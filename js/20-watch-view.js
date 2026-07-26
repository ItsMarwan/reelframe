/* ==========================================================================
   Watch view
   ========================================================================== */
const UP_NEXT_COUNT = 12;
let currentUpNext = [];

function applySidebarCollapsed(){
  const side = document.getElementById('watchSide');
  if(!side) return;
  side.classList.toggle('collapsed', state.sideCollapsed);
  const btn = document.getElementById('sideCollapseBtn');
  if(btn) btn.title = state.sideCollapsed ? 'Expand' : 'Collapse';
}

function playNextUpNext(){
  if(currentUpNext.length) openWatch(currentUpNext[0]);
  else toast('No more videos in Up next');
}

function buildAutoplayQueue(item){
  const forYouPicks = computeForYou().filter(v => v !== item).slice(0, 2);
  const forYouPaths = new Set(forYouPicks.map(v => v.path));
  const preferredPool = getFiltered('videos').filter(v => v !== item && !forYouPaths.has(v.path));
  const fallbackPool = state.videos.filter(v => v !== item && !forYouPaths.has(v.path));
  const seenPaths = new Set([item.path]);
  const queue = [];
  [preferredPool, fallbackPool].forEach(pool => {
    pool.forEach(v => {
      if(seenPaths.has(v.path)) return;
      seenPaths.add(v.path);
      queue.push(v);
    });
  });
  shuffleArray(queue);

  const autoplayCandidates = queue.slice(0, 2);
  const sideCards = [];
  const sideSeen = new Set([item.path]);
  const pushUnique = (list) => {
    list.forEach(v => {
      if(sideSeen.has(v.path)) return;
      sideSeen.add(v.path);
      sideCards.push(v);
    });
  };
  pushUnique(autoplayCandidates);
  pushUnique(forYouPicks);
  pushUnique(queue.slice(2, Math.max(0, UP_NEXT_COUNT - autoplayCandidates.length - forYouPicks.length) + 2));

  return { autoplayCandidates, sideCards, forYouPaths };
}

function applyWatchItemMeta(item){
  document.getElementById('watchTitle').textContent = item.name;
  document.getElementById('watchMeta').textContent =
    `${item.category} · ${formatDate(item.lastModified)} · ${formatBytes(item.size)}`;

  const favBtn = document.getElementById('watchFavBtn');
  favBtn.setAttribute('data-fav-key', favKey(item));
  favBtn.classList.toggle('is-fav', isFav(item));
  favBtn.onclick = () => {
    toggleFav(item);
    favBtn.classList.toggle('is-fav', isFav(item));
  };

  const watchLaterBtn = document.getElementById('watchLaterBtn');
  if(watchLaterBtn){
    watchLaterBtn.setAttribute('data-watch-later-key', favKey(item));
    watchLaterBtn.classList.toggle('is-watch-later', isWatchLater(item));
    watchLaterBtn.innerHTML = watchLaterSVG(isWatchLater(item));
    watchLaterBtn.onclick = () => {
      toggleWatchLater(item);
      watchLaterBtn.classList.toggle('is-watch-later', isWatchLater(item));
      watchLaterBtn.innerHTML = watchLaterSVG(isWatchLater(item));
    };
  }

  const watchSaveBtn = document.getElementById('watchSaveBtn');
  if(watchSaveBtn){
    watchSaveBtn.hidden = !item.remote;
    watchSaveBtn.onclick = () => promptSaveItem(item, 'videos');
  }

  const shareBtn = document.getElementById('shareVideoBtn');
  if(shareBtn) shareBtn.onclick = () => openShareModal(item);

  if(typeof renderChapterTicks === 'function') renderChapterTicks(item);
}

