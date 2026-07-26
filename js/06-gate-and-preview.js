/* ==========================================================================
   Gate — directory picker
   ========================================================================== */
const gateEl = document.getElementById('gate');
const appEl = document.getElementById('app');
const pickDirBtn = document.getElementById('pickDirBtn');
const gateStatus = document.getElementById('gateStatus');
const gateError = document.getElementById('gateError');

function showGateError(msg){
  gateError.textContent = msg;
  gateError.hidden = false;
}

async function launchWithHandle(handle){
  gateStatus.textContent = '';
  pickDirBtn.disabled = true;
  gateError.hidden = true;
  gateEl.style.display = 'none';
  if(state.lockEnabled && state.lockPassword){
    showLockGate();
  }
  showLoadingScreen(`Reading “${handle.name}”`);
  try{
    const { videos, images, audio } = await scanDirectory(handle, updateLoadingProgress);
    if(videos.length === 0 && images.length === 0 && audio.length === 0){
      await hideLoadingScreen();
      gateEl.style.display = 'flex';
      showGateError('No supported videos, photos, or music were found in that folder (or its subfolders). Choose a different one?');
      gateStatus.textContent = '';
      pickDirBtn.disabled = false;
      return;
    }
    state.rootHandle = handle;
    state.rootName = handle.name;
    state.rawVideos = videos;
    state.rawImages = images;
    state.rawAudio = audio;
    state.excluded = loadExcluded(handle.name);
    applyExclusions();
    await hideLoadingScreen();
    appEl.hidden = false;
    await initAppUI();
  }catch(err){
    console.error(err);
    await hideLoadingScreen();
    gateEl.style.display = 'flex';
    showGateError('Something went wrong reading that folder. Please try again.');
    gateStatus.textContent = '';
    pickDirBtn.disabled = false;
  }
}

pickDirBtn.addEventListener('click', async () => {
  if(!window.showDirectoryPicker){
    showGateError('Your browser doesn\u2019t support local folder access. Please open Reelframe in a recent version of Chrome or Edge.');
    return;
  }
  try{
    gateError.hidden = true;
    const handle = await window.showDirectoryPicker();
    idbSet('root', handle).catch(()=>{});
    await launchWithHandle(handle);
  }catch(err){
    if(err.name !== 'AbortError'){
      console.error(err);
      showGateError('Permission wasn\u2019t granted, so Reelframe can\u2019t read that folder.');
    }
  }
});

/* ==========================================================================
   Preview mode — loads a small sample library from public demo APIs so
   people can see how Reelframe looks and works before granting folder
   access. Items behave like normal library items (grid, watch, favorite,
   search…) but stream from remote URLs instead of local files, so
   features that need an actual File (saving to disk, ID3 tags, etc.)
   are simply not available on them.
   ========================================================================== */
const DEMO_VIDEOS_URL = 'https://gist.githubusercontent.com/poudyalanil/ca84582cbeb4fc123a13290a586da925/raw/14a27bd0bcd0cd323b35ad79cf3b493dddf6216b/videos.json';
const DEMO_PHOTOS_URL = 'https://api.thecatapi.com/v1/images/search?limit=24';
const previewDemoBtn = document.getElementById('previewDemoBtn');

