/* ==========================================================================
   NSFW region ("spot") detection — second, optional pass on top of
   35-nsfw-scan.js. That file's classifier (nsfwjs) only knows whether a
   whole photo looks NSFW; this file runs an actual object detector
   (NudeNet's ONNX export, via onnxruntime-web) that returns bounding boxes,
   so a flagged photo can have just the offending spots pixelated instead of
   the entire frame.

   Runs entirely on-device via onnxruntime-web's WASM backend (SIMD +
   multi-threaded where the browser supports it). Not using the WebGPU
   provider here — that needs a different import (onnxruntime-web/webgpu)
   than the plain CDN bundle this file loads, and getting that wrong throws
   at session-create time rather than gracefully falling back, so wasm is
   the safer default. Same on-device-only spirit as the tfjs/nsfwjs model in
   35-nsfw-scan.js either way — nothing leaves the browser.

   NOTE for Marwan: I couldn't run 320n.onnx directly in this environment
   (network here can reach github.com's HTML pages but not the redirect
   target the release-asset binary actually lives on — see the README for
   how to get the file into the repo yourself), but I did track down and
   read vladmandic's sd-extension-nudenet reference implementation, which
   wraps this exact model, and matched this file's preprocessing/decode
   logic to it line-for-line: single [1, 22, numAnchors] output0 tensor (4
   box coords + 18 class scores, no separate objectness), RGB channel order,
   black letterbox padding, centered pad, box math via resize_factor. The
   one thing I could not verify without actually running it is that the
   live .onnx file you host still matches that reference's assumptions
   (input/output tensor names, shape) — worth a quick console check the
   first time you scan a real photo.
   ========================================================================== */

let nudenetSession = null;
let nudenetSessionLoading = null;

/* ---------- cache ---------- */

function nsfwRegionCacheKey(item){ return favKey(item); }

function getNsfwRegionRecord(item){
  return state.nsfwRegions[nsfwRegionCacheKey(item)] || null;
}

function isRegionRecordFresh(item, record){
  return !!record && record.size === item.size && record.lastModified === item.lastModified;
}

function isNsfwRegionFlagged(item){
  const record = getNsfwRegionRecord(item);
  return !!(record && isRegionRecordFresh(item, record) && record.boxes && record.boxes.length);
}

/* ---------- model ---------- */

