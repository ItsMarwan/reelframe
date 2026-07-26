/* ==========================================================================
   Watch party — a host shares whatever video/photo it has open with one or
   more connected devices, sending the actual file (reusing the P2P share
   transfer from 13-p2p-share.js) and syncing play/pause/seek for video.
   Star topology: guests only ever talk to the host; the host relays
   playback events between them, and tracks per-guest transfer progress
   and a best-effort IP for each connection.
   ========================================================================== */
const PARTY_ID_PREFIX = 'reelframe-party-';
const PARTY_DRIFT_THRESHOLD = 1.2;

let watchParty = {
  role: null,          // 'host' | 'guest' | null
  peer: null,
  code: null,
  item: null,           // media item currently being shared/synced
  conns: new Map(),     // host-only: connId -> { conn, ip, locality, progress }
  hostConn: null,       // guest-only
  applyingRemote: false,
  heartbeatTimer: null,
};

function partyIsActive(){
  if(watchParty.role === 'host') return watchParty.conns.size > 0;
  if(watchParty.role === 'guest') return !!(watchParty.hostConn && watchParty.hostConn.open);
  return false;
}

function buildPartyLink(code){
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('party', code);
  return url.toString();
}

function setPartyStatus(text){
  const el = document.getElementById('partyStatusText');
  if(el) el.textContent = text;
}
function setPartyCode(code){
  const el = document.getElementById('partyCodeDisplay');
  if(el) el.textContent = code || '······';
}
let partyQrInstance = null;
function renderPartyQr(code){
  const el = document.getElementById('partyQrCode');
  if(!el) return;
  el.innerHTML = '';
  if(!code || typeof QRCode === 'undefined'){
    if(code) el.textContent = 'QR code unavailable — check your connection.';
    return;
  }
  partyQrInstance = new QRCode(el, {
    text: buildPartyLink(code),
    width: 168, height: 168,
    colorDark: '#121319', colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.M
  });
}
function updatePartyButtonState(){
  document.querySelectorAll('#partyBtn, #focusPartyBtn').forEach(btn => btn.classList.toggle('active', partyIsActive()));
}

function renderPartyPeers(){
  const wrap = document.getElementById('partyPeersList');
  if(!wrap) return;
  if(watchParty.role !== 'host' || watchParty.conns.size === 0){
    wrap.hidden = true;
    wrap.innerHTML = '';
    return;
  }
  wrap.hidden = false;
  wrap.innerHTML = [...watchParty.conns.values()].map(p => {
    const sending = p.progress != null;
    const pct = sending ? Math.round(p.progress * 100) : 100;
    return `
      <div class="party-peer-row">
        <div class="party-peer-info">
          <span class="party-peer-ip">${escapeHtml(p.ip || 'resolving…')}${p.locality && p.locality !== 'unknown' ? ` · ${p.locality}` : ''}</span>
          <span class="party-peer-status">${sending ? `Sending media… ${pct}%` : 'Synced'}</span>
        </div>
        <div class="toast-progress-track"><div class="toast-progress-fill" style="width:${pct}%"></div></div>
      </div>
    `;
  }).join('');
}

/* Best-effort IP + locality from WebRTC stats — mirrors
   detectConnectionLocality() in 13-p2p-share.js but also surfaces the
   address itself. Chrome's mDNS privacy feature can mean a local host
   candidate shows as a ".local" name rather than a raw LAN IP; this shows
   whatever the browser actually reports rather than guessing. */
