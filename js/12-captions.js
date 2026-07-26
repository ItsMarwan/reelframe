/* ==========================================================================
   Caption generation — extracts speech from the video's own audio and
   transcribes it in-browser (no upload, no server), then saves the result
   alongside the video so it's there next time it's opened.
   ========================================================================== */
const CAPTION_CHUNK_SECONDS = 25;
let captionJob = null;
let captionWorker = null;
let captionJobSeq = 0;

function getCaptionWorker() {
  if (!captionWorker) {
    captionWorker = new Worker('js/caption-worker.js', { type: 'module' });
  }
  return captionWorker;
}

function prewarmCaptionModel(){
  try{ getCaptionWorker().postMessage({ type: 'warm' }); }catch(e){ /* non-fatal */ }
}

function captionStorageKey(path){ return `caption:${path}`; }

async function saveCaptionsForItem(item, vttText){
  try{ await idbSet(captionStorageKey(item.path), vttText); }catch(e){ /* non-fatal: captions just won't be remembered */ }
}
async function loadCaptionsForItem(item){
  try{ return await idbGet(captionStorageKey(item.path)); }catch(e){ return null; }
}

/* ==========================================================================
   Transcript search index — turns saved caption VTTs into searchable text
   so global search (⌘K) can match spoken content, not just filenames.
   ========================================================================== */

/* Parses a WEBVTT string into [{start, text}, ...] cues (start in seconds).
   Tolerant of an optional cue-identifier line before the timestamp line,
   and strips any inline <...> tags (e.g. <b>) from the cue text. */
function parseVttCues(vttText){
  if(!vttText) return [];
  const cues = [];
  const timeToSeconds = (str) => {
    const m = str.trim().match(/(\d+):(\d{2}):(\d{2})[.,](\d{3})|(\d{1,2}):(\d{2})[.,](\d{3})/);
    if(!m) return null;
    if(m[1] !== undefined) return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
    return (+m[5]) * 60 + (+m[6]) + (+m[7]) / 1000;
  };
  const blocks = vttText.replace(/\r/g, '').split(/\n\n+/);
  blocks.forEach(block => {
    const lines = block.split('\n').filter(l => l.trim() !== '');
    if(!lines.length) return;
    let idx = 0;
    if(!lines[0].includes('-->')) idx = 1; // skip a cue-identifier line (or the WEBVTT header) if present
    const timeLine = lines[idx];
    if(!timeLine || !timeLine.includes('-->')) return;
    const start = timeToSeconds(timeLine.split('-->')[0]);
    if(start == null) return;
    const text = lines.slice(idx + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if(text) cues.push({ start, text });
  });
  return cues;
}

/* Builds (or refreshes) the in-memory transcript index from every caption
   currently saved in IndexedDB. Runs once in the background at app start —
   not on every keystroke in search — so lookups during typing stay instant. */
async function buildTranscriptIndex(){
  try{
    const keys = await idbGetAllKeysWithPrefix('caption:');
    for(const key of keys){
      const path = key.slice('caption:'.length);
      if(state.transcripts.has(path)) continue;
      try{
        const vtt = await idbGet(key);
        if(vtt) state.transcripts.set(path, parseVttCues(vtt));
      }catch(e){ /* skip an unreadable caption — search just won't include it */ }
    }
  }catch(e){ /* non-fatal — transcript search simply won't be populated yet */ }
}

function showCaptionProgress(label, fraction){
  const el = document.getElementById('captionProgressToast');
  if(!el) return;
  el.hidden = false;
  const labelEl = document.getElementById('captionProgressLabel');
  const fillEl = document.getElementById('captionProgressFill');
  if(labelEl) labelEl.textContent = label;
  if(fillEl) fillEl.style.width = `${Math.max(0, Math.min(100, Math.round(fraction * 100)))}%`;
}
function hideCaptionProgress(){
  const el = document.getElementById('captionProgressToast');
  if(el) el.hidden = true;
}
function maybeShowCaptionProgressForCurrentVideo(){
  if(captionJob && !captionJob.done){
    showCaptionProgress(captionJob.label, captionJob.progress);
  }
}

async function decodeAudioForASR(file){
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if(!AudioCtx) throw new Error('Audio decoding is not supported in this browser.');
  const arrayBuffer = await file.arrayBuffer();
  const tempCtx = new AudioCtx();
  let decoded;
  try{ decoded = await tempCtx.decodeAudioData(arrayBuffer); }
  finally { tempCtx.close().catch(() => {}); }
  const targetRate = 16000;
  const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * targetRate)), targetRate);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start(0);
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

