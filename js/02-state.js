/* ==========================================================================
   State
   ========================================================================== */
const state = {
  rootHandle: null,
  rootName: '',
  rawVideos: [],
  rawImages: [],
  rawAudio: [],
  videos: [],
  images: [],
  audio: [],
  excluded: new Set(),
  favorites: loadFavorites(),
  watchLater: loadWatchLater(),
  watchLaterConsumed: loadWatchLaterConsumed(),
  history: loadHistory(),
  algoEnabled: loadAlgoSetting(),
  sideCollapsed: loadSidebarCollapsed(),
  autoplayEnabled: loadAutoplaySetting(),
  categoryFavorites: loadCategoryFavorites(),
  favoriteTimestamps: loadFavoriteTimestamps(),
  watchProgress: loadWatchProgress(),
  lockEnabled: loadLockEnabled(),
  lockPassword: loadLockPassword(),
  lockTimeoutMinutes: loadLockTimeoutMinutes(),
  lockBlurDelaySeconds: loadLockBlurDelaySeconds(),
  captionsEnabled: false,
  realMiniPlayerEnabled: loadRealMiniPlayerSetting(),
  miniPlayerEnabled: loadMiniPlayerEnabledSetting(),
  nsfwFeatureUnlocked: loadNsfwUnlocked(),
  nsfwScanOnStartup: loadNsfwScanOnStartup(),
  nsfwBlurEnabled: loadNsfwBlurEnabled(),
  nsfwBlurMethod: loadNsfwBlurMethod(),
  nsfwResults: loadNsfwResults(),         // { "type:path": {flagged,score,label,size,lastModified,scannedAt} } — whole-image classifier
  nsfwRegions: loadNsfwRegions(),         // { "type:path": {boxes:[{cls,score,x,y,w,h}],size,lastModified,scannedAt} } — region detector, boxes are 0-1 fractions
  shareAutoApprove: loadShareAutoApproveSetting(),
  shareItem: null,
  tab: 'videos',
  cat: { videos: null, images: null, music: null },
  sort: { videos: 'random', images: 'random', music: 'az' },
  filters: { videos: { category: 'all', date: 'all' }, images: { category: 'all', date: 'all' }, music: { category: 'all', date: 'all' } },
  search: '',
  currentVideo: null,
  currentImage: null,
  scrollPos: { videos: 0, images: 0, music: 0 },
  gridRenderedCount: { videos: 0, images: 0, music: 0 },
  musicQueue: [],
  musicQueueOriginal: null,
  musicQueueIndex: -1,
  musicShuffle: false,
  musicRepeat: 'off',
  snapshots: [],
  snapshotSelectMode: false,
  selectedSnapshots: new Set(),
  discoverEnabled: loadDiscoverSetting(),
  /* New in this pass */
  chapters: loadChapters(),                 // { "type:path": [{time,label}, ...] }
  forYouRecent: loadForYouRecent(),          // { video: [favKey,...], image: [favKey,...] }
  captionedPaths: new Set(),                 // populated by refreshCaptionedPaths()
  transcripts: new Map(),                    // path -> [{start,text}, ...] parsed caption cues, built by buildTranscriptIndex() — powers searchable transcripts in global search
};

let pendingGridRestore = null;
let videoGridState = { list: [], rendered: 0 };

let observers = { grid: null };
let footerCollapsed = false;
let currentViewType = 'grid';
let appBound = false;
let lockBound = false;
