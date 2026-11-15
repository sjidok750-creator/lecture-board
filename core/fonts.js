// 글꼴 — opentype.js 로 글자 윤곽을 읽어 '글자 정의'(채우기 명령 + 펜이 따라갈 선)로 바꾼다.
// 브라우저·Node 공용 순수 모듈. 글꼴 바이트는 바깥에서 주는 함수(loadBytes)로 받는다.
// opentype.js 는 글꼴 파일을 직접 읽을 때만 불러온다(서버 모드 재생 화면은 '글자 묶음'만 써서 필요 없음)
let parseP = null;
const getParse = () => (parseP ||= import('../vendor/opentype.mjs').then((m) => m.parse));

// 글꼴 목록(역할 → 파일). 파일 경로는 web\ 기준 상대경로.
export const FONT_FILES = {
  pen: 'fonts/nanumpenscript/NanumPenScript-Regular.ttf',
  gamja: 'fonts/gamjaflower/GamjaFlower-Regular.ttf',
  himelody: 'fonts/himelody/HiMelody-Regular.ttf',
  poorstory: 'fonts/poorstory/PoorStory-Regular.ttf',            // 푸어 스토리(한글 11,172자)
  gaegu: 'fonts/gaegu/Gaegu-Regular.ttf',                        // 개구(한글 2,350자 — 나머지는 다음 손글씨로)
  eastseadokdo: 'fonts/eastseadokdo/EastSeaDokdo-Regular.ttf',   // 동해 독도(한글 2,484자)
  brush: 'fonts/nanumbrushscript/NanumBrushScript-Regular.ttf',  // 나눔손글씨 붓(한글 11,172자)
  yomogi: 'fonts/yomogi/Yomogi-Regular.ttf',                     // 요모기(손글씨 그리스 문자·수식 기호용)
  patrick: 'fonts/patrickhand/PatrickHand-Regular.ttf',          // 패트릭 핸드(영문·숫자 짝)
  gothic: 'fonts/nanumgothic/NanumGothic-Regular.ttf',
  math: 'fonts/notosansmath/NotoSansMath-Regular.ttf',
};

const EM = 1000; // 글자 정의 단위(1 em = 1000)

function r1(v) { return Math.round(v * 10) / 10; }

// 곡선을 잘게 나눠 꺾은선으로(펜이 따라갈 길)
function flatten(cmds) {
  const polys = [];
  let cur = null, x = 0, y = 0, sx = 0, sy = 0;
  const push = (px, py) => { cur.push(r1(px), r1(py)); };
  for (const c of cmds) {
    if (c[0] === 'M') { if (cur && cur.length > 2) polys.push(cur); cur = []; x = sx = c[1]; y = sy = c[2]; push(x, y); }
    else if (c[0] === 'L') { push(c[1], c[2]); x = c[1]; y = c[2]; }
    else if (c[0] === 'Q') {
      const n = Math.max(2, Math.min(10, Math.ceil(Math.hypot(c[3] - x, c[4] - y) / 40)));
      for (let i = 1; i <= n; i++) { const t = i / n, u = 1 - t; push(u * u * x + 2 * u * t * c[1] + t * t * c[3], u * u * y + 2 * u * t * c[2] + t * t * c[4]); }
      x = c[3]; y = c[4];
    } else if (c[0] === 'C') {
      const n = Math.max(3, Math.min(14, Math.ceil(Math.hypot(c[5] - x, c[6] - y) / 35)));
      for (let i = 1; i <= n; i++) { const t = i / n, u = 1 - t; push(u * u * u * x + 3 * u * u * t * c[1] + 3 * u * t * t * c[3] + t * t * t * c[5], u * u * u * y + 3 * u * u * t * c[2] + 3 * u * t * t * c[4] + t * t * t * c[6]); }
      x = c[5]; y = c[6];
    } else if (c[0] === 'Z') { if (cur) { push(sx, sy); } x = sx; y = sy; }
  }
  if (cur && cur.length > 2) polys.push(cur);
  return polys;
}

function polyLen(p) { let L = 0; for (let i = 2; i < p.length; i += 2) L += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]); return L; }

// 한글 모음 모양: 0 = 세로(ㅏ ㅓ ㅣ …: 초성 왼쪽·모음 오른쪽), 1 = 가로(ㅗ ㅜ ㅡ …: 초성 위·모음 아래), 2 = 섞임(ㅘ ㅝ ㅢ …)
const VOWEL_KIND = [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 2, 2, 1, 1, 2, 2, 2, 1, 1, 2, 0];

