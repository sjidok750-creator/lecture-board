// 판 그리기 — 타임라인의 '시각 t' 프레임을 그린다. 브라우저 <canvas> 와 Node(@napi-rs/canvas) 공용.
// 같은 t 면 늘 같은 그림(끝난 획은 바탕 층에 굽고, 진행 중 획·펜촉·자막만 매번 그림).
// 시각이 뒤로 가면(처음부터) 바탕 층을 처음부터 다시 굽는다.
//
// 손맛(0.2.0): 글자마다 윤곽을 저주파 잡음으로 살짝 휘고(같은 글자도 매번 조금 다름) 기울인다.
// 글자·선은 한 번 '잉크 그림'(마커 줄무늬·시작 뭉침·끝 옅어짐)으로 구워 두고,
// 쓰는 중에는 펜이 지나간 자리만 그 그림에서 오려 내어 곱하기(multiply)로 얹는다 → 겹친 곳은 조금 진해진다.

const BG = '#ffffff';

function prng(seed) { let s = (seed * 2654435761) >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

function pathCmds(ctx, cmds) {
  ctx.beginPath();
  for (const c of cmds) {
    if (c[0] === 'M') ctx.moveTo(c[1], c[2]);
    else if (c[0] === 'L') ctx.lineTo(c[1], c[2]);
    else if (c[0] === 'Q') ctx.quadraticCurveTo(c[1], c[2], c[3], c[4]);
    else if (c[0] === 'C') ctx.bezierCurveTo(c[1], c[2], c[3], c[4], c[5], c[6]);
    else if (c[0] === 'Z') ctx.closePath();
  }
}

// 꺾은선을 길이 L 까지 그리고 끝점을 돌려준다
function strokePartial(ctx, pl, L) {
  ctx.moveTo(pl[0], pl[1]);
  let acc = 0;
  for (let i = 2; i < pl.length; i += 2) {
    const dx = pl[i] - pl[i - 2], dy = pl[i + 1] - pl[i - 1];
    const seg = Math.hypot(dx, dy);
    if (acc + seg >= L) {
      const f = seg ? (L - acc) / seg : 0;
      const x = pl[i - 2] + dx * f, y = pl[i - 1] + dy * f;
      ctx.lineTo(x, y);
      return [x, y, true];
    }
    ctx.lineTo(pl[i], pl[i + 1]);
    acc += seg;
  }
  return [pl[pl.length - 2], pl[pl.length - 1], false];
}

function polyLen(p) { let L = 0; for (let i = 2; i < p.length; i += 2) L += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]); return L; }
function ease(p) { return p < 0 ? 0 : p > 1 ? 1 : p * p * (3 - 2 * p) * 0.35 + p * 0.65; }
// 획 하나 안의 가감속(시작·끝에서 느리게)
function easeStroke(q) { return q <= 0 ? 0 : q >= 1 ? 1 : q * q * (3 - 2 * q) * 0.55 + q * 0.45; }

// 마커 줄무늬 무늬(256×256, 이어 붙여도 이음매 없음). 결정적.
function makeTexture(env) {
  const N = 256;
  const cv = env.createCanvas(N, N), c = cv.getContext('2d');
  const r = prng(9001);
  const ang = -0.62, ux = Math.cos(ang), uy = Math.sin(ang), nx = -uy, ny = ux;
  c.lineCap = 'round';
  const streak = (rgba, wmin, wmax) => {
    const o = (r() - 0.5) * N * 1.5, w = wmin + r() * (wmax - wmin), a = rgba[3] * (0.5 + r() * 0.5);
    const len = 40 + r() * 140, s0 = (r() - 0.5) * N;
    c.strokeStyle = `rgba(${rgba[0]},${rgba[1]},${rgba[2]},${a.toFixed(3)})`; c.lineWidth = w;
    for (let ox = -N; ox <= N; ox += N) for (let oy = -N; oy <= N; oy += N) {
      const cx = N / 2 + nx * o + ux * s0 + ox, cy = N / 2 + ny * o + uy * s0 + oy;
      c.beginPath(); c.moveTo(cx - ux * len / 2, cy - uy * len / 2); c.lineTo(cx + ux * len / 2, cy + uy * len / 2); c.stroke();
    }
  };
  for (let i = 0; i < 46; i++) streak([255, 255, 255, 0.20], 0.7, 1.9);  // 마른 줄(밝음)
  for (let i = 0; i < 18; i++) streak([0, 0, 0, 0.10], 0.8, 2.2);        // 잉크가 몰린 줄(어두움)
  if (env.flush) env.flush(c);
  return cv;
}

