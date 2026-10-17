/* ==========================================================================
   Remote items — opening shared/URL items, saving to disk, bulk download,
   and lock-screen behavior (including configurable timing)
   ========================================================================== */
function openItemInAppropriateView(item){
  if(item.type === 'image'){
    setTab('images', { skipRender: true });
    openFocus(item, { push: false });
  } else if(item.type === 'video'){
    setTab('videos', { skipRender: true });
    openWatch(item, { push: false });
  } else {
    setTab('music', { skipRender: true });
    playTrack(item, [item]);
  }
}

function openReceivedAsset(meta, blob){
  if(!blob || blob.size === 0) return;
  const item = buildSharedItem(meta, blob);
  const backdrop = document.getElementById('receiveModalBackdrop');
  if(backdrop) backdrop.hidden = true;
  teardownReceive();
  openItemInAppropriateView(item);
}

/* ---------- Add from URL ---------- */

function guessTypeFromUrl(url){
  try{
    const pathname = new URL(url).pathname;
    const ext = extOf(pathname.split('/').pop() || '');
    if(VIDEO_EXT.includes(ext)) return 'video';
    if(IMAGE_EXT.includes(ext)) return 'image';
  }catch(e){}
  return null;
}
function guessTypeFromContentType(contentType){
  if(!contentType) return null;
  if(contentType.startsWith('video/')) return 'video';
  if(contentType.startsWith('image/')) return 'image';
  return null;
}
function nameFromUrl(url){
  try{
    const pathname = new URL(url).pathname;
    const last = decodeURIComponent(pathname.split('/').filter(Boolean).pop() || '');
    return last || 'file';
  }catch(e){ return 'file'; }
}

async function loadFromUrl(rawUrl){
  const statusEl = document.getElementById('urlModalStatus');
  const loadBtn = document.getElementById('urlModalLoadBtn');
  const url = (rawUrl || '').trim();
  if(!url){ statusEl.textContent = 'Paste a URL first.'; return; }

  let parsed;
  try{ parsed = new URL(url); }catch(e){ statusEl.textContent = 'That doesn\'t look like a valid URL.'; return; }
  if(parsed.protocol !== 'http:' && parsed.protocol !== 'https:'){
    statusEl.textContent = 'Only http/https URLs are supported.';
    return;
  }

  loadBtn.disabled = true;
  statusEl.textContent = 'Loading…';

  try{
    const res = await fetch(url);
    if(!res.ok){ statusEl.textContent = `Couldn't load that URL (${res.status}).`; return; }
    const contentType = res.headers.get('content-type') || '';
    let itemType = guessTypeFromContentType(contentType) || guessTypeFromUrl(url);
    if(!itemType){ statusEl.textContent = "Couldn't tell if that's a photo or a video."; return; }
    const blob = await res.blob();
    if(blob.size === 0){ statusEl.textContent = 'That URL returned an empty file.'; return; }
    const name = nameFromUrl(url);
    const now = Date.now();
    const item = {
      type: itemType, name, file: blob,
      path: `__remote__/${now}-${name}`,
      category: 'From URL', lastModified: now, size: blob.size,
      ephemeral: true, remote: true, sourceUrl: url
    };
    statusEl.textContent = '';
    document.getElementById('urlModalBackdrop').hidden = true;
    document.getElementById('urlModalInput').value = '';
    openItemInAppropriateView(item);
  }catch(err){
    console.error('load from url failed', err);
    statusEl.textContent = 'Could not load that URL — it may not allow cross-site access from a browser.';
  }finally{
    loadBtn.disabled = false;
  }
}

function bindUrlModal(){
  const backdrop = document.getElementById('urlModalBackdrop');
  const openBtn = document.getElementById('addUrlBtn');
  const mobileOpenBtn = document.getElementById('mobileAddUrlBtn');
  const closeBtn = document.getElementById('urlModalClose');
  const loadBtn = document.getElementById('urlModalLoadBtn');
  const input = document.getElementById('urlModalInput');
  if(!backdrop) return;

  const open = () => {
    backdrop.hidden = false;
    document.getElementById('urlModalStatus').textContent = '';
    input.value = '';
    input.focus();
  };
  const close = () => { backdrop.hidden = true; };

  if(openBtn) openBtn.addEventListener('click', open);
  if(mobileOpenBtn) mobileOpenBtn.addEventListener('click', () => { closeMobileShell(); open(); });
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if(e.target === backdrop) close(); });
  loadBtn.addEventListener('click', () => loadFromUrl(input.value));
  input.addEventListener('keydown', (e) => { if(e.key === 'Enter') loadFromUrl(input.value); });
}

