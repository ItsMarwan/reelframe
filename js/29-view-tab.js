/* ==========================================================================
   View tab — a minimal in-app "browser": an address bar plus an iframe.
   Type a URL (or a search term) and it loads inline, same as the Photos
   or Music tabs sit inline in the app. Detecting a blocked page: we can't read a cross-origin iframe's content
   from here, so we lean on one reliable signal instead of guessing. When
   a site refuses to be framed (X-Frame-Options / CSP frame-ancestors),
   the browser cancels that navigation and the frame is left on its
   previous document — for a fresh load that's still "about:blank", which
   stays same-origin and readable from here. A real successful cross-site
   load makes the frame unreadable from here (cross-origin), which is
   exactly what "it worked" looks like. So: readable + stuck on blank
   means blocked; unreadable means it navigated away successfully.
   ========================================================================== */
const VIEW_LOAD_TIMEOUT_MS = 9000;
const VIEW_BLOCK_CHECK_DELAY_MS = 450;

/* Browsers deliberately prevent a page from telling "blocked by
   X-Frame-Options/CSP" apart from "loaded fine" via script — that's an
   intentional anti-fingerprinting measure on their end, not something we
   can reliably work around. So for the sites that are near-universally
   known to refuse framing, we just flag them instantly instead of
   waiting on a heuristic the browser is actively defeating. Everything
   else still falls through to the best-effort check further down. */
const VIEW_KNOWN_BLOCKED_HOSTS = [
  'youtube.com','youtu.be','google.com','accounts.google.com','mail.google.com','drive.google.com','docs.google.com','maps.google.com','photos.google.com','calendar.google.com','meet.google.com','play.google.com','facebook.com','fb.com','messenger.com','instagram.com','threads.net','twitter.com','x.com','reddit.com','github.com','gist.github.com','githubusercontent.com','gitlab.com','bitbucket.org','netflix.com','disneyplus.com','hulu.com','max.com','primevideo.com','paramountplus.com','peacocktv.com','crunchyroll.com','spotify.com','open.spotify.com','music.apple.com','deezer.com','tidal.com','soundcloud.com','twitch.tv','kick.com','tiktok.com','discord.com','discord.gg','discordapp.com','linkedin.com','pinterest.com','paypal.com','stripe.com','squareup.com','amazon.com','amazon.co.uk','amazon.de','amazon.co.jp','aws.amazon.com','apple.com','icloud.com','id.apple.com','microsoft.com','live.com','outlook.com','office.com','office365.com','login.microsoftonline.com','onedrive.live.com','teams.microsoft.com','xbox.com','yahoo.com','ebay.com','zoom.us','whatsapp.com','web.whatsapp.com','slack.com','notion.so','dropbox.com','figma.com','canva.com','trello.com','asana.com','clickup.com','linear.app','atlassian.com','jira.com','confluence.atlassian.com','cloudflare.com','dash.cloudflare.com','vercel.com','netlify.com','render.com','railway.app','fly.io','firebase.google.com','console.firebase.google.com','supabase.com','digitalocean.com','oracle.com','ibm.com','salesforce.com','adobe.com','openai.com','chatgpt.com','platform.openai.com','claude.ai','gemini.google.com','perplexity.ai','huggingface.co','steamcommunity.com','store.steampowered.com','steampowered.com','epicgames.com','roblox.com','riotgames.com','ea.com','ubisoft.com','battle.net','playstation.com','nintendo.com','mozilla.org','brave.com','opera.com','duckduckgo.com','proton.me','medium.com','quora.com','tumblr.com','vimeo.com','imgur.com','flickr.com','bbc.com','cnn.com','nytimes.com','washingtonpost.com','bloomberg.com','reuters.com','login.gov','gov.uk','irs.gov','bankofamerica.com','chase.com','wellsfargo.com','capitalone.com','discover.com','americanexpress.com','citibank.com','hsbc.com','barclays.co.uk','lloydsbank.com','natwest.com','revolut.com','wise.com'
];
function hostnameIsKnownBlocked(hostname){
  const h = (hostname || '').toLowerCase().replace(/^www\./, '');
  return VIEW_KNOWN_BLOCKED_HOSTS.some(d => h === d || h.endsWith(`.${d}`));
}

let viewState = {
  history: [],   // URLs the person has actually entered/navigated to
  index: -1,     // pointer into history
  loadTimer: null,
  checkTimer: null,
  currentUrl: '',
};
let viewLoadSeq = 0; // guards against a stale load/timeout resolving after a newer navigation started

