/* ==========================================================================
   Manage folders (exclude folders / subfolders — saved per root folder)
   ========================================================================== */
const expandedFolders = new Set();

function buildFolderTree(){
  const root = {};   // name -> node
  let rootFileCount = 0;

  [...state.rawVideos, ...state.rawImages, ...state.rawAudio].forEach(item => {
    if(item.folderPath.length === 0){ rootFileCount++; return; }
    let level = root;
    const prefix = [];
    item.folderPath.forEach(seg => {
      prefix.push(seg);
      const path = prefix.join('/');
      if(!level[seg]) level[seg] = { name: seg, path, children: {}, count: 0 };
      level[seg].count++;
      level = level[seg].children;
    });
  });

  return { root, rootFileCount };
}

function folderRowHTML(node, depth){
  const hasChildren = Object.keys(node.children).length > 0;
  const checked = state.excluded.has(node.path) ? '' : 'checked';
  const expanded = expandedFolders.has(node.path);

  let html = `<div class="folder-row" style="padding-left:${depth * 18}px">`;
  html += hasChildren
    ? `<button type="button" class="folder-toggle ${expanded ? 'expanded' : ''}" data-toggle="${escapeAttr(node.path)}" aria-label="Expand ${escapeAttr(node.name)}">
         <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
       </button>`
    : `<span class="folder-toggle-spacer"></span>`;
  html += `
    <label class="folder-check">
      <input type="checkbox" ${checked} data-folder="${escapeAttr(node.path)}">
      <span class="fr-name">${escapeHtml(node.name)}</span>
      <span class="fr-count">${node.count}</span>
    </label>
  </div>`;

  if(hasChildren){
    const kids = Object.values(node.children).sort((a,b) => a.name.localeCompare(b.name));
    html += `<div class="folder-children" data-children-of="${escapeAttr(node.path)}" ${expanded ? '' : 'hidden'}>`;
    kids.forEach(child => { html += folderRowHTML(child, depth + 1); });
    html += `</div>`;
  }
  return html;
}

function bindFoldersModal(){
  const backdrop = document.getElementById('foldersModalBackdrop');
  const openBtn = document.getElementById('manageFoldersBtn');
  const closeBtn = document.getElementById('foldersModalClose');
  const listEl = document.getElementById('foldersModalList');

  openBtn.addEventListener('click', () => {
    renderFoldersModalList();
    backdrop.hidden = false;
  });
  closeBtn.addEventListener('click', () => { backdrop.hidden = true; });
  backdrop.addEventListener('click', (e) => { if(e.target === backdrop) backdrop.hidden = true; });

  // expand/collapse — delegated so it survives re-renders
  listEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.folder-toggle');
    if(!btn) return;
    const path = btn.getAttribute('data-toggle');
    const childrenEl = [...listEl.querySelectorAll('.folder-children')].find(el => el.dataset.childrenOf === path);
    if(!childrenEl) return;
    const willShow = childrenEl.hidden;
    childrenEl.hidden = !willShow;
    btn.classList.toggle('expanded', willShow);
    if(willShow) expandedFolders.add(path); else expandedFolders.delete(path);
  });

  // include/exclude a folder (and, implicitly, everything under it)
  listEl.addEventListener('change', (e) => {
    const cb = e.target;
    if(cb.tagName !== 'INPUT' || cb.type !== 'checkbox') return;
    const path = cb.getAttribute('data-folder');
    if(cb.checked) state.excluded.delete(path);
    else state.excluded.add(path);
    saveExcluded();
    applyExclusions();
    updateTotalCount();
    renderSidebar();
    goToGrid(state.tab);
    renderFoldersModalList();
  });
}

