// 강의 대본 해석기 — 줄 단위 짧은 형식을 '판서 동작' 목록으로 바꾼다. 브라우저·Node 공용 순수 모듈.
//
// 결과: { items: [...], errors: [{line, msg}], ended }
//   동작 항목에는 바로 앞 '::' 해설(자막)이 cap 으로 붙는다.
// 이어 붙이기: 개행으로 끝나지 않은 마지막 줄은 아직 덜 온 것으로 보고 읽지 않는다(@끝 이 오면 전부 읽음).
// 같은 앞부분은 늘 같은 항목을 만든다(덧붙여도 앞 항목이 바뀌지 않음).

const COLORS = { 검정: 'k', 파랑: 'b', 빨강: 'r', 초록: 'g' };
const SHAPES = new Set(['선', '화살표', '상자', '원', '곡선', '글', '점', '치수', '등분포', '지점', '롤러']);

function takeColor(s) {
  const m = s.match(/\s*\{(검정|파랑|빨강|초록)\}\s*$/);
  if (!m) return [s, null];
  return [s.slice(0, m.index), COLORS[m[1]]];
}

function parseShape(op, rest, ln) {
  // 따옴표 글(라벨) 빼기
  let label = null;
  const qm = rest.match(/["“”]([^"“”]*)["“”]/);
  if (qm) { label = qm[1]; rest = rest.slice(0, qm.index) + ' ' + rest.slice(qm.index + qm[0].length); }
  const toks = rest.trim().split(/\s+/).filter(Boolean);
  const pts = [];
  const nums = [];
  for (const t of toks) {
    const m = t.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
    if (m) pts.push([+m[1], +m[2]]);
    else if (/^-?\d+(?:\.\d+)?$/.test(t)) nums.push(+t);
    else if ((op === '지점' || op === '롤러') && /^(핀|롤러|고정)$/.test(t)) nums.push(t);
    else return { err: `'${op}' 줄에서 '${t}' 를 읽지 못했습니다(좌표는 x,y — 띄어쓰기 없이, 0~100)` };
  }
  const need = { 선: 2, 화살표: 2, 상자: 2, 원: 1, 곡선: 2, 글: 1, 점: 1, 치수: 2, 등분포: 2, 지점: 1, 롤러: 1 }[op];
  if (pts.length < need) return { err: `'${op}' 에는 좌표 x,y 가 ${need}개 이상 필요합니다(지금 ${pts.length}개)` };
  if (op === '원' && !(nums.length && nums[0] > 0)) return { err: `'원' 은 '원 x,y 반지름' 꼴입니다(반지름이 없음)` };
  if (op === '글' && !label) return { err: `'글' 은 '글 x,y "내용"' 꼴입니다(따옴표 글이 없음)` };
  for (const p of pts) if (p[0] < -5 || p[0] > 105 || p[1] < -5 || p[1] > 105) return { err: `'${op}' 좌표 ${p[0]},${p[1]} 이 그림 구역(0~100) 밖입니다` };
  return { shape: { op, pts, r: op === '원' ? nums[0] : null, label } };
}

export function parseScript(text, opts = {}) {
  const raw = text.replace(/\r\n?/g, '\n').replace(/^﻿/, '');
  let lines = raw.split('\n');
  const ended0 = /(^|\n)\s*@끝\s*(\n|$)/.test(raw);
  if (!ended0 && !opts.final && !raw.endsWith('\n')) lines = lines.slice(0, -1); // 덜 온 마지막 줄
  if (raw.endsWith('\n')) lines = lines.slice(0, -1);

  const items = [];
  const errors = [];
  let cap = [];
  let inFig = false, figStart = -1;
  let ended = false;
  const err = (ln, msg) => errors.push({ line: ln, msg });
  const emit = (it) => {
    if (cap.length) { it.cap = cap.join(' '); cap = []; }
    items.push(it);
  };

  for (let i = 0; i < lines.length; i++) {
    const ln = i + 1;
    let s = lines[i].replace(/\t/g, '    ');
    if (ended) { if (s.trim()) err(ln, "'@끝' 뒤의 줄은 읽지 않습니다"); continue; }
    if (!s.trim()) continue;
    const ind = s.match(/^ */)[0].length;
    let body = s.trim();

    if (body === '@끝') {
      if (inFig) { err(ln, "'[그림]' 구역이 닫히지 않은 채 끝났습니다 — 여기서 닫습니다"); items.push({ t: 'figEnd', line: ln }); inFig = false; }
      if (cap.length) emit({ t: 'pause', line: ln });
      ended = true;
      continue;
    }
    if (body.startsWith('::')) { const c = body.slice(2).trim(); if (c) cap.push(c); continue; }
    if (body.startsWith('//')) continue; // 메모(무시)

    // 그림 구역
    const fm = body.match(/^\[\s*그림\s*(.*?)\]$/);
    if (fm) {
      if (inFig) { err(ln, "'[그림]' 안에서 다시 '[그림]' 을 열었습니다 — 앞 구역을 닫고 새로 엽니다"); items.push({ t: 'figEnd', line: ln }); }
      let h = 40, pos = '가운데';
      for (const tok of fm[1].split(/\s+/).filter(Boolean)) {
        let m;
        if ((m = tok.match(/^(?:높이=)?(\d+(?:\.\d+)?)%?$/))) h = +m[1];
        else if ((m = tok.match(/^(?:위치=)?(오른쪽|왼쪽|가운데)$/))) pos = m[1];
        else err(ln, `'[그림]' 설정 '${tok}' 를 모릅니다(높이=숫자, 위치=오른쪽/왼쪽/가운데)`);
      }
      if (h < 10 || h > 100) { err(ln, `그림 높이 ${h} 는 10~100 이어야 합니다 — 40 으로 합니다`); h = 40; }
      figStart = items.length;
      items.push({ t: 'fig', h, pos, line: ln });
      inFig = true;
      continue;
    }
    if (/^\[\s*\/\s*그림\s*\]$/.test(body)) {
      if (!inFig) { err(ln, "열린 '[그림]' 이 없는데 '[/그림]' 이 나왔습니다 — 건너뜁니다"); continue; }
      items.push({ t: 'figEnd', line: ln });
      inFig = false;
      continue;
    }

    let color;
    [body, color] = takeColor(body);
    body = body.trim();
    const op = body.split(/\s+/)[0];
    if (SHAPES.has(op)) {
      if (!inFig) { err(ln, `'${op}' 은 '[그림]' 구역 안에서만 씁니다 — 건너뜁니다`); continue; }
      const r = parseShape(op, body.slice(op.length), ln);
      if (r.err) { err(ln, r.err + ' — 이 줄은 건너뜁니다'); continue; }
      emit({ t: 'shape', ...r.shape, color, line: ln });
      continue;
    }
    if (inFig) { err(ln, `그림 구역 안에서 '${body.slice(0, 12)}' 를 읽지 못했습니다(선·화살표·상자·원·곡선·글·점·치수·등분포·지점·롤러) — 건너뜁니다`); continue; }

    let m;
    if (body === '---') { emit({ t: 'wipe', line: ln }); continue; }
    if ((m = body.match(/^#\s*(.+)$/))) { emit({ t: 'title', text: m[1].trim(), color, line: ln }); continue; }
    if ((m = body.match(/^(밑줄|동그라미)\s*:\s*(.+)$/))) { emit({ t: 'mark', kind: m[1] === '밑줄' ? 'underline' : 'circle', target: m[2].trim(), color, line: ln }); continue; }
    if ((m = body.match(/^!\s*(.+)$/))) { emit({ t: 'text', text: m[1], em: true, level: Math.min(2, ind >> 1), bullet: false, color, line: ln }); continue; }
    if ((m = body.match(/^=\s*(.+)$/))) { emit({ t: 'formula', text: m[1].trim(), color, line: ln }); continue; }
    if ((m = body.match(/^[-*]\s+(.+)$/))) { emit({ t: 'text', text: m[1].trim(), level: Math.min(2, ind >> 1), bullet: true, color, line: ln }); continue; }
    emit({ t: 'text', text: body, level: Math.min(2, ind >> 1), bullet: false, color, line: ln });
  }
  // 아직 닫히지 않은 그림 구역(이어 붙이는 중)은 [/그림] 이 올 때까지 내보내지 않는다 —
  // 그림 라벨은 같은 구역의 뒤 도형까지 보고 자리를 고르므로, 덜 온 구역을 먼저 그리면 나중에 자리가 바뀔 수 있다.
  if (inFig && !ended && !opts.final && figStart >= 0) items.length = figStart;
  return { items, errors, ended, final: !!opts.final };
}
