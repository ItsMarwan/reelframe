/* ==========================================================================
   Subtitles — import a .vtt/.srt/.ass file (browse or drag & drop) or
   generate automatically. Whichever the person picks is saved per-video
   using the same per-path caption storage the auto-generator already uses
   (captionStorageKey / saveCaptionsForItem / loadCaptionsForItem from
   12-captions.js), so it's remembered next time that video is opened.
   ========================================================================== */

/* ---------- SRT -> VTT ---------- */
function srtTimeToVtt(t){ return t.trim().replace(',', '.'); }
function convertSrtToVtt(srtText){
  const body = srtText.replace(/\r/g, '').trim();
  const blocks = body.split(/\n\n+/);
  const cues = blocks.map(block => {
    const lines = block.split('\n').filter(l => l.trim() !== '');
    if(!lines.length) return null;
    let idx = 0;
    if(!lines[0].includes('-->')) idx = 1; // skip the numeric index line
    const timeLine = lines[idx];
    if(!timeLine || !timeLine.includes('-->')) return null;
    const time = timeLine.split('-->').map(s => srtTimeToVtt(s)).join(' --> ');
    const text = lines.slice(idx + 1).join('\n');
    return `${time}\n${text}`;
  }).filter(Boolean);
  return `WEBVTT\n\n${cues.join('\n\n')}`;
}

/* ---------- ASS/SSA -> VTT ---------- */
function assTimeToVtt(t){
  const m = t.trim().match(/(\d+):(\d{2}):(\d{2})\.(\d{2})/);
  if(!m) return '00:00:00.000';
  const h = String(m[1]).padStart(2, '0');
  return `${h}:${m[2]}:${m[3]}.${m[4]}0`;
}
function stripAssTags(text){
  return text.replace(/\{[^}]*\}/g, '').replace(/\\N/gi, '\n').trim();
}
function convertAssToVtt(assText){
  const lines = assText.replace(/\r/g, '').split('\n');
  const cues = [];
  let format = null;
  lines.forEach(line => {
    if(/^Format:\s*/i.test(line)){
      format = line.replace(/^Format:\s*/i, '').split(',').map(s => s.trim().toLowerCase());
    } else if(/^Dialogue:/i.test(line)){
      const rest = line.replace(/^Dialogue:\s*/i, '');
      const cols = format ? format.length : 10;
      const parts = rest.split(',');
      const head = parts.slice(0, cols - 1);
      const text = parts.slice(cols - 1).join(',');
      const startIdx = format ? format.indexOf('start') : 1;
      const endIdx = format ? format.indexOf('end') : 2;
      const start = head[startIdx >= 0 ? startIdx : 1];
      const end = head[endIdx >= 0 ? endIdx : 2];
      if(start && end) cues.push(`${assTimeToVtt(start)} --> ${assTimeToVtt(end)}\n${stripAssTags(text)}`);
    }
  });
  return `WEBVTT\n\n${cues.join('\n\n')}`;
}

function convertSubtitleFileToVtt(filename, text){
  const ext = extOf(filename);
  if(ext === 'vtt') return text;
  if(ext === 'srt') return convertSrtToVtt(text);
  if(ext === 'ass' || ext === 'ssa') return convertAssToVtt(text);
  return null;
}

/* ---------- Modal wiring ---------- */
function setSubtitleStatus(msg){
  const el = document.getElementById('subtitleStatus');
  if(el) el.textContent = msg || '';
}

async function importSubtitleFile(file){
  const item = state.currentVideo;
  if(!item){ setSubtitleStatus('Open a video first.'); return; }
  const ext = extOf(file.name);
  if(!['vtt', 'srt', 'ass', 'ssa'].includes(ext)){
    setSubtitleStatus('Unsupported file type — use .vtt, .srt, or .ass/.ssa.');
    return;
  }
  try{
    const text = await file.text();
    const vtt = convertSubtitleFileToVtt(file.name, text);
    if(!vtt){ setSubtitleStatus('Could not read that subtitle file.'); return; }
    await saveCaptionsForItem(item, vtt);
    state.transcripts.set(item.path, parseVttCues(vtt));
    refreshCaptionedPaths();
    attachCaptionTrack(vtt, file.name.replace(/\.(vtt|srt|ass|ssa)$/i, '') || 'Imported subtitles', { show: true });
    setSubtitleStatus(`Loaded "${file.name}" — saved for this video.`);
    toast('Subtitles loaded');
    closeSubtitlesModal();
  }catch(err){
    console.error('subtitle import failed', err);
    setSubtitleStatus('Something went wrong reading that file.');
  }
}

function openSubtitlesModal(){
  if(!state.currentVideo){ toast('Open a video first.'); return; }
  const backdrop = document.getElementById('subtitlesModalBackdrop');
  if(!backdrop) return;
  setSubtitleStatus('');
  backdrop.hidden = false;
}
function closeSubtitlesModal(){
  const backdrop = document.getElementById('subtitlesModalBackdrop');
  if(backdrop) backdrop.hidden = true;
}

function bindSubtitlesModal(){
  const backdrop = document.getElementById('subtitlesModalBackdrop');
  if(!backdrop) return;
  const closeBtn = document.getElementById('subtitlesModalClose');
  const dropZone = document.getElementById('subtitleDropZone');
  const fileInput = document.getElementById('subtitleFileInput');
  const browseBtn = document.getElementById('subtitleBrowseBtn');
  const generateBtn = document.getElementById('subtitleGenerateBtn');
  const openBtn = document.getElementById('subtitleOptionsBtn');

  if(openBtn) openBtn.addEventListener('click', openSubtitlesModal);
  if(closeBtn) closeBtn.addEventListener('click', closeSubtitlesModal);
  backdrop.addEventListener('click', (e) => { if(e.target === backdrop) closeSubtitlesModal(); });

  browseBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if(file) importSubtitleFile(file);
    e.target.value = '';
  });

  ['dragenter', 'dragover'].forEach(evt => dropZone.addEventListener(evt, (e) => {
    e.preventDefault(); e.stopPropagation();
    dropZone.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach(evt => dropZone.addEventListener(evt, (e) => {
    e.preventDefault(); e.stopPropagation();
    dropZone.classList.remove('dragover');
  }));
  dropZone.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if(file) importSubtitleFile(file);
  });

  generateBtn.addEventListener('click', () => {
    closeSubtitlesModal();
    generateCaptions();
  });
}

document.addEventListener('DOMContentLoaded', bindSubtitlesModal);
