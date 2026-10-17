/* ==========================================================================
   Image pop-out viewer — click the focused photo to pop it into a floating,
   draggable, resizable frame over a darkened backdrop.
   ========================================================================== */

/* ==========================================================================
   "More from this library" row sizing — desktop shows a full-width grid
   capped at 3 rows (column count depends on viewport width); mobile keeps
   the original horizontal-scrolling strip.
   ========================================================================== */
const FOCUS_ROW_GAP = 14;
const FOCUS_ROW_DESKTOP_BREAKPOINT = 980;
const FOCUS_ROW_DESKTOP_ROWS = 3;
const FOCUS_ROW_DESKTOP_POOL = 60; // plenty of items to fill 3 full rows at any reasonable width
let focusRowCapTimer = null;

/* Measures the actual rendered tile height (post-layout) and clips the row
   list to exactly FOCUS_ROW_DESKTOP_ROWS rows worth of height — far more
   reliable than trying to predict column count ahead of time. */
function capFocusRowToRows(){
  const wrap = document.getElementById('focusBottomRow');
  if(!wrap) return;
  if(window.innerWidth <= FOCUS_ROW_DESKTOP_BREAKPOINT){
    wrap.style.maxHeight = '';
    return;
  }
  const firstItem = wrap.querySelector('.pin-item');
  if(!firstItem){ wrap.style.maxHeight = ''; return; }
  const itemHeight = firstItem.getBoundingClientRect().height;
  if(!itemHeight){ wrap.style.maxHeight = ''; return; }
  const maxH = itemHeight * FOCUS_ROW_DESKTOP_ROWS + FOCUS_ROW_GAP * (FOCUS_ROW_DESKTOP_ROWS - 1);
  wrap.style.maxHeight = `${Math.ceil(maxH)}px`;
}

function clampValue(value, min, max){
  return Math.min(max, Math.max(min, value));
}


function downloadSnapshotItem(item){
  if(!item || item.source !== 'snapshot') return;
  const blob = item.blob || null;
  if(!blob){
    toast('This snapshot does not have a downloadable file');
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(item.name || 'snapshot').replace(/\s+/g, ' ').trim() || 'snapshot'}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast('Snapshot downloaded');
}

function goToSnapshotSource(item){
  if(!item || !item.videoPath){ toast('No source video recorded for this snapshot.'); return; }
  const video = state.videos.find(v => v.path === item.videoPath);
  if(!video){ toast('Could not find the original video — it may have been renamed, moved, or excluded.'); return; }
  setTab('videos', { skipRender:true });
  openWatch(video);
  const player = document.getElementById('videoPlayer');
  const seekToTimestamp = () => { player.currentTime = item.timestamp || 0; };
  if(player.readyState >= 1) seekToTimestamp();
  else player.addEventListener('loadedmetadata', seekToTimestamp, { once:true });
}

function locateItemPath(item){
  if(!item) return;
  const fullPath = state.rootName ? `${state.rootName}/${item.path}` : item.path;
  copyTextToClipboard(fullPath).then(ok => {
    toast(ok ? `Path copied: ${fullPath}` : `Path: ${fullPath}`);
  });
}

