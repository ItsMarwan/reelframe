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

/* ---------- Lock screen: blur-delay + inactivity auto-lock ---------- */
let blurLockTimer = null;
let inactivityLockTimer = null;

function scheduleInactivityLockReset(){
  if(inactivityLockTimer){ clearTimeout(inactivityLockTimer); inactivityLockTimer = null; }
  if(!(state.lockEnabled && state.lockPassword && state.lockTimeoutMinutes > 0)) return;
  inactivityLockTimer = setTimeout(() => {
    if(typeof lockScreenNow === 'function') lockScreenNow();
  }, state.lockTimeoutMinutes * 60000);
}

let lockScreenNow = null; // assigned inside bindLockBehavior, used by the inactivity timer above

function bindLockBehavior(){
  if(lockBound) return;
  lockBound = true;
  const lockBackdrop = document.getElementById('lockGate');
  const lockForm = document.getElementById('lockForm');
  const lockInput = document.getElementById('lockPasswordEntry');
  const unlockBtn = document.getElementById('unlockBtn');
  const lockError = document.getElementById('lockError');
  if(!lockBackdrop || !lockInput || !unlockBtn) return;

  lockScreenNow = function lockNow(){
    if(state.lockEnabled && state.lockPassword && document.getElementById('lockGate').hidden){
      const video = document.getElementById('videoPlayer');
      if(video && !video.paused) video.pause();
      const musicAudio = document.getElementById('musicAudioEl');
      if(musicAudio && !musicAudio.paused) musicAudio.pause();
      if(typeof clearNextUpPrompt === 'function') clearNextUpPrompt({ dismissed: true });
      document.getElementById('app').hidden = true;
      lockBackdrop.hidden = false;
      lockInput.value = '';
      if(lockError) lockError.hidden = true;
    }
    if(inactivityLockTimer){ clearTimeout(inactivityLockTimer); inactivityLockTimer = null; }
  };

  const unlock = () => {
    if(lockBackdrop.hidden) return;
    if(lockInput.value === state.lockPassword){
      lockBackdrop.hidden = true;
      document.getElementById('app').hidden = false;
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

  // Losing window focus (alt-tab, switched app) gets a configurable grace
  // period instead of an instant lock — quick alt-tabs shouldn't boot you out.
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

  // A genuinely hidden tab (switched tabs, minimized, screen off) locks
  // immediately regardless of the blur-delay setting.
  document.addEventListener('visibilitychange', () => {
    if(document.visibilityState === 'hidden'){
      if(blurLockTimer){ clearTimeout(blurLockTimer); blurLockTimer = null; }
      lockScreenNow();
    }
  });

  // Any real interaction resets the inactivity clock.
  ['mousemove','mousedown','keydown','touchstart','wheel'].forEach(evt => {
    window.addEventListener(evt, () => { if(lockBackdrop.hidden) scheduleInactivityLockReset(); }, { passive: true });
  });

  if(state.lockEnabled && state.lockPassword){
    lockScreenNow();
  } else {
    scheduleInactivityLockReset();
  }
}