function openWatch(item, opts = {}){
  state.currentVideo = item;
  recordHistory(item);
  consumeWatchLater(item);
  clearNextUpPrompt({ reset: true });
  showView('videoWatch');
  applySidebarCollapsed();
  if(opts.push !== false) history.pushState(null, '', `?v=${encodeURIComponent(item.path)}`);
  const player = document.getElementById('videoPlayer');
  [...player.querySelectorAll('track')].forEach(t => {
    if(t.dataset.blobUrl) URL.revokeObjectURL(t.dataset.blobUrl);
    t.remove();
  });
  state.captionsEnabled = false;
  updateCaptionButtonUI();
  if(item.pairRemote){
    player.removeAttribute('src');
    toast(`Loading "${item.name}" from the paired device…`);
    ensureItemUrlAsync(item).then(src => {
      if(state.currentVideo !== item) return;
      player.src = src;
      player.play().catch(()=>{});
    }).catch(() => toast("Couldn't load that video from the paired device."));
  } else {
    player.src = ensureItemUrl(item);
    player.play().catch(()=>{});
  }

  loadCaptionsForItem(item).then(saved => {
    if(saved && state.currentVideo === item){
      attachCaptionTrack(saved, 'Saved captions', { silent: true, show: false });
    }
  }).catch(() => {});
  maybeShowCaptionProgressForCurrentVideo();
  const musicAudio = document.getElementById('musicAudioEl');
  if(musicAudio && !musicAudio.paused) musicAudio.pause();
  applyWatchItemMeta(item);

  const captionToggleBtn = document.getElementById('captionToggleBtn');
  const captionFileInput = document.getElementById('captionFileInput');

  if(captionToggleBtn){ captionToggleBtn.onclick = handleCaptionButtonClick; updateCaptionButtonUI(); }
  if(captionFileInput){
    captionFileInput.onchange = (event) => {
      const file = event.target.files?.[0];
      if(file) loadCaptionFile(file);
      event.target.value = '';
    };
  }

  const sideList = document.getElementById('watchSideList');
  const { autoplayCandidates, sideCards, forYouPaths } = buildAutoplayQueue(item);
  currentUpNext = autoplayCandidates;
  sideList.innerHTML = '';
  sideCards.forEach((v, idx) => {
    const row = document.createElement('div');
    row.className = 'wside-item';
    const isSuggested = forYouPaths.has(v.path);
    const isUpNext = idx < currentUpNext.length;
    row.innerHTML = `
      <div class="wside-thumb">
        ${isUpNext ? '<span class="wside-badge wside-badge-upnext">Up next</span>' : isWatchLater(v) ? '<span class="wside-badge">Later</span>' : isSuggested ? '<span class="wside-badge">For You</span>' : ''}
        <div class="thumb-fallback" style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-faint)">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M3 6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z" stroke="currentColor" stroke-width="1.5"/></svg>
        </div>
        <span class="wside-dur" hidden></span>${watchedProgressHTML(v)}
        <button class="vcard-fav ${isFav(v)?'is-fav':''}" data-fav-key="${favKey(v)}" title="Favorite">${heartSVG(isFav(v))}</button>
      </div>
      <div class="wside-meta">
        <div class="wt">${escapeHtml(v.name)}</div>
        <div class="wm-channel">${escapeHtml(v.category)}</div>
        <div class="wm-sub">${formatDate(v.lastModified)}</div>
      </div>
    `;
    row.querySelector('.vcard-fav').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFav(v);
      e.currentTarget.classList.toggle('is-fav', isFav(v));
      e.currentTarget.innerHTML = heartSVG(isFav(v));
    });
    row.addEventListener('click', () => openWatch(v));
    sideList.appendChild(row);
    attachHoverPreview(row, v, '.wside-thumb');
    /* FIX: same null-safety as loadCardThumb (18-video-grid.js) — guard
       against the row having been removed/re-rendered (e.g. the person
       clicked to a new video before this resolved) and against the
       fallback element already being replaced by a previous resolution. */
    ensureVideoMeta(v).then(() => {
      if(!row.isConnected) return;
      if(v.thumb){
        const fallback = row.querySelector('.thumb-fallback');
        if(fallback){
          const img = document.createElement('img');
          img.src = v.thumb; img.alt = v.name;
          fallback.replaceWith(img);
        }
      }
      const d = row.querySelector('.wside-dur');
      if(v.duration && d){ d.textContent = formatDuration(v.duration); d.hidden = false; }
    });
  });

  if(watchParty.role === 'host' && partyIsActive() && watchParty.item !== item) broadcastPartyItem(item);
  scrollMainTop();
}