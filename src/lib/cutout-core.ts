// Everything that turns a raw segmentation mask into compositing-ready layers.
// Pure typed-array code so it can run inside the worker.

import { boxBlur, clamp, resampleBilinear, smoothstep } from './imageops';

export interface Img {
  w: number;
  h: number;
  data: Uint8ClampedArray;
}

function luma01(rgba: Uint8ClampedArray, n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    out[i] = (0.2126 * rgba[j] + 0.7152 * rgba[j + 1] + 0.0722 * rgba[j + 2]) / 255;
  }
  return out;
}

/**
 * The model predicts the mask at ~1024px. A fast guided filter re-aligns it to the
 * real edges of the full-resolution photo, so hair and shoulders stay crisp instead
 * of getting the soft, slightly offset outline that makes cut-outs look pasted on.
 */
export function refineAlpha(aSmall: Uint8Array, small: Img, full: Img): Float32Array {
  const { w, h } = small;
  const n = w * h;
  const I = luma01(small.data, n);
  const p = new Float32Array(n);
  for (let i = 0; i < n; i++) p[i] = aSmall[i] / 255;

  // The model is often unsure about large flat areas whose colour is close to the
  // background (a grey jumper against a grey wall) and leaves them semi-transparent.
  // Anything that is mostly subject and has no background nearby is interior: make it solid.
  const bgNear = new Float32Array(n);
  for (let i = 0; i < n; i++) bgNear[i] = p[i] < 0.25 ? 1 : 0;
  const near = boxBlur(bgNear, w, h, Math.max(3, Math.round(Math.max(w, h) * 0.02)), 2);
  for (let i = 0; i < n; i++) {
    if (p[i] > 0.45) {
      const interior = 1 - smoothstep(0.002, 0.06, near[i]);
      p[i] += (1 - p[i]) * interior;
    }
  }

  const r = Math.max(2, Math.round(Math.max(w, h) / 256));
  const mean = (a: Float32Array) => boxBlur(a, w, h, r, 1);
  const eps = 1e-3;

  const II = new Float32Array(n);
  const Ip = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    II[i] = I[i] * I[i];
    Ip[i] = I[i] * p[i];
  }
  const mI = mean(I);
  const mp = mean(p);
  const mII = mean(II);
  const mIp = mean(Ip);
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const varI = mII[i] - mI[i] * mI[i];
    const cov = mIp[i] - mI[i] * mp[i];
    a[i] = cov / (varI + eps);
    b[i] = mp[i] - a[i] * mI[i];
  }
  const ma = mean(a);
  const mb = mean(b);

  const W = full.w;
  const H = full.h;
  const N = W * H;
  const A = resampleBilinear(ma, w, h, W, H);
  const B = resampleBilinear(mb, w, h, W, H);
  const P = resampleBilinear(p, w, h, W, H);
  const d = full.data;
  for (let i = 0, j = 0; i < N; i++, j += 4) {
    const L = (0.2126 * d[j] + 0.7152 * d[j + 1] + 0.0722 * d[j + 2]) / 255;
    let q = A[i] * L + B[i];
    // Never let the filter invent subject far away from where the model saw it, or erase solid areas.
    const base = P[i];
    if (base < 0.004) q = Math.min(q, 0.0);
    else if (base > 0.996) q = Math.max(q, 1.0);
    // Drop the faintest haze (the model's vague guess at flyaway hair turns into grey smears
    // on a new background) and tighten wide, uncertain transitions. Real strands survive.
    q = (q - 0.12) / 0.78;
    q = q < 0 ? 0 : q > 1 ? 1 : q;
    A[i] = q + (q * q * (3 - 2 * q) - q) * 0.7;
  }
  return A;
}

export interface Analysis {
  free: { l: boolean; r: boolean; t: boolean; b: boolean };
  coverage: number;
  /** First row of the photo that contains the subject (top of the hair). */
  top: number;
  head: { cx: number; cy: number; w: number; h: number; eyeY: number } | null;
}

