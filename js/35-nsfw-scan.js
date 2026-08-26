/* ==========================================================================
   NSFW content detection — runs entirely on-device (tfjs + nsfwjs, GPU-
   accelerated via WebGL when available, falling back to CPU/WASM). Nothing
   ever leaves the browser: every classification runs against a local
   <img>/canvas element.

   Scope: photos by default, but videos can be included too (see the "Scan
   media scope" setting) — when they are, each video's thumbnail (generated
   the same way the grid thumbnails are, and cached alongside them) is what
   actually gets classified, since there's no cheap way to classify motion
   video directly. A video never gets flagged/gated until it has a thumbnail
   to check, so the very first scan after a fresh library scan may skip a
   few videos whose thumbnail hasn't been generated yet — a second scan run
   picks those up once thumbnails exist.

   Model download + caching: the first time a scan runs, nsfwjs.load() pulls
   the model from its CDN, which can take a moment on a slow connection — the
   progress toast says so explicitly while that download is in flight. Right
   after that first download, the model is saved into this browser's
   IndexedDB (nsfwjs supports this natively — see loadNsfwModel below), so
   every scan after that — including on a fresh page load — loads instantly
   from disk instead of hitting the network again.

   Category picker: scanning the whole library every time gets slow once a
   library is large, so the Settings scan button is paired with a "which
   category" dropdown (populated from the same photo categories used
   elsewhere in the app). Pick "All photos" to scan everything, or a single
   folder to just scan that.

   Caveat worth knowing: nsfwjs is a whole-image classifier, not an object
   detector — it has no idea *where* in the frame anything is, only how
   likely the whole image is Porn/Hentai/Sexy/Neutral/Drawing. So "point to
   the exact region" isn't something this model can do without swapping in a
   much heavier detection model (which would cost the speed that's the whole
   reason to use this one). The practical middle ground used here: a flagged
   photo gets pixelated in full behind a gate, and unblurring reveals the
   whole image — same end result, just without a bounding box.
   ========================================================================== */

let nsfwModel = null;
let nsfwModelLoading = null;
let nsfwScanState = { running: false, processed: 0, total: 0, cancel: false };

/* ---------- cache ---------- */

function nsfwCacheKey(item){ return favKey(item); }

function getNsfwRecord(item){
  return state.nsfwResults[nsfwCacheKey(item)] || null;
}

/* A cached record is only trusted while the underlying file looks unchanged
   (same size + lastModified) — anything else (a re-saved/replaced file, a
   different photo that happens to reuse a path) gets re-scanned. */
function isNsfwRecordFresh(item, record){
  return !!record && record.size === item.size && record.lastModified === item.lastModified;
}

function isNsfwFlagged(item){
  const record = getNsfwRecord(item);
  return !!(record && isNsfwRecordFresh(item, record) && record.flagged);
}

/* Whether the master feature + the "blur & tag" display setting are both on.
   When this is false, cached results still exist but nothing is ever shown —
   no badge, no blur, no gate. */
function nsfwUIActive(){
  return !!(state.nsfwFeatureUnlocked && state.nsfwBlurEnabled);
}

function shouldGateItem(item){
  // isNsfwRegionFlagged is defined in 36-nsfw-regions.js (loaded after this
  // file); by the time this runs (user interaction, post-load) it exists.
  return nsfwUIActive() && (isNsfwFlagged(item) || (typeof isNsfwRegionFlagged === 'function' && isNsfwRegionFlagged(item)));
}

/* ---------- model ---------- */

