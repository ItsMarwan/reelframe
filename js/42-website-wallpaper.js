/* ==========================================================================
   Website background

   The picture lives on one fixed layer (#websiteWallpaper) that sits behind
   the whole app. The "Website background" window edits a draft of it —
   pick or upload an image (shared picker), position it (shared adjuster),
   choose an effect — and nothing touches the site until you press Save.
   ========================================================================== */
const WALLPAPER_EFFECTS = ['clear', 'frosted', 'blur', 'bw'];
const WALLPAPER_TONES = ['opaque', 'frosted', 'bw'];

function getWallpaperEffectFilter(effect){
  return {
    clear: 'none',
    frosted: 'saturate(1.08) brightness(0.94)',
    blur: 'blur(10px) saturate(1.08)',
    bw: 'grayscale(1) contrast(1.06)',
  }[effect] || 'none';
}

function paintWallpaperLayer(el, wp){
  if(!el) return;
  if(!wp || !wp.image){
    el.style.backgroundImage = 'none';
    el.style.opacity = '0';
    el.style.filter = 'none';
    return;
  }
  el.style.backgroundImage = `url("${wp.image}")`;
  el.style.opacity = String(Math.max(0, Math.min(1, (typeof wp.opacity === 'number' ? wp.opacity : 100) / 100)));
  el.style.filter = getWallpaperEffectFilter(wp.effect);
  // Blur pulls the edges in, so let the layer overshoot the screen a little.
  el.style.inset = wp.effect === 'blur' ? '-28px' : '0';
}

/* Puts the saved background on the real page. Safe to call any time. */
function renderWebsiteWallpaper(){
  const wp = state.websiteWallpaper;
  const has = !!(wp && wp.image);
  document.body.classList.toggle('has-wallpaper', has);
  document.body.dataset.wallpaperComponentTone = has && WALLPAPER_TONES.includes(wp.componentEffect) ? wp.componentEffect : 'opaque';
  paintWallpaperLayer(document.getElementById('websiteWallpaper'), wp);
}
document.addEventListener('DOMContentLoaded', renderWebsiteWallpaper);

