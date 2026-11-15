// 브라우저 안 영상 저장 — 재생 화면과 같은 그리기 코드로 '시각 t 의 프레임'을 차례로 그려 MP4 를 만든다.
//   1순위: WebCodecs(VideoEncoder, H.264) + mp4-muxer(web\vendor) — 실시간보다 빠름
//   2순위: MediaRecorder(캔버스를 실시간으로 녹화 — 강의 길이만큼 걸림, mp4 가 안 되면 webm)
//   둘 다 없으면 안내.
import { Board } from './core/lecture.js';

const W = 1280, H = 720;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pickCodec(fps) {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return null;
  // High 4.0 → Main → Baseline 순(휴대폰 하드웨어 인코더는 Baseline/Main 만 되는 일이 있음)
  for (const codec of ['avc1.640028', 'avc1.4d0028', 'avc1.42e028', 'avc1.42001f']) {
    for (const hw of ['no-preference', 'prefer-software']) {
      const cfg = { codec, width: W, height: H, bitrate: 1_500_000, bitrateMode: 'variable', framerate: fps, avc: { format: 'avc' }, hardwareAcceleration: hw };
      try { const r = await VideoEncoder.isConfigSupported(cfg); if (r.supported) return r.config || cfg; } catch { /* 다음 */ }
    }
  }
  return null;
}

/** 강의 타임라인 → { blob, ext, method, codec, ms } */
export async function exportVideo({ tl, env, fps = 24, hold = 1.0, onProgress = () => {}, noWebCodecs = false }) {
  const t0 = performance.now();
  const lim = tl.end + hold;
  const N = Math.ceil(lim * fps - 1e-9); // 영상 렌더러(lib\video.mjs)와 같은 프레임 수: t = i/fps < lim
  const cfg = noWebCodecs ? null : await pickCodec(fps);
  if (cfg) {
    const { Muxer, ArrayBufferTarget } = await import('./vendor/mp4-muxer.mjs');
    const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: 'avc', width: W, height: H, frameRate: fps }, fastStart: 'in-memory' });
    let err = null;
    const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { err = e; } });
    enc.configure(cfg);
    const cv = env.createCanvas(W, H), ctx = cv.getContext('2d');
    const board = new Board(env, tl);
    let lastKey = null;
    for (let i = 0; i < N; i++) {
      if (err) throw err;
      const t = i / fps;
      board.advance(t);
      const k = board.key(t);
      if (!(k !== null && k === lastKey)) board.paint(ctx, t);
      lastKey = k;
      const vf = new VideoFrame(cv, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
      enc.encode(vf, { keyFrame: i % (fps * 4) === 0 });
      vf.close();
      while (enc.encodeQueueSize > 6) await sleep(2);
      if (i % 12 === 0) { onProgress(i / N, '저장'); await sleep(0); }
    }
    await enc.flush();
    if (err) throw err;
    enc.close();
    muxer.finalize();
    onProgress(1, '저장');
    return { blob: new Blob([muxer.target.buffer], { type: 'video/mp4' }), ext: 'mp4', method: 'WebCodecs', codec: cfg.codec, ms: Math.round(performance.now() - t0), frames: N };
  }
  // 2순위: 실시간 녹화
  if (typeof MediaRecorder !== 'undefined' && HTMLCanvasElement.prototype.captureStream) {
    const types = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    const mime = types.find((m) => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } });
    if (mime) {
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const ctx = cv.getContext('2d');
      const board = new Board(env, tl);
      board.render(ctx, 0);
      const stream = cv.captureStream(fps);
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2_500_000 });
      const parts = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
      const done = new Promise((r) => { rec.onstop = r; });
      rec.start(1000);
      const start = performance.now();
      await new Promise((resolve) => {
        const step = () => {
          const t = Math.min(lim, (performance.now() - start) / 1000);
          board.render(ctx, t);
          onProgress(t / lim, '녹화');
          if (t >= lim) resolve(); else setTimeout(step, 1000 / fps / 2);
        };
        step();
      });
      rec.stop(); await done;
      stream.getTracks().forEach((x) => x.stop());
      const type = mime.split(';')[0];
      return { blob: new Blob(parts, { type }), ext: type === 'video/mp4' ? 'mp4' : 'webm', method: 'MediaRecorder', codec: mime, ms: Math.round(performance.now() - t0) };
    }
  }
  const e = new Error('이 브라우저는 영상 저장을 지원하지 않습니다');
  e.userMsg = '이 브라우저는 영상 저장이 안 됩니다(크롬·엣지·사파리 최신판에서 해 보세요)';
  throw e;
}

/** 파일 이름 = 강의 제목(파일 이름에 못 쓰는 글자는 바꿈) */
export function fileName(title, ext) {
  const t = String(title || '강의').replace(/\//g, '／').replace(/[\\:*?"<>|\x00-\x1f]/g, '').replace(/[\^_{}]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) || '강의';
  return `${t}.${ext}`;
}

/** 저장: 휴대폰(손가락 화면)에서 파일 공유가 되면 공유 시트, 아니면 내려받기.
 *  공유 시트는 사용자가 막 누른 직후에만 열리므로 tapped=false 면 'needTap' 을 돌려준다(단추를 한 번 더 누르게). */
export async function saveFile(blob, name, tapped = false) {
  const file = typeof File !== 'undefined' ? new File([blob], name, { type: blob.type }) : null;
  const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  if (coarse && file && navigator.canShare && navigator.canShare({ files: [file] })) {
    if (!tapped) return 'needTap';
    try { await navigator.share({ files: [file], title: name }); return 'shared'; }
    catch (e) { if (e && e.name === 'AbortError') return 'needTap'; /* 공유 실패 → 내려받기 */ }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.style.display = 'none';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120000);
  return 'downloaded';
}