function loadNsfwModel(){
  if(nsfwModel) return Promise.resolve(nsfwModel);
  if(nsfwModelLoading) return nsfwModelLoading;
  nsfwModelLoading = (async () => {
    try{
      if(typeof nsfwjs === 'undefined' || typeof tf === 'undefined'){
        throw new Error('NSFW model library did not load (check your connection).');
      }

      // Fast path: a copy already cached in this browser's IndexedDB from a
      // previous run. No network involved at all when this succeeds.
      //
      // NOTE: tf.io.browserIndexedDB is NOT part of tfjs's public API in the
      // version this app loads (verified against the actual 4.20.0 bundle —
      // it exists internally but is never exposed on tf.io), so calling it
      // throws "tf.io.browserIndexedDB is not a function" every single time
      // and we always fell through to a redownload. The supported way to
      // hit IndexedDB is to pass the plain 'indexeddb://...' URL string —
      // nsfwjs 4.2.1's loader explicitly checks for and preserves that
      // scheme (it only appends '/model.json' to strings that *aren't*
      // indexeddb:// or localstorage:// and don't already end in
      // model.json), and tf itself resolves that scheme via its own
      // internally-registered IndexedDB router. No direct call to
      // tf.io.browserIndexedDB is needed at all.
      const NSFW_MODEL_INDEXEDDB_URL = `indexeddb://${NSFW_MODEL_CACHE_KEY}`;
      try{
        nsfwModel = await nsfwjs.load(NSFW_MODEL_INDEXEDDB_URL);
        return nsfwModel;
      }catch(e){
        // Nothing cached yet (first run ever, cache was cleared, etc.) —
        // fall through to a real download below.
        console.info('NSFW model: no cached copy in IndexedDB yet, downloading.', e);
      }

      // NOTE: nsfwjs.load() with no argument is also broken when nsfwjs is
      // loaded as a plain <script> tag from the CDN (dist/browser/nsfwjs.min.js).
      // It lazy-loads its bundled weights via a *relative* dynamic import
      // (import("./model_imports/mobilenet_v2.js")), but that folder was
      // never published next to the browser bundle on npm/jsDelivr — only
      // next to the esm/cjs builds — so the import 404s and nsfwjs rethrows
      // it as "Could not load the model." Passing an explicit model.json URL
      // sidesteps nsfwjs's broken by-name loader entirely and goes straight
      // through tf's normal, working HTTP IOHandler.
      showNsfwProgress('Downloading NSFW detection model (first run only)…', 0, 0);
      try{
        nsfwModel = await nsfwjs.load(NSFW_MODEL_URL);
      }catch(e){
        console.error('NSFW model: download failed.', e);
        throw e;
      } finally {
        hideNsfwProgress();
      }

      // Cache it for next time so future scans — and future app launches —
      // skip the download entirely. Best-effort: if IndexedDB isn't
      // available (private browsing, storage quota, etc.) the model still
      // works fine, it just won't be cached and will re-download next time.
      try{ await nsfwModel.model.save(NSFW_MODEL_INDEXEDDB_URL); }
      catch(e){ console.warn('NSFW model: could not cache to IndexedDB (non-fatal).', e); }

      return nsfwModel;
    } finally {
      nsfwModelLoading = null;
    }
  })();
  return nsfwModelLoading;
};

function loadImageElement(src){
  return new Promise((resolve, reject) => {
    const img = new Image();
    try{ img.crossOrigin = 'anonymous'; img.referrerPolicy = 'no-referrer'; }catch(e){}
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode image'));
    img.src = src;
  });
}

async function classifyImageElement(imgEl){
  const predictions = await nsfwModel.classify(imgEl);
  const scores = {};
  predictions.forEach(p => { scores[p.className] = p.probability; });
  const badScore = (scores.Porn || 0) + (scores.Hentai || 0) + (scores.Sexy || 0);
  const top = predictions.slice().sort((a, b) => b.probability - a.probability)[0];
  return {
    flagged: badScore >= NSFW_SCORE_THRESHOLD,
    score: badScore,
    label: top ? top.className : null,
  };
}

/* ---------- scanning a single item ---------- */

async function scanImageItemForNsfw(item){
  const src = ensureItemUrl(item);
  if(!src) return null;
  let img;
  try{ img = await loadImageElement(src); }
  catch(e){ return null; }
  const result = await classifyImageElement(img);
  const record = {
    flagged: result.flagged,
    score: Math.round(result.score * 1000) / 1000,
    label: result.label,
    size: item.size,
    lastModified: item.lastModified,
    scannedAt: Date.now(),
  };
  state.nsfwResults[nsfwCacheKey(item)] = record;
  return record;
}

