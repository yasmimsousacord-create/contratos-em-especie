import { CONTRATOS, QUESTOES, BIBLIOGRAFIA } from './data.js';

const $ = s => document.querySelector(s);
const view = $('#view');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = s => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
const dataBR = ts => new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const byId = Object.fromEntries(CONTRATOS.map(c => [c.id, c]));
const isTouch = matchMedia('(pointer:coarse)').matches;
const ANDROID = /Android/i.test(navigator.userAgent);
const INSTALADO = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const IOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const LINKS = {
  cc: 'https://www.planalto.gov.br/ccivil_03/leis/2002/l10406compilada.htm',
  cpc: 'https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2015/lei/l13105.htm',
  seguro: 'https://www.planalto.gov.br/ccivil_03/_ato2023-2026/2024/lei/l15040.htm'
};

function toast(t) { const el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => el.hidden = true, 4000); }

/* ---------- Banco local (IndexedDB) ---------- */
let dbp;
const db = () => dbp ??= new Promise((res, rej) => {
  const r = indexedDB.open('contratos-estudo', 1);
  r.onupgradeneeded = () => { r.result.createObjectStore('aulas', { keyPath: 'id' }); r.result.createObjectStore('kv'); };
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode); const r = fn(t.objectStore(store));
    t.oncomplete = () => res(r?.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  });
}
const Aulas = {
  all: async () => ((await tx('aulas', 'readonly', s => s.getAll())) || []).sort((a, b) => b.criada - a.criada),
  get: id => tx('aulas', 'readonly', s => s.get(id)),
  put: a => tx('aulas', 'readwrite', s => s.put(a)),
  del: id => tx('aulas', 'readwrite', s => s.delete(id))
};
const KV = {
  get: async (k, d) => (await tx('kv', 'readonly', s => s.get(k))) ?? d,
  set: (k, v) => tx('kv', 'readwrite', s => s.put(v, k)),
  del: k => tx('kv', 'readwrite', s => s.delete(k)),
  keys: () => tx('kv', 'readonly', s => s.getAllKeys())
};
// Altera uma aula em fila, para que a transcrição e as anotações não se sobrescrevam.
let fila = Promise.resolve();
const alterarAula = (id, fn) => (fila = fila.then(async () => { const a = await Aulas.get(id); if (!a) return; fn(a); await Aulas.put(a); return a; }).catch(e => { console.error(e); toast('Não consegui salvar a alteração.'); }));

/* ---------- Detecção dos contratos citados ---------- */
const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const TERMOS = CONTRATOS.map(c => ({ c, termos: c.termos.map(norm) }));
function citados(texto) {
  const t = norm(texto), cont = {};
  for (const { c, termos } of TERMOS) for (const termo of termos) {
    let i = -1; while ((i = t.indexOf(termo, i + 1)) !== -1) cont[c.id] = (cont[c.id] || 0) + 1;
  }
  for (const m of t.matchAll(/\bart(?:igo|\.)?s?\s*(\d{3})\b/g)) {
    const n = +m[1]; const c = CONTRATOS.find(c => n >= c.de && n <= c.ate); if (c) cont[c.id] = (cont[c.id] || 0) + 1;
  }
  return Object.entries(cont).sort((a, b) => b[1] - a[1]);
}
const citaContrato = (texto, c) => citados(texto).some(([id]) => id === c.id);

/* ---------- Gravação ---------- */
// Grava direto em WAV 16 kHz mono. É o formato que qualquer navegador e qualquer programa de
// transcrição leem sem conversão (o MP4 do Safari às vezes não é lido de volta pelo próprio Safari).
const TAXA = 16000;
const rec = { mr: null, stream: null, chunks: [], marcas: [], acum: 0, desde: 0, wake: null, ctx: null, raf: 0, parando: false, id: null, titulo: '', nivel: 0, buf: [], pos: 0 };
const decorrido = () => rec.acum + (rec.mr?.state === 'recording' ? (Date.now() - rec.desde) / 1000 : 0);
const WORKLET = `class Cap extends AudioWorkletProcessor{constructor(){super();this.b=[];this.n=0}process(i){const c=i[0]&&i[0][0];if(c){this.b.push(c.slice());this.n+=c.length;if(this.n>=4096){const o=new Float32Array(this.n);let k=0;for(const x of this.b){o.set(x,k);k+=x.length}this.port.postMessage(o,[o.buffer]);this.b=[];this.n=0}}return true}}registerProcessor('cap',Cap)`;