/** Where the subject sits: which photo edges it touches and a rough head position. */
export function analyse(alpha: Float32Array, W: number, H: number): Analysis {
  const band = Math.max(2, Math.round(Math.max(W, H) * 0.004));
  const colTouch = (x0: number) => {
    let hit = 0;
    for (let y = 0; y < H; y++) {
      const o = y * W;
      for (let x = x0; x < x0 + band; x++) {
        if (alpha[o + x] > 0.5) {
          hit++;
          break;
        }
      }
    }
    return hit / H;
  };
  const rowTouch = (y0: number) => {
    let hit = 0;
    for (let x = 0; x < W; x++) {
      for (let y = y0; y < y0 + band; y++) {
        if (alpha[y * W + x] > 0.5) {
          hit++;
          break;
        }
      }
    }
    return hit / W;
  };
  const limit = 0.012;
  const free = {
    l: colTouch(0) < limit,
    r: colTouch(W - band) < limit,
    t: rowTouch(0) < limit,
    b: rowTouch(H - band) < limit,
  };

  // Row extents of the silhouette (subsampled).
  const step = 2;
  let sum = 0;
  let count = 0;
  let top = -1;
  let bottom = -1;
  const rows: { y: number; x0: number; x1: number }[] = [];
  for (let y = 0; y < H; y += step) {
    let x0 = -1;
    let x1 = -1;
    const o = y * W;
    for (let x = 0; x < W; x += step) {
      const a = alpha[o + x];
      sum += a;
      count++;
      if (a > 0.5) {
        if (x0 < 0) x0 = x;
        x1 = x;
      }
    }
    if (x0 >= 0 && x1 - x0 > W * 0.02) {
      if (top < 0) top = y;
      bottom = y;
      rows.push({ y, x0, x1 });
    }
  }
  const coverage = count ? sum / count : 0;

  let head: Analysis['head'] = null;
  if (top >= 0 && bottom > top) {
    const span = bottom - top;
    const limitY = top + span * 0.22;
    let widest = 0;
    let cxSum = 0;
    let wSum = 0;
    for (const row of rows) {
      if (row.y > limitY) break;
      const wRow = row.x1 - row.x0;
      widest = Math.max(widest, wRow);
      cxSum += ((row.x0 + row.x1) / 2) * wRow;
      wSum += wRow;
    }
    if (widest > 0 && wSum > 0) {
      const headW = Math.min(widest, span * 0.6);
      head = {
        cx: cxSum / wSum,
        cy: top + headW * 0.74,
        w: headW * 0.74,
        h: headW * 0.92,
        eyeY: top + headW * 0.62,
      };
    }
  }
  return { free, coverage, top: Math.max(0, top), head };
}

const SOLID = 0.97;

function sampleBilinear(a: Float32Array, w: number, h: number, x: number, y: number): number {
  const sx = clamp(x, 0, w - 1);
  const sy = clamp(y, 0, h - 1);
  const x0 = Math.floor(sx);
  const y0 = Math.floor(sy);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = sx - x0;
  const fy = sy - y0;
  const top = a[y0 * w + x0] + (a[y0 * w + x1] - a[y0 * w + x0]) * fx;
  const bot = a[y1 * w + x0] + (a[y1 * w + x1] - a[y1 * w + x0]) * fx;
  return top + (bot - top) * fy;
}

/**
 * Builds the subject layer. Pixels on the silhouette are a mix of the person and the old
 * background (the classic bright or dark fringe of a cut-out). We know roughly what the old
 * background looked like there, so we subtract its share and keep the real hair/skin/fabric
 * detail. Where almost nothing of the person is left (fine wisps), the colour of nearby
 * solid subject pixels is used instead, because un-mixing would only amplify noise.
 */