/* ---------- progress toast — shared by this file and 36-nsfw-regions.js ---------- */

function showNsfwProgress(label, processed, total){
  const el = document.getElementById('nsfwProgressToast');
  if(!el) return;
  el.hidden = false;
  const labelEl = document.getElementById('nsfwProgressLabel');
  const countEl = document.getElementById('nsfwProgressCount');
  const fillEl = document.getElementById('nsfwProgressFill');
  if(labelEl) labelEl.textContent = label;
  if(countEl) countEl.textContent = total ? `${processed} / ${total}` : '';
  if(fillEl) fillEl.style.width = `${total ? Math.max(0, Math.min(100, Math.round((processed / total) * 100))) : 0}%`;
}
function hideNsfwProgress(){
  const el = document.getElementById('nsfwProgressToast');
  if(el) el.hidden = true;
}

/* ---------- full-library scan ---------- */

function nsfwScanTargets(force, category, mediaScope = state.nsfwMediaScope || (state.nsfwIncludeVideos ? 'all' : 'photos')){
  const images = state.rawImages.filter(i => !i.pairRemote);
  const snapshots = state.snapshots.filter(s => s && s.type === 'image' && !s.pairRemote);
  const videos = (mediaScope === 'all' || mediaScope === 'videos') ? state.rawVideos.filter(v => !v.pairRemote) : [];

  const photoBase = mediaScope === 'videos' ? [] : [...images, ...snapshots];
  let collection = [...photoBase, ...videos];
  if(category && category !== 'all'){
    collection = collection.filter(item => item.category === category);
  }

  const all = collection.map(item => ({ item }));
  if(force) return all;
  return all.filter(({ item }) => !isNsfwRecordFresh(item, getNsfwRecord(item)));
}

/* ---------- category picker (Settings) ---------- */

function getNsfwScanCategorySelectEl(){
  return document.getElementById('nsfwScanCategorySelect');
}

function getSelectedNsfwScanCategory(){
  const el = getNsfwScanCategorySelectEl();
  return el ? (el.value || 'all') : 'all';
}

/* Keeps the dropdown's option list in sync with the photo categories that
   actually exist right now, without clobbering whatever the person has
   currently selected (falls back to "All photos" if that category no
   longer exists, e.g. the folder was removed). */
function populateNsfwScanCategorySelect(){
  const select = getNsfwScanCategorySelectEl();
  if(!select) return;
  const imageCats = (state.categoriesByTab && state.categoriesByTab.images) ? state.categoriesByTab.images : [];
  const videoCats = (state.categoriesByTab && state.categoriesByTab.videos) ? state.categoriesByTab.videos : [];
  const cats = [...new Set([...imageCats, ...videoCats, 'Snapshots'])];
  const current = select.value || 'all';
  const categoryOptions = cats.map(cat => `<option value="${escapeAttr(cat)}">${escapeHtml(cat)}</option>`).join('');
  select.innerHTML = `<option value="all">All media</option>${categoryOptions}`;
  select.value = (current === 'all' || cats.includes(current)) ? current : 'all';
}

async function scanVideoItemForNsfw(item){
  if(!item || item.type !== 'video') return null;
  try{ await ensureVideoMeta(item); }
  catch(e){ return null; }
  const src = item.thumb || null;
  if(!src) return null;
  let img;
  try{ img = await loadImageElement(src); }
  catch(e){ return null; }
  let result;
  try{ result = await classifyImageElement(img); }
  catch(e){ return null; } // e.g. a 0x0 decoded thumbnail — skip rather than abort the whole scan
  const record = {
    flagged: result.flagged,
    score: Math.round(result.score * 1000) / 1000,
    label: result.label,
    size: item.size,
    lastModified: item.lastModified,
    scannedAt: Date.now(),
  };
  state.nsfwResults[nsfwCacheKey(item)] = record;
  return record;
}

