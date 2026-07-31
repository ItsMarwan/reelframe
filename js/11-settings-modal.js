/* ==========================================================================
   Settings modal
   ========================================================================== */
function blobToDataURL(blob){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function exportLibraryData(){
  const snapshotsPayload = (await Promise.all((state.snapshots || []).map(async (s) => {
    let data = null;
    try{ if(s.blob) data = await blobToDataURL(s.blob); }catch(e){ /* skip unreadable snapshot */ }
    return data ? { videoName: s.videoName, videoPath: s.videoPath || null, timestamp: s.timestamp, savedAt: s.savedAt, data } : null;
  }))).filter(Boolean);

  const payload = {
    version: 2,
    favorites: [...state.favorites],
    watchLater: [...state.watchLater],
    watchLaterConsumed: [...state.watchLaterConsumed],
    categoryFavorites: [...state.categoryFavorites],
    history: state.history,
    watchProgress: state.watchProgress,
    chapters: state.chapters,
    snapshots: snapshotsPayload,
    nsfwResults: state.nsfwResults,
    nsfwScanOnStartup: state.nsfwScanOnStartup,
    nsfwBlurEnabled: state.nsfwBlurEnabled,
    exportedAt: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'reelframe-library.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast('Library backup exported');
}
/* replace with */
function unionSet(existing, incoming){
  const merged = new Set(existing);
  incoming.forEach(v => merged.add(v));
  return merged;
}

/* Adds any imported history entries not already present (matched by
   type:path), keeps existing entries untouched, then re-sorts by recency. */
function mergeHistoryArrays(existing, incoming){
  const seen = new Set(existing.map(h => `${h.type}:${h.path}`));
  const merged = existing.slice();
  incoming.forEach(h => {
    const key = `${h.type}:${h.path}`;
    if(!seen.has(key)){ seen.add(key); merged.push(h); }
  });
  merged.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return merged.slice(0, HISTORY_MAX);
}

/* "Add if it doesn't exist" for plain key -> value objects (watchProgress,
   chapters): never overwrites a key the person already has locally. */
function mergeObjectAddOnly(existing, incoming){
  const merged = { ...existing };
  Object.keys(incoming).forEach(key => {
    if(!(key in merged)) merged[key] = incoming[key];
  });
  return merged;
}

function clearAllSnapshots(){
  return new Promise((resolve, reject) => {
    initIDBSnapshots().then(db => {
      const tx = db.transaction([SNAPSHOTS_STORE], 'readwrite');
      const req = tx.objectStore(SNAPSHOTS_STORE).clear();
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve();
    }).catch(reject);
  });
}

/* Resolves to 'replace', 'add', or null (cancelled/closed). */
function openImportChoiceModal(){
  return new Promise((resolve) => {
    const backdrop = document.getElementById('importChoiceModalBackdrop');
    if(!backdrop){ resolve(null); return; }
    const replaceBtn = document.getElementById('importChoiceReplaceBtn');
    const addBtn = document.getElementById('importChoiceAddBtn');
    const cancelBtn = document.getElementById('importChoiceCancelBtn');
    const closeBtn = document.getElementById('importChoiceModalClose');

    const cleanup = (choice) => {
      backdrop.hidden = true;
      replaceBtn.removeEventListener('click', onReplace);
      addBtn.removeEventListener('click', onAdd);
      cancelBtn.removeEventListener('click', onCancel);
      closeBtn.removeEventListener('click', onCancel);
      backdrop.removeEventListener('click', onBackdropClick);
      resolve(choice);
    };
    const onReplace = () => cleanup('replace');
    const onAdd = () => cleanup('add');
    const onCancel = () => cleanup(null);
    const onBackdropClick = (e) => { if(e.target === backdrop) cleanup(null); };

    replaceBtn.addEventListener('click', onReplace);
    addBtn.addEventListener('click', onAdd);
    cancelBtn.addEventListener('click', onCancel);
    closeBtn.addEventListener('click', onCancel);
    backdrop.addEventListener('click', onBackdropClick);
    backdrop.hidden = false;
  });
}

async function importLibraryData(file){
  if(!file) return;
  let parsed;
  try{
    const text = await file.text();
    parsed = JSON.parse(text);
  }catch(e){
    console.error(e);
    toast('Could not read that backup file');
    return;
  }

  const mode = await openImportChoiceModal();
  if(!mode){ toast('Import cancelled'); return; }
  const isReplace = mode === 'replace';

  try{
    if(Array.isArray(parsed.favorites)){
      state.favorites = isReplace ? new Set(parsed.favorites) : unionSet(state.favorites, parsed.favorites);
      saveFavorites();
    }
    if(Array.isArray(parsed.watchLater)){
      state.watchLater = isReplace ? new Set(parsed.watchLater) : unionSet(state.watchLater, parsed.watchLater);
      saveWatchLater();
    }
    if(Array.isArray(parsed.watchLaterConsumed)){
      state.watchLaterConsumed = isReplace ? new Set(parsed.watchLaterConsumed) : unionSet(state.watchLaterConsumed, parsed.watchLaterConsumed);
      saveWatchLaterConsumed();
    }
    if(Array.isArray(parsed.categoryFavorites)){
      state.categoryFavorites = isReplace ? new Set(parsed.categoryFavorites) : unionSet(state.categoryFavorites, parsed.categoryFavorites);
      saveCategoryFavorites();
    }
    if(Array.isArray(parsed.history)){
      state.history = isReplace ? parsed.history.slice(0, HISTORY_MAX) : mergeHistoryArrays(state.history, parsed.history);
      saveHistory();
    }
    if(parsed.watchProgress && typeof parsed.watchProgress === 'object'){
      state.watchProgress = isReplace ? parsed.watchProgress : mergeObjectAddOnly(state.watchProgress, parsed.watchProgress);
      saveWatchProgress();
    }
    if(parsed.chapters && typeof parsed.chapters === 'object'){
      state.chapters = isReplace ? parsed.chapters : mergeObjectAddOnly(state.chapters, parsed.chapters);
      saveChapters();
    }
    if(parsed.nsfwResults && typeof parsed.nsfwResults === 'object'){
      state.nsfwResults = isReplace ? parsed.nsfwResults : mergeObjectAddOnly(state.nsfwResults, parsed.nsfwResults);
      saveNsfwResults();
    }
    if(typeof parsed.nsfwScanOnStartup === 'boolean'){
      state.nsfwScanOnStartup = parsed.nsfwScanOnStartup;
      saveNsfwScanOnStartup();
    }
    if(typeof parsed.nsfwBlurEnabled === 'boolean'){
      state.nsfwBlurEnabled = parsed.nsfwBlurEnabled;
      saveNsfwBlurEnabled();
    }
    if(Array.isArray(parsed.snapshots) && parsed.snapshots.length){
      if(isReplace) await clearAllSnapshots();
      // For "add", skip snapshots that look identical to one already saved
      // (same source video, timestamp, and export time) so re-importing the
      // same backup twice doesn't pile up duplicates.
      const existingKeys = isReplace ? new Set() : new Set(
        state.snapshots.map(s => `${s.videoName}|${s.timestamp}|${s.savedAt}`)
      );
      for(const snap of parsed.snapshots){
        if(!snap.data) continue;
        const key = `${snap.videoName}|${snap.timestamp}|${snap.savedAt}`;
        if(!isReplace && existingKeys.has(key)) continue;
        try{
          const blob = await (await fetch(snap.data)).blob();
          await saveSnapshot(blob, snap.videoName || 'Imported snapshot', snap.timestamp || 0, snap.videoPath || null);
        }catch(e){ console.error('Failed to import a snapshot', e); }
      }
      await loadSnapshots();
      updateTotalCount();
      if(state.tab === 'images') renderActiveGrid();
    }
    updateWatchLaterButtons();
    updateFavCount();
    renderSidebar();
    renderActiveGrid();
    updateNsfwScanUI();
    toast(isReplace ? 'Library backup imported (replaced)' : 'Library backup imported (added)');
  }catch(e){
    console.error(e);
    toast('Could not import that backup file');
  }
}

/* ---------- Duplicate detection — content-hashed, not name/size guessing ---------- */
const DUPLICATE_HASH_SAMPLE_BYTES = 262144; // 256KB from each end

async function fileFingerprint(item){
  const file = item.file;
  if(!file || !file.size) return null;
  try{
    const size = file.size;
    const sampleSize = Math.min(DUPLICATE_HASH_SAMPLE_BYTES, size);
    const headBuf = await file.slice(0, sampleSize).arrayBuffer();
    const tailBuf = size > sampleSize ? await file.slice(size - sampleSize, size).arrayBuffer() : new ArrayBuffer(0);
    const combined = new Uint8Array(headBuf.byteLength + tailBuf.byteLength + 8);
    combined.set(new Uint8Array(headBuf), 0);
    combined.set(new Uint8Array(tailBuf), headBuf.byteLength);
    new DataView(combined.buffer, headBuf.byteLength + tailBuf.byteLength, 8).setBigUint64(0, BigInt(size));
    const digest = await crypto.subtle.digest('SHA-256', combined);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  }catch(e){
    return null;
  }
}

async function collectDuplicateGroups(items){
  const withHash = await Promise.all(items.map(async item => ({ item, hash: await fileFingerprint(item) })));
  const groups = new Map();
  withHash.forEach(({ item, hash }) => {
    const key = hash || `fallback::${(item.name||'').trim().toLowerCase()}::${item.size||0}`;
    if(!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });
  return [...groups.values()].filter(group => group.length > 1);
}

async function renderDuplicateModal(){
  const backdrop = document.getElementById('duplicatesModalBackdrop');
  const listEl = document.getElementById('duplicatesModalList');
  listEl.innerHTML = '<div class="modal-empty">Scanning files for duplicates…</div>';
  backdrop.hidden = false;

  const groups = [
    ...(await collectDuplicateGroups(state.videos)),
    ...(await collectDuplicateGroups(state.images)),
    ...(await collectDuplicateGroups(state.audio)),
  ];

  if(groups.length === 0){
    listEl.innerHTML = '<div class="modal-empty">No duplicates were found.</div>';
    return;
  }
  listEl.innerHTML = groups.map(group => {
    const sample = group[0];
    const label = `${sample.type === 'image' ? 'Photo' : sample.type === 'audio' ? 'Music' : 'Video'} · ${formatBytes(sample.size || 0)} · identical content`;
    return `
      <div class="folder-row" style="display:block; padding:10px 12px; border:1px solid var(--border-soft); border-radius:10px; margin-bottom:8px;">
        <div style="font-weight:600; margin-bottom:6px;">${escapeHtml(group[0].name)}</div>
        <div style="font-size:12px; color:var(--text-faint); margin-bottom:6px;">${escapeHtml(label)} · ${group.length} items</div>
        <div style="display:flex; flex-direction:column; gap:4px;">
          ${group.map(item => `<div style="font-size:12px; color:var(--text-dim);">• ${escapeHtml(item.category)} / ${escapeHtml(item.path)}</div>`).join('')}
        </div>
      </div>
    `;
  }).join('');
}

function closeMobileShell(){
  const sidebar = document.querySelector('.sidebar');
  const backdrop = document.getElementById('mobileSidebarBackdrop');
  const menu = document.getElementById('mobileActionsMenu');
  const menuBtn = document.getElementById('mobileMenuBtn');
  if(sidebar) sidebar.classList.remove('open');
  if(backdrop) backdrop.hidden = true;
  if(menu) menu.hidden = true;
  if(menuBtn) menuBtn.setAttribute('aria-expanded', 'false');
  document.body.classList.remove('mobile-sidebar-open');
}

function bindMobileShell(){
  const sidebar = document.querySelector('.sidebar');
  const backdrop = document.getElementById('mobileSidebarBackdrop');
  const toggleBtn = document.getElementById('mobileSidebarToggleBtn');
  const menuBtn = document.getElementById('mobileMenuBtn');
  const menu = document.getElementById('mobileActionsMenu');
  const mobileNavSelect = document.getElementById('mobileNavSelect');
  const mobileFoldersBtn = document.getElementById('mobileFoldersBtn');
  const mobileSettingsBtn = document.getElementById('mobileSettingsBtn');
  const mobileChangeDirBtn = document.getElementById('mobileChangeDirBtn');
  if(!sidebar || !backdrop || !toggleBtn || !menuBtn || !menu) return;

  toggleBtn.addEventListener('click', () => {
    const open = !sidebar.classList.contains('open');
    sidebar.classList.toggle('open', open);
    document.body.classList.toggle('mobile-sidebar-open', open);
    backdrop.hidden = !open;
    if(!open) menu.hidden = true;
  });

  backdrop.addEventListener('click', closeMobileShell);

  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open;
    menuBtn.setAttribute('aria-expanded', String(open));
    backdrop.hidden = !open;
    if(open){
      sidebar.classList.remove('open');
      document.body.classList.remove('mobile-sidebar-open');
    }
  });

  document.addEventListener('click', (e) => {
    if(!menu.contains(e.target) && e.target !== menuBtn && !menuBtn.contains(e.target)) {
      menu.hidden = true;
      menuBtn.setAttribute('aria-expanded', 'false');
    }
  });

  mobileNavSelect.addEventListener('change', () => {
    const tab = mobileNavSelect.value;
    if(tab === state.tab) return;
    syncCategoryAcrossTab(state.tab, tab); // NEW
    setTab(tab, { skipRender:true });
    switchViewsForTab();
    clearUrlParams();
    scrollMainTop();
    renderActiveGrid();
  });

  mobileFoldersBtn.addEventListener('click', () => {
    closeMobileShell();
    document.getElementById('manageFoldersBtn').click();
  });
  mobileSettingsBtn.addEventListener('click', () => {
    closeMobileShell();
    document.getElementById('settingsBtn').click();
  });
  mobileChangeDirBtn.addEventListener('click', () => {
    closeMobileShell();
    document.getElementById('changeDirBtn').click();
  });

  window.addEventListener('resize', () => {
    if(window.innerWidth > 860) closeMobileShell();
  });
}

function bindSettingsModal(){
  const backdrop = document.getElementById('settingsModalBackdrop');
  const openBtn = document.getElementById('settingsBtn');
  const closeBtn = document.getElementById('settingsModalClose');
  const algoToggle = document.getElementById('algoToggle');
  const lockToggle = document.getElementById('lockToggle');
  const lockPasswordInput = document.getElementById('lockPasswordInput');
  const lockPasswordConfirmInput = document.getElementById('lockPasswordConfirmInput');
  const setLockPasswordBtn = document.getElementById('setLockPasswordBtn');
  const lockBlurDelayInput = document.getElementById('lockBlurDelayInput');
  const lockTimeoutInput = document.getElementById('lockTimeoutInput');
  const exportBtn = document.getElementById('exportDataBtn');
  const importBtn = document.getElementById('importDataBtn');
  const findDuplicatesBtn = document.getElementById('findDuplicatesBtn');
  const duplicateBackdrop = document.getElementById('duplicatesModalBackdrop');
  const duplicateClose = document.getElementById('duplicatesModalClose');
  const discoverToggle = document.getElementById('discoverToggle');
  const realMiniPlayerToggle = document.getElementById('realMiniPlayerToggle');
  const installBtn = document.getElementById('installAppBtn');
  const miniPlayerEnabledToggle = document.getElementById('miniPlayerEnabledToggle');
  const nsfwScanBtn = document.getElementById('nsfwScanBtn');
  const nsfwScanStartupToggle = document.getElementById('nsfwScanStartupToggle');
  const nsfwBlurToggle = document.getElementById('nsfwBlurToggle');
  const nsfwRegionScanBtn = document.getElementById('nsfwRegionScanBtn');
  const nsfwRegionPauseBtn = document.getElementById('nsfwRegionPauseBtn');
  const redeemCodeInput = document.getElementById('redeemCodeInput');
  const redeemCodeBtn = document.getElementById('redeemCodeBtn');

  function refreshNsfwFeatureUI(){
    if(nsfwScanStartupToggle) nsfwScanStartupToggle.disabled = !state.nsfwFeatureUnlocked;
    if(nsfwBlurToggle) nsfwBlurToggle.disabled = !state.nsfwFeatureUnlocked;
    if(nsfwRegionScanBtn) nsfwRegionScanBtn.disabled = !state.nsfwFeatureUnlocked;
    if(nsfwRegionPauseBtn) nsfwRegionPauseBtn.disabled = !state.nsfwFeatureUnlocked;
    updateNsfwScanUI();
    updateNsfwRegionScanUI();
  }
  refreshNsfwFeatureUI();

  if(redeemCodeBtn){
    redeemCodeBtn.addEventListener('click', () => {
      const code = (redeemCodeInput.value || '').trim();
      if(!code){ toast('Enter a code first.'); return; }
      if(code.toUpperCase() === NSFW_REDEEM_CODE){
        state.nsfwFeatureUnlocked = true;
        saveNsfwUnlocked();
        refreshNsfwFeatureUI();
        toast('Code redeemed — NSFW detection unlocked (beta).');
      } else {
        toast('That code is not valid.');
      }
      redeemCodeInput.value = '';
    });
    redeemCodeInput.addEventListener('keydown', (e) => { if(e.key === 'Enter') redeemCodeBtn.click(); });
  }
  if(nsfwScanBtn){
    nsfwScanBtn.addEventListener('click', () => {
      if(!state.nsfwFeatureUnlocked){ toast('Redeem a code to unlock NSFW detection first.'); return; }
      if(nsfwScanState.running) cancelNsfwScan();
      else scanLibraryForNsfw({ force: true });
    });
  }
  if(nsfwScanStartupToggle){
    nsfwScanStartupToggle.addEventListener('change', () => {
      state.nsfwScanOnStartup = nsfwScanStartupToggle.checked;
      saveNsfwScanOnStartup();
      toast(state.nsfwScanOnStartup ? 'Will scan for NSFW content on startup' : 'Startup scan turned off — use the button here instead');
    });
  }
  if(nsfwBlurToggle){
    nsfwBlurToggle.addEventListener('change', () => {
      state.nsfwBlurEnabled = nsfwBlurToggle.checked;
      saveNsfwBlurEnabled();
      refreshNsfwVisuals();
      toast(state.nsfwBlurEnabled ? 'Flagged photos will be blurred and tagged' : 'Flagged photos will show normally');
    });
  }


  const importInput = document.createElement('input');
  importInput.type = 'file';
  importInput.accept = '.json,application/json';
  importInput.hidden = true;
  document.body.appendChild(importInput);

  openBtn.addEventListener('click', () => {
    algoToggle.checked = state.algoEnabled;
    discoverToggle.checked = state.discoverEnabled;
    realMiniPlayerToggle.checked = state.realMiniPlayerEnabled;
    if(miniPlayerEnabledToggle) miniPlayerEnabledToggle.checked = state.miniPlayerEnabled;
    lockToggle.checked = state.lockEnabled;
    shareAutoApproveSelect.value = state.shareAutoApprove;
    lockPasswordInput.value = '';
    if(lockPasswordConfirmInput) lockPasswordConfirmInput.value = '';
    if(lockBlurDelayInput) lockBlurDelayInput.value = state.lockBlurDelaySeconds;
    if(lockTimeoutInput) lockTimeoutInput.value = state.lockTimeoutMinutes;
    if(installBtn) installBtn.hidden = !deferredInstallPrompt;
    if(nsfwScanStartupToggle) nsfwScanStartupToggle.checked = state.nsfwScanOnStartup;
    if(nsfwBlurToggle) nsfwBlurToggle.checked = state.nsfwBlurEnabled;
    updateNsfwScanUI();
    updateNsfwRegionScanUI();
    backdrop.hidden = false;
  });
  closeBtn.addEventListener('click', () => { backdrop.hidden = true; });
  backdrop.addEventListener('click', (e) => { if(e.target === backdrop) backdrop.hidden = true; });
  duplicateClose.addEventListener('click', () => { duplicateBackdrop.hidden = true; });
  duplicateBackdrop.addEventListener('click', (e) => { if(e.target === duplicateBackdrop) duplicateBackdrop.hidden = true; });

  discoverToggle.addEventListener('change', () => {
    state.discoverEnabled = discoverToggle.checked;
    saveDiscoverSetting();
    renderDiscoverSections();
    toast(state.discoverEnabled ? 'Continue watching / Recently added shown' : 'Continue watching / Recently added hidden');
  });

  shareAutoApproveSelect.addEventListener('change', () => {
    state.shareAutoApprove = shareAutoApproveSelect.value;
    saveShareAutoApproveSetting();
    const labels = { always:'Always auto-approving', local:'Auto-approving on local network only', internet:'Auto-approving over internet only', never:'Always asking before approving' };
    toast(labels[state.shareAutoApprove] || 'Setting saved');
  });

  realMiniPlayerToggle.addEventListener('change', () => {
    state.realMiniPlayerEnabled = realMiniPlayerToggle.checked;
    saveRealMiniPlayerSetting();
    toast(state.realMiniPlayerEnabled ? 'Real mini player enabled' : 'Using the built-in mini player');
  });

  algoToggle.addEventListener('change', () => {
    state.algoEnabled = algoToggle.checked;
    saveAlgoSetting();
    renderForYouRow();
    toast(state.algoEnabled ? 'Personalized recommendations turned on' : 'Personalized recommendations turned off');
  });

  lockToggle.addEventListener('change', () => {
    if(lockToggle.checked){
      if(!state.lockPassword){
        toast('Set a password before enabling lock.');
        lockToggle.checked = false;
        return;
      }
      state.lockEnabled = true;
      saveLockEnabled();
      toast('Screen lock enabled');
      scheduleInactivityLockReset();
    } else {
      const attempt = lockPasswordInput.value.trim();
      if(state.lockPassword && attempt !== state.lockPassword){
        toast('Enter the current password to disable locking.');
        lockToggle.checked = true;
        return;
      }
      state.lockEnabled = false;
      saveLockEnabled();
      toast('Screen lock disabled');
    }
  });

  setLockPasswordBtn.addEventListener('click', () => {
    const value = lockPasswordInput.value.trim();
    const confirmValue = lockPasswordConfirmInput ? lockPasswordConfirmInput.value.trim() : value;
    if(!value){ toast('Enter a password first.'); return; }
    if(value !== confirmValue){ toast('Passwords do not match.'); return; }
    if(state.lockPassword && state.lockPassword !== value){
      toast('Password updated. Use the new password when unlocking or disabling the lock.');
    } else {
      toast('Password saved. You can now enable lock protection.');
    }
    state.lockPassword = value;
    saveLockPassword();
    lockPasswordInput.value = '';
    if(lockPasswordConfirmInput) lockPasswordConfirmInput.value = '';
  });

  if(lockBlurDelayInput){
    lockBlurDelayInput.addEventListener('change', () => {
      const n = Math.max(0, parseInt(lockBlurDelayInput.value, 10) || 0);
      state.lockBlurDelaySeconds = n;
      lockBlurDelayInput.value = n;
      saveLockBlurDelaySeconds();
      toast('Focus-loss lock delay updated');
    });
  }
  if(lockTimeoutInput){
    lockTimeoutInput.addEventListener('change', () => {
      const n = Math.max(0, parseInt(lockTimeoutInput.value, 10) || 0);
      state.lockTimeoutMinutes = n;
      lockTimeoutInput.value = n;
      saveLockTimeoutMinutes();
      scheduleInactivityLockReset();
      toast('Inactivity auto-lock updated');
    });
  }

  if(installBtn){
    installBtn.addEventListener('click', async () => {
      if(!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      const choice = await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      installBtn.hidden = true;
      toast(choice.outcome === 'accepted' ? 'Installing Reelframe…' : 'Install dismissed');
    });
  }

  if(miniPlayerEnabledToggle){
    miniPlayerEnabledToggle.addEventListener('change', () => {
      state.miniPlayerEnabled = miniPlayerEnabledToggle.checked;
      saveMiniPlayerEnabledSetting();
      toast(state.miniPlayerEnabled ? 'Mini player enabled' : 'Mini player disabled');
    });
  }

  exportBtn.addEventListener('click', exportLibraryData);
  importBtn.addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if(file) importLibraryData(file);
    e.target.value = '';
  });
  findDuplicatesBtn.addEventListener('click', renderDuplicateModal);
}