// 윤곽 조각 하나: 시작점을 왼쪽 위로 돌리고, 넓은 조각은 오른쪽으로·높은 조각은 아래로 먼저 가게 방향을 맞춘다
function orientPoly(pl) {
  const n = pl.length / 2 - 1; // 마지막 점 = 첫 점(닫힘)
  if (n < 3 || pl[0] !== pl[pl.length - 2] || pl[1] !== pl[pl.length - 1]) return pl;
  let i0 = 0, best = Infinity, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = pl[2 * i], y = pl[2 * i + 1];
    if (x + y < best) { best = x + y; i0 = i; }
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  const m = Math.max(1, Math.floor(n / 6));
  const f = (i0 + m) % n, b = (i0 - m + n) % n;
  const ax = x1 - x0 >= y1 - y0 ? 0 : 1;
  const rev = pl[2 * b + ax] > pl[2 * f + ax];
  const out = [];
  for (let k = 0; k <= n; k++) { const i = rev ? (i0 - k + n * 2) % n : (i0 + k) % n; out.push(pl[2 * i], pl[2 * i + 1]); }
  return out;
}

/** 펜이 따라갈 윤곽 조각 순서 — 한글은 초성 → 중성 → 종성, 같은 자모 안에서는 왼쪽 위부터. 그 밖의 글자는 왼쪽 위부터. */
export function orderPolys(cmds, ch) {
  const polys = flatten(cmds).map(orientPoly);
  let gx0 = Infinity, gy0 = Infinity, gx1 = -Infinity, gy1 = -Infinity;
  const info = polys.map((pl) => {
    let mx = Infinity, my = Infinity, sx = 0, sy = 0; const n = pl.length / 2;
    for (let i = 0; i < pl.length; i += 2) { mx = Math.min(mx, pl[i]); my = Math.min(my, pl[i + 1]); sx += pl[i]; sy += pl[i + 1]; gx0 = Math.min(gx0, pl[i]); gx1 = Math.max(gx1, pl[i]); gy0 = Math.min(gy0, pl[i + 1]); gy1 = Math.max(gy1, pl[i + 1]); }
    return { pl, key: my * 0.6 + mx, cx: sx / n, cy: sy / n, rank: 0 };
  });
  const cp = ch ? ch.codePointAt(0) : 0;
  if (cp >= 0xAC00 && cp <= 0xD7A3 && info.length > 1) {
    const idx = cp - 0xAC00, V = Math.floor((idx % 588) / 28), T = idx % 28, kind = VOWEL_KIND[V];
    const w = gx1 - gx0 || 1, h = gy1 - gy0 || 1;
    for (const o of info) {
      const u = (o.cx - gx0) / w, v = (o.cy - gy0) / h;
      if (T && v > 0.66) o.rank = 2;
      else if (kind === 0) o.rank = u < 0.56 ? 0 : 1;
      else if (kind === 1) o.rank = v < (T ? 0.32 : 0.45) ? 0 : 1;
      else o.rank = (u < 0.62 && v < (T ? 0.34 : 0.46)) ? 0 : 1;
    }
  }
  return info.sort((a, b) => a.rank - b.rank || a.key - b.key).map((o) => o.pl);
}

/** 채우기 명령 → 펜 길·길이·상자(글자 묶음·글꼴 조각에서 받은 글자도 같은 계산을 쓴다) */
export function defFromCmds(k, adv, cmds, ch, lens = null) {
  const polys = orderPolys(cmds, ch);
  lens = lens || polys.map(polyLen);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const pl of polys) for (let i = 0; i < pl.length; i += 2) { x0 = Math.min(x0, pl[i]); x1 = Math.max(x1, pl[i]); y0 = Math.min(y0, pl[i + 1]); y1 = Math.max(y1, pl[i + 1]); }
  return { k, adv, cmds, polys, lens, len: lens.reduce((a, b) => a + b, 0), box: polys.length ? [x0, y0, x1, y1] : [0, 0, 0, 0] };
}

