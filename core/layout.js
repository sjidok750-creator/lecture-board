// 판서 배치 — 해석된 대본 항목을 화면 좌표의 '획'(글자·선)으로 바꾸고 박자를 매긴다.
// 브라우저·Node 공용 순수 모듈(시계·난수 없음 → 같은 입력이면 늘 같은 결과).
//
// 결과 timeline: { W, H, defs, actions:[{kind:'draw'|'wipe'|'pause', line, t0, dur, strokes:[...], cap}], errors, end }
//   획 종류  g: 글자 {k,x,y,s,c}   p: 선 {pts,w,c}   d: 점 {x,y,r,c}
//   획마다 st(동작 안 시작 시각)·d(길이) — 초 단위

export const DEFAULTS = {
  W: 1280, H: 720,
  font: 'poorstory',           // 판서 글꼴(poorstory·gaegu·eastseadokdo·brush·gamja·himelody·pen — fonts.js FONT_FILES)
  fontFallback: ['poorstory', 'yomogi'], // 판서 글꼴에 없는 글자를 찾을 손글씨(그다음 고딕·수식 글꼴)
  latin: null,                 // 영문·숫자를 따로 쓸 손글씨(예: 'patrick'). null 이면 판서 글꼴 것
  colors: { k: '#1e2433', b: '#1f4fc2', r: '#cf2b2b', g: '#178a3a' }, // 보드마커 색(검정은 약간 푸른 검정)
  // 손맛(0 = 끔, 1 = 기본): jitter 글자별 크기·기울기·기준선·자간 흔들림, warp 윤곽 휘기, ink 잉크 질감, lift 획 사이 펜 들림
  hand: { jitter: 1, warp: 1, ink: 1, lift: 1 },
  margin: { l: 64, r: 64, t: 30 },
  boardBottom: 604,            // 판서 영역 아래 끝(이 아래는 자막 구역)
  caption: { top: 618, size: 29, lineH: 40, maxW: 1160, maxLines: 2, color: '#2b2b2b', band: '#f3f2ee' },
  sizes: { title: 62, text: [46, 41, 38], formula: 48, label: 32 },
  lineGap: 1.30,
  fontScale: { pen: 1.15, gamja: 1.0, himelody: 1.0, poorstory: 0.95, gaegu: 1.04, eastseadokdo: 1.22, brush: 1.22, yomogi: 1.0, patrick: 1.0, gothic: 0.86, math: 0.86 },
  tight: ['yomogi'],           // 이 글꼴의 글자는 모양 폭으로 좁혀 씀(전각 기호)
  traceW: { pen: 150, gamja: 140, himelody: 140, poorstory: 140, gaegu: 130, eastseadokdo: 150, brush: 150, yomogi: 140, patrick: 140, gothic: 150, math: 150 },
  // 박자(초)
  pace: {
    glyphBase: 0.040, glyphPerEm: 0.000040, glyphMin: 0.07, glyphMax: 0.26,  // 글자 하나 쓰는 시간 = base + 윤곽길이(em)·perEm
    charGap: 0.012, wordGap: 0.07, lineGap: 0.14,
    shapeSpeed: 950, shapeMin: 0.16, shapeMax: 1.1,       // 도형 px/s
    lead: 0.10,                                           // 동작 시작 뒤 펜이 옮겨 가는 시간
    after: 0.35,                                          // 다 쓰고 눈으로 따라갈 쉼
    wipe: 0.75,
    readCPM: 560, readMin: 1.3, readLead: 0.15,           // 자막 읽기: 분당 글자 수, 최소 표시
    stretchMax: 1.35,                                     // 자막이 길 때 쓰기를 늦추는 한도
  },
};

const SUP = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁺': '+', '⁻': '-', 'ⁿ': 'n' };
const SUB = { '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9', '₊': '+', '₋': '-' };
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';

function prng(seed) { let s = (seed * 2654435761) >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const r1 = (v) => Math.round(v * 10) / 10;
function plen(p) { let L = 0; for (let i = 2; i < p.length; i += 2) L += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]); return L; }