/* ---------- the window ---------- */
function bindWebsiteWallpaperModal(){
  const $ = (id) => document.getElementById(id);
  const backdrop = $('websiteWallpaperModalBackdrop');
  const openBtn = $('openWebsiteWallpaperBtn');
  if(!backdrop || !openBtn || backdrop.dataset.bound) return;
  backdrop.dataset.bound = '1';

  const closeBtn = $('websiteWallpaperModalClose');
  const cancelBtn = $('websiteWallpaperCancelBtn');
  const saveBtn = $('websiteWallpaperApplyBtn');
  const removeBtn = $('websiteWallpaperClearBtn');
  const chooseBtn = $('wpChooseBtn');
  const adjustBtn = $('wallpaperEditCropBtn');
  const effectSeg = $('wpEffectSeg');
  const toneSeg = $('wpToneSeg');
  const opacity = $('websiteWallpaperOpacity');
  const opacityText = $('websiteWallpaperOpacityText');
  const preview = $('wallpaperPreview');
  const previewImg = $('wallpaperPreviewImg');
  const previewEmpty = $('wallpaperPreviewEmpty');

  let draft = null;        // { image, effect, componentEffect, opacity }
  let sourceUrl = null;    // object URL of the picture picked this session (so Adjust can start from the original)
  let dirty = false;

  const screenAspect = () => Math.min(3, Math.max(0.4, (window.innerWidth || 16) / (window.innerHeight || 9)));

  function setSeg(seg, value){
    seg.querySelectorAll('.rf-seg-btn').forEach(b => {
      const on = b.dataset.v === value;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', String(on));
    });
  }

  function sync(){
    paintWallpaperLayer(previewImg, draft);
    preview.dataset.tone = draft.componentEffect;
    preview.classList.toggle('is-empty', !draft.image);
    previewEmpty.hidden = !!draft.image;
    setSeg(effectSeg, draft.effect);
    setSeg(toneSeg, draft.componentEffect);
    opacity.value = String(draft.opacity);
    opacityText.textContent = `${draft.opacity}%`;
    adjustBtn.disabled = !draft.image;
    chooseBtn.textContent = draft.image ? 'Change image…' : 'Choose image…';
    removeBtn.hidden = !(state.websiteWallpaper && state.websiteWallpaper.image);
  }

  function releaseSource(){
    if(sourceUrl){ URL.revokeObjectURL(sourceUrl); sourceUrl = null; }
  }

  function openModal(){
    const wp = state.websiteWallpaper;
    draft = {
      image: wp && wp.image ? wp.image : null,
      effect: wp && WALLPAPER_EFFECTS.includes(wp.effect) ? wp.effect : 'clear',
      componentEffect: wp && WALLPAPER_TONES.includes(wp.componentEffect) ? wp.componentEffect : 'opaque',
      opacity: wp && typeof wp.opacity === 'number' ? Math.max(10, wp.opacity) : 100,
    };
    dirty = false;
    releaseSource();
    sync();
    backdrop.hidden = false;
  }

  function closeModal(){
    backdrop.hidden = true;
    releaseSource();
    draft = null;
  }

  /* Opens the adjuster on `src`; keeps the result in the draft. */
  async function adjust(src){
    const wide = screenAspect();
    const result = await openImageAdjuster({
      src,
      aspect: wide,
      aspects: [['This screen', wide], ['Wide 16:9', 16 / 9], ['Phone', 9 / 16]],
      title: 'Position your background',
      confirmLabel: 'Use this crop',
      maxEdge: 1920,
      maxChars: 2200000,
    });
    if(!result || !draft) return false;
    draft.image = result;
    dirty = true;
    sync();
    return true;
  }

  async function choose(){
    const picked = await openImagePicker({
      kind: 'image',
      title: 'Choose a background',
      subtitle: 'Pick a photo from your library, or upload one from this device.',
    });
    if(!picked || !picked[0] || !draft) return;
    const url = URL.createObjectURL(picked[0].blob);
    const used = await adjust(url);
    if(used){ releaseSource(); sourceUrl = url; }
    else URL.revokeObjectURL(url);
  }

  openBtn.addEventListener('click', openModal);
  chooseBtn.addEventListener('click', choose);
  adjustBtn.addEventListener('click', () => {
    if(!draft || !draft.image) return;
    adjust(sourceUrl || draft.image);
  });

  effectSeg.addEventListener('click', (e) => {
    const b = e.target.closest('.rf-seg-btn');
    if(!b || !draft) return;
    draft.effect = b.dataset.v;
    dirty = true;
    sync();
  });
  toneSeg.addEventListener('click', (e) => {
    const b = e.target.closest('.rf-seg-btn');
    if(!b || !draft) return;
    draft.componentEffect = b.dataset.v;
    dirty = true;
    sync();
  });
  opacity.addEventListener('input', () => {
    if(!draft) return;
    draft.opacity = Number(opacity.value);
    dirty = true;
    opacityText.textContent = `${draft.opacity}%`;
    paintWallpaperLayer(previewImg, draft);
  });

  saveBtn.addEventListener('click', () => {
    if(!draft) return;
    if(!draft.image){ toast('Choose an image first.'); return; }
    const previous = state.websiteWallpaper;
    state.websiteWallpaper = {
      image: draft.image,
      effect: draft.effect,
      componentEffect: draft.componentEffect,
      opacity: draft.opacity,
      scale: 100, positionX: 50, positionY: 50,
    };
    if(!saveWebsiteWallpaper()){
      state.websiteWallpaper = previous;
      toast('That picture is too big for browser storage. Try zooming in a little or picking a smaller one.');
      return;
    }
    renderWebsiteWallpaper();
    closeModal();
    toast('Background saved');
  });

  removeBtn.addEventListener('click', () => {
    state.websiteWallpaper = null;
    saveWebsiteWallpaper();
    renderWebsiteWallpaper();
    closeModal();
    toast('Background removed');
  });

  const tryClose = () => {
    if(dirty && !confirm('Discard your changes to the background?')) return;
    closeModal();
  };
  closeBtn.addEventListener('click', tryClose);
  cancelBtn.addEventListener('click', tryClose);
  backdrop.addEventListener('click', (e) => { if(e.target === backdrop && !dirty) closeModal(); });
}
