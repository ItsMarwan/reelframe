/* ==========================================================================
   Pair devices — like Share/Watch Party's code+QR flow, but instead of
   sending one file, the host streams a manifest of its whole library
   (respecting folder exclusions). The guest doesn't get a separate
   "Paired" screen — pairing just swaps the host's videos/images/audio
   into the guest's own state, exactly like opening a local folder, so
   every existing tab, grid, search, sort, and filter keeps working
   unmodified. Actual bytes (thumbnails, then full files on open/play)
   are pulled from the host on demand over the same PeerJS data channel.
   If the host ends the pairing, or the connection drops, the guest's
   previous local library (if any) is restored automatically.
   ========================================================================== */
const PAIR_ID_PREFIX = 'reelframe-pair-';

/* Google's public STUN server alone can't traverse symmetric NATs, some
   corporate/VPN paths, or a phone hopping wifi<->cellular mid-session —
   the connection "opens", data flows for a moment, then ICE just dies
   with no JS error to show for it (that's the "connection lost, nothing
   in the console" symptom). A TURN relay fallback actually fixes that
   instead of just retrying into the same dead end. */
const PAIR_ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ]
};

/* Reconnects no longer rebuild the library/UI (see pair-manifest-end
   below), so it's cheap to be more patient here — a few quick tries
   spaced out with backoff has a much better chance of riding out a
   flaky path than giving up after 3 rapid-fire attempts. */
const PAIR_MAX_RECONNECT_ATTEMPTS = 6;
const PAIR_RECONNECT_BASE_DELAY_MS = 1000;
const PAIR_RECONNECT_MAX_DELAY_MS = 8000;

state.pair = {
  role: null,                 // 'host' | 'guest' | null
  peer: null,
  code: null,
  conns: new Map(),           // host-only: connId -> { conn, ip, locality, queue }
  hostConn: null,             // guest-only
  hostLocality: 'unknown',    // guest-only
  rootName: '',               // guest-only: the host's library name, for status text
  previousLibrary: null,      // guest-only: snapshot of what was open before pairing, to restore on leave
  pendingRequests: new Map(), // guest-only: reqId -> { resolve, reject }
  lastCode: null,             // guest-only: remembered so a dropped connection can retry the same code
  reconnectAttempts: 0,       // guest-only: counts consecutive reconnect tries since the last successful manifest
};
let pairConnSeq = 0;
let pairReqSeq = 0;

/* pairPath -> [callback, ...], fired once a requested thumb comes back.
   Lets the normal grid thumbnail code (ensureVideoMeta / createPinCard)
   ask for a paired thumb the same way it'd generate a local one. */
const pairThumbWaiters = new Map();
/* Returns true if this is the first waiter for `pairPath` — i.e. the
   caller should actually send the request-thumb message. If a request is
   already in flight (grid re-renders, the same item showing in multiple
   rows, etc.), just queue the callback instead of firing a duplicate
   request — those duplicates were part of what flooded the data channel
   and starved out actual video/photo load requests. */
function registerPairThumbWaiter(pairPath, cb){
  const alreadyPending = pairThumbWaiters.has(pairPath);
  if(!alreadyPending) pairThumbWaiters.set(pairPath, []);
  pairThumbWaiters.get(pairPath).push(cb);
  return !alreadyPending;
}
function notifyPairThumbWaiters(pairPath, thumb){
  const list = pairThumbWaiters.get(pairPath);
  if(!list) return;
  pairThumbWaiters.delete(pairPath);
  list.forEach(cb => { try{ cb(thumb); }catch(e){} });
}

function pairIsActive(){
  if(state.pair.role === 'host') return state.pair.conns.size > 0;
  if(state.pair.role === 'guest') return !!(state.pair.hostConn && isConnectionReallyOpen(state.pair.hostConn));
  return false;
}
function buildPairLink(code){
  const url = new URL(location.href);
  url.search = ''; url.hash = '';
  url.searchParams.set('pair', code);
  return url.toString();
}
function setPairStatus(text){
  const el = document.getElementById('pairStatusText');
  if(el) el.textContent = text;
  const spinner = document.getElementById('pairWaitingSpinner');
  if(spinner) spinner.hidden = !/connecting|waiting|setting up|sending|reconnecting/i.test(text || '');
}
function setPairCode(code){ const el = document.getElementById('pairCodeDisplay'); if(el) el.textContent = code || '······'; }
let pairQrInstance = null;
function renderPairQr(code){
  const el = document.getElementById('pairQrCode');
  if(!el) return;
  el.innerHTML = '';
  if(!code || typeof QRCode === 'undefined'){ if(code) el.textContent = 'QR unavailable — check your connection.'; return; }
  pairQrInstance = new QRCode(el, { text: buildPairLink(code), width:168, height:168, colorDark:'#121319', colorLight:'#ffffff', correctLevel: QRCode.CorrectLevel.M });
}
function sendPairMessage(conn, msg){
  if(!isConnectionReallyOpen(conn)) return;
  try{
    conn.send(JSON.stringify(msg));
  }catch(e){
    // A congested channel can make send() throw instead of just queuing —
    // this used to be swallowed silently, which is how a request or its
    // response could just vanish with nothing on either end ever knowing.
    // One retry after the channel's had a moment covers the common case.
    try{ conn.send(JSON.stringify(msg)); }
    catch(e2){ console.warn('[pair] message send failed twice, dropping', msg?.type, e2); }
  }
}

