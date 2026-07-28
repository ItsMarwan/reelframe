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

/* ==========================================================================
   Deep-link parsing + persistent pair code — kept dependency-free so it
   can run at the very top of boot, before PeerJS/pairing code has loaded.
   ========================================================================== */
const PAIR_CUSTOM_CODE_KEY = 'reelframe-pair-custom-code-v1';
function loadCustomPairCode(){
  try{ return (localStorage.getItem(PAIR_CUSTOM_CODE_KEY) || '').trim().toUpperCase(); }
  catch(e){ return ''; }
}
function saveCustomPairCode(code){
  try{ localStorage.setItem(PAIR_CUSTOM_CODE_KEY, (code || '').trim().toUpperCase()); }
  catch(e){ /* ignore */ }
}

const DEEP_LINK_IGNORE_RE = /^(css\/|js\/|images\/|favicon\.svg$|manifest\.json$|sw\.js$|robots\.xml$|sitemap\.xml$|license\.md$|readme\.md$|index\.html$|404\.html$)/i;

/* Parses a URL path like "/CODE/Folder/Sub/file.mp4" or "/CODE/file.jpg.image"
   into { code, targetPath, imageOnly }. targetPath matches the item.path
   format used everywhere else in the app (folder segments joined with "/",
   no leading slash). Returns null if the path doesn't look like a deep link
   at all (e.g. it's the site root, or one of the app's real static files). */
function parseDeepLinkPath(){
  const params = new URLSearchParams(location.search);
  const code = (params.get('code') || params.get('share') || '').trim();
  const rawPath = (params.get('path') || params.get('item') || '').trim();
  const imageOnly = ['1','true','yes','on'].includes((params.get('image') || '').toLowerCase());

  if(code && rawPath){
    const targetPath = rawPath.replace(/^\/+/, '').replace(/\/+$/, '');
    if(targetPath) return { code, targetPath, imageOnly };
  }

  let path = decodeURIComponent(location.pathname);
  path = path.replace(/^\/+/, '').replace(/\/+$/, '');
  if(!path) return null;
  if(DEEP_LINK_IGNORE_RE.test(path)) return null;

  const segments = path.split('/').filter(Boolean);
  if(segments.length < 2) return null; // need at least CODE/file

  const legacyCode = segments[0];
  let last = segments[segments.length - 1];
  let legacyImageOnly = false;
  if(/\.image$/i.test(last)){
    legacyImageOnly = true;
    last = last.slice(0, -'.image'.length);
  }
  if(!last) return null;

  const targetPath = [...segments.slice(1, -1), last].join('/');
  return { code: legacyCode, targetPath, imageOnly: legacyImageOnly };
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

/* Same idea as ensureItemUrl, but for an item whose bytes live on a
   paired device: there's nothing to hand back synchronously, so this
   actually goes and fetches them (once — cached on item.url after,
   same as a normal local item) instead of permanently returning ''. */
async function ensureItemUrlAsync(item){
  if(item.url) return item.url;
  if(item.file){ item.url = URL.createObjectURL(item.file); return item.url; }
  if(item.pairRemote){
    const blob = await requestPairFile(item.pairPath);
    item.file = blob;
    item.url = URL.createObjectURL(blob);
    return item.url;
  }
  return '';
}

function watchedProgressHTML(item){
  const p = getWatchProgress(item);
  if(!p || !p.percent || p.percent <= 0) return '';
  return `<div class="vcard-watched-bar"><div class="vcard-watched-fill" style="width:${Math.min(100, Math.round(p.percent*100))}%"></div></div>`;
}

/* ==========================================================================
   Stalled-thumbnail watcher — a thumbnail can fail to arrive for reasons
   that are worth quietly retrying rather than leaving the card stuck
   forever: a paired-device request that got dropped, a video that
   happened to be busy decoding elsewhere, a brief connection hiccup, etc.
   Every few seconds this rechecks any card still missing a thumbnail and,
   if — and only if — that card is actually visible on screen right now,
   asks for it again. Off-screen cards are left alone entirely, so this
   never burns bandwidth (particularly over a paired connection) on
   something nobody's looking at.
   ========================================================================== */
const THUMB_RETRY_INTERVAL_MS = 4000;
let thumbRetryTimer = null;

function isElementVisibleOnScreen(el){
  if(!el || !el.isConnected) return false;
  const rect = el.getBoundingClientRect();
  if(rect.width <= 0 && rect.height <= 0) return false; // hidden ancestor (e.g. [hidden] view) collapses to 0x0
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const vw = window.innerWidth || document.documentElement.clientWidth;
  return rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;
}

function retryVisibleStalledThumbs(){
  if(document.hidden) return; // tab isn't even being looked at — nothing to do
  document.querySelectorAll('.vcard, .pin-item').forEach(el => {
    const item = el._rfItem;
    if(!item) return;
    if(!isElementVisibleOnScreen(el)) return;

    if(item.type === 'video'){
      if(item.thumb || item.broken || item._metaPromise) return; // already have it, never will, or already trying
      if(typeof loadCardThumb === 'function') loadCardThumb(el, item);
    } else if(item.type === 'image' && item.pairRemote){
      if(item.thumb) return;
      if(typeof pairThumbWaiters !== 'undefined' && pairThumbWaiters.has(item.pairPath)) return; // already waiting on a response
      const img = el.querySelector('img');
      if(typeof registerPairThumbWaiter !== 'function' || typeof requestPairThumb !== 'function') return;
      registerPairThumbWaiter(item.pairPath, (thumb) => {
        item.thumb = thumb;
        if(img) img.src = thumb;
      });
      requestPairThumb(item.pairPath);
    }
  });
}

function startThumbRetryWatcher(){
  if(thumbRetryTimer) return;
  thumbRetryTimer = setInterval(retryVisibleStalledThumbs, THUMB_RETRY_INTERVAL_MS);
}