async function scanLibraryForNsfw(opts = {}){
  if(!state.nsfwFeatureUnlocked){ toast('Redeem a code to unlock NSFW detection first.'); return; }
  if(nsfwScanState.running){ toast('A scan is already running.'); return; }

  // opts.category lets callers (e.g. the quiet startup auto-scan) force a
  // specific scope; otherwise use whatever category is picked in Settings.
  const category = opts.category || getSelectedNsfwScanCategory();
  const categoryLabel = category === 'all' ? '' : ` in “${category}”`;
  const mediaScope = opts.mediaScope || state.nsfwMediaScope || (state.nsfwIncludeVideos ? 'all' : 'photos');

  const targets = nsfwScanTargets(!!opts.force, category, mediaScope);
  if(!targets.length){
    toast(`Nothing new to scan${categoryLabel} — everything is already up to date.`);
    return;
  }

  try{
    await loadNsfwModel();
  }catch(e){
    console.error('NSFW scan: could not load model.', e);
    toast('Could not load the NSFW model — check your connection and try again.');
    return;
  }

  nsfwScanState = { running: true, processed: 0, total: targets.length, cancel: false };
  updateNsfwScanUI();
  if(!opts.quiet) toast(`Scanning ${targets.length} item${targets.length === 1 ? '' : 's'}${categoryLabel} for NSFW content…`);
  showNsfwProgress(`Scanning for NSFW content${categoryLabel}…`, 0, targets.length);

  let flaggedCount = 0;
  for(const { item } of targets){
    if(nsfwScanState.cancel) break;
    try{
      const record = item.type === 'video' ? await scanVideoItemForNsfw(item) : await scanImageItemForNsfw(item);
      if(record && record.flagged) flaggedCount++;
    }catch(e){ /* skip whatever file wouldn't decode */ }
    nsfwScanState.processed++;
    showNsfwProgress(`Scanning for NSFW content${categoryLabel}…`, nsfwScanState.processed, nsfwScanState.total);
    if(nsfwScanState.processed % 5 === 0 || nsfwScanState.processed === nsfwScanState.total){
      saveNsfwResults();
      updateNsfwScanUI();
    }
    // yield back to the main thread so the UI (and the Stop button) stay responsive
    await new Promise(r => setTimeout(r, 0));
  }
  saveNsfwResults();
  hideNsfwProgress();

  const wasCancelled = nsfwScanState.cancel;
  const processed = nsfwScanState.processed;
  nsfwScanState = { running: false, processed: 0, total: 0, cancel: false };
  updateNsfwScanUI();
  refreshNsfwVisuals();

  if(!opts.quiet || wasCancelled || flaggedCount > 0){
    toast(wasCancelled
      ? `NSFW scan stopped — ${processed} checked`
      : `NSFW scan complete — ${processed} checked, ${flaggedCount} flagged`);
  }
}

function cancelNsfwScan(){
  if(nsfwScanState.running) nsfwScanState.cancel = true;
}

/* Called on startup (if the setting is on) — quieter than a manual scan:
   no toast unless something actually gets flagged, since this can run
   every launch and shouldn't nag. */
async function maybeAutoScanNsfwOnStartup(){
  if(!state.nsfwFeatureUnlocked || !state.nsfwScanOnStartup) return;
  const targets = nsfwScanTargets(false, 'all', state.nsfwMediaScope || (state.nsfwIncludeVideos ? 'all' : 'photos'));
  if(!targets.length) return;
  await scanLibraryForNsfw({ quiet: true, category: 'all', mediaScope: state.nsfwMediaScope || (state.nsfwIncludeVideos ? 'all' : 'photos') });
}

/* ---------- settings modal UI ---------- */

