/* ==========================================================================
   Deep links — /CODE/Folder/File.ext opens that file straight from a URL,
   auto-connecting to whatever device is hosting Pair devices with that
   code, no manual "share" step required. Append ".image" to the filename
   to get a bare page with nothing but the raw image itself — no topbar,
   no sidebar, no chrome at all.

   Requires the host to actually have Pair devices open with a matching
   code (custom or session) at the moment the link is visited — this is
   peer-to-peer, not a permanent server-backed URL.
   ========================================================================== */

function buildDirectShareUrl(item, opts = {}){
  if(!item || state.pair.role !== 'host' || !state.pair.code) return '';
  const path = item.path.split('/').map(encodeURIComponent).join('/');
  return `${location.origin}/${state.pair.code}/${path}${opts.imageOnly ? '.image' : ''}`;
}

function currentShareableItem(){
  if(!document.getElementById('videoWatch').hidden) return state.currentVideo;
  if(!document.getElementById('imageFocus').hidden) return state.currentImage;
  return null;
}

function copyDirectLink(imageOnly){
  const item = currentShareableItem();
  if(!item){ toast('Nothing open to link to.'); return; }
  if(state.pair.role !== 'host'){
    toast('Start Pair devices (as the host) first — the link only works while you’re hosting.');
    return;
  }
  const url = buildDirectShareUrl(item, { imageOnly });
  if(!url){ toast('Could not build a link for this item.'); return; }
  copyTextToClipboard(url).then(ok => toast(ok ? 'Link copied' : url));
}

function bindDeepLinkButtons(){
  const watchBtn = document.getElementById('watchCopyLinkBtn');
  const focusBtn = document.getElementById('focusCopyLinkBtn');
  const focusImageBtn = document.getElementById('focusCopyImageLinkBtn');
  if(watchBtn) watchBtn.addEventListener('click', () => copyDirectLink(false));
  if(focusBtn) focusBtn.addEventListener('click', () => copyDirectLink(false));
  if(focusImageBtn) focusImageBtn.addEventListener('click', () => copyDirectLink(true));
}
document.addEventListener('DOMContentLoaded', bindDeepLinkButtons);

/* ---------- Bare-image render (no app chrome at all) ---------- */
function renderBareImageOnly(blobUrl, name){
  document.title = name || 'Image';
  document.documentElement.innerHTML = '<head></head><body></body>';
  const style = document.createElement('style');
  style.textContent = 'html,body{margin:0;padding:0;background:#000;width:100%;height:100%;overflow:hidden;}img{display:block;width:100%;height:100%;object-fit:contain;}';
  document.head.appendChild(style);
  const img = document.createElement('img');
  img.src = blobUrl;
  img.alt = name || '';
  document.body.appendChild(img);
}

/* ---------- Lightweight one-off peer connection just for this link ---------- */
let deepLinkPeer = null;
function teardownDeepLinkPeer(){
  if(deepLinkPeer){ try{ deepLinkPeer.destroy(); }catch(e){} }
  deepLinkPeer = null;
}

function connectDeepLinkPeer(code){
  return new Promise((resolve, reject) => {
    if(typeof Peer === 'undefined'){ reject(new Error('P2P library unavailable.')); return; }
    const peer = new Peer({ debug: 0, config: PAIR_ICE_CONFIG });
    deepLinkPeer = peer;
    peer.on('open', () => {
      const conn = peer.connect(PAIR_ID_PREFIX + code, { reliable: true, serialization: 'raw' });
      conn.on('open', () => resolve({ peer, conn }));
      conn.on('error', reject);
    });
    peer.on('error', reject);
  });
}

function receiveDeepLinkManifest(conn){
  return new Promise((resolve, reject) => {
    let chunks = null;
    const timer = setTimeout(() => reject(new Error('Timed out waiting for the library.')), 15000);
    conn.on('data', (data) => {
      if(data instanceof ArrayBuffer) return;
      let msg = data;
      if(typeof data === 'string'){ try{ msg = JSON.parse(data); }catch(e){ return; } }
      if(!msg || typeof msg !== 'object') return;
      if(msg.type === 'pair-manifest-start') chunks = new Array(msg.total);
      else if(msg.type === 'pair-manifest-chunk'){ if(chunks) chunks[msg.index] = msg.chunk; }
      else if(msg.type === 'pair-manifest-end'){
        clearTimeout(timer);
        try{ resolve(JSON.parse((chunks || []).join(''))); }
        catch(e){ reject(e); }
      }
    });
  });
}