/* ---------- Save (remote item) to the library on disk ---------- */
let saveLocationState = null;

async function getCurrentFolderHandle(tab){
  if(!state.rootHandle) return null;
  const cat = state.cat[tab];
  if(!cat || cat.startsWith('__')) return state.rootHandle;
  try{ return await state.rootHandle.getDirectoryHandle(cat); }
  catch(e){ return state.rootHandle; }
}
async function ensureReadWritePermission(handle){
  const opts = { mode: 'readwrite' };
  try{
    if((await handle.queryPermission(opts)) === 'granted') return true;
    if((await handle.requestPermission(opts)) === 'granted') return true;
  }catch(e){}
  return false;
}
async function promptSaveItem(item, tab){
  if(!window.showDirectoryPicker || !state.rootHandle){
    toast('Saving to disk needs a Chromium browser (Chrome/Edge) with a folder open.');
    return;
  }
  const dirHandle = await getCurrentFolderHandle(tab);
  saveLocationState = { item, tab, dirHandle, dirLabel: dirHandle === state.rootHandle ? state.rootName : dirHandle.name };

  document.getElementById('saveLocationName').textContent = item.name;
  document.getElementById('saveLocationFolder').textContent = `Saving to: ${saveLocationState.dirLabel}`;
  document.getElementById('saveLocationStatus').textContent = '';
  document.getElementById('saveLocationModalBackdrop').hidden = false;
}
async function writeItemToDirectory(item, dirHandle){
  const ok = await ensureReadWritePermission(dirHandle);
  if(!ok) throw new Error('Permission to write to that folder was denied.');
  let finalName = item.name;
  try{
    let exists = true;
    try{ await dirHandle.getFileHandle(finalName); }catch(e){ exists = false; }
    if(exists){
      const dot = finalName.lastIndexOf('.');
      const base = dot > 0 ? finalName.slice(0, dot) : finalName;
      const ext = dot > 0 ? finalName.slice(dot) : '';
      finalName = `${base}-${Date.now()}${ext}`;
    }
  }catch(e){}
  const fileHandle = await dirHandle.getFileHandle(finalName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(item.file);
  await writable.close();
  return { fileHandle, finalName };
}
async function integrateSavedItem(item, tab, dirHandle, fileHandle, finalName){
  const isRootSave = dirHandle === state.rootHandle;
  const category = isRootSave ? UNCATEGORIZED : dirHandle.name;
  const folderPath = isRootSave ? [] : [dirHandle.name];
  let file;
  try{ file = await fileHandle.getFile(); }catch(e){ file = item.file; }
  const libraryItem = {
    name: finalName, path: [...folderPath, finalName].join('/'), folderPath, category,
    type: item.type, handle: fileHandle, file, url: null, size: file.size,
    lastModified: file.lastModified, ext: extOf(finalName), _rand: Math.random(),
    duration: null, thumb: null, broken: false,
  };
  if(tab === 'videos') state.rawVideos.push(libraryItem);
  else if(tab === 'images') state.rawImages.push(libraryItem);
  applyExclusions();
  renderSidebar();
  renderActiveGrid();
  updateTotalCount();
  return libraryItem;
}
function bindSaveLocationModal(){
  const backdrop = document.getElementById('saveLocationModalBackdrop');
  const closeBtn = document.getElementById('saveLocationModalClose');
  const changeBtn = document.getElementById('saveLocationChangeBtn');
  const confirmBtn = document.getElementById('saveLocationConfirmBtn');
  if(!backdrop) return;

  const close = () => { backdrop.hidden = true; saveLocationState = null; };
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if(e.target === backdrop) close(); });

  changeBtn.addEventListener('click', async () => {
    if(!saveLocationState) return;
    try{
      const picked = await window.showDirectoryPicker({ mode: 'readwrite' });
      saveLocationState.dirHandle = picked;
      saveLocationState.dirLabel = picked.name;
      saveLocationState.pickedOutsideLibrary = true;
      document.getElementById('saveLocationFolder').textContent = `Saving to: ${picked.name}`;
    }catch(e){}
  });

  confirmBtn.addEventListener('click', async () => {
    if(!saveLocationState) return;
    const statusEl = document.getElementById('saveLocationStatus');
    const { item, tab, dirHandle, pickedOutsideLibrary } = saveLocationState;
    confirmBtn.disabled = true;
    statusEl.textContent = 'Saving…';
    try{
      const { fileHandle, finalName } = await writeItemToDirectory(item, dirHandle);
      if(!pickedOutsideLibrary){
        await integrateSavedItem(item, tab, dirHandle, fileHandle, finalName);
        item.remote = false;
        const saveBtn = document.getElementById(tab === 'videos' ? 'watchSaveBtn' : 'focusSaveBtn');
        if(saveBtn) saveBtn.hidden = true;
        toast(`Saved "${finalName}" to your library.`);
      } else {
        toast(`Saved "${finalName}" to ${saveLocationState.dirLabel}.`);
      }
      close();
    }catch(err){
      console.error('save failed', err);
      statusEl.textContent = err.message || 'Could not save that file.';
    }finally{
      confirmBtn.disabled = false;
    }
  });
}

