/* ==========================================================================
   Audio booster + equalizer (music only) — routes the music <audio>
   element through a Web Audio graph: source -> booster gain -> 5-band
   peaking EQ -> destination. Built lazily on first use since creating a
   MediaElementSourceNode requires (and consumes) a real user gesture in
   most browsers, and can only be done once per <audio> element.
   ========================================================================== */
const EQ_BANDS = [60, 250, 1000, 4000, 12000];
const AUDIO_FX_KEY = 'reelframe-audio-fx-v1';

function loadAudioFxSettings(){
  try{
    const raw = localStorage.getItem(AUDIO_FX_KEY);
    if(raw){
      const parsed = JSON.parse(raw);
      if(Array.isArray(parsed.gains) && parsed.gains.length === EQ_BANDS.length) return parsed;
    }
  }catch(e){ }
  return { boost: 1, gains: EQ_BANDS.map(() => 0), preset: 'flat' };
}
function saveAudioFxSettings(){ localStorage.setItem(AUDIO_FX_KEY, JSON.stringify(state.audioFx)); }
if(!state.audioFx) state.audioFx = loadAudioFxSettings();

const AUDIO_FX_PRESETS = {
  flat:   [0, 0, 0, 0, 0],
  bass:   [7, 4, 0, -1, -2],
  vocal:  [-2, 1, 4, 3, 0],
  treble: [-2, -1, 0, 3, 6],
  rock:   [4, 2, -1, 2, 4],
};

let audioFxGraph = null;

function ensureAudioFxGraph(){
  if(audioFxGraph) return audioFxGraph;
  const audio = document.getElementById('musicAudioEl');
  if(!audio) return null;
  try{
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const source = ctx.createMediaElementSource(audio);
    const boostGain = ctx.createGain();
    boostGain.gain.value = state.audioFx.boost;
    const filters = EQ_BANDS.map((freq, i) => {
      const f = ctx.createBiquadFilter();
      f.type = 'peaking';
      f.frequency.value = freq;
      f.Q.value = 1;
      f.gain.value = state.audioFx.gains[i] || 0;
      return f;
    });
    let node = source;
    node.connect(boostGain);
    node = boostGain;
    filters.forEach(f => { node.connect(f); node = f; });
    node.connect(ctx.destination);
    audioFxGraph = { ctx, source, boostGain, filters };
  }catch(e){
    console.warn('Audio effects unavailable in this browser', e);
    return null;
  }
  return audioFxGraph;
}

function applyAudioFxToGraph(){
  if(!audioFxGraph) return;
  audioFxGraph.boostGain.gain.value = state.audioFx.boost;
  audioFxGraph.filters.forEach((f, i) => { f.gain.value = state.audioFx.gains[i] || 0; });
}

function setAudioBoost(value){
  state.audioFx.boost = Math.max(1, Math.min(4, value));
  saveAudioFxSettings();
  applyAudioFxToGraph();
}
function setAudioEqGain(bandIdx, db){
  state.audioFx.gains[bandIdx] = Math.max(-12, Math.min(12, db));
  state.audioFx.preset = 'custom';
  saveAudioFxSettings();
  applyAudioFxToGraph();
}
function applyAudioFxPreset(name){
  const preset = AUDIO_FX_PRESETS[name];
  if(!preset) return;
  state.audioFx.gains = preset.slice();
  state.audioFx.preset = name;
  saveAudioFxSettings();
  applyAudioFxToGraph();
  renderEqualizerUI();
}

function renderEqualizerUI(){
  const boostSlider = document.getElementById('audioBoostSlider');
  const boostLabel = document.getElementById('audioBoostLabel');
  if(boostSlider) boostSlider.value = state.audioFx.boost;
  if(boostLabel) boostLabel.textContent = `${Math.round(state.audioFx.boost * 100)}%`;
  EQ_BANDS.forEach((freq, i) => {
    const slider = document.getElementById(`eqBand${i}`);
    if(slider) slider.value = state.audioFx.gains[i] || 0;
  });
  document.querySelectorAll('.eq-preset-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.preset === state.audioFx.preset);
  });
}

function bindAudioFxUI(){
  const openBtn = document.getElementById('equalizerBtn');
  const backdrop = document.getElementById('equalizerModalBackdrop');
  if(!backdrop) return;
  const closeBtn = document.getElementById('equalizerModalClose');
  const boostSlider = document.getElementById('audioBoostSlider');

  if(openBtn) openBtn.addEventListener('click', () => {
    const graph = ensureAudioFxGraph();
    if(graph && graph.ctx.state === 'suspended') graph.ctx.resume().catch(() => {});
    renderEqualizerUI();
    backdrop.hidden = false;
  });
  if(closeBtn) closeBtn.addEventListener('click', () => { backdrop.hidden = true; });
  backdrop.addEventListener('click', (e) => { if(e.target === backdrop) backdrop.hidden = true; });

  if(boostSlider){
    boostSlider.addEventListener('input', () => {
      setAudioBoost(parseFloat(boostSlider.value));
      const label = document.getElementById('audioBoostLabel');
      if(label) label.textContent = `${Math.round(state.audioFx.boost * 100)}%`;
    });
  }
  EQ_BANDS.forEach((freq, i) => {
    const slider = document.getElementById(`eqBand${i}`);
    if(slider) slider.addEventListener('input', () => setAudioEqGain(i, parseFloat(slider.value)));
  });
  document.querySelectorAll('.eq-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => applyAudioFxPreset(btn.dataset.preset));
  });

  document.addEventListener('click', function resumeAudioFxOnce(){
    const g = ensureAudioFxGraph();
    if(g && g.ctx.state === 'suspended') g.ctx.resume().catch(() => {});
  }, { once: true });
}

document.addEventListener('DOMContentLoaded', bindAudioFxUI);