function updateNsfwScanUI(){
  const btn = document.getElementById('nsfwScanBtn');
  const status = document.getElementById('nsfwScanStatus');
  const categorySelect = getNsfwScanCategorySelectEl();
  populateNsfwScanCategorySelect();
  if(categorySelect) categorySelect.disabled = !state.nsfwFeatureUnlocked || nsfwScanState.running;
  if(btn){
    if(!state.nsfwFeatureUnlocked){
      btn.disabled = true;
      btn.textContent = 'Scan library';
    } else if(nsfwScanState.running){
      btn.disabled = false;
      btn.textContent = `Stop (${nsfwScanState.processed}/${nsfwScanState.total})`;
    } else {
      btn.disabled = false;
      btn.textContent = 'Scan library';
    }
  }
  if(status){
    if(!state.nsfwFeatureUnlocked){
      status.textContent = '';
    } else if(nsfwScanState.running){
      status.textContent = `Scanning… ${nsfwScanState.processed} of ${nsfwScanState.total}`;
    } else {
      const total = Object.keys(state.nsfwResults).length;
      const flagged = Object.values(state.nsfwResults).filter(r => r.flagged).length;
      status.textContent = total ? `${total} checked so far · ${flagged} flagged` : 'Not scanned yet.';
    }
  }
}

/* Re-renders whatever's currently visible so badges/blur reflect the latest
   scan results — the active grid, the focus-view gate if a flagged photo
   happens to be open, the video watch gate, its related-videos side list,
   and the home/discover rows (For You, Continue watching, Recently added) —
   none of those last ones used to get touched here, so a scan finishing
   while one was already on screen left it showing stale, unblurred cards. */
function refreshNsfwVisuals(){
  if(state.tab === 'videos' || state.tab === 'images') renderActiveGrid();
  const focusView = document.getElementById('imageFocus');
  if(focusView && !focusView.hidden && state.currentImage) applyFocusNsfwGate(state.currentImage);
  const watchView = document.getElementById('videoWatch');
  if(watchView && !watchView.hidden && state.currentVideo){
    applyWatchNsfwGate(state.currentVideo);
    if(typeof refreshWatchSideList === 'function') refreshWatchSideList();
  }
  if(typeof renderForYouRow === 'function') renderForYouRow();
  if(typeof renderDiscoverSections === 'function') renderDiscoverSections();
}

/* ---------- focus-view gate (blur / pixelate / black-box + click-to-unblur) ---------- */

function nsfwWarningIconSVG(){
  return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M9 3h6M10 3v5.2L5.5 16a2 2 0 0 0 1.7 3h9.6a2 2 0 0 0 1.7-3L14 8.2V3" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/><circle cx="12" cy="16.3" r="1" fill="currentColor"/></svg>';
}

function getNsfwBlurMethod(){
  return ['blur', 'pixelate', 'blackbox'].includes(state.nsfwBlurMethod) ? state.nsfwBlurMethod : 'pixelate';
}

function blurImageToCanvas(imgEl, canvasEl, blurRadius = 22){
  const w = imgEl.naturalWidth || canvasEl.clientWidth || 320;
  const h = imgEl.naturalHeight || canvasEl.clientHeight || 180;
  if(!w || !h) return;
  canvasEl.width = w; canvasEl.height = h;
  const ctx = canvasEl.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  ctx.filter = `blur(${blurRadius}px)`;
  ctx.drawImage(imgEl, 0, 0, w, h);
  ctx.filter = 'none';
}

function blackboxImageToCanvas(imgEl, canvasEl){
  const w = imgEl.naturalWidth || canvasEl.clientWidth || 320;
  const h = imgEl.naturalHeight || canvasEl.clientHeight || 180;
  if(!w || !h) return;
  canvasEl.width = w; canvasEl.height = h;
  const ctx = canvasEl.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
}

/* Draws a heavily-mosaiced version of imgEl onto canvasEl by rendering at a
   tiny resolution first, then scaling back up with smoothing off. */
function pixelateImageToCanvas(imgEl, canvasEl, pixelSize = 22){
  const w = imgEl.naturalWidth || canvasEl.clientWidth || 320;
  const h = imgEl.naturalHeight || canvasEl.clientHeight || 180;
  if(!w || !h) return;
  const smallW = Math.max(1, Math.round(w / pixelSize));
  const smallH = Math.max(1, Math.round(h / pixelSize));

  const small = document.createElement('canvas');
  small.width = smallW; small.height = smallH;
  const sctx = small.getContext('2d');
  sctx.drawImage(imgEl, 0, 0, smallW, smallH);

  canvasEl.width = w; canvasEl.height = h;
  const ctx = canvasEl.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, smallW, smallH, 0, 0, w, h);
}