async function getConnectionAddressInfo(conn){
  try{
    const pc = conn.peerConnection;
    if(!pc) return { ip: 'unknown', locality: 'unknown' };
    const stats = await pc.getStats();
    let pair = null;
    stats.forEach(report => {
      if(report.type === 'transport' && report.selectedCandidatePairId) pair = stats.get(report.selectedCandidatePairId);
    });
    if(!pair) stats.forEach(report => { if(report.type === 'candidate-pair' && report.selected) pair = report; });
    if(!pair) return { ip: 'unknown', locality: 'unknown' };
    const remote = stats.get(pair.remoteCandidateId);
    if(!remote) return { ip: 'unknown', locality: 'unknown' };
    const ip = remote.address || remote.ip || 'unknown';
    let locality = 'unknown';
    if(remote.candidateType === 'relay' || remote.candidateType === 'srflx') locality = 'internet';
    else if(remote.candidateType === 'host') locality = isPrivateIPAddress(ip) ? 'local' : 'internet';
    return { ip, locality };
  }catch(e){ return { ip: 'unknown', locality: 'unknown' }; }
}

function teardownWatchParty(){
  if(watchParty.heartbeatTimer) clearInterval(watchParty.heartbeatTimer);
  if(watchParty.role === 'host'){
    watchParty.conns.forEach(p => {
      try{ if(isConnectionReallyOpen(p.conn)) p.conn.send(JSON.stringify({ type:'party-end' })); }catch(e){}
      try{ p.conn.close(); }catch(e){}
    });
  } else if(watchParty.hostConn){
    try{ watchParty.hostConn.close(); }catch(e){}
  }
  if(watchParty.peer){ try{ watchParty.peer.destroy(); }catch(e){} }
  watchParty = { role: null, peer: null, code: null, item: null, conns: new Map(), hostConn: null, applyingRemote: false, heartbeatTimer: null };
  updatePartyButtonState();
  renderPartyPeers();
}
function endParty(){
  if(watchParty.role !== 'host') return;
  teardownWatchParty();
  toast('Party ended');
}
function leaveParty(){
  if(watchParty.role !== 'guest') return;
  teardownWatchParty();
  toast('Left the party');
}

function sendPartyMessageToConn(conn, msg){
  if(!isConnectionReallyOpen(conn)) return;
  try{ conn.send(JSON.stringify(msg)); }catch(e){}
}
function broadcastPartyMessage(msg, exceptConn){
  if(watchParty.role === 'host') watchParty.conns.forEach(p => { if(p.conn !== exceptConn) sendPartyMessageToConn(p.conn, msg); });
  else if(watchParty.role === 'guest' && watchParty.hostConn) sendPartyMessageToConn(watchParty.hostConn, msg);
}

function applyIncomingPartyMessage(msg){
  if(!watchParty.item || watchParty.item.type !== 'video') return;
  const video = document.getElementById('videoPlayer');
  if(!video) return;
  watchParty.applyingRemote = true;
  if(typeof msg.time === 'number' && Math.abs(video.currentTime - msg.time) > PARTY_DRIFT_THRESHOLD) video.currentTime = msg.time;
  if(msg.type === 'play' && video.paused) video.play().catch(()=>{});
  else if(msg.type === 'pause' && !video.paused) video.pause();
  setTimeout(() => { watchParty.applyingRemote = false; }, 150);
}
function broadcastLocalPartyState(type){
  if(!partyIsActive() || watchParty.applyingRemote) return;
  if(!watchParty.item || watchParty.item.type !== 'video') return;
  const video = document.getElementById('videoPlayer');
  if(!video) return;
  broadcastPartyMessage({ type, time: video.currentTime });
}
function startPartyHeartbeat(){
  if(watchParty.role !== 'host') return;
  if(watchParty.heartbeatTimer) clearInterval(watchParty.heartbeatTimer);
  watchParty.heartbeatTimer = setInterval(() => {
    if(!watchParty.item || watchParty.item.type !== 'video') return;
    const video = document.getElementById('videoPlayer');
    if(!video || video.paused) return;
    broadcastPartyMessage({ type: 'heartbeat', time: video.currentTime });
  }, 4000);
}

/* ---------- Media transfer (host -> each guest), reusing the chunking
   approach from 13-p2p-share.js's sendItemOverConnection ---------- */
