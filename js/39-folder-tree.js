/* ==========================================================================
   Folder tree — shared by the sidebar (collapsible subfolders) and the image
   picker (folder navigation).

   An item lives at  item.folderPath = ['Category', 'Sub', 'Sub-sub']  (the
   scan fills this in; the first part is also item.category). Files that sit
   directly in the chosen root have no folders, so they fall back to their
   category name (Uncategorized / Snapshots) as a one-level path.
   ========================================================================== */

/* Where in the folder tree an item sits, as an array of folder names. */
function itemFolderParts(item){
  if(item && Array.isArray(item.folderPath) && item.folderPath.length) return item.folderPath;
  return [(item && item.category) || UNCATEGORIZED];
}

/* Builds a tree out of a list of items. Every node carries the number of
   items *anywhere inside it* (descendants included), so the counts you see
   match what you get when you open the folder.
   node = { name, parts: [...], key: 'A/B', count, children: Map<name,node> } */
function buildFolderTree(items){
  const root = { name: '', parts: [], key: '', count: 0, children: new Map() };
  for(const item of items){
    const parts = itemFolderParts(item);
    let node = root;
    root.count++;
    for(let i = 0; i < parts.length; i++){
      let next = node.children.get(parts[i]);
      if(!next){
        const sliced = parts.slice(0, i + 1);
        next = { name: parts[i], parts: sliced, key: sliced.join('/'), count: 0, children: new Map() };
        node.children.set(parts[i], next);
      }
      next.count++;
      node = next;
    }
  }
  return root;
}

function sortedChildren(node){
  return [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

function findFolderNode(root, parts){
  let node = root;
  for(const p of parts){
    node = node.children.get(p);
    if(!node) return null;
  }
  return node;
}

/* True when `item` is inside the folder described by `parts` (or is in it directly). */
function itemIsInside(item, parts){
  const own = itemFolderParts(item);
  if(own.length < parts.length) return false;
  for(let i = 0; i < parts.length; i++) if(own[i] !== parts[i]) return false;
  return true;
}

/* ---------- subfolder selection (sidebar) ----------
   state.subcat[tab] = { cat, key }. It only counts while state.cat[tab] is
   still that same category, so every place that changes the category
   (sidebar, links, special lists…) clears it for free. */
if(!state.subcat) state.subcat = { videos: null, images: null, music: null };

/* The subfolder key ('Cat/Sub') currently filtering this tab, or null. */
function activeSubfolder(tab){
  const sel = state.subcat && state.subcat[tab];
  if(!sel || !sel.key) return null;
  if(!state.cat[tab] || state.cat[tab] !== sel.cat){
    // The category changed some other way (a special list, a link…): forget the subfolder.
    state.subcat[tab] = null;
    return null;
  }
  return sel.key;
}

function subfolderMatches(item, key){
  return itemIsInside(item, key.split('/'));
}

/* "Cat / Sub / Deeper" for headings. */
function subfolderLabel(key){
  return key.split('/').join(' / ');
}

/* ---------- which folders are expanded in the sidebar (remembered) ---------- */
const CAT_EXPANDED_KEY = 'reelframe-cat-expanded-v1';
const catExpanded = (() => {
  try{
    const raw = JSON.parse(localStorage.getItem(CAT_EXPANDED_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw : []);
  }catch(e){ return new Set(); }
})();
function saveCatExpanded(){
  try{ localStorage.setItem(CAT_EXPANDED_KEY, JSON.stringify([...catExpanded])); }catch(e){}
}
const expandKey = (tab, key) => `${tab}|${key}`;

/* ---------- sidebar markup for one category's subfolders ---------- */
const CHEVRON_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="m9 6 6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const SUBFOLDER_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" stroke="currentColor" stroke-width="1.6"/></svg>';

function renderSubfolderList(tab, node, activeKey){
  const kids = sortedChildren(node);
  if(!kids.length) return '';
  return `<ul class="sub-list">` + kids.map(kid => {
    const hasKids = kid.children.size > 0;
    const open = hasKids && catExpanded.has(expandKey(tab, kid.key));
    return `<li class="sub-node ${open ? 'is-open' : ''}">
      <div class="cat-row sub-row">
        ${hasKids
          ? `<button type="button" class="cat-twist" data-twist="${escapeAttr(kid.key)}" aria-expanded="${open}" aria-label="${open ? 'Collapse' : 'Expand'} ${escapeAttr(kid.name)}">${CHEVRON_SVG}</button>`
          : `<span class="cat-twist-spacer"></span>`}
        <button type="button" class="cat-item sub-item ${activeKey === kid.key ? 'active' : ''}" data-cat="${escapeAttr(kid.parts[0])}" data-sub="${escapeAttr(kid.key)}" title="${escapeAttr(kid.key)}">
          ${SUBFOLDER_SVG}
          <span>${escapeHtml(kid.name)}</span> <span class="cat-count">${kid.count}</span>
        </button>
      </div>
      ${hasKids ? renderSubfolderList(tab, kid, activeKey) : ''}
    </li>`;
  }).join('') + `</ul>`;
}

/* Called from renderSidebar once per render: makes sure the chosen subfolder
   still exists (e.g. the folder got excluded). Returns its key, or null. */
function reconcileSubfolderSelection(tab, tree){
  const key = activeSubfolder(tab);
  if(!key) return null;
  const node = findFolderNode(tree, key.split('/'));
  if(!node){ state.subcat[tab] = null; return null; }
  return key;
}

/* Picking a subfolder opens every folder above it so it stays visible. */
function expandAncestorsOf(tab, key){
  const parts = key.split('/');
  for(let i = 1; i < parts.length; i++) catExpanded.add(expandKey(tab, parts.slice(0, i).join('/')));
  saveCatExpanded();
}
