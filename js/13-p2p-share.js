/* ==========================================================================
   P2P sharing — real device-to-device transfer over WebRTC (via PeerJS).
   The old version just copied a "?v=path" link, which only worked if the
   other device already had the exact same local folder open — nothing was
   actually sent anywhere. This sends the real file bytes directly to the
   other device's browser. PeerJS's public broker only handles the initial
   handshake; once connected, data flows straight between the two devices
   (near-instant on the same WiFi, still works over the internet via NAT
   traversal — that's why one mechanism covers both share modes).
   ========================================================================== */
const SHARE_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L — easy to read aloud
const SHARE_ID_PREFIX = 'reelframe-share-';
const SHARE_SEND_CHUNK_SIZE = 16 * 1024; // keep well under WebRTC data channel message-size limits
const SHARE_CHUNK_LOW_WATER = 256 * 1024;
const SHARE_CHUNK_HIGH_WATER = 1024 * 1024;

function generateShareCode(len = 6){
  let out = '';
  for(let i = 0; i < len; i++) out += SHARE_CODE_CHARS[Math.floor(Math.random() * SHARE_CODE_CHARS.length)];
  return out;
}

function guessMimeForItem(item, fileType){
  if(fileType) return fileType;
  if(item.type === 'video') return 'video/mp4';
  if(item.type === 'image') return 'image/jpeg';
  return 'audio/mpeg';
}

/* PeerJS's 'open' event should mean the DataConnection is ready, but on
   flaky mobile connections (backgrounding, screen lock, or just a slow
   ICE handshake) a send can still be attempted before the underlying
   RTCDataChannel is truly open — or after it's silently died mid-transfer.
   This checks the real channel state instead of trusting the event alone. */
function isConnectionReallyOpen(conn){
  return !!(conn && conn.open && conn.dataChannel && conn.dataChannel.readyState === 'open');
}
function waitForConnectionOpen(conn, timeoutMs = 6000){
  return new Promise((resolve, reject) => {
    if(isConnectionReallyOpen(conn)){ resolve(); return; }
    const start = Date.now();
    const check = () => {
      if(isConnectionReallyOpen(conn)){ resolve(); return; }
      if(Date.now() - start > timeoutMs){ reject(new Error('Connection never became ready.')); return; }
      setTimeout(check, 80);
    };
    check();
  });
}

/* Encodes a link back into this same page with ?receive=CODE, so scanning
   the QR on another device (with Reelframe already open there) jumps
   straight into the receive flow instead of making the person type the code. */
function buildShareLink(code){
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('receive', code);
  return url.toString();
}
let shareQrInstance = null;
function renderShareQr(code){
  const el = document.getElementById('shareQrCode');
  if(!el) return;
  el.innerHTML = '';
  if(typeof QRCode === 'undefined'){
    el.textContent = 'QR code unavailable — check your connection.';
    return;
  }
  shareQrInstance = new QRCode(el, {
    text: buildShareLink(code),
    width: 168,
    height: 168,
    colorDark: '#121319',
    colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.M
  });
}

/* ---------- Sender ---------- */
const shareHost = { peer: null, item: null, code: null };

function setShareStatus(text){
  const el = document.getElementById('shareStatusText');
  if(el) el.textContent = text;
}
function setShareCode(code){
  const el = document.getElementById('shareCodeDisplay');
  if(el) el.textContent = code || '······';
}
function setShareProgress(fraction){
  const row = document.getElementById('shareProgressRow');
  const fill = document.getElementById('shareSendProgressFill');
  if(!row || !fill) return;
  row.hidden = fraction == null;
  if(fraction != null) fill.style.width = `${Math.max(0, Math.min(100, Math.round(fraction * 100)))}%`;
}

function teardownShareHost(){
  if(shareHost.peer){
    try{ shareHost.peer.destroy(); }catch(e){ /* already gone */ }
  }
  shareHost.peer = null;
  shareHost.item = null;
  shareHost.code = null;
  setShareProgress(null);
  const row = document.getElementById('sharePendingApproval');
  if(row) row.hidden = true;
}

