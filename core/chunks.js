// 글꼴 조각 — 웹판(정적 모드)이 글꼴 파일 대신 받는 '글자 정의' 조각. 만들기는 tools\font_chunks.mjs.
// 조각 규칙·인코딩은 이 파일 하나에만 있다(만드는 쪽·읽는 쪽 공용).
import { defFromCmds } from './fonts.js';
import { DEFAULTS, boardChain, capChain, mergeCfg } from './layout.js';

/** 자주 쓰는 한글 순위 구간: [구간 끝 순위, 조각 크기] — 앞쪽(흔한 글자)은 크게, 뒤쪽은 작게 */
export const TIERS = [[256, 32], [1024, 16], [2350, 8]];

/** 글자 하나가 들어갈 조각 이름 */
export function chunkKey(cp, rank, tiers = TIERS) {
  const r = rank.get(String.fromCodePoint(cp));
  if (r != null) {
    let start = 0;
    for (let t = 0; t < tiers.length; t++) {
      const [end, size] = tiers[t];
      if (r < end) return `r${t}_${Math.floor((r - start) / size)}`;
      start = end;
    }
  }
  return 'u' + (cp >> 4).toString(16);
}

/** 채우기 명령 ↔ 짧은 글('M12.3 4L5 6Q…Z'). 숫자는 PC 판과 같은 값(0.1 단위)으로 그대로 돌아온다 */
export function encodeCmds(cmds) { return cmds.map((c) => c[0] + c.slice(1).join(' ')).join(''); }
export function decodeCmds(s) {
  const out = [];
  const re = /([MLQCZ])([^MLQCZ]*)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[2] ? [m[1], ...m[2].split(' ').map(Number)] : [m[1]]);
  return out;
}

function hasCp(ranges, cp) {
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) { const mid = (lo + hi) >> 1, r = ranges[mid]; if (cp < r[0]) hi = mid - 1; else if (cp > r[1]) lo = mid + 1; else return true; }
  return false;
}
let rankCache = null;
function rankOf(idx) { if (!rankCache || rankCache.order !== idx.order) rankCache = { order: idx.order, map: new Map([...idx.order].map((c, i) => [c, i])) }; return rankCache.map; }

const SHAPE_RE = /^(선|화살표|상자|원|곡선|글|점|치수|등분포|지점|롤러)(\s|$)/;
const EXTRA = '0123456789+-n?.,() ';
/** 대본을 볼 때 필요한 조각: { 글꼴: Set(조각 이름) }. 판서 글자는 판서 사슬, '::' 자막 글자는 자막 사슬로 고른다 */
export function needChunks(idx, text, cfg = {}) {
  const C = mergeCfg(DEFAULTS, cfg);
  const bChain = boardChain(C), cChain = capChain(bChain);
  const board = new Set(EXTRA), cap = new Set(EXTRA);
  for (let ln of text.replace(/\r\n?/g, '\n').split('\n')) {
    ln = ln.trim();
    if (!ln || ln.startsWith('//') || ln === '@끝' || /^\[\s*\/?\s*그림/.test(ln)) continue;
    if (ln.startsWith('::')) { for (const c of ln.slice(2)) cap.add(c); continue; }
    if (SHAPE_RE.test(ln)) { const q = ln.match(/["“”]([^"“”]*)["“”]/); if (q) for (const c of q[1]) board.add(c); continue; }
    for (const c of ln) board.add(c);
  }
  const rank = rankOf(idx), need = {};
  const want = (chars, chain) => {
    for (const ch of chars) {
      const cp = ch.codePointAt(0);
      for (const n of chain) {
        const f = idx.fonts[n];
        if (f && hasCp(f.ranges, cp)) { (need[n] ||= new Set()).add(chunkKey(cp, rank, idx.tiers)); break; }
      }
    }
  };
  want(board, bChain); want(cap, cChain);
  return need;
}

/** 조각으로 움직이는 글꼴 묶음 — FontSet 과 같은 꼴(pick/def/defs). 안 받은 글자를 만나면 missing 에 적는다 */
const EMPTY = { k: '_', adv: 500, cmds: [], polys: [], lens: [], len: 0, box: [0, 0, 0, 0] };
export class ChunkFonts {
  constructor(idx) { this.idx = idx; this.defs = { _: EMPTY }; this.rec = {}; this.byGi = {}; this.missing = new Map(); this.loaded = new Set(); }
  add(font, key, data) {
    this.loaded.add(font + '/' + key);
    const r = (this.rec[font] ||= new Map()), g = (this.byGi[font] ||= new Map());
    for (const e of data.g) { r.set(e[0], e); if (!g.has(e[1])) g.set(e[1], e); }
  }
  pick(ch, chain) {
    const cp = ch.codePointAt(0);
    for (const n of chain) {
      const f = this.idx.fonts[n];
      if (!f || !hasCp(f.ranges, cp)) continue;
      const e = this.rec[n] && this.rec[n].get(cp);
      if (!e) { const k = chunkKey(cp, rankOf(this.idx), this.idx.tiers); this.missing.set(n + '/' + k, [n, k]); return { font: n, gi: -1 }; }
      return { font: n, gi: e[1] };
    }
    return null;
  }
  def(font, gi) {
    if (gi < 0) return EMPTY;
    const k = font + ':' + gi;
    if (this.defs[k]) return this.defs[k];
    const e = this.byGi[font].get(gi);
    const d = defFromCmds(k, e[2], decodeCmds(e[3]), String.fromCodePoint(e[4] ?? e[0]));
    this.defs[k] = d;
    return d;
  }
}

/** 조각 받기(브라우저). 받은 조각은 Cache Storage 에 남겨 다음 방문에 다시 받지 않는다(이름에 내용 해시가 있어 낡지 않음) */
const CACHE = 'lecture-board-glyphs-1';
async function getJSON(url) {
  if (typeof caches !== 'undefined') {
    try {
      const c = await caches.open(CACHE);
      const hit = await c.match(url);
      if (hit) return await hit.json();
      const r = await fetch(url);
      if (!r.ok) throw new Error(url + ' ' + r.status);
      try { await c.put(url, r.clone()); } catch { /* 저장 못 해도 진행 */ }
      return await r.json();
    } catch (e) { if (/ \d{3}$/.test(e.message)) throw e; /* 캐시를 못 쓰면 그냥 받음 */ }
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + ' ' + r.status);
  return r.json();
}
export async function loadIndex(base) {
  const r = await fetch(base + 'fonts/chunks/index.json', { cache: 'no-cache' });
  if (!r.ok) throw new Error('글꼴 색인 ' + r.status);
  return r.json();
}
/** list: [[글꼴, 조각 이름], …] 중 아직 안 받은 것만 받는다 */
export async function loadChunks(base, F, list) {
  const todo = list.filter(([n, k]) => !F.loaded.has(n + '/' + k) && F.idx.fonts[n] && F.idx.fonts[n].files[k]);
  const got = await Promise.all(todo.map(([n, k]) => getJSON(`${base}fonts/chunks/${n}/${k}.${F.idx.fonts[n].files[k]}.json`)));
  todo.forEach(([n, k], i) => F.add(n, k, got[i]));
  return todo.length;
}
