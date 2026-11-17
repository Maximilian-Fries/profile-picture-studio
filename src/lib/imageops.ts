// Small numeric helpers shared by the worker and the main thread. No DOM access here.

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

function boxH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number) {
  const norm = 1 / (2 * r + 1);
  const last = w - 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += src[row + (i < 0 ? 0 : i > last ? last : i)];
    for (let x = 0; x < w; x++) {
      dst[row + x] = acc * norm;
      const add = x + r + 1;
      const sub = x - r;
      acc += src[row + (add > last ? last : add)] - src[row + (sub < 0 ? 0 : sub)];
    }
  }
}

function boxV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number) {
  const norm = 1 / (2 * r + 1);
  const last = h - 1;
  const acc = new Float64Array(w);
  for (let i = -r; i <= r; i++) {
    const row = (i < 0 ? 0 : i > last ? last : i) * w;
    for (let x = 0; x < w; x++) acc[x] += src[row + x];
  }
  for (let y = 0; y < h; y++) {
    const o = y * w;
    const addY = y + r + 1;
    const subY = y - r;
    const add = (addY > last ? last : addY) * w;
    const sub = (subY < 0 ? 0 : subY) * w;
    for (let x = 0; x < w; x++) {
      dst[o + x] = acc[x] * norm;
      acc[x] += src[add + x] - src[sub + x];
    }
  }
}

/**
 * Separable box blur with clamped edges. Three passes approximate a Gaussian
 * whose sigma is roughly equal to `r`. Returns a new array.
 */
export function boxBlur(src: Float32Array, w: number, h: number, r: number, passes = 3): Float32Array {
  const a = src.slice();
  r = Math.round(r);
  if (r < 1) return a;
  const b = new Float32Array(src.length);
  for (let p = 0; p < passes; p++) {
    boxH(a, b, w, h, r);
    boxV(b, a, w, h, r);
  }
  return a;
}

/** Bilinear resample (pixel-centre aligned). Intended for upsampling smooth fields. */
export function resampleBilinear(src: Float32Array, w: number, h: number, W: number, H: number): Float32Array {
  const out = new Float32Array(W * H);
  const x0s = new Int32Array(W);
  const x1s = new Int32Array(W);
  const fxs = new Float32Array(W);
  for (let X = 0; X < W; X++) {
    const sx = clamp(((X + 0.5) * w) / W - 0.5, 0, w - 1);
    const x0 = Math.floor(sx);
    x0s[X] = x0;
    x1s[X] = Math.min(w - 1, x0 + 1);
    fxs[X] = sx - x0;
  }
  for (let Y = 0; Y < H; Y++) {
    const sy = clamp(((Y + 0.5) * h) / H - 0.5, 0, h - 1);
    const y0 = Math.floor(sy);
    const y1 = Math.min(h - 1, y0 + 1);
    const fy = sy - y0;
    const r0 = y0 * w;
    const r1 = y1 * w;
    const o = Y * W;
    for (let X = 0; X < W; X++) {
      const x0 = x0s[X];
      const x1 = x1s[X];
      const fx = fxs[X];
      const top = src[r0 + x0] + (src[r0 + x1] - src[r0 + x0]) * fx;
      const bot = src[r1 + x0] + (src[r1 + x1] - src[r1 + x0]) * fx;
      out[o + X] = top + (bot - top) * fy;
    }
  }
  return out;
}

export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.trim().replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  if (Number.isNaN(n) || h.length !== 6) return [128, 128, 128];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
