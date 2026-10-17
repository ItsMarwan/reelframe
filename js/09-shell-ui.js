/* ==========================================================================
   Shell UI — footer positioning, view switching, sidebar, escaping helpers
   ========================================================================== */
function updateFooterPositioning(){
  const footerContainer = document.getElementById('footerContainer');
  if(!footerContainer) return;
  const isGridView = currentViewType === 'grid';
  footerContainer.classList.toggle('is-normal', !isGridView);
  loadFooterCollapsedState();
  applyFooterCollapsedState();
}

function loadFooterCollapsedState(){
  const saved = localStorage.getItem(FOOTER_COLLAPSE_KEY);
  footerCollapsed = saved === '1';
}
function applyFooterCollapsedState(){
  const footerContainer = document.getElementById('footerContainer');
  if(footerContainer){
    footerContainer.classList.toggle('collapsed', footerCollapsed);
    updateFooterToggleText();
  }
}
function updateFooterToggleText(){
  const text = document.getElementById('footerToggleText');
  if(text) text.textContent = footerCollapsed ? 'Expand' : 'Collapse';
}
function toggleFooter(){
  footerCollapsed = !footerCollapsed;
  const footerContainer = document.getElementById('footerContainer');
  if(footerContainer){
    footerContainer.classList.toggle('collapsed', footerCollapsed);
    updateFooterToggleText();
    localStorage.setItem(FOOTER_COLLAPSE_KEY, footerCollapsed ? '1' : '0');
  }
}

function showView(id){
  rememberGridScroll();
  if(id === 'videoWatch' && miniPlayerActive) undockMiniPlayer();
  const leavingWatch = !document.getElementById('videoWatch').hidden && id !== 'videoWatch';
  if(leavingWatch){
    const video = document.getElementById('videoPlayer');
    if(video && video.src && !video.ended) dockMiniPlayer();
    else stopActiveVideo();
    clearNextUpPrompt({ dismissed: true });
    hideCaptionProgress();
  }

  if(id === 'videosGrid' || id === 'imagesGrid' || id === 'musicGrid' || id === 'viewGrid'){
    currentViewType = 'grid';
  } else if(id === 'videoWatch'){
    currentViewType = 'watch';
  } else if(id === 'imageFocus'){
    currentViewType = 'focus';
  } else {
    currentViewType = 'other';
  }
  updateFooterPositioning();

  const mainEl = document.querySelector('.main');
  if(mainEl){
    if(!document.getElementById('videosGrid').hidden && id !== 'videosGrid'){
      state.scrollPos.videos = mainEl.scrollTop;
      state.gridRenderedCount.videos = videoGridState.rendered;
    }
    if(!document.getElementById('imagesGrid').hidden && id !== 'imagesGrid'){
      state.scrollPos.images = mainEl.scrollTop;
      state.gridRenderedCount.images = imageGridState.rendered;
    }
    if(!document.getElementById('musicGrid').hidden && id !== 'musicGrid'){
      state.scrollPos.music = mainEl.scrollTop;
      state.gridRenderedCount.music = musicGridState.rendered;
    }
  }

  ['videosGrid','videoWatch','imagesGrid','imageFocus','legalView','musicGrid','viewGrid','pairedGrid'].forEach(v => {
    document.getElementById(v).hidden = (v !== id);
  });
  document.getElementById('app').classList.toggle('watch-mode', id === 'videoWatch');
  if(id === 'videoWatch') maybeShowCaptionProgressForCurrentVideo();
  else hideCaptionProgress();
  if(captionJob && !captionJob.done) maybeShowCaptionProgressForCurrentVideo();
  else hideCaptionProgress();

  if(id === 'videoWatch' || id === 'imageFocus' || id === 'legalView') scrollMainTop();
}

