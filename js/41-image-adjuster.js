/* ==========================================================================
   Image adjuster — position and zoom a photo inside a fixed frame, then bake
   exactly what's inside the frame into a new picture.

     const dataUrl = await openImageAdjuster({
       src,                     // image URL (blob:, data:, …)
       aspect,                  // width / height of the frame
       aspects: [[label, ratio], …],   // optional presets shown under the frame
       title, confirmLabel,
       maxEdge: 1920,           // longest side of the result, in pixels
       maxChars: 2_200_000,     // keep the data URL under this (localStorage)
     });                        // -> data URL (JPEG), or null if cancelled

   Everything is driven by one idea: the point of the image that sits at the
   centre of the frame (cx, cy, in image pixels) and a zoom factor z where
   z = 1 means "just covers the frame". Panning moves that point, zooming
   keeps whatever is under your finger/cursor still. The image can never
   leave a gap inside the frame.
   ========================================================================== */
let imageAdjusterOpen = false;

function openImageAdjuster(opts = {}){
  if(imageAdjusterOpen || !opts.src) return Promise.resolve(null);
  imageAdjusterOpen = true;

  const maxEdge = opts.maxEdge || 1920;
  const maxChars = opts.maxChars || 2200000;
  const ZMAX = 8;
  const aspects = Array.isArray(opts.aspects) && opts.aspects.length > 1 ? opts.aspects : null;

  let aspect = opts.aspect || (aspects ? aspects[0][1] : 16 / 9);
  let natW = 0, natH = 0;
  let W = 0, H = 0;           // frame size on screen (px)
  let z = 1, cx = 0, cy = 0;  // zoom factor + image point at the frame centre
  let minScale = 1;
  let ready = false;

  const root = document.createElement('div');
  root.className = 'modal-backdrop rf-layer-adjust';
  root.innerHTML = `
    <div class="modal rf-adjust" role="dialog" aria-modal="true" aria-label="${escapeAttr(opts.title || 'Adjust image')}">
      <div class="modal-header">
        <h2>${escapeHtml(opts.title || 'Adjust image')}</h2>
        <button type="button" class="icon-btn" data-act="cancel" aria-label="Close">✕</button>
      </div>
      <div class="modal-body">
        <div class="rf-adjust-area">
          <div class="rf-adjust-stage is-loading">
            <img class="rf-adjust-img" alt="" draggable="false">
            <div class="rf-adjust-thirds" aria-hidden="true"></div>
            <div class="rf-adjust-loading">Loading…</div>
          </div>
        </div>
        ${aspects ? `<div class="rf-seg rf-adjust-aspects" role="radiogroup" aria-label="Frame shape">${
          aspects.map(([label, ratio], i) => `<button type="button" role="radio" class="rf-seg-btn ${i === 0 ? 'is-on' : ''}" data-ratio="${ratio}" aria-checked="${i === 0}">${escapeHtml(label)}</button>`).join('')
        }</div>` : ''}
        <div class="rf-adjust-zoom">
          <button type="button" class="icon-btn" data-act="zoom-out" aria-label="Zoom out"><svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
          <input type="range" min="0" max="1000" step="1" value="0" aria-label="Zoom">
          <button type="button" class="icon-btn" data-act="zoom-in" aria-label="Zoom in"><svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
          <button type="button" class="btn btn-sm" data-act="reset">Reset</button>
        </div>
        <p class="rf-adjust-hint">Drag to reposition · scroll or pinch to zoom · arrow keys nudge</p>
      </div>
      <div class="modal-footer">
        <span class="rf-adjust-size"></span>
        <button type="button" class="btn" data-act="cancel">Cancel</button>
        <button type="button" class="btn btn-primary" data-act="done" disabled>${escapeHtml(opts.confirmLabel || 'Done')}</button>
      </div>
    </div>`;
  document.body.appendChild(root);

  const $ = (sel) => root.querySelector(sel);
  const area = $('.rf-adjust-area');
  const stage = $('.rf-adjust-stage');
  const img = $('.rf-adjust-img');
  const slider = $('.rf-adjust-zoom input');
  const sizeEl = $('.rf-adjust-size');
  const doneBtn = $('[data-act="done"]');
  const returnFocus = document.activeElement;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const scale = () => minScale * z;

  /* ---------- layout ---------- */
  function layoutStage(){
    const availW = Math.max(160, area.clientWidth);
    const availH = Math.max(140, Math.min(window.innerHeight * 0.5, 480));
    W = Math.round(Math.min(availW, availH * aspect));
    H = Math.round(W / aspect);
    stage.style.width = W + 'px';
    stage.style.height = H + 'px';
    if(natW){
      minScale = Math.max(W / natW, H / natH);
      render();
    }
  }

  function keepInside(){
    const s = scale();
    const halfW = W / 2 / s, halfH = H / 2 / s;
    cx = clamp(cx, halfW, natW - halfW);
    cy = clamp(cy, halfH, natH - halfH);
  }

  function render(){
    if(!natW) return;
    z = clamp(z, 1, ZMAX);
    keepInside();
    const s = scale();
    img.style.width = (natW * s) + 'px';
    img.style.height = (natH * s) + 'px';
    img.style.transform = `translate3d(${W / 2 - cx * s}px, ${H / 2 - cy * s}px, 0)`;
    slider.value = String(Math.round(Math.log(z) / Math.log(ZMAX) * 1000));
    const out = outputSize();
    sizeEl.textContent = `${out.w} × ${out.h} px`;
  }

  /* Zoom to `nextZ`, keeping the image point under stage position (sx, sy) fixed. */
  function zoomAt(nextZ, sx, sy){
    nextZ = clamp(nextZ, 1, ZMAX);
    const s0 = scale();
    const px = cx + (sx - W / 2) / s0;
    const py = cy + (sy - H / 2) / s0;
    z = nextZ;
    const s1 = scale();
    cx = px - (sx - W / 2) / s1;
    cy = py - (sy - H / 2) / s1;
    render();
  }

  function reset(){
    z = 1;
    cx = natW / 2;
    cy = natH / 2;
    render();
  }

  /* ---------- result ---------- */
  function outputSize(){
    const s = scale();
    const sw = W / s, sh = H / s;
    const k = Math.min(1, maxEdge / Math.max(sw, sh));
    return { w: Math.max(1, Math.round(sw * k)), h: Math.max(1, Math.round(sh * k)) };
  }

  function bake(){
    const s = scale();
    const sw = W / s, sh = H / s;
    const sx = clamp(cx - sw / 2, 0, Math.max(0, natW - sw));
    const sy = clamp(cy - sh / 2, 0, Math.max(0, natH - sh));
    let k = Math.min(1, maxEdge / Math.max(sw, sh));
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    let url = '';
    // Try a few quality / size steps until it fits comfortably in storage.
    for(let attempt = 0; attempt < 4; attempt++){
      canvas.width = Math.max(1, Math.round(sw * k));
      canvas.height = Math.max(1, Math.round(sh * k));
      ctx.fillStyle = '#14120f';            // behind transparent PNGs
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      for(const q of [0.88, 0.78, 0.68]){
        url = canvas.toDataURL('image/jpeg', q);
        if(url.length <= maxChars) return url;
      }
      k *= 0.8;
    }
    return url;
  }

  /* ---------- finishing ---------- */
  let done = false;
  let resolveFn = null;
  function finish(result){
    if(done) return;
    done = true;
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', layoutStage);
    root.remove();
    imageAdjusterOpen = false;
    try{ if(returnFocus && returnFocus.focus) returnFocus.focus(); }catch(e){}
    resolveFn(result);
  }
  function accept(){
    if(!ready) return;
    let url = '';
    try{ url = bake(); }catch(e){ console.error(e); }
    if(!url){ toast('Couldn’t process that image.'); return; }
    finish(url);
  }

  /* ---------- pointer: drag to pan, two fingers to pinch ---------- */
  const pointers = new Map();
  let drag = null;   // { x, y } of the single active pointer
  let pinch = null;  // { dist, z }

  const stagePoint = (e) => {
    const r = stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  stage.addEventListener('pointerdown', (e) => {
    if(!ready) return;
    e.preventDefault();
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    stage.classList.add('is-dragging');
    if(pointers.size === 1){
      drag = { x: e.clientX, y: e.clientY };
      pinch = null;
    } else if(pointers.size === 2){
      const [a, b] = [...pointers.values()];
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, z };
      drag = null;
    }
  });

  stage.addEventListener('pointermove', (e) => {
    if(!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if(pinch && pointers.size >= 2){
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const r = stage.getBoundingClientRect();
      zoomAt(pinch.z * (dist / pinch.dist), (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
    } else if(drag){
      const s = scale();
      cx -= (e.clientX - drag.x) / s;
      cy -= (e.clientY - drag.y) / s;
      drag = { x: e.clientX, y: e.clientY };
      render();
    }
  });

  const endPointer = (e) => {
    if(!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    try{ stage.releasePointerCapture(e.pointerId); }catch(err){}
    if(pointers.size === 1){
      const [p] = [...pointers.values()];
      drag = { x: p.x, y: p.y };   // carry on panning with the finger that's left
      pinch = null;
    } else if(pointers.size === 0){
      drag = null;
      pinch = null;
      stage.classList.remove('is-dragging');
    }
  };
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);

  stage.addEventListener('wheel', (e) => {
    if(!ready) return;
    e.preventDefault();
    const p = stagePoint(e);
    const speed = e.ctrlKey ? 0.01 : 0.0018;   // trackpad pinch reports ctrl+wheel
    zoomAt(z * Math.exp(-e.deltaY * speed), p.x, p.y);
  }, { passive: false });

  stage.addEventListener('dblclick', () => { if(ready) (z > 1.01 ? reset() : zoomAt(2.5, W / 2, H / 2)); });

  /* ---------- controls ---------- */
  slider.addEventListener('input', () => {
    if(!ready) return;
    zoomAt(Math.pow(ZMAX, Number(slider.value) / 1000), W / 2, H / 2);
  });

  root.addEventListener('click', (e) => {
    if(e.target === root){ finish(null); return; }
    const seg = e.target.closest('.rf-seg-btn');
    if(seg){
      root.querySelectorAll('.rf-seg-btn').forEach(b => { const on = b === seg; b.classList.toggle('is-on', on); b.setAttribute('aria-checked', String(on)); });
      aspect = Number(seg.dataset.ratio) || aspect;
      layoutStage();
      return;
    }
    const act = e.target.closest('[data-act]');
    if(!act) return;
    switch(act.getAttribute('data-act')){
      case 'cancel': finish(null); break;
      case 'done': accept(); break;
      case 'reset': if(ready) reset(); break;
      case 'zoom-in': if(ready) zoomAt(z * 1.25, W / 2, H / 2); break;
      case 'zoom-out': if(ready) zoomAt(z / 1.25, W / 2, H / 2); break;
    }
  });

  function onKey(e){
    if(e.key === 'Escape'){ e.preventDefault(); e.stopImmediatePropagation(); finish(null); return; }
    if(!ready) return;
    const typing = e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && e.target.type !== 'range';
    if(typing) return;
    if(e.target === slider && e.key.startsWith('Arrow')) return;   // let the slider use its own arrows
    const step = 24 / scale();
    let handled = true;
    switch(e.key){
      case 'ArrowLeft': cx -= step; break;
      case 'ArrowRight': cx += step; break;
      case 'ArrowUp': cy -= step; break;
      case 'ArrowDown': cy += step; break;
      case '+': case '=': zoomAt(z * 1.15, W / 2, H / 2); e.stopImmediatePropagation(); e.preventDefault(); return;
      case '-': case '_': zoomAt(z / 1.15, W / 2, H / 2); e.stopImmediatePropagation(); e.preventDefault(); return;
      case 'Enter':
        if(e.target && e.target.tagName === 'BUTTON') return;
        accept(); break;
      default: handled = false;
    }
    if(handled){ e.preventDefault(); e.stopImmediatePropagation(); render(); }
  }
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', layoutStage);

  /* ---------- load the picture ---------- */
  img.onload = () => {
    natW = img.naturalWidth;
    natH = img.naturalHeight;
    if(!natW || !natH){ img.onerror(); return; }
    ready = true;
    stage.classList.remove('is-loading');
    doneBtn.disabled = false;
    cx = natW / 2;
    cy = natH / 2;
    layoutStage();
  };
  img.onerror = () => {
    toast('Couldn’t open that image.');
    finish(null);
  };
  layoutStage();
  img.src = opts.src;

  const dialog = $('.rf-adjust');
  dialog.setAttribute('tabindex', '-1');
  dialog.focus({ preventScroll: true });

  return new Promise(resolve => { resolveFn = resolve; });
}
