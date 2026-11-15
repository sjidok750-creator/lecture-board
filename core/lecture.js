// 강의 한 편 = 대본 글 → 타임라인. 브라우저·Node 가 똑같이 이 함수를 쓴다.
import { FontSet, PackFonts } from './fonts.js';
export { PackFonts };
import { parseScript } from './script.js';
import { Layout, DEFAULTS, boardChain, capChain, mergeCfg } from './layout.js';
export { Board, totalDuration } from './draw.js';
export { DEFAULTS };

export const ENGINE_VERSION = '0.1.0';

/** loadBytes(relPath) → Promise<ArrayBuffer>. relPath 는 web\ 기준(예: fonts/...ttf) */
export async function makeFonts(loadBytes, cfg = {}) {
  const F = new FontSet(loadBytes);
  await F.loadAll(fontChains(cfg)[0]);
  return F;
}

/** 판서·자막 글꼴 사슬(고를 순서) — 배치와 글자 묶음이 같은 순서를 쓴다 */
export function fontChains(cfg = {}) { const b = boardChain(mergeCfg(DEFAULTS, cfg)); return [b, capChain(b)]; }
/** 이 대본에 쓰인 글자만 담은 묶음(서버 → 재생 화면). known: 이미 보낸 글자 키 */
export function makePack(F, text, cfg = {}, known = null) { return F.pack(text, fontChains(cfg), known); }

/** 대본 글 → 타임라인. opts.final: 덜 온 마지막 줄도 읽음 */
export function buildTimeline(text, fonts, cfg = {}, opts = {}) {
  const parsed = parseScript(text, opts);
  const tl = new Layout(fonts, cfg).build(parsed);
  const seen = new Set();
  tl.errors = [...parsed.errors, ...tl.errors]
    .filter((e) => { const k = e.line + e.msg; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.line - b.line);
  tl.title = (parsed.items.find((i) => i.t === 'title') || {}).text || '';
  return tl;
}

/** 오류를 한 줄 한국어 메시지로 */
export function formatError(e, lineMap) {
  const where = lineMap ? lineMap(e.line) : `${e.line}번째 줄`;
  return `[대본] ${where}: ${e.msg}`;
}

/** 타임라인 지문(동작·획·자막 시각) — 재생 화면과 영상 렌더러가 같은 박자인지 대조할 때 */
export function timelineSig(tl) {
  let h = 2166136261 >>> 0;
  const add = (v) => { const s = String(v); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } h ^= 124; h = Math.imul(h, 16777619) >>> 0; };
  add(tl.end);
  for (const a of tl.actions) {
    add(a.kind); add(a.t0); add(a.dur);
    for (const s of a.strokes) { add(s.type); add(s.st); add(s.d); add(s.k || ''); add(s.x ?? (s.pts ? s.pts.length : '')); add(s.y ?? ''); add(s.s ?? ''); add(s.r ?? ''); add(s.ws ?? ''); }
    if (a.cap) for (const p of a.cap.pages) { add(p.st); add(p.d); add(p.glyphs.length); }
  }
  return (h >>> 0).toString(16) + ':' + tl.actions.length;
}