function waitForBufferedAmountLow(dc, threshold, maxWaitMs = 15000){
  return new Promise((resolve) => {
    if(!dc){ resolve(); return; }
    const start = Date.now();
    const check = () => {
      // Channel died while we were waiting — don't hang forever, let the
      // caller's own open/retry checks handle it.
      if(dc.readyState !== 'open'){ resolve(); return; }
      if(dc.bufferedAmount <= threshold){ resolve(); return; }
      if(Date.now() - start > maxWaitMs){ resolve(); return; }
      setTimeout(check, 50);
    };
    check();
  });
}

async function sendItemOverConnection(conn, item){
  const file = item.file || item.blob;
  if(!file){
    try{ conn.send(JSON.stringify({ type: 'error', message: 'That file is no longer available on this device.' })); }catch(e){}
    return;
  }
  try{
    await waitForConnectionOpen(conn);

    conn.send(JSON.stringify({ type: 'meta', name: item.name, mime: guessMimeForItem(item, file.type), size: file.size, itemType: item.type }));
    const dc = conn.dataChannel;
    let offset = 0;
    while(offset < file.size){
      if(!isConnectionReallyOpen(conn)){
        throw new Error('Connection dropped mid-transfer.');
      }
      const end = Math.min(offset + SHARE_SEND_CHUNK_SIZE, file.size);
      const chunk = await file.slice(offset, end).arrayBuffer();
      conn.send(chunk);
      offset = end;
      setShareProgress(file.size ? offset / file.size : 0);
      if(dc && dc.bufferedAmount > SHARE_CHUNK_HIGH_WATER){
        await waitForBufferedAmountLow(dc, SHARE_CHUNK_LOW_WATER);
      }
    }
    if(isConnectionReallyOpen(conn)){
      conn.send(JSON.stringify({ type: 'done' }));
      setShareStatus(`Sent "${item.name}" successfully.`);
    } else {
      setShareStatus('Connection dropped before the transfer finished. Ask the other device to reconnect.');
    }
    setShareProgress(null);
  }catch(err){
    console.error('share send failed', err);
    try{ if(isConnectionReallyOpen(conn)) conn.send(JSON.stringify({ type: 'error', message: 'Transfer failed.' })); }catch(e){ /* connection already gone */ }
    setShareStatus('Transfer failed — the connection wasn\u2019t ready or dropped. Close this and try again.');
    setShareProgress(null);
  }
}

function isPrivateIPAddress(address){
  if(!address) return false;
  if(address.includes(':')) return address.startsWith('fd') || address.startsWith('fe80'); // IPv6 ULA / link-local
  return /^10\./.test(address) || /^192\.168\./.test(address) ||
         /^172\.(1[6-9]|2\d|3[0-1])\./.test(address) || address === '127.0.0.1';
}

/* Best-effort read of the active WebRTC connection to guess whether the
   other device is on the same local network or reached over the internet.
   Only used to decide auto-approval — never shown/relied on as a security
   guarantee, since it's inferred from ICE candidate info. */
async function detectConnectionLocality(conn){
  try{
    const pc = conn.peerConnection;
    if(!pc) return 'unknown';
    const stats = await pc.getStats();
    let pair = null;
    stats.forEach(report => {
      if(report.type === 'transport' && report.selectedCandidatePairId){
        pair = stats.get(report.selectedCandidatePairId);
      }
    });
    if(!pair){
      stats.forEach(report => { if(report.type === 'candidate-pair' && report.selected) pair = report; });
    }
    if(!pair) return 'unknown';
    const remote = stats.get(pair.remoteCandidateId);
    if(!remote) return 'unknown';
    if(remote.candidateType === 'relay') return 'internet';
    if(remote.candidateType === 'srflx') return 'internet';
    if(remote.candidateType === 'host') return isPrivateIPAddress(remote.address || remote.ip) ? 'local' : 'internet';
    return 'unknown';
  }catch(e){ return 'unknown'; }
}

function shouldAutoApprove(locality){
  const mode = state.shareAutoApprove;
  if(mode === 'always') return true;
  if(mode === 'never') return false;
  if(mode === 'local') return locality === 'local';
  if(mode === 'internet') return locality === 'internet';
  return true;
}