export class Board {
  /** env: { createCanvas(w,h) } — 바탕 층을 만들 때 씀 */
  constructor(env, tl) {
    this.env = env;
    this.tl = tl;
    this.W = tl.W; this.H = tl.H;
    this.base = env.createCanvas(this.W, this.H);
    this.bctx = this.base.getContext('2d');
    this.scratch = env.createCanvas(this.W, this.H);
    this.sctx = this.scratch.getContext('2d');
    this.tmp = env.createCanvas(this.W, this.H);
    this.tctx = this.tmp.getContext('2d');
    this.tex = makeTexture(env);
    this.reset();
  }
  setTimeline(tl) { this.tl = tl; }
  get hand() { return (this.tl.style && this.tl.style.hand) || {}; }
  reset() {
    this.ai = 0; this.si = 0; this.tDone = -1;
    this.bctx.globalCompositeOperation = 'source-over';
    this.bctx.fillStyle = BG; this.bctx.fillRect(0, 0, this.W, this.H);
  }

  // ── 글자 한 벌(이 자리의 이 글자): 기울이고 윤곽을 살짝 휜 모양. 획마다 한 번 계산해 둔다 ──
  inst(s) {
    if (s._i) return s._i;
    const d = this.tl.defs[s.k];
    const H = this.hand;
    const amp = (H.warp ?? 0) * 20, rough = (H.warp ?? 0) * 5;
    if (!s.ws && !s.r) { s._i = d; return d; }
    const r = prng(s.ws || 1);
    const ph = [r(), r(), r(), r(), r(), r()].map((v) => v * 6.2832);
    const f1 = 0.0062 + r() * 0.003, f2 = 0.0062 + r() * 0.003;
    const ca = Math.cos(s.r || 0), sa = Math.sin(s.r || 0);
    const T = (x, y) => {
      const wx = x + amp * (Math.sin(y * f1 + ph[0]) + 0.6 * Math.sin(x * f2 + ph[1])) + rough * Math.sin(x * 0.071 + y * 0.053 + ph[2]);
      const wy = y + amp * (Math.sin(x * f2 + ph[3]) + 0.6 * Math.sin(y * f1 + ph[4])) + rough * Math.sin(y * 0.067 - x * 0.047 + ph[5]);
      return [wx * ca - wy * sa, wx * sa + wy * ca];
    };
    const cmds = d.cmds.map((c) => {
      if (c[0] === 'Z') return c;
      const o = [c[0]];
      for (let i = 1; i < c.length; i += 2) { const p = T(c[i], c[i + 1]); o.push(p[0], p[1]); }
      return o;
    });
    const polys = d.polys.map((pl) => { const o = new Array(pl.length); for (let i = 0; i < pl.length; i += 2) { const p = T(pl[i], pl[i + 1]); o[i] = p[0]; o[i + 1] = p[1]; } return o; });
    const lens = polys.map(polyLen);
    s._i = { cmds, polys, lens, len: lens.reduce((a, b) => a + b, 0) };
    return s._i;
  }