// ── 글 → 원자(글자 + 크기 배율 + 높이 이동) ─────────────────────────────
// ^2, ^{n+1}, _ck, _{ck}, ²·₁, 그리고 수식 줄에서는 {위}/{아래} 분수.
function toAtoms(str, allowFrac) {
  const out = [];
  let i = 0;
  const readGroup = () => { // { ... } 짝 맞추기
    let depth = 0, j = i;
    for (; j < str.length; j++) { if (str[j] === '{') depth++; else if (str[j] === '}') { depth--; if (depth === 0) break; } }
    const g = str.slice(i + 1, j); i = j + 1; return g;
  };
  while (i < str.length) {
    const ch = str[i];
    if (allowFrac && ch === '{') {
      const save = i;
      const num = readGroup();
      if (str[i] === '/' && str[i + 1] === '{') { i++; const den = readGroup(); out.push({ frac: true, num: toAtoms(num, false), den: toAtoms(den, false) }); continue; }
      i = save;
    }
    if ((ch === '^' || ch === '_') && i + 1 < str.length) {
      const kind = ch === '^' ? 'sup' : 'sub';
      i++;
      let g;
      if (str[i] === '{') g = readGroup();
      else {
        const rest = str.slice(i);
        const m = kind === 'sup' ? rest.match(/^[+-]?(\d+(\.\d+)?|[A-Za-zͰ-Ͽ'])/) : rest.match(/^[+-]?[A-Za-z0-9Ͱ-Ͽ]+/);
        g = m ? m[0] : rest[0];
        i += g.length;
      }
      for (const a of toAtoms(g, false)) out.push({ ...a, lv: [kind, ...(a.lv || [])] });
      continue;
    }
    if (SUP[ch]) { out.push({ ch: SUP[ch], lv: ['sup'] }); i++; continue; }
    if (SUB[ch]) { out.push({ ch: SUB[ch], lv: ['sub'] }); i++; continue; }
    const ci = CIRCLED.indexOf(ch);
    if (ci >= 0) { out.push({ circled: String(ci + 1) }); i++; continue; }
    out.push({ ch });
    i++;
  }
  return out;
}

/** 판서 글꼴 사슬: (영문 짝) → 판서 글꼴 → 손글씨 대체 → 고딕 → 수식 */
export function boardChain(C) {
  const out = [];
  for (const n of [C.latin, C.font, ...(C.fontFallback || []), 'gothic', 'math']) if (n && !out.includes(n)) out.push(n);
  return out;
}
/** 자막 글꼴 사슬: 고딕 → 수식 → 판서 글꼴들 */
export function capChain(board) { return ['gothic', 'math', ...board.filter((n) => n !== 'gothic' && n !== 'math')]; }

export class Layout {
  constructor(fonts, cfg = {}) {
    this.F = fonts;
    this.C = mergeCfg(DEFAULTS, cfg);
    this.chain = boardChain(this.C);      // lecture.js fontChains 와 같은 순서
    this.capChain = capChain(this.chain);
  }

  // 글자 하나 → 글자 정의(+대체 글꼴, 없으면 '?')
  glyph(ch, chain, warn) {
    let p = this.F.pick(ch, chain);
    if (!p) { if (warn) warn(`'${ch}'(U+${ch.codePointAt(0).toString(16).toUpperCase()}) 글자는 어느 글꼴에도 없어 '?' 로 씁니다`); p = this.F.pick('?', chain); }
    return { def: this.F.def(p.font, p.gi, ch), font: p.font };
  }

  // 원자 목록을 한 줄로 배치(상대 좌표: 기준선 0). 돌려줌: {w, asc, desc, glyphs:[{k,x,y,s,font,ch,len}], extras:[{type:'p',..}]}
  shapeAtoms(atoms, size, chain, warn) {
    const C = this.C;
    const glyphs = [], extras = [];
    let x = 0, asc = size * 0.80, desc = size * 0.22;
    for (const a of atoms) {
      if (a.frac) {
        const s2 = size * 0.82;
        const n = this.shapeAtoms(a.num, s2, chain, warn), d = this.shapeAtoms(a.den, s2, chain, warn);
        const w = Math.max(n.w, d.w) + size * 0.3;
        const barY = -size * 0.30;
        const nx = x + (w - n.w) / 2, dx = x + (w - d.w) / 2;
        const ny = barY - size * 0.14 - n.desc, dy = barY + size * 0.12 + d.asc;
        for (const g of n.glyphs) glyphs.push({ ...g, x: g.x + nx, y: g.y + ny });
        for (const e of n.extras) extras.push(shiftP(e, nx, ny));
        extras.push({ type: 'p', pts: [x + size * 0.08, barY, x + w - size * 0.08, barY], w: Math.max(2.4, size * 0.06), after: glyphs.length });
        for (const g of d.glyphs) glyphs.push({ ...g, x: g.x + dx, y: g.y + dy });
        for (const e of d.extras) extras.push(shiftP(e, dx, dy));
        asc = Math.max(asc, -ny + n.asc); desc = Math.max(desc, dy + d.desc);
        x += w + size * 0.08;
        continue;
      }
      if (a.circled) {
        const s2 = size * 0.62;
        const n = this.shapeAtoms(toAtoms(a.circled, false), s2, chain, warn);
        const rr = size * 0.40, cx = x + rr + size * 0.04, cy = -size * 0.30;
        for (const g of n.glyphs) glyphs.push({ ...g, x: g.x + cx - n.w / 2, y: g.y + cy + s2 * 0.32 });
        extras.push({ type: 'p', pts: circlePts(cx, cy, rr, rr, -Math.PI / 2, 1.0, 28), w: Math.max(2, size * 0.05), after: glyphs.length });
        x += rr * 2 + size * 0.12;
        continue;
      }
      const lv = a.lv || [];
      let s = size, dy = 0;
      for (const k of lv) { if (k === 'sup') { dy -= s * 0.40; s *= 0.64; } else { dy += s * 0.16; s *= 0.64; } }
      if (a.ch === ' ') { x += size * 0.30; continue; }
      const { def, font } = this.glyph(a.ch, chain, warn);
      const fs = s * (C.fontScale[font] || 1);
      // 대체 글꼴은 손글씨 기준선에 맞게 조금 올림
      // 전각 너비 기호(일본 손글씨의 그리스 문자 등)는 실제 모양 폭으로 좁힌다
      const tight = (C.tight || []).includes(font) && def.box[2] > def.box[0];
      const gx = tight ? x + (60 - def.box[0]) * fs / 1000 : x;
      glyphs.push({ k: def.k, x: r1(gx), y: r1(dy), s: r1(fs), font, ch: a.ch, len: def.len * fs / 1000, lv: lv.length });
      x += (tight ? def.box[2] - def.box[0] + 120 : def.adv) * fs / 1000 + (lv.length ? s * 0.02 : 0);
      if (lv.length && lv[0] === 'sup') asc = Math.max(asc, -dy + s * 0.8);
      if (lv.length && lv[0] === 'sub') desc = Math.max(desc, dy + s * 0.25);
    }
    return { w: x, asc, desc, glyphs, extras };
  }

  // 글 → 줄바꿈된 줄들. 띄어쓰기 단위로 끊고, 한 낱말이 너무 길면 글자 단위로.
  wrap(text, size, maxW, chain, warn, allowFrac) {
    const atoms = toAtoms(text, allowFrac);
    const words = [];
    let cur = [];
    for (const a of atoms) { if (a.ch === ' ' && !(a.lv && a.lv.length)) { if (cur.length) words.push(cur); cur = []; } else cur.push(a); }
    if (cur.length) words.push(cur);
    const space = size * 0.30;
    const lines = [];
    let line = [], lw = 0;
    for (let w of words) {
      let sh = this.shapeAtoms(w, size, chain, warn);
      if (sh.w > maxW) { // 긴 낱말: 글자 단위로 쪼갬
        if (line.length) { lines.push(line); line = []; lw = 0; }
        let part = [];
        for (const a of w) {
          const t = this.shapeAtoms([...part, a], size, chain, warn);
          if (t.w > maxW && part.length) { lines.push([part]); part = [a]; } else part.push(a);
        }
        w = part; sh = this.shapeAtoms(w, size, chain, warn);
      }
      const need = (line.length ? lw + space : 0) + sh.w;
      if (need > maxW && line.length) { lines.push(line); line = [w]; lw = sh.w; }
      else { line.push(w); lw = need; }
    }
    if (line.length) lines.push(line);
    // 각 줄을 배치
    return lines.map((ws) => {
      const glyphs = [], extras = [], wordEnds = [];
      let x = 0, asc = size * 0.8, desc = size * 0.22;
      ws.forEach((w, wi) => {
        if (wi) x += space;
        const sh = this.shapeAtoms(w, size, chain, warn);
        for (const g of sh.glyphs) glyphs.push({ ...g, x: g.x + x });
        for (const e of sh.extras) extras.push({ ...shiftP(e, x, 0), after: (e.after ?? sh.glyphs.length) + glyphs.length - sh.glyphs.length });
        wordEnds.push(glyphs.length);
        asc = Math.max(asc, sh.asc); desc = Math.max(desc, sh.desc);
        x += sh.w;
      });
      return { w: x, asc, desc, glyphs, extras, wordEnds };
    });
  }

  /** 대본 해석 결과 → 타임라인 */
  build(parsed) {
    const C = this.C, P = C.pace;
    const W = C.W, L = C.margin.l, R = W - C.margin.r, top = C.margin.t, bottom = C.boardBottom;
    const errors = [];
    const actions = [];
    const defs = {};
    const useDef = (k) => { defs[k] = this.F.defs[k]; };
    // 판 상태
    let y = top, empty = true, side = null, blocks = [], fig = null;
    let lastPen = null;

    const newBoard = (line) => {
      if (!empty) actions.push({ kind: 'wipe', line, strokes: [] });
      y = top; empty = true; side = null; blocks = []; fig = null;
    };
    const area = (yy) => { // 지금 줄이 쓸 수 있는 가로 범위
      if (side && yy < side.bottom) return side.pos === '오른쪽' ? [L, side.x0 - 28] : [side.x1 + 28, R];
      return [L, R];
    };

    const items = parsed.items;
    for (let ii = 0; ii < items.length; ii++) {
      const it = items[ii];
      const warn = (msg) => errors.push({ line: it.line, msg });
      const color = C.colors[it.color || (it.t === 'formula' ? 'b' : it.em ? 'r' : 'k')];
      const capText = it.cap || null;
      const act = { kind: 'draw', line: it.line, strokes: [], capText };

      if (it.t === 'wipe') { if (!empty) { newBoard(it.line); actions[actions.length - 1].capText = capText; } else if (capText) actions.push({ kind: 'pause', line: it.line, strokes: [], capText }); continue; }
      if (it.t === 'pause') { actions.push({ kind: 'pause', line: it.line, strokes: [], capText }); continue; }
      if (it.t === 'figEnd') {
        if (fig && fig.pos === '가운데') { y = Math.max(fig.y1, fig.maxY || 0) + 18; }
        else if (fig && side) { side.bottom = Math.max(side.bottom, (fig.maxY || 0) + 8); }
        fig = null; continue;
      }
      if (it.t === 'fig') {
        const H = bottom - top;
        const fh = Math.min(H, it.h / 100 * H);
        let fw = it.pos === '가운데' ? Math.min((R - L) * 0.92, fh * 3.0) : Math.min((R - L) * 0.46, fh * 1.6);
        let fy = side ? Math.max(y, side.bottom + 10) : y;
        if (fy + fh > bottom + 0.5) { newBoard(it.line); fy = y; }
        let fx = it.pos === '가운데' ? (L + R - fw) / 2 : it.pos === '오른쪽' ? R - fw : L;
        fig = { x0: fx, y0: fy, x1: fx + fw, y1: fy + fh, pos: it.pos, segs: [], dots: [], labels: [], ahead: [] };
        // 같은 구역의 뒤 도형(선·점·'글' 자리)을 미리 계산해 둔다 — 라벨이 앞으로 그려질 선도 피하게.
        // 해석기가 닫히지 않은 구역은 내보내지 않으므로(이어 붙이기 중) 여기 있는 도형은 바뀌지 않는다.
        for (let j = ii + 1; j < items.length && items[j].t !== 'figEnd' && items[j].t !== 'fig'; j++) {
          const q = items[j];
          if (q.t !== 'shape') continue;
          const g = this.geom(q, fig);
          const ah = { idx: j, segs: g.S.filter((s) => s.type === 'p').map((s) => s.pts), dots: g.S.filter((s) => s.type === 'd'), rect: null };
          if (q.op === '글' && q.label) {
            const ln = this.wrap(q.label, C.sizes.label, fig.x1 - fig.x0, this.chain, () => {}, true)[0];
            if (ln) { const x0 = g.lab[0][0] - ln.w / 2, base = g.lab[0][1] + (ln.asc - ln.desc) / 2; ah.rect = [x0, base - ln.asc, x0 + ln.w, base + ln.desc]; }
          }
          fig.ahead.push(ah);
        }
        if (it.pos !== '가운데') { side = { x0: fx, x1: fx + fw, bottom: fy + fh + 8, pos: it.pos }; }
        else { y = fy; }
        empty = false;
        continue;
      }

      if (it.t === 'title') {
        if (!empty) newBoard(it.line);
        const size = C.sizes.title;
        const lines = this.wrap(it.text, size, R - L, this.chain, warn, false).slice(0, 2);
        let yy = y;
        for (const ln of lines) {
          const base = yy + ln.asc;
          const x0 = (L + R - ln.w) / 2;
          this.pushLine(act, ln, x0, base, color, useDef);
          yy = base + ln.desc + size * 0.18;
        }
        const wmax = Math.max(...lines.map((l) => l.w));
        const uy = yy + 2;
        act.strokes.push({ type: 'p', pts: wobbleLine((L + R - wmax) / 2 - 10, uy, (L + R + wmax) / 2 + 10, uy, prng(it.line), 1.6), w: 3, c: color, gap: P.lineGap });
        blocks.push(...[]);
        y = uy + 26; empty = false;
        actions.push(act); continue;
      }

      if (it.t === 'text' || it.t === 'formula') {
        const isF = it.t === 'formula';
        const size = isF ? C.sizes.formula : C.sizes.text[it.level];
        const indent = isF ? 0 : it.level * 46 + (it.bullet ? 34 : 0);
        let [ax0, ax1] = area(y);
        let lines = this.wrap(it.text, size, ax1 - ax0 - indent, this.chain, warn, isF);
        const lh = size * C.lineGap;
        const pad = isF ? 0.12 : 0.25;
        const total = (ls) => ls.reduce((h, l) => h + Math.max(lh, l.asc + l.desc + size * pad), 0);
        if (y + total(lines) > bottom) { // 판이 참 → 지우고 새 판
          newBoard(it.line);
          [ax0, ax1] = area(y);
          lines = this.wrap(it.text, size, ax1 - ax0 - indent, this.chain, warn, isF);
        }
        const blk = { chars: [], boxes: [] };
        let first = true;
        for (const ln of lines) {
          const h = Math.max(lh, ln.asc + ln.desc + size * pad);
          const base = y + (h - (ln.asc + ln.desc)) / 2 + ln.asc;
          const x0 = isF ? (ax0 + ax1 - ln.w) / 2 : ax0 + indent;
          if (first && it.bullet) {
            const bx = ax0 + it.level * 46 + 4, by = base - size * 0.30;
            const bl = it.level ? 10 : 14;
            act.strokes.push({ type: 'p', pts: [bx, by, bx + bl * 0.5, by - 0.6, bx + bl, by + 0.4], w: it.level ? 3.6 : 4.4, c: color });
          }
          const st0 = act.strokes.length;
          this.pushLine(act, ln, x0, base, color, useDef);
          for (const g of ln.glyphs) { blk.chars.push(g.ch || ''); blk.boxes.push([x0 + g.x, base + g.y - g.s * 0.80, x0 + g.x + this.F.defs[g.k].adv * g.s / 1000, base + g.y + g.s * 0.12, base, size]); }
          if (it.em) {
            const uy = base + size * 0.17;
            act.strokes.push({ type: 'p', pts: wobbleLine(x0 - 4, uy, x0 + ln.w + 4, uy, prng(it.line * 7 + st0), 1.4), w: 3.2, c: color });
          }
          y += h; first = false;
        }
        blocks.push(blk);
        y += size * 0.12;
        empty = false;
        actions.push(act); continue;
      }

      if (it.t === 'mark') {
        const hit = findText(blocks, it.target);
        if (!hit) { errors.push({ line: it.line, msg: `'${it.target}' 을(를) 지금 판에서 찾지 못했습니다 — ${it.kind === 'underline' ? '밑줄' : '동그라미'}을 건너뜁니다` }); if (capText) actions.push({ kind: 'pause', line: it.line, strokes: [], capText }); continue; }
        const c = C.colors[it.color || 'r'];
        const rnd = prng(it.line * 13 + 5);
        if (it.kind === 'underline') {
          // 줄마다 따로(줄바꿈된 경우)
          const rows = groupRows(hit);
          for (const rw of rows) {
            const uy = Math.max(rw.base + rw.size * 0.19, rw.bottom + 4); // 분수·아래첨자가 있으면 그 아래로
            act.strokes.push({ type: 'p', pts: wobbleLine(rw.x0 - 3, uy, rw.x1 + 3, uy, rnd, 1.5), w: 3.4, c });
          }
        } else {
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (const b of hit) { x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]); }
          const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2 + 2;
          const rx = Math.min((x1 - x0) / 2 + 16, W / 2 - 6), ry = Math.min((y1 - y0) / 2 + 12, 120);
          const pts = circlePts(cx, cy, rx, ry, -Math.PI * 0.85, 1.08, 56, rnd);
          act.strokes.push({ type: 'p', pts: clampPts(pts, 4, top - 20, W - 4, bottom + 4), w: 3.4, c });
        }
        actions.push(act); continue;
      }

      if (it.t === 'shape') {
        if (!fig) { warn(`'${it.op}' 은 그림 구역 안에서만 씁니다`); continue; }
        fig.ahead = fig.ahead.filter((a) => a.idx > ii); // 이제 그리는 도형부터는 '이미 그린 것'으로
        this.shape(it, fig, color, act, useDef, warn);
        for (const s of act.strokes) { // 그림에서 실제로 그린 가장 아래(라벨 포함) — 다음 줄이 겹치지 않게
          const yb = s.type === 'p' ? Math.max(...s.pts.filter((_, i) => i % 2)) + s.w : s.type === 'g' ? s.y + s.s * 0.25 : s.y + s.r;
          fig.maxY = Math.max(fig.maxY || 0, yb);
        }
        actions.push(act); continue;
      }
    }

    // ── 박자 매기기 ──
    let t = 0;
    for (const a of actions) {
      a.cap = a.capText ? this.caption(a.capText, useDef, (m) => errors.push({ line: a.line, msg: m })) : null;
      const read = a.cap ? Math.max(P.readMin, a.cap.chars / P.readCPM * 60) + P.readLead : 0;
      let write = 0;
      if (a.kind === 'wipe') write = P.wipe;
      else if (a.kind === 'draw') {
        let tt = P.lead;
        for (const s of a.strokes) {
          tt += s.gap || 0;
          s.st = tt;
          if (s.type === 'g') s.d = clamp(P.glyphBase + s.lenEm * P.glyphPerEm * 1000, P.glyphMin, P.glyphMax);
          else if (s.type === 'p') s.d = clamp(plen(s.pts) / P.shapeSpeed, P.shapeMin, P.shapeMax);
          else s.d = 0.08;
          tt += s.d;
        }
        write = tt;
      }
      let k = 1;
      if (a.kind === 'draw' && read > write && write > 0) k = Math.min(P.stretchMax, read / write);
      if (k !== 1) for (const s of a.strokes) { s.st *= k; s.d *= k; }
      write *= k;
      a.write = r3(write);
      a.dur = r3(Math.max(write + (a.kind === 'draw' ? P.after : 0.1), read));
      a.t0 = r3(t);
      t += a.dur;
      for (const s of a.strokes) { s.st = r3(s.st); s.d = r3(s.d); delete s.lenEm; delete s.gap; }
      if (a.cap) { // 자막 쪽(page)마다 표시 구간
        let acc = 0;
        const tot = a.cap.pages.reduce((n, p) => n + p.n, 0) || 1;
        for (const p of a.cap.pages) { p.st = r3(a.dur * acc / tot); acc += p.n; p.d = r3(a.dur * p.n / tot); }
      }
      delete a.capText;
    }
    return { W: C.W, H: C.H, style: { cap: C.caption, colors: C.colors, traceW: C.traceW, boardBottom: C.boardBottom, hand: C.hand }, defs, actions, errors, end: r3(t), ended: !!parsed.ended };
  }

  pushLine(act, ln, x0, base, color, useDef) {
    const P = this.C.pace;
    const J = (this.C.hand && this.C.hand.jitter) || 0;
    // 사람 손의 흔들림(결정적: 대본 줄 번호 + 이 동작 안 획 번호가 씨앗 → 덧붙여도 앞 글자는 그대로)
    const seed0 = act.line * 7919 + act.strokes.length * 131;
    const rl = prng(seed0 + 3);
    const size0 = ln.glyphs.length ? ln.glyphs[0].s : 40;
    const slope = (rl() - 0.5) * 2 * 0.006 * J;           // 줄 전체 기울어짐(약 ±0.35°)
    const sag = (rl() - 0.5) * 2 * 0.035 * J * size0;      // 줄 가운데 처짐/솟음(px)
    const lineY = (x) => { const u = ln.w > 1 ? Math.min(1, Math.max(0, x / ln.w)) : 0; return x * slope + sag * 4 * u * (1 - u); };
    const ext = (e) => ({ type: 'p', pts: e.pts.map((v, j) => r1(j % 2 ? v + base + lineY(e.pts[j - 1]) : v + x0)), w: e.w, c: color });
    let wi = 0, ei = 0;
    const extras = ln.extras.slice().sort((a, b) => a.after - b.after);
    ln.glyphs.forEach((g, i) => {
      while (ei < extras.length && extras[ei].after <= i) { act.strokes.push(ext(extras[ei])); ei++; }
      useDef(g.k);
      const newWord = i > 0 && ln.wordEnds[wi] === i;
      if (newWord) wi++;
      const ws = (seed0 + i * 37 + 11) >>> 0;
      const r = prng(ws);
      const ds = 1 + (r() - 0.5) * 2 * 0.03 * J;             // 크기 ±3 %
      const rot = (r() - 0.5) * 2 * 0.026 * J;               // 기울기 ±1.5°
      const dy = (r() - 0.5) * 2 * 0.028 * g.s * J;          // 기준선 오르내림
      const dx = (r() - 0.5) * 2 * 0.022 * g.s * J;          // 자간
      const s = { type: 'g', k: g.k, x: r1(x0 + g.x + dx), y: r1(base + g.y + lineY(g.x) + dy), s: r1(g.s * ds), c: color, lenEm: g.len / g.s, gap: i === 0 ? P.lineGap * 0.5 : newWord ? P.wordGap : P.charGap };
      if (J) s.r = r3(rot + slope);
      if (J || (this.C.hand && this.C.hand.warp)) s.ws = ws;
      act.strokes.push(s);
    });
    while (ei < extras.length) { act.strokes.push(ext(extras[ei])); ei++; }
  }

  caption(text, useDef, warn) {
    const C = this.C.caption;
    const lines = this.wrap(text.replace(/\^|_/g, (m) => m), C.size, C.maxW, this.capChain, warn, false);
    const pages = [];
    for (let i = 0; i < lines.length; i += C.maxLines) {
      const ls = lines.slice(i, i + C.maxLines);
      const glyphs = [];
      let n = 0;
      const blockH = ls.length * C.lineH;
      const zoneH = this.C.H - C.top;
      let base = C.top + (zoneH - blockH) / 2 + C.size * 0.86;
      for (const ln of ls) {
        const x0 = (this.C.W - ln.w) / 2;
        for (const g of ln.glyphs) { useDef(g.k); glyphs.push({ k: g.k, x: r1(x0 + g.x), y: r1(base + g.y), s: g.s }); n++; }
        for (const e of ln.extras) glyphs.push({ p: e.pts.map((v, j) => r1(v + (j % 2 ? base : x0))), w: e.w });
        base += C.lineH;
      }
      pages.push({ glyphs, n: Math.max(1, n) });
    }
    return { pages, chars: text.replace(/\s/g, '').length, text: text.replace(/[\^_{}]/g, '') };
  }

  // 도형 하나의 선·점(색 없음)과 라벨 후보 자리. 같은 줄이면 늘 같은 결과(뒤 도형 미리 보기에도 씀)
  geom(it, fig) {
    const fw = fig.x1 - fig.x0, fh = fig.y1 - fig.y0;
    const X = (x) => fig.x0 + x / 100 * fw, Y = (y) => fig.y0 + y / 100 * fh;
    const pts = it.pts.map(([x, y]) => [X(x), Y(y)]);
    const rnd = prng(it.line * 31 + 7);
    const lw = 3.2;
    const S = [];
    const color = null;
    const line = (a, b, w = lw) => S.push({ type: 'p', pts: wobbleLine(a[0], a[1], b[0], b[1], rnd, 0.8), w, c: color });
    const head = (a, b, sz = 15) => {
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const p1 = [b[0] - sz * Math.cos(ang - 0.42), b[1] - sz * Math.sin(ang - 0.42)];
      const p2 = [b[0] - sz * Math.cos(ang + 0.42), b[1] - sz * Math.sin(ang + 0.42)];
      S.push({ type: 'p', pts: [p1[0], p1[1], b[0], b[1], p2[0], p2[1]].map(r1), w: lw, c: color });
    };
    let lab = null; // 라벨 위치 [x, y, 정렬]
    const op = it.op;
    if (op === '선') {
      for (let i = 1; i < pts.length; i++) line(pts[i - 1], pts[i]);
      const m = mid(pts[0], pts[pts.length - 1]); const e = pts[pts.length - 1], s0 = pts[0];
      lab = [[m[0], m[1] - 14, 'above'], [m[0], m[1] + 14, 'below'], [e[0] + 10, e[1], 'right'], [s0[0] - 10, s0[1], 'left']];
    } else if (op === '화살표') {
      const a = pts[0], b = pts[pts.length - 1];
      for (let i = 1; i < pts.length; i++) line(pts[i - 1], pts[i]);
      head(pts[pts.length - 2], b);
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const vert = Math.abs(Math.sin(ang)) > 0.7, m = mid(a, b);
      lab = [[a[0] - Math.cos(ang) * 14, a[1] - Math.sin(ang) * 14, vert ? (Math.sin(ang) > 0 ? 'above' : 'below') : (Math.cos(ang) > 0 ? 'left' : 'right')]];
      if (vert) lab.push([a[0] + 12, a[1] + 14, 'right'], [a[0] - 12, a[1] + 14, 'left'], [m[0] + 12, m[1], 'right'], [m[0] - 12, m[1], 'left']);
      else lab.push([a[0], a[1] - 12, 'above'], [a[0], a[1] + 12, 'below'], [m[0], m[1] - 12, 'above'], [m[0], m[1] + 12, 'below']);
    } else if (op === '상자') {
      const [a, b] = pts;
      const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
      S.push({ type: 'p', pts: [...wobbleLine(x0, y0, x1, y0, rnd, 0.7), ...wobbleLine(x1, y0, x1, y1, rnd, 0.7), ...wobbleLine(x1, y1, x0, y1, rnd, 0.7), ...wobbleLine(x0, y1, x0, y0, rnd, 0.7)], w: lw, c: color });
      lab = [[(x0 + x1) / 2, (y0 + y1) / 2, 'center'], [(x0 + x1) / 2, y0 - 10, 'above'], [(x0 + x1) / 2, y1 + 10, 'below']];
    } else if (op === '원') {
      const r = it.r / 100 * Math.min(fw, fh);
      S.push({ type: 'p', pts: circlePts(pts[0][0], pts[0][1], r, r, -Math.PI / 2, 1.0, Math.max(24, Math.min(72, Math.round(r))), null), w: lw, c: color });
      lab = [[pts[0][0], pts[0][1], 'center'], [pts[0][0], pts[0][1] - r - 10, 'above'], [pts[0][0], pts[0][1] + r + 10, 'below']];
    } else if (op === '곡선') {
      S.push({ type: 'p', pts: catmull(pts), w: lw, c: color });
      const e = pts[pts.length - 1]; lab = [[e[0] + 10, e[1] - 10, 'right'], [e[0] - 10, e[1] - 10, 'left'], [e[0], e[1] - 14, 'above'], [e[0], e[1] + 14, 'below']];
    } else if (op === '글') {
      lab = [[pts[0][0], pts[0][1], 'center']];
    } else if (op === '점') {
      for (const p of pts) S.push({ type: 'd', x: r1(p[0]), y: r1(p[1]), r: 5.5, c: color });
      lab = [[pts[0][0] + 10, pts[0][1] - 10, 'right'], [pts[0][0] - 10, pts[0][1] - 10, 'left'], [pts[0][0], pts[0][1] + 12, 'below']];
    } else if (op === '치수') {
      const [a, b] = pts;
      line(a, b, 2.4); head(mid(a, b), a, 12); head(mid(a, b), b, 12);
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), nx = -Math.sin(ang) * 9, ny = Math.cos(ang) * 9;
      S.push({ type: 'p', pts: [a[0] - nx, a[1] - ny, a[0] + nx, a[1] + ny].map(r1), w: 2.4, c: color });
      S.push({ type: 'p', pts: [b[0] - nx, b[1] - ny, b[0] + nx, b[1] + ny].map(r1), w: 2.4, c: color });
      const m = mid(a, b); lab = [[m[0], m[1] + 16, 'below'], [m[0], m[1] - 16, 'above']];
    } else if (op === '등분포') {
      const [a, b] = pts;
      const hgt = clamp(fh * 0.16, 26, 56);
      const n = Math.max(3, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 46));
      line([a[0], a[1] - hgt], [b[0], b[1] - hgt]);
      for (let i = 0; i <= n; i++) {
        const t = i / n, x = a[0] + (b[0] - a[0]) * t, yb = a[1] + (b[1] - a[1]) * t;
        S.push({ type: 'p', pts: [r1(x), r1(yb - hgt), r1(x), r1(yb - 3)], w: 2.4, c: color });
        head([x, yb - hgt], [x, yb - 2], 10);
      }
      const m = mid(a, b); lab = [[m[0], m[1] - hgt - 12, 'above']];
    } else if (op === '지점' || op === '롤러') {
      const sz = clamp(fh * 0.09, 14, 26);
      for (const p of pts) {
        S.push({ type: 'p', pts: [p[0], p[1], p[0] + sz * 0.8, p[1] + sz * 1.3, p[0] - sz * 0.8, p[1] + sz * 1.3, p[0], p[1]].map(r1), w: 2.8, c: color });
        if (op === '롤러') {
          const rr = sz * 0.22, yy = p[1] + sz * 1.3 + rr + 1;
          S.push({ type: 'p', pts: circlePts(p[0] - sz * 0.42, yy, rr, rr, 0, 1, 14, null), w: 2.2, c: color });
          S.push({ type: 'p', pts: circlePts(p[0] + sz * 0.42, yy, rr, rr, 0, 1, 14, null), w: 2.2, c: color });
        } else {
          const yy = p[1] + sz * 1.3;
          for (let k = -2; k <= 1; k++) S.push({ type: 'p', pts: [p[0] + k * sz * 0.5 + sz * 0.1, yy + 1, p[0] + k * sz * 0.5 - sz * 0.25, yy + sz * 0.45].map(r1), w: 1.8, c: color });
        }
      }
      lab = [[pts[0][0], pts[0][1] + sz * 1.9, 'below']];
    }
    for (const s of S) if (s.type === 'p') s.pts = s.pts.map(r1);
    // 라벨 후보를 더 넓게: 기준점(꼬리·가운데·머리·끝 등) 둘레 8방향
    const anchors = [];
    const addA = (p) => { if (p && !anchors.some((q) => Math.abs(q[0] - p[0]) < 1 && Math.abs(q[1] - p[1]) < 1)) anchors.push(p); };
    if (op === '화살표' || op === '선' || op === '치수' || op === '곡선') { addA(pts[0]); addA(mid(pts[0], pts[pts.length - 1])); addA(pts[pts.length - 1]); if (pts.length > 2) addA(pts[Math.floor(pts.length / 2)]); }
    else if (op === '등분포') { const m = mid(pts[0], pts[1]); const hgt = clamp(fh * 0.16, 26, 56); addA([m[0], m[1] - hgt]); addA([pts[1][0], pts[1][1] - hgt]); addA([pts[0][0], pts[0][1] - hgt]); }
    else if (op !== '글') for (const p of pts) addA(p);
    return { S, lab, anchors, op };
  }

  shape(it, fig, color, act, useDef, warn) {
    const fw = fig.x1 - fig.x0;
    const { S, lab, anchors, op } = this.geom(it, fig);
    for (const s of S) { s.c = color; act.strokes.push(s); fig[s.type === 'd' ? 'dots' : 'segs'].push(s.type === 'd' ? s : s.pts); }
    if (!(it.label && lab)) return;
    const size = this.C.sizes.label;
    const ln = this.wrap(it.label, size, fw, this.chain, warn, true)[0];
    if (!ln) return;
    const place = (c) => {
      let x0 = c[0] - ln.w / 2, base = c[1] + (ln.asc - ln.desc) / 2;
      const al = c[2];
      if (al === 'above' || al === 'al' || al === 'ar') base = c[1] - ln.desc;
      if (al === 'below' || al === 'bl' || al === 'br') base = c[1] + ln.asc;
      if (al === 'left' || al === 'al' || al === 'bl') x0 = c[0] - ln.w;
      if (al === 'right' || al === 'ar' || al === 'br') x0 = c[0];
      return [x0, base];
    };
    // 후보: 원래 자리(앞쪽이 우선) → 기준점 둘레 8방향(가까운 것, 조금 먼 것)
    const cands = lab.slice();
    if (op !== '글') {
      for (const gap of [12, 26]) for (const a of anchors) {
        const d = gap * 0.75;
        cands.push([a[0] + gap, a[1], 'right'], [a[0] - gap, a[1], 'left'], [a[0], a[1] - gap, 'above'], [a[0], a[1] + gap, 'below'],
          [a[0] + d, a[1] - d, 'ar'], [a[0] - d, a[1] - d, 'al'], [a[0] + d, a[1] + d, 'br'], [a[0] - d, a[1] + d, 'bl']);
      }
    }
    // 같은 구역의 모든 선(이미 그린 것 + 뒤에 그릴 것), 점, 이미 놓인 라벨·뒤에 올 '글' 자리
    const segs = fig.segs.concat(...fig.ahead.map((a) => a.segs));
    const dots = fig.dots.concat(...fig.ahead.map((a) => a.dots));
    const rects = fig.labels.concat(fig.ahead.filter((a) => a.rect).map((a) => a.rect));
    const B = this.C.boardBottom;
    const cost = ([x0, base]) => {
      const r = [x0 - 4, base - ln.asc - 3, x0 + ln.w + 4, base + ln.desc + 3];
      let c = 0;
      if (r[0] < fig.x0 - 1 || r[2] > fig.x1 + 1 || r[1] < fig.y0 - 1 || r[3] > B) c += 1000;
      for (const p of segs) for (let i = 2; i < p.length; i += 2) if (segHitsRect(p[i - 2], p[i - 1], p[i], p[i + 1], r)) c += 10;
      for (const d of dots) if (d.x + d.r > r[0] && d.x - d.r < r[2] && d.y + d.r > r[1] && d.y - d.r < r[3]) c += 10;
      const area = (r[2] - r[0]) * (r[3] - r[1]);
      for (const q of rects) { const ix = Math.min(r[2], q[2]) - Math.max(r[0], q[0]), iy = Math.min(r[3], q[3]) - Math.max(r[1], q[1]); if (ix > 0 && iy > 0) c += 30 + 60 * ix * iy / area; }
      return c;
    };
    let best = null, bc = Infinity;
    for (let i = 0; i < cands.length; i++) {
      const q = place(cands[i]);
      const c = cost(q) + i * 0.001; // 같으면 앞 후보
      if (c < bc) { bc = c; best = q; }
      if (op === '글') break; // '글' 은 적은 자리 그대로
    }
    let [x0, base] = best;
    // 그래도 그림 구역 밖이면 안으로 가둔다 — 옆 칸 글이나 위쪽 글과 겹치지 않게
    x0 = ln.w <= fw ? clamp(x0, fig.x0, fig.x1 - ln.w) : (fig.x0 + fig.x1 - ln.w) / 2;
    x0 = clamp(x0, 6, this.C.W - 6 - ln.w);
    base = clamp(base, Math.max(this.C.margin.t, fig.y0) + ln.asc, B - ln.desc);
    fig.labels.push([x0, base - ln.asc, x0 + ln.w, base + ln.desc]);
    this.pushLine(act, ln, x0, base, color, useDef);
  }
}