function showSharePendingApproval(conn, item, locality){
  const row = document.getElementById('sharePendingApproval');
  const desc = document.getElementById('sharePendingDesc');
  if(!row || !desc){
    setShareStatus(`Sending "${item.name}"…`);
    sendItemOverConnection(conn, item);
    return;
  }
  const localityLabel = locality === 'local' ? 'on your local network' : locality === 'internet' ? 'over the internet' : 'nearby';
  desc.textContent = `A device connected ${localityLabel} wants to receive "${item.name}".`;
  row.hidden = false;
  setShareStatus('Waiting for your approval…');

  const approveBtn = document.getElementById('shareApproveBtn');
  const denyBtn = document.getElementById('shareDenyBtn');

  const onApprove = async () => {
    row.hidden = true;
    if(!isConnectionReallyOpen(conn)){
      setShareStatus('That connection dropped while waiting for approval — ask the other device to reconnect.');
      return;
    }
    setShareStatus(`Sending "${item.name}"…`);
    setShareProgress(0);
    await sendItemOverConnection(conn, item);
  };
  const onDeny = () => {
    row.hidden = true;
    try{ if(isConnectionReallyOpen(conn)) conn.send(JSON.stringify({ type:'error', message:'The other device declined this transfer.' })); }catch(e){}
    try{ conn.close(); }catch(e){}
    setShareStatus('Declined. Waiting for a new connection…');
  };
  // Use { once: true } so a stray duplicate 'open' event (which can happen
  // on flaky connections) can never double-bind these and fire two
  // concurrent transfers down the same channel.
  approveBtn.addEventListener('click', onApprove, { once: true });
  denyBtn.addEventListener('click', onDeny, { once: true });
}

function startShareHost(item){
  teardownShareHost();
  if(typeof Peer === 'undefined'){
    setShareCode('');
    setShareStatus("Sharing isn't available right now — the share library failed to load. Check your connection and try again.");
    return;
  }
  shareHost.item = item;
  const code = generateShareCode();
  shareHost.code = code;
  setShareCode(code);
  renderShareQr(code);
  setShareStatus('Setting up…');

  const peer = new Peer(SHARE_ID_PREFIX + code, { debug: 0 });
  shareHost.peer = peer;

  peer.on('open', () => {
    if(shareHost.peer !== peer) return;
    setShareStatus(`Code ready — enter ${code} on the other device.`);
  });
  const handledConnections = new WeakSet();
  peer.on('connection', (conn) => {
      if(shareHost.peer !== peer) return;
      setShareStatus('Connecting…');
      conn.on('open', async () => {
        if(shareHost.peer !== peer || shareHost.item !== item) return;
        if(handledConnections.has(conn)) return; // already being processed — ignore a duplicate 'open'
        handledConnections.add(conn);
        const locality = await detectConnectionLocality(conn);
        if(!isConnectionReallyOpen(conn)){
          setShareStatus('The connection dropped before it could be verified. Waiting for a new one…');
          handledConnections.delete(conn);
          return;
        }
        if(shouldAutoApprove(locality)){
          setShareStatus(`Sending "${item.name}"…`);
          setShareProgress(0);
          sendItemOverConnection(conn, item);
        } else {
          showSharePendingApproval(conn, item, locality);
        }
      });
      conn.on('error', (err) => console.error('share connection error', err));
  });
  peer.on('error', (err) => {
    if(shareHost.peer !== peer) return;
    console.error('share peer error', err);
    if(err && err.type === 'unavailable-id'){
      startShareHost(item); // extremely unlikely code collision — just retry with a fresh code
      return;
    }
    setShareStatus('Could not start sharing. Check your connection and try again.');
  });
}

function openShareModal(item){
  state.shareItem = item;
  const backdrop = document.getElementById('shareModalBackdrop');
  const itemNameEl = document.getElementById('shareItemName');
  const statusTextEl = document.getElementById('shareStatusText');
  const copyLinkBtn = document.getElementById('shareCopyLinkBtn');
  const copyImageBtn = document.getElementById('shareCopyImageBtn');

  if(itemNameEl) itemNameEl.textContent = item.name;
  if(statusTextEl) statusTextEl.textContent = item.type === 'image' ? 'Choose a link to copy below.' : 'Copy a direct link below.';
  if(copyLinkBtn){
    copyLinkBtn.onclick = () => {
      copyDirectLinkForItem(item, false);
      backdrop.hidden = true;
    };
  }
  if(copyImageBtn){
    copyImageBtn.hidden = item.type !== 'image';
    copyImageBtn.onclick = () => {
      copyDirectLinkForItem(item, true);
      backdrop.hidden = true;
    };
  }
  setShareProgress(null);
  backdrop.hidden = false;
}