function bindReceiveShareModal(){
  const backdrop = document.getElementById('receiveModalBackdrop');
  const closeBtn = document.getElementById('receiveModalClose');
  const codeInput = document.getElementById('receiveCodeInput');
  const connectBtn = document.getElementById('receiveConnectBtn');
  const downloadBtn = document.getElementById('receiveDownloadBtn');
  const playBtn = document.getElementById('receivePlayBtn');
  if(!backdrop || !closeBtn || !codeInput || !connectBtn || !downloadBtn || !playBtn) return;

  const openModal = () => {
    teardownReceive();
    codeInput.value = '';
    setReceiveStatus('');
    backdrop.hidden = false;
    codeInput.focus();
  };
  const close = () => { backdrop.hidden = true; teardownReceive(); };

  document.getElementById('receiveShareBtn')?.addEventListener('click', openModal);
  document.getElementById('mobileReceiveBtn')?.addEventListener('click', () => { closeMobileShell(); openModal(); });
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if(e.target === backdrop) close(); });

  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });
  codeInput.addEventListener('keydown', (e) => { if(e.key === 'Enter') connectBtn.click(); });

  connectBtn.addEventListener('click', () => {
    const code = codeInput.value.trim();
    if(code.length < 4){ setReceiveStatus('Enter the code shown on the other device.'); return; }
    if(typeof Peer === 'undefined'){
      setReceiveStatus("Sharing isn't available right now — check your connection and try again.");
      return;
    }
    teardownReceive();
    setReceiveStatus('Connecting…');
    const peer = new Peer({ debug: 0 });
    shareReceive.peer = peer;
    peer.on('open', () => {
      if(shareReceive.peer !== peer) return;
      const conn = peer.connect(SHARE_ID_PREFIX + code, { reliable: true, serialization: 'raw' });
      shareReceive.conn = conn;
      conn.on('open', () => { if(shareReceive.peer === peer) setReceiveStatus('Connected — waiting for the file…'); });
      conn.on('data', (data) => { if(shareReceive.peer === peer) handleShareData(data); });
      conn.on('error', (err) => {
        console.error('receive connection error', err);
        if(shareReceive.peer === peer) setReceiveStatus('Could not connect. Check the code and try again.');
      });
      conn.on('close', () => {
        if(shareReceive.peer === peer && !shareReceive.blob) setReceiveStatus('Connection closed before the file finished.');
      });
    });
    peer.on('error', (err) => {
      console.error('receive peer error', err);
      if(shareReceive.peer !== peer) return;
      if(err && err.type === 'peer-unavailable') setReceiveStatus("No share found with that code — double check it's still open on the other device.");
      else setReceiveStatus('Could not connect. Check your connection and try again.');
    });
  });

  downloadBtn.addEventListener('click', () => {
    if(!shareReceive.blob || !shareReceive.meta) return;
    const url = URL.createObjectURL(shareReceive.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = shareReceive.meta.name || 'shared-file';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  });

  playBtn.addEventListener('click', () => {
    if(!shareReceive.blob || !shareReceive.meta) return;
    openReceivedAsset(shareReceive.meta, shareReceive.blob);
  });
}

function bindBulkDownloadButton(){
  const toggleBtn = document.getElementById('toggleSnapshotSelectBtn');
  const downloadBtn = document.getElementById('downloadSelectedSnapshotsBtn');
  const deleteBtn = document.getElementById('deleteSelectedSnapshotsBtn'); // NEW
  if(toggleBtn) toggleBtn.addEventListener('click', toggleSnapshotSelectMode);
  if(downloadBtn) downloadBtn.addEventListener('click', downloadSelectedSnapshots);
  if(deleteBtn) deleteBtn.addEventListener('click', deleteSelectedSnapshots); // NEW
}