function cabecalhoWav(bytes) {
  const v = new DataView(new ArrayBuffer(44)), str = (o, t) => [...t].forEach((c, k) => v.setUint8(o + k, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, TAXA, true); v.setUint32(28, TAXA * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, bytes, true); return v.buffer;
}
const montarWav = partes => { const bytes = partes.reduce((n, b) => n + b.size, 0); return new Blob([cabecalhoWav(bytes), ...partes], { type: 'audio/wav' }); };

// Reduz a taxa do microfone (44,1 ou 48 kHz) para 16 kHz, com média por janela.
function receber(amostras) {
  if (rec.mr?.state !== 'recording') return;
  const razao = rec.ctx.sampleRate / TAXA; let s = 0;
  for (const v of amostras) s += v * v;
  rec.nivel = Math.min(1, Math.sqrt(s / amostras.length) * 4);
  const saida = [];
  let p = rec.pos;
  while (p + razao <= amostras.length) {
    let soma = 0, n = 0; for (let k = Math.floor(p); k < Math.floor(p + razao); k++) { soma += amostras[k]; n++; }
    saida.push(n ? soma / n : 0); p += razao;
  }
  rec.pos = p - amostras.length; // fração que passa para o próximo bloco
  const i16 = new Int16Array(saida.length);
  for (let k = 0; k < saida.length; k++) i16[k] = Math.max(-1, Math.min(1, saida[k])) * 0x7fff;
  rec.buf.push(i16);
  if (rec.buf.reduce((n, b) => n + b.length, 0) >= TAXA * 10) descarregar();
}
function descarregar() { if (!rec.buf.length) return; rec.chunks.push(new Blob(rec.buf)); rec.buf = []; salvarRascunho(); }

async function iniciarGravacao() {
  if (rec.mr) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!navigator.mediaDevices?.getUserMedia || !AC) { toast('Este navegador não grava áudio. Use o Safari ou o Chrome atualizados.'); return; }
  if (job) { toast('Aguarde a transcrição em andamento terminar antes de gravar.'); return; }
  try { rec.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true, channelCount: 1 } }); }
  catch { toast('Sem acesso ao microfone. Libere o microfone para este site nos ajustes do navegador.'); return; }
  try {
    rec.ctx = new AC(); await rec.ctx.resume();
    const fonte = rec.ctx.createMediaStreamSource(rec.stream);
    if (rec.ctx.audioWorklet) {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
      await rec.ctx.audioWorklet.addModule(url); URL.revokeObjectURL(url);
      const no = new AudioWorkletNode(rec.ctx, 'cap'); no.port.onmessage = e => receber(e.data);
      fonte.connect(no); rec.no = no;
    } else { // navegadores antigos
      const no = rec.ctx.createScriptProcessor(4096, 1, 1); no.onaudioprocess = e => receber(e.inputBuffer.getChannelData(0).slice());
      fonte.connect(no); no.connect(rec.ctx.destination); rec.no = no;
    }
  } catch (e) { console.error(e); rec.stream.getTracks().forEach(t => t.stop()); rec.ctx?.close().catch(() => {}); toast('Não consegui iniciar a gravação neste navegador.'); return; }
  // "mr" imita a interface do MediaRecorder para o resto do app (estado, pausa e fim).
  rec.mr = { state: 'recording', mimeType: 'audio/wav' };
  Object.assign(rec, { chunks: [], buf: [], pos: 0, marcas: [], acum: 0, desde: Date.now(), parando: false, id: uid(), titulo: 'Aula de ' + dataBR(Date.now()) });
  rec.stream.getAudioTracks()[0].onended = () => { if (rec.mr && !rec.parando) finalizarGravacao(); }; // microfone desconectado ou bloqueado
  medidor();
  manterTelaLigada();
  desenharBarra();
}
function salvarRascunho() {
  KV.set('rascunho', { id: rec.id, titulo: rec.titulo, criada: rec.desde, tipo: 'audio/wav', pcm: true, chunks: rec.chunks.slice(), marcas: rec.marcas, duracao: decorrido() }).catch(() => {});
}
function medidor() {
  const loop = () => {
    const i = $('#lvl'); if (i) i.style.width = (rec.nivel * 100) + '%';
    const t = $('#rtimer'); if (t) t.textContent = fmt(decorrido());
    rec.raf = requestAnimationFrame(loop);
  };
  loop();
}
async function manterTelaLigada() { try { rec.wake = await navigator.wakeLock?.request('screen'); } catch { rec.wake = null; } }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !rec.mr) return;
  rec.ctx?.resume().catch(() => {});
  manterTelaLigada();
});
function pausarRetomar() {
  if (!rec.mr) return;
  if (rec.mr.state === 'recording') { rec.acum = decorrido(); rec.mr.state = 'paused'; descarregar(); }
  else if (rec.mr.state === 'paused') { rec.desde = Date.now(); rec.mr.state = 'recording'; rec.ctx?.resume().catch(() => {}); }
  desenharBarra();
}
function marcar() {
  const inp = $('#rnota'); const texto = inp?.value.trim() || 'Ponto importante';
  rec.marcas.push({ t: decorrido(), texto }); if (inp) inp.value = '';
  toast(`Marcado em ${fmt(decorrido())}: ${texto}`); salvarRascunho();
}
function pararGravacao() { if (!rec.mr) return; rec.parando = true; finalizarGravacao(); }
async function finalizarGravacao() {
  if (!rec.mr) return;
  const inesperado = !rec.parando;
  rec.acum = decorrido(); rec.mr.state = 'inactive';
  descarregar();
  cancelAnimationFrame(rec.raf);
  try { rec.no?.disconnect(); } catch { }
  rec.ctx?.close().catch(() => {});
  rec.stream?.getTracks().forEach(t => t.stop());
  rec.wake?.release?.().catch(() => {});
  const blob = montarWav(rec.chunks);
  const aula = { id: rec.id, titulo: rec.titulo, criada: rec.desde, origem: 'gravada', tipo: blob.type, blob, duracao: rec.acum, marcas: rec.marcas, segs: [], notas: '' };
  rec.mr = null; desenharBarra();
  if (blob.size <= 44) { toast('A gravação ficou vazia e não foi salva.'); KV.del('rascunho'); return; }
  try { await Aulas.put(aula); await KV.del('rascunho'); }
  catch { toast('Não consegui salvar a gravação. Verifique o espaço livre no aparelho.'); return; }
  toast(inesperado ? 'O sistema interrompeu a gravação. O trecho gravado foi salvo.' : 'Gravação salva.');
  sessionStorage.setItem('recemGravada', aula.id);
  // Sempre gera o arquivo da aula. No iPhone o sistema exige um toque, então o botão aparece na tela da aula.
  if (!IOS && !INSTALADO) salvarArquivo(blob, aula.titulo + '.wav', true).then(() => toast('Arquivo da aula (WAV) salvo em Downloads. Ele pode ser transcrito em qualquer programa.')).catch(() => {});
  location.hash = '#aula/' + aula.id;
}
function desenharBarra() {
  const bar = $('#recbar');
  if (!rec.mr) { bar.hidden = true; bar.innerHTML = ''; return; }
  const pausado = rec.mr.state === 'paused';
  bar.hidden = false;
  bar.innerHTML = `<div class="card"><div class="row">
    <span class="dot ${pausado ? '' : 'live'}"></span><b>${pausado ? 'Pausado' : 'Gravando'}</b>
    <span class="timer" id="rtimer">${fmt(decorrido())}</span><span class="lvl"><i id="lvl"></i></span>
    <span class="grow"></span>
    <button id="rpausa">${pausado ? 'Continuar' : 'Pausar'}</button>
    <button id="rparar" class="primary">Parar e salvar</button></div>
    <div class="row" style="margin-top:8px"><input id="rnota" type="text" class="grow" placeholder="Nota rápida (opcional), ex.: cai na prova">
    <button id="rmarcar">Marcar este momento</button></div>
    <p class="muted" style="margin:8px 0 0">Mantenha o app aberto e a tela ligada. Se o sistema interromper, o trecho gravado é salvo.</p></div>`;
  $('#rpausa').onclick = pausarRetomar; $('#rparar').onclick = pararGravacao; $('#rmarcar').onclick = marcar;
  $('#rnota').onkeydown = e => { if (e.key === 'Enter') marcar(); };
}

/* ---------- Transcrição ---------- */
let job = null; // { id, status, segs }
const MODELOS = [
  ['Xenova/whisper-base', 'Rápido (recomendado no celular e tablet)'],
  ['Xenova/whisper-small', 'Mais preciso (melhor no computador)']
];
async function lerAudio(blob) {
  const buf = await blob.arrayBuffer();
  const v = new DataView(buf);
  if (buf.byteLength > 44 && v.getUint32(0) === 0x52494646 && v.getUint16(20, true) === 1 && v.getUint16(22, true) === 1 && v.getUint32(24, true) === 16000 && v.getUint16(34, true) === 16) {
    const n = Math.floor((buf.byteLength - 44) / 2), out = new Float32Array(n);
    for (let k = 0; k < n; k++) out[k] = v.getInt16(44 + k * 2, true) / 0x8000;
    return out;
  }
  const Off = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new Off(1, 1, 16000);
  const ab = await new Promise((res, rej) => { const p = ctx.decodeAudioData(buf, res, rej); p?.then?.(res, rej); });
  let d = ab.getChannelData(0);
  if (ab.numberOfChannels > 1) { const b = ab.getChannelData(1), m = new Float32Array(d.length); for (let i = 0; i < d.length; i++) m[i] = (d[i] + b[i]) / 2; d = m; }
  if (ab.sampleRate !== 16000) { // reamostragem linear, se o navegador não converteu
    const r = ab.sampleRate / 16000, out = new Float32Array(Math.floor(d.length / r));
    for (let i = 0; i < out.length; i++) { const x = i * r, j = Math.floor(x), f = x - j; out[i] = d[j] * (1 - f) + (d[j + 1] ?? d[j]) * f; }
    d = out;
  }
  return d.buffer === ab.getChannelData(0).buffer ? d.slice() : d;
}
async function transcrever(id, modelo) {
  if (job) { toast('Já existe uma transcrição em andamento.'); return; }
  if (rec.mr) { toast('Termine a gravação antes de transcrever.'); return; }
  const a = await Aulas.get(id); if (!a) return;
  job = { id, status: 'Lendo o áudio…', segs: [] }; atualizarTranscricao();
  let audio;
  try { audio = await lerAudio(a.blob); }
  catch { job = null; atualizarTranscricao(); toast('Este navegador não conseguiu ler o áudio. Use “Reparar áudio”, logo abaixo do player.'); const r = $('#reparo'); if (r) { r.hidden = false; r.scrollIntoView({ behavior: 'smooth', block: 'center' }); } return; }
  await alterarAula(id, x => { x.segs = []; x.transcricao = 'andamento'; x.modelo = modelo; });
  const w = new Worker('worker.js', { type: 'module' });
  w.onmessage = ({ data }) => {
    if (data.type === 'status') { job.status = data.text; atualizarTranscricao(); }
    if (data.type === 'segments') { job.segs.push(...data.segs); alterarAula(id, x => { x.segs = job.segs.slice(); }).then(atualizarTranscricao); }
    if (data.type === 'done' || data.type === 'error') {
      w.terminate();
      const ok = data.type === 'done';
      alterarAula(id, x => { x.segs = job.segs.slice(); x.transcricao = ok ? 'ok' : 'erro'; }).then(() => {
        job = null; atualizarTranscricao(true);
        toast(ok ? 'Transcrição concluída.' : 'A transcrição falhou: ' + data.text);
      });
    }
  };
  w.onerror = e => { w.terminate(); job = null; atualizarTranscricao(true); toast('A transcrição falhou. Confira a conexão (a primeira vez baixa o modelo).'); console.error(e); };
  w.postMessage({ audio, model: modelo }, [audio.buffer]);
}
let aulaAberta = null; // id da aula exibida
async function atualizarTranscricao(full) {
  if (!aulaAberta) { if (location.hash.startsWith('#aulas') || !location.hash) route(); return; }
  const a = await Aulas.get(aulaAberta); if (!a) return;
  if (full) return route();
  const st = $('#tstatus'); if (st) st.textContent = job?.id === a.id ? job.status : '';
  const btn = $('#transcrever'); if (btn) btn.disabled = !!job;
  desenharSegs(a); desenharCitados(a);
}

