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
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('code', state.pair.code);
  url.searchParams.set('path', item.path);
  if(opts.imageOnly) url.searchParams.set('image', '1');
  return url.toString();
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

function openShareLinkModal(){
  const backdrop = document.getElementById('shareLinkModalBackdrop');
  if(backdrop) backdrop.hidden = false;
}

function closeShareLinkModal(){
  const backdrop = document.getElementById('shareLinkModalBackdrop');
  if(backdrop) backdrop.hidden = true;
}

function bindDeepLinkButtons(){
  const shareBtn = document.getElementById('shareLinkBtn');
  const focusShareBtn = document.getElementById('focusShareBtn');
  const modalCloseBtn = document.getElementById('shareLinkModalClose');
  const copyNormalBtn = document.getElementById('shareLinkCopyBtn');
  const copyImageBtn = document.getElementById('shareLinkCopyImageBtn');
  const backdrop = document.getElementById('shareLinkModalBackdrop');

  if(shareBtn) shareBtn.addEventListener('click', openShareLinkModal);
  if(focusShareBtn) focusShareBtn.addEventListener('click', openShareLinkModal);
  if(modalCloseBtn) modalCloseBtn.addEventListener('click', closeShareLinkModal);
  if(backdrop) backdrop.addEventListener('click', (e) => { if(e.target === backdrop) closeShareLinkModal(); });
  if(copyNormalBtn) copyNormalBtn.addEventListener('click', () => { copyDirectLink(false); closeShareLinkModal(); });
  if(copyImageBtn) copyImageBtn.addEventListener('click', () => { copyDirectLink(true); closeShareLinkModal(); });
}
document.addEventListener('DOMContentLoaded', bindDeepLinkButtons);

/* ---------- Bare-image render (no app chrome at all) ---------- */
function ensureBareImageHost(){
  let host = document.getElementById('rf-bare-image-host');
  if(!host){
    host = document.createElement('div');
    host.id = 'rf-bare-image-host';
    host.hidden = true;
    document.body.appendChild(host);
  }
  document.documentElement.classList.add('rf-bare-image-mode');
  return host;
}

function renderBareImageOnly(blobUrl, name){
  document.title = name || 'Image';
  const host = ensureBareImageHost();
  host.hidden = false;
  host.innerHTML = '';
  host.style.cssText = 'position:fixed;inset:0;background:#000;display:flex;align-items:center;justify-content:center;z-index:99999;';
  const img = document.createElement('img');
  img.src = blobUrl;
  img.alt = name || '';
  img.style.cssText = 'display:block;max-width:100%;max-height:100%;width:100%;height:100%;object-fit:contain;';
  host.appendChild(img);
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

  if(imageOnly){
    ensureBareImageHost();
  } else {
    gateEl.style.display = 'none';
    showLoadingScreen(`Connecting to "${code}"…`);
  }

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
    if(imageOnly){
      renderBareImageOnly('', 'Image');
      const host = document.getElementById('rf-bare-image-host');
      if(host){ host.innerHTML = '<div style="color:#fff;font-family:Inter,system-ui;text-align:center;padding:24px;">Couldn’t load the image.</div>'; }
    } else {
      gateEl.style.display = 'flex';
      showGateError(`Couldn't connect to "${code}" — make sure the other device still has Pair devices open with that code.`);
    }
  }
}