function openFocus(item, opts = {}){
  state.currentImage = item;
  recordHistory(item);
  showView('imageFocus');
  if(opts.push !== false) history.pushState(null, '', `?p=${encodeURIComponent(item.path)}`);
  const focusImgEl = document.getElementById('focusImg');
  // reset any residual pan transform when opening a new photo
  focusImgEl.style.transform = '';
  if(item.pairRemote){
    focusImgEl.removeAttribute('src');
    ensureItemUrlAsync(item).then(src => { if(state.currentImage === item) focusImgEl.src = src; })
      .catch(() => toast("Couldn't load that photo from the paired device."));
  } else {
    const src = ensureItemUrl(item);
    if(src && /^https?:\/\//i.test(src)){
      try{ focusImgEl.crossOrigin = 'anonymous'; focusImgEl.referrerPolicy = 'no-referrer'; }catch(e){}
    }
    focusImgEl.src = src;
  }
  focusImgEl.alt = item.name;
  focusImgEl.onclick = () => {
    // Don't let the zoom pop-out bypass a blur gate that hasn't been
    // unblurred yet. FIX: this used to check shouldGateItem(item) alone,
    // which only reflects the scan result — it has no idea the person
    // already clicked "Unblur" for this viewing. That meant a flagged
    // photo could never be opened/zoomed at all, even right after
    // revealing it, since the flag itself never goes away. Checking
    // whether the wrap is currently in its "revealed" state (set by
    // revealFocusNsfwGate, reset every time a new photo opens) is what
    // the gate overlay/canvas already effectively do for their own
    // clicks — this just brings the image element's click in line with it.
    const wrap = document.getElementById('focusImgWrap');
    const revealed = !!(wrap && (wrap.classList.contains('nsfw-revealed') || wrap.classList.contains('variant-shown')));
    if(!revealed && shouldGateItem(item)) return;
    openImagePop(item);
  };
  applyFocusNsfwGate(item);
  if(typeof variantsOpenItem === 'function') variantsOpenItem(item);
  document.getElementById('focusTitle').textContent = item.name;
  const focusMetaEl = document.getElementById('focusMeta');
  focusMetaEl.innerHTML = `<span class="meta-cat-link" data-cat="${escapeAttr(item.category)}" title="Jump to this category">${escapeHtml(item.category)}</span> · ${escapeHtml(formatDate(item.lastModified))} · ${escapeHtml(formatBytes(item.size))}`;
  const focusCatLink = focusMetaEl.querySelector('.meta-cat-link');
  if(focusCatLink) focusCatLink.addEventListener('click', () => goToCategory('images', item.category));
  // Resolution: appended once the image's real pixel size is known.
  {
    const resImg = document.getElementById('focusImg');
    const showRes = () => {
      if(state.currentImage !== item || !resImg.naturalWidth) return;
      const mp = (resImg.naturalWidth * resImg.naturalHeight) / 1e6;
      const old = focusMetaEl.querySelector('.focus-res');
      if(old) old.remove();
      const span = document.createElement('span');
      span.className = 'focus-res';
      span.textContent = ` · ${resImg.naturalWidth} × ${resImg.naturalHeight}${mp >= 0.1 ? ` (${mp.toFixed(1)} MP)` : ''}`;
      focusMetaEl.appendChild(span);
    };
    if(resImg.complete && resImg.naturalWidth) showRes();
    if(resImg._resHandler) resImg.removeEventListener('load', resImg._resHandler);
    resImg._resHandler = showRes;
    resImg.addEventListener('load', showRes);
  }

  const favBtn = document.getElementById('focusFavBtn');
  favBtn.setAttribute('data-fav-key', favKey(item));
  favBtn.classList.toggle('is-fav', isFav(item));
  favBtn.onclick = () => {
    toggleFav(item);
    favBtn.classList.toggle('is-fav', isFav(item));
  };
  const seeBtn = document.getElementById('focusSeeLaterBtn');
  if(seeBtn){
    seeBtn.setAttribute('data-see-later-key', favKey(item));
    seeBtn.classList.toggle('is-see-later', isSeeLater(item));
    seeBtn.innerHTML = seeLaterSVG(isSeeLater(item));
    seeBtn.onclick = () => {
      toggleSeeLater(item);
      seeBtn.classList.toggle('is-see-later', isSeeLater(item));
      seeBtn.innerHTML = seeLaterSVG(isSeeLater(item));
    };
  }
  if(typeof bindICameButton === 'function') bindICameButton(item);
  const shareBtn = document.getElementById('focusShareBtn');
  if(shareBtn){
    shareBtn.onclick = () => openShareChoiceModal(item);
  }

  const downloadBtn = document.getElementById('focusDownloadBtn');
  const isSnapshot = item && item.source === 'snapshot';
  if(downloadBtn){
    downloadBtn.hidden = !isSnapshot;
    downloadBtn.onclick = () => downloadSnapshotItem(item);
  }

  const sourceBtn = document.getElementById('focusSourceBtn');
  if(sourceBtn){
    const hasSource = isSnapshot && !!item.videoPath;
    sourceBtn.hidden = !hasSource;
    if(hasSource){
      const sourceLabel = document.getElementById('focusSourceLabel');
      if(sourceLabel) sourceLabel.textContent = `From: ${item.videoName || 'video'}`;
      sourceBtn.title = `Jump to "${item.videoName || 'video'}" at ${formatDuration(item.timestamp || 0)}`;
      sourceBtn.onclick = () => goToSnapshotSource(item);
    }
  }

  const locateBtn = document.getElementById('focusLocateBtn');
  if(locateBtn){
    const canLocate = !isSnapshot && !item.remote && !item.pairRemote && !item.ephemeral;
    locateBtn.hidden = !canLocate;
    if(canLocate) locateBtn.onclick = () => locateItemPath(item);
  }

  const focusSaveBtn = document.getElementById('focusSaveBtn');
  if(focusSaveBtn){
    focusSaveBtn.hidden = !item.remote;
    focusSaveBtn.onclick = () => promptSaveItem(item, 'images');
  }
  const SIDE_COUNT = 16;
  const FOR_YOU_MIX = 3;
  const isDesktopRow = window.innerWidth > FOCUS_ROW_DESKTOP_BREAKPOINT;
  const ROW_COUNT = isDesktopRow ? FOCUS_ROW_DESKTOP_POOL : 14;

  const forYouPicks = computeForYouFor('image').filter(v => v !== item).slice(0, FOR_YOU_MIX);
  const forYouPaths = new Set(forYouPicks.map(v => v.path));
  const pool = shuffleArray(getFiltered('images').filter(v => v !== item && !forYouPaths.has(v.path)));
  const leadForYou = forYouPicks.slice(0, 2);
  const sideItems = [
    ...leadForYou,
    ...pool.slice(0, Math.max(0, SIDE_COUNT - leadForYou.length))
  ];
  const rowItems = [
    ...leadForYou,
    ...pool.slice(SIDE_COUNT - leadForYou.length, SIDE_COUNT - leadForYou.length + ROW_COUNT)
  ];

  const sideCol = document.getElementById('focusSideCol');
  sideCol.innerHTML = '';
  sideItems.forEach(im => sideCol.appendChild(createPinCard(im, { forYou: forYouPaths.has(im.path) })));

  const bottomRow = document.getElementById('focusBottomRow');
  bottomRow.innerHTML = '';
  rowItems.forEach(im => bottomRow.appendChild(createPinCard(im, { forYou: forYouPaths.has(im.path) })));

  capFocusRowToRows();

  if(watchParty.role === 'host' && partyIsActive() && watchParty.item !== item) broadcastPartyItem(item);
  scrollMainTop();
}


/* Re-lay the "More from this library" grid when the column count would
   actually change — not on every resize tick. */
window.addEventListener('resize', () => {
  const focusView = document.getElementById('imageFocus');
  if(!focusView || focusView.hidden || !state.currentImage) return;
  clearTimeout(focusRowCapTimer);
  focusRowCapTimer = setTimeout(capFocusRowToRows, 150);
});