/* ---------- Reparo de áudio ilegível ---------- */
let reparando = false;
async function repararAula(id) {
  if (reparando) return; reparando = true;
  const st = t => { const e = $('#reparoSt'); if (e) e.textContent = t; };
  const btn = $('#reparar'); if (btn) btn.disabled = true;
  const a = await Aulas.get(id);
  let bytes;
  try { bytes = await a.blob.arrayBuffer(); } catch { reparando = false; st(''); toast('Não consegui abrir os dados desta gravação.'); return; }
  const w = new Worker('reparo.js');
  const fim = () => { reparando = false; w.terminate(); if (btn) btn.disabled = false; };
  w.onmessage = async ({ data }) => {
    if (data.type === 'status') st(data.text);
    if (data.type === 'error') { fim(); st(''); toast('Não consegui reparar: ' + data.text); }
    if (data.type === 'done') {
      fim();
      const wavBlob = new Blob([data.wav], { type: 'audio/wav' });
      await alterarAula(id, x => { if (!x.original) { x.original = x.blob; x.tipoOriginal = x.tipo; } x.blob = wavBlob; x.tipo = 'audio/wav'; x.duracao = (data.wav.byteLength - 44) / 32000; });
      toast('Áudio reparado. Agora ele toca e pode ser transcrito.');
      if (aulaAberta === id) route();
    }
  };
  w.onerror = () => { fim(); st(''); toast('O conversor não carregou. Confira a internet e tente de novo.'); };
  w.postMessage({ bytes }, [bytes]);
}

/* ---------- Roteamento ---------- */
const urls = [];
const routes = { aulas: viewAulas, aula: viewAula, contratos: viewContratos, contrato: viewContrato, cartoes: viewCartoes, questoes: viewQuestoes, backup: viewBackup };
async function route() {
  const [nome, ...args] = (location.hash.slice(1) || 'aulas').split('/');
  const aba = { aula: 'aulas', contrato: 'contratos' }[nome] || nome;
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('on', a.getAttribute('href') === '#' + aba));
  while (urls.length) URL.revokeObjectURL(urls.pop());
  aulaAberta = null; view.onclick = null; document.onkeydown = null;
  try { await (routes[nome] || viewAulas)(...args.map(decodeURIComponent)); }
  catch (e) { console.error(e); view.innerHTML = `<div class="card">Algo deu errado ao abrir esta tela: ${esc(e.message)}</div>`; }
}
addEventListener('hashchange', () => { route(); scrollTo(0, 0); });

/* ---------- Tela: Aulas ---------- */
async function viewAulas() {
  const [aulas, rasc] = await Promise.all([Aulas.all(), KV.get('rascunho')]);
  view.innerHTML = `
  <h2>Suas aulas</h2>
  ${rasc && !rec.mr ? `<div class="card warn"><b>Há uma gravação não finalizada</b> (${fmt(rasc.duracao)}).
     <div class="row" style="margin-top:8px"><button id="recuperar" class="primary">Recuperar</button><button id="descartar">Descartar</button></div></div>` : ''}
  <div class="card"><div class="row">
    <button id="gravar" class="primary big">● Gravar aula</button>
    <label class="btn big">Enviar aula gravada<input id="arquivo" type="file" accept="audio/*,video/*,.m4a,.mp3,.wav,.mp4,.mov,.ogg,.webm" multiple hidden></label>
  </div>
  <p class="muted" style="margin:10px 0 0">Aceita áudio e vídeo. O arquivo fica guardado só neste aparelho.
  ${isTouch ? `Para aulas longas, grave no app gravador do aparelho (${ANDROID ? 'Gravador de Voz da Samsung' : 'Gravador do iPhone'}), que continua com a tela desligada, e envie o arquivo aqui. Em aulas de mais de 1 hora, a transcrição no ${ANDROID ? 'tablet' : 'celular'} pode faltar memória: transcreva no computador.` : ''}</p></div>
  ${aulas.length ? `<div class="grid">${aulas.map(cartaoAula).join('')}</div>` :
    `<div class="card"><h3>Nenhuma aula ainda</h3><p class="muted">Grave a próxima aula ou envie um arquivo. Depois da transcrição, o app aponta quais contratos foram tratados e liga cada trecho ao conteúdo de estudo.</p></div>`}
  ${!matchMedia('(display-mode: standalone)').matches && isTouch ? `<div class="card">${ANDROID ? '<b>Instalar no tablet:</b> no Chrome, toque no menu ⋮ e depois em “Instalar app” ou “Adicionar à tela inicial”.' : '<b>Instalar no iPhone:</b> toque em Compartilhar e depois em “Adicionar à Tela de Início”.'}</div>` : ''}`;
  $('#gravar').onclick = iniciarGravacao;
  $('#arquivo').onchange = e => enviarArquivos([...e.target.files]);
  if ($('#recuperar')) $('#recuperar').onclick = async () => {
    const r = await KV.get('rascunho');
    const blob = r.pcm ? montarWav(r.chunks) : new Blob(r.chunks, { type: r.tipo });
    await Aulas.put({ id: r.id, titulo: r.titulo, criada: r.criada, origem: 'gravada', tipo: blob.type, blob, duracao: r.duracao, marcas: r.marcas || [], segs: [], notas: '' });
    await KV.del('rascunho'); toast('Gravação recuperada.'); location.hash = '#aula/' + r.id;
  };
  if ($('#descartar')) $('#descartar').onclick = async () => { await KV.del('rascunho'); route(); };
}
function cartaoAula(a) {
  const cit = citados((a.segs || []).map(s => s.text).join(' ') + ' ' + (a.notas || '')).slice(0, 4);
  const st = job?.id === a.id ? 'Transcrevendo…' : a.transcricao === 'ok' ? 'Transcrita' : a.transcricao === 'andamento' ? 'Transcrição incompleta' : 'Sem transcrição';
  return `<a class="card" href="#aula/${a.id}"><h3>${esc(a.titulo)}</h3>
    <div class="muted">${dataBR(a.criada)} · ${a.duracao ? fmt(a.duracao) : '—'} · ${st}</div>
    ${cit.length ? `<div class="row" style="margin-top:8px">${cit.map(([id]) => `<span class="chip">${esc(byId[id].nome)}</span>`).join('')}</div>` : ''}</a>`;
}
async function enviarArquivos(files) {
  let ultimo;
  for (const f of files) {
    const a = { id: uid(), titulo: f.name.replace(/\.[^.]+$/, ''), criada: f.lastModified || Date.now(), origem: 'arquivo', tipo: f.type || 'audio/mp4', blob: f, duracao: 0, marcas: [], segs: [], notas: '' };
    try { await Aulas.put(a); ultimo = a.id; } catch { toast(`Não consegui guardar “${f.name}”. Verifique o espaço livre.`); }
  }
  if (ultimo) { toast(files.length > 1 ? `${files.length} aulas adicionadas.` : 'Aula adicionada.'); location.hash = '#aula/' + ultimo; }
}

