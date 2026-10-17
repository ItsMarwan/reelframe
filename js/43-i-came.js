/* ==========================================================================
   js/43-i-came.js  —  "I came" (Focus view)
   - Each press shoots a number of separate ropes, one after another. Every rope
     is a connected, uneven jet (thick head, thinning strands, breaking beads)
     that sweeps while it is shot and lands on the photo.
   - A rope's splat only appears once that rope actually touches the photo.
   - Splats and the stream are fully opaque, glossy white liquid. Drips are random and liquidy.
   - Rope count, amount, splat size and drip amount are all
     adjustable in Settings. All styles are injected from this file.
   ========================================================================== */
const ICAME_KEY = 'reelframe-i-came-v1';
const ICAME_SETTINGS_KEY = 'reelframe-i-came-settings-v1';
const ICAME_CAT = '__icame__';
const ICAME_DEFAULT_COOLDOWN_HOURS = 8;
const ICAME_MAX_SPLATS_SHOWN = 36;

const ICAME_BODY_PART_PRESETS = {
  custom: { label: 'Custom location', x: 0.18, y: 0.22, w: 0.64, h: 0.5 },
  face: { label: 'Face', x: 0.32, y: 0.14, w: 0.36, h: 0.22 },
  chest: { label: 'Chest', x: 0.25, y: 0.28, w: 0.5, h: 0.2 },
  breasts: { label: 'Breasts', x: 0.24, y: 0.24, w: 0.52, h: 0.18 },
  belly: { label: 'Belly', x: 0.26, y: 0.42, w: 0.48, h: 0.18 },
  genitals: { label: 'Genitals', x: 0.32, y: 0.58, w: 0.36, h: 0.15 },
  anus: { label: 'Anus', x: 0.36, y: 0.7, w: 0.28, h: 0.1 },
  buttocks: { label: 'Buttocks', x: 0.28, y: 0.68, w: 0.44, h: 0.17 },
  feet: { label: 'Feet', x: 0.22, y: 0.76, w: 0.56, h: 0.18 },
  armpits: { label: 'Armpits', x: 0.18, y: 0.32, w: 0.64, h: 0.12 }
};
const ICAME_DEFAULTS = { cooldownHours: ICAME_DEFAULT_COOLDOWN_HOURS, showSplats: true, ropes: 4, ropesRandom: true, amount: 100, size: 100, drips: 70, targetMode: 'anywhere', targetPreset: 'custom', target: { x: 0.18, y: 0.22, w: 0.64, h: 0.5 } };
const ICAME_RANGES = { ropes: [1, 12], amount: [20, 250], size: [40, 250], drips: [0, 100] };

function clampNum(v, lo, hi){ return Math.min(hi, Math.max(lo, v)); }

