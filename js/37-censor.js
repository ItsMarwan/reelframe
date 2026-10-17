/* ==========================================================================
   Censor + variants

   VARIANTS — every photo or video can have extra versions saved with it:
     • censored versions you generate (videos go through the local Censor
       app, photos are censored right here in the browser with the same
       NudeNet model the region scan uses), and
     • files you add yourself ("Add variant").
   They're stored per item in IndexedDB under `censor:<path>`. In the viewer
   you pick between Original and each variant; in the grids the item stays a
   single card with a "+X" badge when it has variants.

   CENSORING runs in the background, like caption generation: pick the
   options, the window closes, a progress chip shows in the corner, and the
   result is saved as a variant when it's done — even if you've moved on to
   another video or photo. One job at a time.
   ========================================================================== */
const CENSOR_LINK_KEY = 'reelframe:censorLink';
const CENSOR_SITE_URL = 'https://itsmarwan.github.io/censor/';
const CENSOR_STYLES = [
  ['blur', 'Gaussian blur'], ['soft-blur', 'Soft blur'], ['pixelate', 'Pixelate'],
  ['frosted', 'Frosted glass'], ['smudge', 'Smudge'], ['box', 'Black box'],
  ['solid', 'Solid colour'], ['cover', 'Tinted cover'], ['outline', 'Dashed outline'],
  ['glitch', 'Glitch'], ['rainbow', 'Rainbow'], ['dots', 'Dots'],
  ['scanline', 'Scanlines'], ['negative', 'Negative'], ['emboss', 'Emboss'],
];
/* Photos are drawn in the browser, so only the styles that make sense there. */
const CENSOR_IMAGE_STYLES = [
  ['blur', 'Gaussian blur'], ['pixelate', 'Pixelate'], ['box', 'Black box'], ['solid', 'Solid colour'],
];
const CENSOR_CATEGORIES = [
  ['genitals', 'Genitals'], ['breasts', 'Breasts'], ['buttocks', 'Buttocks'],
  ['feet', 'Feet'], ['belly', 'Belly'], ['armpits', 'Armpits'], ['face', 'Faces'],
];
/* What each category means to the in-browser NudeNet detector. */
const CENSOR_IMAGE_CLASS_MAP = {
  genitals: ['FEMALE_GENITALIA_EXPOSED', 'MALE_GENITALIA_EXPOSED', 'ANUS_EXPOSED'],
  breasts: ['FEMALE_BREAST_EXPOSED', 'MALE_BREAST_EXPOSED'],
  buttocks: ['BUTTOCKS_EXPOSED'],
  feet: ['FEET_EXPOSED'],
  belly: ['BELLY_EXPOSED'],
  armpits: ['ARMPITS_EXPOSED'],
  face: ['FACE_FEMALE', 'FACE_MALE'],
};
const CENSOR_DETAIL = [['8', 'Fast'], ['5', 'Balanced'], ['2', 'Precise']];
const CENSOR_STATUS_LABELS = {
  queued: 'Waiting to start…', decoding: 'Reading video…', queued_for_gpu: 'Waiting for the detector…',
  detecting: 'Finding regions…', censoring: 'Applying the effect…', encoding: 'Encoding the result…', done: 'Done',
};

const censorState = {
  base: null,          // linked Censor app address (videos only)
  target: null,        // item the options window is open for
  job: null,           // running background job: { path, name, type, label, progress, cancelled, xhr, done }
  item: null,          // item whose variants are loaded in the open viewer
  versions: [],        // variants of that item: {id, createdAt, kind, label, mime, blob, ...}
  activeId: null,      // null = original
  urls: new Map(),     // variantId -> object URL
  itemPath: null,
};
const variantCounts = new Map(); // item path -> number of variants (drives the "+X" badge)

const censorKey = (path) => `censor:${path}`;
const censorEl = (id) => document.getElementById(id);
const censorIsImage = (item) => !!item && item.type === 'image';

