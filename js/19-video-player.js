/* ==========================================================================
   Custom video player
   ========================================================================== */
let nextUpPromptState = { timer: null, visible: false, startedAt: 0, dismissed: false, mode: 'preview' };
const PLAYER_DEBUG = true;
const AUTOPLAY_PREVIEW_SECS = 10;
const AUTOPLAY_PREVIEW_MIN_SECS = 1.5;
const AUTOPLAY_FINAL_SECS = 10;
const AUTOPLAY_TRANSITION_EPSILON_SECS = 0.18;

function previewWindowSecs(duration){
  if(!isFinite(duration) || duration <= 0) return AUTOPLAY_PREVIEW_SECS;
  return Math.min(AUTOPLAY_PREVIEW_SECS, Math.max(AUTOPLAY_PREVIEW_MIN_SECS, duration * 0.35));
}

function debugPlayer(message, extra = {}){
  if(!PLAYER_DEBUG) return;
  if(Object.keys(extra).length) console.debug(`[reelframe][player] ${message}`, extra);
  else console.debug(`[reelframe][player] ${message}`);
}

function clearNextUpPrompt(opts = {}){
  if(nextUpPromptState.timer){ clearTimeout(nextUpPromptState.timer); nextUpPromptState.timer = null; }
  const overlay = document.getElementById('nextUpOverlay');
  if(overlay){
    overlay.hidden = true;
    overlay.classList.remove('player-nextup-full');
  }
  nextUpPromptState.visible = false;
  nextUpPromptState.mode = 'preview';
  if(opts.dismissed) nextUpPromptState.dismissed = true;
  if(opts.reset) nextUpPromptState.dismissed = false;
  if(opts.reset && document.getElementById('videoPlayer')){
    document.getElementById('playerControls').classList.add('visible');
    document.getElementById('playerCenterOverlay').classList.add('visible');
  }
}

function maybeAdvanceToNextVideo(reason){
  const video = document.getElementById('videoPlayer');
  if(!video || !state.autoplayEnabled || !currentUpNext.length) return false;
  if(video.paused && !video.ended) return false;
  if(!video.ended && (!isFinite(video.duration) || (video.duration - video.currentTime) > AUTOPLAY_TRANSITION_EPSILON_SECS)) return false;
  clearNextUpPrompt();
  const pick = currentUpNext[Math.floor(Math.random() * currentUpNext.length)];
  debugPlayer('autoplay advancing', { reason, currentTime: video.currentTime, duration: video.duration, picked: pick.name });
  openWatch(pick);
  return true;
}

let treatVideoAsEnded = null;

