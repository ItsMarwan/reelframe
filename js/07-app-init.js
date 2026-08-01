/* ==========================================================================
   App init
   ========================================================================== */

/* PWA — register the shell service worker and capture the install prompt.
   Runs once at script load, outside any function, so it fires regardless
   of which screen (gate, lock, app) is showing. */
let deferredInstallPrompt = null;
if('serviceWorker' in navigator){
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline shell just won't be available */ });
  });
}
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  const installBtn = document.getElementById('installAppBtn');
  if(installBtn) installBtn.hidden = false;
});

function showLockGate(){
  enterLockedState();
  const lockInput = document.getElementById('lockPasswordEntry');
  const lockError = document.getElementById('lockError');
  if(lockInput) lockInput.value = '';
  if(lockError) lockError.hidden = true;
}

async function initAppUI(){
  document.getElementById('rootName').textContent = state.rootName;
  await loadSnapshots();
  await refreshCaptionedPaths();
  updateTotalCount();
  updateFavCount();
  renderSidebar();
  renderActiveGrid();
  if(!appBound){
    bindTabAndSortEvents();
    bindFoldersModal();
    bindMobileShell();
    bindSettingsModal();
    bindShareControls();
    bindReceiveShareModal();
    bindUrlModal();
    bindSaveLocationModal();
    bindImagePopOverlay();
    bindMiniPlayer();
    bindBulkDownloadButton();
    initCustomPlayer();
    initMusicPlayer();
    bindLockBehavior();
    bindGlobalSearch();
    bindLegalLinks();
    bindFooterToggle();
    bindChaptersUI();
    bindWatchPartyUI();
    bindKeyboardShortcutsUI();
    bindViewTab();
    bindViewTab();
    bindRefreshLibraryButton();
    bindNsfwFocusGate();
    bindNsfwRegionScanButtons();
    consumePairParamIfPresent();
    window.addEventListener('popstate', syncViewFromURL);
    // Keep retrying any video/pair thumbnail that never came in — but only
    // for cards actually visible on screen right now, checked every few
    // seconds. Without this, a thumb that failed once (a stalled video
    // decode, a dropped pair request, a brief connection hiccup) stayed
    // blank forever even though nothing was actually broken.
    startThumbRetryWatcher();
    appBound = true;
    (window.requestIdleCallback || ((fn) => setTimeout(fn, 1500)))(() => {
      prewarmCaptionModel();
      buildTranscriptIndex();
      maybeAutoScanNsfwOnStartup();
    });
  }
  syncViewFromURL();
}

function scrollMainTop(){
  const m = document.querySelector('.main');
  if(m) m.scrollTop = 0;
}
function clearUrlParams(){
  history.pushState(null, '', location.pathname + location.hash);
}

function renderLegalDoc(doc = 'tos'){
  const legalDoc = document.getElementById('legalDoc');
  const normalized = doc === 'privacy' ? 'privacy' : 'tos';
  legalDoc.innerHTML = LEGAL_DOCS[normalized];
  document.querySelectorAll('[data-legal-doc]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.legalDoc === normalized);
  });
}

function openLegalDoc(doc, opts = {}){
  const normalized = doc === 'privacy' ? 'privacy' : 'tos';
  renderLegalDoc(normalized);
  showView('legalView');
  if(opts.push !== false) history.pushState(null, '', `?l=${normalized}`);
}

function goToGrid(tab){
  pendingGridRestore = { tab, top: state.scrollPos[tab] || 0 };
  const viewId = tab === 'videos' ? 'videosGrid' : tab === 'images' ? 'imagesGrid' : tab === 'view' ? 'viewGrid' : 'musicGrid';
  showView(viewId);
  pushCategoryUrl(tab);
  renderActiveGrid();
}