function formatTimeForVTT(seconds){
  const ms = Math.max(0, Math.round(seconds * 1000));
  const hour = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const minute = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
  const second = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  const mill = String(ms % 1000).padStart(3, '0');
  return `${hour}:${minute}:${second}.${mill}`;
}

function attachCaptionTrack(vttText, label='Captions', opts={}){
  const { silent=false, show=true } = opts;
  const player = document.getElementById('videoPlayer');
  [...player.querySelectorAll('track')].forEach(t => t.remove());
  const blob = new Blob([vttText], { type: 'text/vtt' });
  const url = URL.createObjectURL(blob);
  const track = document.createElement('track');
  track.kind = 'captions';
  track.label = label;
  track.srclang = 'en';
  track.src = url;
  track.default = show;
  player.append(track);
  player.textTracks[0].mode = show ? 'showing' : 'hidden';
  state.captionsEnabled = show;
  updateCaptionButtons();
  if(!silent) toast('Captions loaded');
}

function updateCaptionButtons(){
  const btn = document.getElementById('captionToggleBtn');
  if(!btn) return;
  btn.classList.toggle('active', state.captionsEnabled);
  btn.textContent = state.captionsEnabled ? 'CC On' : 'CC Off';
}

function toggleCaptions(){
  const player = document.getElementById('videoPlayer');
  const track = player.textTracks?.[0];
  if(!track){
    toast('No captions loaded. Upload a VTT file or generate captions first.');
    return;
  }
  track.mode = track.mode === 'showing' ? 'hidden' : 'showing';
  state.captionsEnabled = track.mode === 'showing';
  updateCaptionButtons();
  toast(state.captionsEnabled ? 'Captions enabled' : 'Captions hidden');
}

function loadCaptionFile(file){
  if(!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    attachCaptionTrack(reader.result, file.name || 'Imported captions');
    if(state.currentVideo){
      const item = state.currentVideo;
      saveCaptionsForItem(item, reader.result).then(() => {
        // Index immediately so an imported VTT is searchable right away,
        // same as generated captions.
        state.transcripts.set(item.path, parseVttCues(reader.result));
        refreshCaptionedPaths();
      });
    }
  };
  reader.readAsText(file);
}

/* NOTE: blobToDataURL / exportLibraryData / importLibraryData are already
   defined near the top of this file (with support for snapshots, chapters,
   and watch progress). They used to be redeclared here with an older,
   incomplete version — since these were plain `function` declarations in
   the same scope, the later (this) definition silently won, clobbering the
   good one above. Removed for good. */