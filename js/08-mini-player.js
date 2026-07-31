/* ==========================================================================
   Mini player (picture-in-picture style docked bar, or native PiP)
   ========================================================================== */
let miniPlayerActive = false;
let miniPlayerDrag = null;
let miniPlayerPositioned = false;
const MINI_PLAYER_FOLLOW_DAMPING = 0.22; // lower = laggier/more fluid, higher = snappier
const MINI_PLAYER_SETTLE_EPS = 0.4;
let miniPlayerFollow = null; // { targetLeft, targetTop, rafId, onSettle }

function stopMiniPlayerFollow(){
  if(miniPlayerFollow && miniPlayerFollow.rafId) cancelAnimationFrame(miniPlayerFollow.rafId);
  miniPlayerFollow = null;
}

/* Keeps nudging the box toward wherever it's supposed to be — the live
   pointer position while dragging, or the snapped edge once released —
   instead of jumping straight there each frame. That lag is what reads
   as fluid motion rather than glued to the cursor. */
function tickMiniPlayerFollow(bar){
  if(!miniPlayerFollow) return;
  const rect = bar.getBoundingClientRect();
  const dx = miniPlayerFollow.targetLeft - rect.left;
  const dy = miniPlayerFollow.targetTop - rect.top;
  const stillDragging = !!(miniPlayerDrag && miniPlayerDrag.mode === 'move');
  const settled = !stillDragging && Math.abs(dx) < MINI_PLAYER_SETTLE_EPS && Math.abs(dy) < MINI_PLAYER_SETTLE_EPS;
  if(settled){
    bar.style.left = `${miniPlayerFollow.targetLeft}px`;
    bar.style.top = `${miniPlayerFollow.targetTop}px`;
    const onSettle = miniPlayerFollow.onSettle;
    miniPlayerFollow = null;
    if(onSettle) onSettle();
    return;
  }
  bar.style.left = `${rect.left + dx * MINI_PLAYER_FOLLOW_DAMPING}px`;
  bar.style.top = `${rect.top + dy * MINI_PLAYER_FOLLOW_DAMPING}px`;
  miniPlayerFollow.rafId = requestAnimationFrame(() => tickMiniPlayerFollow(bar));
}

function setMiniPlayerFollowTarget(bar, left, top, opts = {}){
  const alreadyRunning = !!(miniPlayerFollow && miniPlayerFollow.rafId);
  miniPlayerFollow = { targetLeft: left, targetTop: top, rafId: alreadyRunning ? miniPlayerFollow.rafId : null, onSettle: opts.onSettle || null };
  if(!alreadyRunning) miniPlayerFollow.rafId = requestAnimationFrame(() => tickMiniPlayerFollow(bar));
}

function stopActiveVideo(){
  const video = document.getElementById('videoPlayer');
  if(video && !miniPlayerActive){
    video.pause();
  }
  const overlay = document.getElementById('nextUpOverlay');
  if(overlay) overlay.hidden = true;
}

/* Moves the live <video> element into the floating mini player (or, if the
   real-mini-player setting is on and supported, hands it to native
   Picture-in-Picture) instead of pausing it, so playback — or a paused
   frame — stays visible while the person browses elsewhere. */
async function dockMiniPlayer(){
  const video = document.getElementById('videoPlayer');
  if(!video) return;

  if(!state.miniPlayerEnabled){ // NEW — setting off: just pause, no floating window
    video.pause();
    return;
  }

  if(state.realMiniPlayerEnabled && document.pictureInPictureEnabled && !video.disablePictureInPicture){
    try{
      if(document.pictureInPictureElement !== video) await video.requestPictureInPicture();
      miniPlayerActive = true;
      return;
    }catch(e){ /* fall through to the built-in mini player */ }
  }

  const frame = document.getElementById('miniPlayerFrame');
  const bar = document.getElementById('miniPlayerBar');
  if(!frame || !bar) return;
  frame.appendChild(video);
  document.getElementById('miniPlayerTitle').textContent = (state.currentVideo && state.currentVideo.name) || '';
  const wasHidden = bar.hidden;
  bar.hidden = false;
  if(wasHidden){
    bar.classList.add('entering');
    setTimeout(() => bar.classList.remove('entering'), 340);
  }
  miniPlayerActive = true;
  if(miniPlayerPositioned) clampMiniPlayerToViewport(bar);
  updateMiniPlayerPlayState();
}