function syncViewFromURL(){
  const params = new URLSearchParams(location.search);
  const vPath = params.get('v');
  const pPath = params.get('p');
  const legalDoc = params.get('l');
  const cParam = params.get('c');

  const receiveCode = params.get('receive');
  if(receiveCode){
    document.getElementById('receiveShareBtn')?.click();
    setTimeout(() => {
      const input = document.getElementById('receiveCodeInput');
      const connectBtn = document.getElementById('receiveConnectBtn');
      if(input) input.value = receiveCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if(connectBtn) connectBtn.click();
    }, 50);
    clearUrlParams();
    return;
  }
  if(vPath){
    const item = state.videos.find(i => i.path === vPath);
    setTab('videos', { skipRender:true });
    if(item) openWatch(item, { push:false });
    else goToGrid('videos');
    return;
  }
  if(pPath){
    const item = [...state.images, ...state.snapshots].find(i => i.path === pPath);
    setTab('images', { skipRender:true });
    if(item) openFocus(item, { push:false });
    else goToGrid('images');
    return;
  }
  if(legalDoc){
    openLegalDoc(legalDoc, { push:false });
    return;
  }
  if(cParam){
    const sep = cParam.indexOf(':');
    const tab = sep === -1 ? cParam : cParam.slice(0, sep);
    const cat = sep === -1 ? null : cParam.slice(sep + 1);
    if(tab === 'videos' || tab === 'images' || tab === 'music'){
      state.cat[tab] = cat || null;
      setTab(tab, { skipRender:true });
      switchViewsForTab();
      renderActiveGrid();
      return;
    }
  }
  switchViewsForTab();
}

function setTab(tab, opts = {}){
  state.tab = tab;
  document.querySelectorAll('.tab').forEach(b => {
    const on = b.getAttribute('data-tab') === tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const mobileSelect = document.getElementById('mobileNavSelect');
  if(mobileSelect) mobileSelect.value = tab;
  renderSidebar();
  if(!opts.skipRender) renderActiveGrid();
}

/* Carries the active category from one tab to another when the person
   switches tabs — e.g. sitting in "Nature" under Videos and switching to
   Photos jumps straight to "Nature" there too, if that category exists
   in Photos. If it doesn't exist there, the target tab's category is
   left untouched (whatever it last was). Special views (__fav__,
   __history__, etc.) and Uncategorized are never carried over — those
   are per-tab states, not real folders shared across tabs. */
function syncCategoryAcrossTab(fromTab, toTab){
  if(!(fromTab in state.cat) || !(toTab in state.cat)) return;
  const cat = state.cat[fromTab];
  if(!cat || cat.startsWith('__') || cat === UNCATEGORIZED) return;
  const targetCats = (state.categoriesByTab && state.categoriesByTab[toTab]) || [];
  if(targetCats.includes(cat)) state.cat[toTab] = cat;
  // else: leave state.cat[toTab] exactly as it was
}

function updateTotalCount(){
  const n = state.videos.length + state.images.length + state.audio.length + state.snapshots.length;
  document.getElementById('totalCount').textContent = `${n} item${n===1?'':'s'}`;
}
function updateFavCount(){
  document.getElementById('favCount').textContent = state.favorites.size;
  document.querySelectorAll('[data-fav-key]').forEach(btn => {
    const key = btn.getAttribute('data-fav-key');
    btn.classList.toggle('is-fav', state.favorites.has(key));
  });
}
function updateWatchLaterButtons(){
  document.querySelectorAll('[data-watch-later-key]').forEach(btn => {
    const key = btn.getAttribute('data-watch-later-key');
    const active = state.watchLater.has(key);
    btn.classList.toggle('is-watch-later', active);
    btn.innerHTML = watchLaterSVG(active);
    btn.title = active ? 'Remove from Watch later' : 'Add to Watch later';
  });
  const el = document.getElementById('watchLaterCount');
  if(el) el.textContent = state.watchLater.size;
}

function bindLegalLinks(){
  document.querySelectorAll('[data-legal]').forEach(btn => {
    btn.addEventListener('click', () => openLegalDoc(btn.dataset.legal));
  });
  document.querySelectorAll('[data-legal-doc]').forEach(btn => {
    btn.addEventListener('click', () => openLegalDoc(btn.dataset.legalDoc));
  });
  document.getElementById('backToLibraryFromLegal').addEventListener('click', () => {
    const tab = state.tab === 'images' ? 'images' : state.tab === 'music' ? 'music' : 'videos';
    goToGrid(tab);
  });
}

function bindFooterToggle(){
  const toggleTab = document.getElementById('footerToggleTab');
  if(toggleTab) toggleTab.addEventListener('click', toggleFooter);
  loadFooterCollapsedState();
  applyFooterCollapsedState();
}

function bindTabAndSortEvents(){
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab');
      if(tab === state.tab) return;
      syncCategoryAcrossTab(state.tab, tab); // NEW
      setTab(tab, { skipRender:true });
      switchViewsForTab();
      clearUrlParams();
      scrollMainTop();
      renderActiveGrid();
    });
  });

  document.querySelectorAll('.sort-group').forEach(group => {
    group.querySelectorAll('.sort-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.getAttribute('data-sort');
        state.sort[state.tab] = mode;
        group.querySelectorAll('.sort-btn').forEach(b => b.classList.toggle('active', b === btn));
        if(mode === 'random') shuffleKeys(itemsForTab(state.tab));
        renderActiveGrid();
      });
    });
  });

  document.getElementById('backToGrid').addEventListener('click', () => goToGrid('videos'));
  document.getElementById('backToPinGrid').addEventListener('click', () => goToGrid('images'));

  const searchInput = document.getElementById('searchInput');
  let t;
  searchInput.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      state.search = searchInput.value.trim().toLowerCase();
      renderActiveGrid();
    }, 140);
  });
}

