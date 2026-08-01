const CACHE_NAME = 'reelframe-shell-v8';
const SHELL_ASSETS = [
  './', './index.html', './css/style.css',
  './js/01-constants.js', './js/03-storage.js', './js/02-state.js',
  './js/04-helpers.js', './js/05-scan.js', './js/14-remote-import-and-actions.js',
  './js/06-gate-and-preview.js', './js/07-app-init.js', './js/08-mini-player.js',
  './js/09-shell-ui.js', './js/10-folders-modal.js', './js/11-settings-modal.js',
  './js/12-captions.js', './js/13-p2p-share.js', './js/15-global-search.js',
  './js/16-filter-sort.js', './js/17-for-you.js', './js/18-video-grid.js',
  './js/19-video-player.js', './js/20-watch-view.js', './js/21-image-grid.js',
  './js/22-music-id3.js', './js/23-music-library.js', './js/24-music-player-bar.js',
  './js/25-image-viewer-and-focus.js', './js/26-chapters.js', './js/27-watch-party.js',
  './js/28-keyboard-shortcuts.js', './js/29-view-tab.js', './js/30-pair-mode.js',
  './js/31-subtitles.js', './js/32-playlists.js', './js/33-audio-fx.js',
  './js/35-nsfw-scan.js', './js/36-nsfw-regions.js',
  './models/nsfw-mobilenet-v2/model.json', './models/nsfw-mobilenet-v2/group1-shard1of1',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(
      names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
    ))
  );
  self.clients.claim();
});

/* Cache-first for the app shell only. Local media, remote demo URLs, CDN
   scripts, and PeerJS signaling all pass straight through — this worker
   only ever exists to make the app itself launch instantly and work
   offline, never to touch anyone's actual media library. */
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if(url.origin !== self.location.origin) return;
  if(event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if(cached) return cached;
      return fetch(event.request).then((res) => {
        if(res && res.ok){
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return res;
      }).catch(() => cached);
    })
  );
});