/* ==========================================================================
   Settings modal
   ========================================================================== */
function blobToDataURL(blob){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function getWallpaperEffectFilter(effect){
  return {
    clear: 'none',
    frosted: 'saturate(1.08) brightness(0.94)',
    blur: 'blur(10px) saturate(1.08)',
    bw: 'grayscale(1) contrast(1.06)',
  }[effect] || 'none';
}

function clampWallpaperNumber(value, min, max, fallback){
  const num = Number(value);
  if(!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function getWallpaperCoverStyle(imageWidth, imageHeight, scale, positionX, positionY){
  const viewportWidth = window.innerWidth || 1;
  const viewportHeight = window.innerHeight || 1;
  const coverScale = Math.max(viewportWidth / Math.max(imageWidth, 1), viewportHeight / Math.max(imageHeight, 1));
  const finalScale = coverScale * (scale / 100);
  const width = Math.max(1, imageWidth * finalScale);
  const height = Math.max(1, imageHeight * finalScale);
  return {
    backgroundSize: `${width}px ${height}px`,
    backgroundPosition: `${clampWallpaperNumber(positionX, 0, 100, 50)}% ${clampWallpaperNumber(positionY, 0, 100, 50)}%`,
    backgroundRepeat: 'no-repeat',
  };
}

function loadWallpaperImage(imageUrl){
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth || img.width, height: img.naturalHeight || img.height });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = imageUrl;
  });
}

async function applyWallpaperFrameStyle(el, imageUrl, effect, scale, positionX, positionY, opacity){
  if(!el || !imageUrl) return;
  const { width, height } = await loadWallpaperImage(imageUrl);
  const style = getWallpaperCoverStyle(width || window.innerWidth, height || window.innerHeight, scale, positionX, positionY);
  el.style.backgroundImage = `url(${imageUrl})`;
  el.style.backgroundSize = style.backgroundSize;
  el.style.backgroundPosition = style.backgroundPosition;
  el.style.backgroundRepeat = style.backgroundRepeat;
  el.style.opacity = String(opacity);
  el.style.filter = getWallpaperEffectFilter(effect);
}

/* ==========================================================================
   Website Wallpaper — direct-manipulation cropper
   Replaces the old blind Scale/Position X/Position Y sliders. The person
   drags/zooms the source image under a fixed frame that represents the
   current viewport's aspect ratio; "Apply crop" bakes exactly what's
   visible inside that frame into a new image (real pixels, not a
   transform), which becomes state.websiteWallpaper.image.
   ========================================================================== */
let wallpaperCropDraft = null;   // { sourceImage, naturalW, naturalH, frameW, frameH, scale, minScale, maxScale, offsetX, offsetY }
let wallpaperCropPointers = null; // { pointers: Map<id,{x,y}>, mode: 'pan'|'pinch', ... }

function wallpaperCropperEls(){
  return {
    overlay: document.getElementById('wallpaperCropperOverlay'),
    viewport: document.getElementById('wallpaperCropperViewport'),
    img: document.getElementById('wallpaperCropperImg'),
    frame: document.getElementById('wallpaperCropperFrame'),
    controls: document.getElementById('wallpaperCropperControls'),
    zoom: document.getElementById('wallpaperCropperZoom'),
    actions: document.getElementById('wallpaperCropperActions'),
    normalControls: document.getElementById('wallpaperNormalControls'),
    editCropBtn: document.getElementById('wallpaperEditCropBtn'),
  };
}

function getWallpaperViewportAspect(){
  const w = window.innerWidth || 16;
  const h = window.innerHeight || 9;
  return w / h;
}

/* Sizes/positions the cropper viewport + frame box to fill the preview
   card while matching the current window's aspect ratio (the frame
   represents "how big the viewport is"). Returns the box rect in
   preview-card-local coordinates, or null if the DOM isn't ready. */
function layoutWallpaperCropperFrame(){
  const { viewport, frame } = wallpaperCropperEls();
  const container = document.querySelector('.wallpaper-preview-frame');
  if(!container || !viewport || !frame) return null;

  const containerW = container.clientWidth || 1;
  const containerH = container.clientHeight || 1;
  const aspect = getWallpaperViewportAspect();

  let boxW = containerW;
  let boxH = boxW / aspect;
  if(boxH > containerH){
    boxH = containerH;
    boxW = boxH * aspect;
  }
  const left = Math.round((containerW - boxW) / 2);
  const top = Math.round((containerH - boxH) / 2);
  boxW = Math.round(boxW);
  boxH = Math.round(boxH);

  [viewport, frame].forEach((el) => {
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.width = `${boxW}px`;
    el.style.height = `${boxH}px`;
  });

  return { width: boxW, height: boxH, left, top };
}

function clampWallpaperCropOffsets(draft){
  const minX = draft.frameW - draft.naturalW * draft.scale;
  const minY = draft.frameH - draft.naturalH * draft.scale;
  draft.offsetX = Math.min(0, Math.max(minX, draft.offsetX));
  draft.offsetY = Math.min(0, Math.max(minY, draft.offsetY));
}

function renderWallpaperCropTransform(){
  if(!wallpaperCropDraft) return;
  clampWallpaperCropOffsets(wallpaperCropDraft);
  const { img, zoom } = wallpaperCropperEls();
  const draft = wallpaperCropDraft;
  if(img){
    img.style.width = `${draft.naturalW * draft.scale}px`;
    img.style.height = `${draft.naturalH * draft.scale}px`;
    img.style.left = `${draft.offsetX}px`;
    img.style.top = `${draft.offsetY}px`;
  }
  if(zoom){
    const span = draft.maxScale - draft.minScale;
    const pct = span > 0 ? ((draft.scale - draft.minScale) / span) * 100 : 0;
    zoom.value = String(Math.round(Math.max(0, Math.min(100, pct))));
  }
}

/* Zooms while keeping the image point under (anchorX, anchorY) — in
   frame-local coordinates — visually stationary, like pinch/scroll zoom
   in a photo app. */
function setWallpaperCropZoom(newScale, anchorX, anchorY){
  if(!wallpaperCropDraft) return;
  const draft = wallpaperCropDraft;
  const clamped = Math.min(draft.maxScale, Math.max(draft.minScale, newScale));
  if(clamped === draft.scale) return;
  const ratio = clamped / draft.scale;
  draft.offsetX = anchorX - (anchorX - draft.offsetX) * ratio;
  draft.offsetY = anchorY - (anchorY - draft.offsetY) * ratio;
  draft.scale = clamped;
  renderWallpaperCropTransform();
}

function openWallpaperCropper(imageSrc){
  const { overlay, img, controls, actions, normalControls } = wallpaperCropperEls();
  if(!overlay || !img){
    toast('Wallpaper cropper UI is missing from this page.');
    return;
  }
  const probe = new Image();
  probe.onload = () => {
    const rect = layoutWallpaperCropperFrame();
    if(!rect) return;
    const naturalW = probe.naturalWidth || probe.width || 1;
    const naturalH = probe.naturalHeight || probe.height || 1;
    const minScale = Math.max(rect.width / naturalW, rect.height / naturalH);
    const scale = minScale;
    wallpaperCropDraft = {
      sourceImage: probe,
      naturalW, naturalH,
      frameW: rect.width, frameH: rect.height,
      scale, minScale, maxScale: minScale * 4,
      offsetX: (rect.width - naturalW * scale) / 2,
      offsetY: (rect.height - naturalH * scale) / 2,
    };
    img.src = imageSrc;
    renderWallpaperCropTransform();
    overlay.hidden = false;
    if(controls) controls.hidden = false;
    if(actions) actions.hidden = false;
    if(normalControls) normalControls.hidden = true;
  };
  probe.onerror = () => toast('Could not load that image');
  probe.src = imageSrc;
}