/* ---------- Lock screen: blur-delay + inactivity auto-lock + tamper guard ---------- */
let blurLockTimer = null;
let inactivityLockTimer = null;
let isLockedNow = false;
let lockEnforcerObserver = null;
let lockEnforcerInterval = null;

async function sha256Hex(str){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str || ''));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
/* Old installs stored the raw password; a hash is always 64 hex chars, so
   anything else is a legacy plaintext value — rehash it once and move on. */
async function normalizeStoredLockPassword(){
  const val = state.lockPassword;
  if(val && !/^[0-9a-f]{64}$/i.test(val)){
    state.lockPassword = await sha256Hex(val);
    saveLockPassword();
  }
}

function wireLockGateEvents(){
  const lockBackdrop = document.getElementById('lockGate');
  const lockForm = document.getElementById('lockForm');
  const lockInput = document.getElementById('lockPasswordEntry');
  const unlockBtn = document.getElementById('unlockBtn');
  const lockError = document.getElementById('lockError');
  if(!lockBackdrop || !lockInput || !unlockBtn) return;

  const unlock = async () => {
    if(lockBackdrop.hidden) return;
    const attemptHash = await sha256Hex(lockInput.value);
    if(attemptHash === state.lockPassword){
      exitLockedState();
      lockInput.value = '';
      if(lockError) lockError.hidden = true;
      toast('Unlocked');
      retryStalledThumbs();
      scheduleInactivityLockReset();
    } else {
      if(lockError){ lockError.textContent = 'Password incorrect'; lockError.hidden = false; }
      toast('Password incorrect');
    }
  };

  if(lockForm){
    lockForm.addEventListener('submit', (e) => { e.preventDefault(); unlock(); });
  } else {
    unlockBtn.addEventListener('click', unlock);
    lockInput.addEventListener('keydown', (e) => { if(e.key === 'Enter') unlock(); });
  }
}

/* Rebuilds #lockGate from the pristine template captured at page load if
   it's ever missing from the DOM (deleted via devtools, etc.), and
   re-wires its form. Safe to call repeatedly — no-ops if it already exists. */
function ensureLockGateExists(){
  let gate = document.getElementById('lockGate');
  if(gate) return gate;
  if(!LOCK_GATE_TEMPLATE) return null;
  const wrap = document.createElement('div');
  wrap.innerHTML = LOCK_GATE_TEMPLATE;
  gate = wrap.firstElementChild;
  document.body.appendChild(gate);
  wireLockGateEvents();
  return gate;
}

function enterLockedState(){
  isLockedNow = true;
  const video = document.getElementById('videoPlayer');
  if(video && !video.paused) video.pause();
  const musicAudio = document.getElementById('musicAudioEl');
  if(musicAudio && !musicAudio.paused) musicAudio.pause();
  if(typeof clearNextUpPrompt === 'function') clearNextUpPrompt({ dismissed: true });
  enforceLockState();
  if(inactivityLockTimer){ clearTimeout(inactivityLockTimer); inactivityLockTimer = null; }
}
function exitLockedState(){
  isLockedNow = false;
  const appEl = document.getElementById('app');
  const gate = document.getElementById('lockGate');
  if(appEl) appEl.hidden = false;
  if(gate) gate.hidden = true;
}

/* The tamper guard: whenever isLockedNow is true, this repeatedly forces
   #app hidden and #lockGate visible, rebuilding the gate if it's gone.
   Called from a MutationObserver (instant) and a backup interval (belt
   and suspenders in case a mutation slips through). */
function enforceLockState(){
  if(!isLockedNow) return;
  const gate = ensureLockGateExists();
  const appEl = document.getElementById('app');
  if(gate){
    if(gate.hidden) gate.hidden = false;
    gate.style.removeProperty('display');
  }
  if(appEl && !appEl.hidden) appEl.hidden = true;
}
function startLockEnforcer(){
  if(lockEnforcerObserver) return;
  lockEnforcerObserver = new MutationObserver(() => { if(isLockedNow) enforceLockState(); });
  lockEnforcerObserver.observe(document.body, {
    attributes: true, attributeFilter: ['hidden', 'style', 'class'],
    childList: true, subtree: true,
  });
  lockEnforcerInterval = setInterval(() => { if(isLockedNow) enforceLockState(); }, 1200);
}

function scheduleInactivityLockReset(){
  if(inactivityLockTimer){ clearTimeout(inactivityLockTimer); inactivityLockTimer = null; }
  if(!(state.lockEnabled && state.lockPassword && state.lockTimeoutMinutes > 0)) return;
  inactivityLockTimer = setTimeout(() => {
    if(typeof lockScreenNow === 'function') lockScreenNow();
  }, state.lockTimeoutMinutes * 60000);
}

