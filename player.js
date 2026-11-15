// 재생 화면 — 서버 모드(?live=1: 로컬 엔진이 대본·영상 상태를 보냄)와 정적 모드(#z= / #s= / #t= / 붙여넣기).
// 해석·배치·박자·그리기는 영상 렌더러와 같은 core 모듈을 쓴다.
import { makeFonts, buildTimeline, Board, timelineSig, PackFonts } from './core/lecture.js';

const $ = (id) => document.getElementById(id);
const canvas = $('board');
const ctx = canvas.getContext('2d');
const params = new URLSearchParams(location.search);
const LIVE = params.has('live');
const HOLD = 1.0;
const FPS = 24;
const BASE = new URL('./', import.meta.url).href; // 재생기 폴더(GitHub Pages 하위 경로에서도 맞게)
const env = { createCanvas: (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; } };
const loadBytes = (rel) => fetch(BASE + rel).then((r) => { if (!r.ok) throw new Error(rel + ' ' + r.status); return r.arrayBuffer(); });

let F = null, boardCfg = {}, tl = null, board = null, scriptText = '';
let t = 0, playing = true, lastNow = null, lastPaint = -1e9, lastKey = null;
let reported = {}, videoText = '', stallAcc = 0, note = '';
let gotConfig; const configReady = new Promise((r) => { gotConfig = r; });
const portrait = matchMedia('(orientation: portrait)');
window.__lb = { get t() { return t; }, get tl() { return tl; }, get sig() { return tl ? timelineSig(tl) : null; }, firstDrawMs: null, fontsMs: null, timelineMs: null };