async function sendPartyItemToConn(conn, item, connId){
  const file = item.file || item.blob;
  const entry = watchParty.conns.get(connId);
  if(!file){
    try{ conn.send(JSON.stringify({ type:'error', message:'That file is no longer available on this device.' })); }catch(e){}
    return;
  }
  try{
    await waitForConnectionOpen(conn);
    conn.send(JSON.stringify({ type:'party-item', itemType: item.type, name: item.name, mime: guessMimeForItem(item, file.type), size: file.size }));
    const dc = conn.dataChannel;
    let offset = 0;
    if(entry){ entry.progress = 0; renderPartyPeers(); }
    while(offset < file.size){
      if(!isConnectionReallyOpen(conn)) throw new Error('Connection dropped mid-transfer.');
      const end = Math.min(offset + SHARE_SEND_CHUNK_SIZE, file.size);
      const chunk = await file.slice(offset, end).arrayBuffer();
      conn.send(chunk);
      offset = end;
      if(entry){ entry.progress = file.size ? offset / file.size : 1; renderPartyPeers(); }
      if(dc && dc.bufferedAmount > SHARE_CHUNK_HIGH_WATER) await waitForBufferedAmountLow(dc, SHARE_CHUNK_LOW_WATER);
    }
    if(isConnectionReallyOpen(conn)) conn.send(JSON.stringify({ type:'party-item-done' }));
  }catch(err){
    console.error('party item send failed', err);
    try{ if(isConnectionReallyOpen(conn)) conn.send(JSON.stringify({ type:'error', message:'Transfer failed.' })); }catch(e){}
  }finally{
    if(entry){ entry.progress = null; renderPartyPeers(); }
  }
}

/* Called whenever the host opens a different video/photo while a party is
   active — pushes the new item to every connected guest. */
function broadcastPartyItem(item){
  watchParty.item = item;
  if(watchParty.role !== 'host') return;
  watchParty.conns.forEach((entry, connId) => { sendPartyItemToConn(entry.conn, item, connId); });
}

let partyConnSeq = 0;
function wireHostConnection(conn){
  const connId = ++partyConnSeq;
  const entry = { conn, ip: 'resolving…', locality: 'unknown', progress: null };
  watchParty.conns.set(connId, entry);
  updatePartyButtonState();
  renderPartyPeers();

  conn.on('data', (data) => {
    if(data instanceof ArrayBuffer) return; // host never receives file bytes from guests
    let msg = data;
    if(typeof data === 'string'){ try{ msg = JSON.parse(data); }catch(e){ return; } }
    if(!msg || typeof msg !== 'object') return;
    if(msg.type === 'play' || msg.type === 'pause' || msg.type === 'seek'){
      applyIncomingPartyMessage(msg);
      broadcastPartyMessage(msg, conn); // relay to every other guest
    }
  });
  conn.on('close', () => {
    watchParty.conns.delete(connId);
    renderPartyPeers();
    updatePartyButtonState();
    if(watchParty.conns.size === 0) setPartyStatus('Everyone disconnected. Waiting for someone to join…');
  });
  conn.on('error', (err) => console.error('watch party connection error', err));

  getConnectionAddressInfo(conn).then(info => {
    entry.ip = info.ip;
    entry.locality = info.locality;
    renderPartyPeers();
  });

  setPartyStatus('Connected — playback is now synced.');
  startPartyHeartbeat();
  if(watchParty.item) sendPartyItemToConn(conn, watchParty.item, connId);
}

