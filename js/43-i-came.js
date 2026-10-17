/* ==========================================================================
   js/43-i-came.js  —  "I came" (Focus view)
   Fluid model (v2):
   - EMITTER      : each press fires several ropes. A rope is a chain of parcels with
                    pulsed flow, a fat head, thinning body and a beaded tail. Direction
                    wobbles slowly, speed varies parcel to parcel, so the jet stretches.
   - LINKS        : neighbouring parcels are joined by threads that neck down as they
                    stretch and snap at a viscosity-dependent length (thin = early).
                    Snapping can leave a tiny satellite droplet in flight.
   - CONTACT      : a parcel "hits" when its flight time ends. Only then is the deposit
                    revealed; it grows while the rest of the rope keeps landing.
   - DEPOSITS     : central patch area follows the volume actually delivered; spread and
                    elongation follow impact speed + material. Far-flung droplets become
                    their own tiny deposits. Tiny volumes give droplets only.
   - SATELLITES   : variable count / radius / distance / direction around each deposit.
   - DRIPS        : optional, driven by volume, material and surface tilt; irregular onset,
                    speed, width and length; some narrow and pinch off a bead.
   - Everything is seeded per press (photo + press count) so a press is reproducible.
   Realistic mode (settings → "Realistic fluid (shaders)") swaps the drawing for a WebGL2
   fluid shader: refraction of the photo underneath, hue shift / tint, subsurface scatter,
   Fresnel + specular gloss and contact shadows. See the REALISTIC MODE section below.
   Tunables: ICAME_MATERIALS, ICAME_PHYS and the settings panel (ropes, amount, size,
   drips, fluid type, realistic look).
   ========================================================================== */
const ICAME_KEY = 'reelframe-i-came-v1';
const ICAME_SETTINGS_KEY = 'reelframe-i-came-settings-v1';
const ICAME_CAT = '__icame__';
const ICAME_DEFAULT_COOLDOWN_HOURS = 8;
const ICAME_MAX_SPLATS_SHOWN = 80;

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

/* Fluid presets. visc 0..1 (thin → thick). Every emission uses ONE preset throughout.
   breakLen : thread length multiplier before it snaps (low = breaks up early)
   spread   : how far a deposit spreads on impact      ragged : boundary irregularity
   sat      : satellite-droplet multiplier              dripSpeed / dripLen : drip behaviour
   opacity  : 0.7 = translucent, 1 = opaque              sheen : highlight strength        */
const ICAME_MATERIALS = {
  watery: { label: 'Watery / thin',    visc: 0.15, opacity: 0.62, color: '#eceff0', goo: 0, breakLen: 0.70, spread: 1.35, ragged: 1.40, sat: 1.6, dripSpeed: 1.7,  dripLen: 1.2, sheen: 0.5 },
  medium: { label: 'Medium',           visc: 0.50, opacity: 0.93, color: '#f1eee5', goo: 1, breakLen: 1.05, spread: 1.00, ragged: 1.00, sat: 1.0, dripSpeed: 1.0,  dripLen: 1.0, sheen: 0.7 },
  thick:  { label: 'Thick / opaque',   visc: 0.85, opacity: 1.00, color: '#f5f2e9', goo: 1, breakLen: 1.70, spread: 0.72, ragged: 0.65, sat: 0.5, dripSpeed: 0.45, dripLen: 0.7, sheen: 0.9 }
};
/* gravity in screen px/s² ; tilt: 1 = vertical surface (drips run), 0 = flat (no drips) */
const ICAME_PHYS = { gravity: 1700, tilt: 1 };
/* false = no outline / rim shading around deposits (set true to bring it back) */
const ICAME_OUTLINE = false;

/* Wateriness is continuous: 0 = thick, 0.5 = medium, 1 = watery. Old string keys still work. */
const ICAME_WATERY_OF = { thick: 0.1, medium: 0.5, watery: 0.9 };
const icameMatCache = new Map();
function hexLerp(a, b, t){
  const p = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const A = p(a), B = p(b);
  return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('');
}
function icameMaterial(m){
  let w = typeof m === 'number' ? m : (ICAME_WATERY_OF[m] != null ? ICAME_WATERY_OF[m] : 0.5);
  w = Math.round(clampNum(w, 0, 1) * 100) / 100;
  let c = icameMatCache.get(w);
  if(c) return c;
  const lo = w <= 0.5 ? ICAME_MATERIALS.thick : ICAME_MATERIALS.medium;
  const hi = w <= 0.5 ? ICAME_MATERIALS.medium : ICAME_MATERIALS.watery;
  const t = w <= 0.5 ? w / 0.5 : (w - 0.5) / 0.5;
  c = { label: 'Custom' };
  ['visc', 'opacity', 'breakLen', 'spread', 'ragged', 'sat', 'dripSpeed', 'dripLen', 'sheen'].forEach(k => { c[k] = lo[k] + (hi[k] - lo[k]) * t; });
  c.color = hexLerp(lo.color, hi.color, t);
  c.goo = w < 0.7 ? 1 : 0;
  icameMatCache.set(w, c);
  return c;
}

/* Presets (apply to the sliders; "Cum by age" then scales on top of them) */
const ICAME_PRESETS = {
  normal:   { label: 'Normal',            ropes: 4,  amount: 100, size: 100, drips: 70, watery: 50 },
  light:    { label: 'Light',             ropes: 3,  amount: 55,  size: 80,  drips: 30, watery: 55 },
  heavy:    { label: 'Heavy',             ropes: 7,  amount: 170, size: 120, drips: 85, watery: 35 },
  watery:   { label: 'Watery',            ropes: 5,  amount: 100, size: 110, drips: 85, watery: 90 },
  thick:    { label: 'Thick & sticky',    ropes: 4,  amount: 110, size: 90,  drips: 35, watery: 8 },
  dribble:  { label: 'Dribble',           ropes: 2,  amount: 30,  size: 60,  drips: 60, watery: 70 },
  marathon: { label: 'Marathon',          ropes: 10, amount: 200, size: 130, drips: 80, watery: 45 }
};

/* Cum by age: rough, approximate curves relative to a young adult (not medical data).
   Volume, number of strong spurts and force all trend down with age; thinner with age. */
function icameCurve(x, pts){
  if(x <= pts[0][0]) return pts[0][1];
  for(let i = 1; i < pts.length; i++){
    if(x <= pts[i][0]){ const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]; return y0 + (y1 - y0) * (x - x0) / (x1 - x0); }
  }
  return pts[pts.length - 1][1];
}
function icameAgeFactors(age){
  return {
    vol:   icameCurve(age, [[18, 1], [25, 1], [35, 0.93], [45, 0.85], [55, 0.75], [65, 0.62], [75, 0.5], [90, 0.35], [100, 0.3]]),
    ropes: icameCurve(age, [[18, 1], [30, 0.95], [40, 0.82], [50, 0.68], [60, 0.55], [70, 0.42], [85, 0.3], [100, 0.25]]),
    force: icameCurve(age, [[18, 1], [30, 0.95], [40, 0.85], [50, 0.72], [60, 0.6], [70, 0.5], [100, 0.35]]),
    water: 0.12 * clampNum((age - 25) / 50, 0, 1)
  };
}
/* the values a press actually uses (settings, scaled by age when "Cum by age" is on) */
function icameEffective(){
  const S = state.iCameSettings;
  const E = { ropes: S.ropes, amount: S.amount, watery: clampNum(S.watery / 100, 0, 1), force: 1 };
  if(S.ageMode && S.age >= 18){
    const f = icameAgeFactors(S.age);
    E.ropes = Math.max(1, Math.round(S.ropes * f.ropes));
    E.amount = Math.max(10, S.amount * f.vol);
    E.watery = clampNum(E.watery + f.water, 0, 1);
    E.force = f.force;
  }
  return E;
}

const ICAME_DEFAULTS = { cooldownHours: ICAME_DEFAULT_COOLDOWN_HOURS, showSplats: true, ropes: 4, ropesRandom: true, amount: 100, size: 100, drips: 70, watery: 50, ageMode: false, age: 25, realistic: false, rRefract: 70, rTint: 60, rGloss: 70, targetMode: 'anywhere', targetPreset: 'custom', target: { x: 0.18, y: 0.22, w: 0.64, h: 0.5 } };
const ICAME_RANGES = { ropes: [1, 12], amount: [20, 250], size: [40, 250], drips: [0, 100], watery: [0, 100], rRefract: [0, 150], rTint: [0, 100], rGloss: [0, 100] };

function clampNum(v, lo, hi){ return Math.min(hi, Math.max(lo, v)); }

