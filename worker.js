// Transcrição no próprio aparelho (Whisper). O áudio não é enviado a servidor;
// a internet é usada para baixar a biblioteca e o modelo.
const LIB = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5';
const cache = {};
self.onmessage = async ({ data: { audio, model } }) => {
  try {
    const { pipeline } = await import(LIB);
    self.postMessage({ type: 'status', text: 'Preparando o modelo…' });
    cache[model] ??= await pipeline('automatic-speech-recognition', model, {
      dtype: 'q8', device: 'wasm',
      progress_callback: p => { if (p.status === 'progress') self.postMessage({ type: 'status', text: `Baixando modelo: ${Math.round(p.progress)}% (${p.file})` }); }
    });
    const SR = 16000, WIN = 30 * SR, total = audio.length;
    let start = 0;
    while (start < total) {
      let end = Math.min(start + WIN, total);
      if (end < total) { // corta no trecho mais silencioso dos últimos 5 s
        let best = end, min = Infinity;
        for (let i = end - 5 * SR; i < end - 1600; i += 1600) {
          let e = 0;
          for (let j = i; j < i + 1600; j++) e += audio[j] * audio[j];
          if (e < min) { min = e; best = i + 800; }
        }
        end = best;
      }
      self.postMessage({ type: 'status', text: `Transcrevendo… ${Math.round(start / total * 100)}%` });
      const piece = audio.slice(start, end);
      let peak = 0;
      for (let i = 0; i < piece.length; i += 8) peak = Math.max(peak, Math.abs(piece[i]));
      if (peak > 0.008) { // pula silêncio, onde o modelo tende a inventar texto
        const out = await cache[model](piece, { language: 'portuguese', task: 'transcribe', return_timestamps: true });
        const off = start / SR;
        const segs = (out.chunks || []).map(c => ({ t: off + (c.timestamp[0] || 0), text: c.text.trim() })).filter(s => s.text);
        self.postMessage({ type: 'segments', segs });
      }
      start = end;
    }
    self.postMessage({ type: 'done' });
  } catch (e) {
    self.postMessage({ type: 'error', text: String((e && e.message) || e) });
  }
};