function hostWatchParty(item){
  teardownWatchParty();
  if(typeof Peer === 'undefined'){
    setPartyStatus("Watch party isn't available right now — check your connection.");
    return;
  }
  const code = generateShareCode();
  watchParty.role = 'host';
  watchParty.code = code;
  watchParty.item = item || null;
  setPartyCode(code);
  renderPartyQr(code);
  setPartyStatus('Setting up…');
  renderPartyPeers();

  const peer = new Peer(PARTY_ID_PREFIX + code, { debug: 0 });
  watchParty.peer = peer;
  peer.on('open', () => { if(watchParty.peer === peer) setPartyStatus('Code ready — waiting for someone to join…'); });
  peer.on('connection', (conn) => {
    if(watchParty.peer !== peer) return;
    conn.on('open', () => wireHostConnection(conn));
  });
  peer.on('error', (err) => {
    if(watchParty.peer !== peer) return;
    console.error('watch party host error', err);
    if(err && err.type === 'unavailable-id'){ hostWatchParty(item); return; }
    setPartyStatus('Could not start a watch party. Check your connection and try again.');
  });
}

function wireGuestConnection(conn){
  watchParty.hostConn = conn;
  let incomingMeta = null, chunks = [], received = 0;

  conn.on('data', (data) => {
    if(data instanceof ArrayBuffer){ chunks.push(data); received += data.byteLength; return; }
    let msg = data;
    if(typeof data === 'string'){ try{ msg = JSON.parse(data); }catch(e){ return; } }
    if(!msg || typeof msg !== 'object') return;

    if(msg.type === 'party-item'){
      incomingMeta = msg; chunks = []; received = 0;
      setPartyStatus(`Receiving "${msg.name}"…`);
    } else if(msg.type === 'party-item-done'){
      const meta = incomingMeta || {};
      const blob = new Blob(chunks, { type: meta.mime || 'application/octet-stream' });
      if(blob.size === 0 || (meta.size && blob.size !== meta.size)){
        setPartyStatus('The shared media arrived incomplete — ask the host to try again.');
        return;
      }
      const item = buildSharedItem({ itemType: meta.itemType, name: meta.name }, blob);
      watchParty.item = item;
      openItemInAppropriateView(item);
      setPartyStatus('Connected — playback is now synced.');
    } else if(msg.type === 'play' || msg.type === 'pause' || msg.type === 'heartbeat'){
      applyIncomingPartyMessage(msg);
    } else if(msg.type === 'party-end'){
      setPartyStatus('The host ended the party.');
      teardownWatchParty();
    } else if(msg.type === 'error'){
      setPartyStatus(msg.message || 'The host reported a problem.');
    }
  });
  conn.on('close', () => { setPartyStatus('The host disconnected.'); teardownWatchParty(); });
  conn.on('error', (err) => console.error('watch party connection error', err));
  setPartyStatus('Connected — waiting for the host\u2019s media…');
  updatePartyButtonState();
}

function joinWatchParty(code){
  teardownWatchParty();
  if(typeof Peer === 'undefined'){
    setPartyStatus("Watch party isn't available right now — check your connection.");
    return;
  }
  const trimmed = (code || '').trim().toUpperCase();
  if(trimmed.length < 4){ setPartyStatus('Enter the code from the other device.'); return; }
  watchParty.role = 'guest';
  setPartyStatus('Connecting…');
  const peer = new Peer({ debug: 0 });
  watchParty.peer = peer;
  peer.on('open', () => {
    if(watchParty.peer !== peer) return;
    const conn = peer.connect(PARTY_ID_PREFIX + trimmed, { reliable: true, serialization: 'raw' });
    conn.on('open', () => { if(watchParty.peer === peer) wireGuestConnection(conn); });
    conn.on('error', (err) => console.error('watch party join error', err));
  });
  peer.on('error', (err) => {
    if(watchParty.peer !== peer) return;
    console.error('watch party peer error', err);
    if(err && err.type === 'peer-unavailable') setPartyStatus('No watch party found with that code.');
    else setPartyStatus('Could not connect. Check your connection and try again.');
  });
}