function showNextUpPrompt(mode = 'preview'){
  const overlay = document.getElementById('nextUpOverlay');
  const cardsEl = document.getElementById('nextUpCards');
  const countdownEl = document.getElementById('nextUpCountdown');
  const video = document.getElementById('videoPlayer');
  if(!overlay || !cardsEl || !countdownEl || !video || !currentUpNext.length) return;
  if(!state.autoplayEnabled || nextUpPromptState.dismissed) return;
  if(!isFinite(video.duration)) return;

  const remaining = video.duration - video.currentTime;
  if(mode !== 'final' && remaining <= AUTOPLAY_TRANSITION_EPSILON_SECS){
    treatVideoAsEnded && treatVideoAsEnded('prompt-threshold');
    return;
  }

  const picks = currentUpNext.slice(0, 2);
  cardsEl.innerHTML = '';
  picks.forEach((item) => {
    const card = document.createElement('button');
    card.className = 'player-nextup-card';
    card.type = 'button';
    card.innerHTML = `
      <div class="player-nextup-thumb" data-thumb-for="${escapeAttr(item.path)}">${watchedProgressHTML(item)}
        ${item.thumb
          ? `<img src="${item.thumb}" alt="${escapeAttr(item.name)}">`
          : `<div class="thumb-fallback" style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-faint)"><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M3 6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z" stroke="currentColor" stroke-width="1.5"/><path d="m21 8 -4 3 4 3V8Z" fill="currentColor"/></svg></div>`}
      </div>
      <div class="player-nextup-card-title">${escapeHtml(item.name)}</div>
    `;
    card.addEventListener('click', () => {
      clearNextUpPrompt({ reset: true });
      openWatch(item);
    });
    cardsEl.appendChild(card);
    ensureVideoMeta(item).then(() => {
      const box = cardsEl.querySelector(`[data-thumb-for="${escapeAttr(item.path)}"]`);
      if(!box || !item.thumb) return;
      box.innerHTML = `<img src="${item.thumb}" alt="${escapeAttr(item.name)}">`;
    });
  });

  overlay.hidden = false;
  nextUpPromptState.visible = true;
  nextUpPromptState.mode = mode;
  nextUpPromptState.startedAt = Date.now();

  if(mode === 'final'){
    overlay.classList.add('player-nextup-full');
    countdownEl.textContent = `Autoplay in ${AUTOPLAY_FINAL_SECS}s`;
    const tick = () => {
      if(!nextUpPromptState.visible || nextUpPromptState.mode !== 'final') return;
      if(video.paused && !video.ended){
        nextUpPromptState.timer = setTimeout(tick, 250);
        return;
      }
      const elapsed = (Date.now() - nextUpPromptState.startedAt) / 1000;
      const remainingTime = Math.max(0, AUTOPLAY_FINAL_SECS - elapsed);
      countdownEl.textContent = `Autoplay in ${Math.ceil(remainingTime)}s`;
      if(remainingTime <= 0){
        clearNextUpPrompt();
        maybeAdvanceToNextVideo('final-countdown');
        return;
      }
      nextUpPromptState.timer = setTimeout(tick, 100);
    };
    clearTimeout(nextUpPromptState.timer);
    tick();
    return;
  }

  overlay.classList.remove('player-nextup-full');
  countdownEl.textContent = `Autoplay in ${Math.ceil(remaining)}s`;
  const tick = () => {
    if(!nextUpPromptState.visible || nextUpPromptState.mode !== 'preview') return;
    if(video.paused){
      nextUpPromptState.timer = setTimeout(tick, 250);
      return;
    }
    const remainingTime = Math.max(0, video.duration - video.currentTime);
    countdownEl.textContent = `Autoplay in ${Math.ceil(remainingTime)}s`;
    if(remainingTime <= AUTOPLAY_TRANSITION_EPSILON_SECS){
      clearNextUpPrompt();
      treatVideoAsEnded && treatVideoAsEnded('preview-countdown');
      return;
    }
    nextUpPromptState.timer = setTimeout(tick, 250);
  };
  clearTimeout(nextUpPromptState.timer);
  tick();
  debugPlayer('preview autoplay prompt shown', { remaining });
}

function maybeShowNextUpPrompt(reason = 'timeupdate'){
  const video = document.getElementById('videoPlayer');
  if(!video) return;
  if(!video.duration || video.paused || video.ended) return;

  if(!state.autoplayEnabled || !currentUpNext.length){
    if(nextUpPromptState.visible) clearNextUpPrompt();
    return;
  }

  const remaining = video.duration - video.currentTime;
  const windowSecs = previewWindowSecs(video.duration);

  if(remaining <= AUTOPLAY_TRANSITION_EPSILON_SECS){
    treatVideoAsEnded && treatVideoAsEnded(reason);
    return;
  }

  if(remaining <= windowSecs){
    if(nextUpPromptState.dismissed) return;
    if(!nextUpPromptState.visible || nextUpPromptState.mode !== 'preview') showNextUpPrompt('preview');
    else updateNextUpCountdown(remaining);
  } else if(nextUpPromptState.visible){
    clearNextUpPrompt();
  }
}

function updateNextUpCountdown(remaining){
  const countdownEl = document.getElementById('nextUpCountdown');
  if(!countdownEl || nextUpPromptState.mode !== 'preview') return;
  countdownEl.textContent = `Autoplay in ${Math.ceil(remaining)}s`;
}

