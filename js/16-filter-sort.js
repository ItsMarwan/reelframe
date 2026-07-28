/* ==========================================================================
   Filtering + sorting
   ========================================================================== */
function getFiltered(tab){
  const cat = state.cat[tab];
  let list;
  if(tab === 'images' && cat === '__snapshots__'){
    list = state.snapshots;
  } else if(tab === 'videos' && cat === '__watchlater__'){
    list = state.videos.filter(v => state.watchLater.has(favKey(v)));
  } else if(tab === 'videos' && cat === '__captioned__'){
    list = state.videos.filter(v => state.captionedPaths && state.captionedPaths.has(v.path));
  } else {
    list = itemsForTab(tab);
  }
  if(cat === '__fav__') list = list.filter(isFav);
  else if(cat === '__history__') list = historyItemsFor(tab);
  else if(cat && cat !== '__snapshots__' && cat !== '__watchlater__' && cat !== '__captioned__') list = list.filter(i => i.category === cat);
  if(state.filters[tab].category && state.filters[tab].category !== 'all'){
    list = list.filter(i => i.category === state.filters[tab].category);
  }
  if(state.filters[tab].date && state.filters[tab].date !== 'all'){
    const cutoff = Date.now() - (Number(state.filters[tab].date) * 86400000);
    list = list.filter(i => (i.lastModified || 0) >= cutoff);
  }
  if(state.search){
    list = list.filter(i => i.name.toLowerCase().includes(state.search));
  }
  if(cat === '__snapshots__' && state.sort[tab] === 'random') return list;
  if(cat === '__history__' && (tab === 'music' || state.sort[tab] === 'random')) return list;
  return applySort(list.slice(), state.sort[tab]);
}
function historyItemsFor(tab){
  const wantType = tab === 'videos' ? 'video' : tab === 'images' ? 'image' : 'audio';
  const pool = tab === 'images' ? [...itemsForTab(tab), ...state.snapshots] : itemsForTab(tab);
  const byPath = new Map(pool.map(i => [i.path, i]));
  const seen = new Set();
  const out = [];
  state.history.forEach(h => {
    if(h.type !== wantType || seen.has(h.path)) return;
    const item = byPath.get(h.path);
    if(item){ out.push({ ...item, _historyTs: h.ts || 0 }); seen.add(h.path); }
  });
  return out;
}
function applySort(list, mode){
  switch(mode){
    case 'new': return list.sort((a,b) => (b._historyTs ?? b.lastModified ?? 0) - (a._historyTs ?? a.lastModified ?? 0));
    case 'old': return list.sort((a,b) => (a._historyTs ?? a.lastModified ?? 0) - (b._historyTs ?? b.lastModified ?? 0));
    case 'az':  return list.sort((a,b) => a.name.localeCompare(b.name));
    case 'za':  return list.sort((a,b) => b.name.localeCompare(a.name));
    case 'random':
    default:    return list.sort((a,b) => a._rand - b._rand);
  }
}