/* ==========================================================================
   caption-worker.js — runs speech-to-text transcription for the caption
   generator off the main thread. Model loading and per-chunk inference are
   both CPU-heavy and were previously running inline on the UI thread, which
   is what caused the page to lag/freeze while "Generating captions…" ran.
   This worker owns all of that work now and only ever talks back to the
   main thread via small progress/result messages.
   ========================================================================== */

let transcriberPromise = null;

function getTranscriber(onProgress) {
  if (!transcriberPromise) {
    transcriberPromise = import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2')
      .then(({ pipeline, env }) => {
        env.allowLocalModels = false;
        env.useBrowserCache = true;
        return pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
          progress_callback: onProgress
        });
      })
      .catch((err) => {
        transcriberPromise = null;
        throw err;
      });
  }
  return transcriberPromise;
}

self.onmessage = async (e) => {
  const { type, jobId } = e.data || {};
  if (type === 'warm') {
    // Fired once at app start so the model is already resident by the time
    // someone actually asks for captions, instead of paying that cost inline.
    getTranscriber(() => {}).catch(() => { /* a real job will retry and surface the error */ });
    return;
  }
  if (type !== 'transcribe') return;
  const { audio, chunkSeconds } = e.data;

  try {
    const transcriber = await getTranscriber((data) => {
      if (data?.status === 'progress' && typeof data.progress === 'number') {
        self.postMessage({ type: 'model-progress', jobId, progress: data.progress });
      }
    });

    const sampleRate = 16000;
    const chunkSamples = Math.max(1, Math.round(chunkSeconds * sampleRate));
    const chunkCount = Math.max(1, Math.ceil(audio.length / chunkSamples));
    const allChunks = [];

    for (let i = 0; i < chunkCount; i++) {
      const startSample = i * chunkSamples;
      const endSample = Math.min(audio.length, startSample + chunkSamples);
      const slice = audio.subarray(startSample, endSample);
      const offsetSeconds = startSample / sampleRate;

      const result = await transcriber(slice, { return_timestamps: true });
      const resultChunks = (result.chunks && result.chunks.length)
        ? result.chunks
        : [{ text: result.text || '', timestamp: [0, (endSample - startSample) / sampleRate] }];

      resultChunks.forEach((c) => {
        const [s, e2] = c.timestamp || [0, null];
        allChunks.push({
          text: c.text,
          timestamp: [offsetSeconds + (s || 0), e2 == null ? null : offsetSeconds + e2]
        });
      });

      self.postMessage({ type: 'chunk-progress', jobId, index: i, count: chunkCount });
    }

    self.postMessage({ type: 'done', jobId, chunks: allChunks });
  } catch (err) {
    self.postMessage({ type: 'error', jobId, message: (err && err.message) ? err.message : String(err) });
  }
};
