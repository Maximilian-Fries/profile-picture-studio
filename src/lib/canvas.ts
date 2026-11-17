import type { LowImage, Mips } from './types';

export function createCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function ctx2d(c: HTMLCanvasElement, readback = false): CanvasRenderingContext2D {
  const ctx = c.getContext('2d', readback ? { willReadFrequently: true } : undefined);
  if (!ctx) throw new Error('Your browser could not create a drawing surface.');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return ctx;
}

/** Draws `source` into a new canvas of the given size, halving step by step for clean downscales. */
export function resizeCanvas(source: CanvasImageSource, sw: number, sh: number, w: number, h: number): HTMLCanvasElement {
  let current: CanvasImageSource = source;
  let cw = sw;
  let ch = sh;
  while (cw / 2 >= w && ch / 2 >= h && cw > 2 && ch > 2) {
    const next = createCanvas(cw / 2, ch / 2);
    ctx2d(next).drawImage(current, 0, 0, next.width, next.height);
    current = next;
    cw = next.width;
    ch = next.height;
  }
  const out = createCanvas(w, h);
  ctx2d(out).drawImage(current, 0, 0, out.width, out.height);
  return out;
}

export function makeMips(base: HTMLCanvasElement): Mips {
  const mips: Mips = [base];
  let current = base;
  while (Math.max(current.width, current.height) > 320) {
    const next = createCanvas(current.width / 2, current.height / 2);
    ctx2d(next).drawImage(current, 0, 0, next.width, next.height);
    mips.push(next);
    current = next;
  }
  return mips;
}

/** Picks the smallest pre-shrunk copy that is still at least as detailed as the output needs. */
export function pickMip(mips: Mips, scale: number): HTMLCanvasElement {
  if (scale >= 1) return mips[0];
  const level = Math.min(mips.length - 1, Math.max(0, Math.floor(Math.log2(1 / scale))));
  return mips[level];
}

export function alphaCanvas(alpha: Uint8Array, w: number, h: number, rgb: number): HTMLCanvasElement {
  const c = createCanvas(w, h);
  const img = new ImageData(w, h);
  for (let i = 0, j = 0; i < alpha.length; i++, j += 4) {
    img.data[j] = rgb;
    img.data[j + 1] = rgb;
    img.data[j + 2] = rgb;
    img.data[j + 3] = alpha[i];
  }
  ctx2d(c).putImageData(img, 0, 0);
  return c;
}

/** Converts a canvas into the squared-light float planes used for blurring. */
export function toLowImage(source: HTMLCanvasElement, maxLong: number): LowImage {
  const scale = Math.min(1, maxLong / Math.max(source.width, source.height));
  const small = resizeCanvas(source, source.width, source.height, source.width * scale, source.height * scale);
  const { width: w, height: h } = small;
  const data = ctx2d(small, true).getImageData(0, 0, w, h).data;
  const r = new Float32Array(w * h);
  const g = new Float32Array(w * h);
  const b = new Float32Array(w * h);
  const inv = 1 / 65025;
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    r[i] = data[j] * data[j] * inv;
    g[i] = data[j + 1] * data[j + 1] * inv;
    b[i] = data[j + 2] * data[j + 2] * inv;
  }
  return { w, h, r, g, b };
}