export function buildForeground(full: Img, alpha: Float32Array, bg: BackgroundLayers): Uint8ClampedArray {
  const { w: W, h: H, data } = full;
  const k = Math.max(1, Math.round(Math.max(W, H) / 640));
  const w = Math.ceil(W / k);
  const h = Math.ceil(H / k);
  const n = w * h;
  const sr = new Float32Array(n);
  const sg = new Float32Array(n);
  const sb = new Float32Array(n);
  const sc = new Float32Array(n);
  for (let Y = 0; Y < H; Y++) {
    const by = Math.floor(Y / k) * w;
    const o = Y * W;
    for (let X = 0; X < W; X++) {
      if (alpha[o + X] >= SOLID) {
        const j = by + Math.floor(X / k);
        const p = (o + X) * 4;
        sr[j] += data[p];
        sg[j] += data[p + 1];
        sb[j] += data[p + 2];
        sc[j] += 1;
      }
    }
  }
  const fine = [sr, sg, sb, sc].map((a) => boxBlur(a, w, h, 2, 2));
  const coarse = [sr, sg, sb, sc].map((a) => boxBlur(a, w, h, 10, 2));
  const nr = new Float32Array(n);
  const ng = new Float32Array(n);
  const nb = new Float32Array(n);
  const nd = new Float32Array(n);
  const minFine = 0.04 * k * k;
  for (let j = 0; j < n; j++) {
    const src = fine[3][j] > minFine ? fine : coarse;
    nr[j] = src[0][j];
    ng[j] = src[1][j];
    nb[j] = src[2][j];
    nd[j] = src[3][j];
  }

  const bx = bg.w / W;
  const by2 = bg.h / H;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let Y = 0; Y < H; Y++) {
    const o = Y * W;
    const ly = (Y + 0.5) / k - 0.5;
    const gy = (Y + 0.5) * by2 - 0.5;
    for (let X = 0; X < W; X++) {
      const a = alpha[o + X];
      if (a <= 0.004) continue;
      const p = (o + X) * 4;
      let r = data[p];
      let g = data[p + 1];
      let b = data[p + 2];
      if (a < SOLID) {
        const gx = (X + 0.5) * bx - 0.5;
        // Remove the old background's contribution: C = a*F + (1-a)*B  =>  F = (C - (1-a)*B) / a
        const inv = 1 / Math.max(a, 0.2);
        const ur = clamp((r - (1 - a) * Math.sqrt(sampleBilinear(bg.r, bg.w, bg.h, gx, gy)) * 255) * inv, 0, 255);
        const ug = clamp((g - (1 - a) * Math.sqrt(sampleBilinear(bg.g, bg.w, bg.h, gx, gy)) * 255) * inv, 0, 255);
        const ub = clamp((b - (1 - a) * Math.sqrt(sampleBilinear(bg.b, bg.w, bg.h, gx, gy)) * 255) * inv, 0, 255);
        const lx = (X + 0.5) / k - 0.5;
        const den = sampleBilinear(nd, w, h, lx, ly);
        if (den > 1e-3) {
          const fr = sampleBilinear(nr, w, h, lx, ly) / den;
          const fg = sampleBilinear(ng, w, h, lx, ly) / den;
          const fb = sampleBilinear(nb, w, h, lx, ly) / den;
          const t = smoothstep(0.25, 0.7, a);
          r = fr + (ur - fr) * t;
          g = fg + (ug - fg) * t;
          b = fb + (ub - fb) * t;
        } else {
          r = ur;
          g = ug;
          b = ub;
        }
      }
      out[p] = r;
      out[p + 1] = g;
      out[p + 2] = b;
      out[p + 3] = Math.round(a * 255);
    }
  }
  return out;
}

export interface BackgroundLayers {
  w: number;
  h: number;
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  shadow: Uint8Array;
  wrap: Uint8Array;
}

/**
 * Builds a low-resolution copy of the original background with the person painted out
 * (so blurring it never smears their colours into a halo), plus the soft shadow and
 * edge maps used when compositing.
 */
