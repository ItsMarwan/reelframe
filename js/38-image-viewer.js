/* ==========================================================================
   Photo viewer — full-screen lightbox, rebuilt from scratch.

   • Wheel / trackpad-pinch zooms toward the cursor; two-finger pinch on touch.
   • Drag to move (mouse, pen or finger) with momentum when you let go.
   • Double-click / double-tap toggles between "fit" and a close-up.
   • Click the dark area (when not zoomed in) to close. Esc closes.
   • Keys: + / − zoom, 0 fit, 1 actual pixels, arrow keys move when zoomed.
   • The image can never be dragged out of view, and it stays centred when
     it's smaller than the screen.

   One transform (translate + scale, origin top-left) drives everything, so
   there is a single source of truth: viewer.x / viewer.y / viewer.scale.
   ========================================================================== */
const viewer = {
  open: false, item: null,
  nw: 0, nh: 0,               // natural size of the loaded image
  W: 0, H: 0,                 // stage size
  fit: 1, min: 1, max: 8,     // scale limits (scale 1 = actual pixels)
  scale: 1, x: 0, y: 0,       // current view
  atFit: true,                // was the last zoom "fit"? (so resizes keep it fitted)
  pointers: new Map(),
  gesture: null,              // { type:'pan'|'pinch', ... }
  lastTap: null,
  inertia: 0,
  returnFocus: null,
};
const VIEWER_PAD = 28;        // breathing room around a fitted photo
const VIEWER_FIT_CAP = 3;     // never auto-enlarge small photos past 3×

const vEl = (id) => document.getElementById(id);
const vClamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* ---------- geometry ---------- */
function viewerMeasure(){
  const stage = vEl('viewerStage');
  viewer.W = stage.clientWidth || window.innerWidth;
  viewer.H = stage.clientHeight || window.innerHeight;
  if(!viewer.nw || !viewer.nh) return;
  const fit = Math.min((viewer.W - VIEWER_PAD * 2) / viewer.nw, (viewer.H - VIEWER_PAD * 2) / viewer.nh, VIEWER_FIT_CAP);
  viewer.fit = Math.max(0.01, fit);
  viewer.min = viewer.fit;
  viewer.max = Math.max(8, viewer.fit * 6);
}

/* Keep the photo on screen: centred when smaller than the stage, otherwise
   it may travel only until its edge meets the stage edge. */
function viewerClampPosition(){
  const w = viewer.nw * viewer.scale, h = viewer.nh * viewer.scale;
  viewer.x = w <= viewer.W ? (viewer.W - w) / 2 : vClamp(viewer.x, viewer.W - w, 0);
  viewer.y = h <= viewer.H ? (viewer.H - h) / 2 : vClamp(viewer.y, viewer.H - h, 0);
}