/* Snapshot functionality - IndexedDB storage and capture */
function initIDBSnapshots(){
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, IDB_VERSION);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if(!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      if(!db.objectStoreNames.contains(SNAPSHOTS_STORE)){
        db.createObjectStore(SNAPSHOTS_STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function buildSnapshotItem(snapshot){
  const item = {
    id: snapshot.id,
    name: snapshot.name || `Snapshot ${new Date(snapshot.savedAt || Date.now()).toLocaleString()}`,
    path: `snapshot:${snapshot.id}`,
    folderPath: [],
    category: 'Snapshots',
    type: 'image',
    handle: null,
    file: null,
    blob: snapshot.blob || null,
    url: snapshot.url || null,
    size: snapshot.blob?.size || 0,
    lastModified: snapshot.timestamp ? Date.parse(snapshot.savedAt || new Date().toISOString()) : Date.now(),
    ext: 'png',
    _rand: Math.random(),
    duration: null,
    thumb: null,
    source: 'snapshot',
    videoName: snapshot.videoName || 'snapshot',
    videoPath: snapshot.videoPath || null,
    timestamp: snapshot.timestamp || 0,
    savedAt: snapshot.savedAt || new Date().toISOString(),
  };
  if(item.blob && !item.url) item.url = URL.createObjectURL(item.blob);
  return item;
}

function loadSnapshots(){
  return new Promise((resolve, reject) => {
    initIDBSnapshots().then(db => {
      const transaction = db.transaction([SNAPSHOTS_STORE], 'readonly');
      const store = transaction.objectStore(SNAPSHOTS_STORE);
      const request = store.getAll();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        state.snapshots = (request.result || []).map(buildSnapshotItem).reverse();
        resolve(state.snapshots);
      };
    }).catch(reject);
  });
}

function saveSnapshot(blob, videoName, timestamp, videoPath){
  return new Promise((resolve, reject) => {
    initIDBSnapshots().then(db => {
      const transaction = db.transaction([SNAPSHOTS_STORE], 'readwrite');
      const store = transaction.objectStore(SNAPSHOTS_STORE);
      const snapshot = { blob, videoName, timestamp, videoPath: videoPath || null, savedAt: new Date().toISOString() };
      const request = store.add(snapshot);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const snapshotItem = buildSnapshotItem({ id: request.result, ...snapshot });
        state.snapshots = state.snapshots || [];
        state.snapshots.unshift(snapshotItem);
        resolve(snapshotItem);
      };
    }).catch(reject);
  });
}

async function bulkDownloadSnapshots(){
  if(!window.JSZip){ toast('Download library not ready. Please refresh and try again.'); return; }
  if(state.snapshots.length === 0){ toast('No snapshots to download'); return; }

  const bulkBtn = document.getElementById('bulkDownloadSnapshotsBtn');
  const originalText = bulkBtn.textContent;
  bulkBtn.disabled = true;
  bulkBtn.textContent = '⏳ Preparing...';

  try{
    const zip = new JSZip();
    let count = 0;
    for(const snapshot of state.snapshots){
      try{
        const blob = snapshot.blob;
        if(!blob) continue;
        const timestamp = snapshot.savedAt ? new Date(snapshot.savedAt).toISOString().replace(/[:.]/g, '-').split('T')[0] : `snapshot-${count}`;
        const filename = `snapshot-${timestamp}-${count++}.png`;
        zip.file(filename, blob);
      } catch(e){ console.error('Failed to add snapshot to zip:', e); }
    }
    if(count === 0){
      toast('No snapshots could be downloaded');
      bulkBtn.disabled = false; bulkBtn.textContent = originalText;
      return;
    }
    bulkBtn.textContent = '⏳ Zipping...';
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement('a');
    a.href = url; a.download = `reelframe-snapshots-${new Date().toISOString().split('T')[0]}.zip`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast(`Downloaded ${count} snapshots as ZIP`);
  } catch(err){
    console.error('Bulk download error:', err);
    toast('Failed to download snapshots');
  } finally{
    bulkBtn.disabled = false;
    bulkBtn.textContent = originalText;
  }
}

function toggleSnapshotSelectMode(){
  if(state.cat.images !== '__snapshots__') return;
  state.snapshotSelectMode = !state.snapshotSelectMode;
  state.selectedSnapshots.clear();
  const toggleBtn = document.getElementById('toggleSnapshotSelectBtn');
  const downloadBtn = document.getElementById('downloadSelectedSnapshotsBtn');
  if(state.snapshotSelectMode){
    toggleBtn.textContent = '✓ Done Selecting';
    downloadBtn.style.display = 'block';
    document.querySelectorAll('.pin-item').forEach(el => {
      if(el.querySelector('.pin-checkbox')) el.classList.add('show-checkboxes');
    });
  } else {
    toggleBtn.textContent = '☑ Select';
    downloadBtn.style.display = 'none';
    document.querySelectorAll('.pin-item.show-checkboxes').forEach(el => {
      el.classList.remove('show-checkboxes');
      el.querySelector('.pin-checkbox')?.classList.remove('checked');
    });
  }
  updateDownloadSelectedBtn();
}

function updateDownloadSelectedBtn(){
  const downloadBtn = document.getElementById('downloadSelectedSnapshotsBtn');
  if(!downloadBtn) return;
  const selected = state.selectedSnapshots.size;
  if(selected === 0){
    downloadBtn.disabled = true; downloadBtn.textContent = '⬇ Download Selected'; downloadBtn.style.opacity = '0.5';
  } else {
    downloadBtn.disabled = false; downloadBtn.textContent = `⬇ Download (${selected})`; downloadBtn.style.opacity = '1';
  }
}

async function downloadSelectedSnapshots(){
  if(!window.JSZip){ toast('Download library not ready. Please refresh and try again.'); return; }
  if(state.selectedSnapshots.size === 0){ toast('No snapshots selected'); return; }

  const downloadBtn = document.getElementById('downloadSelectedSnapshotsBtn');
  const originalText = downloadBtn.textContent;
  downloadBtn.disabled = true;
  downloadBtn.textContent = '⏳ Preparing...';

  try{
    const zip = new JSZip();
    let count = 0;
    for(const snapshot of state.snapshots){
      if(!state.selectedSnapshots.has(snapshot.path)) continue;
      try{
        const blob = snapshot.blob;
        if(!blob) continue;
        const timestamp = snapshot.savedAt ? new Date(snapshot.savedAt).toISOString().replace(/[:.]/g, '-').split('T')[0] : `snapshot-${count}`;
        const filename = `snapshot-${timestamp}-${count++}.png`;
        zip.file(filename, blob);
      } catch(e){ console.error('Failed to add snapshot to zip:', e); }
    }
    if(count === 0){
      toast('No snapshots could be downloaded');
      downloadBtn.disabled = false; downloadBtn.textContent = originalText;
      return;
    }
    downloadBtn.textContent = '⏳ Zipping...';
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement('a');
    a.href = url; a.download = `reelframe-snapshots-${new Date().toISOString().split('T')[0]}.zip`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast(`Downloaded ${count} snapshots as ZIP`);
    state.snapshotSelectMode = false;
    state.selectedSnapshots.clear();
    toggleSnapshotSelectMode();
  } catch(err){
    console.error('Bulk download error:', err);
    toast('Failed to download snapshots');
  } finally{
    downloadBtn.disabled = false;
    downloadBtn.textContent = originalText;
  }
}

function captureSnapshot(){
  const video = document.getElementById('videoPlayer');
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0);
  canvas.toBlob((blob) => {
    const sourceItem = state.currentVideo;
    const videoName = (sourceItem && sourceItem.name) || 'snapshot';
    const videoPath = sourceItem ? sourceItem.path : null;
    const timestamp = video.currentTime;
    saveSnapshot(blob, videoName, timestamp, videoPath).then(() => {
      toast('Snapshot added to your gallery');
      updateTotalCount();
      renderSidebar();
      if(state.tab === 'images') renderActiveGrid();
    }).catch(err => console.error('Failed to save snapshot:', err));
  }, 'image/png');
}