let lockScreenNow = null;

function bindLockBehavior(){
  if(lockBound) return;
  lockBound = true;
  startLockEnforcer();
  normalizeStoredLockPassword();
  // Ensure the lock gate element exists in the document and is wired
  // up. This handles cases where the gate was removed or lives inside a
  // stacking context that breaks interactivity; rebuilding ensures it's
  // appended to document.body and event handlers are attached.
  const gate = ensureLockGateExists();
  if(gate){
    gate.style.zIndex = '100001';
    wireLockGateEvents();
  }

  lockScreenNow = function lockNow(){
    if(state.lockEnabled && state.lockPassword && !isLockedNow){
      enterLockedState();
    }
  };

  window.addEventListener('blur', () => {
    if(!(state.lockEnabled && state.lockPassword)) return;
    if(blurLockTimer) clearTimeout(blurLockTimer);
    const delayMs = Math.max(0, state.lockBlurDelaySeconds) * 1000;
    if(delayMs <= 0){ lockScreenNow(); return; }
    blurLockTimer = setTimeout(() => { blurLockTimer = null; lockScreenNow(); }, delayMs);
  });
  window.addEventListener('focus', () => {
    if(blurLockTimer){ clearTimeout(blurLockTimer); blurLockTimer = null; }
  });
  document.addEventListener('visibilitychange', () => {
    if(document.visibilityState === 'hidden'){
      if(blurLockTimer){ clearTimeout(blurLockTimer); blurLockTimer = null; }
      lockScreenNow();
    }
  });
  ['mousemove','mousedown','keydown','touchstart','wheel'].forEach(evt => {
    window.addEventListener(evt, () => { if(!isLockedNow) scheduleInactivityLockReset(); }, { passive: true });
  });

  if(state.lockEnabled && state.lockPassword) lockScreenNow();
  else scheduleInactivityLockReset();
}

/* ------------------------------------------------------------------
   Connect to a Filebeam / Midnight Explorer host by IP/URL and browse
   its files via the server's /api/list and /api/view endpoints.
   Minimal: shows a modal, lets you navigate folders, open or download
   files, and 'use' a folder (stores a link in localStorage).
   ------------------------------------------------------------------ */
const remoteHostState = { base: null, path: '', items: [], pendingLockedPath: null };