/* Like sendPairMessage, but waits for the data channel to drain first —
   use this for anything that isn't tiny (thumbnails, file metadata), so a
   burst of sends doesn't overflow the channel's send buffer and get
   silently dropped. */
async function sendPairMessageBackpressured(conn, msg){
  const dc = conn.dataChannel;
  if(dc && dc.bufferedAmount > SHARE_CHUNK_HIGH_WATER) await waitForBufferedAmountLow(dc, SHARE_CHUNK_LOW_WATER);
  sendPairMessage(conn, msg);
}
function renderPairPeers(){
  const wrap = document.getElementById('pairPeersList');
  if(!wrap) return;
  if(state.pair.role !== 'host' || state.pair.conns.size === 0){ wrap.hidden = true; wrap.innerHTML = ''; return; }
  wrap.hidden = false;
  wrap.innerHTML = [...state.pair.conns.values()].map(p => `
    <div class="party-peer-row">
      <div class="party-peer-info">
        <span class="party-peer-ip">${escapeHtml(p.ip || 'resolving…')}${p.locality && p.locality!=='unknown' ? ` · ${p.locality === 'local' ? 'local network' : 'internet'}` : ''}</span>
        <span class="party-peer-status">Browsing your library</span>
      </div>
    </div>
  `).join('');
}
function updatePairButtonState(){
  document.querySelectorAll('#openPairModalBtn').forEach(b => b.classList.toggle('active', pairIsActive()));
}

/* Cheap diagnostics — logs the underlying ICE connection state so a future
   drop shows *something* in the console instead of nothing. Safe to call
   even if peerConnection isn't ready yet. */
function watchPairIceState(conn, label){
  if(!conn || !conn.peerConnection) return;
  conn.peerConnection.oniceconnectionstatechange = () => {
    console.debug(`[pair][${label}] ICE state:`, conn.peerConnection.iceConnectionState);
  };
}

/* ---------------------------------------------------------------------
   HOST side — unchanged: serve a manifest, serve thumbs, serve full
   files on request. The host's own screen never reacts to anything a
   guest does; it only ever responds to explicit requests.
   --------------------------------------------------------------------- */
function pairFindItemByPath(path){
  return state.videos.find(i => i.path === path)
      || state.images.find(i => i.path === path)
      || state.audio.find(i => i.path === path)
      || state.snapshots.find(i => i.path === path)
      || null;
}
function pairManifestItem(item){
  return {
    path: item.path, name: item.name, category: item.category, type: item.type,
    size: item.size, lastModified: item.lastModified, duration: item.duration || null,
    title: item.title || null, artist: item.artist || null,
  };
}
/* Converts one of the host's own favorite/watch-later keys (`type:path`,
   using the host's original local path) into the matching key for the
   paired copy of that item on the guest (`type:__paired__/path`) — so
   "Liked" and "Watch later" carry over instead of just being empty. */
function convertHostFavKey(key){
  const idx = key.indexOf(':');
  if(idx === -1) return null;
  const type = key.slice(0, idx);
  const path = key.slice(idx + 1);
  return `${type}:__paired__/${path}`;
}
function pairManifestSnapshot(s){
  return {
    path: s.path, name: s.name, videoName: s.videoName,
    timestamp: s.timestamp, savedAt: s.savedAt, size: s.size, lastModified: s.lastModified,
  };
}
function buildPairManifest(){
  return {
    type: 'pair-manifest', rootName: state.rootName,
    videos: state.videos.map(pairManifestItem),
    images: state.images.map(pairManifestItem),
    audio: state.audio.map(pairManifestItem),
    // Everything below is new: without it, Liked / Watch later / Snapshots
    // / "For You" would all look empty (or worse, show your own unrelated
    // picks) the whole time you're paired, instead of reflecting the
    // host's library the way the videos/images/audio already do.
    snapshots: state.snapshots.map(pairManifestSnapshot),
    favorites: [...state.favorites],
    watchLater: [...state.watchLater],
    watchLaterConsumed: [...state.watchLaterConsumed],
    categoryFavorites: [...state.categoryFavorites],
    history: state.history.slice(0, HISTORY_MAX),
  };
}
const PAIR_MANIFEST_CHUNK_SIZE = 16000;