function initCustomPlayer(){
  const wrap = document.getElementById('playerWrap');
  const video = document.getElementById('videoPlayer');
  const clickCatcher = document.getElementById('playerClickCatcher');

  const centerOverlay = document.getElementById('playerCenterOverlay');
  const centerPauseBtn = document.getElementById('centerPauseBtn');
  const centerPlayIcon = document.getElementById('centerPlayIcon');
  const centerPauseIcon = document.getElementById('centerPauseIcon');
  const centerNextBtn = document.getElementById('centerNextBtn');

  const controls = document.getElementById('playerControls');
  const progress = document.getElementById('playerProgress');
  const playedEl = document.getElementById('playerPlayed');
  const bufferedEl = document.getElementById('playerBuffered');
  const thumbEl = document.getElementById('playerThumb');

  const playPauseBtn = document.getElementById('playPauseBtn');
  const playIcon = document.getElementById('playIcon');
  const pauseIcon = document.getElementById('pauseIcon');
  const timeEl = document.getElementById('playerTime');
  const skipBackBtn = document.getElementById('skipBackBtn');
  const skipFwdBtn = document.getElementById('skipFwdBtn');
  const speedBtn = document.getElementById('speedBtn');
  const autoplayBtn = document.getElementById('autoplayBtn');
  const muteBtn = document.getElementById('muteBtn');
  const volumeIcon = document.getElementById('volumeIcon');
  const muteIcon = document.getElementById('muteIcon');
  const volumeSlider = document.getElementById('volumeSlider');
  const snapshotBtn = document.getElementById('snapshotBtn');
  const fullscreenBtn = document.getElementById('fullscreenBtn');
  const savedAudio = loadPlayerAudioSettings();
  video.volume = savedAudio.volume;
  video.muted = savedAudio.muted || savedAudio.volume === 0;
  volumeSlider.value = video.muted ? 0 : video.volume;

  const flashLeft = document.getElementById('skipFlashLeft');
  const flashRight = document.getElementById('skipFlashRight');

  const sideCollapseBtn = document.getElementById('sideCollapseBtn');
  if(sideCollapseBtn){
    sideCollapseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.sideCollapsed = !state.sideCollapsed;
      saveSidebarCollapsed();
      applySidebarCollapsed();
    });
  }
  applySidebarCollapsed();

  function preventFocusSteal(el){
    if(!el) return;
    el.addEventListener('mousedown', (e) => e.preventDefault());
  }
  [
    centerPauseBtn, centerNextBtn, playPauseBtn, skipBackBtn, skipFwdBtn,
    speedBtn, autoplayBtn, muteBtn, snapshotBtn, fullscreenBtn,
    sideCollapseBtn
  ].forEach(preventFocusSteal);

  let hideTimer = null;
  let clickTimer = null;
  let seeking = false;

  function showControls(persist){
    controls.classList.add('visible');
    centerOverlay.classList.add('visible');
    clearTimeout(hideTimer);
    if(!video.paused && !persist){
      hideTimer = setTimeout(hideControls, 2800);
    }
  }
  function hideControls(){
    if(video.paused) return;
    controls.classList.remove('visible');
    centerOverlay.classList.remove('visible');
  }
  function toggleControls(){
    if(controls.classList.contains('visible') && !video.paused) hideControls();
    else showControls();
  }

  function setPlayPauseIcons(){
    const playing = !video.paused && !video.ended;
    playIcon.classList.toggle('icon-hide', playing);
    pauseIcon.classList.toggle('icon-hide', !playing);
    centerPlayIcon.classList.toggle('icon-hide', playing);
    centerPauseIcon.classList.toggle('icon-hide', !playing);
    debugPlayer('play-pause icons updated', { playing, paused: video.paused, ended: video.ended, readyState: video.readyState });
  }
  function togglePlay(){
    if('mediaSession' in navigator){
      navigator.mediaSession.setActionHandler('play', () => togglePlay());
      navigator.mediaSession.setActionHandler('pause', () => togglePlay());
    }
    if(video.paused){
      const playPromise = video.play();
      if(playPromise && typeof playPromise.then === 'function'){
        playPromise.then(() => setPlayPauseIcons()).catch(() => setPlayPauseIcons());
      } else {
        setPlayPauseIcons();
      }
    } else {
      video.pause();
      setPlayPauseIcons();
    }
  }

  /* Fullscreen — feature-detects requestFullscreen (unavailable on iOS
     Safari), falling back to the video element's native fullscreen there. */
  function toggleFullscreen(){
    if(document.fullscreenElement || document.webkitFullscreenElement){
      if(document.exitFullscreen) document.exitFullscreen();
      else if(document.webkitExitFullscreen) document.webkitExitFullscreen();
    } else if(wrap.requestFullscreen){
      wrap.requestFullscreen().catch(()=>{});
    } else if(wrap.webkitRequestFullscreen){
      wrap.webkitRequestFullscreen();
    } else if(video.webkitEnterFullscreen){
      video.webkitEnterFullscreen();
    }
  }

  function flashSkip(el){
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 550);
  }
  function skip(sec, side){
    if(isFinite(video.duration)){
      video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + sec));
    } else {
      video.currentTime = Math.max(0, video.currentTime + sec);
    }
    flashSkip(side === 'left' ? flashLeft : flashRight);
    showControls();
  }

  // Single click toggles controls. Double-click toggles fullscreen.
  clickCatcher.addEventListener('click', () => {
    if(clickTimer){
      clearTimeout(clickTimer); clickTimer = null;
      // second click within the window — 'dblclick' below handles it
    } else {
      clickTimer = setTimeout(() => { clickTimer = null; toggleControls(); }, 260);
    }
  });
  clickCatcher.addEventListener('dblclick', (e) => {
    e.preventDefault();
    if(clickTimer){ clearTimeout(clickTimer); clickTimer = null; }
    toggleFullscreen();
  });

  centerPauseBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePlay(); showControls(); });
  playPauseBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePlay(); showControls(); });
  centerNextBtn.addEventListener('click', (e) => { e.stopPropagation(); playNextUpNext(); });
  skipBackBtn.addEventListener('click', (e) => { e.stopPropagation(); skip(-10, 'left'); });
  skipFwdBtn.addEventListener('click', (e) => { e.stopPropagation(); skip(10, 'right'); });

  autoplayBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    state.autoplayEnabled = !state.autoplayEnabled;
    saveAutoplaySetting();
    autoplayBtn.classList.toggle('active', state.autoplayEnabled);
    if(!state.autoplayEnabled) clearNextUpPrompt({ dismissed: false, reset: true });
    else nextUpPromptState.dismissed = false;
    showControls();
  });
  autoplayBtn.classList.toggle('active', state.autoplayEnabled);

  document.getElementById('nextUpClose').addEventListener('click', (e) => {
    e.stopPropagation();
    clearNextUpPrompt({ dismissed: true });
  });

  video.addEventListener('play', () => {
    const inWatchView = !document.getElementById('videoWatch').hidden;
    if(!inWatchView && !miniPlayerActive){
      video.pause();
      return;
    }
    setPlayPauseIcons();
    if(nextUpPromptState.visible && nextUpPromptState.mode === 'preview') showNextUpPrompt('preview');
    showControls();
  });
  video.addEventListener('pause', () => {
    setPlayPauseIcons();
    if(nextUpPromptState.timer){ clearTimeout(nextUpPromptState.timer); nextUpPromptState.timer = null; }
    showControls(true);
  });
  treatVideoAsEnded = (reason) => {
    if(nextUpPromptState.visible && nextUpPromptState.mode === 'final') return;
    debugPlayer('treating as ended', { reason });
    clearNextUpPrompt({ reset: true });
    setPlayPauseIcons();
    showNextUpPrompt('final');
    showControls(true);
  };

  video.addEventListener('ended', () => {
    if(state.currentVideo){ setWatchProgress(state.currentVideo, video.duration || 0, video.duration || 0); }
    treatVideoAsEnded('ended-event');
  });
  video.addEventListener('loadedmetadata', () => {
    setPlayPauseIcons();
    updateTime();
    const saved = getWatchProgress(state.currentVideo);
    if(saved && saved.position && isFinite(video.duration) && video.duration > 0 && saved.position < video.duration - 2){
      video.currentTime = Math.min(saved.position, video.duration - 1);
    }
    if(typeof renderChapterTicks === 'function') renderChapterTicks(state.currentVideo);
  });
  video.addEventListener('timeupdate', () => {
    if(!seeking) updateProgress();
    updateTime();
    maybeShowNextUpPrompt('timeupdate');
    if(state.currentVideo){ setWatchProgress(state.currentVideo, video.currentTime, video.duration || 0); }
  });
  video.addEventListener('seeked', () => {
    updateProgress();
    updateTime();
    if(nextUpPromptState.visible && nextUpPromptState.mode === 'final' &&
       isFinite(video.duration) && (video.duration - video.currentTime) > AUTOPLAY_TRANSITION_EPSILON_SECS){
      clearNextUpPrompt({ reset: true });
    }
    maybeShowNextUpPrompt('seeked');
  });
  video.addEventListener('progress', updateBuffered);

  function updateProgress(){
    const pct = video.duration ? (video.currentTime / video.duration) * 100 : 0;
    playedEl.style.width = pct + '%';
    thumbEl.style.left = pct + '%';
  }
  function updateBuffered(){
    if(video.buffered.length){
      const end = video.buffered.end(video.buffered.length - 1);
      const pct = video.duration ? (end / video.duration) * 100 : 0;
      bufferedEl.style.width = pct + '%';
    }
  }
  function updateTime(){
    timeEl.textContent = `${formatDuration(video.currentTime)} / ${formatDuration(video.duration || 0)}`;
  }

  function seekFromEvent(e){
    const rect = progress.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const pct = rect.width ? x / rect.width : 0;
    if(isFinite(video.duration)) video.currentTime = pct * video.duration;
    playedEl.style.width = (pct * 100) + '%';
    thumbEl.style.left = (pct * 100) + '%';
  }
  progress.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    seeking = true;
    progress.classList.add('dragging');
    seekFromEvent(e);
    progress.setPointerCapture(e.pointerId);
    showControls(true);
  });
  progress.addEventListener('pointermove', (e) => { if(seeking) seekFromEvent(e); });
  function endSeek(){ if(seeking){ seeking = false; progress.classList.remove('dragging'); showControls(); } }
  progress.addEventListener('pointerup', endSeek);
  progress.addEventListener('pointercancel', endSeek);

  /* ---------- Scrub preview: mini thumbnail while hovering/dragging the timeline ---------- */
  const scrubPreview = document.getElementById('playerScrubPreview');
  const scrubCanvas = document.getElementById('playerScrubCanvas');
  const scrubTimeEl = document.getElementById('playerScrubTime');
  const scrubCtx = scrubCanvas ? scrubCanvas.getContext('2d') : null;
  let scrubVideo = null;
  let scrubSeekTimer = null;

  function ensureScrubVideo(){
    if(scrubVideo) return scrubVideo;
    scrubVideo = document.createElement('video');
    scrubVideo.muted = true;
    scrubVideo.playsInline = true;
    scrubVideo.preload = 'auto';
    scrubVideo.style.display = 'none';
    document.body.appendChild(scrubVideo);
    scrubVideo.addEventListener('seeked', () => {
      if(!scrubCtx) return;
      try{ scrubCtx.drawImage(scrubVideo, 0, 0, scrubCanvas.width, scrubCanvas.height); }
      catch(e){ /* frame not ready — leave last drawn frame in place */ }
    });
    return scrubVideo;
  }

  function updateScrubPreview(clientX){
    if(!scrubPreview) return;
    const item = state.currentVideo;
    if(!item || item.pairRemote) { scrubPreview.hidden = true; return; } // no independent seek source for a paired item mid-stream
    const rect = progress.getBoundingClientRect();
    const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
    const pct = rect.width ? x / rect.width : 0;
    const duration = isFinite(video.duration) && video.duration > 0 ? video.duration : (item.duration || 0);
    if(!duration) return;
    const time = pct * duration;

    if(scrubTimeEl) scrubTimeEl.textContent = formatDuration(time);

    const boxWidth = scrubPreview.offsetWidth || 160;
    let left = x - boxWidth / 2;
    left = Math.max(4, Math.min(left, rect.width - boxWidth - 4));
    scrubPreview.style.left = `${left}px`;

    const src = ensureItemUrl(item);
    if(!src) return;
    const sv = ensureScrubVideo();
    if(sv.src !== src) sv.src = src;

    clearTimeout(scrubSeekTimer);
    scrubSeekTimer = setTimeout(() => {
      try{ sv.currentTime = time; }catch(e){ /* ignore — will retry on next move */ }
    }, 60);
  }

  if(scrubPreview){
    progress.addEventListener('pointerenter', () => {
      if(state.currentVideo && state.currentVideo.type === 'video' && !state.currentVideo.pairRemote){
        scrubPreview.hidden = false;
      }
    });
    progress.addEventListener('pointerleave', () => { scrubPreview.hidden = true; });
    progress.addEventListener('pointermove', (e) => {
      if(scrubPreview.hidden && state.currentVideo && !state.currentVideo.pairRemote) scrubPreview.hidden = false;
      updateScrubPreview(e.clientX);
    });
  }

  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
  speedBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const idx = (SPEEDS.indexOf(video.playbackRate) + 1) % SPEEDS.length;
    video.playbackRate = SPEEDS[idx];
    speedBtn.textContent = SPEEDS[idx] + 'x';
    showControls();
  });

  function setVolumeIcons(){
    const muted = video.muted || video.volume === 0;
    volumeIcon.classList.toggle('icon-hide', muted);
    muteIcon.classList.toggle('icon-hide', !muted);
  }
  muteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    video.muted = !video.muted;
    if(!video.muted && video.volume === 0) video.volume = 1;
    volumeSlider.value = video.muted ? 0 : video.volume;
    setVolumeIcons();
    savePlayerAudioSettings(video);
    showControls();
  });
  volumeSlider.addEventListener('input', () => {
    video.volume = parseFloat(volumeSlider.value);
    video.muted = video.volume === 0;
    setVolumeIcons();
    savePlayerAudioSettings(video);
  });
  volumeSlider.addEventListener('click', (e) => e.stopPropagation());
  volumeSlider.addEventListener('pointerdown', (e) => e.stopPropagation());

  if(snapshotBtn){
    snapshotBtn.addEventListener('click', (e) => { e.stopPropagation(); captureSnapshot(); });
  }

  fullscreenBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleFullscreen(); });

  wrap.addEventListener('mousemove', () => { if(!video.paused) showControls(); });

  document.addEventListener('keydown', (e) => {
    if(document.getElementById('videoWatch').hidden) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if(tag === 'INPUT' || tag === 'TEXTAREA') return;
    if(e.key === ' '){ e.preventDefault(); togglePlay(); showControls(); }
    else if(e.key === 'ArrowLeft') skip(-5, 'left');
    else if(e.key === 'ArrowRight') skip(5, 'right');
    else if(e.key === 'f' || e.key === 'F') toggleFullscreen();
    else if(e.key === 'm' || e.key === 'M') muteBtn.click();
  });

  setPlayPauseIcons();
  setVolumeIcons();
  showControls(true);
}
function bindPlayerMoreMenu(){
  const moreBtn = document.getElementById('playerMoreBtn');
  const moreWrap = document.getElementById('playerMoreWrap');
  if(!moreBtn || !moreWrap) return;

  moreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    moreWrap.classList.toggle('open');
  });

  document.addEventListener('click', (e) => {
    if(!moreWrap.classList.contains('open')) return;
    if(moreWrap.contains(e.target) || e.target === moreBtn) return;
    moreWrap.classList.remove('open');
  });

  // Close after picking autoplay/snapshot (one-shot actions).
  // Speed is left open since people often tap it a few times to cycle.
  ['autoplayBtn', 'snapshotBtn'].forEach(id => {
    const btn = document.getElementById(id);
    if(btn) btn.addEventListener('click', () => moreWrap.classList.remove('open'));
  });
}
document.addEventListener('DOMContentLoaded', bindPlayerMoreMenu);