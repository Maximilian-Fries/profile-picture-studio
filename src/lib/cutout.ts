import { alphaCanvas, createCanvas, ctx2d, makeMips, resizeCanvas } from './canvas';
import type { Cutout, Face, Mips } from './types';

export interface CutProgress {
  label: string;
  ratio: number | null;
}

interface Pending {
  previous?: Cutout;
  resolve: (cut: Cutout) => void;
  reject: (error: Error) => void;
  onProgress: (p: CutProgress) => void;
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();

function failAll(message: string) {
  for (const job of pending.values()) job.reject(new Error(message));
  pending.clear();
  worker?.terminate();
  worker = null;
}

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./cutout.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event) => {
    const msg = event.data;
    const job = pending.get(msg.id);
    if (!job) return;
    if (msg.type === 'progress') {
      job.onProgress({ label: msg.label, ratio: msg.ratio });
    } else if (msg.type === 'error') {
      pending.delete(msg.id);
      job.reject(new Error(msg.message));
    } else if (msg.type === 'done') {
      pending.delete(msg.id);
      try {
        job.resolve(assemble(msg, job.previous));
      } catch (error) {
        job.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  };
  worker.onerror = (event) => failAll(event.message || 'The cut-out engine stopped unexpectedly.');
  return worker;
}

function copyCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const copy = createCanvas(source.width, source.height);
  ctx2d(copy).drawImage(source, 0, 0);
  return copy;
}

function assemble(msg: any, previous?: Cutout): Cutout {
  const { W, H } = msg;
  const fgCanvas = createCanvas(W, H);
  ctx2d(fgCanvas).putImageData(new ImageData(new Uint8ClampedArray(msg.fg), W, H), 0, 0);
  // After a hand correction the user's mask stays the source of truth; otherwise derive it.
  const mask = previous?.mask ?? copyCanvas(fgCanvas);
  const autoMask = previous?.autoMask ?? copyCanvas(fgCanvas);
  const { bg } = msg;
  let headGuess: Face | null = null;
  if (msg.head) {
    headGuess = {
      cx: msg.head.cx,
      cy: msg.head.cy,
      w: msg.head.w,
      h: msg.head.h,
      eyeX: msg.head.cx,
      eyeY: msg.head.eyeY,
      roll: 0,
      detected: false,
    };
  }
  return {
    fg: makeMips(fgCanvas),
    mask,
    autoMask,
    bg: { w: bg.w, h: bg.h, r: bg.r, g: bg.g, b: bg.b },
    shadow: alphaCanvas(bg.shadow, bg.w, bg.h, 0),
    wrap: alphaCanvas(bg.wrap, bg.w, bg.h, 255),
    free: msg.free,
    noise: msg.noise,
    subjectTop: msg.top ?? 0,
    headGuess,
  };
}

/** Separates the person from the background. Resolves with every layer the renderer needs. */
export function runCutout(src: Mips, key: number, onProgress: (p: CutProgress) => void): Promise<Cutout> {
  const base = src[0];
  const W = base.width;
  const H = base.height;
  const full = ctx2d(base, true).getImageData(0, 0, W, H);
  const scale = Math.min(1, 1024 / Math.max(W, H));
  const smallCanvas = scale < 1 ? resizeCanvas(base, W, H, W * scale, H * scale) : base;
  const small = ctx2d(smallCanvas, true).getImageData(0, 0, smallCanvas.width, smallCanvas.height);
  const id = ++seq;
  return new Promise<Cutout>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    try {
      getWorker().postMessage(
        {
          type: 'cut',
          id,
          key,
          full: { w: W, h: H, data: full.data.buffer },
          small: { w: small.width, h: small.height, data: small.data.buffer },
        },
        [full.data.buffer, small.data.buffer],
      );
    } catch (error) {
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** Re-builds the compositing layers after the mask was corrected with the touch-up brush. */
export function recut(key: number, cut: Cutout): Promise<Cutout> {
  const { mask } = cut;
  const data = ctx2d(mask, true).getImageData(0, 0, mask.width, mask.height).data;
  const alpha = new Uint8Array(mask.width * mask.height);
  for (let i = 0, j = 3; i < alpha.length; i++, j += 4) alpha[i] = data[j];
  const id = ++seq;
  return new Promise<Cutout>((resolve, reject) => {
    pending.set(id, { previous: cut, resolve, reject, onProgress: () => {} });
    try {
      getWorker().postMessage({ type: 'recut', id, key, alpha: alpha.buffer }, [alpha.buffer]);
    } catch (error) {
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** Paints a soft round brush stroke segment onto the mask. */
export function paintMask(mask: HTMLCanvasElement, from: { x: number; y: number }, to: { x: number; y: number }, radius: number, erase: boolean) {
  const ctx = mask.getContext('2d');
  if (!ctx) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(1, Math.ceil(dist / Math.max(1, radius * 0.3)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    const g = ctx.createRadialGradient(x, y, radius * 0.6, x, y, radius);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export function snapshotMask(mask: HTMLCanvasElement): HTMLCanvasElement {
  return copyCanvas(mask);
}

export function restoreMask(mask: HTMLCanvasElement, from: HTMLCanvasElement) {
  const ctx = mask.getContext('2d');
  if (!ctx) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'copy';
  ctx.drawImage(from, 0, 0);
  ctx.restore();
}