function closeWallpaperCropper(){
  const { overlay, controls, actions, normalControls } = wallpaperCropperEls();
  if(overlay) overlay.hidden = true;
  if(controls) controls.hidden = true;
  if(actions) actions.hidden = true;
  if(normalControls) normalControls.hidden = false;
  wallpaperCropDraft = null;
  wallpaperCropPointers = null;
}

/* Reads exactly the region of the source image currently visible inside
   the frame and draws it 1:1 into an output canvas — the crop is baked
   into real pixels, not stored as a transform. */
function bakeWallpaperCrop(){
  const draft = wallpaperCropDraft;
  if(!draft) return null;
  const sx = -draft.offsetX / draft.scale;
  const sy = -draft.offsetY / draft.scale;
  const sw = draft.frameW / draft.scale;
  const sh = draft.frameH / draft.scale;

  const targetW = Math.min(1920, Math.max(320, Math.round(sw)));
  const targetH = Math.max(1, Math.round(targetW * (draft.frameH / draft.frameW)));

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(draft.sourceImage, sx, sy, sw, sh, 0, 0, targetW, targetH);
  return canvas.toDataURL('image/jpeg', 0.92);
}

function bindWallpaperCropperInteractions(){
  const { viewport } = wallpaperCropperEls();
  if(!viewport || viewport.dataset.cropperBound) return;
  viewport.dataset.cropperBound = '1';

  const pointerPos = (e) => {
    const rect = viewport.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  viewport.addEventListener('pointerdown', (e) => {
    if(!wallpaperCropDraft) return;
    viewport.setPointerCapture(e.pointerId);
    if(!wallpaperCropPointers) wallpaperCropPointers = { pointers: new Map() };
    wallpaperCropPointers.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if(wallpaperCropPointers.pointers.size === 1){
      wallpaperCropPointers.mode = 'pan';
      wallpaperCropPointers.startOffsetX = wallpaperCropDraft.offsetX;
      wallpaperCropPointers.startOffsetY = wallpaperCropDraft.offsetY;
      wallpaperCropPointers.startClientX = e.clientX;
      wallpaperCropPointers.startClientY = e.clientY;
      viewport.classList.add('dragging');
    } else if(wallpaperCropPointers.pointers.size === 2){
      wallpaperCropPointers.mode = 'pinch';
      const pts = [...wallpaperCropPointers.pointers.values()];
      wallpaperCropPointers.startDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      wallpaperCropPointers.startScale = wallpaperCropDraft.scale;
    }
  });

  viewport.addEventListener('pointermove', (e) => {
    if(!wallpaperCropDraft || !wallpaperCropPointers || !wallpaperCropPointers.pointers.has(e.pointerId)) return;
    wallpaperCropPointers.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if(wallpaperCropPointers.mode === 'pan' && wallpaperCropPointers.pointers.size === 1){
      const dx = e.clientX - wallpaperCropPointers.startClientX;
      const dy = e.clientY - wallpaperCropPointers.startClientY;
      wallpaperCropDraft.offsetX = wallpaperCropPointers.startOffsetX + dx;
      wallpaperCropDraft.offsetY = wallpaperCropPointers.startOffsetY + dy;
      renderWallpaperCropTransform();
    } else if(wallpaperCropPointers.mode === 'pinch' && wallpaperCropPointers.pointers.size === 2){
      const pts = [...wallpaperCropPointers.pointers.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      const mid = pointerPos({ clientX: (pts[0].x + pts[1].x) / 2, clientY: (pts[0].y + pts[1].y) / 2 });
      const newScale = wallpaperCropPointers.startScale * (dist / wallpaperCropPointers.startDist);
      setWallpaperCropZoom(newScale, mid.x, mid.y);
    }
  });

  const endPointer = (e) => {
    if(!wallpaperCropPointers) return;
    wallpaperCropPointers.pointers.delete(e.pointerId);
    if(wallpaperCropPointers.pointers.size === 0){
      wallpaperCropPointers = null;
      viewport.classList.remove('dragging');
    } else if(wallpaperCropPointers.pointers.size === 1 && wallpaperCropDraft){
      const [[, remaining]] = [...wallpaperCropPointers.pointers.entries()];
      wallpaperCropPointers.mode = 'pan';
      wallpaperCropPointers.startOffsetX = wallpaperCropDraft.offsetX;
      wallpaperCropPointers.startOffsetY = wallpaperCropDraft.offsetY;
      wallpaperCropPointers.startClientX = remaining.x;
      wallpaperCropPointers.startClientY = remaining.y;
    }
  };
  viewport.addEventListener('pointerup', endPointer);
  viewport.addEventListener('pointercancel', endPointer);
  viewport.addEventListener('pointerleave', (e) => { if(e.buttons === 0) endPointer(e); });

  viewport.addEventListener('wheel', (e) => {
    if(!wallpaperCropDraft) return;
    e.preventDefault();
    const pos = pointerPos(e);
    const factor = Math.exp(-e.deltaY * 0.0015);
    setWallpaperCropZoom(wallpaperCropDraft.scale * factor, pos.x, pos.y);
  }, { passive: false });

  const zoomSlider = document.getElementById('wallpaperCropperZoom');
  if(zoomSlider){
    zoomSlider.addEventListener('input', () => {
      if(!wallpaperCropDraft) return;
      const draft = wallpaperCropDraft;
      const pct = Number(zoomSlider.value) / 100;
      const newScale = draft.minScale + pct * (draft.maxScale - draft.minScale);
      setWallpaperCropZoom(newScale, draft.frameW / 2, draft.frameH / 2);
    });
  }

  window.addEventListener('resize', () => {
    if(!wallpaperCropDraft) return;
    const rect = layoutWallpaperCropperFrame();
    if(!rect) return;
    const draft = wallpaperCropDraft;
    const newMinScale = Math.max(rect.width / draft.naturalW, rect.height / draft.naturalH);
    // Preserve how far zoomed-in the person was, relative to "fit", across the resize.
    const zoomRatio = draft.scale / draft.minScale;
    draft.frameW = rect.width;
    draft.frameH = rect.height;
    draft.minScale = newMinScale;
    draft.maxScale = newMinScale * 4;
    draft.scale = Math.min(draft.maxScale, Math.max(draft.minScale, newMinScale * zoomRatio));
    renderWallpaperCropTransform();
  });
}

async function renderWebsiteWallpaper(){
  const wallpaperEl = document.getElementById('websiteWallpaper');
  const previewEl = document.getElementById('wallpaperPreview');
  const componentSelect = document.getElementById('websiteWallpaperComponentSelect');
  const effectSelect = document.getElementById('websiteWallpaperEffectSelect');
  if(!wallpaperEl) return;

  const liveComponentEffect = componentSelect && ['opaque', 'frosted', 'bw'].includes(componentSelect.value)
    ? componentSelect.value
    : (state.websiteWallpaper && ['opaque', 'frosted', 'bw'].includes(state.websiteWallpaper.componentEffect)
      ? state.websiteWallpaper.componentEffect
      : 'opaque');
  const liveEffect = effectSelect && ['clear', 'frosted', 'blur', 'bw'].includes(effectSelect.value)
    ? effectSelect.value
    : (state.websiteWallpaper && ['clear', 'frosted', 'blur', 'bw'].includes(state.websiteWallpaper.effect)
      ? state.websiteWallpaper.effect
      : 'clear');

  document.body.dataset.wallpaperComponentTone = liveComponentEffect;
  if(componentSelect) componentSelect.value = liveComponentEffect;

  if(!state.websiteWallpaper || !state.websiteWallpaper.image){
    wallpaperEl.style.backgroundImage = 'none';
    wallpaperEl.style.opacity = '0';
    wallpaperEl.style.filter = 'none';
    wallpaperEl.style.backgroundSize = 'cover';
    wallpaperEl.style.backgroundPosition = 'center center';
    if(previewEl) previewEl.style.backgroundImage = 'none';
    if(previewEl) previewEl.style.filter = 'none';
    if(previewEl) previewEl.style.backgroundSize = 'cover';
    if(previewEl) previewEl.style.backgroundPosition = 'center center';
    return;
  }

  const scale = clampWallpaperNumber(state.websiteWallpaper.scale, 60, 180, 100);
  const positionX = clampWallpaperNumber(state.websiteWallpaper.positionX, 0, 100, 50);
  const positionY = clampWallpaperNumber(state.websiteWallpaper.positionY, 0, 100, 50);
  const opacity = Math.max(0, Math.min(1, (state.websiteWallpaper.opacity || 100) / 100));

  await applyWallpaperFrameStyle(wallpaperEl, state.websiteWallpaper.image, liveEffect, scale, positionX, positionY, opacity);
  if(previewEl) await applyWallpaperFrameStyle(previewEl, state.websiteWallpaper.image, liveEffect, scale, positionX, positionY, opacity);
}

function populateWebsiteWallpaperSourceSelect(){
  const grid = document.getElementById('websiteWallpaperSourceGrid');
  const categorySelect = document.getElementById('websiteWallpaperCategorySelect');
  if(!grid || !categorySelect) return;

  const sources = [...(state.rawImages || []), ...(state.snapshots || [])].filter((item) => item && item.type === 'image');
  const categories = new Set();
  sources.forEach((item) => {
    const key = item.path || item.id || item.name || item.videoPath || item.videoName;
    if(!key) return;
    const category = (item.category || (item.source === 'snapshot' ? 'Snapshots' : 'Uncategorized')).trim();
    if(category) categories.add(category);
  });

  const categoryList = [...categories].sort((a, b) => a.localeCompare(b));
  const currentCategory = categorySelect.value || categoryList[0] || 'Uncategorized';
  categorySelect.innerHTML = categoryList.map((cat) => `<option value="${escapeHtml(cat)}">${escapeHtml(cat)}</option>`).join('');
  if(categoryList.includes(currentCategory)) categorySelect.value = currentCategory;
  else if(categoryList.length) categorySelect.value = categoryList[0];

  const filtered = sources.filter((item) => {
    const category = (item.category || (item.source === 'snapshot' ? 'Snapshots' : 'Uncategorized')).trim();
    return category === categorySelect.value;
  });

  const seen = new Set();
  grid.innerHTML = filtered.map((item) => {
    const key = item.path || item.id || item.name || item.videoPath || item.videoName;
    if(!key || seen.has(key)) return '';
    seen.add(key);
    const category = (item.category || (item.source === 'snapshot' ? 'Snapshots' : 'Uncategorized')).trim();
    const label = (item.name || item.videoName || item.path || 'Library image').trim();
    const previewSrc = item.file ? URL.createObjectURL(item.file) : (item.blob ? URL.createObjectURL(item.blob) : null);
    return `
      <button class="wallpaper-source-card" type="button" data-wallpaper-key="${escapeHtml(key)}" data-wallpaper-preview="${previewSrc ? escapeHtml(previewSrc) : ''}">
        <div class="wallpaper-source-thumb" style="background-image:${previewSrc ? `url(${previewSrc})` : 'none'}"></div>
        <div class="wallpaper-source-meta">
          <div class="wallpaper-source-name">${escapeHtml(label)}</div>
          <div class="wallpaper-source-category">${escapeHtml(category)}</div>
        </div>
      </button>
    `;
  }).join('');

  grid.querySelectorAll('.wallpaper-source-card').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const sourceKey = btn.dataset.wallpaperKey;
      grid.querySelectorAll('.wallpaper-source-card').forEach((other) => other.classList.toggle('active', other === btn));
      await openWallpaperCropperFromSource(sourceKey);
    });
  });
}

