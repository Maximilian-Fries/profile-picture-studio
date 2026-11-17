import { clamp } from './imageops';
import type { Tone, ToneStats } from './types';

export interface ToneLut {
  r: Uint8Array;
  g: Uint8Array;
  b: Uint8Array;
  sat: number;
  identity: boolean;
}

/**
 * Builds per-channel lookup tables. Every adjustment is a smooth curve that keeps pure
 * black and pure white where they are, so nothing clips and skin never looks "filtered".
 */
export function buildTone(t: Tone, stats: ToneStats | null): ToneLut {
  const r = new Uint8Array(256);
  const g = new Uint8Array(256);
  const b = new Uint8Array(256);

  let bp = 0;
  let wp = 1;
  let autoGamma = 1;
  if (t.auto && stats) {
    // Gentle levels: recover a little of any unused range, never a full stretch.
    bp = Math.min(0.06, stats.lo * 0.6);
    wp = Math.max(0.88, 1 - (1 - stats.hi) * 0.6);
    // Exposure is only nudged when both the face and the whole scene say the photo is
    // under- or over-exposed, so naturally darker or lighter skin is left exactly as it is.
    if (stats.faceMedian != null) {
      const m = clamp((stats.faceMedian - bp) / (wp - bp), 0.02, 0.98);
      let target = m;
      if (m < 0.36 && stats.median < 0.38) target = 0.36;
      else if (m > 0.72 && stats.median > 0.62) target = 0.72;
      if (target !== m) {
        const full = Math.log(target) / Math.log(m);
        autoGamma = clamp(1 + (full - 1) * 0.7, 0.8, 1.2);
      }
    }
  }

  const gamma = autoGamma * Math.pow(2, -t.brightness * 0.55);
  const c = t.contrast;
  const w = t.warmth;
  let identity = true;
  for (let v = 0; v < 256; v++) {
    let x = clamp((v / 255 - bp) / (wp - bp), 0, 1);
    x = Math.pow(x, gamma);
    if (c > 0) {
      const s = x < 0.5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x);
      x += (s - x) * c * 0.6;
    } else if (c < 0) {
      x = 0.5 + (x - 0.5) * (1 + c * 0.45);
    }
    r[v] = Math.round(Math.pow(x, 1 - 0.09 * w) * 255);
    g[v] = Math.round(Math.pow(x, 1 - 0.012 * w) * 255);
    b[v] = Math.round(Math.pow(x, 1 + 0.09 * w) * 255);
    if (r[v] !== v || g[v] !== v || b[v] !== v) identity = false;
  }
  const sat = t.mono ? 0 : t.saturation >= 0 ? 1 + t.saturation * 0.5 : 1 + t.saturation * 0.7;
  if (sat !== 1) identity = false;
  return { r, g, b, sat, identity };
}
