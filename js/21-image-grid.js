/* ==========================================================================
   Image grid — laid out with a real CSS grid (see .pin-grid in style.css).
   All tiles share a fixed aspect ratio, so the grid fills every row
   edge-to-edge on its own; no more JS column-balancing needed.
   ========================================================================== */
let imageGridState = { list: [], rendered: 0 };

function updateImagesEndMessage(rendered, total){
  const el = document.getElementById('imagesEndMessage');
  if(el) el.hidden = !(rendered >= total && total > 0);
}

function renderImageGrid(){
  const wrap = document.getElementById('imageGridWrap');
  const list = getFiltered('images');
  document.getElementById('imagesEmpty').hidden = list.length !== 0;
  wrap.innerHTML = '';

  const toggleBtn = document.getElementById('toggleSnapshotSelectBtn');
  if(toggleBtn){
    const showBtn = state.cat.images === '__snapshots__';
    toggleBtn.style.display = showBtn ? 'block' : 'none';
    if(!showBtn){
      state.snapshotSelectMode = false;
      state.selectedSnapshots.clear();
      document.getElementById('downloadSelectedSnapshotsBtn').style.display = 'none';
      const deleteBtn = document.getElementById('deleteSelectedSnapshotsBtn'); // NEW
      if(deleteBtn) deleteBtn.style.display = 'none';                          // NEW
    }
  }

  imageGridState = { list, rendered: 0 };
  updateImagesEndMessage(0, list.length);
  const restore = pendingGridRestore && pendingGridRestore.tab === 'images' ? pendingGridRestore : null;
  appendImageCards(restore ? Math.max(IMAGE_PAGE_SIZE, state.gridRenderedCount.images) : IMAGE_PAGE_SIZE);
  setupGridLoadMore('imageGridSentinel', 'image', () => appendImageCards(IMAGE_PAGE_SIZE));

  if(restore){
    pendingGridRestore = null;
    requestAnimationFrame(() => {
      const m = document.querySelector('.main');
      if(m) m.scrollTop = restore.top;
    });
  }
}

function createPinCard(item, opts = {}){
  const el = document.createElement('div');
  el.className = 'pin-item';
  el._rfItem = item;
  el.innerHTML = `
    ${opts.forYou ? '<span class="pin-badge">For You</span>' : ''}
    <img alt="${escapeAttr(item.name)}" loading="lazy" decoding="async" fetchpriority="low">
    <div class="pin-overlay"><div class="pt">${escapeHtml(item.name)}</div></div>
    <button class="pin-fav ${isFav(item)?'is-fav':''}" data-fav-key="${favKey(item)}" title="Favorite">${heartSVG(isFav(item))}</button>
    ${item.source === 'snapshot' ? '<div class="pin-checkbox"></div>' : ''}
  `;
  const img = el.querySelector('img');

  /* Paired photos have no local file — the grid only needs a small
     preview, so ask the host for a thumb instead of the full-size
     original (that only gets pulled when the photo is actually opened
     in Focus view, via ensureItemUrlAsync). */
  if(item.pairRemote){
    if(item.thumb){
      img.src = item.thumb;
    } else {
      const isFirstWaiter = registerPairThumbWaiter(item.pairPath, (thumb) => { item.thumb = thumb; img.src = thumb; });
      if(isFirstWaiter) requestPairThumb(item.pairPath);
    }
  } else {
    img.src = ensureItemUrl(item);
  }

  if(item.source === 'snapshot'){
    const checkbox = el.querySelector('.pin-checkbox');
    const isSelected = state.selectedSnapshots.has(item.path);
    if(isSelected) checkbox.classList.add('checked');
    checkbox.addEventListener('click', (e) => {
      e.stopPropagation();
      if(state.selectedSnapshots.has(item.path)){
        state.selectedSnapshots.delete(item.path);
        checkbox.classList.remove('checked');
      } else {
        state.selectedSnapshots.add(item.path);
        checkbox.classList.add('checked');
      }
      updateDownloadSelectedBtn();
      updateDeleteSelectedBtn(); // NEW
    });
  }

  el.querySelector('.pin-fav').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFav(item);
    e.currentTarget.classList.toggle('is-fav', isFav(item));
    e.currentTarget.innerHTML = heartSVG(isFav(item));
  });
  el.addEventListener('click', () => {
    if(state.snapshotSelectMode && item.source === 'snapshot') return;
    openFocus(item);
  });
  return el;
}

function appendImageCards(count){
  const wrap = document.getElementById('imageGridWrap');
  const { list, rendered } = imageGridState;
  const end = Math.min(list.length, rendered + count);
  for(let idx = rendered; idx < end; idx++){
    const card = createPinCard(list[idx]);
    if(state.snapshotSelectMode && list[idx].source === 'snapshot'){
      card.classList.add('show-checkboxes');
    }
    wrap.appendChild(card);
  }
  imageGridState.rendered = end;
  updateImagesEndMessage(end, list.length);
}
