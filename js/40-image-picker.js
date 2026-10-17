/* ==========================================================================
   Library picker — one picker for everything that needs "choose a photo
   (or video) from my library, or from this device".

     const picked = await openImagePicker({
       kind: 'image' | 'video',     // what to list (default 'image')
       multiple: false,             // pick several?
       title, subtitle,             // header text
       confirmLabel: n => '…',      // text of the confirm button
       excludePath: item.path,      // hide one item (e.g. the item itself)
       allowUpload: true,           // show "Upload from device"
     });
     // -> null if cancelled, else [{ blob, name, item|null }, …]

   Folder navigation mirrors the sidebar: a breadcrumb, then the folders that
   sit inside the current one. Opening a folder shows everything inside it.
   ========================================================================== */
let imagePickerOpen = false;

function openImagePicker(opts = {}){
  if(imagePickerOpen) return Promise.resolve(null);
  imagePickerOpen = true;

  const kind = opts.kind === 'video' ? 'video' : 'image';
  const multiple = !!opts.multiple;
  const allowUpload = opts.allowUpload !== false;
  const noun = kind === 'video' ? 'video' : 'photo';

  /* ---------- what can be picked ---------- */
  const pool = (kind === 'video' ? state.videos : [...state.images, ...state.snapshots])
    .filter(i => i && i.type === kind && (i.file || i.blob) && i.path !== opts.excludePath)
    .slice()
    .sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
  const tree = buildFolderTree(pool);

  /* ---------- state ---------- */
  let path = [];                       // current folder, as an array of names
  let query = '';
  let visible = [];                    // items in the current view
  let shown = 0;                       // how many tiles are in the DOM
  const selected = new Map();          // item.path -> item
  const visibleByPath = new Map();     // item.path -> item, for the current view
  const ownUrls = new Map();           // item.path -> object URL we made (revoked on close)
  const PAGE = 72;

  /* ---------- markup ---------- */
  const root = document.createElement('div');
  root.className = 'modal-backdrop rf-layer-picker';
  root.innerHTML = `
    <div class="modal rf-picker" role="dialog" aria-modal="true" aria-label="${escapeAttr(opts.title || 'Choose a ' + noun)}">
      <div class="modal-header">
        <div class="rf-picker-titles">
          <h2>${escapeHtml(opts.title || `Choose a ${noun}`)}</h2>
          ${opts.subtitle ? `<div class="rf-picker-sub">${escapeHtml(opts.subtitle)}</div>` : ''}
        </div>
        <button type="button" class="icon-btn" data-act="close" aria-label="Close">✕</button>
      </div>
      <div class="rf-picker-bar">
        <label class="rf-picker-search">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.8"/><path d="m21 21-4.3-4.3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
          <input type="search" class="input" placeholder="Search by name" autocomplete="off" spellcheck="false">
        </label>
        ${allowUpload ? `<button type="button" class="btn" data-act="upload"><svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M12 16V5m0 0L8 9m4-4 4 4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" stroke="currentColor" stroke-width="1.7"/></svg>Upload from device</button>
        <input type="file" hidden accept="${kind}/*" ${multiple ? 'multiple' : ''}>` : ''}
      </div>
      <nav class="rf-picker-crumbs" aria-label="Folder"></nav>
      <div class="rf-picker-folders"></div>
      <div class="rf-picker-scroll"><div class="rf-picker-grid"></div><div class="rf-picker-sentinel"></div></div>
      <div class="modal-footer rf-picker-foot">
        <span class="rf-picker-count"></span>
        <button type="button" class="btn" data-act="cancel">Cancel</button>
        <button type="button" class="btn btn-primary" data-act="confirm" disabled></button>
      </div>
    </div>`;
  document.body.appendChild(root);

  const $ = (sel) => root.querySelector(sel);
  const searchInput = $('.rf-picker-search input');
  const crumbsEl = $('.rf-picker-crumbs');
  const foldersEl = $('.rf-picker-folders');
  const scrollEl = $('.rf-picker-scroll');
  const gridEl = $('.rf-picker-grid');
  const sentinelEl = $('.rf-picker-sentinel');
  const countEl = $('.rf-picker-count');
  const confirmBtn = $('[data-act="confirm"]');
  const fileInput = $('input[type="file"]');
  const returnFocus = document.activeElement;
  const moreObserver = new IntersectionObserver((entries) => {
    if(entries.some(en => en.isIntersecting)) appendTiles();
  }, { root: scrollEl, rootMargin: '400px' });

  /* ---------- thumbnails (loaded only when scrolled near) ---------- */
  const thumbObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if(!entry.isIntersecting) return;
      const img = entry.target;
      thumbObserver.unobserve(img);
      const item = visibleByPath.get(img.dataset.p);
      if(item) loadThumb(img, item);
    });
  }, { root: scrollEl, rootMargin: '320px' });

  function thumbUrl(item){
    if(kind === 'video') return item.thumb || '';
    if(item.url) return item.url;
    if(item.file) return ensureItemUrl(item);
    if(item.blob){
      if(!ownUrls.has(item.path)) ownUrls.set(item.path, URL.createObjectURL(item.blob));
      return ownUrls.get(item.path);
    }
    return '';
  }
  function loadThumb(img, item){
    const url = thumbUrl(item);
    if(!url){ img.closest('.rf-thumb').classList.add('is-empty'); img.remove(); return; }
    img.onerror = () => { const t = img.closest('.rf-thumb'); if(t) t.classList.add('is-empty'); img.remove(); };
    img.onload = () => img.classList.add('is-ready');
    img.src = url;
  }

  /* ---------- rendering ---------- */
  function computeVisible(){
    const q = query.trim().toLowerCase();
    visible = pool.filter(i => (!path.length || itemIsInside(i, path)) && (!q || (i.name || '').toLowerCase().includes(q)));
    visibleByPath.clear();
    visible.forEach(i => visibleByPath.set(i.path, i));
  }

  function renderCrumbs(){
    const parts = [{ label: kind === 'video' ? 'All videos' : 'All photos', to: [] }];
    path.forEach((name, i) => parts.push({ label: name, to: path.slice(0, i + 1) }));
    crumbsEl.innerHTML = parts.map((p, i) => {
      const last = i === parts.length - 1;
      return `${i ? '<span class="rf-crumb-sep">›</span>' : ''}<button type="button" class="rf-crumb ${last ? 'is-current' : ''}" data-to="${escapeAttr(p.to.join('/'))}" ${last ? 'aria-current="page"' : ''}>${escapeHtml(p.label)}</button>`;
    }).join('');
    crumbsEl.querySelectorAll('.rf-crumb').forEach(btn => btn.addEventListener('click', () => {
      const to = btn.getAttribute('data-to');
      setPath(to ? to.split('/') : []);
    }));
  }

  function renderFolders(){
    const node = findFolderNode(tree, path);
    const kids = node ? sortedChildren(node) : [];
    foldersEl.hidden = kids.length === 0;
    foldersEl.innerHTML = kids.map(k => `
      <button type="button" class="rf-folder" data-key="${escapeAttr(k.key)}">
        ${SUBFOLDER_SVG}<span>${escapeHtml(k.name)}</span><em>${k.count}</em>
      </button>`).join('');
    foldersEl.querySelectorAll('.rf-folder').forEach(btn => btn.addEventListener('click', () => setPath(btn.getAttribute('data-key').split('/'))));
  }

  function tileHTML(item){
    const isSel = selected.has(item.path);
    const placeholder = kind === 'video'
      ? '<svg class="rf-thumb-ph" width="26" height="26" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="m10 9.5 5 2.5-5 2.5v-5Z" fill="currentColor"/></svg>'
      : '';
    return `<button type="button" class="rf-tile ${isSel ? 'is-selected' : ''}" data-p="${escapeAttr(item.path)}" title="${escapeAttr(item.name || '')}" aria-pressed="${isSel}">
      <span class="rf-thumb ${kind === 'video' ? 'is-video' : ''}">${placeholder}<img alt="" decoding="async" data-p="${escapeAttr(item.path)}"></span>
      <span class="rf-tile-name">${escapeHtml(item.name || '')}</span>
      <span class="rf-tile-check" aria-hidden="true">✓</span>
    </button>`;
  }

  function appendTiles(){
    if(shown >= visible.length) return;
    const slice = visible.slice(shown, shown + PAGE);
    shown += slice.length;
    const frag = document.createElement('div');
    frag.innerHTML = slice.map(tileHTML).join('');
    while(frag.firstChild){
      const tile = frag.firstChild;
      gridEl.appendChild(tile);
      const img = tile.querySelector('img');
      if(img) thumbObserver.observe(img);
    }
  }

  function renderGrid(){
    thumbObserver.disconnect();
    gridEl.innerHTML = '';
    shown = 0;
    computeVisible();
    if(!visible.length){
      gridEl.innerHTML = `<div class="rf-picker-empty">${
        pool.length === 0
          ? `No ${noun}s in your library yet.${allowUpload ? ' You can still upload one from this device.' : ''}`
          : (query.trim() ? `Nothing named “${escapeHtml(query.trim())}” in here.` : `No ${noun}s in this folder.`)
      }</div>`;
    } else {
      appendTiles();
    }
    scrollEl.scrollTop = 0;
    updateFooter();
  }

  function setPath(next){
    path = next;
    renderCrumbs();
    renderFolders();
    renderGrid();
  }

  function updateFooter(){
    const n = selected.size;
    const total = visible.length;
    countEl.textContent = n
      ? `${n} selected`
      : `${total} ${noun}${total === 1 ? '' : 's'}`;
    confirmBtn.disabled = n === 0;
    confirmBtn.textContent = typeof opts.confirmLabel === 'function'
      ? opts.confirmLabel(n)
      : (multiple ? (n > 1 ? `Add ${n}` : 'Add') : `Use this ${noun}`);
  }

  /* ---------- selection ---------- */
  function toggleItem(tile){
    const item = visibleByPath.get(tile.dataset.p);
    if(!item) return;
    if(selected.has(item.path)){
      selected.delete(item.path);
    } else {
      if(!multiple){
        selected.clear();
        gridEl.querySelectorAll('.rf-tile.is-selected').forEach(t => { t.classList.remove('is-selected'); t.setAttribute('aria-pressed', 'false'); });
      }
      selected.set(item.path, item);
    }
    const on = selected.has(item.path);
    tile.classList.toggle('is-selected', on);
    tile.setAttribute('aria-pressed', String(on));
    updateFooter();
  }

  /* ---------- finishing ---------- */
  let done = false;
  let resolveFn = null;
  function finish(result){
    if(done) return;
    done = true;
    document.removeEventListener('keydown', onKey, true);
    thumbObserver.disconnect();
    moreObserver.disconnect();
    ownUrls.forEach(u => URL.revokeObjectURL(u));
    ownUrls.clear();
    root.remove();
    imagePickerOpen = false;
    try{ if(returnFocus && returnFocus.focus) returnFocus.focus(); }catch(e){}
    resolveFn(result);
  }
  function pickedFromSelection(){
    return [...selected.values()].map(item => ({ blob: item.file || item.blob, name: item.name || '', item }));
  }
  function confirm(){
    if(!selected.size) return;
    finish(pickedFromSelection());
  }

  function onKey(e){
    if(e.key === 'Escape'){
      e.preventDefault();
      e.stopImmediatePropagation();
      finish(null);
    }
  }

  /* ---------- events ---------- */
  root.addEventListener('click', (e) => {
    if(e.target === root){ finish(null); return; }
    const act = e.target.closest('[data-act]');
    if(act){
      const a = act.getAttribute('data-act');
      if(a === 'close' || a === 'cancel') finish(null);
      else if(a === 'confirm') confirm();
      else if(a === 'upload' && fileInput){ fileInput.value = ''; fileInput.click(); }
      return;
    }
    const tile = e.target.closest('.rf-tile');
    if(tile) toggleItem(tile);
  });
  gridEl.addEventListener('dblclick', (e) => {
    if(multiple) return;
    const tile = e.target.closest('.rf-tile');
    if(!tile) return;
    if(!selected.has(tile.dataset.p)) toggleItem(tile);
    confirm();
  });
  let searchTimer = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { query = searchInput.value; renderGrid(); }, 140);
  });
  if(fileInput){
    fileInput.addEventListener('change', () => {
      const files = [...(fileInput.files || [])].filter(f => !f.type || f.type.startsWith(kind + '/'));
      fileInput.value = '';
      if(!files.length){ toast(`Pick ${kind === 'video' ? 'a video' : 'an image'} file.`); return; }
      // Uploads are used straight away, together with anything already ticked.
      const uploaded = (multiple ? files : files.slice(0, 1)).map(f => ({ blob: f, name: f.name, item: null }));
      finish(multiple ? [...pickedFromSelection(), ...uploaded] : uploaded);
    });
  }
  moreObserver.observe(sentinelEl);
  document.addEventListener('keydown', onKey, true);

  /* ---------- go ---------- */
  setPath([]);
  const dialog = $('.rf-picker');
  dialog.setAttribute('tabindex', '-1');
  dialog.focus({ preventScroll: true });
  return new Promise(resolve => { resolveFn = resolve; });
}