// ── 도움 함수 ──
// 선분이 사각형 [x0,y0,x1,y1] 을 지나는가(Liang–Barsky)
function segHitsRect(ax, ay, bx, by, r) {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  const p = [-dx, dx, -dy, dy], q = [ax - r[0], r[2] - ax, ay - r[1], r[3] - ay];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return false; continue; }
    const t = q[i] / p[i];
    if (p[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return true;
}
function r3(v) { return Math.round(v * 1000) / 1000; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function mid(a, b) { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
function shiftP(e, dx, dy) { return { ...e, pts: e.pts.map((v, j) => v + (j % 2 ? dy : dx)) }; }
function clampPts(p, x0, y0, x1, y1) { return p.map((v, j) => r1(j % 2 ? clamp(v, y0, y1) : clamp(v, x0, x1))); }
function wobbleLine(x0, y0, x1, y1, rnd, amp) {
  const L = Math.hypot(x1 - x0, y1 - y0), n = Math.max(2, Math.round(L / 40));
  const nx = -(y1 - y0) / (L || 1), ny = (x1 - x0) / (L || 1);
  const ph = rnd() * 6.28, out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, w = (i === 0 || i === n) ? 0 : Math.sin(t * Math.PI * 1.3 + ph) * amp;
    out.push(r1(x0 + (x1 - x0) * t + nx * w), r1(y0 + (y1 - y0) * t + ny * w));
  }
  return out;
}
function circlePts(cx, cy, rx, ry, a0, turns, n, rnd) {
  const out = [];
  const N = Math.round(n * turns);
  for (let i = 0; i <= N; i++) {
    const a = a0 + (i / n) * Math.PI * 2;
    const j = rnd ? 1 + (Math.sin(i * 0.7) * 0.02 + (i / N) * 0.06) : 1;
    out.push(r1(cx + Math.cos(a) * rx * j), r1(cy + Math.sin(a) * ry * j));
  }
  return out;
}
function catmull(pts) {
  const out = [];
  const P = [pts[0], ...pts, pts[pts.length - 1]];
  for (let i = 1; i < P.length - 2; i++) {
    const [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]];
    const n = Math.max(6, Math.round(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 10));
    for (let k = (i === 1 ? 0 : 1); k <= n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push(r1(f(p0[0], p1[0], p2[0], p3[0])), r1(f(p0[1], p1[1], p2[1], p3[1])));
    }
  }
  return out;
}
function findText(blocks, target) {
  const norm = (x) => x.replace(/[\s^_{}/]/g, ''); // 띄어쓰기·첨자·분수 표시는 빼고 비교
  const want = norm(target);
  if (!want) return null;
  for (let b = blocks.length - 1; b >= 0; b--) {
    const blk = blocks[b];
    const idx = []; let s = '';
    blk.chars.forEach((c, i) => { if (c && norm(c)) { s += c; idx.push(i); } });
    const at = s.lastIndexOf(want);
    if (at >= 0) return idx.slice(at, at + want.length).map((i) => blk.boxes[i]);
  }
  return null;
}
function groupRows(boxes) {
  const rows = [];
  for (const b of boxes) {
    let r = rows.find((q) => Math.abs(q.base - b[4]) < 2);
    if (!r) { r = { base: b[4], size: b[5], x0: b[0], x1: b[2], bottom: b[3] }; rows.push(r); }
    r.x0 = Math.min(r.x0, b[0]); r.x1 = Math.max(r.x1, b[2]); r.bottom = Math.max(r.bottom, b[3]);
  }
  return rows;
}
export function mergeCfg(a, b) {
  const o = Array.isArray(a) ? a.slice() : { ...a };
  for (const k of Object.keys(b || {})) o[k] = (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k]) ? mergeCfg(a[k], b[k]) : b[k];
  return o;
}