function mulberry32(a){
  return function(){
    let t = (a += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- injected styles (no stylesheet edits needed) ---------- */
(function injectICameStyle(){
  if(document.getElementById('icame-style')) return;
  const profiles = [
    [[0, .04], [30, .5], [42, .52], [100, 1]],
    [[0, .04], [15, .25], [55, .8], [65, .82], [100, 1]],
    [[0, .04], [60, .35], [70, .36], [100, 1]],
  ];
  let kf = '';
  profiles.forEach((pr, i) => {
    kf += `@keyframes icameTail${i}{${pr.map(([t, s]) => `${t}%{transform:scaleY(${s})}`).join('')}}`;
    kf += `@keyframes icameBulb${i}{${pr.map(([t, s]) => `${t}%{transform:translateY(calc(var(--len) * ${(-(1 - s)).toFixed(2)}))}`).join('')}}`;
  });
  let dripCss = '';
  profiles.forEach((_, i) => {
    dripCss += `.icame-splat.is-new .icame-drip.v${i} .dt{animation-name:icameTail${i}}.icame-splat.is-new .icame-drip.v${i} .db{animation-name:icameBulb${i}}`;
  });
  const s = document.createElement('style');
  s.id = 'icame-style';
  s.textContent = `
#focusSplatLayer{ position:absolute; inset:0; overflow:hidden; pointer-events:none; z-index:3; mix-blend-mode:normal !important; }
#focusSplatLayer[hidden]{ display:none; }
.icame-splat{ position:absolute; overflow:visible; opacity:1; transform-origin:50% 50%; filter:drop-shadow(0 .5px 1px rgba(0,0,0,.2)); animation:none; }
.icame-splat.is-hidden{ visibility:hidden !important; }
.icame-splat.is-new{ animation:icameLand .9s cubic-bezier(.1,.85,.2,1) both; }
@keyframes icameLand{ from{ transform:scale(.12); opacity:0; } 25%{ opacity:1; } to{ transform:scale(1); opacity:1; } }
.icame-splat.is-new .icame-drip{ animation:none !important; transform:none !important; }
.icame-drip .dt{ transform-box:fill-box; transform-origin:50% 0; }
.icame-splat.is-new .icame-drip .dt, .icame-splat.is-new .icame-drip .db{ animation-duration:var(--dur); animation-delay:var(--dl); animation-timing-function:cubic-bezier(.3,.1,.5,1); animation-fill-mode:both; }
${dripCss}
${kf}
.pin-icame-layer{ position:absolute; inset:0; z-index:2; pointer-events:none; overflow:hidden; }
.pin-icame-splat{ position:absolute; display:block; filter:drop-shadow(0 1px 1.2px rgba(0,0,0,.22)); }
.icame-target-box{ position:absolute; border:1px solid rgba(255,255,255,.9); background:rgba(255,255,255,.08); box-shadow:inset 0 0 0 1px rgba(255,255,255,.24), 0 0 0 1px rgba(0,0,0,.15); border-radius:10px; pointer-events:none; }
.focus-img-wrap .icame-target-box{ z-index:2; }
.focus-img-wrap.nsfw-gated:not(.nsfw-baked) #focusSplatLayer{ display:none; }
#focusICameBtn{ display:inline-flex; align-items:center; gap:6px; }
#focusICameBtn .icame-icon{ flex:none; }
.focus-actions .btn#focusICameBtn.is-cooling{ opacity:.65; cursor:not-allowed; }
#focusICameTargetBtn.is-active{ box-shadow:inset 0 0 0 1px rgba(255,255,255,.5), 0 0 0 1px rgba(255,255,255,.15); }
`;
  document.head.appendChild(s);
})();

/* ---------- shared SVG defs (gradients) ---------- */
function ensureICameDefs(){
  if(document.getElementById('icameDefsSvg')) return;
  const d = document.createElement('div');
  d.id = 'icameDefsSvg';
  d.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  d.innerHTML = `<svg width="0" height="0" aria-hidden="true"><defs>
    <linearGradient id="icameIconGrad" x1="0" y1="0" x2="0.6" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset=".55" stop-color="#eef2f7"/><stop offset="1" stop-color="#c3cfdd"/></linearGradient>
    <radialGradient id="icameFillGrad" cx=".4" cy=".35" r=".8"><stop offset="0" stop-color="#ffffff" stop-opacity=".40"/><stop offset=".7" stop-color="#f4f7fa" stop-opacity=".30"/><stop offset="1" stop-color="#e9eef4" stop-opacity=".22"/></radialGradient>
    <filter id="icameRim" filterUnits="userSpaceOnUse" x="-60" y="-60" width="220" height="220" color-interpolation-filters="sRGB">
      <feGaussianBlur in="SourceAlpha" stdDeviation="1.2" result="b"/>
      <feOffset in="b" dx="-1.5" dy="-1.7" result="o1"/>
      <feComposite in="SourceAlpha" in2="o1" operator="out" result="e1"/>
      <feFlood flood-color="#0f1923" flood-opacity=".38"/>
      <feComposite in2="e1" operator="in" result="dark"/>
      <feOffset in="b" dx="1.2" dy="1.3" result="o2"/>
      <feComposite in="SourceAlpha" in2="o2" operator="out" result="e2"/>
      <feFlood flood-color="#ffffff" flood-opacity=".75"/>
      <feComposite in2="e2" operator="in" result="light"/>
      <feMorphology in="SourceAlpha" operator="erode" radius=".5" result="er"/>
      <feComposite in="SourceAlpha" in2="er" operator="out" result="ol"/>
      <feFlood flood-color="#ffffff" flood-opacity=".55"/>
      <feComposite in2="ol" operator="in" result="outline"/>
      <feMerge><feMergeNode in="dark"/><feMergeNode in="light"/><feMergeNode in="outline"/></feMerge>
    </filter>
    <filter id="icameGoo" color-interpolation-filters="sRGB"><feGaussianBlur in="SourceGraphic" stdDeviation="2.4" result="b"/><feColorMatrix in="b" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7"/></filter>
  </defs></svg>`;
  document.body.appendChild(d);
}

function smoothClosedPath(pts, dg = 1){
  const n = pts.length, f = v => v.toFixed(dg);
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for(let i = 0; i < n; i++){
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    d += ` C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d + 'Z';
}

/* ---------- realistic splat geometry (100x100 box) ----------
   ang = direction of travel (radians), dripAmt = 0..100 */
function splatShapes(seed, ang, dripAmt){
  const rand = mulberry32(seed);
  const f = v => v.toFixed(1);
  const ra = rand();
  const a = typeof ang === 'number' ? ang : ra * Math.PI * 2;
  const cx = 50, cy = 50;
  const ux = Math.cos(a), uy = Math.sin(a), px = -uy, py = ux;
  const R = 10 + rand() * 5;
  const shapes = [], strands = [], hl = [], drips = [];

  /* main body: lumpy, stretched along the shot */
  const p1 = rand() * 6.28, p2 = rand() * 6.28, p3 = rand() * 6.28;
  const pts = [];
  for(let i = 0; i < 18; i++){
    const th = i / 18 * Math.PI * 2;
    const wob = 1 + 0.16 * Math.sin(3 * th + p1) + 0.11 * Math.sin(5 * th + p2) + 0.07 * Math.sin(8 * th + p3);
    const r = R * wob * (1 + 0.12 * Math.cos(2 * (th - a)));
    pts.push([cx + Math.cos(th) * r, cy + Math.sin(th) * r]);
  }
  shapes.push(`<path d="${smoothClosedPath(pts)}"/>`);

  /* merged secondary lobes (separate pulses landing close together) */
  const lobes = 2 + Math.floor(rand() * 2);
  for(let l = 0; l < lobes; l++){
    const off = R * (0.5 + rand() * 0.9) * (rand() < 0.5 ? -1 : 1);
    const lx = cx + ux * off * 0.8 + px * (rand() - 0.5) * R * 0.9;
    const ly = cy + uy * off * 0.8 + py * (rand() - 0.5) * R * 0.9;
    const lr = R * (0.35 + rand() * 0.35), ph = rand() * 6.28, q = [];
    for(let i = 0; i < 9; i++){
      const th = i / 9 * Math.PI * 2, w = 1 + 0.2 * Math.sin(3 * th + ph);
      q.push([lx + Math.cos(th) * lr * w, ly + Math.sin(th) * lr * w * 0.85]);
    }
    shapes.push(`<path d="${smoothClosedPath(q)}"/>`);
  }

  /* a few tiny droplets close to the body (all around, not streaming off one side) */
  const m = 3 + Math.floor(rand() * 4);
  for(let i = 0; i < m; i++){
    const th = rand() * Math.PI * 2;
    const d = R * (1.25 + rand() * 0.7);
    const sx = cx + Math.cos(th) * d, sy = cy + Math.sin(th) * d;
    const r = 0.6 + rand() * 1.3;
    shapes.push(`<ellipse cx="${f(sx)}" cy="${f(sy)}" rx="${f(r * 1.2)}" ry="${f(r)}" transform="rotate(${f(th * 180 / Math.PI)} ${f(sx)} ${f(sy)})"/>`);
  }

  /* specular glints */
  hl.push(`<path d="M${f(cx - R * 0.6)} ${f(cy - R * 0.2)} Q${f(cx - R * 0.25)} ${f(cy - R * 0.72)} ${f(cx + R * 0.3)} ${f(cy - R * 0.55)}" fill="none" stroke="#fff" stroke-opacity=".9" stroke-width="1.3" stroke-linecap="round"/>`);
  hl.push(`<ellipse cx="${f(cx - R * 0.32)}" cy="${f(cy - R * 0.38)}" rx="${f(R * 0.2)}" ry="${f(R * 0.09)}" fill="#fff" fill-opacity=".95" transform="rotate(-28 ${f(cx - R * 0.32)} ${f(cy - R * 0.38)})"/>`);
  hl.push(`<circle cx="${f(cx + R * 0.45)}" cy="${f(cy + R * 0.35)}" r="${f(R * 0.07)}" fill="#fff" fill-opacity=".8"/>`);

  /* random liquidy drips: different count / length / width / speed / stalls */
  const da = clampNum(dripAmt == null ? 70 : dripAmt, 0, 100) / 100;
  const nd = Math.round(da * (0.6 + rand() * 2.6));
  for(let d = 0; d < nd; d++){
    const th = Math.PI * (0.22 + rand() * 0.56);
    const dx0 = cx + Math.cos(th) * R * 0.55, dy0 = cy + Math.sin(th) * R * 0.5;
    const L = 6 + Math.pow(rand(), 1.6) * 40 * (0.5 + da);
    const w = 0.9 + rand() * 1.7, wb = w * (1.15 + rand() * 0.5) + 0.3;
    const jit = (rand() - 0.5) * 1.4;
    const dur = (2.5 + rand() * 9).toFixed(1), dl = (0.5 + rand() * 2).toFixed(1);
    const v = Math.floor(rand() * 3);
    drips.push(
      `<g class="icame-drip v${v}" style="--len:${f(L)}px;--dur:${dur}s;--dl:${dl}s">` +
      `<path class="dt" d="M${f(dx0 - w)} ${f(dy0)} Q${f(dx0 - w * 0.8 + jit)} ${f(dy0 + L * 0.5)} ${f(dx0 - w * 0.5)} ${f(dy0 + L)} L${f(dx0 + w * 0.5)} ${f(dy0 + L)} Q${f(dx0 + w * 0.8 + jit)} ${f(dy0 + L * 0.5)} ${f(dx0 + w)} ${f(dy0)}Z" fill="#f6f3ea"/>` +
      `<circle class="db" cx="${f(dx0)}" cy="${f(dy0 + L)}" r="${f(wb)}" fill="#f6f3ea"/>` +
      `</g>`
    );
  }
  return { shapes: shapes.join(''), strands: strands.join(''), hl: hl.join(''), drips: drips.join('') };
}

const splatShapeCache = new Map();
function splatShapesCached(seed, ang, dr){
  const k = seed + '|' + (typeof ang === 'number' ? ang.toFixed(3) : 'r') + '|' + dr;
  let m = splatShapeCache.get(k);
  if(!m){ m = splatShapes(seed, ang, dr); splatShapeCache.set(k, m); if(splatShapeCache.size > 400) splatShapeCache.delete(splatShapeCache.keys().next().value); }
  return m;
}

/* one splat's inner SVG: opaque glossy liquid with a soft shaded rim */
function splatInner(p, gi, c){
  const sh = splatShapesCached(p.seed, p.a, p.dr);
  return `<g fill="#f6f3ea">${sh.shapes}</g>` +                  // solid body
    `<g fill="#ffffff" filter="url(#icameRim)">${sh.shapes}</g>` + // shading: dark inner edge, bright inner edge, outline
    sh.strands + sh.hl + sh.drips;
}

/* ---------- the button / sidebar icon: a realistic splat glyph ---------- */
let icameIconInner = '';
function buildICameIcon(){
  if(icameIconInner) return icameIconInner;
  const pts = [], R = 6.1;
  for(let i = 0; i < 14; i++){
    const th = i / 14 * Math.PI * 2;
    const w = 1 + 0.17 * Math.sin(3 * th + 0.6) + 0.1 * Math.sin(5 * th + 2.1);
    pts.push([12.2 + Math.cos(th) * R * w * (1 + 0.18 * Math.cos(2 * (th - 0.7))), 9.6 + Math.sin(th) * R * w * 0.92]);
  }
  const body = smoothClosedPath(pts, 2);
  icameIconInner =
    `<g fill="url(#icameIconGrad)" stroke="rgba(70,90,115,.45)" stroke-width=".3">` +
      `<path d="${body}"/>` +
      `<path d="M17.2 6.4 Q19.4 4.6 21.6 3.9 Q20.2 5.8 18.4 8Z"/>` +
      `<circle cx="22.4" cy="3.3" r=".85"/><circle cx="3.8" cy="5.6" r=".8"/><circle cx="21.2" cy="14.4" r=".7"/><circle cx="3.2" cy="13.6" r=".6"/><circle cx="5.6" cy="2.9" r=".5"/>` +
      `<path d="M10.5 14.6 Q10.3 17.4 10.8 19.6 L12.2 19.6 Q12.6 17.4 13.2 14.9Z"/><circle cx="11.5" cy="20.2" r="1.45"/>` +
      `<path d="M16.4 14.9 Q16.2 16.6 16.5 17.8 L17.3 17.8 Q17.6 16.6 17.8 15.2Z"/><circle cx="16.9" cy="18.2" r=".9"/>` +
    `</g>` +
    `<path d="M7.6 8.1 Q9 5.6 12.2 5.5" fill="none" stroke="#fff" stroke-width=".9" stroke-linecap="round"/>` +
    `<ellipse cx="9.2" cy="7.3" rx="1.1" ry=".5" fill="#fff" transform="rotate(-28 9.2 7.3)"/>` +
    `<ellipse cx="11" cy="19.6" rx=".35" ry=".6" fill="#fff" opacity=".9"/>`;
  return icameIconInner;
}
function icameIconSVG(size){
  ensureICameDefs();
  return `<svg class="icame-icon" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${buildICameIcon()}</svg>`;
}
function paintICameIcons(){
  ensureICameDefs();
  document.querySelectorAll('svg[data-icame-icon]').forEach(el => {
    el.setAttribute('viewBox', '0 0 24 24');
    el.removeAttribute('fill');
    el.innerHTML = buildICameIcon();
  });
}

/* ---------- settings ---------- */
function loadICameSettings(){
  const d = { ...ICAME_DEFAULTS, target: { ...ICAME_DEFAULTS.target } };
  try{
    const raw = JSON.parse(localStorage.getItem(ICAME_SETTINGS_KEY) || '{}');
    if(raw && typeof raw === 'object'){
      const h = Number(raw.cooldownHours);
      if(isFinite(h) && h >= 0) d.cooldownHours = h;
      if(typeof raw.showSplats === 'boolean') d.showSplats = raw.showSplats;
      if(typeof raw.ropesRandom === 'boolean') d.ropesRandom = raw.ropesRandom;
      if(raw.targetMode === 'specific' || raw.targetMode === 'anywhere') d.targetMode = raw.targetMode;
      d.targetPreset = resolveICameTargetPreset(raw.targetPreset);
      const nt = normalizeICameTarget(raw.target || ICAME_DEFAULTS.target);
      if(nt) d.target = nt;
      Object.keys(ICAME_RANGES).forEach(k => {
        const v = Number(raw[k]);
        if(isFinite(v)) d[k] = clampNum(v, ICAME_RANGES[k][0], ICAME_RANGES[k][1]);
      });
    }
  }catch(e){}
  return d;
}
function saveICameSettings(){
  try{ localStorage.setItem(ICAME_SETTINGS_KEY, JSON.stringify(state.iCameSettings)); }catch(e){}
}
state.iCameSettings = loadICameSettings();
function iCameCooldownMs(){
  const h = Number(state.iCameSettings.cooldownHours);
  return isFinite(h) && h > 0 ? h * 3600000 : 0;
}

/* { 'image:path': { count, last, first, splats: [{x,y,s,r,a,seed,dr,gl}] } } */
function loadICame(){
  try{
    const raw = JSON.parse(localStorage.getItem(ICAME_KEY) || '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  }catch(e){ return {}; }
}
function saveICame(){
  try{ localStorage.setItem(ICAME_KEY, JSON.stringify(state.iCame)); }catch(e){}
}
state.iCame = loadICame();

function iCameEntry(item){ return item ? state.iCame[favKey(item)] || null : null; }
function iCameCount(item){ const e = iCameEntry(item); return e ? e.count || 0 : 0; }

function iCameCooldownLeft(item){
  const e = iCameEntry(item);
  const cd = iCameCooldownMs();
  if(!e || !e.last || !cd) return 0;
  return Math.max(0, e.last + cd - Date.now());
}
function formatCooldown(ms){
  const mins = Math.ceil(ms / 60000);
  const h = Math.floor(mins / 60), m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function cooldownLabel(){
  const h = Number(state.iCameSettings.cooldownHours) || 0;
  if(h <= 0) return 'as often as you like';
  return `once every ${h === 1 ? 'hour' : h + ' hours'}`;
}

function normalizeICameTarget(raw){
  if(!raw || typeof raw !== 'object') return null;
  let x = Number(raw.x), y = Number(raw.y), w = Number(raw.w), h = Number(raw.h);
  if(!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h)) return null;
  const safeW = clampNum(w, 0.08, 1);
  const safeH = clampNum(h, 0.08, 1);
  const safeX = clampNum(x, 0, Math.max(0, 1 - safeW));
  const safeY = clampNum(y, 0, Math.max(0, 1 - safeH));
  return { x: +safeX.toFixed(4), y: +safeY.toFixed(4), w: +safeW.toFixed(4), h: +safeH.toFixed(4) };
}
function resolveICameTargetPreset(key){
  const next = (key && ICAME_BODY_PART_PRESETS[key]) ? key : 'custom';
  return ICAME_BODY_PART_PRESETS[next] ? next : 'custom';
}
function preferredICameTarget(){
  if(!state.iCameSettings || state.iCameSettings.targetMode !== 'specific') return null;
  const presetKey = resolveICameTargetPreset(state.iCameSettings.targetPreset);
  if(presetKey !== 'custom') return normalizeICameTarget(ICAME_BODY_PART_PRESETS[presetKey]) || null;
  return normalizeICameTarget(state.iCameSettings.target) || normalizeICameTarget(ICAME_DEFAULTS.target) || null;
}
function iCameTargetForItem(item){
  const e = iCameEntry(item);
  if(!e) return preferredICameTarget();
  return normalizeICameTarget(e.target) || preferredICameTarget();
}
function setICameTargetForItem(item, target){
  if(!item) return;
  const key = favKey(item);
  const e = state.iCame[key] || { count: 0, first: Date.now(), last: 0, splats: [] };
  const next = normalizeICameTarget(target);
  if(next){ e.target = next; }
  else { delete e.target; }
  state.iCame[key] = e;
  saveICame();
  renderFocusSplats(item);
  if(typeof renderViewerSplats === 'function') renderViewerSplats(item);
  if(typeof renderImageGrid === 'function') renderImageGrid();
}
function targetAreaRect(target, width, height){
  const tw = target ? Math.max(0, width * target.w) : width;
  const th = target ? Math.max(0, height * target.h) : height;
  const tx = target ? (width * target.x) : 0;
  const ty = target ? (height * target.y) : 0;
  return { left: tx, top: ty, width: tw, height: th };
}
function newSplat(existing, target = null){
  const preferred = target || preferredICameTarget();
  let best = null, bestGap = -1;
  for(let i = 0; i < 8; i++){
    const x = preferred ? preferred.x + Math.random() * preferred.w : (0.1 + Math.random() * 0.8);
    const y = preferred ? preferred.y + Math.random() * preferred.h : (0.1 + Math.random() * 0.8);
    const gap = (existing || []).reduce((g, p) => Math.min(g, Math.hypot(p.x - x, p.y - y)), 9);
    if(gap > bestGap){ bestGap = gap; best = { x, y }; }
    if(gap > 0.28) break;
  }
  const S = state.iCameSettings;
  return {
    x: +Math.min(0.98, Math.max(0.02, best.x)).toFixed(4),
    y: +Math.min(0.98, Math.max(0.02, best.y)).toFixed(4),
    s: +Math.min(0.9, (0.24 + Math.random() * 0.16) * S.size / 100).toFixed(3),
    r: Math.round(Math.random() * 360),
    a: +(Math.random() * Math.PI * 2).toFixed(3),
    seed: 1 + Math.floor(Math.random() * 1e9),
    dr: S.drips,
  };
}
function ensureSplats(entry){
  if(!entry) return false;
  if(!Array.isArray(entry.splats)) entry.splats = [];
  let changed = false;
  while(entry.splats.length < (entry.count || 0)){ entry.splats.push(newSplat(entry.splats, normalizeICameTarget(entry.target))); changed = true; }
  return changed;
}

/* counts the press; the splats themselves are created by iCameShoot */
function recordICame(item){
  if(!item || iCameCooldownLeft(item) > 0) return false;
  const key = favKey(item);
  const now = Date.now();
  const e = state.iCame[key] || { count: 0, first: now, last: 0, splats: [] };
  ensureSplats(e);
  e.count = (e.count || 0) + 1;
  e.last = now;
  state.iCame[key] = e;
  saveICame();
  updateICameCount();
  return true;
}

function iCameItems(){
  return [...state.images, ...state.snapshots]
    .filter(i => state.iCame[favKey(i)])
    .map(i => {
      const e = state.iCame[favKey(i)];
      return { ...i, _icameCount: e.count || 1, _icameLast: e.last || 0 };
    })
    .sort((a, b) => (b._icameCount - a._icameCount) || (b._icameLast - a._icameLast));
}

function updateICameCount(){
  const el = document.getElementById('iCameCount');
  if(el) el.textContent = Object.keys(state.iCame).length;
}

function ensureSplatLayer(){
  let layer = document.getElementById('focusSplatLayer');
  if(!layer){
    const wrap = document.getElementById('focusImgWrap');
    if(!wrap) return null;
    layer = document.createElement('div');
    layer.id = 'focusSplatLayer';
    layer.hidden = true;
    wrap.appendChild(layer);
  }
  return layer;
}

/* while a shot is in flight its splats stay hidden until their rope lands */
let splatHold = null; // { key, from, shown:Set<globalIndex> }

function renderFocusSplats(item = iCameFocusItem, animateNewest = false){
  const layer = ensureSplatLayer();
  if(!layer) return;
  ensureICameDefs();
  const img = document.getElementById('focusImg');
  const entry = item ? iCameEntry(item) : null;
  if(!state.iCameSettings.showSplats || !entry || !img || !img.clientWidth || !img.clientHeight){
    layer.hidden = true;
    layer.innerHTML = '';
    return;
  }
  if(ensureSplats(entry)) saveICame();

  const w = img.clientWidth, h = img.clientHeight, m = Math.min(w, h);
  layer.style.left = img.offsetLeft + 'px';
  layer.style.top = img.offsetTop + 'px';
  layer.style.width = w + 'px';
  layer.style.height = h + 'px';
  const shown = entry.splats.slice(-ICAME_MAX_SPLATS_SHOWN);
  const offset = entry.splats.length - shown.length;
  const hold = splatHold && splatHold.key === favKey(item) ? splatHold : null;
  const draft = item && iCameFocusItem && favKey(item) === favKey(iCameFocusItem) && iCameTargetSelection && iCameTargetSelection.draft ? iCameTargetSelection.draft : null;
  const target = draft || iCameTargetForItem(item);
  const targetMarkup = target ? `<div class="icame-target-box" style="left:${(target.x * w).toFixed(1)}px;top:${(target.y * h).toFixed(1)}px;width:${(target.w * w).toFixed(1)}px;height:${(target.h * h).toFixed(1)}px"></div>` : '';
  layer.innerHTML = shown.map((p, i) => {
    const gi = offset + i;
    const hidden = !!(hold && gi >= hold.from && !hold.shown.has(gi));
    const px = Math.max(18, p.s * m);
    const isNew = animateNewest && i === shown.length - 1;
    return `<svg class="icame-splat${isNew ? ' is-new' : ''}${hidden ? ' is-hidden' : ''}" data-i="${gi}" viewBox="0 0 100 100" style="left:${(p.x * w - px / 2).toFixed(1)}px;top:${(p.y * h - px / 2).toFixed(1)}px;width:${px.toFixed(1)}px;height:${px.toFixed(1)}px${hidden ? ';visibility:hidden' : ''}">${splatInner(p, gi)}</svg>`;
  }).join('') + targetMarkup;
  layer.hidden = false;
}
let splatLayoutQueued = false;
function queueSplatLayout(){
  if(splatLayoutQueued) return;
  splatLayoutQueued = true;
  requestAnimationFrame(() => { splatLayoutQueued = false; renderFocusSplats(); });
}
(function bindSplatLayout(){
  const img = document.getElementById('focusImg');
  if(!img) return;
  img.addEventListener('load', queueSplatLayout);
  if('ResizeObserver' in window) new ResizeObserver(queueSplatLayout).observe(img);
  window.addEventListener('resize', queueSplatLayout);
})();

function revealSplat(item, gi){
  if(splatHold) splatHold.shown.add(gi);
  if(!iCameFocusItem || favKey(iCameFocusItem) !== favKey(item)) return;
  const el = document.querySelector(`#focusSplatLayer .icame-splat[data-i="${gi}"]`);
  if(el){ el.style.visibility = ''; el.classList.remove('is-hidden'); el.classList.add('is-new'); }
}

/* --------------------------------------------------------------------------
   The shot.
   Each rope is a chain of particles on a gravity arc. Particles differ in
   size (thick head → noisy, thinning body → tiny trailing beads) and in
   speed, so the rope stretches in flight. Neighbouring particles are joined by
   thin threads that get thinner as they stretch and finally snap, like
   surface-tension liquid. Ropes are fired strictly one after another.
   -------------------------------------------------------------------------- */
function iCameShoot(originEl, item){
  const key = favKey(item);
  const entry = iCameEntry(item);
  const img = document.getElementById('focusImg');
  if(!entry) return;
  const S = state.iCameSettings;
  const target = iCameTargetForItem(item);
  const reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const box = img ? img.getBoundingClientRect() : null;
  const sb = originEl ? originEl.getBoundingClientRect() : null;
  const ox = sb ? sb.left + sb.width / 2 : innerWidth / 2;
  const oy = sb ? sb.top + sb.height / 2 : innerHeight / 2;
  const clamp01 = v => Math.min(0.95, Math.max(0.05, v));
  const sizeF = S.size / 100, amountF = S.amount / 100;

  /* 1) plan the ropes */
  let n = Math.round(S.ropes);
  if(S.ropesRandom) n += Math.round((Math.random() - 0.5) * 3) + (Math.random() < 0.3 ? 1 : 0);
  n = Math.max(1, Math.min(12, n));
  const first = entry.splats.length;
  const plans = [];
  for(let i = 0; i < n; i++){
    const power = Math.min(1.1, Math.max(0.35, 1 - (i / n) * 0.55 + (Math.random() - 0.5) * 0.3));
    const spot = newSplat([...entry.splats, ...plans.map(p => p.splat)], target);
    const dir = Math.random() * Math.PI * 2;
    const len = 0.05 + Math.random() * 0.1;
    const x0 = clamp01(spot.x - Math.cos(dir) * len / 2), y0 = clamp01(spot.y - Math.sin(dir) * len / 2);
    const x1 = clamp01(spot.x + Math.cos(dir) * len / 2), y1 = clamp01(spot.y + Math.sin(dir) * len / 2);
    spot.x = +((x0 + x1) / 2).toFixed(4);
    spot.y = +((y0 + y1) / 2).toFixed(4);
    spot.s = +Math.min(0.9, (0.2 + 0.16 * power) * sizeF).toFixed(3);
    if(box){
      const cx = box.left + spot.x * box.width, cy = box.top + spot.y * box.height;
      spot.a = +(Math.atan2(cy - oy, cx - ox) + (Math.random() - 0.5) * 0.7).toFixed(3);
    }
    plans.push({ power, splat: spot, x0, y0, x1, y1, curve: (Math.random() - 0.5) * 0.07 });
  }
  plans.forEach(p => entry.splats.push(p.splat));
  saveICame();

  if(!box || !box.width || reduced || !S.showSplats){
    renderFocusSplats(item, true);
    return;
  }

  splatHold = { key, from: first, shown: new Set() };
  renderFocusSplats(item);
  ensureICameDefs();

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const mk = (css) => {
    const c = document.createElement('canvas');
    c.width = innerWidth * dpr; c.height = innerHeight * dpr;
    c.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:100001;' + css;
    document.body.appendChild(c);
    const x = c.getContext('2d');
    x.scale(dpr, dpr);
    x.lineCap = 'round'; x.lineJoin = 'round';
    return { c, x };
  };
  const body = mk('filter:url(#icameGoo)');                // merged, opaque liquid
  const glint = mk('opacity:.9');                          // specular glints on top
  const ctx = body.x, gx = glint.x;
  ctx.strokeStyle = ctx.fillStyle = '#ffffff';
  gx.strokeStyle = gx.fillStyle = '#ffffff';

  /* 2) build the particle chains on one timeline */
  const G = 2200;
  const spread = Math.min(box.width, box.height) * 0.012;
  const ropes = [];
  const splash = [];
  let cursor = 0;
  plans.forEach((pl, i) => {
    const count = Math.max(10, Math.round((26 + 26 * pl.power) * amountF * (0.85 + Math.random() * 0.3)));
    const dur = (0.16 + 0.15 * pl.power) * (0.8 + Math.random() * 0.4);
    const ph1 = Math.random() * 6.28, ph2 = Math.random() * 6.28, ph3 = Math.random() * 6.28;
    const aimX = box.left + (pl.x0 + pl.x1) / 2 * box.width, aimY = box.top + (pl.y0 + pl.y1) / 2 * box.height;
    const Tb = Math.min(0.75, Math.max(0.36, Math.hypot(aimX - ox, aimY - oy) / 1400)) + Math.random() * 0.05;
    const ddx = pl.x1 - pl.x0, ddy = pl.y1 - pl.y0, dl = Math.hypot(ddx, ddy) || 1;
    const perpx = -ddy / dl, perpy = ddx / dl;
    const baseW = 3.2 * Math.sqrt(amountF) * (0.7 + 0.4 * pl.power);
    const rope = { ps: [], landed: 0, gi: first + i };
    for(let k = 0; k < count; k++){
      const f = count > 1 ? k / (count - 1) : 0.5;
      const prof = f < 0.14 ? 1.25 : 1 - 0.55 * f;                       // fat head, thinning body
      const nz = 0.5 + 0.5 * (Math.sin(f * 9 + ph1) * 0.5 + Math.sin(f * 21 + ph2) * 0.3 + Math.sin(f * 47 + ph3) * 0.2);
      const bead = f > 0.82;                                             // trailing beads
      const w = Math.max(0.8, baseW * prof * (0.45 + 0.95 * nz) * (bead ? 0.5 : 1));
      const sc = spread * (bead ? 3.5 : 1);
      const sw = Math.sin(Math.PI * f) * pl.curve;
      const lx = box.left + (pl.x0 + ddx * f + perpx * sw) * box.width + (Math.random() - 0.5) * sc;
      const ly = box.top + (pl.y0 + ddy * f + perpy * sw) * box.height + (Math.random() - 0.5) * sc;
      const sx = ox + (Math.random() - 0.5) * 5, sy = oy + (Math.random() - 0.5) * 5;
      const T = Tb * (0.92 + 0.1 * f + (Math.random() - 0.5) * (bead ? 0.1 : 0.04));
      rope.ps.push({
        ts: cursor + dur * (f + 0.05 * Math.sin(f * 17 + ph2)),
        T, x0: sx, y0: sy,
        vx: (lx - sx) / T,
        vy: (ly - sy - 0.5 * G * T * T) / T,
        w, lx, ly, landed: false
      });
    }
    ropes.push(rope);
    cursor += dur + 0.28 + Math.random() * 0.45;                         // pause before the next rope
  });

  const finish = () => {
    ropes.forEach(r => revealSplat(item, r.gi));
    splatHold = null;
    body.c.remove(); glint.c.remove();
  };
  const failsafe = setTimeout(finish, Math.ceil((cursor + 3) * 1000));

  const start = performance.now();
  let prev = start, done = false;
  (function frame(now){
    if(done) return;
    const t = (now - start) / 1000, dt = Math.min(0.05, (now - prev) / 1000);
    prev = now;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    gx.clearRect(0, 0, innerWidth, innerHeight);
    let alive = false;

    for(const r of ropes){
      let last = null;
      for(const p of r.ps){
        const age = t - p.ts;
        if(age < 0){ alive = true; last = null; continue; }
        if(age >= p.T){
          if(!p.landed){
            p.landed = true;
            if(Math.random() < 0.3){
              splash.push({ x: p.lx, y: p.ly, vx: (Math.random() - 0.5) * 200, vy: -(50 + Math.random() * 140), r: 0.8 + Math.random() * 1.8, life: 0.25 + Math.random() * 0.12, age: 0 });
            }
            if(++r.landed === 1) revealSplat(item, r.gi);                 // splat appears only once the rope touches
          }
          last = { x: p.lx, y: p.ly, w: p.w * 0.6 };
          continue;
        }
        alive = true;
        const x = p.x0 + p.vx * age;
        const y = p.y0 + p.vy * age + 0.5 * G * age * age;
        const vy = p.vy + G * age;
        let sdx = p.vx * 0.022, sdy = vy * 0.022;
        const sl = Math.hypot(sdx, sdy);
        if(sl > 60){ sdx *= 60 / sl; sdy *= 60 / sl; }
        const lw = p.w * (1 - 0.3 * age / p.T);
        ctx.lineWidth = lw;
        ctx.beginPath(); ctx.moveTo(x - sdx, y - sdy); ctx.lineTo(x, y); ctx.stroke();
        gx.lineWidth = Math.max(0.6, lw * 0.28);
        gx.globalAlpha = 0.55;
        gx.beginPath(); gx.moveTo(x - sdx - lw * 0.18, y - sdy - lw * 0.18); gx.lineTo(x - lw * 0.18, y - lw * 0.18); gx.stroke();
        if(last){
          const d = Math.hypot(x - last.x, y - last.y);
          const link = 22 + p.w * 5;
          if(d < link){
            ctx.lineWidth = Math.max(0.5, Math.min(p.w, last.w) * (1 - d / link) * 0.95);
            ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(x, y); ctx.stroke();
          }
        }
        last = { x, y, w: lw };
      }
    }

    for(let i = splash.length - 1; i >= 0; i--){
      const s = splash[i];
      s.age += dt; s.vy += 1400 * dt; s.x += s.vx * dt; s.y += s.vy * dt;
      if(s.age >= s.life){ splash.splice(i, 1); continue; }
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r * (1 - s.age / s.life), 0, Math.PI * 2); ctx.fill();
    }

    if(alive || splash.length) requestAnimationFrame(frame);
    else { done = true; clearTimeout(failsafe); finish(); }
  })(start);
}

let iCameFocusItem = null;
function refreshICameButton(item = iCameFocusItem){
  const btn = document.getElementById('focusICameBtn');
  if(!btn || !item) return;
  const count = iCameCount(item);
  const left = iCameCooldownLeft(item);
  const countTxt = count ? ` ×${count}` : '';
  let label;
  if(left > 0){
    btn.disabled = true;
    btn.classList.add('is-cooling');
    label = `I came${countTxt} · again in ${formatCooldown(left)}`;
    btn.title = `You can press this ${cooldownLabel()} per photo`;
  } else {
    btn.disabled = false;
    btn.classList.remove('is-cooling');
    label = `I came${countTxt}`;
    btn.title = count ? `Pressed ${count} time${count === 1 ? '' : 's'} — press again to rank it higher` : 'Add this photo to "I came"';
  }
  btn.innerHTML = icameIconSVG(18) + '<span class="icame-label">' + label + '</span>';
}

let iCameTargetSelection = { active: false, draft: null };
function ensureICameTargetButton(){
  const actions = document.querySelector('.focus-actions');
  if(!actions) return null;
  let btn = document.getElementById('focusICameTargetBtn');
  if(!btn){
    btn = document.createElement('button');
    btn.id = 'focusICameTargetBtn';
    btn.type = 'button';
    btn.className = 'btn btn-sm';
    btn.title = 'Set the area where this photo gets splattered';
    btn.textContent = 'Target';
    const ref = document.getElementById('focusICameBtn');
    if(ref) actions.insertBefore(btn, ref.nextSibling);
    else actions.appendChild(btn);
  }
  return btn;
}
function bindICameTargetSelection(){
  const img = document.getElementById('focusImg');
  if(!img || img._icameAreaBound) return;
  img._icameAreaBound = true;
  const btn = ensureICameTargetButton();
  const mode = document.getElementById('iCameTargetMode');
  if(!btn) return;
  btn.onclick = () => {
    iCameTargetSelection.active = !iCameTargetSelection.active;
    btn.classList.toggle('is-active', iCameTargetSelection.active);
    btn.textContent = iCameTargetSelection.active ? 'Targeting' : 'Target';
    if(!iCameTargetSelection.active){
      iCameTargetSelection.draft = null;
      renderFocusSplats(iCameFocusItem);
      toast('Target mode off');
      return;
    }
    iCameTargetSelection.draft = iCameTargetForItem(iCameFocusItem) || { x: 0.22, y: 0.22, w: 0.56, h: 0.42 };
    toast('Drag on the photo to set the splash area');
    renderFocusSplats(iCameFocusItem);
  };
  img.addEventListener('pointerdown', (event) => {
    if(!iCameTargetSelection.active || !iCameFocusItem) return;
    const rect = img.getBoundingClientRect();
    const nx = clampNum((event.clientX - rect.left) / rect.width, 0, 1);
    const ny = clampNum((event.clientY - rect.top) / rect.height, 0, 1);
    iCameTargetSelection.draft = { x: nx, y: ny, w: 0.08, h: 0.08 };
    img.setPointerCapture?.(event.pointerId);
    renderFocusSplats(iCameFocusItem);
  });
  img.addEventListener('pointermove', (event) => {
    if(!iCameTargetSelection.active || !iCameTargetSelection.draft || !iCameFocusItem) return;
    const rect = img.getBoundingClientRect();
    const nx = clampNum((event.clientX - rect.left) / rect.width, 0, 1);
    const ny = clampNum((event.clientY - rect.top) / rect.height, 0, 1);
    const sx = iCameTargetSelection.draft.x;
    const sy = iCameTargetSelection.draft.y;
    const w = Math.max(0.08, Math.abs(nx - sx));
    const h = Math.max(0.08, Math.abs(ny - sy));
    iCameTargetSelection.draft = {
      x: Math.min(sx, nx),
      y: Math.min(sy, ny),
      w: Math.min(1, w),
      h: Math.min(1, h),
    };
    renderFocusSplats(iCameFocusItem);
  });
  img.addEventListener('pointerup', (event) => {
    if(!iCameTargetSelection.active || !iCameFocusItem) return;
    const rect = img.getBoundingClientRect();
    const nx = clampNum((event.clientX - rect.left) / rect.width, 0, 1);
    const ny = clampNum((event.clientY - rect.top) / rect.height, 0, 1);
    const sx = iCameTargetSelection.draft ? iCameTargetSelection.draft.x : nx;
    const sy = iCameTargetSelection.draft ? iCameTargetSelection.draft.y : ny;
    const w = Math.max(0.08, Math.abs(nx - sx));
    const h = Math.max(0.08, Math.abs(ny - sy));
    const next = normalizeICameTarget({ x: Math.min(sx, nx), y: Math.min(sy, ny), w: Math.min(1, w), h: Math.min(1, h) });
    if(next){
      state.iCameSettings.target = next;
      state.iCameSettings.targetMode = 'specific';
      saveICameSettings();
      if(mode) mode.value = 'specific';
      setICameTargetForItem(iCameFocusItem, next);
      toast('Preferred target area updated');
    }
    iCameTargetSelection.active = false;
    iCameTargetSelection.draft = null;
    btn.classList.remove('is-active');
    btn.textContent = 'Target';
    renderFocusSplats(iCameFocusItem);
  });
}
function bindICameButton(item){
  const btn = document.getElementById('focusICameBtn');
  if(!btn) return;
  iCameFocusItem = item;
  btn.onclick = () => {
    if(!recordICame(item)){
      toast(`Available again in ${formatCooldown(iCameCooldownLeft(item))}`);
      refreshICameButton(item);
      return;
    }
    refreshICameButton(item);
    iCameShoot(btn, item);
    const n = iCameCount(item);
    toast(n === 1 ? 'Added to “I came”' : `Ranked up — ×${n}`);
  };
  refreshICameButton(item);
  renderFocusSplats(item);
  queueSplatLayout();
  bindICameTargetSelection();
}

setInterval(() => {
  const focus = document.getElementById('imageFocus');
  if(focus && !focus.hidden && iCameFocusItem) refreshICameButton(iCameFocusItem);
}, 30000);

function bindICameSidebar(){
  const btn = document.querySelector('.cat-item[data-special="icame"]');
  if(!btn) return;
  btn.classList.toggle('active', state.cat.images === ICAME_CAT && state.tab === 'images');
  btn.onclick = () => {
    setTab('images', { skipRender: true });
    state.cat.images = ICAME_CAT;
    document.querySelectorAll('#categoryList .cat-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.sidebar .cat-item[data-special]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    closeMobileShell();
    goToGrid('images');
  };
}

function clearICameSplatters(){
  const before = Object.keys(state.iCame || {}).length;
  state.iCame = {};
  splatHold = null;
  saveICame();
  updateICameCount();
  renderFocusSplats();
  if(typeof renderImageGrid === 'function') renderImageGrid();
  toast(before > 0 ? 'All photo splatters and counts cleared' : 'No photo splatters to clear');
  return before;
}

/* ---------- settings UI ---------- */
const ICAME_CONTROLS = [
  // [inputId, settingKey, valueLabelId, suffix, eventName]
  ['iCameRopesInput',  'ropes',  null,             '',  'change'],
  ['iCameAmountInput', 'amount', 'iCameAmountVal', '%', 'input'],
  ['iCameSizeInput',   'size',   'iCameSizeVal',   '%', 'input'],
  ['iCameDripsInput',  'drips',  'iCameDripsVal',  '%', 'input'],
];
function syncICameControls(){
  const S = state.iCameSettings;
  ICAME_CONTROLS.forEach(([id, key, lab, suf]) => {
    const el = document.getElementById(id);
    if(el) el.value = S[key];
    const l = lab && document.getElementById(lab);
    if(l) l.textContent = S[key] + suf;
  });
  const rr = document.getElementById('iCameRopesRandomToggle');
  if(rr) rr.checked = !!S.ropesRandom;
  const mode = document.getElementById('iCameTargetMode');
  if(mode) mode.value = S.targetMode === 'specific' ? 'specific' : 'anywhere';
  const preset = document.getElementById('iCameTargetPreset');
  if(preset){
    const key = resolveICameTargetPreset(S.targetPreset || 'custom');
    preset.value = key;
    preset.disabled = !(S.targetMode === 'specific');
  }
}

function bindICameSettings(){
  const cd = document.getElementById('iCameCooldownInput');
  const tg = document.getElementById('iCameSplatToggle');
  const mode = document.getElementById('iCameTargetMode');
  const preset = document.getElementById('iCameTargetPreset');
  const targetBtn = document.getElementById('iCameSetTargetBtn');
  const clearTargetBtn = document.getElementById('iCameClearTargetBtn');
  const clearBtn = document.getElementById('iCameClearSplattersBtn');
  const rr = document.getElementById('iCameRopesRandomToggle');
  const resetBtn = document.getElementById('iCameResetLookBtn');

  if(cd){
    cd.value = state.iCameSettings.cooldownHours;
    cd.addEventListener('change', () => {
      let h = parseFloat(cd.value);
      if(!isFinite(h) || h < 0) h = 0;
      h = Math.min(h, 24 * 365);
      state.iCameSettings.cooldownHours = h;
      cd.value = h;
      saveICameSettings();
      refreshICameButton();
      toast(h === 0 ? 'I came cooldown turned off' : `I came cooldown set to ${h} hour${h === 1 ? '' : 's'}`);
    });
  }
  if(tg){
    tg.checked = !!state.iCameSettings.showSplats;
    tg.addEventListener('change', () => {
      state.iCameSettings.showSplats = tg.checked;
      saveICameSettings();
      renderFocusSplats();
      if(typeof renderImageGrid === 'function') renderImageGrid();
      toast(tg.checked ? 'Splatters on photos: on' : 'Splatters on photos: off');
    });
  }
  if(mode){
    mode.value = state.iCameSettings.targetMode || 'anywhere';
    mode.addEventListener('change', () => {
      const next = mode.value === 'specific' ? 'specific' : 'anywhere';
      state.iCameSettings.targetMode = next;
      if(next === 'anywhere') state.iCameSettings.targetPreset = 'custom';
      saveICameSettings();
      syncICameControls();
      renderFocusSplats(iCameFocusItem);
      if(typeof renderImageGrid === 'function') renderImageGrid();
      toast(next === 'specific' ? 'Preferred cum area: specific' : 'Preferred cum area: anywhere');
    });
  }
  if(preset){
    preset.innerHTML = '';
    Object.keys(ICAME_BODY_PART_PRESETS).forEach(key => {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = ICAME_BODY_PART_PRESETS[key].label;
      preset.appendChild(option);
    });
    preset.value = resolveICameTargetPreset(state.iCameSettings.targetPreset || 'custom');
    preset.addEventListener('change', () => {
      state.iCameSettings.targetPreset = resolveICameTargetPreset(preset.value);
      if(state.iCameSettings.targetMode !== 'specific') state.iCameSettings.targetMode = 'specific';
      if(mode) mode.value = 'specific';
      saveICameSettings();
      syncICameControls();
      renderFocusSplats(iCameFocusItem);
      if(typeof renderImageGrid === 'function') renderImageGrid();
      const label = ICAME_BODY_PART_PRESETS[state.iCameSettings.targetPreset].label;
      toast(`Preferred cum area: ${label}`);
    });
  }
  if(targetBtn){
    targetBtn.addEventListener('click', () => {
      if(state.iCameSettings.targetMode !== 'specific') state.iCameSettings.targetMode = 'specific';
      if(mode) mode.value = 'specific';
      const item = iCameFocusItem || state.currentImage;
      if(preset && preset.value !== 'custom'){
        state.iCameSettings.targetPreset = resolveICameTargetPreset(preset.value);
        state.iCameSettings.target = { ...ICAME_BODY_PART_PRESETS[state.iCameSettings.targetPreset] };
        saveICameSettings();
        syncICameControls();
        renderFocusSplats(item);
        toast(`Preferred cum area set to ${ICAME_BODY_PART_PRESETS[state.iCameSettings.targetPreset].label}`);
        return;
      }
      saveICameSettings();
      if(item){
        iCameTargetSelection.active = true;
        iCameTargetSelection.draft = normalizeICameTarget(state.iCameSettings.target) || { x: 0.2, y: 0.22, w: 0.6, h: 0.5 };
        state.iCameSettings.targetPreset = 'custom';
        if(preset) preset.value = 'custom';
        toast('Drag on the current photo to set a custom cum area');
        renderFocusSplats(item);
      } else {
        toast('Open a photo first, then set its preferred cum area');
      }
    });
  }
  if(clearTargetBtn){
    clearTargetBtn.addEventListener('click', () => {
      state.iCameSettings.targetMode = 'anywhere';
      state.iCameSettings.targetPreset = 'custom';
      state.iCameSettings.target = { x: 0.18, y: 0.22, w: 0.64, h: 0.5 };
      if(mode) mode.value = 'anywhere';
      if(preset) preset.value = 'custom';
      saveICameSettings();
      syncICameControls();
      renderFocusSplats(iCameFocusItem || state.currentImage);
      toast('Preferred cum area cleared — shots will go anywhere');
    });
  }
  if(clearBtn){
    clearBtn.addEventListener('click', () => { clearICameSplatters(); });
  }
  ICAME_CONTROLS.forEach(([id, key, lab, suf, ev]) => {
    const el = document.getElementById(id);
    if(!el) return;
    el.addEventListener(ev, () => {
      let v = parseFloat(el.value);
      if(!isFinite(v)) v = ICAME_DEFAULTS[key];
      v = clampNum(v, ICAME_RANGES[key][0], ICAME_RANGES[key][1]);
      if(key === 'ropes') v = Math.round(v);
      state.iCameSettings[key] = v;
      if(ev === 'change') el.value = v;
      const l = lab && document.getElementById(lab);
      if(l) l.textContent = v + suf;
      saveICameSettings();
    });
  });
  if(rr){
    rr.addEventListener('change', () => {
      state.iCameSettings.ropesRandom = rr.checked;
      saveICameSettings();
    });
  }
  if(resetBtn){
    resetBtn.addEventListener('click', () => {
      ['ropes', 'ropesRandom', 'amount', 'size', 'drips', 'targetMode', 'targetPreset', 'target'].forEach(k => {
        if(k === 'target') state.iCameSettings[k] = { ...ICAME_DEFAULTS.target };
        else if(k === 'targetPreset') state.iCameSettings[k] = ICAME_DEFAULTS.targetPreset;
        else state.iCameSettings[k] = ICAME_DEFAULTS[k];
      });
      saveICameSettings();
      syncICameControls();
      toast('Cum look reset to defaults');
    });
  }
  syncICameControls();
}
ensureICameDefs();
paintICameIcons();
bindICameSettings();