async function sendPairManifest(conn){
  const json = JSON.stringify(buildPairManifest());
  const total = Math.max(1, Math.ceil(json.length / PAIR_MANIFEST_CHUNK_SIZE));
  sendPairMessage(conn, { type: 'pair-manifest-start', total });
  for(let i = 0; i < total; i++){
    if(!isConnectionReallyOpen(conn)) return;
    const chunk = json.slice(i * PAIR_MANIFEST_CHUNK_SIZE, (i + 1) * PAIR_MANIFEST_CHUNK_SIZE);
    sendPairMessage(conn, { type: 'pair-manifest-chunk', index: i, chunk });
    const dc = conn.dataChannel;
    if(dc && dc.bufferedAmount > SHARE_CHUNK_HIGH_WATER) await waitForBufferedAmountLow(dc, SHARE_CHUNK_LOW_WATER);
  }
  if(isConnectionReallyOpen(conn)) sendPairMessage(conn, { type: 'pair-manifest-end' });
}
async function loadImageEl(src){
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
async function servePairThumbInner(conn, path){
  const item = pairFindItemByPath(path);
  if(!item) return;
  if(item.type === 'video'){
    await ensureVideoMeta(item);
    if(item.thumb) await sendPairMessageBackpressured(conn, { type:'pair-thumb', path, thumb: item.thumb });
    return;
  }
  if(item.type === 'image'){
    if(item._pairThumb){ await sendPairMessageBackpressured(conn, { type:'pair-thumb', path, thumb: item._pairThumb }); return; }
    try{
      const img = await loadImageEl(ensureItemUrl(item));
      const scale = Math.min(1, 240 / Math.max(img.naturalWidth || 240, img.naturalHeight || 240));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round((img.naturalWidth||240) * scale));
      canvas.height = Math.max(1, Math.round((img.naturalHeight||240) * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      const thumb = canvas.toDataURL('image/jpeg', 0.6);
      item._pairThumb = thumb;
      await sendPairMessageBackpressured(conn, { type:'pair-thumb', path, thumb });
    }catch(e){ /* skip — guest just keeps the fallback icon */ }
  }
}
async function servePairFileInner(conn, path, reqId){
  const item = pairFindItemByPath(path);
  if(!item || !item.file){
    sendPairMessage(conn, { type:'pair-file-error', reqId, message:'That file is no longer available.' });
    return;
  }
  const file = item.file;
  try{
    await waitForConnectionOpen(conn);
    await sendPairMessageBackpressured(conn, { type:'pair-file-meta', reqId, name:item.name, mime:guessMimeForItem(item, file.type), size:file.size, itemType:item.type });
    const dc = conn.dataChannel;
    let offset = 0;
    while(offset < file.size){
      if(!isConnectionReallyOpen(conn)) throw new Error('Connection dropped mid-transfer.');
      const end = Math.min(offset + SHARE_SEND_CHUNK_SIZE, file.size);
      conn.send(await file.slice(offset, end).arrayBuffer());
      offset = end;
      if(dc && dc.bufferedAmount > SHARE_CHUNK_HIGH_WATER) await waitForBufferedAmountLow(dc, SHARE_CHUNK_LOW_WATER);
    }
    if(isConnectionReallyOpen(conn)) sendPairMessage(conn, { type:'pair-file-done', reqId });
  }catch(err){
    console.error('pair file send failed', err);
    try{ sendPairMessage(conn, { type:'pair-file-error', reqId, message:'Transfer failed.' }); }catch(e){}
  }
}
/* Thumbnails and file requests get separate queues per connection. They
   used to share one queue, which meant opening a video or photo had to
   wait behind however many thumbnail-generation jobs were already queued
   from scrolling the grid — on a slow/congested link that could mean
   "never," since thumb requests kept arriving faster than they drained.
   Splitting them means a file request is sent as soon as it's the host's
   turn to touch the network, regardless of how backed up thumbnails are. */
function servePairThumb(conn, entry, path){
  entry.thumbQueue = (entry.thumbQueue || Promise.resolve()).then(() => servePairThumbInner(conn, path), () => servePairThumbInner(conn, path));
}
function servePairFile(conn, entry, path, reqId){
  entry.fileQueue = (entry.fileQueue || Promise.resolve()).then(() => servePairFileInner(conn, path, reqId), () => servePairFileInner(conn, path, reqId));
}

function wirePairHostConnection(conn){
  const connId = ++pairConnSeq;
  const entry = { conn, ip:'resolving…', locality:'unknown', thumbQueue: Promise.resolve(), fileQueue: Promise.resolve() };
  state.pair.conns.set(connId, entry);
  updatePairButtonState();
  renderPairPeers();
  setPairStatus('Connected — sending your library…');
  watchPairIceState(conn, 'host');

  waitForConnectionOpen(conn).then(() => sendPairManifest(conn)).then(() => {
    setPairStatus('Connected — sharing your library.');
  }).catch(() => {
    setPairStatus('Connection never became ready — ask the other device to try again.');
  });

  conn.on('data', (data) => {
    if(data instanceof ArrayBuffer) return;
    let msg = data;
    if(typeof data === 'string'){ try{ msg = JSON.parse(data); }catch(e){ return; } }
    if(!msg || typeof msg !== 'object') return;
    if(msg.type === 'request-thumb') servePairThumb(conn, entry, msg.path);
    else if(msg.type === 'request-file') servePairFile(conn, entry, msg.path, msg.reqId);
  });
  conn.on('close', () => {
    state.pair.conns.delete(connId);
    renderPairPeers();
    updatePairButtonState();
    if(state.pair.conns.size === 0 && state.pair.role === 'host') setPairStatus('Code ready — waiting for someone to join…');
  });
  conn.on('error', (err) => console.error('pair connection error', err));

  getConnectionAddressInfo(conn).then(info => { entry.ip = info.ip; entry.locality = info.locality; renderPairPeers(); });
}

function startPairHost(){
  teardownPairAll();
  if(typeof Peer === 'undefined'){ setPairStatus("Pairing isn't available right now — check your connection."); return; }
  const code = generateShareCode();
  state.pair.role = 'host';
  state.pair.code = code;
  setPairCode(code);
  renderPairQr(code);
  setPairStatus('Setting up…');
  renderPairPeers();

  const peer = new Peer(PAIR_ID_PREFIX + code, { debug: 0, config: PAIR_ICE_CONFIG });
  state.pair.peer = peer;
  peer.on('open', () => { if(state.pair.peer === peer) setPairStatus('Code ready — waiting for someone to join…'); });
  peer.on('connection', (conn) => {
    if(state.pair.peer !== peer) return;
    // PeerJS can double-fire 'open' on a flaky link — guard so we never
    // wire (and send the manifest down) the same connection twice.
    let wired = false;
    conn.on('open', () => {
      if(wired) return;
      wired = true;
      wirePairHostConnection(conn);
    });
  });
  peer.on('error', (err) => {
    if(state.pair.peer !== peer) return;
    console.error('pair host error', err);
    if(err && err.type === 'unavailable-id'){ startPairHost(); return; }
    setPairStatus('Could not start pairing. Check your connection and try again.');
  });
}
function endPairHost(){
  if(state.pair.role !== 'host') return;
  state.pair.conns.forEach(p => { try{ if(isConnectionReallyOpen(p.conn)) p.conn.send(JSON.stringify({ type:'pair-end' })); }catch(e){} try{ p.conn.close(); }catch(e){} });
  teardownPairAll();
  setPairStatus('Pairing ended.');
  toast('Pairing ended');
}

/* ---------------------------------------------------------------------
   GUEST side — this is the part that changed. Instead of a separate
   "Paired" screen, receiving a manifest just replaces the guest's own
   library arrays and re-renders through the exact same code path
   opening a local folder does.
   --------------------------------------------------------------------- */
function requestPairThumb(path){
  if(!state.pair.hostConn) return;
  sendPairMessage(state.pair.hostConn, { type:'request-thumb', path });
}
const PAIR_FILE_REQUEST_TIMEOUT_MS = 20000;

function requestPairFile(path){
  return new Promise((resolve, reject) => {
    if(!state.pair.hostConn || !isConnectionReallyOpen(state.pair.hostConn)){ reject(new Error('Not connected to the paired device.')); return; }
    const reqId = ++pairReqSeq;
    // Without this, a request whose response got lost (dropped send, a
    // connection blip that didn't trigger 'close', etc.) just hung the
    // caller's promise forever — the "Loading..." toast never resolved,
    // never failed, and clicking the same item again did nothing because
    // nothing had actually gone wrong from the UI's point of view yet.
    const timer = setTimeout(() => {
      if(state.pair.pendingRequests.has(reqId)){
        state.pair.pendingRequests.delete(reqId);
        reject(new Error('The paired device took too long to respond.'));
      }
    }, PAIR_FILE_REQUEST_TIMEOUT_MS);
    state.pair.pendingRequests.set(reqId, {
      resolve: (val) => { clearTimeout(timer); resolve(val); },
      reject: (err) => { clearTimeout(timer); reject(err); },
    });
    sendPairMessage(state.pair.hostConn, { type:'request-file', path, reqId });
  });
}

/* Turns one manifest entry into a normal library item. `pairPath` keeps
   the host's original path (used for thumb/file requests); `path` is
   namespaced so it can never collide with anything already in the
   guest's own local library. Everything else — category, type, favKey,
   history, sorting — treats this exactly like a local item. */
function buildPairedItem(mi){
  const base = {
    name: mi.name,
    path: `__paired__/${mi.path}`,
    pairPath: mi.path,
    folderPath: [],
    category: mi.category || UNCATEGORIZED,
    type: mi.type,
    handle: null, file: null, url: null,
    size: mi.size || 0,
    lastModified: mi.lastModified || Date.now(),
    ext: extOf(mi.name),
    _rand: Math.random(),
    duration: mi.duration || null,
    thumb: null,
    broken: false,
    pairRemote: true,
  };
  if(mi.type === 'audio'){ base.title = mi.title || null; base.artist = mi.artist || null; base.album = null; base.cover = null; }
  return base;
}

/* Snapshots only travel as metadata over the manifest (no image bytes —
   that would bloat every pairing handshake even for snapshots nobody ever
   looks at). Built the same way as buildPairedItem: thumb/full image are
   pulled from the host on demand via the normal pairPath thumb/file
   request flow, which already knows how to look items up in
   state.snapshots on the host side. */
function buildPairedSnapshotItem(ms){
  return {
    name: ms.name || `Snapshot ${new Date(ms.savedAt || Date.now()).toLocaleString()}`,
    path: `__paired__/${ms.path}`,
    pairPath: ms.path,
    folderPath: [],
    category: 'Snapshots',
    type: 'image',
    handle: null, file: null, url: null, blob: null,
    size: ms.size || 0,
    lastModified: ms.lastModified || Date.now(),
    ext: 'png',
    _rand: Math.random(),
    duration: null,
    thumb: null,
    broken: false,
    pairRemote: true,
    source: 'snapshot',
    videoName: ms.videoName || 'snapshot',
    timestamp: ms.timestamp || 0,
    savedAt: ms.savedAt || new Date().toISOString(),
  };
}

/* Merges the host's Liked / Watch later / category favorites / history
   into the guest's own state, converting each key/path to the
   __paired__/ namespace so they line up with the paired item objects
   built above. This is additive (union), so nothing the guest already
   had is lost — and since state.pair.previousLibrary snapshots the
   guest's own sets before this runs, restorePreviousLibrary can put things
   back exactly as they were once pairing ends. */
function applyPairedPersonalData(manifest){
  (manifest.favorites || []).forEach(key => {
    const converted = convertHostFavKey(key);
    if(converted) state.favorites.add(converted);
  });
  (manifest.watchLater || []).forEach(key => {
    const converted = convertHostFavKey(key);
    if(converted) state.watchLater.add(converted);
  });
  (manifest.watchLaterConsumed || []).forEach(key => {
    const converted = convertHostFavKey(key);
    if(converted) state.watchLaterConsumed.add(converted);
  });
  (manifest.categoryFavorites || []).forEach(cat => state.categoryFavorites.add(cat));
  const convertedHistory = (manifest.history || []).map(h => ({ ...h, path: `__paired__/${h.path}` }));
  state.history = mergeHistoryArrays(state.history, convertedHistory);
  updateFavCount();
  updateWatchLaterButtons();
}

/* Swaps in the host's library, saving whatever was open first so it can
   be put back on teardown. Mirrors the tail end of launchWithHandle /
   launchDemoLibrary in 06-gate-and-preview.js. */
function activatePairedLibrary(manifest, hostRootName){
  if(!state.pair.previousLibrary){
    state.pair.previousLibrary = {
      rootHandle: state.rootHandle, rootName: state.rootName,
      rawVideos: state.rawVideos, rawImages: state.rawImages, rawAudio: state.rawAudio,
      excluded: state.excluded, isDemo: state.isDemo,
      snapshots: state.snapshots,
      favorites: new Set(state.favorites),
      watchLater: new Set(state.watchLater),
      watchLaterConsumed: new Set(state.watchLaterConsumed),
      categoryFavorites: new Set(state.categoryFavorites),
      history: state.history.slice(),
    };
  }
  state.rootHandle = null;
  state.rootName = `Paired: ${hostRootName}`;
  state.rawVideos = (manifest.videos || []).map(buildPairedItem);
  state.rawImages = (manifest.images || []).map(buildPairedItem);
  state.rawAudio = (manifest.audio || []).map(buildPairedItem);
  state.snapshots = (manifest.snapshots || []).map(buildPairedSnapshotItem);
  state.excluded = new Set();
  state.isDemo = false;
  applyExclusions();
  applyPairedPersonalData(manifest);

  const appEl = document.getElementById('app');
  if(appEl.hidden){
    document.getElementById('gate').style.display = 'none';
    appEl.hidden = false;
  }
  document.getElementById('rootName').textContent = state.rootName;
  updateTotalCount();
  renderSidebar();
  setTab('videos', { skipRender:true });
  switchViewsForTab();
  clearUrlParams();
  scrollMainTop();
  renderActiveGrid();
}

/* Restores whatever was open before pairing started — a local folder,
   the demo library, or (if there was nothing) an empty library, same as
   right after gate load. */
function restorePreviousLibrary(){
  const prev = state.pair.previousLibrary;
  state.pair.previousLibrary = null;
  if(!prev){
    state.rootHandle = null; state.rootName = ''; state.rawVideos = []; state.rawImages = []; state.rawAudio = [];
    state.excluded = new Set();
    state.snapshots = [];
  } else {
    state.rootHandle = prev.rootHandle; state.rootName = prev.rootName;
    state.rawVideos = prev.rawVideos; state.rawImages = prev.rawImages; state.rawAudio = prev.rawAudio;
    state.excluded = prev.excluded; state.isDemo = prev.isDemo;
    state.snapshots = prev.snapshots || [];
    // Put the guest's own Liked/Watch later/history back exactly as they
    // were before pairing merged the host's in, and persist that so any
    // paired-session data that got saved along the way (any toggle while
    // paired calls the normal save*() functions) doesn't linger on disk.
    state.favorites = prev.favorites; saveFavorites();
    state.watchLater = prev.watchLater; saveWatchLater();
    state.watchLaterConsumed = prev.watchLaterConsumed; saveWatchLaterConsumed();
    state.categoryFavorites = prev.categoryFavorites; saveCategoryFavorites();
    state.history = prev.history; saveHistory();
  }
  applyExclusions();
  document.getElementById('rootName').textContent = state.rootName || '—';
  updateTotalCount();
  updateFavCount();
  updateWatchLaterButtons();
  renderSidebar();
  renderActiveGrid();
}

function findPairedItemByPairPath(path){
  return state.videos.find(i => i.pairPath === path)
      || state.images.find(i => i.pairPath === path)
      || state.audio.find(i => i.pairPath === path)
      || null;
}

/* Cleans up just the dead peer/connection objects — unlike teardownPairGuest,
   this never restores the previous library and never clears lastCode, so a
   brief drop doesn't flash the screen back to the local library while a
   reconnect attempt is quietly happening underneath it. */
function teardownPairGuestConnectionOnly(){
  if(state.pair.hostConn){ try{ state.pair.hostConn.close(); }catch(e){} }
  if(state.pair.peer){ try{ state.pair.peer.destroy(); }catch(e){} }
  state.pair.peer = null;
  state.pair.hostConn = null;
  state.pair.pendingRequests.forEach(p => p.reject(new Error('Reconnecting…')));
  state.pair.pendingRequests.clear();
}

/* Retries the same pairing code a few times (with the TURN fallback in
   place) before giving up and reverting to the guest's own library. Only
   fires when we'd already successfully paired once (state.pair.rootName
   is set) — an initial connection failure still surfaces immediately via
   the normal joinPairSession error handling. */
function attemptPairReconnect(){
  if(state.pair.role !== 'guest' || !state.pair.lastCode) return;
  state.pair.reconnectAttempts++;
  if(state.pair.reconnectAttempts > PAIR_MAX_RECONNECT_ATTEMPTS){
    teardownPairGuest('Connection to the paired device was lost.');
    return;
  }
  setPairStatus(`Reconnecting…`); // deliberately low-key — this no longer disrupts what's on screen
  teardownPairGuestConnectionOnly();
  const delay = Math.min(PAIR_RECONNECT_MAX_DELAY_MS, PAIR_RECONNECT_BASE_DELAY_MS * Math.pow(1.6, state.pair.reconnectAttempts - 1));
  setTimeout(() => {
    if(state.pair.role !== 'guest') return; // left/torn down while we were waiting
    const trimmed = state.pair.lastCode;
    const peer = new Peer({ debug: 0, config: PAIR_ICE_CONFIG });
    state.pair.peer = peer;
    peer.on('open', () => {
      if(state.pair.peer !== peer) return;
      const conn = peer.connect(PAIR_ID_PREFIX + trimmed, { reliable: true, serialization: 'raw' });
      conn.on('open', () => { if(state.pair.peer === peer) wirePairGuestConnection(conn); });
      conn.on('error', (err) => console.error('pair reconnect error', err));
    });
    peer.on('error', (err) => {
      if(state.pair.peer !== peer) return;
      console.error('pair reconnect peer error', err);
      attemptPairReconnect();
    });
  }, delay);
}

function teardownPairGuest(message){
  if(state.pair.role !== 'guest') return;
  state.pair.lastCode = null;
  state.pair.reconnectAttempts = 0;
  if(state.pair.hostConn){ try{ state.pair.hostConn.close(); }catch(e){} }
  if(state.pair.peer){ try{ state.pair.peer.destroy(); }catch(e){} }
  state.pair.role = null; state.pair.peer = null; state.pair.hostConn = null;
  state.pair.pendingRequests.forEach(p => p.reject(new Error('Pairing ended.')));
  state.pair.pendingRequests.clear();
  if(state.rootName && state.rootName.startsWith('Paired: ')) restorePreviousLibrary();
  if(message) toast(message);
  updatePairButtonState();
}
function teardownPairHostOnly(){
  if(state.pair.peer){ try{ state.pair.peer.destroy(); }catch(e){} }
  state.pair.role = null; state.pair.peer = null; state.pair.code = null;
  state.pair.conns = new Map();
  updatePairButtonState();
  renderPairPeers();
}
function teardownPairAll(){
  if(state.pair.role === 'host') teardownPairHostOnly();
  else if(state.pair.role === 'guest') teardownPairGuest(null);
}

function wirePairGuestConnection(conn){
  state.pair.hostConn = conn;
  watchPairIceState(conn, 'guest');
  let incoming = null;
  let manifestChunks = null;
  let manifestTimer = setTimeout(() => {
    setPairStatus("Connected, but the library never arrived. Ask the host to reopen Pair devices and try again.");
  }, 8000);

  conn.on('data', (data) => {
    if(data instanceof ArrayBuffer){
      if(incoming){ incoming.chunks.push(data); incoming.received += data.byteLength; }
      return;
    }
    let msg = data;
    if(typeof data === 'string'){ try{ msg = JSON.parse(data); }catch(e){ return; } }
    if(!msg || typeof msg !== 'object') return;

    if(msg.type === 'pair-manifest-start'){
      manifestChunks = new Array(msg.total);
    } else if(msg.type === 'pair-manifest-chunk'){
      if(manifestChunks) manifestChunks[msg.index] = msg.chunk;
    } else if(msg.type === 'pair-manifest-end'){
      clearTimeout(manifestTimer);
      try{
        const json = (manifestChunks || []).join('');
        const full = JSON.parse(json);
        // Was this device already paired with this host before this
        // connection came up? If so this manifest arrived because of a
        // reconnect, not a fresh pairing — the item objects, thumbnails,
        // and grid the person is already looking at are all still valid
        // (requestPairThumb/requestPairFile just read state.pair.hostConn
        // at call time, which is already pointed at the new connection
        // above). Rebuilding the whole library and re-rendering here is
        // exactly what was causing the visible flash/flicker on every
        // reconnect — so only do that heavy work the first time.
        const isFirstPairing = !state.pair.rootName;
        state.pair.rootName = full.rootName || 'Paired library';
        state.pair.reconnectAttempts = 0; // a manifest landed — connection is good again

        if(isFirstPairing){
          activatePairedLibrary(full, state.pair.rootName);
          toast(`Paired with "${state.pair.rootName}"`);
        } else {
          // Quietly recover any thumbnails that were mid-request when the
          // connection dropped and never got a reply.
          if(typeof retryStalledThumbs === 'function') retryStalledThumbs();
        }
        const localityNote = state.pair.hostLocality === 'local' ? ' (local network)' : state.pair.hostLocality === 'internet' ? ' (over the internet)' : '';
        setPairStatus(`Connected — browsing "${state.pair.rootName}"${localityNote}.`);
      }catch(e){
        console.error('failed to parse paired library manifest', e);
        setPairStatus("The paired library arrived corrupted — ask the host to try again.");
      }
      manifestChunks = null;
    } else if(msg.type === 'pair-thumb'){
      const item = findPairedItemByPairPath(msg.path);
      if(item && msg.thumb) item.thumb = msg.thumb;
      if(msg.thumb) notifyPairThumbWaiters(msg.path, msg.thumb);
    } else if(msg.type === 'pair-file-meta'){
      incoming = { meta: msg, chunks: [], received: 0 };
    } else if(msg.type === 'pair-file-done'){
      if(incoming){
        const blob = new Blob(incoming.chunks, { type: incoming.meta.mime || 'application/octet-stream' });
        const pending = state.pair.pendingRequests.get(msg.reqId);
        if(pending) pending.resolve(blob);
        state.pair.pendingRequests.delete(msg.reqId);
      }
      incoming = null;
    } else if(msg.type === 'pair-file-error'){
      const pending = state.pair.pendingRequests.get(msg.reqId);
      if(pending) pending.reject(new Error(msg.message || 'Transfer failed.'));
      state.pair.pendingRequests.delete(msg.reqId);
      incoming = null;
    } else if(msg.type === 'pair-end'){
      teardownPairGuest('The host ended the pairing.');
    }
  });
  conn.on('close', () => {
    clearTimeout(manifestTimer);
    // A drop after we'd already paired successfully gets a few quiet
    // reconnect attempts (with TURN fallback) instead of immediately
    // yanking the person back to their own library.
    if(state.pair.role === 'guest' && state.pair.rootName){
      attemptPairReconnect();
    } else {
      teardownPairGuest(null);
    }
  });
  conn.on('error', (err) => console.error('pair guest conn error', err));

  detectConnectionLocality(conn).then(loc => { state.pair.hostLocality = loc; });
  setPairStatus('Connected — waiting for the library…');
}

function joinPairSession(code){
  teardownPairAll();
  if(typeof Peer === 'undefined'){ setPairStatus("Pairing isn't available right now — check your connection."); return; }
  const trimmed = (code || '').trim().toUpperCase();
  if(trimmed.length < 4){ setPairStatus('Enter the code from the other device.'); return; }
  state.pair.role = 'guest';
  state.pair.lastCode = trimmed;
  state.pair.reconnectAttempts = 0;
  setPairStatus('Connecting…');
  const peer = new Peer({ debug: 0, config: PAIR_ICE_CONFIG });
  state.pair.peer = peer;
  peer.on('open', () => {
    if(state.pair.peer !== peer) return;
    const conn = peer.connect(PAIR_ID_PREFIX + trimmed, { reliable: true, serialization: 'raw' });
    conn.on('open', () => { if(state.pair.peer === peer) wirePairGuestConnection(conn); });
    conn.on('error', (err) => console.error('pair join error', err));
  });
  peer.on('error', (err) => {
    if(state.pair.peer !== peer) return;
    console.error('pair join peer error', err);
    if(err && err.type === 'peer-unavailable') setPairStatus('No paired library found with that code.');
    else setPairStatus('Could not connect. Check your connection and try again.');
  });
}

function bindPairUI(){
  const openBtn = document.getElementById('openPairModalBtn');
  const backdrop = document.getElementById('pairModalBackdrop');
  const closeBtn = document.getElementById('pairModalClose');
  const copyBtn = document.getElementById('pairCodeCopyBtn');
  const endBtn = document.getElementById('pairEndBtn');
  const joinBtn = document.getElementById('pairJoinBtn');
  const joinInput = document.getElementById('pairJoinInput');
  if(!backdrop || !openBtn) return;

  openBtn.addEventListener('click', () => {
    backdrop.hidden = false;
    renderPairPeers();
    if(state.pair.role === 'host'){
      setPairStatus(pairIsActive() ? 'Connected — sharing your library.' : 'Code ready — waiting for someone to join…');
      setPairCode(state.pair.code);
      renderPairQr(state.pair.code);
    } else if(state.pair.role === 'guest'){
      setPairStatus(state.pair.rootName ? `Connected — browsing "${state.pair.rootName}".` : 'Connecting…');
      setPairCode('');
    } else {
      startPairHost();
    }
  });
  closeBtn.addEventListener('click', () => { backdrop.hidden = true; });
  backdrop.addEventListener('click', (e) => { if(e.target === backdrop) backdrop.hidden = true; });
  copyBtn.addEventListener('click', async () => {
    if(!state.pair.code) return;
    const ok = await copyTextToClipboard(state.pair.code);
    toast(ok ? 'Code copied' : `Couldn't copy — code is ${state.pair.code}`);
  });
  endBtn.addEventListener('click', () => {
    if(state.pair.role === 'host') endPairHost();
    else if(state.pair.role === 'guest') teardownPairGuest('Left the pairing — back to your own library.');
    backdrop.hidden = true;
  });
  joinBtn.addEventListener('click', () => joinPairSession(joinInput.value));
  joinInput.addEventListener('keydown', (e) => { if(e.key === 'Enter') joinPairSession(joinInput.value); });
}
document.addEventListener('DOMContentLoaded', bindPairUI);

/* ?pair=CODE deep link — same idea as the existing share/party invite flow */
function consumePairParamIfPresent(){
  const code = new URLSearchParams(location.search).get('pair');
  if(!code) return;
  history.replaceState(null, '', location.pathname + location.hash);
  document.getElementById('pairModalBackdrop').hidden = false;
  setPairStatus('Connecting…');
  joinPairSession(code);
}