function mulberry32(a){
  return function(){
    let t = (a += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function icameSeed(key, entry){
  const s = key + '|' + (entry.count || 0) + '|' + (entry.first || 0);
  let h = 2166136261;
  for(let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/* drip progress profiles: [percent, tail scale]; plateaus = the drip stalling (shared by CSS + realistic mode) */
const ICAME_DRIP_PROFILES = [
    [[0, .04], [18, .12], [34, .5], [46, .52], [58, .55], [100, 1]],
    [[0, .04], [10, .3], [26, .34], [70, .9], [78, .92], [100, 1]],
    [[0, .04], [55, .2], [62, .6], [68, .62], [100, 1]],
    [[0, .04], [8, .15], [40, .45], [52, .47], [85, .95], [100, 1]],
    [[0, .04], [30, .2], [36, .58], [40, .6], [74, .8], [100, 1]],
    [[0, .04], [14, .4], [22, .43], [36, .6], [52, .64], [64, .92], [100, 1]],
  ];

/* ---------- injected styles (no stylesheet edits needed) ---------- */
(function injectICameStyle(){
  if(document.getElementById('icame-style')) return;
  const profiles = ICAME_DRIP_PROFILES;
  let kf = '';
  profiles.forEach((pr, i) => {
    kf += `@keyframes icameTail${i}{${pr.map(([t, s]) => `${t}%{transform:scaleY(${s})}`).join('')}}`;
    kf += `@keyframes icameBulb${i}{${pr.map(([t, s]) => `${t}%{transform:translateY(calc(var(--len) * ${(-(1 - s)).toFixed(2)}))}`).join('')}}`;
  });
  kf += `@keyframes icameDet{0%,80%{opacity:0;transform:translateY(calc(var(--gap) * -1))}86%{opacity:1}100%{opacity:1;transform:translateY(0)}}`;
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
.icame-splat.is-new .icame-drip .dd{ animation:icameDet var(--dur) var(--dl) cubic-bezier(.4,0,.8,1) both; }
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
    <filter id="icameGooFine" color-interpolation-filters="sRGB"><feGaussianBlur in="SourceGraphic" stdDeviation="1.0" result="b"/><feColorMatrix in="b" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 14 -4.5"/></filter>
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

/* ==========================================================================
   DEPOSIT + SATELLITE + DRIP GEOMETRY (100x100 box, absolute size set by splat.s)
   seed/ang/dripAmt as before; o = { v: volume, sp: impact speed 0..1.2,
   m: material key, el: elongation }.  Old saved splats without o still render.
   ========================================================================== */
function angDiff(a, b){ const d = a - b; return Math.atan2(Math.sin(d), Math.cos(d)); }

function splatShapes(seed, ang, dripAmt, o){
  o = o || {};
  const rand = mulberry32(seed);
  const f = v => v.toFixed(1);
  const mat = icameMaterial(o.m);
  const vol = o.v != null ? o.v : 0.8;
  const sp = o.sp != null ? o.sp : 0.5;
  const a = typeof ang === 'number' ? ang : rand() * Math.PI * 2;
  const cx = 50, cy = 50;
  const ux = Math.cos(a), uy = Math.sin(a);
  const el = o.el != null ? o.el : 1 + 0.45 * sp * (1 - mat.visc * 0.5);
  const shapes = [], hl = [], drips = [];
  const geo = { items: [], drips: [] };   // same shapes as data, for the realistic renderer
  const hasCore = vol > 0.09;
  let R = 0, pts = null;

  if(hasCore){
    /* ---- central deposit: irregular boundary (3 octaves + a few fingers) ---- */
    R = 7 + 5 * Math.min(1, vol / 0.5) + rand() * 3;
    const N = 30, rg = mat.ragged;
    const ph = [rand() * 6.28, rand() * 6.28, rand() * 6.28, rand() * 6.28];
    const nf = Math.floor(rand() * (1 + 3 * rg * (0.4 + sp)));
    const fingers = [];
    for(let i = 0; i < nf; i++) fingers.push({ th: a + (rand() - 0.5) * 2.4 + (rand() < 0.3 ? Math.PI : 0), len: (0.2 + rand() * 0.55) * rg * (0.5 + sp), wid: 0.18 + rand() * 0.25 });
    pts = [];
    for(let i = 0; i < N; i++){
      const th = i / N * Math.PI * 2;
      let wob = 1 + rg * (0.10 * Math.sin(3 * th + ph[0]) + 0.07 * Math.sin(5 * th + ph[1]) + 0.05 * Math.sin(9 * th + ph[2]) + 0.03 * Math.sin(14 * th + ph[3]));
      for(const fg of fingers){ const d = angDiff(th, fg.th); wob += fg.len * Math.exp(-(d / fg.wid) * (d / fg.wid)); }
      const c = Math.cos(th - a);
      const r = R * wob * (1 + (el - 1) * c * c) / (1 + (el - 1) * 0.3);
      pts.push([cx + Math.cos(th) * r, cy + Math.sin(th) * r]);
    }
    const dCore = smoothClosedPath(pts);
    shapes.push(`<path d="${dCore}"/>`);
    geo.items.push({ d: dCore, th: 0.55 + 0.45 * Math.min(1, vol / 0.8) });

    /* merged secondary lobes: only bigger volumes arrive in several pulses */
    const lobes = vol > 0.45 ? Math.min(3, 1 + Math.floor(rand() * (1 + vol))) : 0;
    for(let l = 0; l < lobes; l++){
      const th0 = a + (rand() - 0.5) * 3.2;
      const dd = R * (0.7 + rand() * 0.8);
      const lx = cx + Math.cos(th0) * dd, ly = cy + Math.sin(th0) * dd;
      const lr = R * (0.28 + rand() * 0.3), ph2 = rand() * 6.28, q = [];
      for(let i = 0; i < 9; i++){
        const th = i / 9 * Math.PI * 2, w = 1 + 0.22 * Math.sin(3 * th + ph2);
        q.push([lx + Math.cos(th) * lr * w, ly + Math.sin(th) * lr * w * 0.85]);
      }
      const dLobe = smoothClosedPath(q);
      shapes.push(`<path d="${dLobe}"/>`);
      geo.items.push({ d: dLobe, th: 0.5 + 0.4 * Math.min(1, vol / 0.8) });
    }
  } else {
    /* tiny volume: an isolated droplet (slightly squashed along the shot) */
    const r = 2.4 + Math.sqrt(Math.max(0, vol)) * 14;
    const sx = r * (1 + 0.25 * sp * rand() + 0.1), sy = r * (0.85 + rand() * 0.2);
    shapes.push(`<ellipse cx="${cx}" cy="${cy}" rx="${f(sx)}" ry="${f(sy)}" transform="rotate(${f(a * 180 / Math.PI)} ${cx} ${cy})"/>`);
    geo.items.push({ e: [cx, cy, sx, sy, a], th: 0.5 });
  }

  /* ---- satellites: many tiny, few mid-sized; varied distance & direction ---- */
  const base = hasCore ? Math.sqrt(vol) * (1.5 + 6 * sp) * rand() : rand() * 2;
  const ns = Math.round(mat.sat * base);
  const R0 = hasCore ? R : 4;
  for(let i = 0; i < ns; i++){
    const th = rand() < 0.65 ? a + (rand() - 0.5) * (1.6 + 1.2 * (1 - sp)) : rand() * Math.PI * 2;
    const dist = R0 * (1.25 + Math.pow(rand(), 1.4) * (0.9 + 1.8 * sp * (1 - mat.visc * 0.6)));
    const r = 0.5 + Math.pow(rand(), 2.6) * 3.2 * (0.6 + Math.min(1, vol) * 0.6);
    const sx = clampNum(cx + Math.cos(th) * dist, 3, 97), sy = clampNum(cy + Math.sin(th) * dist, 3, 97);
    const rot = th * 180 / Math.PI;
    const rxs = r * (1 + sp * rand() * 0.9);
    shapes.push(`<ellipse cx="${f(sx)}" cy="${f(sy)}" rx="${f(rxs)}" ry="${f(r)}" transform="rotate(${f(rot)} ${f(sx)} ${f(sy)})"/>`);
    geo.items.push({ e: [sx, sy, rxs, r, th], th: 0.35 + 0.3 * Math.min(1, r / 3) });
    if(r > 1.3 && rand() < 0.4){   // tadpole tail pointing back toward the deposit
      const tx = sx - Math.cos(th) * r * 2.6, ty = sy - Math.sin(th) * r * 2.6;
      const dTad = `M${f(sx + Math.sin(th) * r * 0.7)} ${f(sy - Math.cos(th) * r * 0.7)} L${f(tx)} ${f(ty)} L${f(sx - Math.sin(th) * r * 0.7)} ${f(sy + Math.cos(th) * r * 0.7)}Z`;
      shapes.push(`<path d="${dTad}"/>`);
      geo.items.push({ d: dTad, th: 0.3 });
    }
  }

  /* ---- subtle highlights ---- */
  if(hasCore){
    const k = mat.sheen;
    hl.push(`<path d="M${f(cx - R * 0.55)} ${f(cy - R * 0.2)} Q${f(cx - R * 0.25)} ${f(cy - R * 0.65)} ${f(cx + R * 0.25)} ${f(cy - R * 0.5)}" fill="none" stroke="#fff" stroke-opacity="${(0.55 * k).toFixed(2)}" stroke-width="1" stroke-linecap="round"/>`);
    if(vol > 0.4) hl.push(`<ellipse cx="${f(cx - R * 0.3)}" cy="${f(cy - R * 0.35)}" rx="${f(R * 0.14)}" ry="${f(R * 0.06)}" fill="#fff" fill-opacity="${(0.6 * k).toFixed(2)}" transform="rotate(-28 ${f(cx - R * 0.3)} ${f(cy - R * 0.35)})"/>`);
  }

  /* ---- drips: optional; depend on volume, material, gravity (surface tilt) ---- */
  const da = clampNum(dripAmt == null ? 70 : dripAmt, 0, 100) / 100;
  const grav = ICAME_PHYS.tilt;
  if(hasCore && grav > 0.05 && vol > 0.18 && da > 0){
    const load = (vol - 0.18) * (1.1 + (1 - mat.visc) * 0.6) * da * grav;
    if(rand() < Math.min(0.92, 0.12 + load * 0.9)){
      const nd = 1 + Math.floor(rand() * Math.min(3, 1 + load * 2.2));
      const cand = [];
      pts.forEach((p, i) => { const th = i / pts.length * Math.PI * 2; if(Math.sin(th) > 0.25) cand.push(i); });
      const used = new Set();
      for(let d = 0; d < nd && cand.length; d++){
        const ci = Math.floor(rand() * cand.length);
        const idx = cand[ci];
        if(used.has(idx) || used.has(idx - 1) || used.has(idx + 1)) continue;
        used.add(idx);
        const x0 = cx + (pts[idx][0] - cx) * 0.82, y0 = cy + (pts[idx][1] - cy) * 0.82;
        const L = R * (0.35 + Math.pow(rand(), 1.5) * (1.4 + vol * 1.1) * mat.dripLen);
        const w = R * (0.045 + rand() * 0.09) * (0.7 + mat.visc * 0.7);
        const wb = w * (1.15 + rand() * 0.6) + 0.25;
        const dur = ((3.5 + rand() * 9) / (mat.dripSpeed * (0.6 + 0.8 * grav))).toFixed(1);
        const dl = (0.6 + Math.pow(rand(), 2) * 7).toFixed(1);
        const vv = Math.floor(rand() * 6);
        const jit = (rand() - 0.5) * 1.6;
        const detach = L > R * 0.9 && rand() < 0.35 * (1.2 - mat.visc);
        const gap = detach ? wb * (3 + rand() * 5) : 0;
        geo.drips.push({
          d: `M${f(x0 - w)} ${f(y0)} Q${f(x0 - w * 0.7 + jit)} ${f(y0 + L * 0.55)} ${f(x0 - w * 0.42)} ${f(y0 + L)} L${f(x0 + w * 0.42)} ${f(y0 + L)} Q${f(x0 + w * 0.7 + jit)} ${f(y0 + L * 0.55)} ${f(x0 + w)} ${f(y0)}Z`,
          y0, L, wb, xb: x0 + jit * 0.3, dur: parseFloat(dur), dl: parseFloat(dl), vv, detach, gap
        });
        drips.push(
          `<g class="icame-drip v${vv}" style="--len:${f(L)}px;--gap:${f(gap)}px;--dur:${dur}s;--dl:${dl}s">` +
          `<path class="dt" d="M${f(x0 - w)} ${f(y0)} Q${f(x0 - w * 0.7 + jit)} ${f(y0 + L * 0.55)} ${f(x0 - w * 0.42)} ${f(y0 + L)} L${f(x0 + w * 0.42)} ${f(y0 + L)} Q${f(x0 + w * 0.7 + jit)} ${f(y0 + L * 0.55)} ${f(x0 + w)} ${f(y0)}Z" fill="${mat.color}"/>` +
          `<circle class="db" cx="${f(x0 + jit * 0.3)}" cy="${f(y0 + L)}" r="${f(wb)}" fill="${mat.color}"/>` +
          (detach ? `<circle class="dd" cx="${f(x0 + jit * 0.3)}" cy="${f(y0 + L + gap)}" r="${f(wb * 0.5)}" fill="${mat.color}"/>` : '') +
          `</g>`
        );
      }
    }
  }
  return { shapes: shapes.join(''), strands: '', hl: hl.join(''), drips: drips.join(''), geo };
}

const splatShapeCache = new Map();
function splatShapesCached(seed, ang, dr, o){
  o = o || {};
  const k = seed + '|' + (typeof ang === 'number' ? ang.toFixed(3) : 'r') + '|' + dr + '|' + (o.v || '') + '|' + (o.sp || '') + '|' + (o.m || '') + '|' + (o.el || '');
  let m = splatShapeCache.get(k);
  if(!m){ m = splatShapes(seed, ang, dr, o); splatShapeCache.set(k, m); if(splatShapeCache.size > 400) splatShapeCache.delete(splatShapeCache.keys().next().value); }
  return m;
}

/* one splat's inner SVG: material colour/opacity, soft shaded rim, subtle highlights */
function splatInner(p, gi, c){
  const mat = icameMaterial(p.m);
  const sh = splatShapesCached(p.seed, p.a, p.dr, { v: p.v, sp: p.sp, m: p.m, el: p.el });
  return `<g opacity="${mat.opacity.toFixed(2)}">` +
    `<g fill="${mat.color}">${sh.shapes}</g>` +
    (ICAME_OUTLINE ? `<g fill="#ffffff" filter="url(#icameRim)" opacity="${(0.5 + 0.3 * mat.visc).toFixed(2)}">${sh.shapes}</g>` : '') +
    sh.strands + sh.hl + sh.drips + `</g>`;
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
      if(raw.watery == null && raw.material && ICAME_WATERY_OF[raw.material] != null) d.watery = Math.round(ICAME_WATERY_OF[raw.material] * 100);   // migrate old fluid type
      if(typeof raw.ageMode === 'boolean') d.ageMode = raw.ageMode;
      if(typeof raw.realistic === 'boolean') d.realistic = raw.realistic;
      const ag = Number(raw.age);
      if(isFinite(ag) && ag >= 18) d.age = Math.min(100, Math.round(ag));
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

/* { 'image:path': { count, last, first, splats: [{x,y,s,r,a,seed,dr,v,sp,m,el}] } } */
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
/* Which area a press uses — one clear rule, so the picked preset is never overridden:
   anywhere → none · a body-part preset → that preset · custom → this photo's own area
   (if it has one) else the saved custom area. */
function icameResolveTarget(entry){
  const S = state.iCameSettings;
  if(!S || S.targetMode !== 'specific') return null;
  const key = resolveICameTargetPreset(S.targetPreset);
  if(key !== 'custom') return normalizeICameTarget(ICAME_BODY_PART_PRESETS[key]);
  return normalizeICameTarget(entry && entry.target) || normalizeICameTarget(S.target) || normalizeICameTarget(ICAME_DEFAULTS.target);
}
function iCameTargetForItem(item){
  return icameResolveTarget(iCameEntry(item));
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

/* box size (fraction of the shorter image side) for a deposit of volume v */
function icameDepositScale(v, sp, mat, sizeF){
  return Math.min(0.9, (0.05 + 0.16 * Math.sqrt(Math.max(0, v))) * (0.88 + 0.3 * sp) * Math.sqrt(mat.spread) * sizeF);
}

/* position picker (also used to backfill old counts); rng defaults to Math.random */
function newSplat(existing, target = null, rng = Math.random){
  const preferred = target || preferredICameTarget();
  let best = null, bestGap = -1;
  for(let i = 0; i < 8; i++){
    const x = preferred ? preferred.x + rng() * preferred.w : (0.1 + rng() * 0.8);
    const y = preferred ? preferred.y + rng() * preferred.h : (0.1 + rng() * 0.8);
    const gap = (existing || []).reduce((g, p) => Math.min(g, Math.hypot(p.x - x, p.y - y)), 9);
    if(gap > bestGap){ bestGap = gap; best = { x, y }; }
    if(gap > 0.28) break;
  }
  const S = state.iCameSettings;
  const matKey = +icameEffective().watery.toFixed(2);
  const mat = icameMaterial(matKey);
  const v = 0.3 + rng() * 0.6, sp = 0.35 + rng() * 0.4;
  return {
    x: +Math.min(0.98, Math.max(0.02, best.x)).toFixed(4),
    y: +Math.min(0.98, Math.max(0.02, best.y)).toFixed(4),
    s: +icameDepositScale(v, sp, mat, S.size / 100).toFixed(3),
    r: Math.round(rng() * 360),
    a: +(rng() * Math.PI * 2).toFixed(3),
    seed: 1 + Math.floor(rng() * 1e9),
    dr: S.drips, v: +v.toFixed(3), sp: +sp.toFixed(2), m: matKey,
  };
}
function ensureSplats(entry){
  if(!entry) return false;
  if(!Array.isArray(entry.splats)) entry.splats = [];
  let changed = false;
  while(entry.splats.length < (entry.count || 0)){ entry.splats.push(newSplat(entry.splats, icameResolveTarget(entry))); changed = true; }
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

/* ==========================================================================
   REALISTIC MODE  (settings → "Realistic fluid (shaders)")           WebGL2
   --------------------------------------------------------------------------
   Same simulation as before; only the *drawing* changes.
   1. A thickness field is built:
        deposits  → every deposit (+ drips) is rasterised into a mask, blurred at three
                    scales on the GPU and turned into a rounded height map
        ropes     → every parcel / thread in flight is an analytic capsule, summed as
                    metaballs so strands merge, neck and bead like real liquid
   2. One shader lights that height map:
        · refraction   – the photo underneath is bent by the surface normal (+ slight
                         chromatic aberration), so edges magnify / distort the image
        · hue + tint   – thicker fluid shifts the hue of what is below, desaturates it,
                         absorbs blue first (warm cast) and scatters milky light into it
        · scattering   – blurred, lightened "subsurface" look that grows with thickness
        · gloss        – Fresnel reflection of a soft studio environment + sharp speculars
        · contact shadow around every deposit
   If WebGL2 / float textures are missing, the classic SVG look is used automatically.
   If the photo cannot be read (cross-origin), the fluid is still lit and shaded but
   cannot refract the image.
   ========================================================================== */
const ICR = { embed: null, flight: null, failed: false, supported: null };
function icameRealisticOn(){ return !!(state.iCameSettings && state.iCameSettings.realistic) && !ICR.failed; }
function icameWateryOf(m){ return typeof m === 'number' ? clampNum(m, 0, 1) : (ICAME_WATERY_OF[m] != null ? ICAME_WATERY_OF[m] : 0.5); }

const ICR_GLSL = {
  quadVS: `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`,

  blurFS: `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uTex; uniform vec2 uStep; uniform float uSigma;
void main(){
  float st = max(1.0, uSigma * 2.5 / 12.0);
  vec4 acc = vec4(0.0); float ws = 0.0;
  for(int i = -12; i <= 12; i++){
    float x = float(i) * st;
    float w = exp(-0.5 * x * x / (uSigma * uSigma));
    acc += texture(uTex, vUv + uStep * x) * w; ws += w;
  }
  o = acc / ws;
}`,

  resMaskFS: `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uM, uB1, uB2, uB3;
uniform float uHmax;
void main(){
  vec4 m = texture(uM, vUv), b1 = texture(uB1, vUv), b2 = texture(uB2, vUv), b3 = texture(uB3, vUv);
  float a = smoothstep(0.08, 0.92, m.r);
  float i1 = 1.0 / max(b1.r, 1e-3), i2 = 1.0 / max(b2.r, 1e-3), i3 = 1.0 / max(b3.r, 1e-3);
  float th = clamp(mix(b2.g * i2, b3.g * i3, 0.4), 0.0, 1.0);
  float mw = clamp(b1.b * i1, 0.0, 1.0);
  float hs = smoothstep(0.12, 0.95, b1.r) * 0.5;
  float hl = smoothstep(0.25, 1.00, b2.r);
  float hd = smoothstep(0.30, 1.00, b3.r);
  float h = max(hs, hl * 0.75 + hd * 0.25);
  o = vec4(a, h * uHmax * (0.45 + 0.75 * th), mw, 1.0);
}`,

  capVS: `#version 300 es
layout(location=0) in vec4 aAB;
layout(location=1) in vec3 aRN;
uniform vec2 uCss;
flat out vec4 vAB; flat out vec3 vRN; out vec2 vP;
void main(){
  vec2 c = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  float rm = max(aRN.x, aRN.y) * 1.5 + 2.0;
  vec2 lo = min(aAB.xy, aAB.zw) - rm, hi = max(aAB.xy, aAB.zw) + rm;
  vec2 p = mix(lo, hi, c);
  vP = p; vAB = aAB; vRN = aRN;
  gl_Position = vec4(p.x / uCss.x * 2.0 - 1.0, 1.0 - p.y / uCss.y * 2.0, 0.0, 1.0);
}`,
  capFS: `#version 300 es
precision highp float;
flat in vec4 vAB; flat in vec3 vRN; in vec2 vP; out vec4 o;
void main(){
  vec2 A = vAB.xy, ab = vAB.zw - vAB.xy;
  float L2 = max(dot(ab, ab), 1e-4);
  float t = clamp(dot(vP - A, ab) / L2, 0.0, 1.0);
  float d = length(vP - (A + ab * t));
  float r = mix(vRN.x, vRN.y, t);
  r *= vRN.z + (1.0 - vRN.z) * pow(abs(2.0 * t - 1.0), 1.6);
  r = max(r, 0.3);
  float u = d / (r * 1.4142);
  float w = u < 1.0 ? pow(1.0 - u * u, 2.0) : 0.0;
  o = vec4(w, w * r, 0.0, 0.0);
}`,
  resFieldFS: `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uD; uniform float uMatW, uRes;
void main(){
  vec4 d = texture(uD, vUv);
  float F = d.r, r = d.g / max(F, 1e-4), T = 0.25;
  float a = smoothstep(T - 0.05, T + 0.05, F);
  float hn = clamp((F - T) / (1.0 - T), 0.0, 1.4);
  o = vec4(a, pow(hn, 0.72) * r * 1.15 * uRes, uMatW, 1.0);
}`,

  shadeFS: `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uHt, uPhoto;
uniform vec2 uPx;
uniform vec4 uRect;
uniform float uHas, uRefract, uTint, uGloss, uRes, uShadow;

float hash(vec2 p){ p = fract(p * vec2(0.1031, 0.1030)); p += dot(p, p.yx + 33.33); return fract((p.x + p.y) * p.x); }
float vn(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float HT(vec2 uv){
  float h = texture(uHt, uv).g;
  vec2 p = uv / uPx / uRes;
  float n = vn(p * 0.11) * 0.6 + vn(p * 0.27 + 7.0) * 0.4;
  return h * (0.86 + 0.28 * n);
}
vec3 hueRot(vec3 c, float a){
  const vec3 k = vec3(0.57735);
  float ca = cos(a), sa = sin(a);
  return c * ca + cross(k, c) * sa + k * dot(k, c) * (1.0 - ca);
}
vec3 env(vec3 R){
  float sky = smoothstep(-0.2, 0.9, R.y);
  vec3 e = mix(vec3(0.10, 0.11, 0.14), vec3(0.62, 0.68, 0.78), sky);
  vec2 q = R.xy - vec2(-0.45, 0.50);
  e += vec3(1.6, 1.55, 1.45) * smoothstep(0.20, 0.05, max(abs(q.x) * 0.9, abs(q.y) * 1.4));
  e += vec3(0.50, 0.55, 0.65) * smoothstep(0.22, 0.04, length(R.xy - vec2(0.55, -0.45)));
  return e;
}
void main(){
  vec4 t = texture(uHt, vUv);
  float a = t.r;
  vec2 puv = (vUv - uRect.xy) / uRect.zw;
  float inside = step(0.0, puv.x) * step(puv.x, 1.0) * step(0.0, puv.y) * step(puv.y, 1.0);
  const vec3 L = vec3(-0.5014, 0.6217, 0.6017);

  if(a < 0.012){
    if(inside < 0.5){ o = vec4(0.0); return; }
    vec2 dir = L.xy / max(length(L.xy), 1e-3);
    float s = 0.0;
    for(int i = 1; i <= 5; i++){
      float d = float(i) * 0.2 * uShadow;
      s += texture(uHt, vUv + dir * d * uPx).r * (1.0 - float(i) * 0.12);
    }
    o = vec4(0.0, 0.0, 0.0, clamp(s * 0.34, 0.0, 0.4) * 0.6);
    return;
  }

  float H = HT(vUv);
  vec2 e = uPx;
  float hl = HT(vUv - vec2(e.x, 0.0)), hr = HT(vUv + vec2(e.x, 0.0));
  float hd = HT(vUv - vec2(0.0, e.y)), hu = HT(vUv + vec2(0.0, e.y));
  vec3 N = normalize(vec3(-0.5 * vec2(hr - hl, hu - hd) * 1.35, 1.0));

  float w = t.b;
  float opac = w <= 0.5 ? mix(1.0, 0.93, w * 2.0) : mix(0.93, 0.62, (w - 0.5) * 2.0);
  float visc = w <= 0.5 ? mix(0.85, 0.50, w * 2.0) : mix(0.50, 0.15, (w - 0.5) * 2.0);
  vec3 milk = w <= 0.5 ? mix(vec3(0.961, 0.949, 0.914), vec3(0.945, 0.933, 0.898), w * 2.0)
                       : mix(vec3(0.945, 0.933, 0.898), vec3(0.925, 0.937, 0.941), (w - 0.5) * 2.0);
  float Hc = H / uRes;
  float s = 1.0 - exp(-Hc * mix(0.18, 0.60, opac * opac));

  float has = uHas * inside;
  vec3 under = vec3(0.0);
  if(has > 0.5){
    vec2 ouv = (-N.xy * H * uRefract * 1.6) * uPx / uRect.zw;
    float ca = 0.05 * uRefract;
    vec3 c0 = vec3(texture(uPhoto, puv + ouv * (1.0 - ca)).r, texture(uPhoto, puv + ouv).g, texture(uPhoto, puv + ouv * (1.0 + ca)).b);
    float br = (0.5 + Hc * 0.8) * uRes * (0.35 + 0.65 * opac);
    vec3 acc = vec3(0.0);
    for(int i = 0; i < 8; i++){
      float an = float(i) * 0.7854;
      acc += texture(uPhoto, puv + ouv + vec2(cos(an), sin(an)) * br * uPx / uRect.zw).rgb;
    }
    under = mix(c0, acc * 0.125, 0.55);
  }

  float k = uTint;
  vec3 tr = hueRot(under, k * 0.60 * (0.3 + 0.7 * s));
  tr = mix(tr, vec3(dot(tr, vec3(0.299, 0.587, 0.114))), 0.28 * k * s);
  tr *= exp(-vec3(0.010, 0.020, 0.055) * Hc * k * 1.2);
  tr += vec3(0.030, 0.026, 0.012) * k * s;

  float diff = clamp(dot(N, L) * 0.5 + 0.5, 0.0, 1.0);
  vec3 milkLit = milk * (0.80 + 0.30 * diff) * (1.0 - 0.14 * (1.0 - N.z));
  float body = clamp(s * opac * 1.08, 0.0, 1.0);

  vec3 col; float al;
  if(has > 0.5){ col = mix(tr, milkLit, body); al = a; }
  else         { col = milkLit; al = a * clamp(body * 0.9 + 0.12, 0.0, 1.0); }
  float cosT = max(N.z, 0.0);
  col *= 1.0 - 0.30 * pow(1.0 - cosT, 2.0) * (1.0 - body * 0.7);

  float fres = 0.025 + 0.975 * pow(1.0 - cosT, 4.0);
  vec3 R = reflect(vec3(0.0, 0.0, -1.0), N);
  float nh = max(dot(N, normalize(L + vec3(0.0, 0.0, 1.0))), 0.0);
  float shin = mix(380.0, 70.0, visc);
  float sp = pow(nh, shin) * (shin + 8.0) / 25.0 * 0.35 + pow(nh, 28.0) * 0.10;
  vec3 hi = (env(R) * fres * 1.5 + vec3(1.0, 0.98, 0.94) * sp) * uGloss;

  vec3 oc = col * (1.0 - fres * uGloss * 0.5) * al + hi * a;
  float oa = max(al, clamp(max(hi.r, max(hi.g, hi.b)), 0.0, 1.0) * a);
  o = vec4(min(oc, vec3(oa)), oa);
}`
};

class IcameGL {
  constructor(canvas){
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' });
    if(!gl) throw new Error('WebGL2 is not available');
    if(!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) throw new Error('float render targets are not available');
    this.gl = gl; this.canvas = canvas; this.W = 0; this.H = 0; this.tg = {}; this.P = {};
    this.lost = false; this.photoOK = false; this.photoKey = ''; this.texM = null; this.photoTex = null;
    this.prev = null; this.icap = 0;
    canvas.addEventListener('webglcontextlost', ev => { ev.preventDefault(); this.lost = true; });

    this.qvao = gl.createVertexArray(); gl.bindVertexArray(this.qvao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.ivao = gl.createVertexArray(); gl.bindVertexArray(this.ivao);
    this.ibuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.ibuf);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 28, 0); gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 28, 16); gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);

    const G = ICR_GLSL;
    this.P.blur = this._prog(G.quadVS, G.blurFS);
    this.P.resMask = this._prog(G.quadVS, G.resMaskFS);
    this.P.cap = this._prog(G.capVS, G.capFS);
    this.P.resField = this._prog(G.quadVS, G.resFieldFS);
    this.P.shade = this._prog(G.quadVS, G.shadeFS);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  }
  _prog(vs, fs){
    const gl = this.gl, mk = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if(!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if(!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
    return { p, u: {} };
  }
  _u(P, n){ if(!(n in P.u)) P.u[n] = this.gl.getUniformLocation(P.p, n); return P.u[n]; }
  _tex(unit, tex){ this.gl.activeTexture(this.gl.TEXTURE0 + unit); this.gl.bindTexture(this.gl.TEXTURE_2D, tex); }
  _mkTex(){
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  _target(name){
    const gl = this.gl; let t = this.tg[name];
    if(t && t.w === this.W && t.h === this.H) return t;
    if(t){ gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); }
    const tex = this._mkTex();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, this.W, this.H, 0, gl.RGBA, gl.HALF_FLOAT, null);
    const fbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if(gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('framebuffer incomplete');
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    return (this.tg[name] = { tex, fbo, w: this.W, h: this.H });
  }
  resize(W, H){
    if(this.W === W && this.H === H) return;
    this.W = W; this.H = H; this.canvas.width = W; this.canvas.height = H; this.prev = null;
  }
  setPhoto(cv, key){
    const gl = this.gl;
    if(key === this.photoKey) return this.photoOK;
    this.photoKey = key; this.photoOK = false;
    if(!this.photoTex) this.photoTex = this._mkTex();
    gl.bindTexture(gl.TEXTURE_2D, this.photoTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
    this.photoOK = true;
    return true;
  }
  _quad(P, target, fn){
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, this.W, this.H);
    gl.useProgram(P.p); fn && fn(P);
    gl.bindVertexArray(this.qvao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  _blur(srcTex, outName, sigma){
    const gl = this.gl, tmp = this._target('tmp'), out = this._target(outName), P = this.P.blur;
    this._tex(0, srcTex);
    this._quad(P, tmp, () => { gl.uniform1i(this._u(P, 'uTex'), 0); gl.uniform2f(this._u(P, 'uStep'), 1 / this.W, 0); gl.uniform1f(this._u(P, 'uSigma'), sigma); });
    this._tex(0, tmp.tex);
    this._quad(P, out, () => { gl.uniform1i(this._u(P, 'uTex'), 0); gl.uniform2f(this._u(P, 'uStep'), 0, 1 / this.H); gl.uniform1f(this._u(P, 'uSigma'), sigma); });
  }
  _shade(par, scissor){
    const gl = this.gl, P = this.P.shade, ht = this.tg.ht;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.W, this.H);
    if(scissor){ gl.enable(gl.SCISSOR_TEST); gl.scissor(scissor[0], scissor[1], scissor[2], scissor[3]); } else gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    this._tex(0, ht.tex); this._tex(1, this.photoTex || ht.tex);
    this._quad(P, null, () => {
      gl.uniform1i(this._u(P, 'uHt'), 0); gl.uniform1i(this._u(P, 'uPhoto'), 1);
      gl.uniform2f(this._u(P, 'uPx'), 1 / this.W, 1 / this.H);
      gl.uniform4f(this._u(P, 'uRect'), par.rect[0], par.rect[1], par.rect[2], par.rect[3]);
      gl.uniform1f(this._u(P, 'uHas'), this.photoOK ? 1 : 0);
      gl.uniform1f(this._u(P, 'uRefract'), par.refract); gl.uniform1f(this._u(P, 'uTint'), par.tint);
      gl.uniform1f(this._u(P, 'uGloss'), par.gloss); gl.uniform1f(this._u(P, 'uRes'), par.res);
      gl.uniform1f(this._u(P, 'uShadow'), par.shadow);
    });
    gl.disable(gl.SCISSOR_TEST);
  }
  renderMask(cv, par){
    const gl = this.gl;
    this._target('tmp'); this._target('b1'); this._target('b2'); this._target('b3'); this._target('ht');
    if(!this.texM) this.texM = this._mkTex();
    gl.bindTexture(gl.TEXTURE_2D, this.texM);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
    gl.disable(gl.SCISSOR_TEST); gl.disable(gl.BLEND);
    this._blur(this.texM, 'b1', 1.0 * par.res); this._blur(this.texM, 'b2', 3.0 * par.res); this._blur(this.texM, 'b3', 9.0 * par.res);
    const P = this.P.resMask;
    this._tex(0, this.texM); this._tex(1, this.tg.b1.tex); this._tex(2, this.tg.b2.tex); this._tex(3, this.tg.b3.tex);
    this._quad(P, this.tg.ht, () => {
      gl.uniform1i(this._u(P, 'uM'), 0); gl.uniform1i(this._u(P, 'uB1'), 1); gl.uniform1i(this._u(P, 'uB2'), 2); gl.uniform1i(this._u(P, 'uB3'), 3);
      gl.uniform1f(this._u(P, 'uHmax'), par.hmax);
    });
    this._shade(par, null);
  }
  renderInstances(data, n, bb, par, cssW, cssH){
    const gl = this.gl;
    const D = this._target('d'); this._target('ht');
    let x0 = bb ? bb[0] : 0, y0 = bb ? bb[1] : 0, x1 = bb ? bb[2] : 0, y1 = bb ? bb[3] : 0;
    const sx = this.W / cssW, sy = this.H / cssH;
    let dx0 = Math.floor(x0 * sx), dy0 = Math.floor(y0 * sy), dx1 = Math.ceil(x1 * sx), dy1 = Math.ceil(y1 * sy);
    if(this.prev){ dx0 = Math.min(dx0, this.prev[0]); dy0 = Math.min(dy0, this.prev[1]); dx1 = Math.max(dx1, this.prev[2]); dy1 = Math.max(dy1, this.prev[3]); }
    dx0 = Math.max(0, dx0 - 2); dy0 = Math.max(0, dy0 - 2); dx1 = Math.min(this.W, dx1 + 2); dy1 = Math.min(this.H, dy1 + 2);
    this.prev = n ? [Math.floor(x0 * sx), Math.floor(y0 * sy), Math.ceil(x1 * sx), Math.ceil(y1 * sy)] : null;
    if(dx1 <= dx0 || dy1 <= dy0) return;
    const sc = [dx0, this.H - dy1, dx1 - dx0, dy1 - dy0];
    gl.enable(gl.SCISSOR_TEST); gl.scissor(sc[0], sc[1], sc[2], sc[3]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, D.fbo); gl.viewport(0, 0, this.W, this.H);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    if(n > 0){
      const P = this.P.cap;
      gl.useProgram(P.p); gl.uniform2f(this._u(P, 'uCss'), cssW, cssH);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
      gl.bindVertexArray(this.ivao); gl.bindBuffer(gl.ARRAY_BUFFER, this.ibuf);
      gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, n * 7), gl.DYNAMIC_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
      gl.disable(gl.BLEND);
    }
    const R = this.P.resField;
    this._tex(0, D.tex);
    this._quad(R, this.tg.ht, () => { gl.uniform1i(this._u(R, 'uD'), 0); gl.uniform1f(this._u(R, 'uMatW'), par.matW); gl.uniform1f(this._u(R, 'uRes'), par.res); });
    this._shade(par, sc);
  }
  clear(){
    const gl = this.gl;
    gl.disable(gl.SCISSOR_TEST); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); this.prev = null;
  }
  dispose(){
    try{ const x = this.gl.getExtension('WEBGL_lose_context'); if(x) x.loseContext(); }catch(e){}
  }
}

function icameGLFail(err){
  ICR.failed = true;
  try{ console.warn('[I came] realistic mode unavailable:', err); }catch(e){}
  state.iCameSettings.realistic = false;
  saveICameSettings();
  const t = document.getElementById('iCameRealisticToggle'); if(t) t.checked = false;
  syncICameRealistic();
  icameEmbedDispose();
  try{ toast('Realistic mode needs WebGL2 — using the classic look'); }catch(e){}
}
function icameGLSupported(){
  if(ICR.supported != null) return ICR.supported;
  try{
    const c = document.createElement('canvas'), gl = c.getContext('webgl2');
    ICR.supported = !!(gl && (gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float')));
    const x = gl && gl.getExtension('WEBGL_lose_context'); if(x) x.loseContext();
  }catch(e){ ICR.supported = false; }
  return ICR.supported;
}

function icamePhotoToGL(g, cv, img, W, H){
  const nc = document.getElementById('focusNsfwCanvas');
  const useNc = !!(nc && !nc.hidden && nc.width > 0 && nc.height > 0 && getComputedStyle(nc).display !== 'none');
  const src = useNc ? nc : img;
  const key = (useNc ? 'nc:' + nc.width + 'x' + nc.height : (img.currentSrc || img.src) + '|' + img.naturalWidth) + '|' + W + 'x' + H;
  if(g.photoKey === key) return g.photoOK;
  try{
    if(cv.width !== W) cv.width = W;
    if(cv.height !== H) cv.height = H;
    const c = cv.getContext('2d');
    c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
    c.clearRect(0, 0, W, H); c.drawImage(src, 0, 0, W, H);
    g.setPhoto(cv, key);
  }catch(e){ g.photoOK = false; g.photoKey = key; }
  return g.photoOK;
}
function icameShadeParams(res, hmax, rect, shadow, matW){
  const S = state.iCameSettings;
  return { res, hmax, rect, shadow, matW, refract: S.rRefract / 100, tint: S.rTint / 100, gloss: S.rGloss / 100 };
}

function icameDripProgress(d, age){
  const prof = ICAME_DRIP_PROFILES[d.vv % ICAME_DRIP_PROFILES.length];
  if(!isFinite(age)) return { s: 1, det: d.detach ? { a: 1, off: d.gap } : null };
  const tau = (age - d.dl) / d.dur;
  let s;
  if(tau <= 0) s = prof[0][1];
  else if(tau >= 1) s = 1;
  else {
    const pc = tau * 100; s = 1;
    for(let i = 1; i < prof.length; i++){
      if(pc <= prof[i][0]){ const [x0, y0] = prof[i - 1], [x1, y1] = prof[i]; s = y0 + (y1 - y0) * (pc - x0) / (x1 - x0); break; }
    }
  }
  const det = d.detach && tau >= 0.8 ? { a: clampNum((tau - 0.8) / 0.06, 0, 1), off: d.gap * clampNum((tau - 0.8) / 0.2, 0, 1) } : null;
  return { s, det };
}
function icameMaskSplat(c, p, E, k, age, alpha){
  const m = Math.min(E.w, E.h), bx = Math.max(8, p.s * m), px = bx * E.res;
  const left = (p.x * E.w - bx / 2) * E.res, top = (p.y * E.h - bx / 2) * E.res;
  const sh = splatShapesCached(p.seed, p.a, p.dr, { v: p.v, sp: p.sp, m: p.m, el: p.el });
  const B = Math.round(icameWateryOf(p.m) * 255);
  const col = th => `rgb(255,${Math.round(clampNum(th, 0, 1) * 255)},${B})`;
  c.setTransform(px / 100, 0, 0, px / 100, left, top);
  if(k !== 1){ c.translate(50, 50); c.scale(k, k); c.translate(-50, -50); }
  c.globalAlpha = alpha;
  for(const it of sh.geo.items){
    c.fillStyle = col(it.th);
    if(it.d) c.fill(it.p2d || (it.p2d = new Path2D(it.d)));
    else { c.beginPath(); c.ellipse(it.e[0], it.e[1], it.e[2], it.e[3], it.e[4], 0, Math.PI * 2); c.fill(); }
  }
  for(const d of sh.geo.drips){
    const { s, det } = icameDripProgress(d, age);
    c.save();
    c.translate(0, d.y0); c.scale(1, s); c.translate(0, -d.y0);
    c.fillStyle = col(0.55); c.fill(d.p2d || (d.p2d = new Path2D(d.d)));
    c.restore();
    c.fillStyle = col(0.8); c.beginPath(); c.arc(d.xb, d.y0 + d.L * s, d.wb, 0, Math.PI * 2); c.fill();
    if(det && det.a > 0.02){
      c.globalAlpha = alpha * det.a; c.fillStyle = col(0.6);
      c.beginPath(); c.arc(d.xb, d.y0 + d.L + det.off, d.wb * 0.5, 0, Math.PI * 2); c.fill();
      c.globalAlpha = alpha;
    }
  }
  c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = 1;
}

function icameEmbedDispose(){
  const E = ICR.embed; if(!E) return;
  if(E.raf) cancelAnimationFrame(E.raf);
  E.gl.dispose(); E.canvas.remove(); ICR.embed = null;
}
function icameEmbedFrame(E, now){
  const entry = E.entry; if(!entry) return false;
  const vis = gi => !(splatHold && splatHold.key === E.itemKey && gi >= splatHold.from && !splatHold.shown.has(gi));
  if(E.dirty){
    const c = E.sx;
    c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = 1; c.fillStyle = '#000'; c.fillRect(0, 0, E.W, E.H);
    E.shown.forEach((p, i) => { const gi = E.offset + i; if(vis(gi) && !E.anim.has(gi)) icameMaskSplat(c, p, E, 1, Infinity, 1); });
    E.dirty = false;
  }
  const c = E.cx;
  c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = 1; c.drawImage(E.mS, 0, 0);
  let finished = false;
  E.anim.forEach((a, gi) => {
    const p = entry.splats[gi];
    if(!p){ E.anim.delete(gi); return; }
    const age = (now - a.t0) / 1000, x = clampNum(age / a.grow, 0, 1);
    icameMaskSplat(c, p, E, 0.12 + 0.88 * (1 - Math.pow(1 - x, 3.2)), age, clampNum(x / 0.25, 0, 1));
    if(age >= a.end){ E.anim.delete(gi); finished = true; }
  });
  if(finished) E.dirty = true;
  const hmax = clampNum(Math.min(E.w, E.h) * 0.0115, 2.4, 9) * E.res;
  E.gl.renderMask(E.mC, icameShadeParams(E.res, hmax, [0, 0, 1, 1], 3 * E.res, 0.5));
  return E.anim.size > 0 || E.dirty;
}
function icameEmbedTick(){
  const E = ICR.embed; if(!E) return;
  E.raf = 0;
  if(E.gl.lost){ icameEmbedDispose(); return; }
  if(icameEmbedFrame(E, performance.now())) E.raf = requestAnimationFrame(icameEmbedTick);
}
function icameEmbedKick(E){ if(!E.raf) E.raf = requestAnimationFrame(icameEmbedTick); }
function icameStartAnim(E, gi, grow){
  const p = E.entry && E.entry.splats[gi]; if(!p) return;
  const sh = splatShapesCached(p.seed, p.a, p.dr, { v: p.v, sp: p.sp, m: p.m, el: p.el });
  let end = grow;
  for(const d of sh.geo.drips) end = Math.max(end, d.dl + d.dur);
  E.anim.set(gi, { t0: performance.now(), grow: Math.max(0.2, grow), end: end + 0.3 });
  E.dirty = true;
  icameEmbedKick(E);
}
function icameGLReveal(item, gi, dur){
  const E = ICR.embed;
  if(!E || E.itemKey !== favKey(item)) return false;
  icameStartAnim(E, gi, dur || 0.9);
  return true;
}
function icameRenderGL(layer, item, entry, img, w, h, shown, offset, animateNewest, targetMarkup){
  let E = ICR.embed;
  if(E && E.gl.lost){ icameEmbedDispose(); E = null; }
  if(!E){
    try{
      const canvas = document.createElement('canvas');
      canvas.id = 'focusSplatGL';
      canvas.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;display:block';
      E = ICR.embed = {
        canvas, gl: new IcameGL(canvas), anim: new Map(), raf: 0, dirty: true, itemKey: '', W: 0, H: 0, res: 1,
        mS: document.createElement('canvas'), mC: document.createElement('canvas'), photoCv: document.createElement('canvas')
      };
      E.sx = E.mS.getContext('2d', { alpha: false }); E.cx = E.mC.getContext('2d', { alpha: false });
    }catch(err){ ICR.embed = null; icameGLFail(err); return false; }
  }
  layer.querySelectorAll('.icame-splat,.icame-target-box').forEach(n => n.remove());
  if(E.canvas.parentNode !== layer) layer.insertBefore(E.canvas, layer.firstChild);
  if(targetMarkup) layer.insertAdjacentHTML('beforeend', targetMarkup);

  let res = Math.min(window.devicePixelRatio || 1, 2);
  if(w * h * res * res > 3.2e6) res = Math.sqrt(3.2e6 / (w * h));
  const W = Math.max(2, Math.round(w * res)), H = Math.max(2, Math.round(h * res));
  if(E.W !== W || E.H !== H || E.res !== res){
    E.W = W; E.H = H; E.res = res;
    E.mS.width = E.mC.width = W; E.mS.height = E.mC.height = H;
    E.gl.resize(W, H);
  }
  const key = favKey(item);
  if(E.itemKey !== key){ E.itemKey = key; E.anim.clear(); }
  E.w = w; E.h = h; E.entry = entry; E.shown = shown; E.offset = offset; E.dirty = true;
  try{
    icamePhotoToGL(E.gl, E.photoCv, img, W, H);
    if(animateNewest && shown.length) icameStartAnim(E, offset + shown.length - 1, 0.9);
    if(icameEmbedFrame(E, performance.now())) icameEmbedKick(E);
  }catch(err){ icameGLFail(err); return false; }
  return true;
}

function icameFlightEnsure(){
  if(ICR.flight && ICR.flight.gl.lost){ try{ ICR.flight.canvas.remove(); }catch(e){} ICR.flight = null; }
  if(ICR.flight) return ICR.flight;
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:100001;display:none';
  document.body.appendChild(canvas);
  try{
    ICR.flight = { canvas, gl: new IcameGL(canvas), data: new Float32Array(7 * 2048), photoCv: document.createElement('canvas') };
  }catch(err){ canvas.remove(); icameGLFail(err); return null; }
  return ICR.flight;
}
function icameFlightBegin(B, matKey){
  const F = icameFlightEnsure(); if(!F) return null;
  const iw = innerWidth, ih = innerHeight;
  let res = Math.min(window.devicePixelRatio || 1, 1.5);
  if(iw * ih * res * res > 2.4e6) res = Math.sqrt(2.4e6 / (iw * ih));
  try{
    F.canvas.style.display = 'block';
    F.gl.resize(Math.round(iw * res), Math.round(ih * res));
    const img = document.getElementById('focusImg');
    icamePhotoToGL(F.gl, F.photoCv, img, Math.max(2, Math.round(B.width * res)), Math.max(2, Math.round(B.height * res)));
    F.gl.clear();
  }catch(err){ F.canvas.style.display = 'none'; icameGLFail(err); return null; }
  const par = icameShadeParams(res, 0, [B.left / iw, 1 - (B.top + B.height) / ih, B.width / iw, B.height / ih], 16 * res, +matKey);
  const FG = {
    n: 0, bb: null, iw, ih,
    cap(ax, ay, bx, by, ra, rb, neck){
      if(!(ra > 0) && !(rb > 0)) return;
      if((this.n + 1) * 7 > F.data.length){ const nd = new Float32Array(F.data.length * 2); nd.set(F.data); F.data = nd; }
      const d = F.data, o = this.n * 7;
      d[o] = ax; d[o + 1] = ay; d[o + 2] = bx; d[o + 3] = by; d[o + 4] = ra; d[o + 5] = rb; d[o + 6] = neck;
      const m = Math.max(ra, rb) * 1.5 + 3, bb = this.bb || (this.bb = [1e9, 1e9, -1e9, -1e9]);
      bb[0] = Math.min(bb[0], ax - m, bx - m); bb[1] = Math.min(bb[1], ay - m, by - m);
      bb[2] = Math.max(bb[2], ax + m, bx + m); bb[3] = Math.max(bb[3], ay + m, by + m);
      this.n++;
    },
    flush(){
      try{ F.gl.renderInstances(F.data, this.n, this.n ? this.bb : null, par, iw, ih); }catch(err){ icameGLFail(err); }
      this.n = 0; this.bb = null;
    },
    end(){ try{ F.gl.clear(); }catch(e){} F.canvas.style.display = 'none'; }
  };
  return FG;
}

/* while a shot is in flight its splats stay hidden until their parcels land */
let splatHold = null; // { key, from, shown:Set<globalIndex> }

function renderFocusSplats(item = iCameFocusItem, animateNewest = false){
  const layer = ensureSplatLayer();
  if(!layer) return;
  ensureICameDefs();
  const img = document.getElementById('focusImg');
  const entry = item ? iCameEntry(item) : null;
  if(ICR.embed && !icameRealisticOn()) icameEmbedDispose();
  if(!state.iCameSettings.showSplats || !entry || !img || !img.clientWidth || !img.clientHeight){
    layer.hidden = true;
    layer.innerHTML = '';
    if(ICR.embed){ ICR.embed.anim.clear(); ICR.embed.entry = null; }
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
  const target = draft;   // the outline box only shows while you are drawing the area
  const targetMarkup = target ? `<div class="icame-target-box" style="left:${(target.x * w).toFixed(1)}px;top:${(target.y * h).toFixed(1)}px;width:${(target.w * w).toFixed(1)}px;height:${(target.h * h).toFixed(1)}px"></div>` : '';
  const svgMarkup = () => shown.map((p, i) => {
    const gi = offset + i;
    const hidden = !!(hold && gi >= hold.from && !hold.shown.has(gi));
    const px = Math.max(8, p.s * m);
    const isNew = animateNewest && i === shown.length - 1;
    return `<svg class="icame-splat${isNew ? ' is-new' : ''}${hidden ? ' is-hidden' : ''}" data-i="${gi}" viewBox="0 0 100 100" style="left:${(p.x * w - px / 2).toFixed(1)}px;top:${(p.y * h - px / 2).toFixed(1)}px;width:${px.toFixed(1)}px;height:${px.toFixed(1)}px${hidden ? ';visibility:hidden' : ''}">${splatInner(p, gi)}</svg>`;
  }).join('') + targetMarkup;
  if(!(icameRealisticOn() && icameRenderGL(layer, item, entry, img, w, h, shown, offset, animateNewest, targetMarkup))){
    layer.innerHTML = svgMarkup();
  }
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

/* reveal at first contact; dur lets the deposit keep growing while the rest of its rope lands */
function revealSplat(item, gi, dur){
  if(splatHold) splatHold.shown.add(gi);
  if(!iCameFocusItem || favKey(iCameFocusItem) !== favKey(item)) return;
  if(ICR.embed && icameRealisticOn() && icameGLReveal(item, gi, dur)) return;   // realistic: growth is drawn by the shader
  const el = document.querySelector(`#focusSplatLayer .icame-splat[data-i="${gi}"]`);
  if(el){
    el.style.visibility = ''; el.classList.remove('is-hidden');
    if(dur) el.style.animationDuration = dur.toFixed(2) + 's';
    el.classList.add('is-new');
  }
}

/* ==========================================================================
   THE SHOT — independent systems
   1 icameEmit            stream motion (parcels: mass, speed, direction)
   2 icameLinks           threads, necking, breakup, in-flight satellites
   3 icameState/Detect    flight state + collision with the photo plane
   4 icameDeposits        impact deposits from what actually landed
   5 (splatShapes above)  satellites around deposit + gravity-driven drips
   -------------------------------------------------------------------------- */

/* 1) EMITTER ----------------------------------------------------------------
   Aims the rope's centre at (aimX,aimY). Flight time is capped so shots to
   targets above the origin never overshoot with a huge arc. Parcels differ in
   mass (pulses, fat head, thin tail), launch time (flow-rate dependent gaps),
   speed (head fast, tail slow, plus noise) and heading (slow wobble). Faster
   parcels arrive sooner and therefore drop less — that comes from the physics. */
function icameEmit(rnd, o){
  const G = ICAME_PHYS.gravity, mat = o.mat;
  const dx = o.aimX - o.ox, dy = o.aimY - o.oy, dist = Math.hypot(dx, dy);
  let Tb = clampNum(dist / 1500, 0.24, 0.6);
  if(dy < 0) Tb = Math.min(Tb, 0.85 * Math.sqrt(2 * -dy / G));   // no overshooting apex
  Tb = clampNum(Tb * (0.94 + rnd() * 0.12), 0.2, 0.65);
  const vxb = dx / Tb, vyb = (dy - 0.5 * G * Tb * Tb) / Tb;

  const V = (0.22 + 0.78 * Math.pow(o.power, 1.3)) * o.amountF * (0.7 + 0.6 * rnd());   // rope volume
  const count = Math.round(clampNum(12 + 26 * Math.sqrt(V), 8, 64));
  const dur = (0.12 + 0.2 * Math.sqrt(V)) * (0.8 + 0.4 * rnd());
  const ph = [rnd() * 6.28, rnd() * 6.28, rnd() * 6.28, rnd() * 6.28, rnd() * 6.28];
  const pf = 5 + rnd() * 6;
  const wob = 0.025 + 0.03 * (1 - mat.visc) + 0.02 * (1 - Math.min(1, o.power));
  const noise = f => 0.5 * Math.sin(f * 7 + ph[0]) + 0.3 * Math.sin(f * 17 + ph[1]) + 0.2 * Math.sin(f * 31 + ph[2]);

  const q = [], gaps = [];
  for(let k = 0; k < count; k++){
    const f = count > 1 ? k / (count - 1) : 0.5;
    const head = Math.exp(-Math.pow((f - 0.12) / 0.14, 2));
    const pulse = 0.5 + 0.5 * Math.sin(f * pf + ph[3]);
    let qk = 0.22 + 0.9 * head + 0.45 * pulse * (1 - f * 0.6);
    qk *= Math.exp((rnd() - 0.5) * (0.8 + 0.6 * (1 - mat.visc)));
    if(f > 0.8) qk *= (1 - f) * 3.2 + 0.15;                      // thinning tail
    q.push(Math.max(0.03, qk));
    gaps.push((0.4 + rnd() * 1.2) / (0.35 + qk));                // heavy flow → tight spacing
  }
  const qs = q.reduce((a, b) => a + b, 0), gs = gaps.reduce((a, b) => a + b, 0);
  const ps = [];
  let tl = 0;
  for(let k = 0; k < count; k++){
    const f = count > 1 ? k / (count - 1) : 0.5;
    const m = V * q[k] / qs;
    const rm = m * count / V;
    const sp = clampNum(1.07 - 0.14 * f + noise(f) * 0.05 + (rnd() - 0.5) * 0.07, 0.85, 1.15);
    const th = wob * (0.6 * Math.sin(f * 3.1 + ph[4]) + 0.4 * Math.sin(f * 8.3 + ph[0])) + (rnd() - 0.5) * 0.006;
    const c = Math.cos(th), s = Math.sin(th);
    const T = Tb / sp;
    const x0 = o.ox + (rnd() - 0.5) * 4, y0 = o.oy + (rnd() - 0.5) * 4;
    let vx = (vxb * c - vyb * s) * sp, vy = (vxb * s + vyb * c) * sp;
    const lx = x0 + vx * T, ly = y0 + vy * T + 0.5 * G * T * T;
    ps.push({
      ts: o.t0 + tl, T, x0, y0, vx, vy, lx, ly, m,
      w: Math.max(0.7, o.px * 2.6 * Math.sqrt(rm) * (0.55 + 0.55 * Math.sqrt(V))),
      landed: false, f
    });
    tl += dur * gaps[k] / gs;
  }
  /* Keep the rope centred on the aim point (speed/heading scatter would otherwise drift it)
     and inside the chosen area, then re-derive velocities so flight and landing agree. */
  const wsum = ps.reduce((s, p) => s + p.m, 0) || 1;
  const mx = ps.reduce((s, p) => s + p.lx * p.m, 0) / wsum, my = ps.reduce((s, p) => s + p.ly * p.m, 0) / wsum;
  const rect = o.rect;
  ps.forEach(p => {
    p.lx = clampNum(p.lx + (o.aimX - mx), rect.l, rect.r);
    p.ly = clampNum(p.ly + (o.aimY - my), rect.t, rect.b);
    p.vx = (p.lx - p.x0) / p.T;
    p.vy = (p.ly - p.y0 - 0.5 * G * p.T * p.T) / p.T;
  });
  return { ps, extra: [], links: [], all: ps, V, dur, t0: o.t0, rect };
}

/* 2) LINKS ------------------------------------------------------------------
   Thread k joins parcel k and k+1. Because flight is closed-form we can find the
   exact moment the separation exceeds the break length: thin fluids and thin
   (low-mass) parcels snap early, thick fluids hold longer. A snap may shed a tiny
   droplet that flies on independently. */
function icamePos(p, t, G){
  const age = t - p.ts;
  if(age < 0) return null;
  if(age >= p.T) return { x: p.lx, y: p.ly, vx: 0, vy: 0, landed: true };
  return { x: p.x0 + p.vx * age, y: p.y0 + p.vy * age + 0.5 * G * age * age, vx: p.vx, vy: p.vy + G * age, landed: false };
}
function icameLinks(rope, mat, rnd, G, B, px){
  const ps = rope.ps;
  for(let k = 0; k < ps.length - 1; k++){
    const a = ps[k], b = ps[k + 1];
    const wmin = Math.min(a.w, b.w), wmax = Math.max(a.w, b.w);
    const Lb = (5 + 5.5 * wmin + 2.2 * wmax) * mat.breakLen * (0.65 + rnd() * 0.7) * px;
    let br = Infinity;
    const tEnd = Math.max(a.ts + a.T, b.ts + b.T);
    for(let t = b.ts; t <= tEnd; t += 1 / 90){
      const A = icamePos(a, t, G), Bp = icamePos(b, t, G);
      if(Math.hypot(A.x - Bp.x, A.y - Bp.y) > Lb){ br = t; break; }
    }
    rope.links.push({ br, Lb });
    if(isFinite(br) && rnd() < 0.25 + 0.5 * (1 - mat.visc)){
      const A = icamePos(a, br, G), Bp = icamePos(b, br, G);
      if(A && Bp && !A.landed && !Bp.landed){
        const rem = Math.min(a.ts + a.T, b.ts + b.T) - br;
        if(rem > 0.05){
          const T = rem * (0.92 + rnd() * 0.2);
          const vx = (A.vx + Bp.vx) / 2 + (rnd() - 0.5) * 90, vy = (A.vy + Bp.vy) / 2 + (rnd() - 0.5) * 70;
          const x0 = (A.x + Bp.x) / 2, y0 = (A.y + Bp.y) / 2;
          const lx = x0 + vx * T, ly = y0 + vy * T + 0.5 * G * T * T;
          const rc = rope.rect;
          if(lx > rc.l && lx < rc.r && ly > rc.t && ly < rc.b){
            const m = (a.m + b.m) * 0.06 * (0.5 + rnd());
            rope.extra.push({ ts: br, T, x0, y0, vx, vy, lx, ly, m, w: Math.max(0.7, wmin * (0.5 + 0.3 * rnd())), landed: false, sat: true, f: 1 });
          }
        }
      }
    }
  }
  rope.all = rope.ps.concat(rope.extra);
}

/* 3) STATE + COLLISION -------------------------------------------------------- */
function icameState(p, t, G){
  const s = icamePos(p, t, G);
  if(!s) return null;
  const age = t - p.ts;
  s.w = s.landed ? p.w * 0.6 : p.w * (1 - 0.25 * age / p.T);
  return s;
}
/* a parcel touches the photo exactly when its flight time ends */
function icameDetectContacts(rope, t, G){
  const ev = [];
  for(const p of rope.all){
    if(!p.landed && t >= p.ts + p.T){
      p.landed = true;
      ev.push({ p, vx: p.vx, vy: p.vy + G * p.T });
    }
  }
  return ev;
}

/* 4) DEPOSITS -----------------------------------------------------------------
   Built from what really lands: centroid, delivered volume, impact velocity and the
   landing scatter. Parcels still joined to the stream when they land form the main
   deposit (plus close-by droplets); stragglers that land far away become separate
   droplet deposits (max 4 per rope). */
function icameDeposits(rope, B, mat, matKey, S, rnd, G, force = 1){
  const all = rope.all, m = Math.min(B.width, B.height), sizeF = S.size / 100;
  const joined = new Set();
  rope.ps.forEach((p, k) => {
    const tl = p.ts + p.T, lb = rope.links[k], lf = rope.links[k - 1];
    if((lb && lb.br > tl) || (lf && lf.br > tl)) joined.add(p);
  });
  let core = all.filter(p => joined.has(p));
  if(!core.length) core = all.slice().sort((a, b) => b.m - a.m).slice(0, Math.ceil(all.length / 2));
  const wsum = core.reduce((s, p) => s + p.m, 0) || 1;
  const cx = core.reduce((s, p) => s + p.lx * p.m, 0) / wsum, cy = core.reduce((s, p) => s + p.ly * p.m, 0) / wsum;
  const farR = 0.42 * m * icameDepositScale(wsum, 0.5, mat, sizeF);
  const near = [], far = [];
  all.forEach(p => (core.includes(p) || Math.hypot(p.lx - cx, p.ly - cy) < farR) ? near.push(p) : far.push(p));

  const make = (ps, isMain) => {
    const V = ps.reduce((s, p) => s + p.m, 0) || 0.001;
    const x = ps.reduce((s, p) => s + p.lx * p.m, 0) / V, y = ps.reduce((s, p) => s + p.ly * p.m, 0) / V;
    let ix = 0, iy = 0;
    ps.forEach(p => { ix += p.vx * p.m; iy += (p.vy + G * p.T) * p.m; });
    ix /= V; iy /= V;
    const sp = clampNum(Math.hypot(ix, iy) / 1400 * force, 0.15, 1.1);
    const s = icameDepositScale(V, sp, mat, sizeF);
    let el = 1 + 0.45 * sp * (1 - mat.visc * 0.5);
    if(isMain && ps.length > 3){
      const ca = Math.cos(Math.atan2(iy, ix)), sa = Math.sin(Math.atan2(iy, ix));
      let sl = 0, sq = 0;
      ps.forEach(p => { const dx = p.lx - x, dy = p.ly - y; const u = dx * ca + dy * sa, w = -dx * sa + dy * ca; sl += u * u * p.m; sq += w * w * p.m; });
      el += clampNum((Math.sqrt(sl / V) - Math.sqrt(sq / V)) / (0.25 * s * m), 0, 0.8);
    }
    return {
      parcels: ps,
      splat: {
        x: +clampNum((x - B.left) / B.width, 0.02, 0.98).toFixed(4),
        y: +clampNum((y - B.top) / B.height, 0.02, 0.98).toFixed(4),
        s: +s.toFixed(3), r: Math.round(rnd() * 360),
        a: +Math.atan2(iy, ix).toFixed(3),
        seed: 1 + Math.floor(rnd() * 1e9), dr: S.drips,
        v: +V.toFixed(3), sp: +sp.toFixed(2), m: matKey, el: +el.toFixed(2)
      }
    };
  };
  const groups = [make(near, true)];
  const clusters = [], cr = 0.05 * m;
  far.sort((a, b) => b.m - a.m).forEach(p => {
    let best = null, bd = 1e9;
    clusters.forEach(c => { const d = Math.hypot(c.x - p.lx, c.y - p.ly); if(d < bd){ bd = d; best = c; } });
    if(best && (bd < cr || clusters.length >= 4)){ best.ps.push(p); best.x = (best.x * (best.ps.length - 1) + p.lx) / best.ps.length; best.y = (best.y * (best.ps.length - 1) + p.ly) / best.ps.length; }
    else clusters.push({ x: p.lx, y: p.ly, ps: [p] });
  });
  clusters.forEach(c => groups.push(make(c.ps, false)));
  return groups;
}

function iCameShoot(originEl, item){
  const key = favKey(item);
  const entry = iCameEntry(item);
  const img = document.getElementById('focusImg');
  if(!entry) return;
  const S = state.iCameSettings;
  const target = iCameTargetForItem(item);
  const reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const box = img ? img.getBoundingClientRect() : null;
  const haveBox = !!(box && box.width);
  const B = haveBox ? box : { left: 0, top: 0, width: 800, height: 600 };
  const sb = originEl ? originEl.getBoundingClientRect() : null;
  const ox = sb ? sb.left + sb.width / 2 : (haveBox ? B.left + B.width / 2 : 400);
  const oy = sb ? sb.top + sb.height / 2 : (haveBox ? B.top + B.height : 700);
  const E = icameEffective();           // settings, scaled by age when "Cum by age" is on
  const matKey = +E.watery.toFixed(2);
  const mat = icameMaterial(matKey);   // one material for the whole emission
  const G = ICAME_PHYS.gravity;
  const amountF = E.amount / 100;
  const px = clampNum(Math.min(B.width, B.height) / 700, 0.6, 1.5);
  const rnd = mulberry32(icameSeed(key, entry));
  /* landing region in screen px: the chosen area (kept strictly inside), else the whole photo */
  const rg = target || { x: 0, y: 0, w: 1, h: 1 };
  const padX = target ? 0 : B.width * 0.015, padY = target ? 0 : B.height * 0.015;
  const rect = { l: B.left + rg.x * B.width + padX, r: B.left + (rg.x + rg.w) * B.width - padX, t: B.top + rg.y * B.height + padY, b: B.top + (rg.y + rg.h) * B.height - padY };

  /* 1) plan ropes, links, contacts and deposits up front (deterministic per press) */
  let n = Math.round(E.ropes);
  if(S.ropesRandom) n += Math.round((rnd() - 0.5) * 3) + (rnd() < 0.3 ? 1 : 0);
  n = Math.max(1, Math.min(12, n));
  const first = entry.splats.length;
  const newSplats = [], ropes = [], groups = [];
  let cursor = 0;
  for(let i = 0; i < n; i++){
    const power = clampNum(1 - (i / n) * 0.6 + (rnd() - 0.5) * 0.35, 0.25, 1.1);
    const spot = newSplat([...entry.splats, ...newSplats], target, rnd);
    const rope = icameEmit(rnd, {
      ox, oy, aimX: B.left + spot.x * B.width, aimY: B.top + spot.y * B.height,
      power, amountF, mat, B, px, t0: cursor, rect
    });
    icameLinks(rope, mat, rnd, G, B, px);
    icameDeposits(rope, B, mat, matKey, S, rnd, G, E.force).forEach(g => {
      g.gi = first + newSplats.length;
      newSplats.push(g.splat);
      g.parcels.forEach(p => { p.gi = g.gi; });
      g.t0 = Math.min(...g.parcels.map(p => p.ts + p.T));
      g.t1 = Math.max(...g.parcels.map(p => p.ts + p.T));
      groups.push(g);
    });
    ropes.push(rope);
    cursor += rope.dur + 0.3 + rnd() * 0.5;                          // pause before the next rope
  }
  newSplats.forEach(s => entry.splats.push(s));
  saveICame();

  if(!haveBox || reduced || !S.showSplats){
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
  /* realistic mode: ropes are drawn by the fluid shader on one GL canvas instead of the 2D canvases */
  const FG = icameRealisticOn() ? icameFlightBegin(B, matKey) : null;
  const body = FG ? null : mk((mat.goo ? 'filter:url(#icameGooFine);' : '') + `opacity:${mat.opacity}`);
  const glint = FG ? null : mk(`opacity:${(0.5 * mat.sheen).toFixed(2)}`);
  const ctx = body && body.x, gx = glint && glint.x;
  if(ctx){
    ctx.strokeStyle = ctx.fillStyle = mat.color;
    gx.strokeStyle = gx.fillStyle = '#ffffff';
  }

  const groupBy = new Map(groups.map(g => [g.gi, g]));
  const revealed = new Set();
  const splash = [];
  const endT = Math.max(...ropes.map(r => Math.max(...r.all.map(p => p.ts + p.T)))) + 0.05;

  const finish = () => {
    groups.forEach(g => revealSplat(item, g.gi, (g.t1 - g.t0) + 0.35));
    splatHold = null;
    if(FG) FG.end(); else { body.c.remove(); glint.c.remove(); }
  };
  const failsafe = setTimeout(finish, Math.ceil((endT + 3) * 1000));

  /* lens-shaped thread: thick ends, neck in the middle */
  const thread = (c, ax, ay, aw, bx, by, bw, neck) => {
    const dx = bx - ax, dy = by - ay, d = Math.hypot(dx, dy);
    if(d < 0.5) return;
    const nx = -dy / d, ny = dx / d;
    const ha = aw / 2, hb = bw / 2, hm = Math.max(0.2, Math.min(aw, bw) / 2 * neck);
    const x1 = ax + dx / 3, y1 = ay + dy / 3, x2 = ax + dx * 2 / 3, y2 = ay + dy * 2 / 3;
    c.beginPath();
    c.moveTo(ax + nx * ha, ay + ny * ha);
    c.bezierCurveTo(x1 + nx * hm, y1 + ny * hm, x2 + nx * hm, y2 + ny * hm, bx + nx * hb, by + ny * hb);
    c.lineTo(bx - nx * hb, by - ny * hb);
    c.bezierCurveTo(x2 - nx * hm, y2 - ny * hm, x1 - nx * hm, y1 - ny * hm, ax - nx * ha, ay - ny * ha);
    c.closePath(); c.fill();
  };

  const start = performance.now();
  let prev = start, done = false;
  (function frame(now){
    if(done) return;
    const t = (now - start) / 1000, dt = Math.min(0.05, (now - prev) / 1000);
    prev = now;
    if(!FG){
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      gx.clearRect(0, 0, innerWidth, innerHeight);
    }
    let alive = t < endT;

    for(const r of ropes){
      /* collision → deposit reveal (synchronised with real contact) + impact spray */
      for(const ev of icameDetectContacts(r, t, G)){
        const p = ev.p, g = groupBy.get(p.gi);
        if(g && !revealed.has(p.gi)){ revealed.add(p.gi); revealSplat(item, p.gi, (g.t1 - g.t0) + 0.35); }
        const spd = clampNum(Math.hypot(ev.vx, ev.vy) / 1400, 0.2, 1.1);
        if(rnd() < (0.12 + 0.35 * (1 - mat.visc)) * (0.5 + spd) * Math.min(1, 0.4 + p.m * 6)){
          splash.push({ x: p.lx, y: p.ly, vx: (rnd() - 0.5) * 220 * spd, vy: -(40 + rnd() * 130) * (0.5 + spd), r: 0.6 + rnd() * 1.2 + Math.sqrt(p.m) * 2, life: 0.2 + rnd() * 0.25, age: 0 });
        }
      }

      /* threads between neighbouring parcels (necking as they stretch) */
      for(let k = 0; k < r.links.length; k++){
        const L = r.links[k];
        if(t >= L.br) continue;
        const A = icameState(r.ps[k], t, G), Bs = icameState(r.ps[k + 1], t, G);
        if(!A || !Bs || (A.landed && Bs.landed)) continue;
        const d = Math.hypot(A.x - Bs.x, A.y - Bs.y);
        const s = clampNum(d / L.Lb, 0, 1);
        const neck = Math.max(0.1, 1 - Math.pow(s, 1.2 + 1.6 * mat.visc));
        if(FG) FG.cap(A.x, A.y, Bs.x, Bs.y, A.w * 0.5, Bs.w * 0.5, neck);
        else thread(ctx, A.x, A.y, A.w, Bs.x, Bs.y, Bs.w, neck);
      }

      /* parcels: heads, body blobs and free droplets (short streaks along velocity) */
      for(const p of r.all){
        const s = icameState(p, t, G);
        if(!s || s.landed) continue;
        const sp = Math.hypot(s.vx, s.vy);
        const sl = Math.min(p.w * 3.2 + 2, sp * 0.016);
        const ux = s.vx / sp, uy = s.vy / sp;
        if(FG){ FG.cap(s.x - ux * sl, s.y - uy * sl, s.x, s.y, s.w * 0.5, s.w * 0.5, 1); continue; }
        ctx.lineWidth = s.w;
        ctx.beginPath(); ctx.moveTo(s.x - ux * sl, s.y - uy * sl); ctx.lineTo(s.x, s.y); ctx.stroke();
        gx.lineWidth = Math.max(0.5, s.w * 0.22);
        gx.beginPath(); gx.moveTo(s.x - ux * sl - s.w * 0.18, s.y - uy * sl - s.w * 0.2); gx.lineTo(s.x - s.w * 0.18, s.y - s.w * 0.2); gx.stroke();
      }
    }

    for(let i = splash.length - 1; i >= 0; i--){
      const sp = splash[i];
      sp.age += dt; sp.vy += 1400 * dt; sp.x += sp.vx * dt; sp.y += sp.vy * dt;
      if(sp.age >= sp.life){ splash.splice(i, 1); continue; }
      const sr = sp.r * (1 - sp.age / sp.life);
      if(FG) FG.cap(sp.x, sp.y, sp.x, sp.y, sr, sr, 1);
      else { ctx.beginPath(); ctx.arc(sp.x, sp.y, sr, 0, Math.PI * 2); ctx.fill(); }
    }

    if(FG) FG.flush();
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
      state.iCameSettings.targetPreset = 'custom';   // a hand-drawn area replaces any body-part preset
      saveICameSettings();
      if(mode) mode.value = 'specific';
      const presetSel = document.getElementById('iCameTargetPreset');
      if(presetSel){ presetSel.value = 'custom'; presetSel.disabled = false; }
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
  ['iCameWateryInput', 'watery', 'iCameWateryVal', '%', 'input'],
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
  const ageT = document.getElementById('iCameAgeToggle');
  if(ageT) ageT.checked = !!S.ageMode;
  const ageI = document.getElementById('iCameAgeInput');
  if(ageI) ageI.value = S.age;
  updateICameAgeHint();
  const mode = document.getElementById('iCameTargetMode');
  if(mode) mode.value = S.targetMode === 'specific' ? 'specific' : 'anywhere';
  const preset = document.getElementById('iCameTargetPreset');
  if(preset){
    const key = resolveICameTargetPreset(S.targetPreset || 'custom');
    preset.value = key;
    preset.disabled = !(S.targetMode === 'specific');
  }
  syncICameRealistic();
}

/* New settings rows (presets, wateriness, cum by age) are added in the same style as the
   existing ones, right after "Dripping". Skipped if the page already has them. */
function ensureICameExtraRows(){
  if(document.getElementById('iCameWateryInput')) return;
  const anchor = document.getElementById('iCameDripsInput');
  const row = anchor && anchor.closest('.setting-row');
  if(!row) return;
  const html = `
    <div class="setting-row">
      <div class="setting-text">
        <div class="setting-title">Cum preset</div>
        <div class="setting-desc">Quick looks that set ropes, amount, size, dripping and wateriness in one go.</div>
      </div>
      <select id="iCamePresetSelect" class="setting-input" style="min-width:160px;"></select>
    </div>
    <div class="setting-row">
      <div class="setting-text">
        <div class="setting-title">Watery cum - <span id="iCameWateryVal">50%</span></div>
        <div class="setting-desc">0% is thick and opaque, 100% is thin and translucent. Thinner cum breaks into more droplets, spreads wider and runs faster.</div>
      </div>
      <input id="iCameWateryInput" type="range" min="0" max="100" step="5" style="width:150px;accent-color:var(--amber);">
    </div>
    <div class="setting-row">
      <div class="setting-text">
        <div class="setting-title">Cum by age</div>
        <div class="setting-desc">Scales amount, ropes, force and thickness to roughly match a real ejaculation at your age (18+). It's an approximation, not medical data. <span id="iCameAgeHint"></span></div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;">
        <input id="iCameAgeInput" type="number" min="18" max="100" step="1" class="setting-input" style="max-width:70px;" placeholder="25">
        <label class="toggle"><input type="checkbox" id="iCameAgeToggle"><span class="track"></span></label>
      </div>
    </div>`;
  row.insertAdjacentHTML('afterend', html);
}
function updateICameAgeHint(){
  const el = document.getElementById('iCameAgeHint');
  if(!el) return;
  const S = state.iCameSettings;
  if(!S.ageMode){ el.textContent = ''; return; }
  const f = icameAgeFactors(S.age);
  el.textContent = `At ${S.age}: about ${Math.round(f.vol * 100)}% of the volume, ${Math.round(f.ropes * 100)}% of the ropes, ${Math.round(f.force * 100)}% of the force.`;
}
/* ---------- "Realistic fluid" rows (added right after "Show cum on photos") ---------- */
const ICAME_REAL_CONTROLS = [
  ['iCameRefractInput', 'rRefract', 'iCameRefractVal'],
  ['iCameTintInput',    'rTint',    'iCameTintVal'],
  ['iCameGlossInput',   'rGloss',   'iCameGlossVal'],
];
function ensureICameRealisticRows(){
  if(document.getElementById('iCameRealisticToggle')) return;
  const anchor = document.getElementById('iCameSplatToggle');
  const row = anchor && anchor.closest('.setting-row');
  if(!row) return;
  const slider = (id, val, title, desc, max) => `
    <div class="setting-row icame-real-sub" style="display:none">
      <div class="setting-text">
        <div class="setting-title">${title} - <span id="${val}">0%</span></div>
        <div class="setting-desc">${desc}</div>
      </div>
      <input id="${id}" type="range" min="0" max="${max}" step="5" style="width:150px;accent-color:var(--amber);">
    </div>`;
  row.insertAdjacentHTML('afterend', `
    <div class="setting-row">
      <div class="setting-text">
        <div class="setting-title">Realistic fluid (shaders)</div>
        <div class="setting-desc">Draws the ropes and splatters with a GPU shader: the fluid refracts and distorts the photo under it, shifts its hue, scatters light, shines and casts a soft shadow. Needs WebGL2; falls back to the classic look if unavailable.</div>
      </div>
      <label class="toggle">
        <input type="checkbox" id="iCameRealisticToggle">
        <span class="track"></span>
      </label>
    </div>` +
    slider('iCameRefractInput', 'iCameRefractVal', 'Refraction', 'How strongly the fluid bends and distorts the image underneath it.', 150) +
    slider('iCameTintInput', 'iCameTintVal', 'Hue shift & tint', 'How much the fluid shifts the hue of the photo below (warmer, paler, less saturated where it is thick).', 100) +
    slider('iCameGlossInput', 'iCameGlossVal', 'Gloss', 'Strength of the wet reflections and highlights.', 100));
}
function syncICameRealistic(){
  const S = state.iCameSettings;
  const t = document.getElementById('iCameRealisticToggle');
  if(t) t.checked = !!S.realistic;
  ICAME_REAL_CONTROLS.forEach(([id, key, lab]) => {
    const el = document.getElementById(id); if(el) el.value = S[key];
    const l = document.getElementById(lab); if(l) l.textContent = S[key] + '%';
  });
  document.querySelectorAll('.icame-real-sub').forEach(r => { r.style.display = S.realistic ? '' : 'none'; });
}
let icameRealRaf = 0;
function icameRealisticRefresh(){
  if(icameRealRaf) return;
  icameRealRaf = requestAnimationFrame(() => { icameRealRaf = 0; renderFocusSplats(); });
}
function bindICameRealistic(){
  ensureICameRealisticRows();
  const S = state.iCameSettings;
  const tg = document.getElementById('iCameRealisticToggle');
  if(tg) tg.addEventListener('change', () => {
    S.realistic = tg.checked;
    if(S.realistic){
      ICR.failed = false;
      if(!icameGLSupported()){ icameGLFail('WebGL2 / float textures unsupported'); return; }
      setTimeout(() => { try{ icameFlightEnsure(); }catch(e){} }, 30);
    } else {
      icameEmbedDispose();
    }
    saveICameSettings();
    syncICameRealistic();
    renderFocusSplats();
    if(typeof renderImageGrid === 'function') renderImageGrid();
    toast(S.realistic ? 'Realistic fluid: on' : 'Realistic fluid: off');
  });
  ICAME_REAL_CONTROLS.forEach(([id, key, lab]) => {
    const el = document.getElementById(id); if(!el) return;
    el.addEventListener('input', () => {
      const v = clampNum(parseFloat(el.value) || 0, ICAME_RANGES[key][0], ICAME_RANGES[key][1]);
      S[key] = v;
      const l = document.getElementById(lab); if(l) l.textContent = v + '%';
      saveICameSettings();
      icameRealisticRefresh();
    });
  });
  syncICameRealistic();
}

function bindICameExtras(){
  const S = state.iCameSettings;
  const sel = document.getElementById('iCamePresetSelect');
  if(sel){
    sel.innerHTML = '<option value="">Custom (your sliders)</option>' + Object.keys(ICAME_PRESETS).map(k => `<option value="${k}">${ICAME_PRESETS[k].label}</option>`).join('');
    sel.addEventListener('change', () => {
      const p = ICAME_PRESETS[sel.value];
      if(!p) return;
      ['ropes', 'amount', 'size', 'drips', 'watery'].forEach(k => { S[k] = p[k]; });
      saveICameSettings();
      syncICameControls();
      toast(`Preset: ${p.label}`);
    });
  }
  /* moving any slider afterwards means it's no longer exactly the preset */
  ICAME_CONTROLS.forEach(([id]) => {
    const el = document.getElementById(id);
    if(el) el.addEventListener('input', () => { if(sel) sel.value = ''; });
    if(el) el.addEventListener('change', () => { if(sel) sel.value = ''; });
  });
  const ageT = document.getElementById('iCameAgeToggle');
  const ageI = document.getElementById('iCameAgeInput');
  const applyAge = () => {
    const n = parseInt(ageI && ageI.value, 10);
    if(!isFinite(n) || n < 18){
      if(ageI) ageI.value = S.age;
      toast('Enter an age of 18 or older');
      if(ageT && S.age < 18) ageT.checked = false;
      return false;
    }
    S.age = Math.min(100, n);
    if(ageI) ageI.value = S.age;
    return true;
  };
  if(ageI) ageI.addEventListener('change', () => { if(applyAge()){ saveICameSettings(); updateICameAgeHint(); } });
  if(ageT) ageT.addEventListener('change', () => {
    if(ageT.checked && !applyAge()){ ageT.checked = false; return; }
    S.ageMode = ageT.checked;
    saveICameSettings();
    updateICameAgeHint();
    toast(S.ageMode ? `Cum by age on (${S.age})` : 'Cum by age off');
  });
}

function bindICameSettings(){
  ensureICameExtraRows();
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
      ['ropes', 'ropesRandom', 'amount', 'size', 'drips', 'watery', 'rRefract', 'rTint', 'rGloss', 'targetMode', 'targetPreset', 'target'].forEach(k => {
        if(k === 'target') state.iCameSettings[k] = { ...ICAME_DEFAULTS.target };
        else if(k === 'targetPreset') state.iCameSettings[k] = ICAME_DEFAULTS.targetPreset;
        else state.iCameSettings[k] = ICAME_DEFAULTS[k];
      });
      saveICameSettings();
      syncICameControls();
      toast('Cum look reset to defaults');
    });
  }
  bindICameExtras();
  bindICameRealistic();
  syncICameControls();
}
ensureICameDefs();
paintICameIcons();
bindICameSettings();