function switchViewsForTab(){
  const t = state.tab;
  document.getElementById('videosGrid').hidden = t !== 'videos';
  document.getElementById('videoWatch').hidden = true;
  document.getElementById('imagesGrid').hidden = t !== 'images';
  document.getElementById('imageFocus').hidden = true;
  document.getElementById('legalView').hidden = true;
  document.getElementById('musicGrid').hidden = t !== 'music';
  document.getElementById('viewGrid').hidden = t !== 'view';

  const toggleBtn = document.getElementById('toggleSnapshotSelectBtn');
  if(toggleBtn){
    const showBtn = t === 'images' && state.cat.images === '__snapshots__';
    toggleBtn.style.display = showBtn ? 'block' : 'none';
  }

  if(state.snapshotSelectMode && !(t === 'images' && state.cat.images === '__snapshots__')){
    state.snapshotSelectMode = false;
    state.selectedSnapshots.clear();
    document.getElementById('downloadSelectedSnapshotsBtn').style.display = 'none';
    const deleteBtn = document.getElementById('deleteSelectedSnapshotsBtn'); // NEW
    if(deleteBtn) deleteBtn.style.display = 'none';                          // NEW
  }
}
function categoryUrlValue(tab){
  const cat = state.cat[tab];
  return cat ? `${tab}:${cat}` : null;
}
function pushCategoryUrl(tab){
  const val = categoryUrlValue(tab);
  if(val) history.pushState(null, '', `?c=${encodeURIComponent(val)}`);
  else clearUrlParams();
}

function goToGrid(tab){
  pendingGridRestore = { tab, top: state.scrollPos[tab] || 0 };
  const viewId = tab === 'videos' ? 'videosGrid' : tab === 'images' ? 'imagesGrid' : tab === 'view' ? 'viewGrid' : 'musicGrid';
  showView(viewId);
  pushCategoryUrl(tab);          // was clearUrlParams()
  renderActiveGrid();
}

function goToCategory(tab, cat){
  if(!cat) return;
  state.cat[tab] = cat;
  setTab(tab, { skipRender:true });
  goToGrid(tab);
}