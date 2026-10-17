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

/* ==========================================================================
   Photo grid thumbnails
   Cards used to point straight at the original files, so scrolling the grid
   meant decoding dozens of full-size photos (often 4000px+). Now each local
   photo is shrunk once to a small JPEG when its card nears the screen; the
   original is only loaded when you open the photo.
   ========================================================================== */
const GRID_THUMB_WIDTH = 480;
const GRID_THUMB_MAX_CONCURRENT = 3;
const gridThumbCache = new Map();      // key -> object URL of the small version
const gridThumbPending = new Map();    // key -> Promise<string|null>
let gridThumbActive = 0;
const gridThumbQueue = [];

function gridThumbKey(item){ return `${item.path}|${item.lastModified || 0}|${item.file && item.file.size || 0}`; }
function gridThumbEligible(item){
  const f = item.file;
  if(!f || item.pairRemote || item.thumb) return false;
  if(item.source === 'snapshot') return false;                  // already small, generated in-app
  const type = (f.type || '').toLowerCase();
  if(type === 'image/gif' || type === 'image/svg+xml') return false;   // keep animation / vectors
  return typeof createImageBitmap === 'function';
}
function runGridThumbQueue(){
  while(gridThumbActive < GRID_THUMB_MAX_CONCURRENT && gridThumbQueue.length){
    const job = gridThumbQueue.shift();
    gridThumbActive++;
    job().finally(() => { gridThumbActive--; runGridThumbQueue(); });
  }
}
function makeGridThumb(item){
  const key = gridThumbKey(item);
  if(gridThumbCache.has(key)) return Promise.resolve(gridThumbCache.get(key));
  if(gridThumbPending.has(key)) return gridThumbPending.get(key);
  const p = new Promise((resolve) => {
    gridThumbQueue.push(async () => {
      let url = null;
      try{
        const bmp = await createImageBitmap(item.file, { resizeWidth: GRID_THUMB_WIDTH, resizeQuality: 'medium' });
        const canvas = document.createElement('canvas');
        canvas.width = bmp.width; canvas.height = bmp.height;
        canvas.getContext('2d').drawImage(bmp, 0, 0);
        if(bmp.close) bmp.close();
        const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.82));
        if(blob){ url = URL.createObjectURL(blob); gridThumbCache.set(key, url); }
      }catch(e){ /* unsupported/huge/corrupt — caller falls back to the original */ }
      gridThumbPending.delete(key);
      resolve(url);
    });
    runGridThumbQueue();
  });
  gridThumbPending.set(key, p);
  return p;
}

/* Cards only start building their thumbnail once they're close to the viewport. */
const gridThumbObserver = ('IntersectionObserver' in window) ? new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if(!entry.isIntersecting) return;
    gridThumbObserver.unobserve(entry.target);
    const img = entry.target;
    const item = img._rfThumbItem;
    if(!item || !img.isConnected) return;
    makeGridThumb(item).then(url => {
      if(img.isConnected || !img.src) img.src = url || ensureItemUrl(item) || '';
    });
  });
}, { rootMargin: '700px 0px' }) : null;

function setGridImageSource(img, item){
  if(gridThumbEligible(item) && gridThumbObserver){
    const cached = gridThumbCache.get(gridThumbKey(item));
    if(cached){ img.src = cached; return; }
    img._rfThumbItem = item;
    gridThumbObserver.observe(img);
    return;
  }
  img.src = item.thumb || ensureItemUrl(item) || '';
}

function createPinCard(item, opts = {}){
  const gated = shouldGateItem(item);
  const el = document.createElement('div');
  el.className = `pin-item${gated ? ' nsfw-flagged' : ''}`;
  el._rfItem = item;
  const entry = iCameEntry ? iCameEntry(item) : null;
  const splatMarkup = entry && state.iCameSettings && state.iCameSettings.showSplats && Array.isArray(entry.splats) && entry.splats.length ? (
    entry.splats.slice(-8).map((p, idx) => {
      const size = Math.max(36, (p.s || 0.3) * 100);
      const left = (p.x || 0.5) * 100;
      const top = (p.y || 0.5) * 100;
      return `<svg class="pin-icame-splat" data-i="${idx}" viewBox="0 0 100 100" style="left:${(left - size / 2 / 100 * 100).toFixed(1)}%;top:${(top - size / 2 / 100 * 100).toFixed(1)}%;width:${size.toFixed(1)}%;height:${size.toFixed(1)}%">${splatInner(p, idx)}</svg>`;
    }).join('')
  ) : '';
  const target = iCameTargetForItem ? iCameTargetForItem(item) : null;
  const targetMarkup = target ? `<div class="icame-target-box" style="left:${(target.x * 100).toFixed(1)}%;top:${(target.y * 100).toFixed(1)}%;width:${(target.w * 100).toFixed(1)}%;height:${(target.h * 100).toFixed(1)}%"></div>` : '';
  el.innerHTML = `
    <div class="pin-badges">
      ${opts.forYou ? '<span class="pin-badge">For You</span>' : ''}
      ${isSeeLater(item) ? '<span class="pin-badge">See later</span>' : ''}
      ${item._icameCount ? `<span class="pin-badge">💦 ×${item._icameCount}</span>` : ''}
      ${gated ? `<span class="nsfw-badge" title="Flagged as possible NSFW content">${nsfwWarningIconSVG()} NSFW</span>` : ''}
    </div>
    <img alt="${escapeAttr(item.name)}" loading="lazy" decoding="async" fetchpriority="low">
    <div class="pin-icame-layer">${splatMarkup}${targetMarkup}</div>
    <div class="pin-overlay"><div class="pt">${escapeHtml(item.name)}</div></div>
    <button class="pin-fav ${isFav(item)?'is-fav':''}" data-fav-key="${favKey(item)}" title="Favorite">${heartSVG(isFav(item))}</button>
    <button class="pin-see-later ${isSeeLater(item)?'is-see-later':''}" data-see-later-key="${favKey(item)}" title="See later">${seeLaterSVG(isSeeLater(item))}</button>
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
    // Prefer a lightweight thumb if provided (remote host thumb URL),
    // otherwise fall back to the full item URL.
    const probe = item.thumb || item.url || '';
    if(probe && /^https?:\/\//i.test(probe)){
      try{ img.crossOrigin = 'anonymous'; img.referrerPolicy = 'no-referrer'; }catch(e){}
    }
    setGridImageSource(img, item);
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
  const seeBtn = el.querySelector('.pin-see-later');
  if(seeBtn){
    seeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSeeLater(item);
      seeBtn.classList.toggle('is-see-later', isSeeLater(item));
      seeBtn.innerHTML = seeLaterSVG(isSeeLater(item));
    });
  }
  el.addEventListener('click', () => {
    if(state.snapshotSelectMode && item.source === 'snapshot') return;
    openFocus(item);
  });
  if(typeof decorateVariantBadge === 'function') decorateVariantBadge(el, item, '');
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