function renderViewerSplats(item = viewer.item){
  const overlay = vEl('imagePopOverlay');
  const img = vEl('imagePopImg');
  if(!overlay || !img) return;
  if(!item || !state.iCameSettings || !state.iCameSettings.showSplats){
    const old = document.getElementById('viewerSplatLayer');
    if(old) old.remove();
    return;
  }
  const entry = iCameEntry ? iCameEntry(item) : null;
  if(!entry || !Array.isArray(entry.splats) || !entry.splats.length){
    const old = document.getElementById('viewerSplatLayer');
    if(old) old.remove();
    return;
  }
  let layer = document.getElementById('viewerSplatLayer');
  if(!layer){
    layer = document.createElement('div');
    layer.id = 'viewerSplatLayer';
    layer.style.position = 'absolute';
    layer.style.inset = '0';
    layer.style.pointerEvents = 'none';
    layer.style.zIndex = '2';
    overlay.appendChild(layer);
  }
  const w = img.naturalWidth || 1;
  const h = img.naturalHeight || 1;
  const shown = entry.splats.slice(-12);
  const target = iCameTargetForItem ? iCameTargetForItem(item) : null;
  const targetMarkup = target ? `<div class="icame-target-box" style="left:${(target.x * w).toFixed(1)}px;top:${(target.y * h).toFixed(1)}px;width:${(target.w * w).toFixed(1)}px;height:${(target.h * h).toFixed(1)}px"></div>` : '';
  layer.style.transform = `translate3d(${viewer.x}px, ${viewer.y}px, 0) scale(${viewer.scale})`;
  layer.style.width = `${w}px`;
  layer.style.height = `${h}px`;
  layer.style.transformOrigin = '0 0';
  layer.innerHTML = shown.map((p, idx) => {
    const size = Math.max(22, (p.s || 0.3) * Math.min(w, h));
    const left = (p.x || 0.5) * w - size / 2;
    const top = (p.y || 0.5) * h - size / 2;
    return `<svg class="icame-splat" data-i="${idx}" viewBox="0 0 100 100" style="left:${left.toFixed(1)}px;top:${top.toFixed(1)}px;width:${size.toFixed(1)}px;height:${size.toFixed(1)}px">${splatInner(p, idx)}</svg>`;
  }).join('') + targetMarkup;
}
function viewerRender(animate){
  const img = vEl('imagePopImg');
  img.classList.toggle('is-animating', !!animate);
  img.style.transform = `translate3d(${viewer.x}px, ${viewer.y}px, 0) scale(${viewer.scale})`;
  renderViewerSplats(viewer.item);
  const zoomed = viewer.scale > viewer.fit * 1.02;
  vEl('imagePopOverlay').classList.toggle('is-zoomed', zoomed);
  vEl('viewerZoomLevel').textContent = `${Math.round(viewer.scale * 100)}%`;
  vEl('viewerZoomOut').disabled = viewer.scale <= viewer.min * 1.001;
  vEl('viewerZoomIn').disabled = viewer.scale >= viewer.max * 0.999;
}

/* Zoom to `next`, keeping the point (cx, cy) — in stage coordinates — fixed. */
function viewerZoomTo(next, cx, cy, animate){
  next = vClamp(next, viewer.min, viewer.max);
  const k = next / viewer.scale;
  viewer.x = cx - (cx - viewer.x) * k;
  viewer.y = cy - (cy - viewer.y) * k;
  viewer.scale = next;
  viewer.atFit = Math.abs(next - viewer.fit) < 0.0005;
  viewerClampPosition();
  viewerRender(animate);
}
function viewerZoomBy(factor, animate = true){
  viewerStopInertia();
  viewerZoomTo(viewer.scale * factor, viewer.W / 2, viewer.H / 2, animate);
}
function viewerFitView(animate = true){
  viewerStopInertia();
  viewer.scale = viewer.fit;
  viewer.atFit = true;
  viewerClampPosition();
  viewerRender(animate);
}
function viewerActualSize(){
  viewerStopInertia();
  viewerZoomTo(1, viewer.W / 2, viewer.H / 2, true);
}
function viewerToggleZoom(cx, cy){
  viewerStopInertia();
  if(viewer.scale > viewer.fit * 1.05){ viewerFitView(true); return; }
  const target = 1 > viewer.fit * 1.4 ? 1 : viewer.fit * 3;
  viewerZoomTo(target, cx, cy, true);
}

/* ---------- momentum ---------- */
function viewerStopInertia(){
  if(viewer.inertia){ cancelAnimationFrame(viewer.inertia); viewer.inertia = 0; }
}
function viewerStartInertia(vx, vy){
  viewerStopInertia();
  let last = performance.now();
  const step = (now) => {
    const dt = Math.min(32, now - last); last = now;
    const decay = Math.pow(0.0035, dt / 1000);     // ~ glides for a third of a second
    vx *= decay; vy *= decay;
    const px = viewer.x, py = viewer.y;
    viewer.x += vx * dt; viewer.y += vy * dt;
    viewerClampPosition();
    viewerRender(false);
    const hitX = Math.abs(viewer.x - (px + vx * dt)) > 0.5, hitY = Math.abs(viewer.y - (py + vy * dt)) > 0.5;
    if(hitX) vx = 0;
    if(hitY) vy = 0;
    if(Math.hypot(vx, vy) > 0.02) viewer.inertia = requestAnimationFrame(step);
    else viewer.inertia = 0;
  };
  viewer.inertia = requestAnimationFrame(step);
}