/* Turns a "8:18" / "1:02:30" style clock string into whole seconds. */
function parseClockDuration(str){
  if(!str) return null;
  const parts = String(str).split(':').map(n => parseInt(n, 10));
  if(!parts.length || parts.some(n => Number.isNaN(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}
/* Loosely parses a human date string ("May 9, 2011"); falls back to now. */
function parseLooseDate(str){
  const t = Date.parse(str || '');
  return Number.isFinite(t) ? t : Date.now();
}

async function fetchDemoVideos(){
  try{
    const res = await fetch(DEMO_VIDEOS_URL);
    if(!res.ok) return [];
    const list = await res.json();
    if(!Array.isArray(list)) return [];
    return list.map((v, idx) => ({
      name: v.title || `Sample video ${idx + 1}`,
      path: `demo/videos/${v.id || idx}`,
      folderPath: ['Sample Videos'],
      category: 'Sample Videos',
      type: 'video',
      handle: null,
      file: null,
      url: v.videoUrl || '',
      size: 0,
      lastModified: parseLooseDate(v.uploadTime),
      ext: 'mp4',
      _rand: Math.random(),
      duration: parseClockDuration(v.duration),
      thumb: v.thumbnailUrl || null,
      demo: true,
    })).filter(item => item.url);
  }catch(e){
    console.warn('Preview videos failed to load', e);
    return [];
  }
}

async function fetchDemoPhotos(){
  try{
    const res = await fetch(DEMO_PHOTOS_URL);
    if(!res.ok) return [];
    const list = await res.json();
    if(!Array.isArray(list)) return [];
    return list.map((c, idx) => ({
      name: `Sample photo ${idx + 1}`,
      path: `demo/photos/${c.id || idx}`,
      folderPath: ['Sample Photos'],
      category: 'Sample Photos',
      type: 'image',
      handle: null,
      file: null,
      url: c.url || '',
      size: 0,
      lastModified: Date.now() - idx * 3600000,
      ext: 'jpg',
      _rand: Math.random(),
      duration: null,
      thumb: null,
      demo: true,
    })).filter(item => item.url);
  }catch(e){
    console.warn('Preview photos failed to load', e);
    return [];
  }
}

async function launchDemoLibrary(){
  gateStatus.textContent = '';
  gateError.hidden = true;
  pickDirBtn.disabled = true;
  if(previewDemoBtn) previewDemoBtn.disabled = true;
  gateEl.style.display = 'none';
  showLoadingScreen('Loading a sample library');
  try{
    const [videos, images] = await Promise.all([fetchDemoVideos(), fetchDemoPhotos()]);
    if(videos.length === 0 && images.length === 0){
      await hideLoadingScreen();
      gateEl.style.display = 'flex';
      showGateError('Couldn\u2019t load the sample library right now — check your connection and try again.');
      pickDirBtn.disabled = false;
      if(previewDemoBtn) previewDemoBtn.disabled = false;
      return;
    }
    state.rootHandle = null;
    state.rootName = 'Sample Library (Preview)';
    state.rawVideos = videos;
    state.rawImages = images;
    state.rawAudio = [];
    state.excluded = loadExcluded(state.rootName);
    state.isDemo = true;
    applyExclusions();
    await hideLoadingScreen();
    appEl.hidden = false;
    await initAppUI();
    if(!hasReceiveParam()){
      toast('Previewing sample media — choose a folder anytime to use your own library.');
    }
  }catch(err){
    console.error(err);
    await hideLoadingScreen();
    gateEl.style.display = 'flex';
    showGateError('Something went wrong loading the sample library. Please try again.');
    pickDirBtn.disabled = false;
    if(previewDemoBtn) previewDemoBtn.disabled = false;
  }
}

if(previewDemoBtn) previewDemoBtn.addEventListener('click', launchDemoLibrary);

async function tryRestorePreviousFolder(){
  if(!window.showDirectoryPicker || !indexedDB) return;
  try{
    const handle = await idbGet('root');
    if(!handle) return;
    const perm = await handle.queryPermission({ mode:'read' });
    if(perm === 'granted'){
      await launchWithHandle(handle);
    } else {
      gateStatus.textContent = `Last used: "${handle.name}"`;
      pickDirBtn.textContent = '';
      pickDirBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg> Continue with "${handle.name}"`;
      pickDirBtn.onclick = null;
      pickDirBtn.addEventListener('click', async function reauth(){
        try{
          const p = await handle.requestPermission({ mode:'read' });
          if(p === 'granted') await launchWithHandle(handle);
          else showGateError('Permission is needed to open this folder.');
        }catch(e){ showGateError('Could not reconnect to that folder. Choose it again.'); }
      }, { once:true });
    }
  }catch(e){ /* ignore — fall back to normal picker */ }
}
function hasReceiveParam(){
  return new URLSearchParams(location.search).has('receive');
}

if(hasReceiveParam()){
  // Someone scanned a share QR (or opened a ?receive= link) — don't make
  // them pick a folder first. Jump straight into the app using the sample
  // library so the shell/UI exists, then syncViewFromURL() (called from
  // initAppUI) picks up ?receive= and routes into the receive flow itself.
  launchDemoLibrary();
} else {
  tryRestorePreviousFolder();
}
bindLockBehavior();

document.getElementById('changeDirBtn').addEventListener('click', () => {
  const musicAudio = document.getElementById('musicAudioEl');
  if(musicAudio) musicAudio.pause();
  const musicBar = document.getElementById('musicPlayerBar');
  if(musicBar) musicBar.hidden = true;
  document.getElementById('app').classList.remove('has-music-bar');
  appEl.hidden = true;
  gateEl.style.display = 'flex';
  gateStatus.textContent = '';
  gateError.hidden = true;
  state.isDemo = false;
  pickDirBtn.disabled = false;
  pickDirBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg> Choose a folder`;
  if(previewDemoBtn) previewDemoBtn.disabled = false;
});

/* ==========================================================================
   Refresh library — rescans the currently-open folder for added/removed/
   changed files, without the full-screen loading state (we already have
   something on screen). Unchanged files keep their existing item object so
   cached thumbnails, duration, ID3 tags, etc. don't need to be regenerated.
   ========================================================================== */
function mergeScannedItems(oldList, newList){
  const oldByPath = new Map(oldList.map(i => [i.path, i]));
  return newList.map(fresh => {
    const old = oldByPath.get(fresh.path);
    if(old && old.size === fresh.size && old.lastModified === fresh.lastModified){
      old.handle = fresh.handle;
      old.file = fresh.file;
      return old;
    }
    return fresh;
  });
}

async function refreshLibrary(){
  if(!state.rootHandle){
    toast(state.isDemo ? "Can't refresh the sample library — choose a real folder to enable this." : 'Choose a folder first.');
    return;
  }
  const buttons = [document.getElementById('refreshLibraryBtn'), document.getElementById('mobileRefreshBtn')].filter(Boolean);
  buttons.forEach(b => { b.disabled = true; b.classList.add('refreshing'); });
  try{
    const { videos, images, audio } = await scanDirectory(state.rootHandle);
    state.rawVideos = mergeScannedItems(state.rawVideos, videos);
    state.rawImages = mergeScannedItems(state.rawImages, images);
    state.rawAudio = mergeScannedItems(state.rawAudio, audio);
    applyExclusions();
    updateTotalCount();
    renderSidebar();
    renderActiveGrid();
    toast('Library refreshed');
  }catch(err){
    console.error('refresh library failed', err);
    toast('Could not refresh the library.');
  }finally{
    buttons.forEach(b => { b.disabled = false; b.classList.remove('refreshing'); });
  }
}

function bindRefreshLibraryButton(){
  const btn = document.getElementById('refreshLibraryBtn');
  const mobileBtn = document.getElementById('mobileRefreshBtn');
  if(btn) btn.addEventListener('click', refreshLibrary);
  if(mobileBtn) mobileBtn.addEventListener('click', () => { closeMobileShell(); refreshLibrary(); });
}