/* Resolves a library item (by the key stashed on its grid card) to a
   full-resolution data URL and opens the cropper on it. Nothing is
   written to state.websiteWallpaper until the person confirms the crop. */
async function openWallpaperCropperFromSource(sourceKey){
  const source = [...(state.rawImages || []), ...(state.snapshots || [])].find((item) => {
    const key = item.path || item.id || item.name || item.videoPath || item.videoName;
    return key === sourceKey;
  });
  if(!source) return;
  const blob = source.file || source.blob;
  if(!blob) return;
  const dataURL = await blobToDataURL(blob);
  openWallpaperCropper(dataURL);
}

async function exportLibraryData(){
  const snapshotsPayload = (await Promise.all((state.snapshots || []).map(async (s) => {
    let data = null;
    try{ if(s.blob) data = await blobToDataURL(s.blob); }catch(e){ /* skip unreadable snapshot */ }
    return data ? { videoName: s.videoName, videoPath: s.videoPath || null, timestamp: s.timestamp, savedAt: s.savedAt, data } : null;
  }))).filter(Boolean);

  const payload = {
    version: 2,
    favorites: [...state.favorites],
    watchLater: [...state.watchLater],
    watchLaterConsumed: [...state.watchLaterConsumed],
    categoryFavorites: [...state.categoryFavorites],
    history: state.history,
    watchProgress: state.watchProgress,
    chapters: state.chapters,
    snapshots: snapshotsPayload,
    nsfwResults: state.nsfwResults,
    nsfwScanOnStartup: state.nsfwScanOnStartup,
    nsfwBlurEnabled: state.nsfwBlurEnabled,
    nsfwBlurMethod: state.nsfwBlurMethod,
    websiteWallpaper: state.websiteWallpaper,
    exportedAt: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'reelframe-library.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast('Library backup exported');
}
/* replace with */
function unionSet(existing, incoming){
  const merged = new Set(existing);
  incoming.forEach(v => merged.add(v));
  return merged;
}

/* Adds any imported history entries not already present (matched by
   type:path), keeps existing entries untouched, then re-sorts by recency. */
function mergeHistoryArrays(existing, incoming){
  const seen = new Set(existing.map(h => `${h.type}:${h.path}`));
  const merged = existing.slice();
  incoming.forEach(h => {
    const key = `${h.type}:${h.path}`;
    if(!seen.has(key)){ seen.add(key); merged.push(h); }
  });
  merged.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return merged.slice(0, HISTORY_MAX);
}

/* "Add if it doesn't exist" for plain key -> value objects (watchProgress,
   chapters): never overwrites a key the person already has locally. */
function mergeObjectAddOnly(existing, incoming){
  const merged = { ...existing };
  Object.keys(incoming).forEach(key => {
    if(!(key in merged)) merged[key] = incoming[key];
  });
  return merged;
}

function clearAllSnapshots(){
  return new Promise((resolve, reject) => {
    initIDBSnapshots().then(db => {
      const tx = db.transaction([SNAPSHOTS_STORE], 'readwrite');
      const req = tx.objectStore(SNAPSHOTS_STORE).clear();
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve();
    }).catch(reject);
  });
}

/* Resolves to 'replace', 'add', or null (cancelled/closed). */
function openImportChoiceModal(){
  return new Promise((resolve) => {
    const backdrop = document.getElementById('importChoiceModalBackdrop');
    if(!backdrop){ resolve(null); return; }
    const replaceBtn = document.getElementById('importChoiceReplaceBtn');
    const addBtn = document.getElementById('importChoiceAddBtn');
    const cancelBtn = document.getElementById('importChoiceCancelBtn');
    const closeBtn = document.getElementById('importChoiceModalClose');

    const cleanup = (choice) => {
      backdrop.hidden = true;
      replaceBtn.removeEventListener('click', onReplace);
      addBtn.removeEventListener('click', onAdd);
      cancelBtn.removeEventListener('click', onCancel);
      closeBtn.removeEventListener('click', onCancel);
      backdrop.removeEventListener('click', onBackdropClick);
      resolve(choice);
    };
    const onReplace = () => cleanup('replace');
    const onAdd = () => cleanup('add');
    const onCancel = () => cleanup(null);
    const onBackdropClick = (e) => { if(e.target === backdrop) cleanup(null); };

    replaceBtn.addEventListener('click', onReplace);
    addBtn.addEventListener('click', onAdd);
    cancelBtn.addEventListener('click', onCancel);
    closeBtn.addEventListener('click', onCancel);
    backdrop.addEventListener('click', onBackdropClick);
    backdrop.hidden = false;
  });
}

async function importLibraryData(file){
  if(!file) return;
  let parsed;
  try{
    const text = await file.text();
    parsed = JSON.parse(text);
  }catch(e){
    console.error(e);
    toast('Could not read that backup file');
    return;
  }

  const mode = await openImportChoiceModal();
  if(!mode){ toast('Import cancelled'); return; }
  const isReplace = mode === 'replace';

  try{
    if(Array.isArray(parsed.favorites)){
      state.favorites = isReplace ? new Set(parsed.favorites) : unionSet(state.favorites, parsed.favorites);
      saveFavorites();
    }
    if(Array.isArray(parsed.watchLater)){
      state.watchLater = isReplace ? new Set(parsed.watchLater) : unionSet(state.watchLater, parsed.watchLater);
      saveWatchLater();
    }
    if(Array.isArray(parsed.watchLaterConsumed)){
      state.watchLaterConsumed = isReplace ? new Set(parsed.watchLaterConsumed) : unionSet(state.watchLaterConsumed, parsed.watchLaterConsumed);
      saveWatchLaterConsumed();
    }
    if(Array.isArray(parsed.categoryFavorites)){
      state.categoryFavorites = isReplace ? new Set(parsed.categoryFavorites) : unionSet(state.categoryFavorites, parsed.categoryFavorites);
      saveCategoryFavorites();
    }
    if(Array.isArray(parsed.history)){
      state.history = isReplace ? parsed.history.slice(0, HISTORY_MAX) : mergeHistoryArrays(state.history, parsed.history);
      saveHistory();
    }
    if(parsed.watchProgress && typeof parsed.watchProgress === 'object'){
      state.watchProgress = isReplace ? parsed.watchProgress : mergeObjectAddOnly(state.watchProgress, parsed.watchProgress);
      saveWatchProgress();
    }
    if(parsed.chapters && typeof parsed.chapters === 'object'){
      state.chapters = isReplace ? parsed.chapters : mergeObjectAddOnly(state.chapters, parsed.chapters);
      saveChapters();
    }
    if(parsed.nsfwResults && typeof parsed.nsfwResults === 'object'){
      state.nsfwResults = isReplace ? parsed.nsfwResults : mergeObjectAddOnly(state.nsfwResults, parsed.nsfwResults);
      saveNsfwResults();
    }
    if(typeof parsed.nsfwScanOnStartup === 'boolean'){
      state.nsfwScanOnStartup = parsed.nsfwScanOnStartup;
      saveNsfwScanOnStartup();
    }
    if(typeof parsed.nsfwBlurEnabled === 'boolean'){
      state.nsfwBlurEnabled = parsed.nsfwBlurEnabled;
      saveNsfwBlurEnabled();
    }
    if(['blur', 'pixelate', 'blackbox'].includes(parsed.nsfwBlurMethod)){
      state.nsfwBlurMethod = parsed.nsfwBlurMethod;
      saveNsfwBlurMethod();
    }
    if(parsed.websiteWallpaper && typeof parsed.websiteWallpaper.image === 'string'){
      state.websiteWallpaper = {
        image: parsed.websiteWallpaper.image,
        effect: ['clear', 'blur', 'frosted', 'bw'].includes(parsed.websiteWallpaper.effect) ? parsed.websiteWallpaper.effect : 'clear',
        componentEffect: ['opaque', 'frosted', 'bw'].includes(parsed.websiteWallpaper.componentEffect) ? parsed.websiteWallpaper.componentEffect : 'opaque',
        opacity: typeof parsed.websiteWallpaper.opacity === 'number' ? parsed.websiteWallpaper.opacity : 100,
        scale: typeof parsed.websiteWallpaper.scale === 'number' ? parsed.websiteWallpaper.scale : 100,
        positionX: typeof parsed.websiteWallpaper.positionX === 'number' ? parsed.websiteWallpaper.positionX : 50,
        positionY: typeof parsed.websiteWallpaper.positionY === 'number' ? parsed.websiteWallpaper.positionY : 50,
      };
      saveWebsiteWallpaper();
      renderWebsiteWallpaper();
    }
    if(Array.isArray(parsed.snapshots) && parsed.snapshots.length){
      if(isReplace) await clearAllSnapshots();
      // For "add", skip snapshots that look identical to one already saved
      // (same source video, timestamp, and export time) so re-importing the
      // same backup twice doesn't pile up duplicates.
      const existingKeys = isReplace ? new Set() : new Set(
        state.snapshots.map(s => `${s.videoName}|${s.timestamp}|${s.savedAt}`)
      );
      for(const snap of parsed.snapshots){
        if(!snap.data) continue;
        const key = `${snap.videoName}|${snap.timestamp}|${snap.savedAt}`;
        if(!isReplace && existingKeys.has(key)) continue;
        try{
          const blob = await (await fetch(snap.data)).blob();
          await saveSnapshot(blob, snap.videoName || 'Imported snapshot', snap.timestamp || 0, snap.videoPath || null);
        }catch(e){ console.error('Failed to import a snapshot', e); }
      }
      await loadSnapshots();
      updateTotalCount();
      if(state.tab === 'images') renderActiveGrid();
    }
    updateWatchLaterButtons();
    updateFavCount();
    renderSidebar();
    renderActiveGrid();
    updateNsfwScanUI();
    toast(isReplace ? 'Library backup imported (replaced)' : 'Library backup imported (added)');
  }catch(e){
    console.error(e);
    toast('Could not import that backup file');
  }
}

/* ---------- Duplicate detection — content-hashed, not name/size guessing ---------- */
const DUPLICATE_HASH_SAMPLE_BYTES = 262144; // 256KB from each end

async function fileFingerprint(item){
  const file = item.file;
  if(!file || !file.size) return null;
  try{
    const size = file.size;
    const sampleSize = Math.min(DUPLICATE_HASH_SAMPLE_BYTES, size);
    const headBuf = await file.slice(0, sampleSize).arrayBuffer();
    const tailBuf = size > sampleSize ? await file.slice(size - sampleSize, size).arrayBuffer() : new ArrayBuffer(0);
    const combined = new Uint8Array(headBuf.byteLength + tailBuf.byteLength + 8);
    combined.set(new Uint8Array(headBuf), 0);
    combined.set(new Uint8Array(tailBuf), headBuf.byteLength);
    new DataView(combined.buffer, headBuf.byteLength + tailBuf.byteLength, 8).setBigUint64(0, BigInt(size));
    const digest = await crypto.subtle.digest('SHA-256', combined);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  }catch(e){
    return null;
  }
}

async function collectDuplicateGroups(items){
  const withHash = await Promise.all(items.map(async item => ({ item, hash: await fileFingerprint(item) })));
  const groups = new Map();
  withHash.forEach(({ item, hash }) => {
    const key = hash || `fallback::${(item.name||'').trim().toLowerCase()}::${item.size||0}`;
    if(!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });
  return [...groups.values()].filter(group => group.length > 1);
}

async function renderDuplicateModal(){
  const backdrop = document.getElementById('duplicatesModalBackdrop');
  const listEl = document.getElementById('duplicatesModalList');
  listEl.innerHTML = '<div class="modal-empty">Scanning files for duplicates…</div>';
  backdrop.hidden = false;

  const groups = [
    ...(await collectDuplicateGroups(state.videos)),
    ...(await collectDuplicateGroups(state.images)),
    ...(await collectDuplicateGroups(state.audio)),
  ];

  if(groups.length === 0){
    listEl.innerHTML = '<div class="modal-empty">No duplicates were found.</div>';
    return;
  }
  listEl.innerHTML = groups.map(group => {
    const sample = group[0];
    const label = `${sample.type === 'image' ? 'Photo' : sample.type === 'audio' ? 'Music' : 'Video'} · ${formatBytes(sample.size || 0)} · identical content`;
    return `
      <div class="folder-row" style="display:block; padding:10px 12px; border:1px solid var(--border-soft); border-radius:10px; margin-bottom:8px;">
        <div style="font-weight:600; margin-bottom:6px;">${escapeHtml(group[0].name)}</div>
        <div style="font-size:12px; color:var(--text-faint); margin-bottom:6px;">${escapeHtml(label)} · ${group.length} items</div>
        <div style="display:flex; flex-direction:column; gap:4px;">
          ${group.map(item => `<div style="font-size:12px; color:var(--text-dim);">• ${escapeHtml(item.category)} / ${escapeHtml(item.path)}</div>`).join('')}
        </div>
      </div>
    `;
  }).join('');
}

function closeMobileShell(){
  const sidebar = document.querySelector('.sidebar');
  const backdrop = document.getElementById('mobileSidebarBackdrop');
  const menu = document.getElementById('mobileActionsMenu');
  const menuBtn = document.getElementById('mobileMenuBtn');
  if(sidebar) sidebar.classList.remove('open');
  if(backdrop) backdrop.hidden = true;
  if(menu) menu.hidden = true;
  if(menuBtn) menuBtn.setAttribute('aria-expanded', 'false');
  document.body.classList.remove('mobile-sidebar-open');
}

function bindMobileShell(){
  const sidebar = document.querySelector('.sidebar');
  const backdrop = document.getElementById('mobileSidebarBackdrop');
  const toggleBtn = document.getElementById('mobileSidebarToggleBtn');
  const menuBtn = document.getElementById('mobileMenuBtn');
  const menu = document.getElementById('mobileActionsMenu');
  const mobileNavSelect = document.getElementById('mobileNavSelect');
  const mobileFoldersBtn = document.getElementById('mobileFoldersBtn');
  const mobileSettingsBtn = document.getElementById('mobileSettingsBtn');
  const mobileChangeDirBtn = document.getElementById('mobileChangeDirBtn');
  if(!sidebar || !backdrop || !toggleBtn || !menuBtn || !menu) return;

  toggleBtn.addEventListener('click', () => {
    const open = !sidebar.classList.contains('open');
    sidebar.classList.toggle('open', open);
    document.body.classList.toggle('mobile-sidebar-open', open);
    backdrop.hidden = !open;
    if(!open) menu.hidden = true;
  });

  backdrop.addEventListener('click', closeMobileShell);

  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open;
    menuBtn.setAttribute('aria-expanded', String(open));
    backdrop.hidden = !open;
    if(open){
      sidebar.classList.remove('open');
      document.body.classList.remove('mobile-sidebar-open');
    }
  });

  document.addEventListener('click', (e) => {
    if(!menu.contains(e.target) && e.target !== menuBtn && !menuBtn.contains(e.target)) {
      menu.hidden = true;
      menuBtn.setAttribute('aria-expanded', 'false');
    }
  });

  mobileNavSelect.addEventListener('change', () => {
    const tab = mobileNavSelect.value;
    if(tab === state.tab) return;
    syncCategoryAcrossTab(state.tab, tab); // NEW
    setTab(tab, { skipRender:true });
    switchViewsForTab();
    clearUrlParams();
    scrollMainTop();
    renderActiveGrid();
  });

  mobileFoldersBtn.addEventListener('click', () => {
    closeMobileShell();
    document.getElementById('manageFoldersBtn').click();
  });
  mobileSettingsBtn.addEventListener('click', () => {
    closeMobileShell();
    document.getElementById('settingsBtn').click();
  });
  mobileChangeDirBtn.addEventListener('click', () => {
    closeMobileShell();
    document.getElementById('changeDirBtn').click();
  });

  window.addEventListener('resize', () => {
    if(window.innerWidth > 860) closeMobileShell();
  });
}