/* ---------- Tela: Aula ---------- */
async function viewAula(id, t) {
  const a = await Aulas.get(id);
  if (!a) { view.innerHTML = '<div class="card">Aula não encontrada. <a href="#aulas">Voltar</a></div>'; return; }
  aulaAberta = id;
  const url = URL.createObjectURL(a.blob); urls.push(url);
  const video = a.tipo?.startsWith('video');
  const modelo = await KV.get('modelo', MODELOS[isTouch ? 0 : 1][0]);
  view.innerHTML = `
  <p><a href="#aulas">← Aulas</a></p>
  <input id="titulo" class="title-input" value="${esc(a.titulo)}" aria-label="Título da aula">
  <p class="muted">${dataBR(a.criada)} · ${a.origem === 'gravada' ? 'Gravada no app' : 'Arquivo enviado'}</p>
  <div class="card">
    ${video ? `<video id="player" src="${url}" controls playsinline preload="metadata"></video>` : `<audio id="player" src="${url}" controls preload="metadata"></audio>`}
    <div id="reparo" class="card warn" style="margin:10px 0 0" hidden><b>Este áudio não abre neste navegador.</b>
      <p class="muted" style="margin:6px 0 10px">Foram gravados ${(a.blob.size / 1048576).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB. O app pode converter a gravação para WAV aqui mesmo, sem enviar para a internet. Depois ela toca e pode ser transcrita normalmente.</p>
      <div class="row"><button id="reparar" class="primary">Reparar áudio</button><span class="muted" id="reparoSt"></span></div></div>
    <div class="row" style="margin-top:8px"><span class="muted">Velocidade</span>${[1, 1.25, 1.5, 1.75, 2].map(v => `<button class="mini vel" data-v="${v}">${String(v).replace('.', ',')}×</button>`).join('')}
    <button class="mini" id="voltar10">−10 s</button></div>
    ${a.marcas?.length ? `<h3 style="margin-top:14px">Momentos marcados</h3>${a.marcas.map(m => `<div class="line"><button class="time" data-t="${m.t}">${fmt(m.t)}</button><span>${esc(m.texto)}</span></div>`).join('')}` : ''}
  </div>
  ${sessionStorage.getItem('recemGravada') === id ? `<div class="card warn" id="arqTranscr"><b>Arquivo da aula para transcrição</b>
    <p class="muted" style="margin:6px 0 10px">${IOS || INSTALADO ? 'Toque para salvar o arquivo (no app instalado, abre a janela de compartilhar: salve em Arquivos, OneDrive ou envie por AirDrop).' : 'O áudio já foi salvo em Downloads em WAV.'} A versão WAV funciona em qualquer programa de transcrição.</p>
    <div class="row"><button class="primary" data-salvar="orig">Salvar áudio da aula</button><button data-salvar="wav">Salvar em WAV</button><button data-salvar="ok">Pronto</button></div></div>` : ''}
  <div class="card"><h3>Contratos tratados nesta aula</h3><div id="citados" class="row"></div></div>
  <div class="card">
    <div class="row"><h3 class="grow" style="margin:0">Transcrição</h3>
      <select id="modelo" aria-label="Modelo de transcrição">${MODELOS.map(([v, n]) => `<option value="${v}" ${v === modelo ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <button id="transcrever" class="primary" ${job ? 'disabled' : ''}>${a.segs?.length ? 'Transcrever de novo' : 'Transcrever'}</button></div>
    <p id="tstatus" class="muted"></p>
    <p class="muted">Feita neste aparelho. Na primeira vez, o app baixa o modelo (base: cerca de 80 MB; preciso: cerca de 250 MB). Mantenha a tela aberta. Confira termos técnicos e números de artigos.</p>
    <input id="busca" type="search" placeholder="Buscar na transcrição">
    <div id="segs" class="scroll" style="margin-top:8px"></div>
    <details style="margin-top:10px"><summary>Já tem a transcrição? Colar texto</summary>
      <p class="muted">Uma frase por linha. Pode começar com o tempo, ex.: [12:30] texto.</p>
      <textarea id="colar"></textarea><button id="usarColado" style="margin-top:8px">Usar este texto</button></details>
  </div>
  <div class="card"><h3>Minhas anotações</h3><textarea id="notas" placeholder="Resumo, dúvidas, o que o professor disse que cai na prova…">${esc(a.notas)}</textarea>
    <p class="muted" id="notasSt"></p></div>
  <div class="card row"><button id="baixarAudio">Exportar áudio</button><button id="baixarWav">Áudio em WAV (para transcrição)</button><button id="baixarTxt">Transcrição (.txt)</button><button id="baixarSrt">Legenda (.srt)</button>
    <span class="grow"></span><button id="apagar" class="danger">Apagar aula</button></div>
  <div id="confirmar"></div>`;

  const player = $('#player');
  const mostrarReparo = () => { if (a.blob.size > 2000) $('#reparo').hidden = false; else toast('A gravação desta aula ficou vazia.'); };
  player.onerror = mostrarReparo;
  $('#reparar').onclick = () => repararAula(id);
  const ir = s => { player.currentTime = +s; player.play().catch(() => {}); };
  view.querySelectorAll('.vel').forEach(b => b.onclick = () => { player.playbackRate = +b.dataset.v; });
  $('#voltar10').onclick = () => { player.currentTime = Math.max(0, player.currentTime - 10); };
  player.onloadedmetadata = () => { if (!a.duracao && isFinite(player.duration)) alterarAula(id, x => { x.duracao = player.duration; }); if (t) player.currentTime = +t; };
  player.ontimeupdate = () => {
    const tt = player.currentTime; let ativo = null;
    view.querySelectorAll('#segs .line').forEach(l => { if (+l.dataset.ini <= tt) ativo = l; l.classList.remove('now'); });
    ativo?.classList.add('now');
  };
  $('#titulo').onchange = e => alterarAula(id, x => { x.titulo = e.target.value.trim() || 'Aula sem título'; });
  $('#modelo').onchange = e => KV.set('modelo', e.target.value);
  $('#transcrever').onclick = () => transcrever(id, $('#modelo').value);
  $('#busca').oninput = () => desenharSegs(null);
  $('#usarColado').onclick = () => {
    const segs = $('#colar').value.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
      const m = l.match(/^\[?(?:(\d+):)?(\d{1,2}):(\d{2})\]?\s*(.*)$/);
      return m ? { t: (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]), text: m[4] } : { t: null, text: l };
    });
    alterarAula(id, x => { x.segs = segs; x.transcricao = 'ok'; }).then(() => { toast('Transcrição salva.'); route(); });
  };
  let tm; $('#notas').oninput = e => { $('#notasSt').textContent = 'Salvando…'; clearTimeout(tm); tm = setTimeout(() => alterarAula(id, x => { x.notas = e.target.value; }).then(() => { $('#notasSt').textContent = 'Salvo'; desenharCitados(null); }), 600); };
  $('#baixarTxt').onclick = async () => { const x = await Aulas.get(id); salvarArquivo(new Blob([(x.segs || []).map(s => (s.t != null ? `[${fmt(s.t)}] ` : '') + s.text).join('\n') + (x.notas ? '\n\nANOTAÇÕES\n' + x.notas : '')], { type: 'text/plain' }), x.titulo + '.txt'); };
  $('#baixarAudio').onclick = () => salvarArquivo(a.blob, a.titulo + extensao(a.tipo));
  $('#baixarWav').onclick = () => salvarWav(a);
  $('#baixarSrt').onclick = async () => { const x = await Aulas.get(id); if (!x.segs?.some(s => s.t != null)) { toast('A legenda precisa de uma transcrição com tempos.'); return; } salvarArquivo(new Blob([srt(x.segs)], { type: 'application/x-subrip' }), x.titulo + '.srt'); };
  view.querySelectorAll('[data-salvar]').forEach(b => b.onclick = () => {
    if (b.dataset.salvar === 'orig') salvarArquivo(a.blob, a.titulo + extensao(a.tipo));
    if (b.dataset.salvar === 'wav') salvarWav(a);
    if (b.dataset.salvar === 'ok') { sessionStorage.removeItem('recemGravada'); $('#arqTranscr')?.remove(); }
  });
  $('#apagar').onclick = () => {
    $('#confirmar').innerHTML = `<div class="card warn"><b>Apagar “${esc(a.titulo)}”?</b> O áudio, a transcrição e as anotações saem deste aparelho e não podem ser recuperados, a menos que você tenha um backup.
      <div class="row" style="margin-top:8px"><button id="simApagar" class="primary">Apagar de vez</button><button id="naoApagar">Cancelar</button></div></div>`;
    $('#simApagar').onclick = async () => { await Aulas.del(id); toast('Aula apagada.'); location.hash = '#aulas'; };
    $('#naoApagar').onclick = () => { $('#confirmar').innerHTML = ''; };
    $('#confirmar').scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  view.onclick = async e => {
    const tb = e.target.closest('button.time[data-t]'); if (tb) { ir(tb.dataset.t); return; }
    const b = e.target.closest('[data-cartao]');
    if (b) { sessionStorage.setItem('novoCartao', b.closest('.line').querySelector('span').textContent); location.hash = '#cartoes'; return; }
    const f = e.target.closest('[data-fixar]'); if (!f) return;
    const linha = f.closest('.line'); if (linha.nextElementSibling?.classList.contains('fixar')) { linha.nextElementSibling.remove(); return; }
    const x = await Aulas.get(id); const i = +f.dataset.fixar; const s = x.segs[i];
    const sugestao = citados(s.text)[0]?.[0] || citados((x.segs || []).map(s => s.text).join(' '))[0]?.[0] || '';
    const box = document.createElement('div'); box.className = 'fixar'; linha.after(box);
    formTrecho(box, { texto: s.text, aulaId: id, aulaTitulo: x.titulo, t: s.t, contrato: sugestao, proximas: x.segs.slice(i + 1).map(s => s.text) }, () => { box.remove(); desenharSegs(null); });
  };
  atualizarTranscricao();
}

/* ---------- Trechos de aula incorporados aos contratos ---------- */
const SECOES = [['conceito', 'Conceito e classificação'], ['cc', 'Código Civil'], ['cpc', 'Processo Civil (CPC)'], ['leis', 'Leis esparsas e súmulas'], ['doutrina', 'Doutrina'], ['exemplos', 'Exemplos e casos']];
const Trechos = { all: () => KV.get('trechos', []), save: v => KV.set('trechos', v) };
function formTrecho(box, d, aoSalvar) {
  let extra = 0;
  box.innerHTML = `<div class="card warn" style="margin:8px 0">
    <b>Incorporar ao conteúdo do contrato</b>
    <div class="row" style="margin-top:8px">
      ${d.contratoFixo ? '' : `<select class="grow" data-c aria-label="Contrato"><option value="">Escolha o contrato</option>${CONTRATOS.map(c => `<option value="${c.id}" ${c.id === d.contrato ? 'selected' : ''}>${esc(c.nome)}</option>`).join('')}</select>`}
      <select class="grow" data-s aria-label="Seção">${SECOES.map(([v, n]) => `<option value="${v}">${n}</option>`).join('')}</select></div>
    <label class="muted" style="display:block;margin-top:8px">Texto (corrija a transcrição, se precisar)</label>
    <textarea data-tx style="min-height:80px">${esc(d.texto)}</textarea>
    <div class="row" style="margin-top:8px">
      ${d.proximas?.length ? '<button class="mini" data-mais>+ frase seguinte</button>' : ''}
      <span class="grow"></span><button data-cancel>Cancelar</button><button class="primary" data-ok>Incorporar</button></div></div>`;
  const q = s => box.querySelector(s);
  q('[data-mais]')?.addEventListener('click', ev => { ev.stopPropagation(); if (extra < d.proximas.length) q('[data-tx]').value += ' ' + d.proximas[extra++]; if (extra >= d.proximas.length) ev.target.disabled = true; });
  q('[data-cancel]').onclick = ev => { ev.stopPropagation(); box.remove(); };
  q('[data-ok]').onclick = async ev => {
    ev.stopPropagation();
    const contrato = d.contratoFixo || q('[data-c]').value, texto = q('[data-tx]').value.trim();
    if (!contrato) { toast('Escolha o contrato.'); return; }
    if (!texto) { toast('O texto está vazio.'); return; }
    const lista = await Trechos.all();
    lista.push({ id: uid(), contrato, secao: q('[data-s]').value, texto, aulaId: d.aulaId, aulaTitulo: d.aulaTitulo, t: d.t, criado: Date.now() });
    await Trechos.save(lista);
    toast(`Incorporado a ${byId[contrato].nome} › ${SECOES.find(s => s[0] === q('[data-s]').value)[1]}.`);
    aoSalvar?.();
  };
}
function htmlDaAula(trechos, secao) {
  const its = trechos.filter(t => t.secao === secao); if (!its.length) return '';
  return `<div class="daaula"><div class="tag">Da aula</div>${its.map(t => `<div class="line" data-trecho="${t.id}">
    ${t.t != null ? `<a class="time btn" href="#aula/${t.aulaId}/${Math.floor(t.t)}" title="${esc(t.aulaTitulo)}">${fmt(t.t)}</a>` : ''}
    <span>${esc(t.texto)} <span class="muted">· ${esc(t.aulaTitulo)}</span></span>
    <button class="mini" data-editar>Editar</button><button class="mini danger" data-remover>Remover</button></div>`).join('')}</div>`;
}
let segsCache = null;
async function desenharSegs(a) {
  if (a) segsCache = a; a = segsCache; const box = $('#segs'); if (!box || !a) return;
  const q = norm($('#busca')?.value.trim() || '');
  const segs = (a.segs || []).filter(s => !q || norm(s.text).includes(q));
  if (!a.segs?.length) { box.innerHTML = `<p class="muted">${job?.id === a.id ? 'Os trechos aparecem aqui conforme ficam prontos.' : 'Ainda sem transcrição.'}</p>`; return; }
  if (!segs.length) { box.innerHTML = '<p class="muted">Nenhum trecho com esse termo.</p>'; return; }
  const realce = txt => { const h = esc(txt); if (!q) return h; const i = norm(txt).indexOf(q); return i < 0 ? h : esc(txt.slice(0, i)) + '<mark>' + esc(txt.slice(i, i + q.length)) + '</mark>' + esc(txt.slice(i + q.length)); };
  const usados = new Set((await Trechos.all()).filter(t => t.aulaId === a.id).map(t => t.t));
  box.innerHTML = segs.map(s => `<div class="line" data-ini="${s.t ?? ''}">${s.t != null ? `<button class="time" data-t="${s.t}">${fmt(s.t)}</button>` : ''}<span>${realce(s.text)}${usados.has(s.t) ? ' <span class="chip">no contrato</span>' : ''}</span><button class="mini" data-fixar="${a.segs.indexOf(s)}" title="Incorporar este trecho ao conteúdo de um contrato">+ contrato</button><button class="mini" data-cartao title="Criar flashcard com este trecho">+ cartão</button></div>`).join('');
}
async function desenharCitados() {
  const box = $('#citados'); if (!box || !aulaAberta) return;
  const a = await Aulas.get(aulaAberta);
  const c = citados((a.segs || []).map(s => s.text).join(' ') + ' ' + (a.notas || ''));
  box.innerHTML = c.length ? c.map(([id, n]) => `<a class="chip" href="#contrato/${id}">${esc(byId[id].nome)} · ${n}</a>`).join('') : '<span class="muted">Aparecem depois da transcrição ou das anotações.</span>';
}
const extensao = t => t?.includes('mp4') ? (t.startsWith('video') ? '.mp4' : '.m4a') : t?.includes('webm') ? '.webm' : t?.includes('mpeg') ? '.mp3' : t?.includes('wav') ? '.wav' : '';

// WAV 16 kHz mono: formato aceito por qualquer serviço de transcrição.
function wav(amostras, taxa = 16000) {
  const buf = new ArrayBuffer(44 + amostras.length * 2), v = new DataView(buf);
  const str = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + amostras.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, taxa, true);
  v.setUint32(28, taxa * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, amostras.length * 2, true);
  for (let i = 0; i < amostras.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, amostras[i])) * 0x7fff, true);
  return new Blob([buf], { type: 'audio/wav' });
}
async function salvarWav(a) {
  toast('Convertendo para WAV…');
  try { await salvarArquivo(wav(await lerAudio(a.blob)), a.titulo + '.wav'); }
  catch { toast('Não consegui converter este áudio. Use “Exportar áudio”.'); }
}
function srt(segs) {
  const ts = s => { const ms = Math.round(s * 1000), h = Math.floor(ms / 36e5), m = Math.floor(ms % 36e5 / 6e4), x = Math.floor(ms % 6e4 / 1000); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
  const c = segs.filter(s => s.t != null);
  return c.map((s, i) => `${i + 1}\n${ts(s.t)} --> ${ts(Math.max(s.t + 1, c[i + 1]?.t ?? s.t + 5))}\n${s.text}\n`).join('\n');
}
async function salvarArquivo(blob, nome, semCompartilhar) {
  nome = nome.replace(/[\\/:*?"<>|]/g, '-');
  const f = new File([blob], nome, { type: blob.type || 'application/octet-stream' });
  if (!semCompartilhar && (isTouch || INSTALADO) && navigator.canShare?.({ files: [f] })) { try { await navigator.share({ files: [f] }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = nome; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

/* ---------- Tela: Contratos ---------- */
async function viewContratos() {
  const aulas = await Aulas.all();
  const mencoes = {};
  for (const a of aulas) for (const [id] of citados((a.segs || []).map(s => s.text).join(' ') + ' ' + (a.notas || ''))) mencoes[id] = (mencoes[id] || 0) + 1;
  view.innerHTML = `<h2>Contratos em espécie</h2>
  <p class="muted">Código Civil, arts. 481 a 853, com os pontos de Processo Civil, leis esparsas e doutrina de cada contrato.</p>
  <input id="filtro" type="search" placeholder="Filtrar por nome ou artigo">
  <div class="grid" id="lista" style="margin-top:12px"></div>`;
  const desenhar = () => {
    const q = norm($('#filtro').value.trim()), n = parseInt(q);
    $('#lista').innerHTML = CONTRATOS.filter(c => !q || norm(c.nome).includes(q) || (n && n >= c.de && n <= c.ate)).map(c =>
      `<a class="card" href="#contrato/${c.id}"><h3>${esc(c.nome)}</h3><div class="muted">${esc(c.artigos)}</div>
       ${mencoes[c.id] ? `<div style="margin-top:6px"><span class="chip">em ${mencoes[c.id]} aula${mencoes[c.id] > 1 ? 's' : ''}</span></div>` : ''}</a>`).join('') || '<p class="muted">Nenhum contrato encontrado.</p>';
  };
  $('#filtro').oninput = desenhar; desenhar();
}
async function viewContrato(id) {
  const c = byId[id]; if (!c) { view.innerHTML = '<div class="card">Contrato não encontrado.</div>'; return; }
  const [aulas, nota, todosTrechos] = await Promise.all([Aulas.all(), KV.get('nota:' + id, ''), Trechos.all()]);
  const meus = todosTrechos.filter(t => t.contrato === id);
  const fixados = new Set(meus.map(t => t.aulaId + '@' + t.t));
  const trechos = [];
  for (const a of aulas) for (const [i, s] of (a.segs || []).entries()) if (citaContrato(s.text, c) && !fixados.has(a.id + '@' + s.t)) trechos.push({ a, s, i });
  const nq = QUESTOES.filter(q => q[0] === id).length;
  const lista = arr => `<ul class="pts">${arr.map(p => `<li>${esc(p)}</li>`).join('')}</ul>`;
  view.innerHTML = `
  <p><a href="#contratos">← Contratos</a></p>
  <h2 style="margin-top:0">${esc(c.nome)}</h2><p class="muted">${esc(c.artigos)} ·
   <a href="${id === 'seguro' ? LINKS.seguro : LINKS.cc}" target="_blank" rel="noopener">texto da lei no Planalto</a>
   ${meus.length ? ` · <span class="chip">${meus.length} trecho${meus.length > 1 ? 's' : ''} das aulas</span>` : ''}</p>
  <div class="card"><div class="tag">Conceito</div><p>${esc(c.conceito)}</p><div class="tag">Classificação</div><p style="margin-bottom:0">${esc(c.classificacao)}</p>${htmlDaAula(meus, 'conceito')}</div>
  <div class="card law"><div class="tag">Código Civil</div>${lista(c.pontos)}${htmlDaAula(meus, 'cc')}</div>
  <div class="card law"><div class="tag">Processo Civil (CPC)</div>${lista(c.cpc)}<p class="muted" style="margin:0"><a href="${LINKS.cpc}" target="_blank" rel="noopener">CPC no Planalto</a></p>${htmlDaAula(meus, 'cpc')}</div>
  <div class="card law"><div class="tag">Leis esparsas e súmulas</div>${lista(c.leis)}${htmlDaAula(meus, 'leis')}</div>
  <div class="card law"><div class="tag">Doutrina: questão para estudar</div><p>${esc(c.doutrina)}</p>
   <p class="muted" style="margin:0">Aprofunde nos manuais da aba Backup › Bibliografia, sempre pela edição mais recente.</p>${htmlDaAula(meus, 'doutrina')}</div>
  ${meus.some(t => t.secao === 'exemplos') ? `<div class="card law"><div class="tag">Exemplos e casos</div>${htmlDaAula(meus, 'exemplos')}</div>` : ''}
  <div class="card"><h3>Citado nas suas aulas</h3><p class="muted">Trechos que mencionam este contrato. Use “Incorporar” para levar o trecho a uma seção acima.</p>
   ${trechos.length ? trechos.slice(0, 40).map(({ a, s, i }) => `<div class="line" data-aula="${a.id}" data-i="${i}">${s.t != null ? `<a class="time btn" href="#aula/${a.id}/${Math.floor(s.t)}">${fmt(s.t)}</a>` : ''}<span>${esc(s.text)} <span class="muted">· ${esc(a.titulo)}</span></span><button class="mini" data-incorporar>Incorporar</button></div>`).join('') + (trechos.length > 40 ? `<p class="muted">E mais ${trechos.length - 40} trechos.</p>` : '') : '<p class="muted">Nenhum outro trecho transcrito cita este contrato.</p>'}</div>
  <div class="card"><h3>Minhas anotações sobre ${esc(c.nome.toLowerCase())}</h3><textarea id="nota">${esc(nota)}</textarea><p class="muted" id="notaSt"></p></div>
  <div class="card row"><a class="btn" href="#cartoes" id="irCartoes">Revisar flashcards</a>${nq ? `<a class="btn primary" href="#questoes" id="irQuestoes">Fazer ${nq} questões</a>` : ''}</div>`;
  let tm; $('#nota').oninput = e => { $('#notaSt').textContent = 'Salvando…'; clearTimeout(tm); tm = setTimeout(() => KV.set('nota:' + id, e.target.value).then(() => $('#notaSt').textContent = 'Salvo'), 500); };
  $('#irCartoes').onclick = () => sessionStorage.setItem('filtro', id);
  if ($('#irQuestoes')) $('#irQuestoes').onclick = () => sessionStorage.setItem('filtro', id);
  view.onclick = async e => {
    const inc = e.target.closest('[data-incorporar]');
    if (inc) {
      const linha = inc.closest('.line'); if (linha.nextElementSibling?.classList.contains('fixar')) { linha.nextElementSibling.remove(); return; }
      const a = aulas.find(a => a.id === linha.dataset.aula), i = +linha.dataset.i, s = a.segs[i];
      const box = document.createElement('div'); box.className = 'fixar'; linha.after(box);
      formTrecho(box, { texto: s.text, aulaId: a.id, aulaTitulo: a.titulo, t: s.t, contratoFixo: id, proximas: a.segs.slice(i + 1).map(s => s.text) }, route);
      return;
    }
    const item = e.target.closest('[data-trecho]'); if (!item) return;
    const tid = item.dataset.trecho;
    if (e.target.closest('[data-remover]')) { await Trechos.save((await Trechos.all()).filter(t => t.id !== tid)); toast('Trecho removido do contrato. A aula continua com ele.'); route(); }
    else if (e.target.closest('[data-editar]')) {
      const t = (await Trechos.all()).find(t => t.id === tid);
      item.innerHTML = `<div style="flex:1"><textarea data-ed style="min-height:70px">${esc(t.texto)}</textarea>
        <div class="row" style="margin-top:6px"><select data-sec aria-label="Seção">${SECOES.map(([v, n]) => `<option value="${v}" ${v === t.secao ? 'selected' : ''}>${n}</option>`).join('')}</select>
        <span class="grow"></span><button class="mini" data-cancelar>Cancelar</button><button class="mini primary" data-gravar>Salvar</button></div></div>`;
      item.querySelector('[data-cancelar]').onclick = ev => { ev.stopPropagation(); route(); };
      item.querySelector('[data-gravar]').onclick = async ev => {
        ev.stopPropagation(); const l = await Trechos.all(); const x = l.find(x => x.id === tid);
        x.texto = item.querySelector('[data-ed]').value.trim() || x.texto; x.secao = item.querySelector('[data-sec]').value;
        await Trechos.save(l); toast('Trecho atualizado.'); route();
      };
    }
  };
}

/* ---------- Tela: Flashcards (repetição espaçada) ---------- */
const INTERVALOS = [0, 1, 3, 7, 16, 35, 90]; // dias por caixa
function cartoesAuto() {
  const out = [];
  for (const c of CONTRATOS) {
    out.push({ id: `a:${c.id}:conceito`, contrato: c.id, frente: `${c.nome}: qual o conceito?`, verso: c.conceito });
    out.push({ id: `a:${c.id}:class`, contrato: c.id, frente: `${c.nome}: como se classifica?`, verso: c.classificacao });
    [...c.pontos, ...c.cpc].forEach((p, i) => {
      const oculto = p.replace(/\(([^)]*(art\.|arts\.|Súmula)[^)]*)\)/g, '(qual dispositivo?)');
      if (oculto !== p) out.push({ id: `a:${c.id}:p${i}`, contrato: c.id, frente: `${c.nome}: ${oculto}`, verso: p });
    });
  }
  return out;
}
async function viewCartoes() {
  const [meus, srs] = await Promise.all([KV.get('cartoes', []), KV.get('srs', {})]);
  const todos = [...meus, ...cartoesAuto()];
  const prefill = sessionStorage.getItem('novoCartao'); sessionStorage.removeItem('novoCartao');
  let filtro = sessionStorage.getItem('filtro') || ''; sessionStorage.removeItem('filtro');
  const sugestao = prefill ? (citados(prefill)[0]?.[0] || '') : '';
  const agora = Date.now();
  view.innerHTML = `<h2>Flashcards</h2>
  <div class="row"><select id="fcFiltro" class="grow" aria-label="Contrato"><option value="">Todos os contratos</option>${CONTRATOS.map(c => `<option value="${c.id}">${esc(c.nome)}</option>`).join('')}</select>
  <button id="novo">Criar cartão</button></div>
  <div id="form" class="card" style="margin-top:12px" ${prefill ? '' : 'hidden'}><h3>Novo cartão</h3>
    <label class="muted" for="frente">Frente (pergunta)</label><textarea id="frente" style="min-height:70px">${esc(prefill || '')}</textarea>
    <label class="muted" for="verso">Verso (resposta)</label><textarea id="verso" style="min-height:70px"></textarea>
    <div class="row" style="margin-top:8px"><select id="fcContrato" aria-label="Contrato do cartão"><option value="">Sem contrato</option>${CONTRATOS.map(c => `<option value="${c.id}" ${c.id === sugestao ? 'selected' : ''}>${esc(c.nome)}</option>`).join('')}</select>
    <button id="salvarCartao" class="primary">Salvar cartão</button><button id="cancelarCartao">Cancelar</button></div></div>
  <div id="sessao" style="margin-top:12px"></div>
  ${meus.length ? `<details class="card"><summary>Meus cartões (${meus.length})</summary>${meus.map(m => `<div class="line"><span><b>${esc(m.frente)}</b><br>${esc(m.verso)}</span><button class="mini danger" data-del="${m.id}">Excluir</button></div>`).join('')}</details>` : ''}`;
  $('#fcFiltro').value = filtro;
  $('#novo').onclick = () => { $('#form').hidden = false; $('#frente').focus(); };
  $('#cancelarCartao').onclick = () => { $('#form').hidden = true; };
  $('#salvarCartao').onclick = async () => {
    const frente = $('#frente').value.trim(), verso = $('#verso').value.trim();
    if (!frente || !verso) { toast('Preencha a frente e o verso.'); return; }
    await KV.set('cartoes', [{ id: 'u:' + uid(), contrato: $('#fcContrato').value, frente, verso }, ...meus]); toast('Cartão criado.'); route();
  };
  view.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { await KV.set('cartoes', meus.filter(m => m.id !== b.dataset.del)); toast('Cartão excluído.'); route(); });
  let fila = [], atual, mostrado = false;
  const montar = () => {
    filtro = $('#fcFiltro').value;
    fila = todos.filter(c => (!filtro || c.contrato === filtro) && (srs[c.id]?.due ?? 0) <= agora)
      .sort((a, b) => (srs[a.id]?.due ?? 0) - (srs[b.id]?.due ?? 0) || Math.random() - .5);
    proximo();
  };
  const proximo = () => {
    atual = fila.shift(); mostrado = false; const box = $('#sessao');
    if (!atual) { const prox = todos.filter(c => !filtro || c.contrato === filtro).map(c => srs[c.id]?.due).filter(Boolean).sort()[0];
      box.innerHTML = `<div class="card flash"><b>Nada para revisar agora.</b><span class="muted">${prox ? 'Próxima revisão: ' + new Date(prox).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}</span></div>`; return; }
    const cx = srs[atual.id]?.cx || 0;
    box.innerHTML = `<p class="muted">${fila.length + 1} para revisar · caixa ${cx}${atual.contrato ? ' · ' + esc(byId[atual.contrato]?.nome) : ''}</p>
     <div class="card flash"><div>${esc(atual.frente)}</div><div class="ans" id="ans" hidden>${esc(atual.verso)}</div></div>
     <div class="row" id="acoes"><button id="mostrar" class="primary grow">Mostrar resposta</button></div>`;
    $('#mostrar').onclick = mostrar;
  };
  const mostrar = () => {
    mostrado = true; $('#ans').hidden = false;
    $('#acoes').innerHTML = `<button id="errei" class="grow">Errei (revisar já)</button><button id="acertei" class="primary grow">Acertei</button>`;
    $('#errei').onclick = () => responder(false); $('#acertei').onclick = () => responder(true);
  };
  const responder = async ok => {
    const cx = ok ? Math.min((srs[atual.id]?.cx || 0) + 1, INTERVALOS.length - 1) : 0;
    srs[atual.id] = { cx, due: ok ? Date.now() + INTERVALOS[cx] * 864e5 : Date.now() + 6e4 };
    if (!ok) fila.push(atual);
    await KV.set('srs', srs); proximo();
  };
  document.onkeydown = e => {
    if (!location.hash.startsWith('#cartoes') || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || !atual) return;
    if (e.key === ' ' && !mostrado) { e.preventDefault(); mostrar(); }
    else if (mostrado && e.key === '1') responder(false); else if (mostrado && e.key === '2') responder(true);
  };
  $('#fcFiltro').onchange = montar; montar();
}

/* ---------- Tela: Questões ---------- */
async function viewQuestoes() {
  const hist = await KV.get('quiz', {});
  let filtro = sessionStorage.getItem('filtro') || ''; sessionStorage.removeItem('filtro');
  view.innerHTML = `<h2>Questões</h2>
  <div class="row"><select id="qFiltro" class="grow" aria-label="Contrato"><option value="">Todos os contratos</option>${CONTRATOS.filter(c => QUESTOES.some(q => q[0] === c.id)).map(c => `<option value="${c.id}">${esc(c.nome)}</option>`).join('')}</select>
  <button id="recomecar">Recomeçar</button></div><div id="quiz" style="margin-top:12px"></div>`;
  $('#qFiltro').value = filtro;
  let lista, i, acertos;
  const iniciar = () => { filtro = $('#qFiltro').value; lista = QUESTOES.filter(q => !filtro || q[0] === filtro).sort(() => Math.random() - .5); i = 0; acertos = 0; mostrar(); };
  const mostrar = () => {
    const box = $('#quiz');
    if (i >= lista.length) { box.innerHTML = `<div class="card flash"><b>${acertos} de ${lista.length} certas</b><button id="denovo" class="primary">Fazer de novo</button></div>`; $('#denovo').onclick = iniciar; return; }
    const [cid, perg, alts, expl] = lista[i];
    const ops = alts.map((t, k) => ({ t, certa: k === 0 })).sort(() => Math.random() - .5);
    const h = hist[perg];
    box.innerHTML = `<p class="muted">Questão ${i + 1} de ${lista.length} · ${esc(byId[cid].nome)}${h ? ` · você já acertou ${h.ok} de ${h.n}` : ''}</p>
     <div class="card"><p style="margin-top:0"><b>${esc(perg)}</b></p>${ops.map((o, k) => `<button class="opt" data-k="${k}">${'ABCD'[k]}) ${esc(o.t)}</button>`).join('')}
     <div id="expl" hidden></div></div>`;
    box.querySelectorAll('.opt').forEach(b => b.onclick = async () => {
      const ok = ops[b.dataset.k].certa; if (ok) acertos++;
      box.querySelectorAll('.opt').forEach(x => { x.disabled = true; if (ops[x.dataset.k].certa) x.classList.add('right'); });
      if (!ok) b.classList.add('wrong');
      hist[perg] = { n: (h?.n || 0) + 1, ok: (h?.ok || 0) + (ok ? 1 : 0) }; KV.set('quiz', hist);
      const e = $('#expl'); e.hidden = false;
      e.innerHTML = `<p><b>${ok ? 'Certo.' : 'Errado.'}</b> ${esc(expl)} <a href="#contrato/${cid}">Rever o contrato</a></p><button id="prox" class="primary">Próxima</button>`;
      $('#prox').onclick = () => { i++; mostrar(); }; $('#prox').focus();
    });
  };
  $('#qFiltro').onchange = iniciar; $('#recomecar').onclick = iniciar; iniciar();
}

/* ---------- Tela: Backup ---------- */
const paraDataURL = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(b); });
async function viewBackup() {
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const persist = await navigator.storage?.persisted?.().catch(() => null);
  const aulas = await Aulas.all();
  const mb = n => (n / 1048576).toLocaleString('pt-BR', { maximumFractionDigits: 0 }) + ' MB';
  view.innerHTML = `<h2>Backup e armazenamento</h2>
  <div class="card"><h3>Onde ficam seus dados</h3>
   <p>Aulas, transcrições, anotações e progresso ficam só neste aparelho, dentro do navegador. No Mac, no iPhone e no tablet os dados são separados. Para levar de um para o outro, exporte aqui e importe no outro aparelho.</p>
   <p class="muted">${aulas.length} aula(s) · ${est ? `uso: ${mb(est.usage)}` : 'uso não informado pelo navegador'} · ${persist ? 'armazenamento protegido' : 'o navegador pode apagar os dados se faltar espaço'}</p>
   ${persist ? '' : '<button id="proteger">Pedir para proteger os dados</button>'}
   <p class="muted">Apagar os dados do site no navegador, ou remover o app da Tela de Início, apaga as aulas. Faça backup com frequência.</p></div>
  <div class="card"><h3>Exportar</h3><div class="row"><button id="expTudo" class="primary">Exportar tudo (com áudio)</button><button id="expLeve">Exportar sem áudio</button></div>
   <p class="muted">O arquivo com áudio pode ficar grande.</p></div>
  <div class="card"><h3>Importar</h3><label class="btn">Escolher arquivo de backup<input id="imp" type="file" accept=".json,application/json" hidden></label>
   <p class="muted">Junta com o que já existe. Aulas com o mesmo identificador são substituídas.</p></div>
  <div class="card"><h3>Bibliografia sugerida</h3><ul class="pts">${BIBLIOGRAFIA.map(b => `<li>${esc(b)}</li>`).join('')}</ul>
   <p class="muted">Use sempre a edição mais recente: seguro (Lei 15.040/2024) e juros (Lei 14.905/2024) mudaram há pouco.</p></div>
  <div class="card muted">Material de apoio ao estudo. Confira a redação vigente da lei, súmulas e temas nas fontes oficiais antes de usar em prova ou peça.</div>`;
  if ($('#proteger')) $('#proteger').onclick = async () => { const ok = await navigator.storage?.persist?.().catch(() => false); toast(ok ? 'Dados protegidos.' : 'O navegador não liberou a proteção. Instalar o app na tela inicial ajuda.'); route(); };
  const exportar = async comAudio => {
    toast('Preparando o backup…');
    const keys = await KV.keys(), kv = {};
    for (const k of keys) if (k !== 'rascunho') kv[k] = await KV.get(k);
    const partes = [`{"app":"contratos-em-especie","versao":1,"exportado":${Date.now()},"kv":${JSON.stringify(kv)},"aulas":[`];
    for (const [n, a] of aulas.entries()) {
      const { blob, ...resto } = a;
      if (comAudio) resto.audio = await paraDataURL(blob);
      partes.push((n ? ',' : '') + JSON.stringify(resto));
    }
    partes.push(']}');
    await salvarArquivo(new Blob(partes, { type: 'application/json' }), `contratos-backup-${new Date().toISOString().slice(0, 10)}${comAudio ? '' : '-sem-audio'}.json`);
  };
  $('#expTudo').onclick = () => exportar(true).catch(() => toast('Não consegui gerar o backup.'));
  $('#expLeve').onclick = () => exportar(false).catch(() => toast('Não consegui gerar o backup.'));
  $('#imp').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (d.app !== 'contratos-em-especie') throw new Error('arquivo de outro app');
      for (const [k, v] of Object.entries(d.kv || {})) { // listas e progresso são somados ao que já existe
        const atual = await KV.get(k);
        if (Array.isArray(v) && Array.isArray(atual)) { const ids = new Set(v.map(x => x.id)); await KV.set(k, [...v, ...atual.filter(x => !ids.has(x.id))]); }
        else if (v && atual && typeof v === 'object' && typeof atual === 'object') await KV.set(k, { ...atual, ...v });
        else await KV.set(k, v);
      }
      let n = 0;
      for (const a of d.aulas || []) {
        const atual = await Aulas.get(a.id);
        const blob = a.audio ? await (await fetch(a.audio)).blob() : atual?.blob;
        if (!blob) continue; delete a.audio;
        await Aulas.put({ ...a, blob }); n++;
      }
      const semAudio = (d.aulas || []).length - n;
      toast(`Backup importado: ${n} aula(s).${semAudio ? ` ${semAudio} ignorada(s) por não ter áudio aqui.` : ''}`); location.hash = '#aulas';
    } catch (err) { toast('Não consegui importar: ' + err.message); }
  };
}

/* ---------- Início ---------- */
addEventListener('beforeunload', e => { if (rec.mr) { e.preventDefault(); e.returnValue = ''; } });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
route();
