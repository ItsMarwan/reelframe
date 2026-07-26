/* ==========================================================================
   Global search — Cmd/Ctrl+K — searches videos and photos together,
   regardless of the current tab, category, or folder exclusions.

   Also searches caption transcripts (state.transcripts, built by
   buildTranscriptIndex() in 12-captions.js): if a video has generated or
   imported captions, its spoken text is searchable here too, and clicking
   a transcript match jumps straight to that moment in the video.
   ========================================================================== */
function bindGlobalSearch(){
  const backdrop = document.getElementById('globalSearchBackdrop');
  const input = document.getElementById('globalSearchInput');
  const results = document.getElementById('globalSearchResults');
  const closeBtn = document.getElementById('globalSearchClose');
  const hintBtn = document.getElementById('globalSearchHint');

  function open(){
    backdrop.hidden = false;
    input.value = '';
    renderResults('');
    setTimeout(() => input.focus(), 30);
  }
  function close(){ backdrop.hidden = true; }

  hintBtn.addEventListener('click', open);
  document.getElementById('mobileSearchBtn')?.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if(e.target === backdrop) close(); });

  document.addEventListener('keydown', (e) => {
    if((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')){
      e.preventDefault();
      backdrop.hidden ? open() : close();
    } else if(e.key === 'Escape' && !backdrop.hidden){
      close();
    }
  });

  let debounce;
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => renderResults(input.value.trim().toLowerCase()), 120);
  });

  /* `entry` is { item, cue? } — cue is present for a transcript/caption
     match and carries the matched line's start time (seconds). */
  function goTo(entry){
    const { item, cue } = entry;
    close();
    if(item.type === 'video'){
      setTab('videos', { skipRender:true });
      openWatch(item);
      if(cue != null){
        const video = document.getElementById('videoPlayer');
        const seekToCue = () => { video.currentTime = cue.start; };
        if(video.readyState >= 1) seekToCue();
        else video.addEventListener('loadedmetadata', seekToCue, { once:true });
      }
    }
    else if(item.type === 'image'){ setTab('images', { skipRender:true }); openFocus(item); }
    else { setTab('music', { skipRender:true }); switchViewsForTab(); clearUrlParams(); scrollMainTop(); renderActiveGrid(); playTrack(item); }
  }

  function renderResults(query){
    let entries; // array of { item, cue? }
    if(!query){
      // no query yet — surface recent history so the palette isn't empty
      entries = historyItemsFor('videos').slice(0, 4).concat(historyItemsFor('images').slice(0, 4)).map(item => ({ item }));
    } else {
      const titleMatches = [...state.videos, ...state.images, ...state.audio].filter(i => {
        if(i.name.toLowerCase().includes(query)) return true;
        if(i.type === 'audio' && ((i.title && i.title.toLowerCase().includes(query)) || (i.artist && i.artist.toLowerCase().includes(query)))) return true;
        return false;
      }).map(item => ({ item }));

      // Transcript matches — search generated/imported caption text for videos.
      // Kept as separate entries (rather than merged into title matches) so a
      // video can show up once for its filename and again for a spoken line.
      const transcriptMatches = [];
      state.videos.forEach(video => {
        const cues = state.transcripts.get(video.path);
        if(!cues || !cues.length) return;
        const hit = cues.find(c => c.text.toLowerCase().includes(query));
        if(hit) transcriptMatches.push({ item: video, cue: hit });
      });

      entries = [...titleMatches, ...transcriptMatches];
    }
    entries = entries.slice(0, 40);

    if(entries.length === 0){
      results.innerHTML = `<div class="gs-empty">No matches for "${escapeHtml(query)}"</div>`;
      return;
    }
    const typeLabel = { video: 'Video', image: 'Photo', audio: 'Music' };
    results.innerHTML = entries.map((entry, idx) => {
      const item = entry.item;
      const cue = entry.cue;
      const subText = cue
        ? `${formatDuration(cue.start)} — ${cue.text}`
        : (item.type === 'audio' ? trackArtist(item) : item.category);
      return `
      <div class="gs-row" data-idx="${idx}">
        <div class="gs-thumb" data-thumb-for="${idx}">
          ${item.type === 'image'
            ? `<img src="${ensureItemUrl(item)}" alt="">`
            : item.type === 'audio'
              ? coverArtHTML(item, 32)
              : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M3 6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z" stroke="currentColor" stroke-width="1.5"/><path d="m21 8 -4 3 4 3V8Z" fill="currentColor"/></svg>`}
        </div>
        <div class="gs-meta">
          <div class="gs-name">${escapeHtml(item.type === 'audio' ? trackTitle(item) : item.name)}</div>
          <div class="gs-sub">${escapeHtml(subText)}</div>
        </div>
        ${cue ? `<span class="gs-type gs-type-caption" title="Matched in captions">CC</span>` : ''}
        <span class="gs-type gs-type-${item.type}">${typeLabel[item.type]}</span>
      </div>
    `;
    }).join('');

    results.querySelectorAll('.gs-row').forEach(row => {
      row.addEventListener('click', () => goTo(entries[+row.dataset.idx]));
    });
    // fill in video thumbnails / track art lazily (images already show their own url above)
    entries.forEach((entry, idx) => {
      const item = entry.item;
      if(item.type === 'video'){
        ensureVideoMeta(item).then(() => {
          if(!item.thumb) return;
          const box = results.querySelector(`[data-thumb-for="${idx}"]`);
          if(box) box.innerHTML = `<img src="${item.thumb}" alt="">`;
        });
      } else if(item.type === 'audio'){
        ensureAudioMeta(item).then(() => {
          const box = results.querySelector(`[data-thumb-for="${idx}"]`);
          const nameEl = results.querySelector(`.gs-row[data-idx="${idx}"] .gs-name`);
          const subEl = results.querySelector(`.gs-row[data-idx="${idx}"] .gs-sub`);
          if(box) box.innerHTML = coverArtHTML(item, 32);
          if(nameEl) nameEl.textContent = trackTitle(item);
          if(subEl && !entry.cue) subEl.textContent = trackArtist(item);
        });
      }
    });
  }
}

function renderFoldersModalList(){
  const listEl = document.getElementById('foldersModalList');
  const { root, rootFileCount } = buildFolderTree();
  const topNodes = Object.values(root).sort((a,b) => a.name.localeCompare(b.name));

  let html = '';
  if(rootFileCount > 0){
    const checked = state.excluded.has(UNCATEGORIZED) ? '' : 'checked';
    html += `<div class="folder-row">
      <span class="folder-toggle-spacer"></span>
      <label class="folder-check">
        <input type="checkbox" ${checked} data-folder="${escapeAttr(UNCATEGORIZED)}">
        <span class="fr-name">${escapeHtml(UNCATEGORIZED)}</span>
        <span class="fr-count">${rootFileCount}</span>
      </label>
    </div>`;
  }
  topNodes.forEach(node => { html += folderRowHTML(node, 0); });

  listEl.innerHTML = html || '<div class="modal-empty">No folders to manage yet.</div>';
}
