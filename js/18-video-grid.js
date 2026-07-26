/* ==========================================================================
   Video grid + lazy thumbnails
   ========================================================================== */
function ensureVideoMeta(item){
  if(item._metaPromise) return item._metaPromise;
  item._metaPromise = new Promise((resolve) => {
    const src = ensureItemUrl(item);
    if(!src){ resolve(item); return; }
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'metadata';
    v.src = src;
    const cleanup = () => { v.src = ''; v.remove(); };
    v.addEventListener('loadedmetadata', () => {
      item.duration = v.duration;
      const seekTo = Math.min(1, (v.duration || 1) * 0.12);
      try{ v.currentTime = seekTo; }catch(e){ finish(); }
    });
    v.addEventListener('seeked', finish);
    v.addEventListener('error', () => { item._metaPromise = null; item.broken = true; resolve(item); });
    function finish(){
      try{
        const canvas = document.createElement('canvas');
        canvas.width = v.videoWidth || 320;
        canvas.height = v.videoHeight || 180;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        item.thumb = canvas.toDataURL('image/jpeg', 0.7);
      }catch(e){ /* cross-origin or decode issue — skip thumb */ }
      cleanup();
      resolve(item);
    }
    setTimeout(() => {
      if(!item.thumb) item._metaPromise = null;
      resolve(item);
    }, 6000);
  });
  return item._metaPromise;
}

function retryStalledThumbs(){
  document.querySelectorAll('.vcard, .wside-item').forEach(card => {
    const idx = card.dataset.idx;
    const item = idx != null ? videoGridState.list[+idx] : null;
    if(item && !item.thumb) loadCardThumb(card, item);
  });
}

function updateVideosEndMessage(rendered, total){
  const el = document.getElementById('videosEndMessage');
  if(el) el.hidden = !(rendered >= total && total > 0);
}

function renderVideoGrid(){
  const wrap = document.getElementById('videoGridWrap');
  const list = getFiltered('videos');
  document.getElementById('videosEmpty').hidden = list.length !== 0;
  wrap.innerHTML = '';
  videoGridState = { list, rendered: 0 };
  updateVideosEndMessage(0, list.length);

  if(observers.grid) observers.grid.disconnect();
  observers.grid = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if(!entry.isIntersecting) return;
      const el = entry.target;
      const item = videoGridState.list[+el.dataset.idx];
      loadCardThumb(el, item);
      observers.grid.unobserve(el);
    });
  }, { rootMargin: '400px 0px' });

  const restore = pendingGridRestore && pendingGridRestore.tab === 'videos' ? pendingGridRestore : null;
  appendVideoCards(restore ? Math.max(VIDEO_PAGE_SIZE, state.gridRenderedCount.videos) : VIDEO_PAGE_SIZE);
  setupGridLoadMore('videoGridSentinel', 'video', () => appendVideoCards(VIDEO_PAGE_SIZE));

  if(restore){
    pendingGridRestore = null;
    requestAnimationFrame(() => {
      const m = document.querySelector('.main');
      if(m) m.scrollTop = restore.top;
    });
  }
}

