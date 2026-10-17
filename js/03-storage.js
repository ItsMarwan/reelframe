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

function loadSeeLater(){
  try{ const raw = localStorage.getItem(SEE_LATER_KEY); return new Set(raw ? JSON.parse(raw) : []); }
  catch(e){ return new Set(); }
}
function saveSeeLater(){ localStorage.setItem(SEE_LATER_KEY, JSON.stringify([...state.seeLater])); }

function loadSeeLaterConsumed(){
  try{ const raw = localStorage.getItem(SEE_LATER_CONSUMED_KEY); return new Set(raw ? JSON.parse(raw) : []); }
  catch(e){ return new Set(); }
}
function saveSeeLaterConsumed(){ localStorage.setItem(SEE_LATER_CONSUMED_KEY, JSON.stringify([...state.seeLaterConsumed])); }

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

function isSeeLater(item){ return state.seeLater.has(favKey(item)); }
function isSeeLaterBoosted(item){ return state.seeLater.has(favKey(item)) && !state.seeLaterConsumed.has(favKey(item)); }
function toggleSeeLater(item){
  const key = favKey(item);
  if(state.seeLater.has(key)){ state.seeLater.delete(key); state.seeLaterConsumed.delete(key); }
  else state.seeLater.add(key);
  saveSeeLater(); saveSeeLaterConsumed(); updateSeeLaterButtons();
}
function consumeSeeLater(item){
  const key = favKey(item);
  if(state.seeLater.has(key)) state.seeLaterConsumed.add(key);
  saveSeeLaterConsumed(); updateSeeLaterButtons();
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
/* The player reports its position several times a second. Serialising the
   whole progress table into localStorage that often (it's synchronous)
   causes constant jank, so progress updates only mark it dirty and the
   actual write happens at most every few seconds, plus when the video
   pauses or the tab is hidden/closed. */
let watchProgressDirty = false, watchProgressTimer = null;
function flushWatchProgress(){
  if(watchProgressTimer){ clearTimeout(watchProgressTimer); watchProgressTimer = null; }
  if(!watchProgressDirty) return;
  watchProgressDirty = false;
  try{ saveWatchProgress(); }catch(e){}
}
function saveWatchProgressSoon(){
  watchProgressDirty = true;
  if(!watchProgressTimer) watchProgressTimer = setTimeout(flushWatchProgress, 5000);
}
document.addEventListener('visibilitychange', () => { if(document.hidden) flushWatchProgress(); });
window.addEventListener('pagehide', flushWatchProgress);

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
function loadMiniPlayerEnabledSetting(){
  const raw = localStorage.getItem(MINI_PLAYER_ENABLED_KEY);
  return raw === null ? true : raw === '1';
}
function saveMiniPlayerEnabledSetting(){ localStorage.setItem(MINI_PLAYER_ENABLED_KEY, state.miniPlayerEnabled ? '1' : '0'); }

function loadImagePopSize(){
  try{
    const raw = localStorage.getItem(IMAGE_POP_SIZE_KEY);
    if(!raw) return null;
    const parsed = JSON.parse(raw);
    if(typeof parsed.wPct === 'number' && typeof parsed.hPct === 'number') return parsed;
    return null;
  } catch(e){ return null; }
}
function saveImagePopSize(wPct, hPct){
  try{ localStorage.setItem(IMAGE_POP_SIZE_KEY, JSON.stringify({ wPct, hPct })); } catch(e){}
}
function loadWebsiteWallpaper(){
  try{
    const raw = localStorage.getItem(WEBSITE_WALLPAPER_KEY);
    if(!raw) return null;
    const parsed = JSON.parse(raw);
    if(parsed && typeof parsed.image === 'string' && parsed.image.length){
      return {
        image: parsed.image,
        effect: ['clear', 'blur', 'frosted', 'bw'].includes(parsed.effect) ? parsed.effect : 'clear',
        componentEffect: ['opaque', 'frosted', 'bw'].includes(parsed.componentEffect) ? parsed.componentEffect : 'opaque',
        opacity: typeof parsed.opacity === 'number' ? Math.max(0, Math.min(100, parsed.opacity)) : 100,
        scale: typeof parsed.scale === 'number' ? Math.max(60, Math.min(180, parsed.scale)) : 100,
        positionX: typeof parsed.positionX === 'number' ? Math.max(0, Math.min(100, parsed.positionX)) : 50,
        positionY: typeof parsed.positionY === 'number' ? Math.max(0, Math.min(100, parsed.positionY)) : 50,
      };
    }
    return null;
  } catch(e){ return null; }
}
/* Returns true when the background was stored (or cleared), false when the
   browser refused it — usually because the picture is too big for localStorage. */
function saveWebsiteWallpaper(){
  try{
    if(!state.websiteWallpaper || !state.websiteWallpaper.image){
      localStorage.removeItem(WEBSITE_WALLPAPER_KEY);
      return true;
    }
    localStorage.setItem(WEBSITE_WALLPAPER_KEY, JSON.stringify({
      image: state.websiteWallpaper.image,
      effect: state.websiteWallpaper.effect || 'clear',
      componentEffect: state.websiteWallpaper.componentEffect || 'opaque',
      opacity: typeof state.websiteWallpaper.opacity === 'number' ? state.websiteWallpaper.opacity : 100,
      scale: typeof state.websiteWallpaper.scale === 'number' ? state.websiteWallpaper.scale : 100,
      positionX: typeof state.websiteWallpaper.positionX === 'number' ? state.websiteWallpaper.positionX : 50,
      positionY: typeof state.websiteWallpaper.positionY === 'number' ? state.websiteWallpaper.positionY : 50,
    }));
    return true;
  }catch(e){
    console.warn('Could not store the website background', e);
    return false;
  }
}

function progressKeyForItem(item){ return `${item.type}:${item.path}`; }
function getWatchProgress(item){ return item ? state.watchProgress[progressKeyForItem(item)] : null; }
function setWatchProgress(item, pos, duration){
  if(!item || !isFinite(pos) || !isFinite(duration) || duration <= 0) return;
  const key = progressKeyForItem(item);
  const percent = Math.min(0.98, pos / duration);
  if(percent < 0.04) return;
  state.watchProgress[key] = { position: pos, duration, percent, updatedAt: Date.now() };
  saveWatchProgressSoon();
}
function clearWatchProgress(item){
  if(!item) return;
  delete state.watchProgress[progressKeyForItem(item)];
  saveWatchProgress();
}

/* New — video thumbnail cache (persisted in IndexedDB, like captions).
   Keyed by type+path+lastModified so a replaced file (different
   lastModified) gets a freshly generated thumbnail instead of showing
   stale/wrong content forever. This is what lets thumbnails survive a
   page reload or a library refresh instead of being redrawn from the
   video every single time. */
function thumbStorageKey(item){ return `thumb:${item.type}:${item.path}:${item.lastModified || 0}`; }
async function loadThumbCache(item){
  try{ return await idbGet(thumbStorageKey(item)); }catch(e){ return null; }
}
async function saveThumbCache(item){
  if(!item || !item.thumb) return;
  try{ await idbSet(thumbStorageKey(item), { thumb: item.thumb, duration: item.duration || null }); }
  catch(e){ /* non-fatal — thumb just gets regenerated next time */ }
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
  const SPECIAL_CATS = ['__fav__', '__history__', '__snapshots__', '__watchlater__', '__seelater__', '__captioned__', '__icame__'];
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
  if(state.favorites.has(key)){
    state.favorites.delete(key);
    delete state.favoriteTimestamps[key];
  } else {
    state.favorites.add(key);
    state.favoriteTimestamps[key] = Date.now();
  }
  saveFavorites();
  saveFavoriteTimestamps();
  updateFavCount();
}
function loadFavoriteTimestamps(){
  try{ const raw = localStorage.getItem(FAVORITE_TIMESTAMPS_KEY); return raw ? JSON.parse(raw) : {}; }
  catch(e){ return {}; }
}
function saveFavoriteTimestamps(){ localStorage.setItem(FAVORITE_TIMESTAMPS_KEY, JSON.stringify(state.favoriteTimestamps)); }
function isCategoryFav(cat){ return state.categoryFavorites.has(cat); }
function toggleCategoryFav(cat){
  if(state.categoryFavorites.has(cat)) state.categoryFavorites.delete(cat);
  else state.categoryFavorites.add(cat);
  saveCategoryFavorites();
  renderSidebar();
  renderActiveGrid();
}

function loadNsfwUnlocked(){
  const raw = localStorage.getItem(NSFW_FEATURE_UNLOCK_KEY);
  return raw === null ? true : raw === '1';
}
function saveNsfwUnlocked(){ localStorage.setItem(NSFW_FEATURE_UNLOCK_KEY, state.nsfwFeatureUnlocked ? '1' : '0'); }

/* New — NSFW scan trigger + display settings */
function loadNsfwScanOnStartup(){ return localStorage.getItem(NSFW_SCAN_ON_STARTUP_KEY) === '1'; }
function saveNsfwScanOnStartup(){ localStorage.setItem(NSFW_SCAN_ON_STARTUP_KEY, state.nsfwScanOnStartup ? '1' : '0'); }
function loadNsfwBlurEnabled(){
  const raw = localStorage.getItem(NSFW_BLUR_ENABLED_KEY);
  return raw === null ? true : raw === '1';
}
function saveNsfwBlurEnabled(){ localStorage.setItem(NSFW_BLUR_ENABLED_KEY, state.nsfwBlurEnabled ? '1' : '0'); }
function loadNsfwMediaScope(){
  const raw = localStorage.getItem(NSFW_MEDIA_SCOPE_KEY);
  // FIX: this used to only recognize 'photos'/'videos' here and fall through
  // to the legacy boolean for 'all', which was harmless on its own — but
  // combined with the old saveNsfwIncludeVideos() (see below) it meant a
  // "Videos only" scan scope could never actually stick. Recognizing all
  // three real values here is part of that fix.
  if(raw === 'all' || raw === 'photos' || raw === 'videos') return raw;
  const legacy = localStorage.getItem(NSFW_INCLUDE_VIDEOS_KEY);
  return legacy === '1' ? 'all' : 'photos';
}
function saveNsfwMediaScope(){ localStorage.setItem(NSFW_MEDIA_SCOPE_KEY, state.nsfwMediaScope || 'all'); }
function loadNsfwIncludeVideos(){
  const scope = loadNsfwMediaScope();
  return scope === 'all' || scope === 'videos';
}
/* FIX: this used to *derive* state.nsfwMediaScope from the legacy boolean
   (true -> 'all', false -> 'photos') and re-save it — so every caller that
   picked the "Videos only" scope, then (as every caller did) immediately
   called this too, had their choice silently collapsed into "All media"
   before it ever reached storage. That's why picking "Videos only" behaved
   like "All media" and there was no way to land on a videos-only scan.
   This is now just a legacy-compat mirror: it writes the old boolean key
   for anything still reading it, without touching the real scope, which
   callers already set via state.nsfwMediaScope + saveNsfwMediaScope(). */
function saveNsfwIncludeVideos(){
  localStorage.setItem(NSFW_INCLUDE_VIDEOS_KEY, state.nsfwIncludeVideos ? '1' : '0');
}
function loadNsfwBlurMethod(){
  const raw = localStorage.getItem(NSFW_BLUR_METHOD_KEY);
  return ['blur', 'pixelate', 'blackbox'].includes(raw) ? raw : 'pixelate';
}
function saveNsfwBlurMethod(){ localStorage.setItem(NSFW_BLUR_METHOD_KEY, state.nsfwBlurMethod || 'pixelate'); }

function loadNsfwImageClasses(){
  const raw = localStorage.getItem(NSFW_CLASS_CONFIG_KEY);
  const allowed = new Set(DEFAULT_NSFW_IMAGE_CLASSES);
  if(!raw){ return new Set(DEFAULT_NSFW_IMAGE_CLASSES); }
  try{
    const parsed = JSON.parse(raw);
    if(!parsed || typeof parsed !== 'object') return new Set(DEFAULT_NSFW_IMAGE_CLASSES);
    if(Array.isArray(parsed.image)){
      return new Set(parsed.image.filter(v => typeof v === 'string' && allowed.has(v)));
    }
    return new Set(DEFAULT_NSFW_IMAGE_CLASSES);
  }catch(e){
    return new Set(DEFAULT_NSFW_IMAGE_CLASSES);
  }
}
function loadNsfwRegionClasses(){
  const raw = localStorage.getItem(NSFW_CLASS_CONFIG_KEY);
  const allowed = new Set(DEFAULT_NSFW_REGION_CLASSES);
  if(!raw){ return new Set(DEFAULT_NSFW_REGION_CLASSES); }
  try{
    const parsed = JSON.parse(raw);
    if(!parsed || typeof parsed !== 'object') return new Set(DEFAULT_NSFW_REGION_CLASSES);
    if(Array.isArray(parsed.region)){
      return new Set(parsed.region.filter(v => typeof v === 'string' && allowed.has(v)));
    }
    return new Set(DEFAULT_NSFW_REGION_CLASSES);
  }catch(e){
    return new Set(DEFAULT_NSFW_REGION_CLASSES);
  }
}
function saveNsfwClasses(){
  localStorage.setItem(NSFW_CLASS_CONFIG_KEY, JSON.stringify({
    image: [...(state.nsfwImageClasses || new Set())],
    region: [...(state.nsfwRegionClasses || new Set())],
  }));
}
function saveNsfwImageClasses(){ saveNsfwClasses(); }
function saveNsfwRegionClasses(){ saveNsfwClasses(); }

/* New — NSFW scan result cache, keyed by favKey(item) ("type:path"). Kept in
   localStorage (like watchProgress) so it round-trips through the existing
   export/import backup flow with no extra plumbing. */
function loadNsfwResults(){
  try{ const raw = localStorage.getItem(NSFW_RESULTS_KEY); return raw ? JSON.parse(raw) : {}; }
  catch(e){ return {}; }
}
function saveNsfwResults(){
  try{ localStorage.setItem(NSFW_RESULTS_KEY, JSON.stringify(state.nsfwResults)); }
  catch(e){ /* storage full — worst case we just re-scan next time */ }
}

/* New — region ("spot") detection cache + resumable queue. Boxes are stored
   as fractions of image width/height (0–1), not pixels, so they stay valid
   regardless of what size the photo is displayed at. */
function loadNsfwRegions(){
  try{ const raw = localStorage.getItem(NSFW_REGIONS_KEY); return raw ? JSON.parse(raw) : {}; }
  catch(e){ return {}; }
}
function saveNsfwRegions(){
  try{ localStorage.setItem(NSFW_REGIONS_KEY, JSON.stringify(state.nsfwRegions)); }
  catch(e){ /* storage full — worst case we just re-scan next time */ }
}

/* Lets a region scan survive a pause, a settings-modal close, or even a
   full page reload and pick back up where it left off, instead of starting
   the whole library over. */
function loadNsfwRegionQueue(){
  try{
    const raw = localStorage.getItem(NSFW_REGION_QUEUE_KEY);
    if(!raw) return null;
    const parsed = JSON.parse(raw);
    if(Array.isArray(parsed.keys) && typeof parsed.index === 'number') return parsed;
    return null;
  }catch(e){ return null; }
}
function saveNsfwRegionQueue(keys, index, category){
  try{ localStorage.setItem(NSFW_REGION_QUEUE_KEY, JSON.stringify({ keys, index, category: category || 'all' })); }
  catch(e){ /* ignore */ }
}
function clearNsfwRegionQueue(){
  try{ localStorage.removeItem(NSFW_REGION_QUEUE_KEY); }
  catch(e){ /* ignore */ }
}