/* ---------------- link parsing + health check (videos) ---------------- */
function censorParseLink(input){
  let v = String(input || '').trim();
  if(!v) return null;
  const m = v.match(/\/u\/([A-Za-z0-9_-]+)/);
  if(m) v = m[1];
  if(/^https?:\/\//i.test(v)) return v.replace(/\/+$/, '');
  if(/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(v)) return `http://${v}`;
  try{
    const pad = v + '='.repeat((4 - (v.length % 4)) % 4);
    const decoded = atob(pad.replace(/-/g, '+').replace(/_/g, '/'));
    if(/^https?:\/\//i.test(decoded)) return decoded.replace(/\/+$/, '');
  }catch(e){ /* not base64 */ }
  return null;
}

function censorFetch(path, opts = {}){
  const headers = Object.assign({ 'ngrok-skip-browser-warning': '1' }, opts.headers || {});
  return fetch(censorState.base + path, Object.assign({}, opts, { headers }));
}

async function censorCheckHealth(base, timeoutMs = 6000){
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try{
    const r = await fetch(base + '/health', { headers: { 'ngrok-skip-browser-warning': '1' }, signal: ctl.signal });
    if(!r.ok) return false;
    const j = await r.json();
    return j && j.status === 'ok';
  }catch(e){ return false; }
  finally{ clearTimeout(timer); }
}

/* ---------------- background progress chip + button state ---------------- */
function censorShowToast(label, frac){
  const el = censorEl('censorProgressToast');
  if(!el) return;
  el.hidden = false;
  const l = censorEl('censorToastLabel'); if(l) l.textContent = label;
  const f = censorEl('censorToastFill');
  if(f) f.style.width = `${Math.max(0, Math.min(100, Math.round((frac || 0) * 100)))}%`;
}
function censorHideToast(){
  const el = censorEl('censorProgressToast');
  if(el) el.hidden = true;
}
function censorJobProgress(job, label, frac){
  job.label = label; job.progress = frac;
  if(censorState.job === job && !job.done) censorShowToast(label, frac);
}
function censorJobIsRunning(){ return !!(censorState.job && !censorState.job.done); }
function censorJobIsFor(item){ return !!(item && censorJobIsRunning() && censorState.job.path === item.path); }

function updateCensorButtonsUI(){
  const vBtn = censorEl('censorBtn');
  if(vBtn){
    const busy = censorJobIsFor(state.currentVideo) && censorState.job.type === 'video';
    vBtn.classList.toggle('generating', busy);
    vBtn.title = busy ? 'Censoring this video…' : 'Censor video';
  }
  const iBtn = censorEl('focusCensorBtn');
  if(iBtn){
    const busy = censorJobIsFor(state.currentImage) && censorState.job.type === 'image';
    iBtn.classList.toggle('generating', busy);
    iBtn.title = busy ? 'Censoring this photo…' : 'Censor this photo — saved as a variant';
  }
}

function censorCancelRun(){
  const job = censorState.job;
  if(!job || job.done) return;
  job.cancelled = true;
  try{ job.xhr && job.xhr.abort(); }catch(e){}
  job.done = true;
  censorHideToast();
  updateCensorButtonsUI();
  toast('Censoring cancelled');
}

/* ---------------- options window ---------------- */
function censorShowPane(name){
  ['link', 'options'].forEach(p => {
    const el = censorEl(`censorPane-${p}`);
    if(el) el.hidden = p !== name;
  });
  const image = censorIsImage(censorState.target);
  const titles = { link: 'Censor video — link the app', options: image ? 'Censor photo' : 'Censor video — options' };
  const t = censorEl('censorModalTitle'); if(t) t.textContent = titles[name] || 'Censor';
}

function censorSetLinkStatus(msg, kind){
  const el = censorEl('censorLinkStatus');
  if(!el) return;
  el.textContent = msg || '';
  el.className = 'status-text censor-status' + (kind ? ` is-${kind}` : '');
}

async function openCensorModal(item){
  if(!item || !item.type){ toast('Open a video or photo first.'); return; }
  if(censorJobIsRunning()){
    toast(censorState.job.path === item.path
      ? 'Already censoring this one — it\'ll appear as a variant when it\'s done.'
      : 'Still censoring something else — please wait for it to finish.');
    return;
  }
  const backdrop = censorEl('censorModalBackdrop');
  if(!backdrop) return;
  censorState.target = item;
  backdrop.hidden = false;
  censorBuildOptions(censorIsImage(item));

  if(censorIsImage(item)){
    // Photos are censored in the browser — nothing to link.
    censorShowOptions();
    return;
  }

  // Videos: already linked from earlier? Skip straight to the options if it still answers.
  let saved = null;
  try{ saved = localStorage.getItem(CENSOR_LINK_KEY); }catch(e){}
  censorShowPane('link');
  censorEl('censorLinkInput').value = '';
  censorSetLinkStatus('');
  if(saved){
    censorSetLinkStatus('Checking your last link…');
    if(await censorCheckHealth(saved, 4000)){
      if(censorState.target !== item || backdrop.hidden) return;
      censorState.base = saved;
      censorShowOptions();
      return;
    }
    censorSetLinkStatus('Your last link isn\'t responding — open the Censor app and paste a fresh code.', 'warn');
  }
}

function closeCensorModal(){
  const backdrop = censorEl('censorModalBackdrop');
  if(backdrop) backdrop.hidden = true;
}

async function censorLinkSubmit(){
  const base = censorParseLink(censorEl('censorLinkInput').value);
  if(!base){ censorSetLinkStatus('That doesn\'t look like a pairing code or address.', 'error'); return; }
  const btn = censorEl('censorLinkBtn');
  btn.disabled = true;
  censorSetLinkStatus('Linking…');
  const ok = await censorCheckHealth(base);
  btn.disabled = false;
  if(!ok){
    censorSetLinkStatus('Couldn\'t reach the app. Make sure it says "Sandbox ready" and the code is current.', 'error');
    return;
  }
  censorState.base = base;
  try{ localStorage.setItem(CENSOR_LINK_KEY, base); }catch(e){}
  censorShowOptions();
}

function censorShowOptions(){
  const item = censorState.target;
  const image = censorIsImage(item);
  const linkedRow = censorEl('censorLinkedRow'); if(linkedRow) linkedRow.hidden = image;
  const detail = censorEl('censorDetailField'); if(detail) detail.hidden = image;
  const kind = censorEl('censorTargetKind'); if(kind) kind.textContent = image ? 'Photo' : 'Video';
  const foot = censorEl('censorFootHint');
  if(foot) foot.textContent = image
    ? 'Runs on this device and keeps going in the background. The result is saved as a variant of this photo.'
    : 'Keeps running in the background if you close this window. The result is saved as a variant of this video.';
  if(!image){
    const sub = censorEl('censorLinkedSub');
    if(sub) sub.textContent = censorState.base && (censorState.base.includes('127.0.0.1') || censorState.base.includes('localhost')) ? 'Linked to the app on this computer' : 'Linked through your tunnel';
  }
  const nm = censorEl('censorTargetName');
  if(nm && item) nm.textContent = item.name;
  censorUpdateStyleExtras();
  censorShowPane('options');
}

function censorBuildOptions(image){
  const sel = censorEl('censorStyle');
  if(!sel) return;
  const prev = sel.value;
  const styles = image ? CENSOR_IMAGE_STYLES : CENSOR_STYLES;
  sel.innerHTML = styles.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  if(styles.some(s => s[0] === prev)) sel.value = prev;
  if(!sel.dataset.built){
    sel.dataset.built = '1';
    censorEl('censorCategories').innerHTML = CENSOR_CATEGORIES.map(([v, l]) =>
      `<label class="censor-check"><input type="checkbox" value="${v}" ${v === 'genitals' || v === 'breasts' ? 'checked' : ''}><span>${l}</span></label>`).join('');
    censorEl('censorDetail').innerHTML = CENSOR_DETAIL.map(([v, l]) => `<option value="${v}" ${v === '5' ? 'selected' : ''}>${l}</option>`).join('');
    sel.addEventListener('change', censorUpdateStyleExtras);
  }
}

function censorUpdateStyleExtras(){
  const style = censorEl('censorStyle').value;
  censorEl('censorColorField').hidden = !(style === 'solid' || style === 'cover');
}

/* ---------------- running a job (in the background) ---------------- */
async function censorGetSourceBlob(item){
  if(item.file) return item.file;
  const src = item.pairRemote ? await ensureItemUrlAsync(item) : ensureItemUrl(item);
  if(!src) throw new Error('This video has no readable source.');
  const r = await fetch(src);
  if(!r.ok) throw new Error('Could not read the video to send it.');
  return await r.blob();
}

function censorUpload(blob, filename, fields, job){
  return new Promise((resolve, reject) => {
    const form = new FormData();
    Object.entries(fields).forEach(([k, v]) => form.append(k, v));
    form.append('video', blob, filename);
    const xhr = new XMLHttpRequest();
    job.xhr = xhr;
    xhr.open('POST', censorState.base + '/start_video_job');
    xhr.setRequestHeader('ngrok-skip-browser-warning', '1');
    xhr.upload.onprogress = (e) => {
      if(e.lengthComputable) censorJobProgress(job, 'Sending video to the app…', (e.loaded / e.total) * 0.15);
    };
    xhr.onload = () => {
      try{
        const j = JSON.parse(xhr.responseText || '{}');
        if(xhr.status >= 200 && xhr.status < 300 && j.job_id) resolve(j.job_id);
        else reject(new Error(j.error || `The app refused the video (${xhr.status}).`));
      }catch(e){ reject(new Error('The app sent back something unexpected.')); }
    };
    xhr.onerror = () => reject(new Error('Lost connection to the app while sending the video.'));
    xhr.onabort = () => reject(new Error('cancelled'));
    xhr.send(form);
  });
}

async function censorStartRun(){
  const item = censorState.target;
  if(!item || censorJobIsRunning()) return;
  const categories = [...censorEl('censorCategories').querySelectorAll('input:checked')].map(i => i.value);
  if(!categories.length){ toast('Pick at least one thing to censor.'); return; }

  const opts = {
    style: censorEl('censorStyle').value,
    solidColor: censorEl('censorColor').value || '#000000',
    categories,
    detail: censorEl('censorDetail').value,
  };

  const job = { path: item.path, name: item.name, type: censorIsImage(item) ? 'image' : 'video', label: 'Preparing…', progress: 0, cancelled: false, xhr: null, done: false };
  censorState.job = job;
  closeCensorModal();                 // runs in the background from here
  censorShowToast('Preparing…', 0);
  updateCensorButtonsUI();

  try{
    const version = job.type === 'image' ? await censorRunImage(item, opts, job) : await censorRunVideo(item, opts, job);
    if(job.cancelled) return;
    if(!version) return;              // nothing found — already reported
    await variantsAdd(item, version);
    toast(`Censored ${job.type === 'image' ? 'photo' : 'video'} saved as a variant of "${item.name}"`);
    if(censorState.itemPath === item.path) censorSelectVersion(version.id);
  }catch(err){
    if(job.cancelled || (err && err.message === 'cancelled')) return;
    console.error('Censor failed', err);
    toast(err && err.message ? err.message : 'Censoring failed.');
  }finally{
    job.done = true;
    if(censorState.job === job) censorHideToast();
    updateCensorButtonsUI();
  }
}

async function censorRunVideo(item, opts, job){
  censorJobProgress(job, 'Preparing video…', 0);
  const blob = await censorGetSourceBlob(item);
  if(job.cancelled) throw new Error('cancelled');
  const jobId = await censorUpload(blob, (item.name || 'video').replace(/[^\w.\-]+/g, '_') + (/\.\w+$/.test(item.name || '') ? '' : '.mp4'), {
    style: opts.style, censor_style: opts.style, style_name: opts.style,
    solid_color: opts.solidColor, categories: opts.categories.join(','), sample_every: opts.detail,
  }, job);

  for(;;){
    if(job.cancelled) throw new Error('cancelled');
    await new Promise(r => setTimeout(r, 700));
    const r = await censorFetch(`/video_progress/${jobId}`);
    if(!r.ok) throw new Error('The app stopped answering.');
    const p = await r.json();
    if(p.status === 'error') throw new Error(p.error || 'The app hit an error while censoring.');
    const total = p.total || 1, frac = Math.min(1, (p.current || 0) / total);
    // stages share the bar: upload 0-15%, detect 15-45%, censor 45-90%, encode 90-100%
    let overall = 0.15;
    if(p.status === 'decoding') overall = 0.15 + frac * 0.05;
    else if(p.status === 'queued_for_gpu') overall = 0.2;
    else if(p.status === 'detecting') overall = 0.2 + frac * 0.25;
    else if(p.status === 'censoring') overall = 0.45 + frac * 0.45;
    else if(p.status === 'encoding') overall = 0.92;
    else if(p.status === 'done') overall = 0.97;
    censorJobProgress(job, `Censoring video — ${CENSOR_STATUS_LABELS[p.status] || 'Working…'}`, overall);
    if(p.status === 'done') break;
  }

  censorJobProgress(job, 'Downloading the result…', 0.98);
  const res = await censorFetch(`/video_result/${jobId}`);
  if(!res.ok) throw new Error('Couldn\'t download the finished video.');
  const out = await res.blob();
  if(job.cancelled) throw new Error('cancelled');
  return {
    id: `cv_${Date.now().toString(36)}`, createdAt: Date.now(), kind: 'censor',
    style: opts.style, solidColor: opts.solidColor, categories: opts.categories, detail: opts.detail,
    label: censorLabelFor(opts), mime: 'video/mp4',
    blob: new Blob([out], { type: 'video/mp4' }),
  };
}

/* ---- photos: detect with the in-browser NudeNet model, draw, save ---- */
function censorCanvasToBlob(canvas, mime, quality){
  return new Promise((resolve, reject) => {
    try{
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('Couldn\'t encode the censored photo.')), mime, quality);
    }catch(e){ reject(e); }
  });
}