/* ---------- Invite-link handling (unchanged) ---------- */
function stripPartyParamFromUrl(){
  const url = new URL(location.href);
  if(url.searchParams.has('party')){ url.searchParams.delete('party'); history.replaceState(null, '', url.toString()); }
}
function bindPartyInviteBanner(){
  const banner = document.getElementById('partyInviteBanner');
  const codeEl = document.getElementById('partyInviteCode');
  const joinBtn = document.getElementById('partyInviteJoinBtn');
  const dismissBtn = document.getElementById('partyInviteDismissBtn');
  if(!banner || !joinBtn || !dismissBtn) return;
  const code = new URLSearchParams(location.search).get('party');
  if(!code) return;
  if(codeEl) codeEl.textContent = code.toUpperCase();
  banner.hidden = false;
  joinBtn.addEventListener('click', () => {
    banner.hidden = true; stripPartyParamFromUrl();
    const backdrop = document.getElementById('partyModalBackdrop');
    if(backdrop) backdrop.hidden = false;
    setPartyStatus('Connecting…');
    joinWatchParty(code);
  }, { once: true });
  dismissBtn.addEventListener('click', () => { banner.hidden = true; stripPartyParamFromUrl(); }, { once: true });
}
bindPartyInviteBanner();

function currentPartyableItem(){
  if(!document.getElementById('videoWatch').hidden) return state.currentVideo;
  if(!document.getElementById('imageFocus').hidden) return state.currentImage;
  return null;
}

function openPartyModal(){
  const backdrop = document.getElementById('partyModalBackdrop');
  if(!backdrop) return;
  backdrop.hidden = false;
  renderPartyPeers();
  if(partyIsActive()){
    setPartyStatus(watchParty.role === 'host' ? 'Connected — playback is synced.' : 'Connected — waiting for the host\u2019s media…');
    setPartyCode(watchParty.code);
    if(watchParty.role === 'host') renderPartyQr(watchParty.code);
  } else if(watchParty.role === 'host' && watchParty.peer){
    setPartyStatus('Code ready — waiting for someone to join…');
    setPartyCode(watchParty.code);
    renderPartyQr(watchParty.code);
  } else {
    const item = currentPartyableItem();
    if(!item){ toast('Open a video or photo first.'); backdrop.hidden = true; return; }
    hostWatchParty(item);
  }
}

function bindWatchPartyUI(){
  const btn = document.getElementById('partyBtn');
  const focusBtn = document.getElementById('focusPartyBtn');
  const backdrop = document.getElementById('partyModalBackdrop');
  const closeBtn = document.getElementById('partyModalClose');
  const copyBtn = document.getElementById('partyCodeCopyBtn');
  const joinBtn = document.getElementById('partyJoinBtn');
  const joinInput = document.getElementById('partyJoinInput');
  const endBtn = document.getElementById('partyEndBtn');
  if(!backdrop) return;

  [btn, focusBtn].forEach(b => { if(b) b.addEventListener('click', (e) => { e.stopPropagation(); openPartyModal(); }); });
  closeBtn.addEventListener('click', () => { backdrop.hidden = true; });
  backdrop.addEventListener('click', (e) => { if(e.target === backdrop) backdrop.hidden = true; });
  copyBtn.addEventListener('click', async () => {
    if(!watchParty.code) return;
    const ok = await copyTextToClipboard(watchParty.code);
    toast(ok ? 'Code copied' : `Couldn't copy — code is ${watchParty.code}`);
  });
  joinBtn.addEventListener('click', () => joinWatchParty(joinInput.value));
  joinInput.addEventListener('keydown', (e) => { if(e.key === 'Enter') joinWatchParty(joinInput.value); });
  if(endBtn){
    endBtn.addEventListener('click', () => {
      if(watchParty.role === 'host') endParty();
      else if(watchParty.role === 'guest') leaveParty();
      backdrop.hidden = true;
    });
  }

  const video = document.getElementById('videoPlayer');
  if(video){
    video.addEventListener('play', () => broadcastLocalPartyState('play'));
    video.addEventListener('pause', () => broadcastLocalPartyState('pause'));
    video.addEventListener('seeked', () => broadcastLocalPartyState('seek'));
  }
}