function report(ev, extra = {}) {
  if (!LIVE) return;
  try { fetch('api/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ev, wall: Date.now(), ...extra }), keepalive: true }); } catch { /* 없음 */ }
}
function fmt(s) { s = Math.max(0, s); const m = Math.floor(s / 60); return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`; }
function setMsg() {
  let s;
  if (note) s = note;
  else if (!tl) s = '준비 중';
  else {
    s = portrait.matches ? `${fmt(t)}/${fmt(tl.end + (tl.ended ? HOLD : 0))}` : `${fmt(t)} / ${fmt(tl.end + (tl.ended ? HOLD : 0))}`;
    if (!tl.ended && t >= tl.end - 1e-6) s = '다음 대본 기다리는 중 ' + s;
    if (LIVE) s += '  ·  ' + (videoText || '영상 만드는 중');
  }
  if ($('msg').textContent !== s) $('msg').textContent = s;
}
let capShown = null;
function setCaption() {
  if (!portrait.matches || !board) return;
  const s = board.captionText(t);
  if (s !== capShown) { $('cap').textContent = s; capShown = s; }
}

function applyScript(text, ended) {
  if (!F) return;
  scriptText = text;
  const nt = buildTimeline(text, F, boardCfg, { final: !LIVE || ended });
  if (F.missing && F.missing.size) return; // 글자 조각을 더 받은 뒤 다시
  tl = nt;
  if (!LIVE) tl.ended = true;
  if (!board) board = new Board(env, tl); else board.setTimeline(tl);
  lastKey = null;
  if (tl.errors.length) console.warn(tl.errors.map((e) => `${e.line}번째 줄: ${e.msg}`).join('\n'));
  if (LIVE && tl.ended && !reported.sig) { reported.sig = 1; report('syncCheck', { sig: timelineSig(tl), end: tl.end }); }
  if (!LIVE) $('bSave').disabled = false;
}

function limit() { return tl ? (tl.ended ? tl.end + HOLD : tl.end) : 0; }
function frame(now) {
  if (lastNow == null) lastNow = now;
  const dt = Math.min(0.25, (now - lastNow) / 1000);
  lastNow = now;
  if (tl && playing) {
    if (!reported.clock) { reported.clock = 1; report('clockStart'); }
    const lim = limit();
    const nt = Math.min(t + dt, lim);
    // 다음 대본을 기다리며 멈춘 시간(이어 붙이기 끊김) 기록
    if (!tl.ended && t + dt > lim + 1e-6) { stallAcc += t + dt - lim; } else if (stallAcc > 0) { report('stall', { at: +t.toFixed(2), sec: +stallAcc.toFixed(3) }); stallAcc = 0; }
    t = nt;
  }
  if (board && now - lastPaint >= 30) { // 30 fps 상한, 바뀐 것 없는 프레임은 다시 그리지 않음
    lastPaint = now;
    board.advance(t);
    const k = board.key(t);
    if (!(k && k === lastKey)) board.paint(ctx, t);
    lastKey = k;
    const a0 = tl.actions[0];
    if (!reported.first && a0 && a0.strokes.length && t >= a0.t0 + a0.strokes[0].st) { reported.first = 1; window.__lb.firstDrawMs = Math.round(performance.now()); report('firstDraw', { t }); }
    if (tl.ended && t >= tl.end + HOLD && !reported.end) { reported.end = 1; report('playEnd'); }
    setCaption();
  }
  setMsg();
  requestAnimationFrame(frame);
}

function setPlay(p) { playing = p; $('bPlay').textContent = playing ? '멈춤' : '재생'; }
function togglePlay() {
  if (tl && tl.ended && t >= limit() - 1e-6) { restart(); return; } // 끝난 뒤 누르면 처음부터
  setPlay(!playing);
}
function restart() { t = 0; lastKey = null; reported.end = 0; if (board) board.reset(); setPlay(true); }
$('bPlay').onclick = togglePlay;
$('bRestart').onclick = restart;
$('stage').onclick = togglePlay;
addEventListener('keydown', (e) => { if (e.code === 'Space' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); togglePlay(); } });
portrait.addEventListener?.('change', () => { capShown = null; setCaption(); });

// 전체 화면(지원하는 브라우저만 단추를 보임)
const fsEl = document.documentElement;
if (document.fullscreenEnabled || document.webkitFullscreenEnabled) {
  $('bFull').hidden = false;
  $('bFull').onclick = async () => {
    try {
      if (document.fullscreenElement || document.webkitFullscreenElement) await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      else { await (fsEl.requestFullscreen || fsEl.webkitRequestFullscreen).call(fsEl); try { await screen.orientation.lock('landscape'); } catch { /* 못 돌려도 됨 */ } }
    } catch { /* 없음 */ }
  };
}

// ── 정적 모드: 주소 조각 또는 붙여넣기 ──
function b64urlBytes(s) { s = s.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, ''); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }
/** #t= 너그러운 해석: 올바른 %XX 만 풀고(UTF-8), 나머지 글자는 그대로. '%20' 이 하나도 없으면 '+' 를 빈칸으로 본다 */
export function decodeLoose(s) {
  const plusIsSpace = !/%20/i.test(s);
  const enc = new TextEncoder(), bytes = [];
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === '%' && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 1, i + 3))) { bytes.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 3; continue; }
    if (c === '+' && plusIsSpace) { bytes.push(32); i++; continue; }
    const ch = String.fromCodePoint(s.codePointAt(i));
    for (const b of enc.encode(ch)) bytes.push(b);
    i += ch.length;
  }
  return new TextDecoder().decode(new Uint8Array(bytes)).replace(/\r\n?/g, '\n');
}
async function scriptFromHash() {
  const h = location.hash.slice(1);
  if (h.startsWith('z=')) {
    const ds = new Blob([b64urlBytes(h.slice(2))]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return await new Response(ds).text();
  }
  if (h.startsWith('s=')) return new TextDecoder().decode(b64urlBytes(h.slice(2)));
  if (h.startsWith('t=')) return decodeLoose(h.slice(2));
  return null;
}
function showPaste(show) { $('paste').style.display = show ? 'flex' : 'none'; if (show) $('src').focus(); }
const withEnd = (s) => (/(^|\n)\s*@끝\s*(\n|$)/.test(s) ? s : s.replace(/\n?$/, '\n') + '@끝\n');

// 정적 모드 글꼴: 글꼴 조각(대본에 쓰인 글자가 든 조각만) — 없으면 글꼴 파일을 직접 읽음
let CH = null, chunkIdx = null;
async function staticFonts(text) {
  const t0 = performance.now();
  if (!CH) CH = await import('./core/chunks.js');
  if (chunkIdx === null) { try { chunkIdx = await CH.loadIndex(BASE); } catch { chunkIdx = false; } }
  window.__lb.indexMs = Math.round(performance.now() - t0);
  if (!chunkIdx) { // 조각이 없는 곳(엔진 폴더를 그대로 연 경우)
    if (!F) F = await makeFonts(loadBytes, boardCfg);
    return;
  }
  if (!(F instanceof CH.ChunkFonts)) F = new CH.ChunkFonts(chunkIdx);
  const need = CH.needChunks(chunkIdx, text, boardCfg);
  await CH.loadChunks(BASE, F, Object.entries(need).flatMap(([n, ks]) => [...ks].map((k) => [n, k])));
  window.__lb.fontsMs = Math.round(performance.now() - t0);
}
async function playStatic(text) {
  text = withEnd(text);
  note = '글자 받는 중';
  await staticFonts(text);
  // 미리 고르지 못한 글자(첨자·원문자 등)가 있으면 그 조각을 더 받아 다시 배치
  for (let i = 0; i < 3; i++) {
    if (F.missing) F.missing.clear();
    applyScript(text, true);
    if (!F.missing || !F.missing.size) break;
    await CH.loadChunks(BASE, F, [...F.missing.values()]);
  }
  window.__lb.timelineMs = Math.round(performance.now());
  note = '';
  restart();
}
$('bGo').onclick = () => { const s = $('src').value; if (!s.trim()) return; showPaste(false); playStatic(s).catch(fail); };
$('bClose').onclick = () => showPaste(false);
$('bPaste').onclick = () => { $('src').value = scriptText.replace(/\n?@끝\s*$/, ''); showPaste(true); };
function fail(e) { note = '대본을 읽지 못했습니다: ' + (e && e.message || e); console.error(e); }

// ── 영상 저장(정적 모드) ──
let exporting = false, ready = null;
$('bSave').onclick = async () => {
  if (ready) { const r = ready; await r.save(); return; }
  if (exporting || !tl) return;
  exporting = true; const was = playing; setPlay(false);
  $('bSave').disabled = true;
  try {
    const { exportVideo, fileName, saveFile } = await import('./export.js');
    const res = await exportVideo({ tl, env, fps: FPS, hold: HOLD, noWebCodecs: params.has('rec'), onProgress: (p, how) => { note = `${how} ${Math.round(p * 100)}%`; } }); // ?rec=1: 시험용(실시간 녹화 차선)
    const name = fileName(tl.title, res.ext);
    window.__lb.exported = { bytes: res.blob.size, ms: res.ms, method: res.method, codec: res.codec, name };
    const r = await saveFile(res.blob, name);
    if (r === 'needTap') { // 휴대폰 공유 시트는 한 번 더 눌러야 열림(브라우저 규칙)
      ready = { save: async () => { const x = await saveFile(res.blob, name, true); if (x !== 'needTap') { ready = null; $('bSave').textContent = '영상 저장'; $('bSave').classList.remove('hot'); note = ''; } } };
      $('bSave').textContent = '파일 보내기'; $('bSave').classList.add('hot'); note = '영상 완성';
    } else note = '';
  } catch (e) { note = e.userMsg || ('영상 저장 실패: ' + (e && e.message || e)); console.error(e); setTimeout(() => { if (!exporting) note = ''; }, 8000); }
  exporting = false; $('bSave').disabled = false;
  if (was) setPlay(true);
};

async function main() {
  if (params.has('warm')) { // 미리 띄운 창: 빈 판을 보이고 강의 주소가 오면 그리로 이동
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1280, 720); ctx.fillStyle = '#f3f2ee'; ctx.fillRect(0, 612, 1280, 108);
    $('msg').textContent = '강의 준비 중'; $('bPlay').disabled = true; $('bRestart').disabled = true;
    const es = new EventSource('api/events');
    es.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.type === 'go') { es.close(); location.replace(msg.url); } };
    return;
  }
  report('pageStart', { nav: performance.timeOrigin });
  requestAnimationFrame(frame);
  if (LIVE) {
    const es = new EventSource('api/events');
    es.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.type === 'config') { boardCfg = msg.board || {}; gotConfig(); }
      else if (msg.type === 'script') { if (!F) F = new PackFonts(); F.add(msg.pack); applyScript(msg.text, msg.ended); }
      else if (msg.type === 'video') videoText = msg.done ? `영상 저장됨 ${msg.path}` : `영상 만드는 중 ${Math.round((msg.progress || 0) * 100)}%`;
      else if (msg.type === 'bye') { videoText = '엔진 종료'; es.close(); try { window.close(); } catch { /* 없음 */ } }
    };
    return;
  }
  // 정적 모드
  $('bPaste').hidden = false; $('bSave').hidden = false; $('bSave').disabled = true;
  try {
    const s = await scriptFromHash();
    if (s && s.trim()) await playStatic(s); else { note = '대본을 넣어 주세요'; showPaste(true); }
  } catch (e) { fail(e); showPaste(true); }
  addEventListener('hashchange', async () => { try { const s = await scriptFromHash(); if (s && s.trim()) await playStatic(s); } catch (e) { fail(e); } });
}
main();
// 시험용: 이 시각의 프레임에서 멈춤(?snap=12.5)
if (params.has('snap')) { const ts = +params.get('snap'); const iv = setInterval(() => { if (board && tl) { setPlay(false); t = ts; board.reset(); lastKey = null; clearInterval(iv); } }, 50); }
