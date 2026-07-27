/* ==========================================================================
   Image pop-out viewer — click the focused photo to pop it into a floating,
   draggable, resizable frame over a darkened backdrop.
   ========================================================================== */

/* ==========================================================================
   "More from this library" row sizing — desktop shows a full-width grid
   capped at 3 rows (column count depends on viewport width); mobile keeps
   the original horizontal-scrolling strip.
   ========================================================================== */
const FOCUS_ROW_GAP = 14;
const FOCUS_ROW_DESKTOP_BREAKPOINT = 980;
const FOCUS_ROW_DESKTOP_ROWS = 3;
const FOCUS_ROW_DESKTOP_POOL = 60; // plenty of items to fill 3 full rows at any reasonable width
let focusRowCapTimer = null;

/* Measures the actual rendered tile height (post-layout) and clips the row
   list to exactly FOCUS_ROW_DESKTOP_ROWS rows worth of height — far more
   reliable than trying to predict column count ahead of time. */
function capFocusRowToRows(){
  const wrap = document.getElementById('focusBottomRow');
  if(!wrap) return;
  if(window.innerWidth <= FOCUS_ROW_DESKTOP_BREAKPOINT){
    wrap.style.maxHeight = '';
    return;
  }
  const firstItem = wrap.querySelector('.pin-item');
  if(!firstItem){ wrap.style.maxHeight = ''; return; }
  const itemHeight = firstItem.getBoundingClientRect().height;
  if(!itemHeight){ wrap.style.maxHeight = ''; return; }
  const maxH = itemHeight * FOCUS_ROW_DESKTOP_ROWS + FOCUS_ROW_GAP * (FOCUS_ROW_DESKTOP_ROWS - 1);
  wrap.style.maxHeight = `${Math.ceil(maxH)}px`;
}

let popState = null;
let imageViewerState = {
  scale: 1,
  panX: 0,
  panY: 0,
  baseWidth: 0,
  baseHeight: 0,
  fitScale: 1,
};
const POP_ZOOM_MIN = 0.45;
const POP_ZOOM_MAX = 5;

function clampValue(value, min, max){
  return Math.min(max, Math.max(min, value));
}

function applyImageViewerState(){
  const img = document.getElementById('imagePopImg');
  const frame = document.getElementById('imagePopFrame');
  const badge = document.getElementById('imagePopZoom');
  if(!img || !frame) return;

  const viewportW = frame.clientWidth || window.innerWidth;
  const viewportH = frame.clientHeight || window.innerHeight;
  const width = Math.max(1, imageViewerState.baseWidth * imageViewerState.scale);
  const height = Math.max(1, imageViewerState.baseHeight * imageViewerState.scale);
  const fits = width <= viewportW + 0.5 && height <= viewportH + 0.5;
  const maxPanX = Math.max(0, (width - viewportW) / 2);
  const maxPanY = Math.max(0, (height - viewportH) / 2);

  if(fits){
    imageViewerState.panX = 0;
    imageViewerState.panY = 0;
  } else {
    imageViewerState.panX = clampValue(imageViewerState.panX, -maxPanX, maxPanX);
    imageViewerState.panY = clampValue(imageViewerState.panY, -maxPanY, maxPanY);
  }

  img.style.width = `${Math.round(width)}px`;
  img.style.height = `${Math.round(height)}px`;
  img.style.transform = `translate(-50%, -50%) translate(${imageViewerState.panX}px, ${imageViewerState.panY}px) scale(${imageViewerState.scale})`;
  frame.classList.toggle('zoomed', imageViewerState.scale > 1);
  frame.classList.toggle('can-pan', !fits);
  badge.textContent = `${Math.round(imageViewerState.scale * 100)}%`;
  badge.classList.toggle('show', imageViewerState.scale > 1);
}