function normalizeHostUrl(raw){
  let s = (raw || '').trim();
  if(!s) return null;
  if(!/^https?:\/\//i.test(s)) s = 'http://' + s;
  try{ const u = new URL(s); return u.origin; }catch(e){ return null; }
}

async function fetchRemoteList(path = ''){
  const base = remoteHostState.base; if(!base) throw new Error('Not connected');
  const url = `${base}/api/list${path ? '?path=' + encodeURIComponent(path) : ''}`;
  const statusEl = document.getElementById('remoteHostStatus');
  const label = base.replace(/^https?:\/\//i, '');
  try{
    const res = await fetch(url, { credentials: 'omit' });
    if(res.status === 403){ if(statusEl) statusEl.textContent = 'Host denied access — the host needs to approve your device.'; return null; }
    if(!res.ok){
      if(statusEl) statusEl.textContent = `The device at ${label} responded, but it rejected the request (${res.status}).`;
      return null;
    }
    const contentType = res.headers.get('content-type') || '';
    if(contentType && !contentType.includes('application/json')){
      if(statusEl) statusEl.textContent = `The host at ${label} did not return the expected Midnight file list format.`;
      return null;
    }
    const data = await res.json();
    if(!data || !Array.isArray(data.items)){
      if(statusEl) statusEl.textContent = `The host at ${label} did not return a valid file list.`;
      return null;
    }
    return data.items;
  }catch(err){
    console.warn('[remote] list fetch failed:', err && err.message ? err.message : err);
    if(statusEl) statusEl.textContent = `Could not reach ${label}. Check that the server is running and the IP/port is correct.`;
    return null;
  }
}

function renderRemoteList(items, path){
  const wrap = document.getElementById('remoteHostList');
  const statusEl = document.getElementById('remoteHostStatus');
  const useBtn = document.getElementById('remoteHostUseFolderBtn');
  const pwRowLocal = document.getElementById('remoteHostPasswordRow');
  if(!wrap) return;
  wrap.innerHTML = '';
  if(statusEl) statusEl.textContent = `Browsing: ${path || '/'} (${items.length} items)`;
  remoteHostState.path = path || '';
  useBtn.hidden = false;
  items.forEach(it => {
    const row = document.createElement('div');
    row.className = 'setting-row';
    row.style.display = 'flex'; row.style.justifyContent = 'space-between'; row.style.alignItems='center';
    const left = document.createElement('div'); left.className='setting-text';
    const title = document.createElement('div'); title.className='setting-title'; title.textContent = it.name || '—';
    const desc = document.createElement('div'); desc.className='setting-desc'; desc.textContent = it.is_dir ? 'Folder' : `${it.type || 'file'} ${it.size ? '· ' + formatBytes(it.size) : ''}`;
    if(it.locked) desc.textContent += ' · Locked';
    left.appendChild(title); left.appendChild(desc);
    const actions = document.createElement('div'); actions.style.display='flex'; actions.style.gap='8px';
    const openBtn = document.createElement('button'); openBtn.className='btn-ghost small'; openBtn.type='button';
    openBtn.textContent = it.is_dir ? 'Open' : 'Open';
    openBtn.addEventListener('click', async () => {
      // If item is locked, require a password first (covers locked folders and files)
      if(it.locked){
        remoteHostState.pendingLockedPath = it.path;
        if(pwRowLocal) { pwRowLocal.hidden = false; console.debug('[remote] showing password row for', it.path); }
        else console.debug('[remote] password row element missing when trying to show for', it.path);
        return;
      }
      if(it.is_dir){
        const next = await fetchRemoteList(it.path);
        if(next) renderRemoteList(next, it.path);
        return;
      }
      // download file and open
      try{
        const res = await fetch(`${remoteHostState.base}/api/view?path=${encodeURIComponent(it.path)}`);
        if(!res.ok){ if(statusEl) statusEl.textContent = `Could not fetch file (${res.status})`; return; }
        const blob = await res.blob();
        const meta = { name: it.name, itemType: it.type, size: it.size, mime: res.headers.get('content-type') };
        openReceivedAsset(meta, blob);
      }catch(e){ console.error(e); if(statusEl) statusEl.textContent = 'Failed to download file.'; }
    });
    actions.appendChild(openBtn);
    const dl = document.createElement('button'); dl.className='btn-ghost small'; dl.type='button'; dl.textContent='Download';
    dl.addEventListener('click', async () => {
      try{
        const res = await fetch(`${remoteHostState.base}/api/view?path=${encodeURIComponent(it.path)}`);
        if(!res.ok){ if(statusEl) statusEl.textContent = `Could not fetch file (${res.status})`; return; }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = it.name || 'file'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),4000);
      }catch(e){ console.error(e); if(statusEl) statusEl.textContent = 'Failed to download file.'; }
    });
    actions.appendChild(dl);
    row.appendChild(left); row.appendChild(actions);
    wrap.appendChild(row);
  });
}

