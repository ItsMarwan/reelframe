/* ==========================================================================
   Playlists — user-defined, reorderable music playlists (localStorage),
   plus a generic drag-to-reorder helper reused for the playlist editor
   and the existing queue drawer.
   ========================================================================== */
const PLAYLISTS_KEY = 'reelframe-playlists-v1';

function loadPlaylists(){
  try{ const raw = localStorage.getItem(PLAYLISTS_KEY); return raw ? JSON.parse(raw) : []; }
  catch(e){ return []; }
}
function savePlaylists(){ localStorage.setItem(PLAYLISTS_KEY, JSON.stringify(state.playlists)); }
if(!state.playlists) state.playlists = loadPlaylists();

function createPlaylist(name){
  const playlist = { id: 'pl_' + Date.now() + '_' + Math.floor(Math.random() * 1000), name: name || 'New playlist', trackPaths: [] };
  state.playlists.push(playlist);
  savePlaylists();
  return playlist;
}
function deletePlaylist(id){ state.playlists = state.playlists.filter(p => p.id !== id); savePlaylists(); }
function renamePlaylist(id, name){
  const p = state.playlists.find(pl => pl.id === id);
  if(p){ p.name = name; savePlaylists(); }
}
function addTrackToPlaylist(playlistId, item){
  const p = state.playlists.find(pl => pl.id === playlistId);
  if(!p) return;
  if(!p.trackPaths.includes(item.path)) p.trackPaths.push(item.path);
  savePlaylists();
}
function removeTrackFromPlaylist(playlistId, path){
  const p = state.playlists.find(pl => pl.id === playlistId);
  if(!p) return;
  p.trackPaths = p.trackPaths.filter(pp => pp !== path);
  savePlaylists();
}
function reorderPlaylistTrack(playlistId, fromIdx, toIdx){
  const p = state.playlists.find(pl => pl.id === playlistId);
  if(!p) return;
  const [moved] = p.trackPaths.splice(fromIdx, 1);
  p.trackPaths.splice(toIdx, 0, moved);
  savePlaylists();
}
function playlistTracks(playlist){
  return playlist.trackPaths.map(path => state.audio.find(a => a.path === path)).filter(Boolean);
}

/* ---------- Generic drag-to-reorder ---------- */
function enableDragReorder(containerEl, rowSelector, onReorder){
  if(!containerEl) return;
  let dragEl = null;
  containerEl.querySelectorAll(rowSelector).forEach(row => {
    row.setAttribute('draggable', 'true');
    row.classList.add('drag-reorder-row');
    row.addEventListener('dragstart', () => {
      dragEl = row;
      row.classList.add('dragging-row');
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging-row');
      dragEl = null;
      containerEl.querySelectorAll(rowSelector).forEach(r => r.classList.remove('drag-over-before', 'drag-over-after'));
    });
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      if(!dragEl || dragEl === row) return;
      const rect = row.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      row.classList.toggle('drag-over-before', before);
      row.classList.toggle('drag-over-after', !before);
    });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over-before', 'drag-over-after'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('drag-over-before', 'drag-over-after');
      if(!dragEl || dragEl === row) return;
      const rows = [...containerEl.querySelectorAll(rowSelector)];
      const fromIdx = rows.indexOf(dragEl);
      let toIdx = rows.indexOf(row);
      const rect = row.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      if(!before) toIdx += 1;
      if(toIdx > fromIdx) toIdx -= 1;
      if(fromIdx === toIdx) return;
      onReorder(fromIdx, toIdx);
    });
  });
}

/* ---------- Playlists UI ---------- */
let playlistAddContext = null;

function renderPlaylistsList(){
  const listEl = document.getElementById('playlistsModalList');
  if(!listEl) return;
  if(state.playlists.length === 0){
    listEl.innerHTML = '<div class="modal-empty">No playlists yet. Create one above.</div>';
  } else {
    listEl.innerHTML = state.playlists.map(p => `
      <div class="playlist-row" data-id="${escapeAttr(p.id)}">
        <div class="playlist-row-main">
          <div class="playlist-row-name">${escapeHtml(p.name)}</div>
          <div class="playlist-row-count">${p.trackPaths.length} track${p.trackPaths.length === 1 ? '' : 's'}</div>
        </div>
        <div class="playlist-row-actions">
          ${playlistAddContext
            ? `<button class="btn-ghost small playlist-add-btn" data-id="${escapeAttr(p.id)}">Add here</button>`
            : `<button class="btn-ghost small playlist-open-btn" data-id="${escapeAttr(p.id)}">Open</button>
               <button class="btn-ghost small playlist-play-btn" data-id="${escapeAttr(p.id)}">Play</button>
               <button class="btn-icon playlist-delete-btn" data-id="${escapeAttr(p.id)}" title="Delete">
                 <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
               </button>`}
        </div>
      </div>
    `).join('');
  }

  listEl.querySelectorAll('.playlist-add-btn').forEach(btn => btn.addEventListener('click', () => {
    if(playlistAddContext) addTrackToPlaylist(btn.dataset.id, playlistAddContext);
    toast('Added to playlist');
    closePlaylistsModal();
  }));
  listEl.querySelectorAll('.playlist-open-btn').forEach(btn => btn.addEventListener('click', () => openPlaylistEditor(btn.dataset.id)));
  listEl.querySelectorAll('.playlist-play-btn').forEach(btn => btn.addEventListener('click', () => {
    const p = state.playlists.find(pl => pl.id === btn.dataset.id);
    if(!p) return;
    const tracks = playlistTracks(p);
    if(!tracks.length){ toast('That playlist is empty.'); return; }
    closePlaylistsModal();
    playTrack(tracks[0], tracks);
  }));
  listEl.querySelectorAll('.playlist-delete-btn').forEach(btn => btn.addEventListener('click', () => {
    deletePlaylist(btn.dataset.id);
    renderPlaylistsList();
  }));
}