export function buildBackground(full: Img, alpha: Float32Array): BackgroundLayers {
  const { w: W, h: H, data } = full;
  const k = Math.max(1, Math.round(Math.max(W, H) / 512));
  const w = Math.ceil(W / k);
  const h = Math.ceil(H / k);
  const n = w * h;
  const br = new Float32Array(n);
  const bg = new Float32Array(n);
  const bb = new Float32Array(n);
  const bc = new Float32Array(n);
  const ar = new Float32Array(n);
  const ag = new Float32Array(n);
  const ab = new Float32Array(n);
  const asum = new Float32Array(n);
  const tot = new Float32Array(n);
  const inv = 1 / 65025;
  for (let Y = 0; Y < H; Y++) {
    const by = Math.floor(Y / k) * w;
    const o = Y * W;
    for (let X = 0; X < W; X++) {
      const j = by + Math.floor(X / k);
      const p = (o + X) * 4;
      const a = alpha[o + X];
      const r = data[p] * data[p] * inv;
      const g = data[p + 1] * data[p + 1] * inv;
      const b = data[p + 2] * data[p + 2] * inv;
      ar[j] += r;
      ag[j] += g;
      ab[j] += b;
      asum[j] += a;
      tot[j] += 1;
      if (a < 0.02) {
        br[j] += r;
        bg[j] += g;
        bb[j] += b;
        bc[j] += 1;
      }
    }
  }
  const alo = new Float32Array(n);
  for (let j = 0; j < n; j++) alo[j] = tot[j] > 0 ? asum[j] / tot[j] : 0;
  const near = boxBlur(alo, w, h, 2, 2);

  const R = new Float32Array(n);
  const G = new Float32Array(n);
  const B = new Float32Array(n);
  const valid = new Float32Array(n);
  let validCount = 0;
  let mr = 0;
  let mg = 0;
  let mbl = 0;
  for (let j = 0; j < n; j++) {
    if (bc[j] > 0 && near[j] < 0.02) {
      valid[j] = 1;
      R[j] = br[j] / bc[j];
      G[j] = bg[j] / bc[j];
      B[j] = bb[j] / bc[j];
      mr += R[j];
      mg += G[j];
      mbl += B[j];
      validCount++;
    }
  }

  if (validCount < n * 0.003) {
    // The person fills the whole frame: there is no background to recover, keep the photo as is.
    for (let j = 0; j < n; j++) {
      const t = Math.max(1, tot[j]);
      R[j] = ar[j] / t;
      G[j] = ag[j] / t;
      B[j] = ab[j] / t;
    }
  } else {
    mr /= validCount;
    mg /= validCount;
    mbl /= validCount;
    const filled = new Uint8Array(n);
    const srcR = R.slice();
    const srcG = G.slice();
    const srcB = B.slice();
    const maxR = Math.max(w, h);
    for (const rad of [1, 3, 9, 27, 81, 243]) {
      if (rad > maxR) break;
      const den = boxBlur(valid, w, h, rad, 2);
      const nR = boxBlur(srcR, w, h, rad, 2);
      const nG = boxBlur(srcG, w, h, rad, 2);
      const nB = boxBlur(srcB, w, h, rad, 2);
      let remaining = 0;
      for (let j = 0; j < n; j++) {
        if (valid[j] || filled[j]) continue;
        if (den[j] > 0.04) {
          R[j] = nR[j] / den[j];
          G[j] = nG[j] / den[j];
          B[j] = nB[j] / den[j];
          filled[j] = 1;
        } else remaining++;
      }
      if (!remaining) break;
    }
    const hole = new Float32Array(n);
    for (let j = 0; j < n; j++) {
      if (!valid[j]) {
        hole[j] = 1;
        if (!filled[j]) {
          R[j] = mr;
          G[j] = mg;
          B[j] = mbl;
        }
      }
    }
    // Soften the painted-out region so the different fill scales don't leave seams.
    const hb = boxBlur(hole, w, h, 2, 2);
    const sR = boxBlur(R, w, h, 4, 2);
    const sG = boxBlur(G, w, h, 4, 2);
    const sB = boxBlur(B, w, h, 4, 2);
    for (let j = 0; j < n; j++) {
      const t = hb[j];
      if (t <= 0) continue;
      R[j] += (sR[j] - R[j]) * t;
      G[j] += (sG[j] - G[j]) * t;
      B[j] += (sB[j] - B[j]) * t;
    }
  }

  const long = Math.max(w, h);
  const sh = boxBlur(alo, w, h, Math.max(2, Math.round(long * 0.035)), 3);
  const inner = boxBlur(alo, w, h, Math.max(2, Math.round(long * 0.014)), 2);
  const shadow = new Uint8Array(n);
  const wrap = new Uint8Array(n);
  for (let j = 0; j < n; j++) {
    shadow[j] = Math.round(clamp(sh[j], 0, 1) * 255);
    wrap[j] = Math.round(clamp(alo[j] * (1 - inner[j]) * 2, 0, 1) * 255);
  }
  return { w, h, r: R, g: G, b: B, shadow, wrap };
}

/**
 * Estimates the photo's own sensor noise (in 0-255 units) so new backdrops can be given
 * matching grain. Uses the median Laplacian response, which ignores edges and texture.
 */
export function estimateNoise(full: Img): number {
  const { w: W, h: H, data } = full;
  const bins = new Uint32Array(512);
  let total = 0;
  const g = (x: number, y: number) => data[(y * W + x) * 4 + 1];
  for (let y = 1; y < H - 1; y += 3) {
    for (let x = 1; x < W - 1; x += 3) {
      const v =
        g(x - 1, y - 1) - 2 * g(x, y - 1) + g(x + 1, y - 1) -
        2 * g(x - 1, y) + 4 * g(x, y) - 2 * g(x + 1, y) +
        g(x - 1, y + 1) - 2 * g(x, y + 1) + g(x + 1, y + 1);
      const bin = Math.min(511, Math.floor(Math.abs(v) * 4));
      bins[bin]++;
      total++;
    }
  }
  if (!total) return 1;
  let acc = 0;
  let median = 0;
  for (let i = 0; i < 512; i++) {
    acc += bins[i];
    if (acc >= total / 2) {
      median = (i + 0.5) / 4;
      break;
    }
  }
  return median / (0.6745 * 6);
}