function bindSettingsModal(){
  const backdrop = document.getElementById('settingsModalBackdrop');
  const openBtn = document.getElementById('settingsBtn');
  const closeBtn = document.getElementById('settingsModalClose');
  const algoToggle = document.getElementById('algoToggle');
  const lockToggle = document.getElementById('lockToggle');
  const lockPasswordInput = document.getElementById('lockPasswordInput');
  const lockPasswordConfirmInput = document.getElementById('lockPasswordConfirmInput');
  const setLockPasswordBtn = document.getElementById('setLockPasswordBtn');
  const lockBlurDelayInput = document.getElementById('lockBlurDelayInput');
  const lockTimeoutInput = document.getElementById('lockTimeoutInput');
  const exportBtn = document.getElementById('exportDataBtn');
  const importBtn = document.getElementById('importDataBtn');
  const openWebsiteWallpaperBtn = document.getElementById('openWebsiteWallpaperBtn');
  const wallpaperModalBackdrop = document.getElementById('websiteWallpaperModalBackdrop');
  const wallpaperModalClose = document.getElementById('websiteWallpaperModalClose');
  const websiteWallpaperUpload = document.getElementById('websiteWallpaperUpload');
  const websiteWallpaperCategorySelect = document.getElementById('websiteWallpaperCategorySelect');
  const websiteWallpaperEffectSelect = document.getElementById('websiteWallpaperEffectSelect');
  const websiteWallpaperComponentSelect = document.getElementById('websiteWallpaperComponentSelect');
  const websiteWallpaperOpacity = document.getElementById('websiteWallpaperOpacity');
  const websiteWallpaperOpacityText = document.getElementById('websiteWallpaperOpacityText');
  const websiteWallpaperApplyBtn = document.getElementById('websiteWallpaperApplyBtn');
  const websiteWallpaperClearBtn = document.getElementById('websiteWallpaperClearBtn');
  const websiteWallpaperClearBtnTop = document.getElementById('websiteWallpaperClearBtnTop');
  const wallpaperEditCropBtn = document.getElementById('wallpaperEditCropBtn');
  const wallpaperCropperCancelBtn = document.getElementById('wallpaperCropperCancelBtn');
  const wallpaperCropperConfirmBtn = document.getElementById('wallpaperCropperConfirmBtn');
  const findDuplicatesBtn = document.getElementById('findDuplicatesBtn');
  const duplicateBackdrop = document.getElementById('duplicatesModalBackdrop');
  const duplicateClose = document.getElementById('duplicatesModalClose');
  const discoverToggle = document.getElementById('discoverToggle');
  const realMiniPlayerToggle = document.getElementById('realMiniPlayerToggle');
  const installBtn = document.getElementById('installAppBtn');
  const miniPlayerEnabledToggle = document.getElementById('miniPlayerEnabledToggle');
  const nsfwScanBtn = document.getElementById('nsfwScanBtn');
  const nsfwScanStartupToggle = document.getElementById('nsfwScanStartupToggle');
  const nsfwBlurToggle = document.getElementById('nsfwBlurToggle');
  const nsfwBlurMethodSelect = document.getElementById('nsfwBlurMethodSelect');
  const nsfwRegionScanBtn = document.getElementById('nsfwRegionScanBtn');
  const nsfwRegionPauseBtn = document.getElementById('nsfwRegionPauseBtn');
  const redeemCodeInput = document.getElementById('redeemCodeInput');
  const redeemCodeBtn = document.getElementById('redeemCodeBtn');

  function refreshNsfwFeatureUI(){
    if(nsfwScanStartupToggle) nsfwScanStartupToggle.disabled = !state.nsfwFeatureUnlocked;
    if(nsfwBlurToggle) nsfwBlurToggle.disabled = !state.nsfwFeatureUnlocked;
    if(nsfwBlurMethodSelect) nsfwBlurMethodSelect.disabled = !state.nsfwFeatureUnlocked;
    if(nsfwRegionScanBtn) nsfwRegionScanBtn.disabled = !state.nsfwFeatureUnlocked;
    if(nsfwRegionPauseBtn) nsfwRegionPauseBtn.disabled = !state.nsfwFeatureUnlocked;
    updateNsfwScanUI();
    updateNsfwRegionScanUI();
  }
  renderWebsiteWallpaper();
  refreshNsfwFeatureUI();

  if(redeemCodeBtn){
    redeemCodeBtn.addEventListener('click', () => {
      const code = (redeemCodeInput.value || '').trim();
      if(!code){ toast('Enter a code first.'); return; }
      if(code.toUpperCase() === NSFW_REDEEM_CODE){
        state.nsfwFeatureUnlocked = true;
        saveNsfwUnlocked();
        refreshNsfwFeatureUI();
        toast('Code redeemed — NSFW detection unlocked (beta).');
      } else {
        toast('That code is not valid.');
      }
      redeemCodeInput.value = '';
    });
    redeemCodeInput.addEventListener('keydown', (e) => { if(e.key === 'Enter') redeemCodeBtn.click(); });
  }
  if(nsfwScanBtn){
    nsfwScanBtn.addEventListener('click', () => {
      if(!state.nsfwFeatureUnlocked){ toast('Redeem a code to unlock NSFW detection first.'); return; }
      if(nsfwScanState.running) cancelNsfwScan();
      else scanLibraryForNsfw({ force: true });
    });
  }
  if(nsfwScanStartupToggle){
    nsfwScanStartupToggle.addEventListener('change', () => {
      state.nsfwScanOnStartup = nsfwScanStartupToggle.checked;
      saveNsfwScanOnStartup();
      toast(state.nsfwScanOnStartup ? 'Will scan for NSFW content on startup' : 'Startup scan turned off — use the button here instead');
    });
  }
  if(nsfwBlurToggle){
    nsfwBlurToggle.addEventListener('change', () => {
      state.nsfwBlurEnabled = nsfwBlurToggle.checked;
      saveNsfwBlurEnabled();
      refreshNsfwVisuals();
      toast(state.nsfwBlurEnabled ? 'Flagged photos will be blurred and tagged' : 'Flagged photos will show normally');
    });
  }
  if(nsfwBlurMethodSelect){
    nsfwBlurMethodSelect.addEventListener('change', () => {
      const method = ['blur', 'pixelate', 'blackbox'].includes(nsfwBlurMethodSelect.value) ? nsfwBlurMethodSelect.value : 'pixelate';
      state.nsfwBlurMethod = method;
      saveNsfwBlurMethod();
      refreshNsfwVisuals();
      toast(`Focus blur method set to ${nsfwBlurMethodSelect.options[nsfwBlurMethodSelect.selectedIndex].text}`);
    });
  }
  bindWallpaperCropperInteractions();

  function refreshWallpaperEditCropBtn(){
    if(wallpaperEditCropBtn) wallpaperEditCropBtn.hidden = !(state.websiteWallpaper && state.websiteWallpaper.image);
  }

  if(openWebsiteWallpaperBtn && wallpaperModalBackdrop){
    openWebsiteWallpaperBtn.addEventListener('click', () => {
      closeWallpaperCropper(); // ensure a fresh, non-cropping state every time the modal opens
      populateWebsiteWallpaperSourceSelect();
      const previewEl = document.getElementById('wallpaperPreview');
      if(previewEl) previewEl.style.backgroundImage = state.websiteWallpaper && state.websiteWallpaper.image ? `url(${state.websiteWallpaper.image})` : 'none';
      if(websiteWallpaperEffectSelect && state.websiteWallpaper) websiteWallpaperEffectSelect.value = state.websiteWallpaper.effect || 'clear';
      if(websiteWallpaperComponentSelect && state.websiteWallpaper) websiteWallpaperComponentSelect.value = state.websiteWallpaper.componentEffect || 'opaque';
      if(websiteWallpaperOpacity && state.websiteWallpaper) websiteWallpaperOpacity.value = String(state.websiteWallpaper.opacity || 100);
      if(websiteWallpaperOpacityText) websiteWallpaperOpacityText.textContent = `${websiteWallpaperOpacity.value}%`;
      refreshWallpaperEditCropBtn();
      renderWebsiteWallpaper();
      wallpaperModalBackdrop.hidden = false;
    });
  }
  if(wallpaperModalClose && wallpaperModalBackdrop){
    wallpaperModalClose.addEventListener('click', () => { closeWallpaperCropper(); wallpaperModalBackdrop.hidden = true; });
  }
  if(wallpaperModalBackdrop){
    wallpaperModalBackdrop.addEventListener('click', (e) => {
      if(e.target === wallpaperModalBackdrop){ closeWallpaperCropper(); wallpaperModalBackdrop.hidden = true; }
    });
  }
  if(websiteWallpaperOpacity){
    websiteWallpaperOpacity.addEventListener('input', () => {
      if(websiteWallpaperOpacityText) websiteWallpaperOpacityText.textContent = `${websiteWallpaperOpacity.value}%`;
      const previewEl = document.getElementById('wallpaperPreview');
      if(previewEl) previewEl.style.opacity = String(Math.max(0, Math.min(1, Number(websiteWallpaperOpacity.value) / 100)));
    });
  }
  if(wallpaperCropperCancelBtn){
    wallpaperCropperCancelBtn.addEventListener('click', () => {
      closeWallpaperCropper();
      renderWebsiteWallpaper(); // restore the preview to whatever's currently applied
    });
  }
  if(wallpaperCropperConfirmBtn){
    wallpaperCropperConfirmBtn.addEventListener('click', () => {
      const baked = bakeWallpaperCrop();
      if(!baked){ toast('Nothing to crop yet'); return; }
      state.websiteWallpaper = {
        image: baked,
        effect: websiteWallpaperEffectSelect ? websiteWallpaperEffectSelect.value : 'clear',
        componentEffect: websiteWallpaperComponentSelect ? websiteWallpaperComponentSelect.value : 'opaque',
        opacity: websiteWallpaperOpacity ? Number(websiteWallpaperOpacity.value) : 100,
        scale: 100,
        positionX: 50,
        positionY: 50,
      };
      saveWebsiteWallpaper();
      closeWallpaperCropper();
      renderWebsiteWallpaper();
      refreshWallpaperEditCropBtn();
      toast('Crop applied');
    });
  }
  if(wallpaperEditCropBtn){
    wallpaperEditCropBtn.addEventListener('click', () => {
      if(state.websiteWallpaper && state.websiteWallpaper.image) openWallpaperCropper(state.websiteWallpaper.image);
    });
  }
  if(websiteWallpaperCategorySelect){
    websiteWallpaperCategorySelect.addEventListener('change', () => {
      populateWebsiteWallpaperSourceSelect();
    });
  }
  if(websiteWallpaperEffectSelect){
    websiteWallpaperEffectSelect.addEventListener('change', () => {
      if(state.websiteWallpaper){
        state.websiteWallpaper.effect = websiteWallpaperEffectSelect.value;
      }
      const previewEl = document.getElementById('wallpaperPreview');
      if(previewEl) previewEl.style.filter = getWallpaperEffectFilter(websiteWallpaperEffectSelect.value);
      renderWebsiteWallpaper();
    });
  }
  if(websiteWallpaperComponentSelect){
    websiteWallpaperComponentSelect.addEventListener('change', () => {
      if(state.websiteWallpaper){
        state.websiteWallpaper.componentEffect = websiteWallpaperComponentSelect.value;
      }
      document.body.dataset.wallpaperComponentTone = websiteWallpaperComponentSelect.value;
      renderWebsiteWallpaper();
    });
  }
  if(websiteWallpaperUpload){
    websiteWallpaperUpload.addEventListener('change', async () => {
      const file = websiteWallpaperUpload.files && websiteWallpaperUpload.files[0];
      if(!file) return;
      const dataURL = await blobToDataURL(file);
      openWallpaperCropper(dataURL);
      websiteWallpaperUpload.value = '';
    });
  }
  if(websiteWallpaperApplyBtn){
    // With the cropper handling image + framing, this button now just
    // saves effect/component/opacity changes against whatever image is
    // already applied, and closes the modal.
    websiteWallpaperApplyBtn.addEventListener('click', () => {
      if(!state.websiteWallpaper || !state.websiteWallpaper.image){
        toast('Upload or pick an image first');
        return;
      }
      state.websiteWallpaper = {
        ...state.websiteWallpaper,
        effect: websiteWallpaperEffectSelect ? websiteWallpaperEffectSelect.value : 'clear',
        componentEffect: websiteWallpaperComponentSelect ? websiteWallpaperComponentSelect.value : 'opaque',
        opacity: websiteWallpaperOpacity ? Number(websiteWallpaperOpacity.value) : 100,
      };
      saveWebsiteWallpaper();
      closeWallpaperCropper();
      renderWebsiteWallpaper();
      toast('Website background applied');
      if(wallpaperModalBackdrop) wallpaperModalBackdrop.hidden = true;
    });
  }
  if(websiteWallpaperClearBtn || websiteWallpaperClearBtnTop){
    const clearWallpaper = () => {
      state.websiteWallpaper = null;
      saveWebsiteWallpaper();
      closeWallpaperCropper();
      renderWebsiteWallpaper();
      refreshWallpaperEditCropBtn();
      toast('Website background cleared');
    };
    if(websiteWallpaperClearBtn) websiteWallpaperClearBtn.addEventListener('click', clearWallpaper);
    if(websiteWallpaperClearBtnTop) websiteWallpaperClearBtnTop.addEventListener('click', clearWallpaper);
  }

  const importInput = document.createElement('input');
  importInput.type = 'file';
  importInput.accept = '.json,application/json';
  importInput.hidden = true;
  document.body.appendChild(importInput);

  openBtn.addEventListener('click', () => {
    algoToggle.checked = state.algoEnabled;
    discoverToggle.checked = state.discoverEnabled;
    realMiniPlayerToggle.checked = state.realMiniPlayerEnabled;
    if(miniPlayerEnabledToggle) miniPlayerEnabledToggle.checked = state.miniPlayerEnabled;
    lockToggle.checked = state.lockEnabled;
    shareAutoApproveSelect.value = state.shareAutoApprove;
    lockPasswordInput.value = '';
    if(lockPasswordConfirmInput) lockPasswordConfirmInput.value = '';
    if(lockBlurDelayInput) lockBlurDelayInput.value = state.lockBlurDelaySeconds;
    if(lockTimeoutInput) lockTimeoutInput.value = state.lockTimeoutMinutes;
    if(installBtn) installBtn.hidden = !deferredInstallPrompt;
    if(nsfwScanStartupToggle) nsfwScanStartupToggle.checked = state.nsfwScanOnStartup;
    if(nsfwBlurToggle) nsfwBlurToggle.checked = state.nsfwBlurEnabled;
    if(nsfwBlurMethodSelect) nsfwBlurMethodSelect.value = state.nsfwBlurMethod || 'pixelate';
    updateNsfwScanUI();
    updateNsfwRegionScanUI();
    backdrop.hidden = false;
  });
  closeBtn.addEventListener('click', () => { backdrop.hidden = true; });
  backdrop.addEventListener('click', (e) => { if(e.target === backdrop) backdrop.hidden = true; });
  duplicateClose.addEventListener('click', () => { duplicateBackdrop.hidden = true; });
  duplicateBackdrop.addEventListener('click', (e) => { if(e.target === duplicateBackdrop) duplicateBackdrop.hidden = true; });

  discoverToggle.addEventListener('change', () => {
    state.discoverEnabled = discoverToggle.checked;
    saveDiscoverSetting();
    renderDiscoverSections();
    toast(state.discoverEnabled ? 'Continue watching / Recently added shown' : 'Continue watching / Recently added hidden');
  });

  shareAutoApproveSelect.addEventListener('change', () => {
    state.shareAutoApprove = shareAutoApproveSelect.value;
    saveShareAutoApproveSetting();
    const labels = { always:'Always auto-approving', local:'Auto-approving on local network only', internet:'Auto-approving over internet only', never:'Always asking before approving' };
    toast(labels[state.shareAutoApprove] || 'Setting saved');
  });

  realMiniPlayerToggle.addEventListener('change', () => {
    state.realMiniPlayerEnabled = realMiniPlayerToggle.checked;
    saveRealMiniPlayerSetting();
    toast(state.realMiniPlayerEnabled ? 'Real mini player enabled' : 'Using the built-in mini player');
  });

  algoToggle.addEventListener('change', () => {
    state.algoEnabled = algoToggle.checked;
    saveAlgoSetting();
    renderForYouRow();
    toast(state.algoEnabled ? 'Personalized recommendations turned on' : 'Personalized recommendations turned off');
  });

  lockToggle.addEventListener('change', () => {
    if(lockToggle.checked){
      if(!state.lockPassword){
        toast('Set a password before enabling lock.');
        lockToggle.checked = false;
        return;
      }
      state.lockEnabled = true;
      saveLockEnabled();
      toast('Screen lock enabled');
      scheduleInactivityLockReset();
    } else {
      const attempt = lockPasswordInput.value.trim();
      if(state.lockPassword && attempt !== state.lockPassword){
        toast('Enter the current password to disable locking.');
        lockToggle.checked = true;
        return;
      }
      state.lockEnabled = false;
      saveLockEnabled();
      toast('Screen lock disabled');
    }
  });

  setLockPasswordBtn.addEventListener('click', () => {
    const value = lockPasswordInput.value.trim();
    const confirmValue = lockPasswordConfirmInput ? lockPasswordConfirmInput.value.trim() : value;
    if(!value){ toast('Enter a password first.'); return; }
    if(value !== confirmValue){ toast('Passwords do not match.'); return; }
    if(state.lockPassword && state.lockPassword !== value){
      toast('Password updated. Use the new password when unlocking or disabling the lock.');
    } else {
      toast('Password saved. You can now enable lock protection.');
    }
    state.lockPassword = value;
    saveLockPassword();
    lockPasswordInput.value = '';
    if(lockPasswordConfirmInput) lockPasswordConfirmInput.value = '';
  });

  if(lockBlurDelayInput){
    lockBlurDelayInput.addEventListener('change', () => {
      const n = Math.max(0, parseInt(lockBlurDelayInput.value, 10) || 0);
      state.lockBlurDelaySeconds = n;
      lockBlurDelayInput.value = n;
      saveLockBlurDelaySeconds();
      toast('Focus-loss lock delay updated');
    });
  }
  if(lockTimeoutInput){
    lockTimeoutInput.addEventListener('change', () => {
      const n = Math.max(0, parseInt(lockTimeoutInput.value, 10) || 0);
      state.lockTimeoutMinutes = n;
      lockTimeoutInput.value = n;
      saveLockTimeoutMinutes();
      scheduleInactivityLockReset();
      toast('Inactivity auto-lock updated');
    });
  }

  if(installBtn){
    installBtn.addEventListener('click', async () => {
      if(!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      const choice = await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      installBtn.hidden = true;
      toast(choice.outcome === 'accepted' ? 'Installing Reelframe…' : 'Install dismissed');
    });
  }

  if(miniPlayerEnabledToggle){
    miniPlayerEnabledToggle.addEventListener('change', () => {
      state.miniPlayerEnabled = miniPlayerEnabledToggle.checked;
      saveMiniPlayerEnabledSetting();
      toast(state.miniPlayerEnabled ? 'Mini player enabled' : 'Mini player disabled');
    });
  }

  exportBtn.addEventListener('click', exportLibraryData);
  importBtn.addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if(file) importLibraryData(file);
    e.target.value = '';
  });
  findDuplicatesBtn.addEventListener('click', renderDuplicateModal);
}

