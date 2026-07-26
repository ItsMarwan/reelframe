/* ==========================================================================
   Persistent music player bar (Spotify-style) — lives outside the tab/view
   system so it keeps playing while you browse videos or photos.
   ========================================================================== */
function currentTrack(){ return state.musicQueue[state.musicQueueIndex] || null; }

function loadTrackIntoBar(item){
  document.getElementById('musicBarTitle').textContent = trackTitle(item);
  document.getElementById('musicBarArtist').textContent = trackArtist(item);
  document.getElementById('musicBarArt').innerHTML = coverArtHTML(item, 44);
  const favBtn = document.getElementById('musicBarFav');
  favBtn.setAttribute('data-fav-key', favKey(item));
  favBtn.classList.toggle('is-fav', isFav(item));
}

/* Start playing `item`; `queueList` (defaults to the currently filtered/sorted
   music list) becomes the play queue, positioned at `item`. */
function playTrack(item, queueList){
  const q = (queueList || getFiltered('music')).slice();
  state.musicQueue = q;
  state.musicQueueOriginal = null;
  state.musicShuffle = false;
  document.getElementById('musicShuffleBtn').classList.remove('active');
  const idx = q.findIndex(t => t.path === item.path);
  playTrackAt(idx === -1 ? 0 : idx);
}

function playTrackAt(idx){
  if(idx < 0 || idx >= state.musicQueue.length) return;
  state.musicQueueIndex = idx;
  const item = state.musicQueue[idx];
  recordHistory(item);
  const audio = document.getElementById('musicAudioEl');
  const video = document.getElementById('videoPlayer');
  if(video && !video.paused) video.pause();
  audio.src = ensureItemUrl(item);
  audio.play().catch(() => {});
  ensureAudioMeta(item).then(() => { if(currentTrack() === item) loadTrackIntoBar(item); });
  loadTrackIntoBar(item);
  document.getElementById('musicPlayerBar').hidden = false;
  document.getElementById('app').classList.add('has-music-bar');
  renderQueueList();
  highlightPlayingRow();
}