function renderFocusNsfwCanvas(imgEl, canvasEl, method, boxes = []){
  if(method === 'blur'){
    if(boxes.length) blurRegionsToCanvas(imgEl, canvasEl, boxes);
    else blurImageToCanvas(imgEl, canvasEl);
  } else if(method === 'blackbox'){
    if(boxes.length) blackboxRegionsToCanvas(imgEl, canvasEl, boxes);
    else blackboxImageToCanvas(imgEl, canvasEl);
  } else {
    if(boxes.length) pixelateRegionsToCanvas(imgEl, canvasEl, boxes);
    else pixelateImageToCanvas(imgEl, canvasEl);
  }
}

/* Which photo the two vars below are cached for — lets applyFocusNsfwGate
   tell "same photo, reapplying (rehide / a fresh scan came in)" apart from
   "a different photo just opened", without needing a separate reset call
   at every call site that opens a photo. */
let focusGateItemRef = null;
// The photo's real, unblurred URL — captured once per photo the first time
// it's gated, and reused as the *source* for every future bake (reveal,
// rehide, a blur-method change, etc.) so re-baking never reads back pixels
// from the currently-visible (possibly already-blurred) <img>, which would
// blur an already-blurred image instead of the real one.
let focusGateOriginalSrc = null;

/* Renders the flagged photo onto a throwaway (never-in-DOM) canvas and
   hands back the blurred/pixelated/blackboxed result as a data URL. Runs
   against a freshly-loaded Image sourced from focusGateOriginalSrc, never
   against the visible #focusImg, so it's always working from real pixels. */
function bakeFocusNsfwImage(item, method, boxes){
  const img = document.getElementById('focusImg');
  const wrap = document.getElementById('focusImgWrap');
  if(!img || !wrap || !focusGateOriginalSrc) return;
  const source = new Image();
  source.onload = () => {
    // Stale by the time this resolves (photo changed, or the gate was
    // toggled off/revealed already) — don't stomp on whatever's showing now.
    if(focusGateItemRef !== item || !wrap.classList.contains('nsfw-gated')) return;
    const canvas = document.createElement('canvas');
    renderFocusNsfwCanvas(source, canvas, method, boxes);
    img.src = canvas.toDataURL('image/jpeg', 0.88);
    // Only reveal #focusImg (see the nsfw-gated:not(.nsfw-baked) CSS rule)
    // once it's actually holding the blurred pixels, never the real ones.
    wrap.classList.add('nsfw-baked');
  };
  source.src = focusGateOriginalSrc;
}

/* Shows/hides the gate for the current photo and — this is the important
   part — actually bakes the blurred pixels into #focusImg itself instead of
   floating a separate <canvas> on top of the real (unblurred) image. A
   canvas-on-top overlay leaves the genuine, un-obscured image sitting right
   there in the DOM underneath it; baking replaces the <img>'s own src with
   the blurred version, so the real pixels simply aren't present while
   gated. Resets to "hidden behind the gate" every time it's called (i.e.
   every time a photo is opened), so unblurring one photo never carries over
   to the next. */