function setImageViewerScale(scale, opts = {}){
  const frame = document.getElementById('imagePopFrame');
  if(!frame) return;

  const viewportW = frame.clientWidth || window.innerWidth;
  const viewportH = frame.clientHeight || window.innerHeight;
  const oldScale = imageViewerState.scale;
  const nextScale = clampValue(scale, POP_ZOOM_MIN, POP_ZOOM_MAX);

  if(opts.originX != null && opts.originY != null && oldScale > 0){
    const centerX = viewportW / 2;
    const centerY = viewportH / 2;
    const deltaX = opts.originX - (centerX + imageViewerState.panX);
    const deltaY = opts.originY - (centerY + imageViewerState.panY);
    const zoomRatio = nextScale / oldScale;
    imageViewerState.panX += deltaX * (1 - zoomRatio);
    imageViewerState.panY += deltaY * (1 - zoomRatio);
  } else if(opts.resetPan){
    imageViewerState.panX = 0;
    imageViewerState.panY = 0;
  }

  imageViewerState.scale = nextScale;
  applyImageViewerState();
}

function resetImageViewer(){
  imageViewerState.scale = 1;
  imageViewerState.panX = 0;
  imageViewerState.panY = 0;
  applyImageViewerState();
}

function openImagePop(item){
  const overlay = document.getElementById('imagePopOverlay');
  const frame = document.getElementById('imagePopFrame');
  const img = document.getElementById('imagePopImg');

  img.src = ensureItemUrl(item);
  img.alt = item.name;
  overlay.hidden = false;
  imageViewerState = { scale: 1, panX: 0, panY: 0, baseWidth: 0, baseHeight: 0, fitScale: 1 };

  const place = () => {
    const viewportW = frame.clientWidth || window.innerWidth;
    const viewportH = frame.clientHeight || window.innerHeight;
    const naturalW = img.naturalWidth || 1280;
    const naturalH = img.naturalHeight || 720;
    const fitScale = Math.min(1, viewportW / naturalW, viewportH / naturalH);
    imageViewerState.baseWidth = naturalW * fitScale;
    imageViewerState.baseHeight = naturalH * fitScale;
    imageViewerState.fitScale = fitScale;
    imageViewerState.scale = 1;
    imageViewerState.panX = 0;
    imageViewerState.panY = 0;
    applyImageViewerState();
  };

  if(img.complete && img.naturalWidth) place();
  else img.onload = place;
}

function closeImagePop(){
  document.getElementById('imagePopOverlay').hidden = true;
  resetImageViewer();
}

function bindImagePopOverlay(){
  const overlay = document.getElementById('imagePopOverlay');
  const frame = document.getElementById('imagePopFrame');
  const resizeHandle = document.getElementById('imagePopResize');
  const closeBtn = document.getElementById('imagePopClose');

  closeBtn.addEventListener('click', closeImagePop);
  overlay.addEventListener('click', (e) => { if(e.target === overlay) closeImagePop(); });
  window.addEventListener('keydown', (e) => {
    if(e.key === 'Escape' && !overlay.hidden) closeImagePop();
  });
  window.addEventListener('resize', () => {
    if(!overlay.hidden) applyImageViewerState();
  });

  frame.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = frame.getBoundingClientRect();
    const originX = e.clientX - rect.left;
    const originY = e.clientY - rect.top;
    const zoomFactor = Math.exp(-e.deltaY * 0.0015);
    setImageViewerScale(imageViewerState.scale * zoomFactor, { originX, originY });
  }, { passive: false });

  frame.addEventListener('dblclick', (e) => {
    if(e.target === resizeHandle || resizeHandle.contains(e.target)) return;
    const rect = frame.getBoundingClientRect();
    const originX = e.clientX - rect.left;
    const originY = e.clientY - rect.top;
    if(imageViewerState.scale > 1.001){
      setImageViewerScale(1, { resetPan: true });
    } else {
      setImageViewerScale(2.2, { originX, originY });
    }
  });

  frame.addEventListener('pointerdown', (e) => {
    if(e.target === resizeHandle || resizeHandle.contains(e.target)) return;
    const viewportW = frame.clientWidth || window.innerWidth;
    const viewportH = frame.clientHeight || window.innerHeight;
    const width = imageViewerState.baseWidth * imageViewerState.scale;
    const height = imageViewerState.baseHeight * imageViewerState.scale;
    const canPan = width > viewportW + 0.5 || height > viewportH + 0.5;
    if(!canPan) return;

    popState = { mode: 'pan', startX: e.clientX, startY: e.clientY, startPanX: imageViewerState.panX, startPanY: imageViewerState.panY };
    frame.classList.add('dragging');
    frame.setPointerCapture(e.pointerId);
  });

  resizeHandle.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
  });

  frame.addEventListener('pointermove', (e) => {
    if(!popState || popState.mode !== 'pan') return;
    const viewportW = frame.clientWidth || window.innerWidth;
    const viewportH = frame.clientHeight || window.innerHeight;
    const width = imageViewerState.baseWidth * imageViewerState.scale;
    const height = imageViewerState.baseHeight * imageViewerState.scale;
    const maxPanX = Math.max(0, (width - viewportW) / 2);
    const maxPanY = Math.max(0, (height - viewportH) / 2);
    imageViewerState.panX = clampValue(popState.startPanX + (e.clientX - popState.startX), -maxPanX, maxPanX);
    imageViewerState.panY = clampValue(popState.startPanY + (e.clientY - popState.startY), -maxPanY, maxPanY);
    applyImageViewerState();
  });

  function endPop(){
    frame.classList.remove('dragging');
    popState = null;
  }
  frame.addEventListener('pointerup', endPop);
  frame.addEventListener('pointercancel', endPop);
}