async function censorRunImage(item, opts, job){
  if(typeof loadNudenetSession !== 'function') throw new Error('The photo detector isn\'t available in this build.');
  censorJobProgress(job, 'Loading the detector…', 0.05);
  let session;
  try{ session = await loadNudenetSession(); }
  catch(e){ throw new Error('Couldn\'t load the detector model (models/nudenet-320n.onnx) — the region scan needs it too.'); }
  if(job.cancelled) throw new Error('cancelled');

  censorJobProgress(job, 'Reading the photo…', 0.2);
  const src = item.pairRemote ? await ensureItemUrlAsync(item) : ensureItemUrl(item);
  if(!src) throw new Error('This photo has no readable source.');
  const img = await loadImageElement(src);
  if(job.cancelled) throw new Error('cancelled');

  censorJobProgress(job, 'Finding regions…', 0.4);
  const classSet = new Set();
  opts.categories.forEach(c => (CENSOR_IMAGE_CLASS_MAP[c] || []).forEach(n => classSet.add(n)));
  const lb = letterboxToTensor(img);
  const results = await session.run({ [session.inputNames[0]]: lb.tensor });
  const output = results[session.outputNames[0]];
  let boxes;
  const prevClasses = state.nsfwRegionClasses;
  state.nsfwRegionClasses = classSet;     // decode is synchronous, so the swap can't leak
  try{ boxes = decodeDetectorOutput(output, lb); }
  finally{ state.nsfwRegionClasses = prevClasses; }
  if(job.cancelled) throw new Error('cancelled');

  if(!boxes.length){
    toast('Nothing to censor found in this photo for those categories.');
    return null;
  }
  // give each box a little breathing room so edges don't peek out
  boxes = boxes.map(b => {
    const px = b.w * 0.08, py = b.h * 0.08;
    const x = Math.max(0, b.x - px), y = Math.max(0, b.y - py);
    return { x, y, w: Math.min(1 - x, b.w + px * 2), h: Math.min(1 - y, b.h + py * 2) };
  });

  censorJobProgress(job, 'Applying the effect…', 0.75);
  const canvas = document.createElement('canvas');
  const longSide = Math.max(img.naturalWidth, img.naturalHeight);
  if(opts.style === 'pixelate') pixelateRegionsToCanvas(img, canvas, boxes, Math.max(12, Math.round(longSide / 70)));
  else if(opts.style === 'box') blackboxRegionsToCanvas(img, canvas, boxes);
  else if(opts.style === 'solid'){
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    ctx.fillStyle = opts.solidColor;
    boxes.forEach(b => ctx.fillRect(Math.round(b.x * canvas.width), Math.round(b.y * canvas.height), Math.max(1, Math.round(b.w * canvas.width)), Math.max(1, Math.round(b.h * canvas.height))));
  } else blurRegionsToCanvas(img, canvas, boxes, Math.max(14, Math.round(longSide / 45)));

  censorJobProgress(job, 'Saving…', 0.92);
  const ext = String(item.ext || '').toLowerCase();
  const mime = (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
  let blob;
  try{ blob = await censorCanvasToBlob(canvas, mime, 0.92); }
  catch(e){ throw new Error('This photo can\'t be censored here — its host doesn\'t allow reading the pixels.'); }
  return {
    id: `cv_${Date.now().toString(36)}`, createdAt: Date.now(), kind: 'censor',
    style: opts.style, solidColor: opts.solidColor, categories: opts.categories,
    label: censorLabelFor(opts), mime: blob.type || mime, blob,
  };
}

function censorLabelFor(o){
  const styles = [...CENSOR_STYLES, ...CENSOR_IMAGE_STYLES];
  const styleName = (styles.find(s => s[0] === o.style) || [, o.style])[1];
  const what = o.categories.length > 2 ? `${o.categories.length} areas` : o.categories.map(c => (CENSOR_CATEGORIES.find(x => x[0] === c) || [, c])[1]).join(' + ');
  return `${styleName} · ${what}`;
}

/* ==========================================================================
   Variants — storage, counts/badges, and the picker
   ========================================================================== */
async function variantsLoad(path){
  try{
    const list = await idbGet(censorKey(path));
    return Array.isArray(list) ? list : [];
  }catch(e){ return []; }
}
async function variantsPersist(path, list){
  try{ await idbSet(censorKey(path), list); }
  catch(e){ console.error('Could not save variants', e); toast('Couldn\'t save that variant to storage.'); return false; }
  variantsSetCount(path, list.length);
  return true;
}

/* A card gets a "+X" badge when its item has variants. `hostSelector` is
   where the badge goes (the thumbnail); the card is found again by data-vpath. */
function decorateVariantBadge(card, item, hostSelector){
  if(!card || !item) return;
  card.dataset.vpath = item.path;
  card._vhostSel = hostSelector || '';
  variantsPaintBadge(card);
}
function variantsPaintBadge(card){
  const host = (card._vhostSel && card.querySelector(card._vhostSel)) || card;
  const old = host.querySelector(':scope > .variant-badge');
  if(old) old.remove();
  const n = variantCounts.get(card.dataset.vpath) || 0;
  if(!n) return;
  const b = document.createElement('span');
  b.className = 'variant-badge';
  b.title = `${n} variant${n === 1 ? '' : 's'} — open to switch`;
  b.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none"><rect x="3.5" y="3.5" width="12" height="12" rx="2" stroke="currentColor" stroke-width="2"/><path d="M8.5 20.5h10a2 2 0 0 0 2-2v-10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>+${n}`;
  host.appendChild(b);
}
function variantsSetCount(path, n){
  if(n > 0) variantCounts.set(path, n); else variantCounts.delete(path);
  document.querySelectorAll('[data-vpath]').forEach(card => { if(card.dataset.vpath === path) variantsPaintBadge(card); });
}
async function variantsInitCounts(){
  try{
    const keys = await idbGetAllKeysWithPrefix('censor:');
    for(const k of keys){
      const list = await idbGet(k);
      if(Array.isArray(list) && list.length) variantCounts.set(k.slice('censor:'.length), list.length);
    }
    document.querySelectorAll('[data-vpath]').forEach(variantsPaintBadge);
  }catch(e){ /* badges just won't show until something changes */ }
}

async function variantsAdd(item, version){
  const sameOpen = censorState.itemPath === item.path;
  const list = sameOpen ? censorState.versions : await variantsLoad(item.path);
  list.push(version);
  if(sameOpen) censorState.versions = list;
  await variantsPersist(item.path, list);
  if(sameOpen) censorRenderVersions();
}

function censorUrlFor(v){
  if(!censorState.urls.has(v.id)) censorState.urls.set(v.id, URL.createObjectURL(v.blob));
  return censorState.urls.get(v.id);
}
/* Used by the scrub preview so hovering the seekbar never reveals uncensored frames. */
function censorActiveUrl(item){
  if(!censorState.activeId || !item || item.path !== censorState.itemPath) return null;
  const v = censorState.versions.find(x => x.id === censorState.activeId);
  return v ? censorUrlFor(v) : null;
}
/* Used by the photo pop-out so zooming shows the picked variant, not the original. */
function variantActiveImageUrl(item){
  return censorIsImage(item) ? censorActiveUrl(item) : null;
}

function censorSelectVersion(id){
  const item = censorState.item;
  if(!item) return;
  let url = null;
  if(id){
    const v = censorState.versions.find(x => x.id === id);
    if(!v) return;
    url = censorUrlFor(v);
  }
  censorState.activeId = id || null;

  if(censorIsImage(item)){
    const img = censorEl('focusImg'), wrap = censorEl('focusImgWrap');
    const gate = censorEl('focusNsfwGate'), rehide = censorEl('focusRehideBtn');
    if(!img || !wrap) return;
    if(url){
      // A variant is shown as-is (that's the point of censoring): drop the blur gate.
      wrap.classList.add('variant-shown');
      wrap.classList.remove('nsfw-gated', 'nsfw-baked');
      if(gate) gate.hidden = true;
      if(rehide) rehide.hidden = true;
      img.src = url;
    } else {
      wrap.classList.remove('variant-shown', 'nsfw-revealed');
      try{ focusGateOriginalSrc = null; }catch(e){}
      const back = (src) => { if(state.currentImage === item && !censorState.activeId){ img.src = src; applyFocusNsfwGate(item); } };
      if(item.pairRemote) ensureItemUrlAsync(item).then(back).catch(() => {});
      else back(ensureItemUrl(item));
    }
    censorRenderVersions();
    return;
  }

  const player = censorEl('videoPlayer');
  if(!player) return;
  const src = url || (item.pairRemote ? (item.url || '') : ensureItemUrl(item));
  if(!src) return;
  const t = player.currentTime || 0;
  const wasPlaying = !player.paused && !player.ended;
  player.src = src;
  const restore = () => {
    player.removeEventListener('loadedmetadata', restore);
    try{ player.currentTime = Math.min(t, (player.duration || t) - 0.05); }catch(e){}
    if(wasPlaying) player.play().catch(() => {});
  };
  player.addEventListener('loadedmetadata', restore);
  censorRenderVersions();
}

async function censorDeleteVersion(id){
  const item = censorState.item;
  if(!item) return;
  const idx = censorState.versions.findIndex(v => v.id === id);
  if(idx < 0) return;
  if(!confirm('Delete this variant?')) return;
  if(censorState.activeId === id) censorSelectVersion(null);
  const url = censorState.urls.get(id);
  if(url){ URL.revokeObjectURL(url); censorState.urls.delete(id); }
  censorState.versions.splice(idx, 1);
  await variantsPersist(item.path, censorState.versions);
  censorRenderVersions();
}

function censorRenderVersions(){
  const item = censorState.item;
  const wrap = item ? censorEl(censorIsImage(item) ? 'focusVariants' : 'watchVariants') : null;
  // keep the other viewer's bar empty so it never shows stale chips
  ['focusVariants', 'watchVariants'].forEach(id => {
    const el = censorEl(id);
    if(el && el !== wrap){ el.hidden = true; el.innerHTML = ''; }
  });
  if(!wrap) return;
  const list = censorState.versions;
  wrap.hidden = list.length === 0;
  if(!list.length){ wrap.innerHTML = ''; return; }
  const chip = (id, label, sub, kind) => `
    <div class="censor-chip ${censorState.activeId === id ? 'is-active' : ''}" data-id="${id || ''}">
      <button type="button" class="censor-chip-main" title="${escapeAttr(label)}">
        <span class="censor-chip-name">${escapeHtml(label)}</span>${sub ? `<span class="censor-chip-sub ${kind ? 'kind' : ''}">${escapeHtml(sub)}</span>` : ''}
      </button>
      ${id ? `<button type="button" class="censor-chip-del" title="Delete this variant" aria-label="Delete this variant">×</button>` : ''}
    </div>`;
  wrap.innerHTML = `<div class="censor-versions-head">Variants</div><div class="censor-chips">` +
    chip(null, 'Original', '') +
    list.map((v, i) => chip(v.id, v.label || `Variant ${i + 1}`, v.kind === 'upload' ? 'Added' : 'Censored', true)).join('') +
    `<button type="button" class="variant-add" data-add="1" title="Add another variant">+ Add</button></div>`;
  wrap.querySelectorAll('.censor-chip').forEach(el => {
    const id = el.dataset.id || null;
    el.querySelector('.censor-chip-main').addEventListener('click', () => {
      if((censorState.activeId || null) !== id) censorSelectVersion(id);
    });
    const del = el.querySelector('.censor-chip-del');
    if(del) del.addEventListener('click', (e) => { e.stopPropagation(); censorDeleteVersion(id); });
  });
  const add = wrap.querySelector('[data-add]');
  if(add) add.addEventListener('click', () => variantsPickFile(item));
}

/* Called when a video or photo is opened: reset to the original and load its variants. */
async function variantsOpenItem(item){
  if(!item) return;
  if(censorState.itemPath !== item.path){
    censorState.urls.forEach(u => URL.revokeObjectURL(u));
    censorState.urls.clear();
  }
  const wrap = censorEl('focusImgWrap');
  if(wrap) wrap.classList.remove('variant-shown');
  censorState.item = item;
  censorState.activeId = null;
  censorState.itemPath = item.path;
  censorState.versions = [];
  censorRenderVersions();
  updateCensorButtonsUI();
  const loaded = await variantsLoad(item.path);
  if(censorState.item !== item) return; // moved on while loading
  censorState.versions = loaded;
  variantsSetCount(item.path, loaded.length);
  censorRenderVersions();
}
/* Kept under the old name — openWatch calls this. */
function censorRefreshVersions(item){ return variantsOpenItem(item); }

/* ---- adding your own variants ----
   "Add variant" opens the shared library picker (same one the website
   background uses): choose photos/videos from the library or upload from
   this device, and each one is saved as a variant of the open item. */
let variantsPickerBusy = false;
async function variantsPickFile(item){
  if(!item || variantsPickerBusy) return;
  if(typeof openImagePicker !== 'function'){
    toast('The picker didn\'t load — try refreshing the page.');
    return;
  }
  variantsPickerBusy = true;
  try{
    const isImage = censorIsImage(item);
    const picked = await openImagePicker({
      kind: isImage ? 'image' : 'video',
      multiple: true,
      title: 'Add variants',
      subtitle: `Variants of: ${item.name}`,
      excludePath: item.path,
      confirmLabel: (n) => n > 1 ? `Add ${n} variants` : 'Add variant',
    });
    if(picked && picked.length) await variantsHandleFiles(item, picked);
  } finally {
    variantsPickerBusy = false;
  }
}

/* `entries` are what the picker hands back: [{ blob, name }, …] */
async function variantsHandleFiles(item, entries){
  const wantImage = censorIsImage(item);
  const ok = entries.filter(e => e && e.blob && (e.blob.type ? e.blob.type.startsWith(wantImage ? 'image/' : 'video/') : true));
  if(!ok.length){ toast(wantImage ? 'Pick an image file.' : 'Pick a video file.'); return; }
  if(ok.length < entries.length) toast(`Skipped ${entries.length - ok.length} file${entries.length - ok.length === 1 ? '' : 's'} that weren't ${wantImage ? 'images' : 'videos'}.`);
  let last = null;
  for(const e of ok){
    const version = {
      id: `cv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      createdAt: Date.now(), kind: 'upload',
      label: (e.name || '').replace(/\.[^.]+$/, '') || 'Variant', mime: e.blob.type || '',
      blob: e.blob,
    };
    await variantsAdd(item, version);
    last = version;
  }
  toast(ok.length === 1 ? 'Variant added' : `${ok.length} variants added`);
  if(last && censorState.itemPath === item.path) censorSelectVersion(last.id);
}

/* ---------------- wiring ---------------- */
function bindCensorModal(){
  const btn = censorEl('censorBtn');
  if(btn) btn.addEventListener('click', () => openCensorModal(state.currentVideo || null));
  const imgBtn = censorEl('focusCensorBtn');
  if(imgBtn) imgBtn.addEventListener('click', () => openCensorModal(state.currentImage || null));

  const wvBtn = censorEl('watchVariantBtn');
  if(wvBtn) wvBtn.addEventListener('click', () => variantsPickFile(state.currentVideo));
  const fvBtn = censorEl('focusVariantBtn');
  if(fvBtn) fvBtn.addEventListener('click', () => variantsPickFile(state.currentImage));

  const cancel = censorEl('censorToastCancel');
  if(cancel) cancel.addEventListener('click', censorCancelRun);

  variantsInitCounts();

  const backdrop = censorEl('censorModalBackdrop');
  if(!backdrop) return;
  censorEl('censorModalClose').addEventListener('click', closeCensorModal);
  backdrop.addEventListener('click', (e) => { if(e.target === backdrop) closeCensorModal(); });
  censorEl('censorLinkBtn').addEventListener('click', censorLinkSubmit);
  censorEl('censorLinkInput').addEventListener('keydown', (e) => { if(e.key === 'Enter') censorLinkSubmit(); });
  censorEl('censorOpenSite').addEventListener('click', () => window.open(CENSOR_SITE_URL, '_blank', 'noopener'));
  censorEl('censorRelinkBtn').addEventListener('click', () => {
    try{ localStorage.removeItem(CENSOR_LINK_KEY); }catch(e){}
    censorState.base = null;
    censorEl('censorLinkInput').value = '';
    censorSetLinkStatus('');
    censorShowPane('link');
  });
  censorEl('censorStartBtn').addEventListener('click', censorStartRun);
}
document.addEventListener('DOMContentLoaded', bindCensorModal);