function applyFocusNsfwGate(item){
  const wrap = document.getElementById('focusImgWrap');
  const img = document.getElementById('focusImg');
  const gate = document.getElementById('focusNsfwGate');
  const legacyCanvas = document.getElementById('focusNsfwCanvas'); // no longer drawn to — the image itself is baked now — kept hidden for old layouts that still reference it
  if(!wrap || !img || !gate) return;

  const rehideBtn = document.getElementById('focusRehideBtn');
  wrap.classList.remove('nsfw-revealed');
  if(rehideBtn) rehideBtn.hidden = true;
  if(legacyCanvas) legacyCanvas.hidden = true;

  if(focusGateItemRef !== item){
    focusGateItemRef = item;
    focusGateOriginalSrc = null;
  }

  if(!shouldGateItem(item)){
    gate.hidden = true;
    wrap.classList.remove('nsfw-gated', 'nsfw-baked');
    // In case this photo was baked earlier and the blur setting/scan result
    // changed mid-view, restore the real image rather than leaving it blurred.
    if(focusGateOriginalSrc) img.src = focusGateOriginalSrc;
    return;
  }

  wrap.classList.add('nsfw-gated');
  // Hide #focusImg (still holding the real pixels, or about to) again until
  // the new bake for this call lands — see bakeFocusNsfwImage.
  wrap.classList.remove('nsfw-baked');
  gate.hidden = false;

  // Prefer the region scan (blurs just the flagged spots) when it's run for
  // this photo; otherwise fall back to the full-frame method the user chose.
  const regionRecord = (typeof getNsfwRegionRecord === 'function') ? getNsfwRegionRecord(item) : null;
  const hasFreshRegions = regionRecord && isRegionRecordFresh(item, regionRecord) && regionRecord.boxes.length;
  const method = getNsfwBlurMethod();
  const boxes = hasFreshRegions ? regionRecord.boxes : [];

  const startBake = () => {
    if(!focusGateOriginalSrc) focusGateOriginalSrc = img.src;
    bakeFocusNsfwImage(item, method, boxes);
  };
  if(img.complete && img.naturalWidth) startBake();
  else img.addEventListener('load', startBake, { once: true });
}

function revealFocusNsfwGate(){
  const wrap = document.getElementById('focusImgWrap');
  const gate = document.getElementById('focusNsfwGate');
  const rehideBtn = document.getElementById('focusRehideBtn');
  const img = document.getElementById('focusImg');
  if(!wrap || !gate || !img) return;
  gate.hidden = true;
  wrap.classList.remove('nsfw-gated');
  wrap.classList.add('nsfw-revealed');
  if(rehideBtn) rehideBtn.hidden = false;
  // Swap the real photo back in — it's already cached from the original
  // load, so this is instant, no network/decode wait.
  if(focusGateOriginalSrc) img.src = focusGateOriginalSrc;
}

function rehideFocusNsfwGate(){
  const wrap = document.getElementById('focusImgWrap');
  if(!wrap || !state.currentImage) return;
  wrap.classList.remove('nsfw-revealed');
  applyFocusNsfwGate(state.currentImage);
}

function bindNsfwFocusGate(){
  const unblurBtn = document.getElementById('focusUnblurBtn');
  const rehideBtn = document.getElementById('focusRehideBtn');
  if(unblurBtn) unblurBtn.addEventListener('click', (e) => { e.stopPropagation(); revealFocusNsfwGate(); });
  if(rehideBtn) rehideBtn.addEventListener('click', (e) => { e.stopPropagation(); rehideFocusNsfwGate(); });
}

/* ---------- watch-view gate (video playback blur + click-to-unblur) ----------
   Videos aren't classified directly (see the file header) — what gets
   scanned is each video's thumbnail, generated/cached the exact same way
   the grid thumbnails are (ensureVideoMeta: cached thumb if one exists,
   otherwise generate + cache one). Once a video is flagged, this mirrors
   the image focus gate as closely as a <video> allows: playback doesn't
   start, a blurred/pixelated/blackboxed version of the thumbnail is shown
   as the player's poster, and an Unblur button reveals + starts playback. */

let watchGateItemRef = null;
let watchGateBakedPoster = null;

function isWatchNsfwGated(){
  const wrap = document.getElementById('playerWrap');
  return !!(wrap && wrap.classList.contains('nsfw-gated'));
}

/* Cache-or-generate the thumbnail (ensureVideoMeta), then render it through
   the same blur/pixelate/blackbox path the photo gate uses. */