function downloadSnapshotItem(item){
  if(!item || item.source !== 'snapshot') return;
  const blob = item.blob || null;
  if(!blob){
    toast('This snapshot does not have a downloadable file');
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(item.name || 'snapshot').replace(/\s+/g, ' ').trim() || 'snapshot'}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast('Snapshot downloaded');
}

function goToSnapshotSource(item){
  if(!item || !item.videoPath){ toast('No source video recorded for this snapshot.'); return; }
  const video = state.videos.find(v => v.path === item.videoPath);
  if(!video){ toast('Could not find the original video — it may have been renamed, moved, or excluded.'); return; }
  setTab('videos', { skipRender:true });
  openWatch(video);
  const player = document.getElementById('videoPlayer');
  const seekToTimestamp = () => { player.currentTime = item.timestamp || 0; };
  if(player.readyState >= 1) seekToTimestamp();
  else player.addEventListener('loadedmetadata', seekToTimestamp, { once:true });
}

function locateItemPath(item){
  if(!item) return;
  const fullPath = state.rootName ? `${state.rootName}/${item.path}` : item.path;
  copyTextToClipboard(fullPath).then(ok => {
    toast(ok ? `Path copied: ${fullPath}` : `Path: ${fullPath}`);
  });
}

function openFocus(item, opts = {}){
  state.currentImage = item;
  recordHistory(item);
  showView('imageFocus');
  if(opts.push !== false) history.pushState(null, '', `?p=${encodeURIComponent(item.path)}`);
  const focusImgEl = document.getElementById('focusImg');
  if(item.pairRemote){
    focusImgEl.removeAttribute('src');
    ensureItemUrlAsync(item).then(src => { if(state.currentImage === item) focusImgEl.src = src; })
      .catch(() => toast("Couldn't load that photo from the paired device."));
  } else {
    focusImgEl.src = ensureItemUrl(item);
  }
  focusImgEl.alt = item.name;
  focusImgEl.onclick = () => openImagePop(item);
  document.getElementById('focusTitle').textContent = item.name;
  const focusMetaEl = document.getElementById('focusMeta');
  focusMetaEl.innerHTML = `<span class="meta-cat-link" data-cat="${escapeAttr(item.category)}" title="Jump to this category">${escapeHtml(item.category)}</span> · ${escapeHtml(formatDate(item.lastModified))} · ${escapeHtml(formatBytes(item.size))}`;
  const focusCatLink = focusMetaEl.querySelector('.meta-cat-link');
  if(focusCatLink) focusCatLink.addEventListener('click', () => goToCategory('images', item.category));

  const favBtn = document.getElementById('focusFavBtn');
  favBtn.setAttribute('data-fav-key', favKey(item));
  favBtn.classList.toggle('is-fav', isFav(item));
  favBtn.onclick = () => {
    toggleFav(item);
    favBtn.classList.toggle('is-fav', isFav(item));
  };
  const shareBtn = document.getElementById('focusShareBtn');
  if(shareBtn){
    shareBtn.onclick = () => openShareModal(item);
  }

  const downloadBtn = document.getElementById('focusDownloadBtn');
  const isSnapshot = item && item.source === 'snapshot';
  if(downloadBtn){
    downloadBtn.hidden = !isSnapshot;
    downloadBtn.onclick = () => downloadSnapshotItem(item);
  }

  const sourceBtn = document.getElementById('focusSourceBtn');
  if(sourceBtn){
    const hasSource = isSnapshot && !!item.videoPath;
    sourceBtn.hidden = !hasSource;
    if(hasSource){
      const sourceLabel = document.getElementById('focusSourceLabel');
      if(sourceLabel) sourceLabel.textContent = `From: ${item.videoName || 'video'}`;
      sourceBtn.title = `Jump to "${item.videoName || 'video'}" at ${formatDuration(item.timestamp || 0)}`;
      sourceBtn.onclick = () => goToSnapshotSource(item);
    }
  }

  const locateBtn = document.getElementById('focusLocateBtn');
  if(locateBtn){
    const canLocate = !isSnapshot && !item.remote && !item.pairRemote && !item.ephemeral;
    locateBtn.hidden = !canLocate;
    if(canLocate) locateBtn.onclick = () => locateItemPath(item);
  }

  const focusSaveBtn = document.getElementById('focusSaveBtn');
  if(focusSaveBtn){
    focusSaveBtn.hidden = !item.remote;
    focusSaveBtn.onclick = () => promptSaveItem(item, 'images');
  }
  const SIDE_COUNT = 16;
  const FOR_YOU_MIX = 3;
  const isDesktopRow = window.innerWidth > FOCUS_ROW_DESKTOP_BREAKPOINT;
  const ROW_COUNT = isDesktopRow ? FOCUS_ROW_DESKTOP_POOL : 14;

  const forYouPicks = computeForYouFor('image').filter(v => v !== item).slice(0, FOR_YOU_MIX);
  const forYouPaths = new Set(forYouPicks.map(v => v.path));
  const pool = shuffleArray(getFiltered('images').filter(v => v !== item && !forYouPaths.has(v.path)));
  const leadForYou = forYouPicks.slice(0, 2);
  const sideItems = [
    ...leadForYou,
    ...pool.slice(0, Math.max(0, SIDE_COUNT - leadForYou.length))
  ];
  const rowItems = [
    ...leadForYou,
    ...pool.slice(SIDE_COUNT - leadForYou.length, SIDE_COUNT - leadForYou.length + ROW_COUNT)
  ];

  const sideCol = document.getElementById('focusSideCol');
  sideCol.innerHTML = '';
  sideItems.forEach(im => sideCol.appendChild(createPinCard(im, { forYou: forYouPaths.has(im.path) })));

  const bottomRow = document.getElementById('focusBottomRow');
  bottomRow.innerHTML = '';
  rowItems.forEach(im => bottomRow.appendChild(createPinCard(im, { forYou: forYouPaths.has(im.path) })));

  capFocusRowToRows();

  if(watchParty.role === 'host' && partyIsActive() && watchParty.item !== item) broadcastPartyItem(item);
  scrollMainTop();
}

/* Re-lay the "More from this library" grid when the column count would
   actually change — not on every resize tick. */
window.addEventListener('resize', () => {
  const focusView = document.getElementById('imageFocus');
  if(!focusView || focusView.hidden || !state.currentImage) return;
  clearTimeout(focusRowCapTimer);
  focusRowCapTimer = setTimeout(capFocusRowToRows, 150);
});