function appendVideoCards(count){
  const wrap = document.getElementById('videoGridWrap');
  const { list, rendered } = videoGridState;
  const end = Math.min(list.length, rendered + count);
  for(let idx = rendered; idx < end; idx++){
    const item = list[idx];
    const card = document.createElement('div');
    card.className = 'vcard';
    card.dataset.idx = idx;
    card.innerHTML = `
      <div class="vcard-thumb">
        ${isWatchLater(item)?'<span class="vcard-badge">Watch later</span>':''}
        <div class="thumb-fallback">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M3 6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z" stroke="currentColor" stroke-width="1.5"/><path d="m21 8 -4 3 4 3V8Z" fill="currentColor"/></svg>
        </div>
        <span class="vcard-dur" hidden></span>${watchedProgressHTML(item)}
        <button class="vcard-fav ${isFav(item)?'is-fav':''}" data-fav-key="${favKey(item)}" title="Favorite">${heartSVG(isFav(item))}</button>
        <button class="vcard-fav watch-later-btn ${isWatchLater(item)?'is-watch-later':''}" data-watch-later-key="${favKey(item)}" title="Watch later">${watchLaterSVG(isWatchLater(item))}</button>
      </div>
      <div class="vcard-title">${escapeHtml(item.name)}</div>
      <div class="vcard-meta">${escapeHtml(item.category)} · ${formatDate(item.lastModified)}</div>
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
    wrap.appendChild(card);
    observers.grid.observe(card);
    attachHoverPreview(card, item);
  }
  videoGridState.rendered = end;
  updateVideosEndMessage(end, list.length);
}

let loadMoreObservers = { video: null, image: null, music: null };
function setupGridLoadMore(sentinelId, key, loadMoreFn){
  const sentinel = document.getElementById(sentinelId);
  if(!sentinel) return;
  if(loadMoreObservers[key]) loadMoreObservers[key].disconnect();
  loadMoreObservers[key] = new IntersectionObserver((entries) => {
    entries.forEach(entry => { if(entry.isIntersecting) loadMoreFn(); });
  }, { rootMargin: '1800px 0px' });
  loadMoreObservers[key].observe(sentinel);
}

/* FIX: this used to do
     thumbBox.querySelector('.thumb-fallback').replaceWith(img)
   unconditionally. If the same card ever gets processed twice — the grid's
   IntersectionObserver fires once, then retryStalledThumbs() (e.g. after
   unlocking the screen) fires again before the item's thumb is cached, or
   two loadCardThumb calls race on the same still-loading item — the
   fallback element is already gone by the second call, querySelector
   returns null, and .replaceWith throws. Also guard against the card
   itself having been removed from the DOM (e.g. the grid re-rendered
   while this was still awaiting ensureVideoMeta). */
async function loadCardThumb(cardEl, item){
  const thumbBox = cardEl.querySelector('.vcard-thumb');
  const durEl = cardEl.querySelector('.vcard-dur');
  await ensureVideoMeta(item);
  if(!thumbBox || !thumbBox.isConnected) return; // card was unmounted/replaced while we were awaiting
  if(item.thumb){
    const fallback = thumbBox.querySelector('.thumb-fallback');
    if(fallback){
      const img = document.createElement('img');
      img.src = item.thumb;
      img.alt = item.name;
      fallback.replaceWith(img);
    }
  } else if(item.broken){
    const fallback = thumbBox.querySelector('.thumb-fallback');
    if(fallback){
      fallback.classList.add('thumb-broken');
      fallback.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6"/><path d="M9 9l6 6M15 9l-6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg><span class="thumb-broken-label">Can't play this file</span>`;
    }
  }
  if(item.duration && durEl){
    durEl.textContent = formatDuration(item.duration);
    durEl.hidden = false;
  }
}

const HOVER_PREVIEW_DELAY = 350;
const HOVER_PREVIEW_SNIPPET = 4;

function attachHoverPreview(card, item, thumbSelector = '.vcard-thumb'){
  const thumbBox = card.querySelector(thumbSelector);
  if(!thumbBox) return;
  let hoverTimer = null;
  let previewVideo = null;
  let active = false;

  function startPreview(){
    if(active || !thumbBox.isConnected) return;
    active = true;
    ensureVideoMeta(item).then(() => {
      if(!active) return;
      const dur = item.duration || 0;
      const start = dur > 8 ? dur * 0.4 : 0;
      const src = ensureItemUrl(item);
      if(!src) return;
      const v = document.createElement('video');
      v.className = 'vcard-preview-video';
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      v.src = src;
      v.addEventListener('loadedmetadata', () => {
        try{ v.currentTime = start; }catch(e){}
      });
      v.addEventListener('timeupdate', () => {
        if(v.currentTime > start + HOVER_PREVIEW_SNIPPET || v.currentTime < start - 0.5) v.currentTime = start;
      });
      previewVideo = v;
      thumbBox.appendChild(v);
      v.play().catch(() => {});
    });
  }
  function stopPreview(){
    active = false;
    if(hoverTimer){ clearTimeout(hoverTimer); hoverTimer = null; }
    if(previewVideo){
      previewVideo.pause();
      previewVideo.removeAttribute('src');
      previewVideo.load();
      previewVideo.remove();
      previewVideo = null;
    }
  }

  card.addEventListener('mouseenter', () => {
    hoverTimer = setTimeout(startPreview, HOVER_PREVIEW_DELAY);
  });
  card.addEventListener('mouseleave', stopPreview);
}
