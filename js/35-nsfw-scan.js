/* ==========================================================================
   NSFW content detection — runs entirely on-device (tfjs + nsfwjs, GPU-
   accelerated via WebGL when available, falling back to CPU/WASM). Nothing
   ever leaves the browser: the model file is fetched once from its CDN and
   cached by the browser like any other asset, and every classification runs
   against a local <img>/canvas element.

   Scope: photos only (this mirrors the existing Settings copy, which has
   always said "flags photos"). Video items get their generated thumbnail
   frame checked too, since that's already a cheap canvas image — but full
   video playback isn't scanned frame-by-frame.

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
      nsfwModel = await nsfwjs.load();
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

async function scanVideoThumbForNsfw(item){
  await ensureVideoMeta(item);
  if(!item.thumb) return null;
  let img;
  try{ img = await loadImageElement(item.thumb); }
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

function nsfwScanTargets(force){
  const images = state.rawImages.filter(i => !i.pairRemote);
  const videos = state.rawVideos.filter(i => !i.pairRemote);
  const all = [...images.map(i => ({ item: i, kind: 'image' })), ...videos.map(i => ({ item: i, kind: 'video' }))];
  if(force) return all;
  return all.filter(({ item }) => !isNsfwRecordFresh(item, getNsfwRecord(item)));
}

async function scanLibraryForNsfw(opts = {}){
  if(!state.nsfwFeatureUnlocked){ toast('Redeem a code to unlock NSFW detection first.'); return; }
  if(nsfwScanState.running){ toast('A scan is already running.'); return; }

  const targets = nsfwScanTargets(!!opts.force);
  if(!targets.length){
    toast('Nothing new to scan — everything is already up to date.');
    return;
  }

  try{
    await loadNsfwModel();
  }catch(e){
    toast('Could not load the NSFW model — check your connection and try again.');
    return;
  }

  nsfwScanState = { running: true, processed: 0, total: targets.length, cancel: false };
  updateNsfwScanUI();
  if(!opts.quiet) toast(`Scanning ${targets.length} photo${targets.length === 1 ? '' : 's'} for NSFW content…`);
  showNsfwProgress('Scanning for NSFW content…', 0, targets.length);

  let flaggedCount = 0;
  for(const { item, kind } of targets){
    if(nsfwScanState.cancel) break;
    try{
      const record = kind === 'image' ? await scanImageItemForNsfw(item) : await scanVideoThumbForNsfw(item);
      if(record && record.flagged) flaggedCount++;
    }catch(e){ /* skip whatever file wouldn't decode */ }
    nsfwScanState.processed++;
    showNsfwProgress('Scanning for NSFW content…', nsfwScanState.processed, nsfwScanState.total);
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
  const targets = nsfwScanTargets(false);
  if(!targets.length) return;
  await scanLibraryForNsfw({ quiet: true });
}

/* ---------- settings modal UI ---------- */

function updateNsfwScanUI(){
  const btn = document.getElementById('nsfwScanBtn');
  const status = document.getElementById('nsfwScanStatus');
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
   scan results — the active grid, and the focus-view gate if a flagged
   photo happens to be open right now. */
function refreshNsfwVisuals(){
  if(state.tab === 'videos' || state.tab === 'images') renderActiveGrid();
  const focusView = document.getElementById('imageFocus');
  if(focusView && !focusView.hidden && state.currentImage) applyFocusNsfwGate(state.currentImage);
}

/* ---------- focus-view gate (pixelate + click-to-unblur) ---------- */

function nsfwWarningIconSVG(){
  return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M9 3h6M10 3v5.2L5.5 16a2 2 0 0 0 1.7 3h9.6a2 2 0 0 0 1.7-3L14 8.2V3" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/><circle cx="12" cy="16.3" r="1" fill="currentColor"/></svg>';
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

/* Shows/hides the pixelated gate over #focusImg for the current photo.
   Resets to "hidden behind the gate" every time it's called (i.e. every time
   a photo is opened), so unblurring one photo never carries over to the
   next. */
function applyFocusNsfwGate(item){
  const wrap = document.getElementById('focusImgWrap');
  const img = document.getElementById('focusImg');
  const canvas = document.getElementById('focusNsfwCanvas');
  const gate = document.getElementById('focusNsfwGate');
  if(!wrap || !img || !canvas || !gate) return;

  const rehideBtn = document.getElementById('focusRehideBtn');
  wrap.classList.remove('nsfw-revealed');
  if(rehideBtn) rehideBtn.hidden = true;

  if(!shouldGateItem(item)){
    canvas.hidden = true;
    gate.hidden = true;
    wrap.classList.remove('nsfw-gated');
    return;
  }

  wrap.classList.add('nsfw-gated');
  gate.hidden = false;
  canvas.hidden = false;

  // Prefer the region scan (blurs just the flagged spots) when it's run for
  // this photo; otherwise fall back to blurring the whole frame.
  const regionRecord = (typeof getNsfwRegionRecord === 'function') ? getNsfwRegionRecord(item) : null;
  const hasFreshRegions = regionRecord && isRegionRecordFresh(item, regionRecord) && regionRecord.boxes.length;
  const draw = () => {
    if(hasFreshRegions) pixelateRegionsToCanvas(img, canvas, regionRecord.boxes);
    else pixelateImageToCanvas(img, canvas);
  };
  if(img.complete && img.naturalWidth) draw();
  else img.addEventListener('load', draw, { once: true });
}

function revealFocusNsfwGate(){
  const wrap = document.getElementById('focusImgWrap');
  const canvas = document.getElementById('focusNsfwCanvas');
  const gate = document.getElementById('focusNsfwGate');
  const rehideBtn = document.getElementById('focusRehideBtn');
  if(!wrap || !canvas || !gate) return;
  canvas.hidden = true;
  gate.hidden = true;
  wrap.classList.remove('nsfw-gated');
  wrap.classList.add('nsfw-revealed');
  if(rehideBtn) rehideBtn.hidden = false;
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
