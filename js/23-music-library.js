/* ==========================================================================
   Music library — a Spotify-style track list
   ========================================================================== */
const MUSIC_PAGE_SIZE = 60;
let musicGridState = { list: [], rendered: 0 };
let musicRowObserver = null;

function updateMusicEndMessage(rendered, total){
  const el = document.getElementById('musicEndMessage');
  if(el) el.hidden = !(rendered >= total && total > 0);
}

function renderMusicLibrary(){
  const rowsWrap = document.getElementById('musicRows');
  const list = getFiltered('music');
  document.getElementById('musicEmpty').hidden = list.length !== 0;
  document.getElementById('musicPlayAllBtn').hidden = list.length === 0;
  rowsWrap.innerHTML = '';
  musicGridState = { list, rendered: 0 };
  updateMusicEndMessage(0, list.length);

  if(musicRowObserver) musicRowObserver.disconnect();
  musicRowObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if(!entry.isIntersecting) return;
      const el = entry.target;
      const item = musicGridState.list[+el.dataset.idx];
      loadTrackRowMeta(el, item);
      musicRowObserver.unobserve(el);
    });
  }, { rootMargin: '600px 0px' });

  const restore = pendingGridRestore && pendingGridRestore.tab === 'music' ? pendingGridRestore : null;
  appendMusicRows(restore ? Math.max(MUSIC_PAGE_SIZE, state.gridRenderedCount.music) : MUSIC_PAGE_SIZE);
  setupGridLoadMore('musicGridSentinel', 'music', () => appendMusicRows(MUSIC_PAGE_SIZE));

  document.getElementById('musicPlayAllBtn').onclick = () => {
    if(musicGridState.list.length) playTrack(musicGridState.list[0], musicGridState.list);
  };

  if(restore){
    pendingGridRestore = null;
    requestAnimationFrame(() => {
      const m = document.querySelector('.main');
      if(m) m.scrollTop = restore.top;
    });
  }
  highlightPlayingRow();
}

function appendMusicRows(count){
  const rowsWrap = document.getElementById('musicRows');
  const { list, rendered } = musicGridState;
  const end = Math.min(list.length, rendered + count);
  for(let idx = rendered; idx < end; idx++){
    const item = list[idx];
    const row = document.createElement('div');
    row.className = 'track-row';
    row.dataset.idx = idx;
    row.dataset.path = item.path;
    row.innerHTML = `
      <span class="track-index">${idx + 1}</span>
      <button class="track-play-btn" title="Play">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7Z"/></svg>
      </button>
      <div class="track-art">${coverArtHTML(item, 40)}</div>
      <div class="track-info">
        <div class="track-title">${escapeHtml(trackTitle(item))}</div>
        <div class="track-artist">${escapeHtml(trackArtist(item))}</div>
      </div>
      <div class="track-col-album">${escapeHtml(item.album || item.category)}</div>
      <button class="track-fav-btn ${isFav(item)?'is-fav':''}" data-fav-key="${favKey(item)}" title="Favorite">${heartSVG(isFav(item))}</button>
      <span class="track-duration">${item.duration ? formatDuration(item.duration) : ''}</span>
    `;
    row.querySelector('.track-fav-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFav(item);
      e.currentTarget.classList.toggle('is-fav', isFav(item));
      e.currentTarget.innerHTML = heartSVG(isFav(item));
    });
    row.addEventListener('click', (e) => {
      if(e.target.closest('.track-fav-btn')) return;
      playTrack(item, musicGridState.list);
    });
    rowsWrap.appendChild(row);
    musicRowObserver.observe(row);
  }
  musicGridState.rendered = end;
  updateMusicEndMessage(end, list.length);
}

async function loadTrackRowMeta(rowEl, item){
  await ensureAudioMeta(item);
  const titleEl = rowEl.querySelector('.track-title');
  const artistEl = rowEl.querySelector('.track-artist');
  const albumEl = rowEl.querySelector('.track-col-album');
  const durEl = rowEl.querySelector('.track-duration');
  const artEl = rowEl.querySelector('.track-art');
  if(titleEl) titleEl.textContent = trackTitle(item);
  if(artistEl) artistEl.textContent = trackArtist(item);
  if(albumEl) albumEl.textContent = item.album || item.category;
  if(durEl && item.duration) durEl.textContent = formatDuration(item.duration);
  if(artEl && item.cover) artEl.innerHTML = coverArtHTML(item, 40);
  if(item.broken) rowEl.classList.add('track-row-broken');
  if(currentTrack() === item) loadTrackIntoBar(item);
}

function highlightPlayingRow(){
  const playing = currentTrack();
  document.querySelectorAll('.track-row[data-path]').forEach(row => {
    row.classList.toggle('playing', !!playing && row.dataset.path === playing.path);
  });
}