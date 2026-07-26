/* ==========================================================================
   IndexedDB — remember the last chosen folder (permission still required)
   ========================================================================== */
function idbOpen(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if(!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      if(!db.objectStoreNames.contains(SNAPSHOTS_STORE)) db.createObjectStore(SNAPSHOTS_STORE, { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbSet(key, val){
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbGet(key){
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
/* Lists every key in IDB_STORE that starts with `prefix` — used to figure
   out which videos have generated/imported captions without keeping a
   separate index in sync. */
function idbGetAllKeysWithPrefix(prefix){
  return idbOpen().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const store = tx.objectStore(IDB_STORE);
    if(store.getAllKeys){
      const req = store.getAllKeys();
      req.onsuccess = () => resolve((req.result || []).filter(k => typeof k === 'string' && k.startsWith(prefix)));
      req.onerror = () => reject(req.error);
    } else {
      const keys = [];
      const cursorReq = store.openKeyCursor();
      cursorReq.onsuccess = (e) => {
        const cursor = e.target.result;
        if(cursor){
          if(typeof cursor.key === 'string' && cursor.key.startsWith(prefix)) keys.push(cursor.key);
          cursor.continue();
        } else resolve(keys);
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    }
  }));
}
async function refreshCaptionedPaths(){
  try{
    const keys = await idbGetAllKeysWithPrefix('caption:');
    state.captionedPaths = new Set(keys.map(k => k.slice('caption:'.length)));
  }catch(e){
    state.captionedPaths = new Set();
  }
  updateCaptionedCount();
}
function updateCaptionedCount(){
  const el = document.getElementById('captionedCount');
  if(el) el.textContent = state.captionedPaths ? state.captionedPaths.size : 0;
}

/* ==========================================================================
   Favorites (persisted in localStorage)
   ========================================================================== */
function loadFavorites(){
  try{ const raw = localStorage.getItem(FAVORITES_KEY); return new Set(raw ? JSON.parse(raw) : []); }
  catch(e){ return new Set(); }
}
function saveFavorites(){ localStorage.setItem(FAVORITES_KEY, JSON.stringify([...state.favorites])); }

function loadWatchLater(){
  try{ const raw = localStorage.getItem(WATCH_LATER_KEY); return new Set(raw ? JSON.parse(raw) : []); }
  catch(e){ return new Set(); }
}
function saveWatchLater(){ localStorage.setItem(WATCH_LATER_KEY, JSON.stringify([...state.watchLater])); }

function loadWatchLaterConsumed(){
  try{ const raw = localStorage.getItem(WATCH_LATER_CONSUMED_KEY); return new Set(raw ? JSON.parse(raw) : []); }
  catch(e){ return new Set(); }
}
function saveWatchLaterConsumed(){ localStorage.setItem(WATCH_LATER_CONSUMED_KEY, JSON.stringify([...state.watchLaterConsumed])); }

function loadDiscoverSetting(){
  const raw = localStorage.getItem(DISCOVER_KEY);
  return raw === null ? true : raw === '1';
}
function saveDiscoverSetting(){ localStorage.setItem(DISCOVER_KEY, state.discoverEnabled ? '1' : '0'); }

function isWatchLater(item){ return state.watchLater.has(favKey(item)); }
function isWatchLaterBoosted(item){ return state.watchLater.has(favKey(item)) && !state.watchLaterConsumed.has(favKey(item)); }
function toggleWatchLater(item){
  const key = favKey(item);
  if(state.watchLater.has(key)){ state.watchLater.delete(key); state.watchLaterConsumed.delete(key); }
  else state.watchLater.add(key);
  saveWatchLater(); saveWatchLaterConsumed(); updateWatchLaterButtons();
}
function consumeWatchLater(item){
  const key = favKey(item);
  if(state.watchLater.has(key)) state.watchLaterConsumed.add(key);
  saveWatchLaterConsumed(); updateWatchLaterButtons();
}

function loadHistory(){
  try{ const raw = localStorage.getItem(HISTORY_KEY); return raw ? JSON.parse(raw) : []; }
  catch(e){ return []; }
}
function saveHistory(){ localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history.slice(0, HISTORY_MAX))); }
function recordHistory(item){
  if(item.ephemeral) return;
  const key = `${item.type}:${item.path}`;
  state.history = state.history.filter(h => `${h.type}:${h.path}` !== key);
  state.history.unshift({ type: item.type, path: item.path, category: item.category, name: item.name, ts: Date.now() });
  if(state.history.length > HISTORY_MAX) state.history.length = HISTORY_MAX;
  saveHistory();
}

function loadAlgoSetting(){
  const raw = localStorage.getItem(ALGO_KEY);
  return raw === null ? true : raw === '1';
}
function saveAlgoSetting(){ localStorage.setItem(ALGO_KEY, state.algoEnabled ? '1' : '0'); }

function loadSidebarCollapsed(){ return localStorage.getItem(SIDEBAR_COLLAPSE_KEY) === '1'; }
function saveSidebarCollapsed(){ localStorage.setItem(SIDEBAR_COLLAPSE_KEY, state.sideCollapsed ? '1' : '0'); }

function loadAutoplaySetting(){
  const raw = localStorage.getItem(AUTOPLAY_KEY);
  return raw === null ? true : raw === '1';
}
function saveAutoplaySetting(){ localStorage.setItem(AUTOPLAY_KEY, state.autoplayEnabled ? '1' : '0'); }

function loadPlayerAudioSettings(){
  const rawVol = localStorage.getItem(PLAYER_VOLUME_KEY);
  const rawMuted = localStorage.getItem(PLAYER_MUTED_KEY);
  const parsed = rawVol !== null ? parseFloat(rawVol) : NaN;
  const volume = Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : 1;
  return { volume, muted: rawMuted === '1' };
}
function savePlayerAudioSettings(video){
  if(!video) return;
  localStorage.setItem(PLAYER_VOLUME_KEY, String(video.volume));
  localStorage.setItem(PLAYER_MUTED_KEY, video.muted ? '1' : '0');
}

function loadCategoryFavorites(){
  try{ const raw = localStorage.getItem(CATEGORY_FAVORITES_KEY); return new Set(raw ? JSON.parse(raw) : []); }
  catch(e){ return new Set(); }
}
function saveCategoryFavorites(){ localStorage.setItem(CATEGORY_FAVORITES_KEY, JSON.stringify([...state.categoryFavorites])); }

function loadWatchProgress(){
  try{ const raw = localStorage.getItem(WATCH_PROGRESS_KEY); return raw ? JSON.parse(raw) : {}; }
  catch(e){ return {}; }
}
function saveWatchProgress(){ localStorage.setItem(WATCH_PROGRESS_KEY, JSON.stringify(state.watchProgress)); }

function loadLockEnabled(){ return localStorage.getItem(LOCK_ENABLED_KEY) === '1'; }
function saveLockEnabled(){ localStorage.setItem(LOCK_ENABLED_KEY, state.lockEnabled ? '1' : '0'); }
function loadLockPassword(){ return localStorage.getItem(LOCK_PASSWORD_KEY) || ''; }
function saveLockPassword(){ localStorage.setItem(LOCK_PASSWORD_KEY, state.lockPassword || ''); }

/* New in this pass — configurable lock timing */
function loadLockTimeoutMinutes(){
  const raw = localStorage.getItem(LOCK_TIMEOUT_KEY);
  const n = raw !== null ? parseInt(raw, 10) : 0;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
function saveLockTimeoutMinutes(){ localStorage.setItem(LOCK_TIMEOUT_KEY, String(state.lockTimeoutMinutes)); }
function loadLockBlurDelaySeconds(){
  const raw = localStorage.getItem(LOCK_BLUR_DELAY_KEY);
  const n = raw !== null ? parseInt(raw, 10) : 0;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
function saveLockBlurDelaySeconds(){ localStorage.setItem(LOCK_BLUR_DELAY_KEY, String(state.lockBlurDelaySeconds)); }

/* New in this pass — video chapters */
function loadChapters(){
  try{ const raw = localStorage.getItem(CHAPTERS_KEY); return raw ? JSON.parse(raw) : {}; }
  catch(e){ return {}; }
}
function saveChapters(){ localStorage.setItem(CHAPTERS_KEY, JSON.stringify(state.chapters)); }

/* New in this pass — For You "don't repeat the same picks" memory */
function loadForYouRecent(){
  try{ const raw = localStorage.getItem(FOR_YOU_RECENT_KEY); return raw ? JSON.parse(raw) : { video: [], image: [] }; }
  catch(e){ return { video: [], image: [] }; }
}
function saveForYouRecent(){ localStorage.setItem(FOR_YOU_RECENT_KEY, JSON.stringify(state.forYouRecent)); }

function loadShareAutoApproveSetting(){
  const raw = localStorage.getItem(SHARE_AUTO_APPROVE_KEY);
  return ['always','local','internet','never'].includes(raw) ? raw : 'always';
}
function saveShareAutoApproveSetting(){ localStorage.setItem(SHARE_AUTO_APPROVE_KEY, state.shareAutoApprove); }
function loadRealMiniPlayerSetting(){ return localStorage.getItem(REAL_MINI_PLAYER_KEY) === '1'; }
function saveRealMiniPlayerSetting(){ localStorage.setItem(REAL_MINI_PLAYER_KEY, state.realMiniPlayerEnabled ? '1' : '0'); }

function progressKeyForItem(item){ return `${item.type}:${item.path}`; }
function getWatchProgress(item){ return item ? state.watchProgress[progressKeyForItem(item)] : null; }
function setWatchProgress(item, pos, duration){
  if(!item || !isFinite(pos) || !isFinite(duration) || duration <= 0) return;
  const key = progressKeyForItem(item);
  const percent = Math.min(0.98, pos / duration);
  if(percent < 0.04) return;
  state.watchProgress[key] = { position: pos, duration, percent, updatedAt: Date.now() };
  saveWatchProgress();
}
function clearWatchProgress(item){
  if(!item) return;
  delete state.watchProgress[progressKeyForItem(item)];
  saveWatchProgress();
}

function excludedStorageKey(rootName){ return `reelframe-excluded-${rootName}`; }
function loadExcluded(rootName){
  try{ const raw = localStorage.getItem(excludedStorageKey(rootName)); return new Set(raw ? JSON.parse(raw) : []); }
  catch(e){ return new Set(); }
}
function saveExcluded(){ localStorage.setItem(excludedStorageKey(state.rootName), JSON.stringify([...state.excluded])); }

function isItemExcluded(item){
  if(item.folderPath.length === 0) return state.excluded.has(UNCATEGORIZED);
  const acc = [];
  for(const seg of item.folderPath){
    acc.push(seg);
    if(state.excluded.has(acc.join('/'))) return true;
  }
  return false;
}

function itemsForTab(tab){
  if(tab === 'videos') return state.videos;
  if(tab === 'images') return [...state.images, ...state.snapshots];
  if(tab === 'music') return state.audio;
  return [];
}

function applyExclusions(){
  state.videos = state.rawVideos.filter(i => !isItemExcluded(i));
  state.images = state.rawImages.filter(i => !isItemExcluded(i));
  state.audio = state.rawAudio.filter(i => !isItemExcluded(i));
  const vc = new Set(state.videos.map(i => i.category));
  const ic = new Set(state.images.map(i => i.category));
  const mc = new Set(state.audio.map(i => i.category));
  state.categoriesByTab = {
    videos: [...vc].sort((a,b) => a.localeCompare(b)),
    images: [...ic].sort((a,b) => a.localeCompare(b)),
    music: [...mc].sort((a,b) => a.localeCompare(b)),
  };
  const SPECIAL_CATS = ['__fav__', '__history__', '__snapshots__', '__watchlater__', '__captioned__'];
  ['videos','images','music'].forEach(tab => {
    const cat = state.cat[tab];
    if(cat && !SPECIAL_CATS.includes(cat) && !state.categoriesByTab[tab].includes(cat)){
      state.cat[tab] = null;
    }
  });
}

function favKey(item){ return `${item.type}:${item.path}`; }
function isFav(item){ return state.favorites.has(favKey(item)); }
function toggleFav(item){
  const key = favKey(item);
  if(state.favorites.has(key)) state.favorites.delete(key);
  else state.favorites.add(key);
  saveFavorites();
  updateFavCount();
}
function isCategoryFav(cat){ return state.categoryFavorites.has(cat); }
function toggleCategoryFav(cat){
  if(state.categoryFavorites.has(cat)) state.categoryFavorites.delete(cat);
  else state.categoryFavorites.add(cat);
  saveCategoryFavorites();
  renderSidebar();
  renderActiveGrid();
}