function loadNudenetSession(){
  if(nudenetSession) return Promise.resolve(nudenetSession);
  if(nudenetSessionLoading) return nudenetSessionLoading;
  nudenetSessionLoading = (async () => {
    try{
      if(typeof ort === 'undefined'){
        throw new Error('Region-detection library did not load (check your connection).');
      }
      nudenetSession = await ort.InferenceSession.create(NUDENET_MODEL_URL, {
        // The CDN build we load (dist/ort.min.js) doesn't reliably support
        // the 'webgpu' provider — that needs the separate
        // onnxruntime-web/webgpu entry point, which we're not pulling in.
        // 'wasm' still gets SIMD + multi-threading where the browser
        // supports it, which is the safer bet here than a session-create
        // that might throw on 'webgpu' isn't actually wired up for.
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
      return nudenetSession;
    } finally {
      nudenetSessionLoading = null;
    }
  })();
  return nudenetSessionLoading;
}

/* ---------- pre/post-processing ---------- */

/* Letterboxes imgEl into a NUDENET_INPUT_SIZE square (grey padding, centered)
   and returns both the raw NCHW Float32 tensor data the model wants and the
   scale/pad info needed to map boxes back to the original image. */
function letterboxToTensor(imgEl){
  const size = NUDENET_INPUT_SIZE;
  const w = imgEl.naturalWidth, h = imgEl.naturalHeight;
  const scale = Math.min(size / w, size / h);
  const newW = Math.round(w * scale), newH = Math.round(h * scale);
  const padLeft = Math.floor((size - newW) / 2);
  const padTop = Math.floor((size - newH) / 2);

  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgb(0,0,0)'; // matches the reference implementation's cv2.copyMakeBorder(..., value=[0,0,0])
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(imgEl, 0, 0, w, h, padLeft, padTop, newW, newH);

  const { data } = ctx.getImageData(0, 0, size, size);
  const floatData = new Float32Array(3 * size * size);
  const plane = size * size;
  // Verified against the reference NudeDetector.read_image(): it converts
  // BGR (cv2's default) to RGB before building the input blob, so the model
  // wants RGB channel order — canvas ImageData is already RGBA, so this is
  // just splitting it into planes, no channel swap needed.
  for(let i = 0; i < plane; i++){
    floatData[i] = data[i * 4] / 255;                 // R
    floatData[plane + i] = data[i * 4 + 1] / 255;      // G
    floatData[2 * plane + i] = data[i * 4 + 2] / 255;  // B
  }
  return {
    tensor: new ort.Tensor('float32', floatData, [1, 3, size, size]),
    scale, padLeft, padTop, origW: w, origH: h,
  };
}

function iou(a, b){
  const x1 = Math.max(a.x1, b.x1), y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2), y2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
  const areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
  return inter / (areaA + areaB - inter || 1);
}

function nonMaxSuppress(boxes){
  const sorted = boxes.slice().sort((a, b) => b.score - a.score);
  const kept = [];
  for(const box of sorted){
    if(kept.some(k => k.cls === box.cls && iou(k, box) > NSFW_REGION_NMS_IOU)) continue;
    kept.push(box);
  }
  return kept;
}

/* Decodes the model's raw output tensor into boxes in original-image pixel
   space, keeping only classes in NUDENET_BLUR_CLASSES above threshold. */
function decodeDetectorOutput(output, letterboxInfo){
  const numClasses = NUDENET_CLASS_NAMES.length;
  const rowLen = 4 + numClasses;
  const dims = output.dims; // e.g. [1, rowLen, numAnchors] or [1, numAnchors, rowLen]
  const dataArr = output.data;

  let numAnchors, transposed;
  if(dims.length === 3 && dims[1] === rowLen){
    numAnchors = dims[2]; transposed = false;       // [1, rowLen, numAnchors]
  } else if(dims.length === 3 && dims[2] === rowLen){
    numAnchors = dims[1]; transposed = true;        // [1, numAnchors, rowLen]
  } else {
    return []; // unexpected shape — bail out quietly rather than misreading it
  }

  const get = (row, anchor) => transposed ? dataArr[anchor * rowLen + row] : dataArr[row * numAnchors + anchor];

  const { scale, padLeft, padTop, origW, origH } = letterboxInfo;
  const raw = [];
  for(let a = 0; a < numAnchors; a++){
    let bestCls = -1, bestScore = 0;
    for(let c = 0; c < numClasses; c++){
      const s = get(4 + c, a);
      if(s > bestScore){ bestScore = s; bestCls = c; }
    }
    if(bestScore < NSFW_REGION_SCORE_THRESHOLD) continue;
    const clsName = NUDENET_CLASS_NAMES[bestCls];
    if(!NUDENET_BLUR_CLASSES.has(clsName)) continue;

    const cx = get(0, a), cy = get(1, a), bw = get(2, a), bh = get(3, a);
    const x1 = (cx - bw / 2 - padLeft) / scale;
    const y1 = (cy - bh / 2 - padTop) / scale;
    const x2 = (cx + bw / 2 - padLeft) / scale;
    const y2 = (cy + bh / 2 - padTop) / scale;
    raw.push({
      cls: clsName, score: bestScore,
      x1: Math.max(0, x1), y1: Math.max(0, y1),
      x2: Math.min(origW, x2), y2: Math.min(origH, y2),
    });
  }

  return nonMaxSuppress(raw).map(b => ({
    cls: b.cls,
    score: Math.round(b.score * 1000) / 1000,
    // stored as 0-1 fractions of the image so boxes stay valid at any display size
    x: b.x1 / origW, y: b.y1 / origH,
    w: (b.x2 - b.x1) / origW, h: (b.y2 - b.y1) / origH,
  }));
}

/* ---------- scanning a single item ---------- */

async function scanImageItemForRegions(item){
  const src = ensureItemUrl(item);
  if(!src) return null;
  let img;
  try{ img = await loadImageElement(src); } // reuses the loader from 35-nsfw-scan.js
  catch(e){ return null; }

  const letterboxInfo = letterboxToTensor(img);
  const results = await nudenetSession.run({ [nudenetSession.inputNames[0]]: letterboxInfo.tensor });
  const output = results[nudenetSession.outputNames[0]];
  const boxes = decodeDetectorOutput(output, letterboxInfo);

  const record = {
    boxes,
    size: item.size,
    lastModified: item.lastModified,
    scannedAt: Date.now(),
  };
  state.nsfwRegions[nsfwRegionCacheKey(item)] = record;
  return record;
}

/* ---------- resumable, pausable background queue ---------- */

let nsfwRegionScanState = { running: false, paused: false, processed: 0, total: 0, cancel: false };

function nsfwRegionQueueTargets(force){
  const images = state.rawImages.filter(i => !i.pairRemote);
  if(force) return images;
  return images.filter(i => !isRegionRecordFresh(i, getNsfwRegionRecord(i)));
}

async function runNsfwRegionQueue(keys, startIndex){
  nsfwRegionScanState = { running: true, paused: false, processed: startIndex, total: keys.length, cancel: false };
  updateNsfwRegionScanUI();
  if(startIndex === 0) toast(`Scanning ${keys.length} photo${keys.length === 1 ? '' : 's'} for NSFW regions…`);
  showNsfwProgress('Scanning for NSFW regions…', startIndex, keys.length);

  const byKey = new Map([...state.rawImages].map(i => [favKey(i), i]));
  let i = startIndex;
  for(; i < keys.length; i++){
    if(nsfwRegionScanState.cancel) break;
    if(nsfwRegionScanState.paused){
      saveNsfwRegionQueue(keys, i);
      break;
    }
    const item = byKey.get(keys[i]);
    if(item){
      try{ await scanImageItemForRegions(item); }
      catch(e){ /* skip whatever file wouldn't decode or infer */ }
    }
    nsfwRegionScanState.processed = i + 1;
    showNsfwProgress('Scanning for NSFW regions…', nsfwRegionScanState.processed, nsfwRegionScanState.total);
    if(i % 5 === 0 || i === keys.length - 1){
      saveNsfwRegions();
      saveNsfwRegionQueue(keys, i + 1);
      updateNsfwRegionScanUI();
      refreshNsfwVisuals();
    }
    // yield back to the main thread every item so the UI (and Pause button) stay responsive
    await new Promise(r => setTimeout(r, 0));
  }

  saveNsfwRegions();
  hideNsfwProgress();
  const wasPaused = nsfwRegionScanState.paused;
  const wasCancelled = nsfwRegionScanState.cancel;
  const processed = nsfwRegionScanState.processed;

  if(wasCancelled){
    clearNsfwRegionQueue();
  } else if(i >= keys.length){
    clearNsfwRegionQueue();
  }
  // if paused, the queue was already saved above with the resume index

  nsfwRegionScanState = { running: false, paused: false, processed: 0, total: 0, cancel: false };
  updateNsfwRegionScanUI();
  refreshNsfwVisuals();

  if(wasCancelled) toast(`Region scan stopped — ${processed} checked`);
  else if(wasPaused) toast(`Region scan paused — ${processed} of ${keys.length} checked so far`);
  else toast(`Region scan complete — ${processed} checked`);
}

async function startNsfwRegionScan(opts = {}){
  if(!state.nsfwFeatureUnlocked){ toast('Redeem a code to unlock NSFW detection first.'); return; }
  if(nsfwRegionScanState.running){ toast('A region scan is already running.'); return; }

  const targets = nsfwRegionQueueTargets(!!opts.force);
  if(!targets.length){ toast('Nothing new to scan — everything is already up to date.'); return; }

  try{ await loadNudenetSession(); }
  catch(e){ toast('Could not load the region-detection model — check your connection and try again.'); return; }

  const keys = targets.map(i => favKey(i));
  saveNsfwRegionQueue(keys, 0);
  runNsfwRegionQueue(keys, 0);
}

async function resumeNsfwRegionScan(){
  if(!state.nsfwFeatureUnlocked){ toast('Redeem a code to unlock NSFW detection first.'); return; }
  if(nsfwRegionScanState.running){ toast('A region scan is already running.'); return; }
  const saved = loadNsfwRegionQueue();
  if(!saved || saved.index >= saved.keys.length){ toast('No paused region scan to resume — starting a new one.'); startNsfwRegionScan(); return; }

  try{ await loadNudenetSession(); }
  catch(e){ toast('Could not load the region-detection model — check your connection and try again.'); return; }

  runNsfwRegionQueue(saved.keys, saved.index);
}

function pauseNsfwRegionScan(){
  if(nsfwRegionScanState.running) nsfwRegionScanState.paused = true;
}

function cancelNsfwRegionScan(){
  if(nsfwRegionScanState.running) nsfwRegionScanState.cancel = true;
}

/* Whether there's a paused-but-not-finished queue sitting in storage, so the
   settings modal can offer "Resume" instead of just "Scan" on open. */
function hasPausedNsfwRegionQueue(){
  const saved = loadNsfwRegionQueue();
  return !!(saved && saved.index < saved.keys.length && !nsfwRegionScanState.running);
}

/* ---------- settings modal UI ---------- */

function updateNsfwRegionScanUI(){
  const scanBtn = document.getElementById('nsfwRegionScanBtn');
  const pauseBtn = document.getElementById('nsfwRegionPauseBtn');
  const status = document.getElementById('nsfwRegionScanStatus');
  const paused = hasPausedNsfwRegionQueue();

  if(scanBtn){
    scanBtn.disabled = !state.nsfwFeatureUnlocked;
    scanBtn.textContent = nsfwRegionScanState.running ? 'Scanning…' : (paused ? 'Start new scan' : 'Scan for regions');
  }
  if(pauseBtn){
    pauseBtn.hidden = !nsfwRegionScanState.running && !paused;
    pauseBtn.disabled = !state.nsfwFeatureUnlocked;
    pauseBtn.textContent = nsfwRegionScanState.running ? 'Pause' : 'Resume';
  }
  if(status){
    if(!state.nsfwFeatureUnlocked){
      status.textContent = '';
    } else if(nsfwRegionScanState.running){
      status.textContent = `Scanning… ${nsfwRegionScanState.processed} of ${nsfwRegionScanState.total}`;
    } else if(paused){
      const saved = loadNsfwRegionQueue();
      status.textContent = `Paused — ${saved.index} of ${saved.keys.length} checked`;
    } else {
      const total = Object.keys(state.nsfwRegions).length;
      const flagged = Object.values(state.nsfwRegions).filter(r => r.boxes && r.boxes.length).length;
      status.textContent = total ? `${total} checked so far · ${flagged} with regions found` : 'Not scanned yet.';
    }
  }
}

function bindNsfwRegionScanButtons(){
  const scanBtn = document.getElementById('nsfwRegionScanBtn');
  const pauseBtn = document.getElementById('nsfwRegionPauseBtn');
  if(scanBtn){
    scanBtn.addEventListener('click', () => {
      if(!state.nsfwFeatureUnlocked){ toast('Redeem a code to unlock NSFW detection first.'); return; }
      startNsfwRegionScan();
    });
  }
  if(pauseBtn){
    pauseBtn.addEventListener('click', () => {
      if(nsfwRegionScanState.running) pauseNsfwRegionScan();
      else resumeNsfwRegionScan();
    });
  }
  updateNsfwRegionScanUI();
}

/* ---------- targeted region blur (focus view) ---------- */

/* Draws imgEl at full res onto canvasEl, then pixelates just the flagged
   boxes on top — same mosaic technique as the whole-image fallback, just
   confined to each box. */
function pixelateRegionsToCanvas(imgEl, canvasEl, boxes, pixelSize = 14){
  const w = imgEl.naturalWidth || canvasEl.clientWidth || 320;
  const h = imgEl.naturalHeight || canvasEl.clientHeight || 180;
  if(!w || !h) return;

  canvasEl.width = w; canvasEl.height = h;
  const ctx = canvasEl.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(imgEl, 0, 0, w, h);

  boxes.forEach(box => {
    const bx = Math.round(box.x * w), by = Math.round(box.y * h);
    const bw = Math.max(1, Math.round(box.w * w)), bh = Math.max(1, Math.round(box.h * h));
    const smallW = Math.max(1, Math.round(bw / pixelSize));
    const smallH = Math.max(1, Math.round(bh / pixelSize));

    const small = document.createElement('canvas');
    small.width = smallW; small.height = smallH;
    const sctx = small.getContext('2d');
    sctx.drawImage(imgEl, bx, by, bw, bh, 0, 0, smallW, smallH);

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(small, 0, 0, smallW, smallH, bx, by, bw, bh);
    ctx.imageSmoothingEnabled = true;
  });
}
