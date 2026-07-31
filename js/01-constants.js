'use strict';

/* ==========================================================================
   Constants
   ========================================================================== */
const VIDEO_EXT = ['mp4','webm','ogv','mov','m4v','mkv','avi'];
const IMAGE_EXT = ['jpg','jpeg','png','gif','webp','svg','bmp','avif'];
const AUDIO_EXT = ['mp3','wav','m4a','flac','ogg','aac','wma','opus'];
const UNCATEGORIZED = 'Uncategorized';
const FAVORITES_KEY = 'reelframe-favorites-v1';
const WATCH_LATER_KEY = 'reelframe-watch-later-v1';
const WATCH_LATER_CONSUMED_KEY = 'reelframe-watch-later-consumed-v1';
const HISTORY_KEY = 'reelframe-history-v1';
const ALGO_KEY = 'reelframe-algo-enabled-v1';
const HISTORY_MAX = 400;
const FOR_YOU_COUNT = 14;
const IDB_NAME = 'reelframe';
const IDB_VERSION = 2;
const IDB_STORE = 'handles';
const SIDEBAR_COLLAPSE_KEY = 'reelframe-side-collapsed-v1';
const FOOTER_COLLAPSE_KEY = 'reelframe-footer-collapsed-v1';
const VIDEO_PAGE_SIZE = 24;
const IMAGE_PAGE_SIZE = 40;
const UP_NEXT_FORYOU_COUNT = 2;
const AUTOPLAY_KEY = 'reelframe-autoplay-v1';
const PLAYER_VOLUME_KEY = 'reelframe-player-volume-v1';
const PLAYER_MUTED_KEY = 'reelframe-player-muted-v1';
const CATEGORY_FAVORITES_KEY = 'reelframe-category-favorites-v1';
const SNAPSHOTS_STORE = 'snapshots';
const WATCH_PROGRESS_KEY = 'reelframe-watch-progress-v1';
const DISCOVER_KEY = 'reelframe-discover-enabled-v1';
const REAL_MINI_PLAYER_KEY = 'reelframe-real-mini-player-v1';
const LOCK_ENABLED_KEY = 'reelframe-lock-enabled-v1';
const LOCK_PASSWORD_KEY = 'reelframe-lock-password-v1';
const SHARE_AUTO_APPROVE_KEY = 'reelframe-share-auto-approve-v1';
const FAVORITE_TIMESTAMPS_KEY = 'reelframe-favorite-timestamps-v1';

/* New in this pass */
const LOCK_TIMEOUT_KEY = 'reelframe-lock-timeout-min-v1';       // auto-lock after N minutes idle (0 = disabled)
const LOCK_BLUR_DELAY_KEY = 'reelframe-lock-blur-delay-sec-v1'; // grace period after losing window focus (0 = instant)
const CHAPTERS_KEY = 'reelframe-chapters-v1';
const FOR_YOU_RECENT_KEY = 'reelframe-foryou-recent-v1';

const HEART_PATH = 'M12 21s-7.5-4.7-10-9.3C.4 8 2.3 4.5 6 4c2.2-.3 4 .9 6 3.2C14 4.9 15.8 3.7 18 4c3.7.5 5.6 4 4 7.7C19.5 16.3 12 21 12 21Z';
const LEGAL_DOCS = {
  tos: `
    <p class="legal-kicker">Last updated: July 24, 2026</p>
    <h1>Terms of Service</h1>
    <p>Reelframe is a local-first media browser designed to help you view videos, photos, and music that already exist on your device. This app does not upload your files to a server, and it does not require an account.</p>
    <h2>1. Local library access</h2>
    <p>When you choose a folder, your browser opens that folder through the Filesystem Access API and lets Reelframe read it locally. You remain in control of which folders are selected and which are excluded from the library.</p>
    <h2>2. Your content, your responsibility</h2>
    <p>You are responsible for making sure you have the right to view, organize, and play the media files in the folder you select. Reelframe does not claim ownership over the files on your machine.</p>
    <h2>3. No warranties</h2>
    <p>Reelframe is provided as-is. We do not guarantee that it will be uninterrupted, error-free, or suitable for every device or browser environment. Performance may vary depending on your machine, file size, and browser.</p>
    <h2>4. Browser and device limits</h2>
    <p>Because Reelframe runs in the browser, things like local permissions, browser cache, storage limits, and media support can affect playback or loading behavior. The app works best in Chromium-based browsers such as Chrome or Edge.</p>
    <h2>5. Changes</h2>
    <p>We may update the app or these terms at any time. Continued use after changes implies acceptance of the updated terms.</p>
  `,
  privacy: `
    <p class="legal-kicker">Last updated: July 24, 2026</p>
    <h1>Privacy Policy</h1>
    <p>Reelframe is designed to keep your media library private. The app reads media files directly from the folder you choose, and it does not send those files to an external service.</p>
    <h2>1. What stays on your device</h2>
    <p>Files, folders, thumbnails, history, favorites, and browser preferences are handled locally in your browser. Your chosen library is not uploaded anywhere.</p>
    <h2>2. Local storage we use</h2>
    <p>Reelframe may use local browser storage such as <code>localStorage</code> and <code>IndexedDB</code> to remember your favorites, watch history, folder exclusions, and the last selected folder. This information stays in your browser profile on your machine.</p>
    <h2>3. What we do not collect</h2>
    <p>Reelframe does not require a sign-in, account, or cloud sync. We do not intentionally collect personal account information, upload your files, or log your media to a remote server.</p>
    <h2>4. Browser permissions</h2>
    <p>To access local folders, your browser may ask for permission. That permission is only used to allow Reelframe to read files from the folder you select.</p>
    <h2>5. Your choices</h2>
    <p>You can switch folders, exclude subfolders, clear saved preferences, or stop using the app at any time. Because data is stored locally, removing browser data will remove that saved library state.</p>
  `
};