function buildVttFromChunks(chunks){
  const cues = chunks
    .filter(c => c.text && c.text.trim())
    .map(c => {
      const [start, rawEnd] = c.timestamp;
      const end = (rawEnd == null || rawEnd <= start) ? start + 2 : rawEnd;
      return `${formatTimeForVTT(start)} --> ${formatTimeForVTT(end)}\n${c.text.trim()}`;
    });
  return `WEBVTT\n\n${cues.join('\n\n')}`;
}

async function startCaptionGeneration(item){
  if(!item){ toast('Open a video first.'); return; }
  if(captionJob && !captionJob.done){
    toast(captionJob.path === item.path
      ? 'Already generating captions for this video…'
      : 'Still generating captions for another video — please wait for it to finish.');
    return;
  }

  const job = { path: item.path, name: item.name, progress: 0, label: 'Preparing…', done: false, id: ++captionJobSeq };
  captionJob = job;
  showCaptionProgress(job.label, 0);
  updateCaptionButtonUI();

  try{
    job.label = 'Reading audio…';
    showCaptionProgress(job.label, 0.02);
    const audioData = await decodeAudioForASR(item.file);

    const worker = getCaptionWorker();

    const chunks = await new Promise((resolve, reject) => {
      const handleMessage = (e) => {
        const msg = e.data || {};
        if(msg.jobId !== job.id) return;
        if(captionJob !== job){
          worker.removeEventListener('message', handleMessage);
          reject(new Error('superseded'));
          return;
        }
        if(msg.type === 'model-progress'){
          job.progress = Math.min(0.15, (msg.progress / 100) * 0.15);
          job.label = `Loading captioning model… ${Math.round(msg.progress)}%`;
          showCaptionProgress(job.label, job.progress);
        } else if(msg.type === 'chunk-progress'){
          job.progress = 0.16 + ((msg.index + 1) / msg.count) * 0.8;
          job.label = `Generating captions… ${Math.round(((msg.index + 1) / msg.count) * 100)}%`;
          showCaptionProgress(job.label, job.progress);
        } else if(msg.type === 'done'){
          worker.removeEventListener('message', handleMessage);
          resolve(msg.chunks);
        } else if(msg.type === 'error'){
          worker.removeEventListener('message', handleMessage);
          reject(new Error(msg.message || 'Transcription failed'));
        }
      };
      worker.addEventListener('message', handleMessage);
      const audioCopy = audioData.slice();
      worker.postMessage(
        { type: 'transcribe', jobId: job.id, audio: audioCopy, chunkSeconds: CAPTION_CHUNK_SECONDS },
        [audioCopy.buffer]
      );
    });

    const vttText = buildVttFromChunks(chunks);
    await saveCaptionsForItem(item, vttText);
    state.transcripts.set(item.path, parseVttCues(vttText)); // index immediately — no need to wait for the next buildTranscriptIndex() pass
    refreshCaptionedPaths();

    job.done = true;
    hideCaptionProgress();
    toast(`Captions ready for "${item.name}"`);

    if(state.currentVideo && state.currentVideo.path === item.path){
      attachCaptionTrack(vttText, 'Generated captions', { silent: true, show: true });
    }
  } catch(err){
    job.done = true;
    hideCaptionProgress();
    if(!err || err.message !== 'superseded'){
      console.error('Caption generation failed', err);
      toast('Could not generate captions for this video.');
    }
  } finally {
    if(captionJob === job) captionJob = null;
    updateCaptionButtonUI();
  }
}