/* Moves the <video> element back into the normal watch view player slot. */
function undockMiniPlayer(){
  const video = document.getElementById('videoPlayer');
  const wrap = document.getElementById('playerWrap');
  const bar = document.getElementById('miniPlayerBar');
  stopMiniPlayerFollow();
  if(document.pictureInPictureElement) document.exitPictureInPicture().catch(()=>{});
  if(video && wrap) wrap.prepend(video);
  if(bar) bar.hidden = true;
  miniPlayerActive = false;
}

function closeMiniPlayer(){
  const video = document.getElementById('videoPlayer');
  if(video) video.pause();
  if(document.pictureInPictureElement) document.exitPictureInPicture().catch(()=>{});
  undockMiniPlayer();
}

function expandMiniPlayer(){
  if(!miniPlayerActive) return;
  const item = state.currentVideo;
  if(document.pictureInPictureElement) document.exitPictureInPicture().catch(()=>{});
  showView('videoWatch');
  if(item && !item.ephemeral) history.pushState(null, '', `?v=${encodeURIComponent(item.path)}`);
}

/* Plays a different video directly inside the mini player — used by its
   "next" button — without switching the person away from whatever
   view they're currently browsing. */
function miniPlayerPlayItem(item){
  if(!item) return;
  const video = document.getElementById('videoPlayer');
  if(!video) return;
  state.currentVideo = item;
  recordHistory(item);
  consumeWatchLater(item);
  [...video.querySelectorAll('track')].forEach(t => t.remove());
  state.captionsEnabled = false;
  video.src = ensureItemUrl(item);
  video.play().catch(() => {});
  document.getElementById('miniPlayerTitle').textContent = item.name;
  applyWatchItemMeta(item);
  updateCaptionButtons();
  const { autoplayCandidates } = buildAutoplayQueue(item);
  currentUpNext = autoplayCandidates;
}

function miniPlayerNext(){
  if(!currentUpNext.length){ toast('No more videos in Up next'); return; }
  miniPlayerPlayItem(currentUpNext[0]);
}

function updateMiniPlayerPlayState(){
  const video = document.getElementById('videoPlayer');
  const playIcon = document.getElementById('miniPlayerPlayIcon');
  const pauseIcon = document.getElementById('miniPlayerPauseIcon');
  if(!video || !playIcon || !pauseIcon) return;
  const isPlaying = !video.paused && !video.ended;
  playIcon.classList.toggle('icon-hide', isPlaying);
  pauseIcon.classList.toggle('icon-hide', !isPlaying);
}

/* Keeps the floating box inside the viewport — called after resizing the
   window, resizing the box itself, or re-docking after a resize elsewhere. */
function clampMiniPlayerToViewport(bar){
  const rect = bar.getBoundingClientRect();
  const musicBarActive = document.getElementById('app')?.classList.contains('has-music-bar');
  const bottomReserve = musicBarActive ? 96 : 12;
  const maxLeft = Math.max(6, window.innerWidth - rect.width - 6);
  const maxTop = Math.max(6, window.innerHeight - rect.height - bottomReserve);
  const left = clampValue(rect.left, 6, maxLeft);
  const top = clampValue(rect.top, 6, maxTop);
  bar.style.left = `${left}px`;
  bar.style.top = `${top}px`;
}

