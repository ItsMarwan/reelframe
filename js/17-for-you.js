/* ==========================================================================
   "For You" — a small, transparent recommendation shelf
   Signals used: (1) the category watched most often, (2) categories of the
   handful of videos most recently watched or liked ("videos like this").
   Also avoids repeating the exact same picks across reloads/sessions until
   the fresh pool runs out. Everything comes from local watch history —
   nothing leaves the browser.
   ========================================================================== */
   /* Weighted-random ordering instead of a strict frequency sort — otherwise
   the same top 1-2 categories win every render and "For You" never shows
   anything else. Categories with more watch/like signal are still more
   likely to come first, just not guaranteed to. */
function weightedShuffleCategories(freqMap){
  const pool = [...freqMap.entries()];
  const order = [];
  while(pool.length){
    const total = pool.reduce((sum, [, w]) => sum + w, 0);
    let r = Math.random() * total;
    let idx = pool.length - 1;
    for(let i = 0; i < pool.length; i++){
      r -= pool[i][1];
      if(r <= 0){ idx = i; break; }
    }
    order.push(pool[idx][0]);
    pool.splice(idx, 1);
  }
  return order;
}
function computeForYouFor(type){
  if(!state.algoEnabled) return [];
  const hist = state.history.filter(h => h.type === type);
  if(hist.length === 0) return [];

  const sourceList = type === 'video' ? state.videos : state.images;
  const seenPaths = new Set(hist.map(h => h.path));
  const recentSet = new Set(state.forYouRecent[type] || []);

  const freq = new Map();
  hist.forEach(h => {
    const boost = state.categoryFavorites.has(h.category) ? 1.2 : 1;
    freq.set(h.category, (freq.get(h.category) || 0) + (1 * boost));
  });
  sourceList.filter(isFav).forEach(v => {
    const boost = state.categoryFavorites.has(v.category) ? 1.2 : 1;
    freq.set(v.category, (freq.get(v.category) || 0) + (1.5 * boost));
  });
  state.categoryFavorites.forEach(cat => {
    if(!freq.has(cat)) freq.set(cat, 0.2);
  });
  const rankedCats = weightedShuffleCategories(freq);
  if(rankedCats.length === 0) return [];

  // Split eligible candidates per category into "fresh" (not shown lately)
  // and "recent" (shown in the last few renders), so fresh picks are
  // always exhausted first before anything repeats.
  const freshByCat = new Map();
  const recentByCat = new Map();
  sourceList.forEach(v => {
    if(seenPaths.has(v.path) ) return;
    if(state.watchLater && state.watchLater.has(favKey(v))) return;
    if(!rankedCats.includes(v.category)) return;
    const bucket = recentSet.has(favKey(v)) ? recentByCat : freshByCat;
    if(!bucket.has(v.category)) bucket.set(v.category, []);
    bucket.get(v.category).push(v);
  });
  freshByCat.forEach(list => shuffleArray(list));
  recentByCat.forEach(list => shuffleArray(list));

  const result = [];
  const pushRoundRobin = (byCat) => {
    for(let round = 0; result.length < FOR_YOU_COUNT; round++){
      let addedAny = false;
      for(const cat of rankedCats){
        const list = byCat.get(cat);
        if(list && list[round] && !result.includes(list[round])){
          result.push(list[round]);
          addedAny = true;
          if(result.length >= FOR_YOU_COUNT) break;
        }
      }
      if(!addedAny) break;
    }
  };
  pushRoundRobin(freshByCat);
  if(result.length < FOR_YOU_COUNT) pushRoundRobin(recentByCat);

  const shownKeys = result.map(favKey);
  state.forYouRecent[type] = [...(state.forYouRecent[type] || []), ...shownKeys].slice(-FOR_YOU_COUNT * 4);
  saveForYouRecent();

  return result;
}
function computeForYou(){ return computeForYouFor('video'); }

function computeContinueWatching(){
  return state.videos
    .map(v => ({ item: v, progress: getWatchProgress(v) }))
    .filter(entry => entry.progress && entry.progress.percent > 0.08 && entry.progress.percent < 0.95)
    .sort((a, b) => (b.progress.updatedAt || 0) - (a.progress.updatedAt || 0))
    .map(entry => entry.item)
    .slice(0, 6);
}

function computeRecentlyAdded(){
  return [...state.videos]
    .sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0))
    .slice(0, 6);
}