function normalizeViewUrl(raw){
  const input = (raw || '').trim();
  if(!input) return null;
  if(/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return input; // already has a scheme
  if(!/\s/.test(input) && /\.[a-z]{2,}/i.test(input)) return `https://${input}`; // looks like a domain
  return `https://www.google.com/search?q=${encodeURIComponent(input)}`; // treat as a search
}

function setViewLoading(isLoading){
  const bar = document.getElementById('viewLoadingBar');
  if(bar) bar.hidden = !isLoading;
}
function showViewBlockedNotice(show, url){
  const notice = document.getElementById('viewBlockedNotice');
  const iframe = document.getElementById('viewIframe');
  const hostEl = document.getElementById('viewBlockedHost');
  if(notice) notice.hidden = !show;
  if(iframe) iframe.classList.toggle('is-blocked', show);
  if(hostEl){
    if(show && url){
      let label = url;
      try{ label = new URL(url).hostname.replace(/^www\./, ''); }catch(e){ /* keep raw url */ }
      hostEl.textContent = label;
    } else {
      hostEl.textContent = '';
    }
  }
}
function showViewEmptyState(show){
  const empty = document.getElementById('viewEmptyState');
  if(empty) empty.hidden = !show;
}
function updateViewNavButtons(){
  const backBtn = document.getElementById('viewBackBtn');
  const fwdBtn = document.getElementById('viewForwardBtn');
  if(backBtn) backBtn.disabled = viewState.index <= 0;
  if(fwdBtn) fwdBtn.disabled = viewState.index >= viewState.history.length - 1;
}
function clearViewTimers(){
  if(viewState.loadTimer){ clearTimeout(viewState.loadTimer); viewState.loadTimer = null; }
  if(viewState.checkTimer){ clearTimeout(viewState.checkTimer); viewState.checkTimer = null; }
}

function checkIframeBlocked(iframe){
  try{
    const win = iframe.contentWindow;
    const href = win && win.location ? win.location.href : null;
    return href === 'about:blank' || href === '';
  }catch(e){
    // Cross-origin access denied — the frame really did navigate away to
    // the target site, which is what a successful embed looks like.
    return false;
  }
}

/* Watches a navigation through to completion and always runs the blocked
   check exactly once — whether the iframe actually fires 'load' (which
   browsers don't reliably do for an X-Frame-Options/CSP-refused frame) or
   we simply time out waiting for it. `seq` guards against a slow, stale
   watcher from a previous navigation resolving after a newer one started. */
function attachViewLoadWatcher(iframe){
  const seq = ++viewLoadSeq;
  let settled = false;

  const finish = () => {
    if(settled || seq !== viewLoadSeq) return;
    settled = true;
    iframe.removeEventListener('load', onLoad);
    setViewLoading(false);
    viewState.checkTimer = setTimeout(() => {
      if(seq !== viewLoadSeq) return;
      if(checkIframeBlocked(iframe)) showViewBlockedNotice(true, viewState.currentUrl);
    }, VIEW_BLOCK_CHECK_DELAY_MS);
  };
  const onLoad = () => finish();

  iframe.addEventListener('load', onLoad);
  viewState.loadTimer = setTimeout(finish, VIEW_LOAD_TIMEOUT_MS);
}

function loadViewUrl(rawUrl, opts = {}){
  const url = normalizeViewUrl(rawUrl);
  if(!url) return;
  const iframe = document.getElementById('viewIframe');
  const input = document.getElementById('viewUrlInput');
  if(!iframe) return;

  clearViewTimers();
  showViewBlockedNotice(false);
  showViewEmptyState(false);
  setViewLoading(true);
  if(input) input.value = url;
  viewState.currentUrl = url;

  if(!opts.fromHistory){
    viewState.history = viewState.history.slice(0, viewState.index + 1);
    viewState.history.push(url);
    viewState.index = viewState.history.length - 1;
  }
  updateViewNavButtons();

  let hostname = '';
  try{ hostname = new URL(url).hostname; }catch(e){ /* fall through, let the iframe try anyway */ }

  if(hostname && hostnameIsKnownBlocked(hostname)){
    iframe.src = 'about:blank';
    setViewLoading(false);
    showViewBlockedNotice(true, url);
    return;
  }

  attachViewLoadWatcher(iframe);
  iframe.src = url;
}

function viewGoBack(){
  if(viewState.index <= 0) return;
  viewState.index -= 1;
  loadViewUrl(viewState.history[viewState.index], { fromHistory: true });
}
function viewGoForward(){
  if(viewState.index >= viewState.history.length - 1) return;
  viewState.index += 1;
  loadViewUrl(viewState.history[viewState.index], { fromHistory: true });
}
function viewReload(){
  const iframe = document.getElementById('viewIframe');
  if(!iframe || !viewState.currentUrl) return;
  clearViewTimers();
  showViewBlockedNotice(false);
  setViewLoading(true);
  const url = viewState.currentUrl;

  let hostname = '';
  try{ hostname = new URL(url).hostname; }catch(e){}
  if(hostname && hostnameIsKnownBlocked(hostname)){
    iframe.src = 'about:blank';
    setViewLoading(false);
    showViewBlockedNotice(true, url);
    return;
  }

  // Force an actual reload even when iframe.src already equals url.
  iframe.src = 'about:blank';
  requestAnimationFrame(() => {
    attachViewLoadWatcher(iframe);
    iframe.src = url;
  });
}

function bindViewTab(){
  const form = document.getElementById('viewUrlForm');
  const input = document.getElementById('viewUrlInput');
  const backBtn = document.getElementById('viewBackBtn');
  const fwdBtn = document.getElementById('viewForwardBtn');
  const reloadBtn = document.getElementById('viewReloadBtn');
  const newTabBtn = document.getElementById('viewOpenNewTabBtn');
  const noticeNewTabBtn = document.getElementById('viewOpenInNewTabFromNotice');
  if(!form || !input) return;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    loadViewUrl(input.value);
    input.blur();
  });
  if(backBtn) backBtn.addEventListener('click', viewGoBack);
  if(fwdBtn) fwdBtn.addEventListener('click', viewGoForward);
  if(reloadBtn) reloadBtn.addEventListener('click', viewReload);

  const openCurrentInNewTab = () => {
    if(viewState.currentUrl) window.open(viewState.currentUrl, '_blank', 'noopener');
  };
  if(newTabBtn) newTabBtn.addEventListener('click', openCurrentInNewTab);
  if(noticeNewTabBtn) noticeNewTabBtn.addEventListener('click', openCurrentInNewTab);

  updateViewNavButtons();
  showViewEmptyState(true);
}