function bindShareControls(){
  const backdrop = document.getElementById('shareModalBackdrop');
  const closeBtn = document.getElementById('shareModalClose');
  if(!backdrop || !closeBtn) return;

  const close = () => { backdrop.hidden = true; teardownShareHost(); };
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if(e.target === backdrop) close(); });
}

/* ---------- Receiver ---------- */
const shareReceive = { peer: null, conn: null, meta: null, chunks: [], received: 0, blob: null };

function setReceiveStatus(text){
  const el = document.getElementById('receiveStatusText');
  if(el) el.textContent = text;
}
function setReceiveProgress(fraction){
  const row = document.getElementById('receiveProgressRow');
  const fill = document.getElementById('receiveProgressFill');
  if(!row || !fill) return;
  row.hidden = fraction == null;
  if(fraction != null) fill.style.width = `${Math.max(0, Math.min(100, Math.round(fraction * 100)))}%`;
}

function teardownReceive(){
  if(shareReceive.peer){
    try{ shareReceive.peer.destroy(); }catch(e){ /* already gone */ }
  }
  shareReceive.peer = null;
  shareReceive.conn = null;
  shareReceive.meta = null;
  shareReceive.chunks = [];
  shareReceive.received = 0;
  if(shareReceive.blob) shareReceive.blob = null;
  const preview = document.getElementById('receivedPreview');
  if(preview) preview.innerHTML = '';
  const result = document.getElementById('receiveResult');
  if(result) result.hidden = true;
  setReceiveProgress(null);
}

function handleShareData(data){
  if(data instanceof ArrayBuffer){
    shareReceive.chunks.push(data);
    shareReceive.received += data.byteLength;
    const size = shareReceive.meta?.size;
    setReceiveProgress(size ? shareReceive.received / size : null);
    return;
  }
  if(typeof data === 'string'){
    try{ data = JSON.parse(data); }catch(e){ return; }
  }
  if(!data || typeof data !== 'object') return;
  if(data.type === 'meta'){
    shareReceive.meta = data;
    shareReceive.chunks = [];
    shareReceive.received = 0;
    setReceiveStatus(`Receiving "${data.name}"…`);
    setReceiveProgress(0);
  } else if(data.type === 'done'){
    const meta = shareReceive.meta || {};
    const blob = new Blob(shareReceive.chunks, { type: meta.mime || 'application/octet-stream' });
    if(blob.size === 0 || (meta.size && blob.size !== meta.size)){
      setReceiveStatus('The file arrived incomplete or empty — ask the sender to try again.');
      setReceiveProgress(null);
      shareReceive.blob = null;
      return;
    }
    shareReceive.blob = blob;
    setReceiveStatus(`Received "${meta.name || 'file'}".`);
    setReceiveProgress(null);
    showReceivedResult(meta, blob);
  } else if(data.type === 'error'){
    setReceiveStatus(data.message || 'The sender reported a problem.');
    setReceiveProgress(null);
  }
}

function showReceivedResult(meta, blob){
  document.getElementById('receivedItemName').textContent = meta.name || 'Received file';
  document.getElementById('receiveResult').hidden = false;
  openReceivedAsset(meta, blob);
}

/* Wraps a received shared file as a lightweight, non-library "item" so it can be
   handed to the app's normal video/photo/music views. Marked `ephemeral` so
   those views skip anything that would persist it into History/For You. */
function buildSharedItem(meta, blob){
  const now = Date.now();
  return {
    type: meta.itemType,
    name: meta.name || 'Received file',
    file: blob,
    path: `__shared__/${now}-${meta.name || 'file'}`,
    category: 'Received share',
    lastModified: now,
    size: blob.size,
    ephemeral: true
  };
}

/* Routes a received shared file into the same views the library uses:
   a shared video opens in the normal video watch/player, a shared photo
   opens in the normal photo focus view, and shared audio plays through
   the normal music player bar. */
/* Opens any lightweight non-library item (received share or URL-loaded media)
   in the same real views the library uses: video -> watch view, image -> focus
   view, audio -> the music player bar. */