  // ── 잉크 그림(획 하나를 다 쓴 모습)을 작은 캔버스에 구움 ──
  ink(s) {
    if (s._im) return s._im;
    const H = this.hand, amount = H.ink ?? 0;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, sp, ep, sz;
    let I = null, k = 1;
    if (s.type === 'g') {
      I = this.inst(s); k = s.s / 1000;
      for (const pl of I.polys) for (let i = 0; i < pl.length; i += 2) { const x = s.x + pl[i] * k, y = s.y + pl[i + 1] * k; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      if (x0 === Infinity) { x0 = x1 = s.x; y0 = y1 = s.y; }
      sp = this.startPt(s); ep = this.endPt(s); sz = s.s;
    } else {
      const p = s.pts;
      for (let i = 0; i < p.length; i += 2) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]); }
      x0 -= s.w; y0 -= s.w; x1 += s.w; y1 += s.w;
      sp = [p[0], p[1]]; ep = [p[p.length - 2], p[p.length - 1]]; sz = Math.max(18, s.w * 8);
    }
    const pad = 3;
    const ox = Math.floor(x0) - pad, oy = Math.floor(y0) - pad;
    const w = Math.max(1, Math.ceil(x1) + pad - ox), h = Math.max(1, Math.ceil(y1) + pad - oy);
    const cv = this.env.createCanvas(w, h), c = cv.getContext('2d');
    c.save(); c.translate(-ox, -oy);
    if (s.type === 'g') {
      c.translate(s.x, s.y); c.scale(k, k); pathCmds(c, I.cmds); c.fillStyle = s.c; c.fill('nonzero');
    } else {
      c.strokeStyle = s.c; c.lineWidth = s.w; c.lineCap = 'round'; c.lineJoin = 'round';
      c.beginPath(); c.moveTo(s.pts[0], s.pts[1]); for (let i = 2; i < s.pts.length; i += 2) c.lineTo(s.pts[i], s.pts[i + 1]); c.stroke();
    }
    c.restore();
    if (amount > 0 && w <= this.W && h <= this.H) {
      // 잉크 면(색 + 줄무늬 + 뭉침·옅어짐)을 따로 그린 뒤, 모양 안쪽만 남긴다(source-in — 투명 바깥에 찌꺼기가 남지 않음)
      const seed = s.type === 'g' ? (s.ws || 7) : Math.round(s.pts[0] * 7 + s.pts[1] * 13);
      const t = this.tctx;
      t.save();
      t.clearRect(0, 0, w, h);
      t.fillStyle = s.c; t.fillRect(0, 0, w, h);
      t.globalAlpha = Math.min(1, amount);
      const tx = (seed % 251), ty = ((seed >>> 8) % 241);
      for (let y = -ty; y < h; y += 256) for (let x = -tx; x < w; x += 256) t.drawImage(this.tex, x, y);
      // 펜을 대는 곳의 진한 뭉침, 떼는 곳의 옅어짐
      let g = t.createRadialGradient(sp[0] - ox, sp[1] - oy, 0, sp[0] - ox, sp[1] - oy, sz * 0.2);
      g.addColorStop(0, 'rgba(0,0,0,0.30)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      t.fillStyle = g; t.fillRect(0, 0, w, h);
      g = t.createRadialGradient(ep[0] - ox, ep[1] - oy, 0, ep[0] - ox, ep[1] - oy, sz * 0.32);
      g.addColorStop(0, 'rgba(255,255,255,0.26)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      t.fillStyle = g; t.fillRect(0, 0, w, h);
      t.restore();
      if (this.env.flush) this.env.flush(t);
      c.save(); c.globalCompositeOperation = 'source-in'; c.drawImage(this.tmp, 0, 0, w, h, 0, 0, w, h); c.restore();
    }
    if (this.env.flush) this.env.flush(c);
    s._im = { cv, ox, oy, w, h };
    return s._im;
  }
  putInk(ctx, im) {
    ctx.save(); ctx.globalCompositeOperation = 'multiply'; ctx.drawImage(im.cv, im.ox, im.oy); ctx.restore();
  }
  // 오려 낸 부분 잉크: draw(c) 가 그린 자리(불투명)만 잉크 그림에서 남겨 얹는다
  putMasked(ctx, im, draw) {
    const c = this.sctx;
    c.save();
    c.beginPath(); c.rect(im.ox, im.oy, im.w, im.h); c.clip();
    c.clearRect(im.ox, im.oy, im.w, im.h);
    c.save(); const r = draw(c); c.restore();
    c.globalCompositeOperation = 'source-in';
    c.drawImage(im.cv, im.ox, im.oy);
    c.restore();
    ctx.save(); ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(this.scratch, im.ox, im.oy, im.w, im.h, im.ox, im.oy, im.w, im.h);
    ctx.restore();
    return r;
  }

  // ── 획 그리기 ──
  glyphFull(ctx, s) { this.putInk(ctx, this.ink(s)); }
  // 진행 중 글자: 굵은 펜이 윤곽 조각을 차례로 따라가며 지나간 자리만 잉크가 나타난다(조각 사이는 펜을 들어 옮김)
  glyphPartial(ctx, s, p) {
    const I = this.inst(s), im = this.ink(s);
    const font = s.k.split(':')[0];
    const tw = (this.tl.style.traceW || {})[font] || 150;
    const k = s.s / 1000;
    const n = I.polys.length;
    const gap = n > 1 ? 0.04 : 0, D = 1 - gap * (n - 1);
    let tip = null, lift = 0;
    this.putMasked(ctx, im, (c) => {
      c.translate(s.x, s.y); c.scale(k, k);
      c.strokeStyle = '#000'; c.lineWidth = tw; c.lineCap = 'round'; c.lineJoin = 'round';
      c.beginPath();
      let acc = 0;
      for (let i = 0; i < n; i++) {
        const share = I.len > 0 ? D * I.lens[i] / I.len : D / n;
        const pl = I.polys[i];
        if (p < acc + share) { tip = strokePartial(c, pl, I.lens[i] * easeStroke((p - acc) / (share || 1))); break; }
        strokePartial(c, pl, I.lens[i] + 1); acc += share;
        if (i < n - 1) {
          if (p < acc + gap) { // 다음 조각으로 펜을 들어 옮기는 중
            const f = (p - acc) / gap, nx = I.polys[i + 1];
            const ex = pl[pl.length - 2], ey = pl[pl.length - 1];
            tip = [ex + (nx[0] - ex) * f, ey + (nx[1] - ey) * f]; lift = Math.sin(Math.PI * f);
            break;
          }
          acc += gap;
        }
        tip = [pl[pl.length - 2], pl[pl.length - 1]];
      }
      c.stroke();
    });
    return tip ? [s.x + tip[0] * k, s.y + tip[1] * k, lift] : [s.x, s.y, 0];
  }
  lineFull(ctx, s) { this.putInk(ctx, this.ink(s)); }
  linePartial(ctx, s, p) {
    if (s._len === undefined) s._len = polyLen(s.pts);
    const im = this.ink(s);
    return this.putMasked(ctx, im, (c) => {
      c.strokeStyle = '#000'; c.lineWidth = s.w + 1; c.lineCap = 'round'; c.lineJoin = 'round';
      c.beginPath();
      const r = strokePartial(c, s.pts, s._len * ease(p));
      c.stroke();
      return [r[0], r[1], 0];
    });
  }
  dotFull(ctx, s) { ctx.save(); ctx.fillStyle = s.c; ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill(); ctx.restore(); }

  full(ctx, s) {
    if (s.type === 'g') this.glyphFull(ctx, s); else if (s.type === 'p') this.lineFull(ctx, s); else this.dotFull(ctx, s);
    delete s._im; // 바탕에 구웠으면 잉크 그림은 버림(처음부터 다시 볼 때 다시 만듦)
  }
  partial(ctx, s, p) {
    if (s.type === 'g') return this.glyphPartial(ctx, s, p);
    if (s.type === 'p') return this.linePartial(ctx, s, p);
    if (p > 0.5) this.dotFull(ctx, s);
    return [s.x, s.y, 0];
  }
  startPt(s) { if (s.type === 'g') { const d = this.inst(s); const pl = d.polys[0]; const k = s.s / 1000; return pl ? [s.x + pl[0] * k, s.y + pl[1] * k] : [s.x, s.y]; } if (s.type === 'p') return [s.pts[0], s.pts[1]]; return [s.x, s.y]; }
  endPt(s) { if (s.type === 'g') { const d = this.inst(s); const pl = d.polys[d.polys.length - 1]; const k = s.s / 1000; return pl ? [s.x + pl[pl.length - 2] * k, s.y + pl[pl.length - 1] * k] : [s.x, s.y]; } if (s.type === 'p') return [s.pts[s.pts.length - 2], s.pts[s.pts.length - 1]]; return [s.x, s.y]; }

  // ── 시각 t 의 프레임 ──
  /** 시각 t 까지 끝난 획을 바탕 층에 굽는다 */
  advance(t) {
    const acts = this.tl.actions;
    if (t < this.tDone) this.reset();
    // 끝난 획을 바탕 층에 굽기
    while (this.ai < acts.length) {
      const a = acts[this.ai];
      if (t < a.t0) break;
      if (a.kind === 'wipe') {
        if (t >= a.t0 + a.write) { this.bctx.fillStyle = BG; this.bctx.fillRect(0, 0, this.W, this.H); this.ai++; this.si = 0; this.dirty = true; continue; }
        break;
      }
      while (this.si < a.strokes.length) {
        const s = a.strokes[this.si];
        if (t < a.t0 + s.st + s.d) break;
        this.full(this.bctx, s); this.si++; this.dirty = true;
      }
      if (this.si >= a.strokes.length && t >= a.t0 + a.dur) { this.ai++; this.si = 0; continue; }
      break;
    }
    this.tDone = t;
    if (this.env.flush && this.dirty) { this.env.flush(this.bctx); }
    this.dirty = false;
  }

  /** 시각 t 프레임이 앞 프레임과 똑같은지 가리는 열쇠(advance 뒤에 부름). 움직이는 중이면 null */
  key(t) {
    const a = this.tl.actions[this.ai];
    if (!a || t < a.t0) return `i${this.ai}`;
    const lt = t - a.t0;
    if (a.kind === 'wipe') return null;
    if (a.kind === 'draw' && this.si < a.strokes.length) return null;
    const pi = a.cap ? a.cap.pages.findIndex((p) => lt >= p.st && lt < p.st + p.d) : -1;
    return `w${this.ai}:${pi}`;
  }

  render(ctx, t) { this.advance(t); this.paint(ctx, t); }

  /** 지금 보이는 자막 글(없으면 '') — 휴대폰 세로 화면에서 판 아래에 크게 보일 때 씀 */
  captionText(t) {
    const a = this.tl.actions[this.ai];
    if (!a || t < a.t0 || !a.cap) return '';
    return a.cap.text || '';
  }

  paint(ctx, t) {
    const acts = this.tl.actions;
    ctx.drawImage(this.base, 0, 0);
    const liftAmt = this.hand.lift ?? 0;

    // 진행 중 동작
    let pen = null, penColor = '#1d1d1f';
    const a = acts[this.ai];
    if (a && t >= a.t0) {
      const lt = t - a.t0;
      if (a.kind === 'wipe') {
        const p = Math.min(1, lt / a.write);
        this.drawWipe(ctx, p);
      } else if (a.kind === 'draw' && a.strokes.length) {
        const s = a.strokes[this.si];
        if (s && lt >= s.st) {
          pen = this.partial(ctx, s, (lt - s.st) / s.d); penColor = s.c;
        } else if (s) { // 획 사이: 펜을 살짝 들어 다음 획 시작점으로 옮겨 감
          const prev = this.si > 0 ? a.strokes[this.si - 1] : this.prevStroke(this.ai);
          const from = prev ? this.endPt(prev) : this.startPt(s);
          const to = this.startPt(s);
          const t0 = this.si > 0 ? prev.st + prev.d : 0;
          const f = Math.max(0, Math.min(1, (lt - t0) / Math.max(0.001, s.st - t0)));
          const dist = Math.hypot(to[0] - from[0], to[1] - from[1]);
          pen = [from[0] + (to[0] - from[0]) * f, from[1] + (to[1] - from[1]) * f, Math.sin(Math.PI * f) * Math.min(1, dist / 24)]; penColor = s.c;
        } else { const l = a.strokes[a.strokes.length - 1]; pen = this.endPt(l); penColor = l.c; }
      } else { const l = this.prevStroke(this.ai + 1); if (l) { pen = this.endPt(l); penColor = l.c; } }
      this.drawCaption(ctx, a, lt);
    } else {
      if (this.ai > 0) { const l = this.prevStroke(this.ai); if (l) { pen = this.endPt(l); penColor = l.c; } }
      this.drawCaption(ctx, null, 0);
    }
    if (pen) this.drawPen(ctx, pen[0], pen[1], penColor, (pen[2] || 0) * liftAmt);
  }

  prevStroke(ai) { // ai 앞 동작들 중 마지막 획(지우기 뒤면 없음)
    const acts = this.tl.actions;
    for (let i = ai - 1; i >= 0; i--) { const a = acts[i]; if (a.kind === 'wipe') return null; if (a.strokes.length) return a.strokes[a.strokes.length - 1]; }
    return null;
  }

  drawWipe(ctx, p) {
    const W = this.W, bottom = this.tl.style.boardBottom + 8;
    const e = p * p * (3 - 2 * p);
    const front = -40 + (W + 80) * e;
    ctx.save();
    ctx.fillStyle = BG; ctx.fillRect(0, 0, Math.max(0, front), bottom);
    // 지우개(회색 펠트)
    const ey = 40 + (bottom - 200) * (0.5 + 0.5 * Math.sin(p * Math.PI * 7));
    ctx.translate(front, ey + 70); ctx.rotate(-0.12);
    ctx.fillStyle = '#d9d6cf'; ctx.fillRect(-26, -78, 52, 156);
    ctx.fillStyle = '#8a8378'; ctx.fillRect(-26, -78, 14, 156);
    ctx.restore();
  }

  drawPen(ctx, x, y, c, lift = 0) {
    // 펜촉만: 마커 끝(색) + 짧은 몸통. lift(0~1) 만큼 판에서 떠 있음(위로 살짝 + 옅은 그림자)
    ctx.save();
    if (lift > 0.02) { ctx.fillStyle = `rgba(0,0,0,${(0.10 * lift).toFixed(3)})`; ctx.beginPath(); ctx.arc(x + 1, y + 2, 3.5, 0, Math.PI * 2); ctx.fill(); }
    ctx.translate(x - 3 * lift, y - 9 * lift);
    ctx.rotate(-0.72 - 0.06 * lift);
    ctx.fillStyle = c;
    ctx.beginPath(); ctx.moveTo(-1.5, 0); ctx.lineTo(1.5, 0); ctx.lineTo(7, 15); ctx.lineTo(-7, 15); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#f4f3f0'; ctx.strokeStyle = '#8f8b84'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(-8, 15); ctx.lineTo(8, 15); ctx.lineTo(10, 64); ctx.lineTo(-10, 64); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = c; ctx.fillRect(-10, 52, 20, 12);
    ctx.restore();
  }

  // 자막: 쪽(page)마다 띠 그림을 한 번 구워 두고 붙인다
  drawCaption(ctx, a, lt) {
    let pg = null;
    if (a && a.cap) pg = a.cap.pages.find((p) => lt >= p.st && lt < p.st + p.d) || (lt >= a.dur ? a.cap.pages[a.cap.pages.length - 1] : null);
    const holder = pg || this;
    const y0 = this.tl.style.cap.top - 6;
    if (!holder._cv) holder._cv = this.captionStrip(pg);
    ctx.drawImage(holder._cv, 0, y0);
  }
  captionStrip(pg) {
    const st = this.tl.style.cap;
    const y0 = st.top - 6;
    const cv = this.env.createCanvas(this.W, this.H - y0);
    const ctx = cv.getContext('2d');
    ctx.save();
    ctx.fillStyle = st.band; ctx.fillRect(0, 0, this.W, this.H - y0);
    ctx.translate(0, -y0);
    {
      if (pg) {
        ctx.fillStyle = st.color; ctx.strokeStyle = st.color;
        for (const g of pg.glyphs) {
          if (g.p) { ctx.lineWidth = g.w; ctx.beginPath(); ctx.moveTo(g.p[0], g.p[1]); for (let i = 2; i < g.p.length; i += 2) ctx.lineTo(g.p[i], g.p[i + 1]); ctx.stroke(); continue; }
          const d = this.tl.defs[g.k];
          ctx.save(); ctx.translate(g.x, g.y); const k = g.s / 1000; ctx.scale(k, k);
          pathCmds(ctx, d.cmds); ctx.fill('nonzero'); ctx.restore();
        }
      }
    }
    ctx.restore();
    if (this.env.flush) this.env.flush(ctx);
    return cv;
  }
}

/** 타임라인 전체 길이(끝난 뒤 1초 머묾 포함) */
export function totalDuration(tl, hold = 1.0) { return tl.end + hold; }