function bindDiscoverCarousel(rowId, prevBtnId, nextBtnId){
  const row = document.getElementById(rowId);
  const prevBtn = document.getElementById(prevBtnId);
  const nextBtn = document.getElementById(nextBtnId);
  if(!row || !prevBtn || !nextBtn) return;
  if(prevBtn.dataset.bound === '1') return;
  prevBtn.dataset.bound = '1';
  nextBtn.dataset.bound = '1';

  const updateButtons = () => {
    const atStart = row.scrollLeft <= 2;
    const atEnd = row.scrollLeft + row.clientWidth >= row.scrollWidth - 2;
    prevBtn.disabled = atStart;
    nextBtn.disabled = atEnd;
  };

  prevBtn.addEventListener('click', () => {
    row.scrollBy({ left: -Math.max(240, row.clientWidth * 0.85), behavior: 'smooth' });
  });
  nextBtn.addEventListener('click', () => {
    row.scrollBy({ left: Math.max(240, row.clientWidth * 0.85), behavior: 'smooth' });
  });
  row.addEventListener('scroll', updateButtons, { passive: true });
  requestAnimationFrame(updateButtons);
}

function renderDiscoverSections(){
  const continueSection = document.getElementById('continueWatchingSection');
  const continueRow = document.getElementById('continueWatchingRow');
  const recentSection = document.getElementById('recentlyAddedSection');
  const recentRow = document.getElementById('recentlyAddedRow');

  if(!state.discoverEnabled || state.tab !== 'videos' || state.cat.videos || state.search || state.filters.videos.category !== 'all' || state.filters.videos.date !== 'all'){
    continueSection.hidden = true;
    recentSection.hidden = true;
    return;
  }

  const continueItems = computeContinueWatching();
  if(continueItems.length){
    continueSection.hidden = false;
    continueRow.innerHTML = '';
    bindDiscoverCarousel('continueWatchingRow', 'continueWatchingPrevBtn', 'continueWatchingNextBtn');
    continueItems.forEach(item => {
      const card = document.createElement('div');
      card.className = 'vcard discover-card';
      card.innerHTML = `
        <div class="vcard-thumb">
          <div class="thumb-fallback">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M3 6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z" stroke="currentColor" stroke-width="1.5"/><path d="m21 8 -4 3 4 3V8Z" fill="currentColor"/></svg>
          </div>
          <span class="vcard-dur" hidden></span>${watchedProgressHTML(item)}
        </div>
        <div class="vcard-title">${escapeHtml(item.name)}</div>
        <div class="vcard-meta">${escapeHtml(item.category)} · ${formatDate(item.lastModified)}</div>
      `;
      card.addEventListener('click', () => openWatch(item));
      continueRow.appendChild(card);
      loadCardThumb(card, item);
      attachHoverPreview(card, item);
    });
  } else {
    continueSection.hidden = true;
  }

  const recentItems = computeRecentlyAdded();
  if(recentItems.length){
    recentSection.hidden = false;
    recentRow.innerHTML = '';
    bindDiscoverCarousel('recentlyAddedRow', 'recentlyAddedPrevBtn', 'recentlyAddedNextBtn');
    recentItems.forEach(item => {
      const card = document.createElement('div');
      card.className = 'vcard discover-card';
      card.innerHTML = `
        <div class="vcard-thumb">
          <div class="thumb-fallback">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M3 6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z" stroke="currentColor" stroke-width="1.5"/><path d="m21 8 -4 3 4 3V8Z" fill="currentColor"/></svg>
          </div>
          <span class="vcard-dur" hidden></span>
        </div>
        <div class="vcard-title">${escapeHtml(item.name)}</div>
        <div class="vcard-meta">${escapeHtml(item.category)} · ${formatDate(item.lastModified)}</div>
      `;
      card.addEventListener('click', () => openWatch(item));
      recentRow.appendChild(card);
      loadCardThumb(card, item);
      attachHoverPreview(card, item);
    });
  } else {
    recentSection.hidden = true;
  }
}