function generateCaptions(){
  startCaptionGeneration(state.currentVideo);
}

/* ==========================================================================
   Caption track attach/toggle + the single unified captions button.
   One button covers three states: no captions yet (click generates them),
   captions available but off (click turns them on), and on (click turns
   them off). While a job is running for the open video the button shows a
   spinner and is disabled — the job itself flips captions on automatically
   the moment it finishes (see the `attachCaptionTrack(..., {show:true})`
   call in startCaptionGeneration above).
   ========================================================================== */
function getCaptionTrackEl(){
  const video = document.getElementById('videoPlayer');
  return video ? video.querySelector('track[data-caption-track]') : null;
}

function attachCaptionTrack(vttText, label, opts = {}){
  const video = document.getElementById('videoPlayer');
  if(!video || !vttText) return;

  const old = getCaptionTrackEl();
  if(old){
    if(old.dataset.blobUrl) URL.revokeObjectURL(old.dataset.blobUrl);
    old.remove();
  }

  const url = URL.createObjectURL(new Blob([vttText], { type: 'text/vtt' }));
  const track = document.createElement('track');
  track.kind = 'subtitles';
  track.label = label || 'Captions';
  track.srclang = 'en';
  track.src = url;
  track.dataset.captionTrack = 'true';
  track.dataset.blobUrl = url;
  video.appendChild(track);

  const show = !!opts.show;
  state.captionsEnabled = show;
  if(track.track) track.track.mode = show ? 'showing' : 'hidden';

  if(!opts.silent) toast(show ? 'Captions on' : 'Captions loaded');
  updateCaptionButtonUI();
}

function toggleCaptions(){
  const track = getCaptionTrackEl();
  if(!track || !track.track) return;
  state.captionsEnabled = !state.captionsEnabled;
  track.track.mode = state.captionsEnabled ? 'showing' : 'hidden';
  updateCaptionButtonUI();
}

async function loadCaptionFile(file){
  const item = state.currentVideo;
  if(!item || !file) return;
  try{
    const text = await file.text();
    await saveCaptionsForItem(item, text);
    state.transcripts.set(item.path, parseVttCues(text));
    refreshCaptionedPaths();
    attachCaptionTrack(text, file.name.replace(/\.vtt$/i, '') || 'Captions', { show: true });
  }catch(err){
    console.error('Failed to load caption file', err);
    toast('Could not read that caption file.');
  }
}

function refreshCaptionedPaths(){
  if(!state.captionedPaths) state.captionedPaths = new Set();
  if(state.currentVideo) state.captionedPaths.add(state.currentVideo.path);
}

function updateCaptionButtonUI(){
  const btn = document.getElementById('captionToggleBtn');
  if(!btn) return;
  const item = state.currentVideo;
  const generating = !!(captionJob && !captionJob.done && item && captionJob.path === item.path);
  const hasTrack = !!getCaptionTrackEl();

  btn.classList.toggle('generating', generating);
  btn.classList.toggle('is-on', !generating && hasTrack && state.captionsEnabled);
  btn.disabled = generating;

  if(generating) btn.title = 'Generating captions…';
  else if(hasTrack) btn.title = state.captionsEnabled ? 'Turn off captions' : 'Turn on captions';
  else btn.title = 'Generate captions';
}

async function handleCaptionButtonClick(){
  const item = state.currentVideo;
  if(!item) return;

  if(captionJob && !captionJob.done && captionJob.path === item.path){
    toast('Generating captions… hang tight.');
    return;
  }

  if(getCaptionTrackEl()){
    toggleCaptions();
    return;
  }

  // No track attached yet — before assuming there's nothing saved, check
  // storage directly (a saved-captions load can still be in flight from
  // openWatch, and we don't want a stray click to kick off a redundant
  // generation job while that's happening).
  const saved = await loadCaptionsForItem(item);
  if(saved && state.currentVideo === item){
    attachCaptionTrack(saved, 'Saved captions', { show: true });
    return;
  }

  generateCaptions();
}