function openPlaylistsModal(itemForAdd){
  playlistAddContext = itemForAdd || null;
  const backdrop = document.getElementById('playlistsModalBackdrop');
  const title = document.getElementById('playlistsModalTitle');
  if(title) title.textContent = playlistAddContext ? `Add "${trackTitle(playlistAddContext)}" to a playlist` : 'Playlists';
  renderPlaylistsList();
  if(backdrop) backdrop.hidden = false;
}
function closePlaylistsModal(){
  playlistAddContext = null;
  const backdrop = document.getElementById('playlistsModalBackdrop');
  if(backdrop) backdrop.hidden = true;
}

let currentEditingPlaylistId = null;
function openPlaylistEditor(id){
  currentEditingPlaylistId = id;
  renderPlaylistEditor();
  const backdrop = document.getElementById('playlistEditorBackdrop');
  if(backdrop) backdrop.hidden = false;
}
function renderPlaylistEditor(){
  const p = state.playlists.find(pl => pl.id === currentEditingPlaylistId);
  const listEl = document.getElementById('playlistEditorList');
  const titleEl = document.getElementById('playlistEditorTitle');
  if(!p || !listEl) return;
  if(titleEl) titleEl.textContent = p.name;
  const tracks = playlistTracks(p);
  if(tracks.length === 0){
    listEl.innerHTML = '<div class="modal-empty">No tracks yet — use the + button on any track in the Music tab.</div>';
    return;
  }
  listEl.innerHTML = tracks.map((t, idx) => `
    <div class="playlist-track-row" data-idx="${idx}" data-path="${escapeAttr(t.path)}">
      <span class="drag-handle" title="Drag to reorder">⠿</span>
      <div class="track-art">${coverArtHTML(t, 32)}</div>
      <div class="track-info">
        <div class="track-title">${escapeHtml(trackTitle(t))}</div>
        <div class="track-artist">${escapeHtml(trackArtist(t))}</div>
      </div>
      <button class="btn-icon playlist-track-remove" data-path="${escapeAttr(t.path)}" title="Remove">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      </button>
    </div>
  `).join('');
  listEl.querySelectorAll('.playlist-track-row').forEach(row => row.addEventListener('click', (e) => {
    if(e.target.closest('.playlist-track-remove') || e.target.closest('.drag-handle')) return;
    const tracksNow = playlistTracks(p);
    playTrack(tracksNow[+row.dataset.idx], tracksNow);
    closePlaylistsModal();
    document.getElementById('playlistEditorBackdrop').hidden = true;
  }));
  listEl.querySelectorAll('.playlist-track-remove').forEach(btn => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    removeTrackFromPlaylist(p.id, btn.dataset.path);
    renderPlaylistEditor();
  }));
  enableDragReorder(listEl, '.playlist-track-row', (fromIdx, toIdx) => {
    reorderPlaylistTrack(p.id, fromIdx, toIdx);
    renderPlaylistEditor();
  });
}

function bindPlaylistsUI(){
  const openBtn = document.getElementById('playlistsBtn');
  const createBtn = document.getElementById('createPlaylistBtn');
  const newPlaylistInput = document.getElementById('newPlaylistNameInput');
  const playlistsBackdrop = document.getElementById('playlistsModalBackdrop');
  const playlistsClose = document.getElementById('playlistsModalClose');
  const editorBackdrop = document.getElementById('playlistEditorBackdrop');
  const editorClose = document.getElementById('playlistEditorClose');
  const editorBack = document.getElementById('playlistEditorBackBtn');

  if(openBtn) openBtn.addEventListener('click', () => openPlaylistsModal());
  if(playlistsClose) playlistsClose.addEventListener('click', closePlaylistsModal);
  if(playlistsBackdrop) playlistsBackdrop.addEventListener('click', (e) => { if(e.target === playlistsBackdrop) closePlaylistsModal(); });

  if(createBtn){
    createBtn.addEventListener('click', () => {
      const name = newPlaylistInput?.value.trim();
      if(!name) return;
      createPlaylist(name);
      if(newPlaylistInput) newPlaylistInput.value = '';
      renderPlaylistsList();
    });
  }

  if(editorClose) editorClose.addEventListener('click', () => { if(editorBackdrop) editorBackdrop.hidden = true; });
  if(editorBack) editorBack.addEventListener('click', () => { if(editorBackdrop) editorBackdrop.hidden = true; openPlaylistsModal(); });
}

document.addEventListener('DOMContentLoaded', bindPlaylistsUI);