/** 글자 묶음으로 움직이는 글꼴 묶음 — FontSet 과 같은 꼴(pick/def/defs). 글꼴 파일을 읽지 않는다. */
export class PackFonts {
  constructor() { this.map = {}; this.defs = {}; }
  add(pack) {
    for (const [ck, m] of Object.entries(pack.map)) this.map[ck] = Object.assign(this.map[ck] || {}, m);
    Object.assign(this.defs, pack.defs);
  }
  pick(ch, chain) { const e = (this.map[chain.join(',')] || {})[ch]; return e ? { font: e[0], gi: e[1] } : null; }
  def(font, gi) { return this.defs[font + ':' + gi]; }
}

export class FontSet {
  /** loadBytes(relPath) → Promise<ArrayBuffer> */
  constructor(loadBytes) {
    this.loadBytes = loadBytes;
    this.fonts = {};      // 이름 → opentype Font
    this.loading = {};
    this.defs = {};       // 글자 키 → 글자 정의
    this.warnings = [];
  }
  async load(name) {
    if (this.fonts[name]) return this.fonts[name];
    if (!this.loading[name]) {
      this.loading[name] = Promise.all([this.loadBytes(FONT_FILES[name]), getParse()]).then(([buf, parse]) => { this.fonts[name] = parse(buf); return this.fonts[name]; });
    }
    return this.loading[name];
  }
  async loadAll(names) { await Promise.all(names.map((n) => this.load(n))); }

  /** 글자 하나를 그릴 글꼴을 고른다. chain = 글꼴 이름 순서. 없으면 null. */
  pick(ch, chain) {
    for (const n of chain) {
      const f = this.fonts[n];
      if (!f) continue;
      const gi = f.charToGlyphIndex(ch);
      if (gi > 0) return { font: n, gi };
    }
    return null;
  }

  /** 글자 정의: {k, adv(em 단위 1000 기준), cmds(채우기), polys(펜 길), len, box} */
  def(fontName, gi, ch) {
    const k = fontName + ':' + gi;
    if (this.defs[k]) return this.defs[k];
    const f = this.fonts[fontName];
    const g = f.glyphs.get(gi);
    const sc = EM / f.unitsPerEm;
    const p = g.getPath(0, 0, f.unitsPerEm); // y 아래로, 기준선 0
    const cmds = [];
    for (const c of p.commands) {
      if (c.type === 'M' || c.type === 'L') cmds.push([c.type, r1(c.x * sc), r1(c.y * sc)]);
      else if (c.type === 'Q') cmds.push(['Q', r1(c.x1 * sc), r1(c.y1 * sc), r1(c.x * sc), r1(c.y * sc)]);
      else if (c.type === 'C') cmds.push(['C', r1(c.x1 * sc), r1(c.y1 * sc), r1(c.x2 * sc), r1(c.y2 * sc), r1(c.x * sc), r1(c.y * sc)]);
      else if (c.type === 'Z') cmds.push(['Z']);
    }
    // 펜 길: 한글은 초성 → 중성 → 종성, 그 밖은 '왼쪽 위 → 오른쪽 아래' 순(사람이 쓰는 순서와 비슷하게)
    const d = defFromCmds(k, r1((g.advanceWidth || 0) * sc), cmds, g.unicode != null ? String.fromCodePoint(g.unicode) : (ch || '')); // 순서는 글자 모양(첫 코드포인트)으로만 정함 — 부르는 순서와 무관
    this.defs[k] = d;
    return d;
  }

  /** 글자 묶음 만들기 — 이 글에 쓰인 글자만 골라 {고른 글꼴, 글자 정의}를 담는다(서버 모드에서 브라우저로 보냄) */
  pack(text, chains, known = null) {
    const chars = new Set([...text, ...'0123456789+-n?.,() ']);
    const map = {}, defs = {};
    for (const chain of chains) {
      const ck = chain.join(',');
      const m = (map[ck] = {});
      for (const ch of chars) {
        const p = this.pick(ch, chain);
        if (!p) continue;
        m[ch] = [p.font, p.gi];
        const d = this.def(p.font, p.gi, ch);
        if (!known || !known.has(d.k)) defs[d.k] = d;
      }
    }
    return { map, defs };
  }

  /** 글꼴의 기준선 위 높이(대문자·한글 높이 대략) — em 1000 기준 */
  metrics(fontName) {
    const f = this.fonts[fontName];
    const sc = EM / f.unitsPerEm;
    return { asc: f.ascender * sc, desc: -f.descender * sc };
  }
}
