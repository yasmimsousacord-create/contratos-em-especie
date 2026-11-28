// Converte qualquer áudio ou vídeo para WAV 16 kHz mono com o FFmpeg (WebAssembly).
// Usado quando o navegador não consegue ler a gravação (ex.: MP4 gravado pelo Safari).
// O arquivo não sai do aparelho; a internet só baixa o conversor (cerca de 32 MB) na primeira vez.
const BASE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd/';
importScripts(BASE + 'ffmpeg-core.js');
let core;
self.onmessage = async ({ data: { bytes } }) => {
  const log = [];
  try {
    self.postMessage({ type: 'status', text: 'Baixando o conversor (cerca de 32 MB, só na primeira vez)…' });
    core ??= await createFFmpegCore({
      mainScriptUrlOrBlob: BASE + 'ffmpeg-core.js#' + btoa(JSON.stringify({ wasmURL: BASE + 'ffmpeg-core.wasm' })),
      locateFile: f => BASE + f
    });
    core.setLogger?.(({ message }) => { log.push(message); if (log.length > 40) log.shift(); });
    core.setProgress?.(({ progress }) => { if (progress > 0 && progress <= 1) self.postMessage({ type: 'status', text: `Convertendo… ${Math.round(progress * 100)}%` }); });
    self.postMessage({ type: 'status', text: 'Convertendo…' });
    core.FS.writeFile('entrada', new Uint8Array(bytes));
    core.exec('-i', 'entrada', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', 'saida.wav');
    const ret = core.ret; core.reset?.();
    let out = null; try { out = core.FS.readFile('saida.wav'); } catch { }
    try { core.FS.unlink('entrada'); core.FS.unlink('saida.wav'); } catch { }
    if (ret !== 0 || !out || out.length <= 44) throw new Error(log.slice(-3).join(' ') || 'o conversor não reconheceu o arquivo');
    self.postMessage({ type: 'done', wav: out.buffer }, [out.buffer]);
  } catch (e) {
    self.postMessage({ type: 'error', text: String((e && e.message) || e) });
  }
};