async function bakeWatchNsfwPoster(item){
  try{ await ensureVideoMeta(item); } catch(e){ return null; }
  if(!item.thumb) return null;
  let img;
  try{ img = await loadImageElement(item.thumb); }
  catch(e){ return null; }
  const method = getNsfwBlurMethod();
  const canvas = document.createElement('canvas');
  renderFocusNsfwCanvas(img, canvas, method);
  return canvas.toDataURL('image/jpeg', 0.85);
}

function applyWatchNsfwGate(item){
  const wrap = document.getElementById('playerWrap');
  const player = document.getElementById('videoPlayer');
  const gate = document.getElementById('watchNsfwGate');
  if(!wrap || !player || !gate) return;

  const rehideBtn = document.getElementById('watchRehideBtn');
  wrap.classList.remove('nsfw-revealed');
  if(rehideBtn) rehideBtn.hidden = true;

  if(watchGateItemRef !== item){
    watchGateItemRef = item;
    watchGateBakedPoster = null;
  }

  if(!shouldGateItem(item)){
    gate.hidden = true;
    wrap.classList.remove('nsfw-gated');
    player.removeAttribute('poster');
    return;
  }

  wrap.classList.add('nsfw-gated');
  gate.hidden = false;
  if(!player.paused) player.pause();

  bakeWatchNsfwPoster(item).then(dataUrl => {
    if(watchGateItemRef !== item || !dataUrl) return; // switched videos while this was baking, or no thumb to work with
    watchGateBakedPoster = dataUrl;
    if(wrap.classList.contains('nsfw-gated')) player.poster = dataUrl;
  });
}

function revealWatchNsfwGate(){
  const wrap = document.getElementById('playerWrap');
  const gate = document.getElementById('watchNsfwGate');
  const rehideBtn = document.getElementById('watchRehideBtn');
  const player = document.getElementById('videoPlayer');
  if(!wrap || !gate || !player) return;
  gate.hidden = true;
  wrap.classList.remove('nsfw-gated');
  wrap.classList.add('nsfw-revealed');
  if(rehideBtn) rehideBtn.hidden = false;
  player.removeAttribute('poster');
  // Triggered by the person's own click on Unblur, so this counts as a user
  // gesture — autoplay-with-sound restrictions won't block it.
  const startPlayback = () => {
    const playPromise = player.play();
    if(playPromise && typeof playPromise.then === 'function') playPromise.catch(() => {});
  };
  const item = state.currentVideo;
  // openWatch withheld the real src entirely while gated (so the browser
  // never had a chance to decode/show a real frame ahead of the poster) —
  // load it for real now that the person has actually unblurred it.
  if(item && !player.src){
    if(item.pairRemote){
      toast(`Loading "${item.name}" from the paired device…`);
      ensureItemUrlAsync(item).then(src => {
        if(state.currentVideo !== item) return;
        player.src = src;
        startPlayback();
      }).catch(() => toast("Couldn't load that video from the paired device."));
    } else {
      player.src = ensureItemUrl(item);
      startPlayback();
    }
  } else {
    startPlayback();
  }
}

function rehideWatchNsfwGate(){
  if(!state.currentVideo) return;
  const wrap = document.getElementById('playerWrap');
  const player = document.getElementById('videoPlayer');
  if(wrap) wrap.classList.remove('nsfw-revealed');
  // A <video> that's already played a real frame keeps showing that frame
  // even after a new `poster` is set — poster only has an effect before
  // any frame has been decoded. So drop the loaded src entirely; the next
  // Unblur (revealWatchNsfwGate) reloads it from scratch, same as the
  // initial gated open.
  if(player){
    player.pause();
    player.removeAttribute('src');
    player.load();
  }
  applyWatchNsfwGate(state.currentVideo);
}

function bindWatchNsfwGate(){
  const unblurBtn = document.getElementById('watchUnblurBtn');
  const rehideBtn = document.getElementById('watchRehideBtn');
  if(unblurBtn) unblurBtn.addEventListener('click', (e) => { e.stopPropagation(); revealWatchNsfwGate(); });
  if(rehideBtn) rehideBtn.addEventListener('click', (e) => { e.stopPropagation(); rehideWatchNsfwGate(); });
}
