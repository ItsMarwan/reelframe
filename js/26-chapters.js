/* ==========================================================================
   Video chapters/markers — lightweight per-video timestamped bookmarks,
   stored locally, rendered as ticks on the scrubber, jumpable from a panel.
   ========================================================================== */
function chapterKeyForItem(item){ return item ? `${item.type}:${item.path}` : null; }

function getChaptersForItem(item){
  const key = chapterKeyForItem(item);
  if(!key) return [];
  return (state.chapters[key] || []).slice().sort((a,b) => a.time - b.time);
}

function saveChaptersForItem(item, list){
  const key = chapterKeyForItem(item);
  if(!key) return;
  if(list.length) state.chapters[key] = list;
  else delete state.chapters[key];
  saveChapters();
}

function addChapterAtCurrentTime(){
  const item = state.currentVideo;
  const video = document.getElementById('videoPlayer');
  if(!item || !video) return;
  const label = (prompt('Label for this chapter?', formatDuration(video.currentTime)) || '').trim();
  if(!label) return;
  const list = getChaptersForItem(item);
  list.push({ time: video.currentTime, label });
  saveChaptersForItem(item, list);
  renderChapterTicks(item);
  renderChaptersList(item);
  toast('Chapter added');
}

function removeChapter(item, index){
  const list = getChaptersForItem(item);
  list.splice(index, 1);
  saveChaptersForItem(item, list);
  renderChapterTicks(item);
  renderChaptersList(item);
}

function renderChapterTicks(item){
  const wrap = document.getElementById('playerChapterTicks');
  if(!wrap) return;
  wrap.innerHTML = '';
  const video = document.getElementById('videoPlayer');
  const duration = video && isFinite(video.duration) ? video.duration : (item && item.duration) || 0;
  if(!duration || !item) return;
  getChaptersForItem(item).forEach(ch => {
    const pct = Math.max(0, Math.min(100, (ch.time / duration) * 100));
    const tick = document.createElement('div');
    tick.className = 'chapter-tick';
    tick.style.left = `${pct}%`;
    tick.title = ch.label;
    tick.addEventListener('click', (e) => {
      e.stopPropagation();
      if(isFinite(video.duration)) video.currentTime = ch.time;
    });
    wrap.appendChild(tick);
  });
}

function renderChaptersList(item){
  const listEl = document.getElementById('chaptersModalList');
  if(!listEl) return;
  const chapters = getChaptersForItem(item);
  if(!chapters.length){
    listEl.innerHTML = '<div class="modal-empty">No chapters yet. Play to where you want a marker, then add one.</div>';
    return;
  }
  listEl.innerHTML = chapters.map((ch, idx) => `
    <div class="folder-row" data-idx="${idx}" style="justify-content:space-between;">
      <div class="folder-check chapter-jump" style="cursor:pointer; flex:1 1 auto;">
        <span class="fr-name">${escapeHtml(ch.label)}</span>
        <span class="fr-count">${formatDuration(ch.time)}</span>
      </div>
      <button class="btn-icon chapter-remove-btn" data-idx="${idx}" title="Remove chapter">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      </button>
    </div>
  `).join('');
  listEl.querySelectorAll('.chapter-jump').forEach(row => {
    row.addEventListener('click', () => {
      const idx = +row.closest('.folder-row').dataset.idx;
      const video = document.getElementById('videoPlayer');
      const ch = chapters[idx];
      if(video && ch) video.currentTime = ch.time;
      document.getElementById('chaptersModalBackdrop').hidden = true;
    });
  });
  listEl.querySelectorAll('.chapter-remove-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeChapter(item, +btn.dataset.idx);
    });
  });
}

function bindChaptersUI(){
  const openBtn = document.getElementById('chaptersBtn');
  const backdrop = document.getElementById('chaptersModalBackdrop');
  const closeBtn = document.getElementById('chaptersModalClose');
  const addBtn = document.getElementById('addChapterBtn');
  if(!openBtn || !backdrop) return;
  openBtn.addEventListener('click', () => {
    renderChaptersList(state.currentVideo);
    backdrop.hidden = false;
  });
  closeBtn.addEventListener('click', () => { backdrop.hidden = true; });
  backdrop.addEventListener('click', (e) => { if(e.target === backdrop) backdrop.hidden = true; });
  addBtn.addEventListener('click', addChapterAtCurrentTime);
}