function bindRemoteHostModal(){
  const backdrop = document.getElementById('remoteHostModalBackdrop');
  const openBtn = document.getElementById('openRemoteHostBtn');
  const mobileOpenBtn = document.getElementById('mobileOpenRemoteHostBtn');
  const closeBtn = document.getElementById('remoteHostModalClose');
  let connectBtn = document.getElementById('remoteHostConnectBtn');
  const input = document.getElementById('remoteHostInput');
  const pwRow = document.getElementById('remoteHostPasswordRow');
  const pwInput = document.getElementById('remoteHostPasswordInput');
  const pwBtn = document.getElementById('remoteHostPasswordBtn');
  const useBtn = document.getElementById('remoteHostUseFolderBtn');
  if(!backdrop || !openBtn || !closeBtn || !input) return;
  console.debug('[remote] bindRemoteHostModal: elements', { backdrop: !!backdrop, openBtn: !!openBtn, closeBtn: !!closeBtn, connectBtn: !!connectBtn, input: !!input });
  try{
    if(backdrop && backdrop.parentElement !== document.body){
      document.body.appendChild(backdrop);
      console.debug('[remote] moved remoteHostModalBackdrop to document.body');
    }
  }catch(e){ console.warn('[remote] could not move backdrop to body', e); }

  // If the template somehow lost its Connect button, create one so the
  // modal always has a usable Connect control.
  if(!connectBtn){
    try{
      const inputWrap = input.parentElement || backdrop.querySelector('.share-code-row');
      const btn = document.createElement('button');
      btn.id = 'remoteHostConnectBtn'; btn.className = 'btn-ghost small'; btn.type = 'button'; btn.textContent = 'Connect';
      if(inputWrap) inputWrap.appendChild(btn);
      connectBtn = btn;
      console.debug('[remote] created missing remoteHostConnectBtn dynamically');
    }catch(e){ console.warn('[remote] could not create connect button', e); }
  }

  const open = () => {
    try{
      backdrop.hidden = false;
      backdrop.style.display = 'flex';
      backdrop.style.zIndex = '99999';
      document.getElementById('remoteHostStatus').textContent='';
      input.value = '';
      input.focus();
      const cs = window.getComputedStyle(backdrop);
      console.debug('[remote] modal opened, computedStyle:', { display: cs.display, visibility: cs.visibility, zIndex: cs.zIndex });
      console.debug('[remote] modal rect:', backdrop.getBoundingClientRect());
    }catch(e){ console.warn('[remote] open() error', e); }
  };
  const close = () => {
    backdrop.hidden = true;
    remoteHostState.base = null;
    const listEl = document.getElementById('remoteHostList'); if(listEl) listEl.innerHTML = '';
    if(pwRow) { pwRow.hidden = true; console.debug('[remote] hiding password row on modal close'); }
    else { const r = document.getElementById('remoteHostPasswordRow'); if(r) r.hidden = true; }
  };
  if(openBtn) openBtn.addEventListener('click', () => { console.debug('[remote] open button clicked'); try{ if(typeof closeMobileShell === 'function') closeMobileShell(); }catch(e){ console.warn('[remote] closeMobileShell error', e); } open(); });
  if(mobileOpenBtn) mobileOpenBtn.addEventListener('click', () => { console.debug('[remote] mobile open button clicked'); try{ if(typeof closeMobileShell === 'function') closeMobileShell(); }catch(e){ console.warn('[remote] closeMobileShell error', e); } open(); });
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if(e.target === backdrop) close(); });

  connectBtn.addEventListener('click', async () => {
    const raw = input.value.trim();
    const base = normalizeHostUrl(raw);
    const statusEl = document.getElementById('remoteHostStatus');
    console.debug('[remote] connect clicked, raw=', raw, 'base=', base);
    if(!base){ if(statusEl) statusEl.textContent = 'Enter a valid host address.'; return; }
    remoteHostState.base = base;
    statusEl.textContent = 'Connecting…';
    const items = await fetchRemoteList('');
    if(items === null){
      remoteHostState.base = null;
      return;
    }
    renderRemoteList(items, '');
  });

  pwBtn.addEventListener('click', async () => {
    const pw = pwInput.value || '';
    const path = remoteHostState.pendingLockedPath;
    if(!path) return;
    const statusEl = document.getElementById('remoteHostStatus');
    console.debug('[remote] checking password for', path);
    try{
      const res = await fetch(`${remoteHostState.base}/api/check_lock`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ path, password: pw }) });
      if(!res.ok){ statusEl.textContent = 'Host rejected the password or connection failed.'; return; }
      const data = await res.json();
      if(data.ok){
        if(pwRow){ pwRow.hidden = true; console.debug('[remote] password accepted, hiding row'); }
        else { const r = document.getElementById('remoteHostPasswordRow'); if(r) r.hidden = true; }
        pwInput.value = '';
        const pending = remoteHostState.pendingLockedPath;
        remoteHostState.pendingLockedPath = null;
        try{
          if(pending){
            // Try to list the pending path — if it's a folder this will return items.
            const items = await fetchRemoteList(pending);
            if(items && items.length >= 0){
              // If items is an array, render it (folder)
              renderRemoteList(items, pending);
            } else {
              // Not a folder — try to fetch the file and open it
              const res2 = await fetch(`${remoteHostState.base}/api/view?path=${encodeURIComponent(pending)}`);
              if(res2 && res2.ok){
                const blob = await res2.blob();
                const meta = { name: (pending.split('/').pop() || 'file'), itemType: res2.headers.get('content-type') || '', size: blob.size, mime: res2.headers.get('content-type') };
                openReceivedAsset(meta, blob);
              } else {
                // fallback to refreshing current listing
                const items2 = await fetchRemoteList(remoteHostState.path);
                if(items2) renderRemoteList(items2, remoteHostState.path);
              }
            }
          } else {
            const items = await fetchRemoteList(remoteHostState.path);
            if(items) renderRemoteList(items, remoteHostState.path);
          }
        }catch(e){ console.warn('[remote] post-password fetch failed', e); }
      }
      else { statusEl.textContent = 'Password incorrect.'; }
    }catch(e){ console.error(e); if(statusEl) statusEl.textContent = 'Password check failed.'; }
  });

  useBtn.addEventListener('click', () => {
    if(!remoteHostState.base) return;
    const savedBase = remoteHostState.base;
    const savedPath = remoteHostState.path;
    const payload = { base: savedBase, path: savedPath };
    try{
      localStorage.setItem('reelframe-linked-host', JSON.stringify(payload));
      toast('Linked remote folder. Reopen Connect to browse it quickly.');
    }catch(e){ console.warn('[remote] could not save linked host', e); }
    // Close the modal to give clear feedback, but restore state for loading
    try{ close(); }catch(e){}
    // restore base/path for the loading operation
    remoteHostState.base = savedBase;
    remoteHostState.path = savedPath || '';
    console.debug('[remote] loading linked host with base,path', savedBase, savedPath);
    // Attempt to load the linked folder into the main UI as a paired-style library
    (async () => {
      try{
        showLoadingScreen('Loading remote folder…');
        const items = await fetchRemoteList(remoteHostState.path || '');
        if(!items) { await hideLoadingScreen(); toast('Could not load remote folder.'); return; }
        // Recursively walk the chosen folder and collect files (include subfolders)
        const allFiles = [];
        const q = [remoteHostState.path || ''];
        while(q.length){
          const cur = q.shift();
          const list = await fetchRemoteList(cur);
          if(!list) { throw new Error('Could not list ' + cur); }
          for(const it of list){
            if(it.is_dir){ q.push(it.path); continue; }
            allFiles.push(it);
          }
        }
        // Build local-style library items (non-paired) pointing at the host's API
        const base = savedBase;
        const localVideos = [];
        const localImages = [];
        // Normalize savedPath for relative calculations
        const normSaved = (savedPath || '').replace(/\\/g, '/');
        const savedRoot = normSaved.endsWith('/') || normSaved === '' ? normSaved : normSaved + '/';
        allFiles.forEach(it => {
          const fullUrl = `${base}/api/view?path=${encodeURIComponent(it.path)}`;
          const itNorm = (it.path || '').replace(/\\/g, '/');
          let rel = itNorm;
          if(savedRoot && itNorm.toLowerCase().startsWith(savedRoot.toLowerCase())) rel = itNorm.slice(savedRoot.length);
          const segs = rel.split('/').filter(Boolean);
          const folderSegments = segs.slice(0, -1);
          const category = folderSegments.length ? folderSegments[0] : UNCATEGORIZED;
          const folderPath = folderSegments;
          if(it.type === 'video'){
            localVideos.push({ name: it.name, path: it.path, folderPath, category, type: 'video', handle: null, file: null, url: fullUrl, size: it.size || 0, lastModified: it.modified || Date.now(), ext: extOf(it.name), _rand: Math.random(), duration: null, thumb: null, broken: false });
          } else if(it.type === 'image'){
            const thumbUrl = `${base}/api/view?path=${encodeURIComponent(it.path)}&thumb=1`;
            localImages.push({ name: it.name, path: it.path, folderPath, category, type: 'image', handle: null, file: null, url: fullUrl, size: it.size || 0, lastModified: it.modified || Date.now(), ext: extOf(it.name), _rand: Math.random(), thumb: thumbUrl, broken: false });
          }
        });
        // Integrate into app state (mirror activatePairedLibrary's post-setup steps)
        state.rootHandle = null;
        state.rootName = `Remote: ${savedBase}${savedPath ? ' ' + savedPath : ''}`;
        state.rawVideos = localVideos;
        state.rawImages = localImages;
        state.rawAudio = [];
        state.snapshots = [];
        state.excluded = new Set();
        state.isDemo = false;
        applyExclusions();
        // Update UI
        document.getElementById('rootName').textContent = state.rootName;
        updateTotalCount();
        renderSidebar();
        // Jump to videos if we have videos, else images
        if(localVideos.length > 0) setTab('videos', { skipRender:true });
        else setTab('images', { skipRender:true });
        switchViewsForTab();
        clearUrlParams();
        scrollMainTop();
        renderActiveGrid();
        toast('Linked remote folder loaded.');
      }catch(e){ console.error('[remote] load linked host failed', e); toast('Failed to load linked host.'); }
      finally{ try{ await hideLoadingScreen(); }catch(e){} }
    })();
  });
}

// bindRemoteHostModal is called from app init to ensure consistent startup
// Also bind safely on DOMContentLoaded / now so the connect button works
try{
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', () => { try{ bindRemoteHostModal(); }catch(e){ console.warn('[remote] bind failed on DOMContentLoaded', e); } });
  } else {
    try{ bindRemoteHostModal(); }catch(e){ console.warn('[remote] initial bind failed', e); }
  }
}catch(e){ console.warn('[remote] bind setup failed', e); }