function initMusicPlayer(){
  const audio = document.getElementById('musicAudioEl');
  const bar = document.getElementById('musicPlayerBar');
  const playBtn = document.getElementById('musicPlayBtn');
  const playIcon = document.getElementById('musicPlayIcon');
  const pauseIcon = document.getElementById('musicPauseIcon');
  const prevBtn = document.getElementById('musicPrevBtn');
  const nextBtn = document.getElementById('musicNextBtn');
  const shuffleBtn = document.getElementById('musicShuffleBtn');
  const repeatBtn = document.getElementById('musicRepeatBtn');
  const repeatOneBadge = document.getElementById('musicRepeatOneBadge');
  const progress = document.getElementById('musicBarProgress');
  const progressFill = document.getElementById('musicBarProgressFill');
  const progressThumb = document.getElementById('musicBarProgressThumb');
  const curTimeEl = document.getElementById('musicBarCurTime');
  const durTimeEl = document.getElementById('musicBarDurTime');
  const volBtn = document.getElementById('musicVolBtn');
  const volIcon = document.getElementById('musicVolIcon');
  const muteIcon = document.getElementById('musicMuteIcon');
  const volSlider = document.getElementById('musicVolSlider');
  const favBtn = document.getElementById('musicBarFav');
  const queueBtn = document.getElementById('musicQueueBtn');
  const queueBackdrop = document.getElementById('musicQueueBackdrop');
  const queueClose = document.getElementById('musicQueueClose');

  function setPlayIcons(){
    const playing = !audio.paused && !audio.ended;
    playIcon.classList.toggle('icon-hide', playing);
    pauseIcon.classList.toggle('icon-hide', !playing);
  }
  function togglePlay(){ if(!currentTrack()) return; if(audio.paused) audio.play().catch(()=>{}); else audio.pause(); }

  function next(){
    if(!state.musicQueue.length) return;
    let idx = state.musicQueueIndex + 1;
    if(idx >= state.musicQueue.length){
      if(state.musicRepeat === 'all') idx = 0;
      else { audio.pause(); return; }
    }
    playTrackAt(idx);
  }
  function prev(){
    if(!state.musicQueue.length) return;
    if(audio.currentTime > 3){ audio.currentTime = 0; return; }
    let idx = state.musicQueueIndex - 1;
    if(idx < 0){
      if(state.musicRepeat === 'all') idx = state.musicQueue.length - 1;
      else { audio.currentTime = 0; return; }
    }
    playTrackAt(idx);
  }

  playBtn.addEventListener('click', togglePlay);
  nextBtn.addEventListener('click', next);
  prevBtn.addEventListener('click', prev);

  shuffleBtn.addEventListener('click', () => {
    state.musicShuffle = !state.musicShuffle;
    shuffleBtn.classList.toggle('active', state.musicShuffle);
    const cur = currentTrack();
    if(!cur) return;
    if(state.musicShuffle){
      state.musicQueueOriginal = state.musicQueue.slice();
      const rest = state.musicQueue.filter((t) => t !== cur);
      shuffleArray(rest);
      state.musicQueue = [cur, ...rest];
      state.musicQueueIndex = 0;
    } else if(state.musicQueueOriginal){
      state.musicQueue = state.musicQueueOriginal.slice();
      state.musicQueueOriginal = null;
      state.musicQueueIndex = state.musicQueue.findIndex(t => t === cur);
    }
    renderQueueList();
  });

  const REPEAT_MODES = ['off', 'all', 'one'];
  repeatBtn.addEventListener('click', () => {
    const idx = (REPEAT_MODES.indexOf(state.musicRepeat) + 1) % REPEAT_MODES.length;
    state.musicRepeat = REPEAT_MODES[idx];
    repeatBtn.classList.toggle('active', state.musicRepeat !== 'off');
    repeatOneBadge.classList.toggle('icon-hide', state.musicRepeat !== 'one');
  });

  audio.addEventListener('play', setPlayIcons);
  audio.addEventListener('pause', setPlayIcons);
  audio.addEventListener('ended', () => {
    if(state.musicRepeat === 'one'){ audio.currentTime = 0; audio.play().catch(()=>{}); return; }
    next();
  });
  audio.addEventListener('loadedmetadata', updateProgressUI);
  audio.addEventListener('timeupdate', updateProgressUI);

  function updateProgressUI(){
    const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
    progressFill.style.width = pct + '%';
    progressThumb.style.left = pct + '%';
    curTimeEl.textContent = formatDuration(audio.currentTime || 0);
    durTimeEl.textContent = formatDuration(audio.duration || 0);
  }

  let seeking = false;
  function seekFromEvent(e){
    const rect = progress.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const pct = rect.width ? x / rect.width : 0;
    if(isFinite(audio.duration)) audio.currentTime = pct * audio.duration;
    progressFill.style.width = (pct * 100) + '%';
    progressThumb.style.left = (pct * 100) + '%';
  }
  progress.addEventListener('pointerdown', (e) => {
    if(!currentTrack()) return;
    seeking = true;
    progress.classList.add('dragging');
    seekFromEvent(e);
    progress.setPointerCapture(e.pointerId);
  });
  progress.addEventListener('pointermove', (e) => { if(seeking) seekFromEvent(e); });
  function endSeek(){ if(seeking){ seeking = false; progress.classList.remove('dragging'); } }
  progress.addEventListener('pointerup', endSeek);
  progress.addEventListener('pointercancel', endSeek);

  function setVolumeIcons(){
    const muted = audio.muted || audio.volume === 0;
    volIcon.classList.toggle('icon-hide', muted);
    muteIcon.classList.toggle('icon-hide', !muted);
  }
  volBtn.addEventListener('click', () => {
    audio.muted = !audio.muted;
    if(!audio.muted && audio.volume === 0) audio.volume = 1;
    volSlider.value = audio.muted ? 0 : audio.volume;
    setVolumeIcons();
  });
  volSlider.addEventListener('input', () => {
    audio.volume = parseFloat(volSlider.value);
    audio.muted = audio.volume === 0;
    setVolumeIcons();
  });

  favBtn.addEventListener('click', () => {
    const item = currentTrack();
    if(!item) return;
    toggleFav(item);
    favBtn.classList.toggle('is-fav', isFav(item));
  });

  function openQueue(){ renderQueueList(); queueBackdrop.hidden = false; }
  function closeQueue(){ queueBackdrop.hidden = true; }
  queueBtn.addEventListener('click', openQueue);
  queueClose.addEventListener('click', closeQueue);
  queueBackdrop.addEventListener('click', (e) => { if(e.target === queueBackdrop) closeQueue(); });

  setPlayIcons();
  setVolumeIcons();
}

function renderQueueList(){
  const listEl = document.getElementById('musicQueueList');
  if(!listEl) return;
  const upcoming = state.musicQueue;
  if(!upcoming.length){
    listEl.innerHTML = '<div class="modal-empty">Nothing queued yet.</div>';
    return;
  }
  listEl.innerHTML = upcoming.map((item, idx) => `
    <div class="mq-row ${idx === state.musicQueueIndex ? 'playing' : ''}" data-idx="${idx}">
      <div class="mq-art">${coverArtHTML(item, 32)}</div>
      <div class="mq-meta">
        <div class="mq-title">${escapeHtml(trackTitle(item))}</div>
        <div class="mq-artist">${escapeHtml(trackArtist(item))}</div>
      </div>
      <span class="mq-dur">${item.duration ? formatDuration(item.duration) : ''}</span>
    </div>
  `).join('');
  listEl.querySelectorAll('.mq-row').forEach(row => {
    row.addEventListener('click', () => playTrackAt(+row.dataset.idx));
  });
}