/* ---------- open / close ---------- */
async function openImagePop(item){
  const overlay = vEl('imagePopOverlay'), img = vEl('imagePopImg');
  if(!overlay || !img || !item) return;
  const existingSplatLayer = document.getElementById('viewerSplatLayer');
  if(existingSplatLayer) existingSplatLayer.remove();
  let src = (typeof variantActiveImageUrl === 'function' && variantActiveImageUrl(item)) || ensureItemUrl(item);
  if(!src && item.pairRemote){
    try{ src = await ensureItemUrlAsync(item); }catch(e){ toast('Couldn\'t load that photo from the paired device.'); return; }
  }
  if(!src){ toast('This photo has no readable source.'); return; }

  viewer.item = item;
  viewer.open = true;
  viewer.returnFocus = document.activeElement;
  viewer.nw = viewer.nh = 0;
  viewer.pointers.clear(); viewer.gesture = null; viewer.lastTap = null;
  viewerStopInertia();

  vEl('viewerTitle').textContent = item.name || '';
  overlay.hidden = false;
  overlay.classList.remove('is-ready', 'is-zoomed');
  img.classList.remove('is-animating');
  img.style.transform = 'translate3d(0,0,0) scale(1)';
  img.onload = () => {
    if(!viewer.open || viewer.item !== item) return;
    viewer.nw = img.naturalWidth || 1; viewer.nh = img.naturalHeight || 1;
    img.style.width = `${viewer.nw}px`; img.style.height = `${viewer.nh}px`;
    viewerMeasure();
    viewer.scale = viewer.fit; viewer.atFit = true;
    viewerClampPosition();
    viewerRender(false);
    renderViewerSplats(item);
    overlay.classList.add('is-ready');
  };
  img.onerror = () => { if(viewer.open){ toast('Couldn\'t open that photo.'); closeImagePop(); } };
  if(/^https?:\/\//i.test(src)){ try{ img.crossOrigin = 'anonymous'; img.referrerPolicy = 'no-referrer'; }catch(e){} }
  img.alt = item.name || '';
  img.src = src;
  vEl('imagePopClose').focus({ preventScroll: true });
}

function closeImagePop(){
  const overlay = vEl('imagePopOverlay');
  if(!overlay || overlay.hidden) return;
  viewerStopInertia();
  viewer.open = false; viewer.item = null;
  const oldSplatLayer = document.getElementById('viewerSplatLayer');
  if(oldSplatLayer) oldSplatLayer.remove();
  viewer.pointers.clear(); viewer.gesture = null;
  overlay.hidden = true;
  overlay.classList.remove('is-ready', 'is-zoomed', 'is-dragging');
  vEl('imagePopImg').removeAttribute('src');
  if(document.fullscreenElement === overlay) document.exitFullscreen().catch(() => {});
  const back = viewer.returnFocus;
  viewer.returnFocus = null;
  if(back && typeof back.focus === 'function') try{ back.focus({ preventScroll: true }); }catch(e){}
}

/* ---------- input ---------- */
function viewerStagePoint(e){
  const r = vEl('viewerStage').getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
function viewerImageContains(p){
  const w = viewer.nw * viewer.scale, h = viewer.nh * viewer.scale;
  return p.x >= viewer.x && p.x <= viewer.x + w && p.y >= viewer.y && p.y <= viewer.y + h;
}

function viewerBeginPan(e){
  const p = viewerStagePoint(e);
  viewer.gesture = { type: 'pan', sx: p.x, sy: p.y, ox: viewer.x, oy: viewer.y, moved: false, samples: [{ t: performance.now(), x: p.x, y: p.y }], target: e.target };
}
function viewerBeginPinch(){
  const pts = [...viewer.pointers.values()];
  const a = pts[0], b = pts[1];
  const r = vEl('viewerStage').getBoundingClientRect();
  viewer.gesture = {
    type: 'pinch',
    dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
    mx: (a.x + b.x) / 2 - r.left, my: (a.y + b.y) / 2 - r.top,
    scale: viewer.scale, ox: viewer.x, oy: viewer.y,
  };
}

function bindImagePopOverlay(){
  const overlay = vEl('imagePopOverlay'), stage = vEl('viewerStage');
  if(!overlay || !stage || overlay.dataset.bound) return;
  overlay.dataset.bound = '1';

  vEl('imagePopClose').addEventListener('click', closeImagePop);
  vEl('viewerZoomIn').addEventListener('click', () => viewerZoomBy(1.4));
  vEl('viewerZoomOut').addEventListener('click', () => viewerZoomBy(1 / 1.4));
  vEl('viewerZoomLevel').addEventListener('click', () => viewerToggleZoom(viewer.W / 2, viewer.H / 2));
  vEl('viewerFit').addEventListener('click', () => viewerFitView(true));
  vEl('viewerActual').addEventListener('click', viewerActualSize);
  vEl('viewerFullscreen').addEventListener('click', () => {
    if(document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else overlay.requestFullscreen().catch(() => toast('Full screen isn\'t available here.'));
  });
  document.addEventListener('fullscreenchange', () => { if(viewer.open) requestAnimationFrame(viewerOnResize); });
  window.addEventListener('resize', () => { if(viewer.open) viewerOnResize(); });

  /* wheel + trackpad pinch (browsers report pinch as ctrl+wheel) */
  stage.addEventListener('wheel', (e) => {
    if(!viewer.nw) return;
    e.preventDefault();
    viewerStopInertia();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? viewer.H : 1;
    const dy = e.deltaY * unit;
    const k = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0016));
    const p = viewerStagePoint(e);
    viewerZoomTo(viewer.scale * k, p.x, p.y, false);
  }, { passive: false });

  stage.addEventListener('pointerdown', (e) => {
    if(e.pointerType === 'mouse' && e.button !== 0) return;
    if(!viewer.nw) return;
    viewerStopInertia();
    try{ stage.setPointerCapture(e.pointerId); }catch(_){}
    const p = viewerStagePoint(e);
    viewer.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if(viewer.pointers.size === 1) viewerBeginPan(e);
    else if(viewer.pointers.size === 2) viewerBeginPinch();
  });

  stage.addEventListener('pointermove', (e) => {
    if(!viewer.pointers.has(e.pointerId)) return;
    viewer.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = viewer.gesture;
    if(!g) return;

    if(g.type === 'pinch' && viewer.pointers.size >= 2){
      const pts = [...viewer.pointers.values()];
      const a = pts[0], b = pts[1];
      const r = stage.getBoundingClientRect();
      const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
      const next = vClamp(g.scale * dist / g.dist, viewer.min, viewer.max);
      const k = next / g.scale;
      // zoom about the starting midpoint, then follow the fingers as they travel
      viewer.x = g.mx - (g.mx - g.ox) * k + (mx - g.mx);
      viewer.y = g.my - (g.my - g.oy) * k + (my - g.my);
      viewer.scale = next;
      viewer.atFit = Math.abs(next - viewer.fit) < 0.0005;
      viewerClampPosition();
      viewerRender(false);
      return;
    }

    if(g.type === 'pan'){
      const p = viewerStagePoint(e);
      const dx = p.x - g.sx, dy = p.y - g.sy;
      if(!g.moved && Math.hypot(dx, dy) < 4) return;
      if(!g.moved){ g.moved = true; overlay.classList.add('is-dragging'); }
      viewer.x = g.ox + dx; viewer.y = g.oy + dy;
      viewerClampPosition();
      viewerRender(false);
      const now = performance.now();
      g.samples.push({ t: now, x: p.x, y: p.y });
      while(g.samples.length > 2 && now - g.samples[0].t > 90) g.samples.shift();
    }
  });

  const endPointer = (e) => {
    if(!viewer.pointers.has(e.pointerId)) return;
    const wasGesture = viewer.gesture;
    viewer.pointers.delete(e.pointerId);
    try{ stage.releasePointerCapture(e.pointerId); }catch(_){}

    if(wasGesture && wasGesture.type === 'pinch'){
      // one finger stays down: carry on as a pan from where it is now
      if(viewer.pointers.size === 1){
        const [id, pt] = [...viewer.pointers.entries()][0];
        const r = stage.getBoundingClientRect();
        viewer.gesture = { type: 'pan', sx: pt.x - r.left, sy: pt.y - r.top, ox: viewer.x, oy: viewer.y, moved: true, samples: [], target: null };
      } else viewer.gesture = null;
      if(viewer.scale < viewer.fit * 1.02) viewerFitView(true);
      return;
    }
    if(viewer.pointers.size) return;
    viewer.gesture = null;
    overlay.classList.remove('is-dragging');
    if(!wasGesture || wasGesture.type !== 'pan' || e.type === 'pointercancel') return;

    if(wasGesture.moved){
      // fling
      const s = wasGesture.samples;
      if(s.length >= 2){
        const a = s[0], b = s[s.length - 1];
        const dt = Math.max(1, b.t - a.t);
        const vx = (b.x - a.x) / dt, vy = (b.y - a.y) / dt;
        if(Math.hypot(vx, vy) > 0.15 && performance.now() - b.t < 80) viewerStartInertia(vx, vy);
      }
      viewer.lastTap = null;
      return;
    }

    /* a tap / click without movement */
    const p = viewerStagePoint(e);
    const now = performance.now();
    const t = viewer.lastTap;
    if(t && now - t.t < 320 && Math.hypot(p.x - t.x, p.y - t.y) < 30){
      viewer.lastTap = null;
      viewerToggleZoom(p.x, p.y);
      return;
    }
    viewer.lastTap = { t: now, x: p.x, y: p.y };
    // clicking the dark area while looking at the whole photo closes the viewer
    if(!viewerImageContains(p) && viewer.scale <= viewer.fit * 1.02){
      const mine = viewer.lastTap;
      setTimeout(() => { if(viewer.open && viewer.lastTap === mine) closeImagePop(); }, 0);
    }
  };
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);
  stage.addEventListener('lostpointercapture', (e) => {
    if(viewer.pointers.has(e.pointerId)) endPointer({ pointerId: e.pointerId, type: 'pointercancel', clientX: e.clientX, clientY: e.clientY });
  });

  /* keyboard */
  window.addEventListener('keydown', (e) => {
    if(!viewer.open) return;
    const k = e.key;
    if(k === 'Escape'){ if(!document.fullscreenElement) closeImagePop(); return; }
    if(e.ctrlKey || e.metaKey || e.altKey) return;
    const step = 80;
    if(k === '+' || k === '='){ e.preventDefault(); viewerZoomBy(1.4); }
    else if(k === '-' || k === '_'){ e.preventDefault(); viewerZoomBy(1 / 1.4); }
    else if(k === '0'){ e.preventDefault(); viewerFitView(true); }
    else if(k === '1'){ e.preventDefault(); viewerActualSize(); }
    else if(k === 'f' || k === 'F'){ e.preventDefault(); vEl('viewerFullscreen').click(); }
    else if(k.startsWith('Arrow') && viewer.scale > viewer.fit * 1.02){
      e.preventDefault();
      viewerStopInertia();
      if(k === 'ArrowLeft') viewer.x += step;
      if(k === 'ArrowRight') viewer.x -= step;
      if(k === 'ArrowUp') viewer.y += step;
      if(k === 'ArrowDown') viewer.y -= step;
      viewerClampPosition();
      viewerRender(true);
    }
  });
}

/* Window or full-screen size changed: re-fit, keeping the same spot in view. */
function viewerOnResize(){
  if(!viewer.open || !viewer.nw) return;
  const oldW = viewer.W, oldH = viewer.H;
  viewerMeasure();
  if(viewer.atFit){ viewer.scale = viewer.fit; }
  else {
    // keep whatever was at the centre of the old stage at the centre of the new one
    const cx = (oldW / 2 - viewer.x) / viewer.scale, cy = (oldH / 2 - viewer.y) / viewer.scale;
    viewer.scale = vClamp(viewer.scale, viewer.min, viewer.max);
    viewer.x = viewer.W / 2 - cx * viewer.scale;
    viewer.y = viewer.H / 2 - cy * viewer.scale;
  }
  viewerClampPosition();
  viewerRender(false);
}

/* The little page-level photo no longer drags around on its own: it just
   opens the viewer, which is where moving and zooming live. */
function bindFocusImagePan(){ /* intentionally empty — kept so app-init still finds it */ }

/* Bind as soon as the page is ready (app-init also calls this; it only binds once). */
document.addEventListener('DOMContentLoaded', bindImagePopOverlay);