function requestDeepLinkFile(conn, pairPath){
  return new Promise((resolve, reject) => {
    let meta = null, chunks = [], settled = false;
    const timer = setTimeout(() => { if(!settled){ settled = true; reject(new Error('Timed out fetching the file.')); } }, 30000);
    conn.on('data', (data) => {
      if(settled) return;
      if(data instanceof ArrayBuffer){ chunks.push(data); return; }
      let msg = data;
      if(typeof data === 'string'){ try{ msg = JSON.parse(data); }catch(e){ return; } }
      if(!msg || typeof msg !== 'object') return;
      if(msg.type === 'pair-file-meta') meta = msg;
      else if(msg.type === 'pair-file-done'){
        settled = true; clearTimeout(timer);
        resolve({ blob: new Blob(chunks, { type: (meta && meta.mime) || 'application/octet-stream' }), meta });
      } else if(msg.type === 'pair-file-error'){
        settled = true; clearTimeout(timer);
        reject(new Error(msg.message || 'Transfer failed.'));
      }
    });
    sendPairMessage(conn, { type: 'request-file', path: pairPath, reqId: 1 });
  });
}

/* Entry point — called once, after every script has loaded, when the
   current URL parses as a deep link. Takes over the gate/loading screen. */
async function handleDeepLink(){
  const parsed = parseDeepLinkPath();
  if(!parsed) return;
  const { code, targetPath, imageOnly } = parsed;

  gateEl.style.display = 'none';
  showLoadingScreen(`Connecting to "${code}"…`);

  try{
    const { conn } = await connectDeepLinkPeer(code);
    document.getElementById('loadingSub').textContent = 'Loading library listing…';
    const manifest = await receiveDeepLinkManifest(conn);
    const allItems = [...(manifest.videos || []), ...(manifest.images || []), ...(manifest.audio || [])];
    const found = allItems.find(i => i.path === targetPath) ||
                  allItems.find(i => i.path.toLowerCase() === targetPath.toLowerCase());

    if(!found){
      teardownDeepLinkPeer();
      await hideLoadingScreen();
      gateEl.style.display = 'flex';
      showGateError(`Couldn't find "${targetPath}" in that shared library.`);
      return;
    }

    if(imageOnly && found.type === 'image'){
      document.getElementById('loadingSub').textContent = `Loading "${found.name}"…`;
      const { blob } = await requestDeepLinkFile(conn, found.path);
      teardownDeepLinkPeer();
      await hideLoadingScreen();
      renderBareImageOnly(URL.createObjectURL(blob), found.name);
      return;
    }

    // Normal case: hand off to the existing Pair-guest flow so the person
    // lands in the full app with the whole library, opened right on this item.
    teardownDeepLinkPeer();
    joinPairSession(code);
    const waitForItem = () => {
      const item = state.videos.find(i => i.pairPath === targetPath) ||
                   state.images.find(i => i.pairPath === targetPath) ||
                   state.audio.find(i => i.pairPath === targetPath);
      if(item){
        hideLoadingScreen();
        if(item.type === 'video') openWatch(item);
        else if(item.type === 'image') openFocus(item);
        else { setTab('music', { skipRender: true }); switchViewsForTab(); playTrack(item); }
      } else if(state.pair.role === 'guest'){
        setTimeout(waitForItem, 250);
      } else {
        hideLoadingScreen();
      }
    };
    waitForItem();
  }catch(err){
    console.error('deep link failed', err);
    teardownDeepLinkPeer();
    await hideLoadingScreen();
    gateEl.style.display = 'flex';
    showGateError(`Couldn't connect to "${code}" — make sure the other device still has Pair devices open with that code.`);
  }
}
