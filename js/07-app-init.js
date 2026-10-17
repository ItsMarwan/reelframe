/* ==========================================================================
   App init
   ========================================================================== */

/* PWA — register the shell service worker and capture the install prompt.
   Runs once at script load, outside any function, so it fires regardless
   of which screen (gate, lock, app) is showing. */
let deferredInstallPrompt = null;
// Service worker registration disabled to avoid hard caching during development.
// If you want to enable the offline shell, uncomment the block below.
// if('serviceWorker' in navigator){
//   window.addEventListener('load', () => {
//     navigator.serviceWorker.register('sw.js').catch(() => { /* offline shell just won't be available */ });
//   });
// }
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
  updateSeeLaterButtons();
  renderSidebar();
  renderActiveGrid();
  if(!appBound){
    bindTabAndSortEvents();
    bindFoldersModal();
    bindMobileShell();
    bindSettingsModal();
    bindShareControls();
    bindReceiveShareModal();
    bindRemoteHostModal();
    bindUrlModal();
    bindSaveLocationModal();
    bindImagePopOverlay();
    bindFocusImagePan();
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
    bindRefreshLibraryButton();
    bindNsfwFocusGate();
    bindWatchNsfwGate();
    bindNsfwRegionScanButtons();
    consumePairParamIfPresent();
    bindGridScrollMemory();
    window.addEventListener('popstate', (e) => syncViewFromURL(e));
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

/* ==========================================================================
   Grid navigation memory
   - Every grid view (tab + category + subfolder) remembers how far it was
     scrolled and how many cards were loaded. Returning to it (Back, the
     in-app back buttons, clicking Home/All again) restores that spot; a view
     you've never visited starts at the top.
   - Each history entry for a grid is stamped with {tab, cat, sub}, so
     browser Back/Forward rebuilds the right grid, not just whatever was last
     on screen.
   ========================================================================== */
const gridScrollMemo = new Map();   // 'tab|cat|sub' -> { top, rendered }
let gridScrollKey = null;           // key whose scroll we're tracking (null = paused while re-rendering)
let lastGridNav = null;

function gridNavFor(tab){
  const sel = state.subcat && state.subcat[tab];
  const cat = state.cat[tab] || null;
  return { tab, cat, sub: (sel && sel.key && sel.cat === cat) ? sel.key : null };
}
function gridKeyOf(nav){ return `${nav.tab}|${nav.cat || ''}|${nav.sub || ''}`; }
function visibleGridTab(){
  const shown = (id) => { const el = document.getElementById(id); return !!el && !el.hidden; };
  if(shown('videosGrid')) return 'videos';
  if(shown('imagesGrid')) return 'images';
  if(shown('musicGrid')) return 'music';
  return null;
}
function renderedCountFor(tab){
  if(tab === 'videos' && typeof videoGridState !== 'undefined') return videoGridState.rendered || 0;
  if(tab === 'images' && typeof imageGridState !== 'undefined') return imageGridState.rendered || 0;
  if(tab === 'music' && typeof musicGridState !== 'undefined') return musicGridState.rendered || 0;
  return 0;
}
/* Saves the live scroll position under the key of the grid actually on screen. */
function rememberGridScroll(){
  if(!gridScrollKey) return;
  const tab = gridScrollKey.split('|')[0];
  if(visibleGridTab() !== tab) return;
  const m = document.querySelector('.main');
  if(!m) return;
  gridScrollMemo.set(gridScrollKey, { top: m.scrollTop, rendered: renderedCountFor(tab) });
}
function bindGridScrollMemory(){
  const m = document.querySelector('.main');
  if(!m || m.__gridScrollBound) return;
  m.__gridScrollBound = true;
  let queued = false;
  m.addEventListener('scroll', () => {
    if(queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; rememberGridScroll(); });
  }, { passive: true });
}
/* Queues a restore for the next grid render, or clears it if there's nothing saved. */
function queueGridScrollFor(nav, forceTop){
  const memo = forceTop ? null : gridScrollMemo.get(gridKeyOf(nav));
  if(memo){
    pendingGridRestore = { tab: nav.tab, top: memo.top };
    state.gridRenderedCount[nav.tab] = memo.rendered;
  } else {
    pendingGridRestore = null;
  }
  return !!memo;
}
/* Is the current history entry one of the grid pages (not a video/photo/legal page)? */
function currentUrlIsGridEntry(){
  const p = new URLSearchParams(location.search);
  return !(p.get('v') || p.get('p') || p.get('l'));
}
/* Called after every grid render: stamp the current history entry. */
function stampGridHistory(){
  lastGridNav = gridNavFor(state.tab);
  if(!currentUrlIsGridEntry()) return;
  try{ history.replaceState(Object.assign({}, history.state || {}, { nav: lastGridNav }), ''); }catch(e){}
}
/* Rebuilds a grid from a history stamp (browser Back/Forward). */
function applyGridNav(nav){
  state.cat[nav.tab] = nav.cat || null;
  if(!state.subcat) state.subcat = { videos: null, images: null, music: null };
  state.subcat[nav.tab] = nav.sub ? { cat: nav.cat, key: nav.sub } : null;
  setTab(nav.tab, { skipRender:true });
  switchViewsForTab();
  const restored = queueGridScrollFor(nav, false);
  renderActiveGrid();
  if(!restored) scrollMainTop();
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


function syncViewFromURL(ev){
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
  const stamped = ev && ev.state && ev.state.nav;
  if(stamped && ['videos','images','music'].includes(stamped.tab)){
    applyGridNav(stamped);
    return;
  }
  if(cParam){
    const sep = cParam.indexOf(':');
    const tab = sep === -1 ? cParam : cParam.slice(0, sep);
    const cat = sep === -1 ? null : cParam.slice(sep + 1);
    if(tab === 'videos' || tab === 'images' || tab === 'music'){
      applyGridNav({ tab, cat: cat || null, sub: null });
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

function openRandomMediaItem(){
  const tab = state.tab === 'videos' || state.tab === 'images' ? state.tab : 'videos';
  const pool = tab === 'videos' ? getFiltered('videos') : getFiltered('images');
  if(!pool.length){
    toast(tab === 'videos' ? 'No videos in this library yet.' : 'No photos in this library yet.');
    return;
  }
  const candidate = shuffleArray(pool.slice())[0];
  if(!candidate) return;
  if(tab === 'videos') openWatch(candidate);
  else openFocus(candidate);
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

function updateSeeLaterButtons(){
  document.querySelectorAll('[data-see-later-key]').forEach(btn => {
    const key = btn.getAttribute('data-see-later-key');
    const active = state.seeLater.has(key);
    btn.classList.toggle('is-see-later', active);
    btn.innerHTML = seeLaterSVG(active);
    btn.title = active ? 'Remove from See later' : 'Add to See later';
  });
  const el = document.getElementById('seeLaterCount');
  if(el) el.textContent = state.seeLater.size;
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

  const randomMediaBtn = document.getElementById('randomMediaBtn');
  if(randomMediaBtn){
    randomMediaBtn.addEventListener('click', () => openRandomMediaItem());
  }

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
  rememberGridScroll();
  const t = state.tab;
  /* Leaving the watch page this way (browser Back, tab switch) bypasses
     showView(), so hand the video to the mini player here too instead of
     letting it be hidden/paused. */
  const watchEl = document.getElementById('videoWatch');
  if(watchEl && !watchEl.hidden){
    const pv = document.getElementById('videoPlayer');
    if(pv && pv.src && !pv.ended) dockMiniPlayer();
    else stopActiveVideo();
    if(typeof clearNextUpPrompt === 'function') clearNextUpPrompt({ dismissed: true });
    if(typeof hideCaptionProgress === 'function') hideCaptionProgress();
  }
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

function goToGrid(tab, opts = {}){
  rememberGridScroll();   // save where the grid we're leaving was scrolled (before any state changes)
  const restored = queueGridScrollFor(gridNavFor(tab), !!opts.top);
  const viewId = tab === 'videos' ? 'videosGrid' : tab === 'images' ? 'imagesGrid' : tab === 'view' ? 'viewGrid' : 'musicGrid';
  showView(viewId);
  pushCategoryUrl(tab);
  renderActiveGrid();
  if(!restored) scrollMainTop();   // a view you haven't been in yet starts at the top
}

function goToCategory(tab, cat){
  if(!cat) return;
  state.cat[tab] = cat;
  setTab(tab, { skipRender:true });
  goToGrid(tab, { top:true });
}
/* Show / hide password on the lock screen. Delegated so it keeps working if
   the lock gate is ever rebuilt from its template. */
document.addEventListener('click', function(e){
  const btn = e.target.closest && e.target.closest('#lockReveal');
  if(!btn) return;
  const input = document.getElementById('lockPasswordEntry');
  if(!input) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.classList.toggle('is-on', show);
  btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  input.focus();
});