/* ---- Sidebar ---- */
function renderSidebar(){
  const list = document.getElementById('categoryList');
  const cats = (state.categoriesByTab[state.tab] || []).filter(c => c !== UNCATEGORIZED);
  const items = itemsForTab(state.tab);
  const activeCat = state.cat[state.tab];
  const snapshotCountEl = document.getElementById('snapshotCount');
  if(snapshotCountEl) snapshotCountEl.textContent = state.snapshots.length;
  const watchCountEl = document.getElementById('watchLaterCount');
  if(watchCountEl) watchCountEl.textContent = state.watchLater.size;
  updateCaptionedCount();
  if(typeof updateICameCount === 'function') updateICameCount();

  const countFor = (cat) => cat === null ? items.length : items.filter(i => i.category === cat).length;

  /* Folder tree for this tab (skips the sidebar's own special buckets), so a
     category can show its subfolders as a collapsible list. */
  const tree = buildFolderTree(items.filter(i => i.category !== UNCATEGORIZED && i.category !== 'Snapshots'));
  const activeSub = reconcileSubfolderSelection(state.tab, tree);

  let html = `<li class="cat-row"><span class="cat-twist-spacer"></span><button class="cat-item ${activeCat===null?'active':''}" data-cat="__all__">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.6"/><rect x="14" y="3" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.6"/><rect x="3" y="14" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.6"/><rect x="14" y="14" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.6"/></svg>
      All <span class="cat-count">${countFor(null)}</span>
    </button></li>`;

  cats.forEach(cat => {
    const fav = isCategoryFav(cat);
    const node = tree.children.get(cat);
    const hasSubs = !!(node && node.children.size);
    const open = hasSubs && catExpanded.has(expandKey(state.tab, cat));
    html += `<li class="cat-group ${open ? 'is-open' : ''}"><div class="cat-row">
      ${hasSubs
        ? `<button type="button" class="cat-twist" data-twist="${escapeAttr(cat)}" aria-expanded="${open}" aria-label="${open ? 'Collapse' : 'Expand'} ${escapeAttr(cat)}">${CHEVRON_SVG}</button>`
        : `<span class="cat-twist-spacer"></span>`}
      <button class="cat-item ${activeCat===cat && !activeSub ? 'active' : ''}" data-cat="${escapeAttr(cat)}">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" stroke="currentColor" stroke-width="1.6"/></svg>
        <span>${escapeHtml(cat)}</span> <span class="cat-count">${countFor(cat)}</span>
      </button>
      <button class="cat-fav-btn ${fav?'is-fav':''}" type="button" data-cat-fav="${escapeAttr(cat)}" title="${fav?'Unfavorite category':'Favorite category'}">${heartSVG(fav)}</button></div>
      ${hasSubs ? renderSubfolderList(state.tab, node, activeCat === cat ? activeSub : null) : ''}
    </li>`;
  });
  list.className = `category-list tab-context-${state.tab}`;
  list.innerHTML = html;

  /* Expand / collapse a folder's subfolders — doesn't change what's showing. */
  list.querySelectorAll('.cat-twist').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const k = expandKey(state.tab, btn.getAttribute('data-twist'));
      const open = !catExpanded.has(k);
      if(open) catExpanded.add(k); else catExpanded.delete(k);
      saveCatExpanded();
      const holder = btn.closest('li');
      if(holder) holder.classList.toggle('is-open', open);
      btn.setAttribute('aria-expanded', String(open));
    });
  });

  list.querySelectorAll('.cat-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const cat = btn.getAttribute('data-cat');
      const sub = btn.getAttribute('data-sub');
      state.cat[state.tab] = cat === '__all__' ? null : cat;
      state.subcat[state.tab] = sub ? { cat, key: sub } : null;
      if(sub) expandAncestorsOf(state.tab, sub);
      document.querySelectorAll('#categoryList .cat-item').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.sidebar .cat-item[data-special]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      closeMobileShell();
      goToGrid(state.tab);
    });
  });

  list.querySelectorAll('.cat-fav-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const cat = btn.getAttribute('data-cat-fav');
      toggleCategoryFav(cat);
    });
  });

  const favBtn = document.querySelector('.cat-item[data-special="favorites"]');
  favBtn.classList.toggle('active', activeCat === '__fav__');
  favBtn.onclick = () => {
    state.cat[state.tab] = '__fav__';
    document.querySelectorAll('#categoryList .cat-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.sidebar .cat-item[data-special]').forEach(b => b.classList.remove('active'));
    favBtn.classList.add('active');
    closeMobileShell();
    goToGrid(state.tab);
  };

  const historyBtn = document.querySelector('.cat-item[data-special="history"]');
  historyBtn.classList.toggle('active', activeCat === '__history__');
  historyBtn.onclick = () => {
    state.cat[state.tab] = '__history__';
    document.querySelectorAll('#categoryList .cat-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.sidebar .cat-item[data-special]').forEach(b => b.classList.remove('active'));
    historyBtn.classList.add('active');
    closeMobileShell();
    goToGrid(state.tab);
  };

  const snapshotsBtn = document.querySelector('.cat-item[data-special="snapshots"]');
  snapshotsBtn.classList.toggle('active', activeCat === '__snapshots__');
  snapshotsBtn.onclick = () => {
    setTab('images', { skipRender:true });
    state.cat.images = '__snapshots__';
    document.querySelectorAll('#categoryList .cat-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.sidebar .cat-item[data-special]').forEach(b => b.classList.remove('active'));
    snapshotsBtn.classList.add('active');
    closeMobileShell();
    goToGrid('images');
  };

  const watchLaterBtn = document.querySelector('.cat-item[data-special="watchlater"]');
  if(watchLaterBtn){
    watchLaterBtn.classList.toggle('active', activeCat === '__watchlater__');
    watchLaterBtn.onclick = () => {
      setTab('videos', { skipRender:true });
      state.cat.videos = '__watchlater__';
      document.querySelectorAll('#categoryList .cat-item').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.sidebar .cat-item[data-special]').forEach(b => b.classList.remove('active'));
      watchLaterBtn.classList.add('active');
      closeMobileShell();
      goToGrid('videos');
    };
  }

  const seeLaterBtn = document.querySelector('.cat-item[data-special="seelater"]');
  if(seeLaterBtn){
    seeLaterBtn.classList.toggle('active', activeCat === '__seelater__');
    seeLaterBtn.onclick = () => {
      setTab('images', { skipRender:true });
      state.cat.images = '__seelater__';
      document.querySelectorAll('#categoryList .cat-item').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.sidebar .cat-item[data-special]').forEach(b => b.classList.remove('active'));
      seeLaterBtn.classList.add('active');
      closeMobileShell();
      goToGrid('images');
    };
  }

  if(typeof bindICameSidebar === 'function') bindICameSidebar();

  const uncategorizedBtn = document.querySelector('.cat-item[data-special="uncategorized"]');
  if(uncategorizedBtn){
    const count = items.filter(i => i.category === UNCATEGORIZED).length;
    const countEl = document.getElementById('uncategorizedCount');
    if(countEl) countEl.textContent = count;
    uncategorizedBtn.classList.toggle('active', activeCat === UNCATEGORIZED);
    uncategorizedBtn.onclick = () => {
      state.cat[state.tab] = UNCATEGORIZED;
      document.querySelectorAll('#categoryList .cat-item').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.sidebar .cat-item[data-special]').forEach(b => b.classList.remove('active'));
      uncategorizedBtn.classList.add('active');
      closeMobileShell();
      goToGrid(state.tab);
    };
  }

  /* New: "Captioned" — videos that have generated or imported captions */
  const captionedBtn = document.querySelector('.cat-item[data-special="captioned"]');
  if(captionedBtn){
    captionedBtn.classList.toggle('active', activeCat === '__captioned__');
    captionedBtn.onclick = () => {
      setTab('videos', { skipRender:true });
      state.cat.videos = '__captioned__';
      document.querySelectorAll('#categoryList .cat-item').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.sidebar .cat-item[data-special]').forEach(b => b.classList.remove('active'));
      captionedBtn.classList.add('active');
      closeMobileShell();
      goToGrid('videos');
    };
  }
}
function escapeHtml(s){ return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escapeAttr(s){ return escapeHtml(s); }