function renderForYouRow(){
  const section = document.getElementById('forYouSection');
  const row = document.getElementById('forYouRow');
  if(state.tab !== 'videos' || state.cat.videos || state.search){
    section.hidden = true;
    return;
  }
  const list = computeForYou();
  if(list.length === 0){ section.hidden = true; return; }
  section.hidden = false;
  row.innerHTML = '';
  list.forEach(item => {
    const card = document.createElement('div');
    card.className = 'vcard for-you-card';
    card.innerHTML = `
      <div class="vcard-thumb">
        ${isWatchLater(item)?'<span class="vcard-badge">Watch later</span>':''}
        <div class="thumb-fallback">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M3 6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z" stroke="currentColor" stroke-width="1.5"/><path d="m21 8 -4 3 4 3V8Z" fill="currentColor"/></svg>
        </div>
        <span class="vcard-dur" hidden></span>${watchedProgressHTML(item)}
        <button class="vcard-fav ${isFav(item)?'is-fav':''}" data-fav-key="${favKey(item)}" title="Favorite">${heartSVG(isFav(item))}</button>
        <button class="vcard-fav watch-later-btn ${isWatchLater(item)?'is-watch-later':''}" data-watch-later-key="${favKey(item)}" title="Watch later">${watchLaterSVG(isWatchLater(item))}</button>
      </div>
      <div class="vcard-title">${escapeHtml(item.name)}</div>
      <div class="vcard-meta">${escapeHtml(item.category)}</div>
    `;
    card.querySelector('.vcard-fav').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFav(item);
      e.currentTarget.classList.toggle('is-fav', isFav(item));
      e.currentTarget.innerHTML = heartSVG(isFav(item));
    });
    card.querySelector('.watch-later-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleWatchLater(item);
    });
    card.addEventListener('click', () => openWatch(item));
    row.appendChild(card);
    loadCardThumb(card, item);
    attachHoverPreview(card, item);
  });
}

function renderForYouImagesRow(){
  const section = document.getElementById('forYouImagesSection');
  const row = document.getElementById('forYouImagesRow');
  if(state.tab !== 'images' || state.cat.images || state.search){
    section.hidden = true;
    return;
  }
  const list = computeForYouFor('image');
  if(list.length === 0){ section.hidden = true; return; }
  section.hidden = false;
  row.innerHTML = '';
  list.forEach(item => row.appendChild(createPinCard(item)));
}

function headingFor(tab){
  const cat = state.cat[tab];
  const noun = tab === 'videos' ? 'videos' : tab === 'images' ? 'photos' : 'tracks';
  if(cat === '__fav__') return `Liked ${noun}`;
  if(cat === '__history__') return `History`;
  if(cat === '__snapshots__') return 'Snapshots';
  if(cat === '__watchlater__') return 'Watch later';
  if(cat === '__captioned__') return 'Captioned';
  if(cat) return `${cat}`;
  return `All ${noun}`;
}

function renderFilterControls(){
  const tabs = [
    { tab: 'videos', categoryId: 'videosCategoryFilter', dateId: 'videosDateFilter' },
    { tab: 'images', categoryId: 'imagesCategoryFilter', dateId: 'imagesDateFilter' },
  ];

  tabs.forEach(({ tab, categoryId, dateId }) => {
    const categorySelect = document.getElementById(categoryId);
    const dateSelect = document.getElementById(dateId);
    if(!categorySelect || !dateSelect) return;

    const cats = (state.categoriesByTab && state.categoriesByTab[tab] ? state.categoriesByTab[tab] : []).slice();
    const selectedCat = state.filters[tab].category || 'all';
    categorySelect.innerHTML = `<option value="all">All categories</option>${cats.map(cat => `<option value="${escapeAttr(cat)}">${escapeHtml(cat)}</option>`).join('')}`;
    categorySelect.value = cats.includes(selectedCat) ? selectedCat : 'all';
    categorySelect.onchange = () => {
      state.filters[tab].category = categorySelect.value;
      renderActiveGrid();
    };

    const selectedDate = state.filters[tab].date || 'all';
    dateSelect.value = ['all','7','30','90'].includes(selectedDate) ? selectedDate : 'all';
    dateSelect.onchange = () => {
      state.filters[tab].date = dateSelect.value;
      renderActiveGrid();
    };
  });
}

function renderActiveGrid(){
  renderFilterControls();
  if(state.tab === 'videos'){
    document.getElementById('videosHeading').textContent = headingFor('videos');
    document.getElementById('forYouImagesSection').hidden = true;
    renderDiscoverSections();
    renderForYouRow();
    renderVideoGrid();
  } else if(state.tab === 'images'){
    document.getElementById('imagesHeading').textContent = headingFor('images');
    document.getElementById('forYouSection').hidden = true;
    renderForYouImagesRow();
    renderImageGrid();
  } else if(state.tab === 'view'){
    document.getElementById('forYouSection').hidden = true;
    document.getElementById('forYouImagesSection').hidden = true;
    /* Static browser tab — nothing to render, the iframe manages itself. */
  } else {
    document.getElementById('musicHeading').textContent = headingFor('music');
    document.getElementById('forYouSection').hidden = true;
    document.getElementById('forYouImagesSection').hidden = true;
    renderMusicLibrary();
  }
}