/* Switches the box from its default bottom/right-anchored CSS position
   over to explicit left/top pixel coordinates, without visually moving
   it, so subsequent drags/resizes have a fixed point of reference. */
function pinMiniPlayerPosition(bar){
  if(miniPlayerPositioned) return;
  const rect = bar.getBoundingClientRect();
  bar.style.left = `${rect.left}px`;
  bar.style.top = `${rect.top}px`;
  bar.style.right = 'auto';
  bar.style.bottom = 'auto';
  bar.classList.add('positioned');
  miniPlayerPositioned = true;
}

/* After a free drag, glide the box to whichever side edge it's closest to,
   like YouTube's mini player. */
function snapMiniPlayerToEdge(bar){
  const rect = bar.getBoundingClientRect();
  const margin = 14;
  const spaceLeft = rect.left;
  const spaceRight = window.innerWidth - rect.right;
  const targetLeft = spaceLeft <= spaceRight
    ? margin
    : window.innerWidth - rect.width - margin;
  const maxTop = Math.max(6, window.innerHeight - rect.height - 6);
  const targetTop = clampValue(rect.top, 6, maxTop);
  setMiniPlayerFollowTarget(bar, targetLeft, targetTop);
}

function bindMiniPlayer(){
  const bar = document.getElementById('miniPlayerBar');
  const frame = document.getElementById('miniPlayerFrame');
  const playBtn = document.getElementById('miniPlayerPlayBtn');
  const nextBtn = document.getElementById('miniPlayerNextBtn');
  const expandBtn = document.getElementById('miniPlayerExpandBtn');
  const closeBtn = document.getElementById('miniPlayerCloseBtn');
  const resizeHandle = document.getElementById('miniPlayerResize');       // bottom-right
  const resizeHandleTL = document.getElementById('miniPlayerResizeTL');   // top-left
  if(!bar || !frame) return;

  playBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const video = document.getElementById('videoPlayer');
    if(!video) return;
    if(video.paused) video.play().catch(() => {});
    else video.pause();
  });
  nextBtn.addEventListener('click', (e) => { e.stopPropagation(); miniPlayerNext(); });
  expandBtn.addEventListener('click', (e) => { e.stopPropagation(); expandMiniPlayer(); });
  closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeMiniPlayer(); });

  // ---- Drag the whole box around the screen ----
    frame.addEventListener('pointerdown', (e) => {
    if(e.target.closest('.mini-player-center-btn, .mini-player-expand, .mini-player-close, .mini-player-resize')) return;
    pinMiniPlayerPosition(bar);
    stopMiniPlayerFollow();
    const rect = bar.getBoundingClientRect();
    miniPlayerDrag = { mode:'move', startX:e.clientX, startY:e.clientY, startLeft:rect.left, startTop:rect.top, moved:false };
    frame.classList.add('dragging');
    bar.classList.add('dragging');
    frame.setPointerCapture(e.pointerId);
  });
  frame.addEventListener('pointermove', (e) => {
    if(!miniPlayerDrag || miniPlayerDrag.mode !== 'move') return;
    const dx = e.clientX - miniPlayerDrag.startX;
    const dy = e.clientY - miniPlayerDrag.startY;
    if(Math.abs(dx) > 4 || Math.abs(dy) > 4) miniPlayerDrag.moved = true;
    const rect = bar.getBoundingClientRect();
    const maxLeft = Math.max(6, window.innerWidth - rect.width - 6);
    const maxTop = Math.max(6, window.innerHeight - rect.height - 6);
    const targetLeft = clampValue(miniPlayerDrag.startLeft + dx, 6, maxLeft);
    const targetTop = clampValue(miniPlayerDrag.startTop + dy, 6, maxTop);
    setMiniPlayerFollowTarget(bar, targetLeft, targetTop);
  });
  function endFrameDrag(){
    if(!miniPlayerDrag || miniPlayerDrag.mode !== 'move') return;
    frame.classList.remove('dragging');
    bar.classList.remove('dragging');
    const moved = miniPlayerDrag.moved;
    miniPlayerDrag = null;
    if(!moved){ stopMiniPlayerFollow(); expandMiniPlayer(); }
    else snapMiniPlayerToEdge(bar);
  }
  frame.addEventListener('pointerup', endFrameDrag);
  frame.addEventListener('pointercancel', () => {
    frame.classList.remove('dragging'); bar.classList.remove('dragging'); miniPlayerDrag = null;
  });

  // ---- Resize from the top-left corner ----
  if(resizeHandleTL){
    resizeHandleTL.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      pinMiniPlayerPosition(bar);
      const rect = bar.getBoundingClientRect();
      miniPlayerDrag = { mode:'resize-tl', startX:e.clientX, startWidth:rect.width, startLeft:rect.left, startTop:rect.top };
      resizeHandleTL.setPointerCapture(e.pointerId);
    });
    resizeHandleTL.addEventListener('pointermove', (e) => {
      if(!miniPlayerDrag || miniPlayerDrag.mode !== 'resize-tl') return;
      const dx = e.clientX - miniPlayerDrag.startX;
      const maxWidth = Math.min(640, window.innerWidth - 24);
      const newWidth = clampValue(miniPlayerDrag.startWidth - dx, 200, maxWidth);
      const newHeight = newWidth * (9 / 16);
      const oldHeight = miniPlayerDrag.startWidth * (9 / 16);
      bar.style.width = `${newWidth}px`;
      bar.style.left = `${miniPlayerDrag.startLeft + (miniPlayerDrag.startWidth - newWidth)}px`;
      bar.style.top = `${miniPlayerDrag.startTop + (oldHeight - newHeight)}px`;
      clampMiniPlayerToViewport(bar);
    });
    const endResizeTL = () => { miniPlayerDrag = null; };
    resizeHandleTL.addEventListener('pointerup', endResizeTL);
    resizeHandleTL.addEventListener('pointercancel', endResizeTL);
  }

  // ---- Resize from the bottom-right corner ----
  if(resizeHandle){
    resizeHandle.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      pinMiniPlayerPosition(bar);
      const rect = bar.getBoundingClientRect();
      miniPlayerDrag = { mode:'resize-br', startX:e.clientX, startWidth:rect.width };
      resizeHandle.setPointerCapture(e.pointerId);
    });
    resizeHandle.addEventListener('pointermove', (e) => {
      if(!miniPlayerDrag || miniPlayerDrag.mode !== 'resize-br') return;
      const dx = e.clientX - miniPlayerDrag.startX;
      const maxWidth = Math.min(640, window.innerWidth - 24);
      const newWidth = clampValue(miniPlayerDrag.startWidth + dx, 200, maxWidth);
      bar.style.width = `${newWidth}px`;
      // top-left stays put; box grows down/right — height follows the CSS aspect-ratio
      clampMiniPlayerToViewport(bar);
    });
    const endResizeBR = () => { miniPlayerDrag = null; };
    resizeHandle.addEventListener('pointerup', endResizeBR);
    resizeHandle.addEventListener('pointercancel', endResizeBR);
  }

  window.addEventListener('resize', () => {
    if(bar.hidden || !miniPlayerPositioned) return;
    clampMiniPlayerToViewport(bar);
  });

  // Keep the mini player's icon in sync with the actual element, whichever view it's in.
  const video = document.getElementById('videoPlayer');
  if(video){
    video.addEventListener('play', updateMiniPlayerPlayState);
    video.addEventListener('pause', updateMiniPlayerPlayState);
    video.addEventListener('leavepictureinpicture', () => {
      miniPlayerActive = false;
      const wrap = document.getElementById('playerWrap');
      const onWatch = !document.getElementById('videoWatch').hidden;
      if(wrap) wrap.prepend(video);
      if(!onWatch) video.pause();
    });
  }
}