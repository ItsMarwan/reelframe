/* ==========================================================================
   Helpers
   ========================================================================== */
async function copyTextToClipboard(text){
  if(!text) return false;
  try{
    if(navigator.clipboard && window.isSecureContext){
      await navigator.clipboard.writeText(text);
      return true;
    }
  }catch(e){ /* fall through to legacy path */ }
  try{
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }catch(e){
    return false;
  }
}
function extOf(name){
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i+1).toLowerCase();
}
function formatBytes(b){
  if(b < 1024) return b + ' B';
  const units = ['KB','MB','GB','TB'];
  let u = -1;
  do{ b /= 1024; u++; }while(b >= 1024 && u < units.length-1);
  return b.toFixed(1) + ' ' + units[u];
}
function formatDate(ms){
  return new Date(ms).toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' });
}
function formatDuration(sec){
  if(!isFinite(sec) || sec < 0) return '';
  sec = Math.round(sec);
  const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = sec%60;
  const mm = h ? String(m).padStart(2,'0') : m;
  const ss = String(s).padStart(2,'0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
function shuffleKeys(list){
  list.forEach(it => it._rand = Math.random());
}
/* Fisher-Yates, in place — used anywhere suggestions need to look fresh
   (rather than deriving order from the fixed per-item _rand above). */
function shuffleArray(list){
  for(let i = list.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}
/* Big animated loading screen shown while a chosen folder is scanned. */
function showLoadingScreen(msg){
  const el = document.getElementById('loadingScreen');
  document.getElementById('loadingSub').textContent = msg || 'Reading your library';
  const fillEl = document.getElementById('loadingProgressFill');
  if(fillEl) fillEl.style.width = '0%';
  el.hidden = false;
  el._shownAt = Date.now();
}
async function hideLoadingScreen(){
  const el = document.getElementById('loadingScreen');
  const MIN_MS = 550; // avoid an instant flash on very fast/small folders
  const elapsed = Date.now() - (el._shownAt || 0);
  if(elapsed < MIN_MS) await new Promise(r => setTimeout(r, MIN_MS - elapsed));
  el.hidden = true;
}

/* Drives the loading screen's progress bar + status line from real scan
   progress (see scanDirectory's onProgress in 05-scan.js) instead of a
   bar that just sits there doing nothing. */
function updateLoadingProgress(info){
  const subEl = document.getElementById('loadingSub');
  const fillEl = document.getElementById('loadingProgressFill');
  if(!subEl || !fillEl || !info) return;

  if(info.phase === 'counting'){
    fillEl.style.width = '0%';
    subEl.textContent = 'Scanning folder structure…';
    return;
  }

  const { processed, total, name } = info;
  const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  fillEl.style.width = pct + '%';

  if(total === 0){
    subEl.textContent = 'No matching files found yet…';
  } else if(name){
    subEl.textContent = `Reading “${name}” — ${processed} of ${total}`;
  } else {
    subEl.textContent = `Found ${total} file${total === 1 ? '' : 's'} — starting…`;
  }
}
function toast(msg){
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2400);
}
function heartSVG(filled){
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="${HEART_PATH}" stroke="currentColor" stroke-width="1.8" ${filled ? 'fill="currentColor"' : ''}/></svg>`;
}
function watchLaterSVG(active){
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 4.5a7.5 7.5 0 1 0 7.5 7.5A7.5 7.5 0 0 0 12 4.5Z" stroke="currentColor" stroke-width="1.7" ${active ? 'fill="currentColor"' : ''}/><path d="M12 8v4l2.5 1.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" ${active ? '' : 'stroke="currentColor"'}/></svg>`;
}

function ensureItemUrl(item){
  if(item.url) return item.url;
  if(!item.file) return '';
  item.url = URL.createObjectURL(item.file);
  return item.url;
}

function watchedProgressHTML(item){
  const p = getWatchProgress(item);
  if(!p || !p.percent || p.percent <= 0) return '';
  return `<div class="vcard-watched-bar"><div class="vcard-watched-fill" style="width:${Math.min(100, Math.round(p.percent*100))}%"></div></div>`;
}