function formatTimeForVTT(seconds){
  const ms = Math.max(0, Math.round(seconds * 1000));
  const hour = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const minute = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
  const second = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  const mill = String(ms % 1000).padStart(3, '0');
  return `${hour}:${minute}:${second}.${mill}`;
}

function attachCaptionTrack(vttText, label='Captions', opts={}){
  const { silent=false, show=true } = opts;
  const player = document.getElementById('videoPlayer');
  [...player.querySelectorAll('track')].forEach(t => t.remove());
  const blob = new Blob([vttText], { type: 'text/vtt' });
  const url = URL.createObjectURL(blob);
  const track = document.createElement('track');
  track.kind = 'captions';
  track.label = label;
  track.srclang = 'en';
  track.src = url;
  track.default = show;
  player.append(track);
  player.textTracks[0].mode = show ? 'showing' : 'hidden';
  state.captionsEnabled = show;
  updateCaptionButtons();
  if(!silent) toast('Captions loaded');
}

function updateCaptionButtons(){
  const btn = document.getElementById('captionToggleBtn');
  if(!btn) return;
  btn.classList.toggle('active', state.captionsEnabled);
  btn.textContent = state.captionsEnabled ? 'CC On' : 'CC Off';
}

function toggleCaptions(){
  const player = document.getElementById('videoPlayer');
  const track = player.textTracks?.[0];
  if(!track){
    toast('No captions loaded. Upload a VTT file or generate captions first.');
    return;
  }
  track.mode = track.mode === 'showing' ? 'hidden' : 'showing';
  state.captionsEnabled = track.mode === 'showing';
  updateCaptionButtons();
  toast(state.captionsEnabled ? 'Captions enabled' : 'Captions hidden');
}

function loadCaptionFile(file){
  if(!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    attachCaptionTrack(reader.result, file.name || 'Imported captions');
    if(state.currentVideo){
      const item = state.currentVideo;
      saveCaptionsForItem(item, reader.result).then(() => {
        // Index immediately so an imported VTT is searchable right away,
        // same as generated captions.
        state.transcripts.set(item.path, parseVttCues(reader.result));
        refreshCaptionedPaths();
      });
    }
  };
  reader.readAsText(file);
}

/* NOTE: blobToDataURL / exportLibraryData / importLibraryData are already
   defined near the top of this file (with support for snapshots, chapters,
   and watch progress). They used to be redeclared here with an older,
   incomplete version — since these were plain `function` declarations in
   the same scope, the later (this) definition silently won, clobbering the
   good one above. Removed for good. */