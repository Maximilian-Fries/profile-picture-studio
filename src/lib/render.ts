import { ctx2d, createCanvas, pickMip } from './canvas';
import { boxBlur, clamp, hexToRgb } from './imageops';
import { buildTone, type ToneLut } from './tone';
import type { CustomBg, LowImage, Photo, Settings } from './types';

export interface RenderExtras {
  custom?: CustomBg | null;
  /** Cut the result to a circle (transparent corners). */
  circle?: boolean;
  /** Show the untouched photo with the same crop (for before/after). */
  plain?: boolean;
  /** Show the photo with everything the cut-out removes tinted red (for the touch-up brush). */
  maskView?: boolean;
}

interface Scratch {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

const scratch = new Map<string, Scratch>();

function getScratch(role: string, size: number): Scratch {
  const key = `${role}:${size}`;
  let s = scratch.get(key);
  if (!s) {
    const canvas = createCanvas(size, size);
    s = { canvas, ctx: ctx2d(canvas, true) };
    scratch.set(key, s);
  }
  const { ctx } = s;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return s;
}

/** Frees the large working canvases created for a one-off export size. */
export function releaseScratch(size: number) {
  for (const key of [...scratch.keys()]) {
    if (key.endsWith(`:${size}`)) scratch.delete(key);
  }
}

// ---------------------------------------------------------------------------------------
// Grain: a fixed tile of camera-like noise (mostly luminance, a little colour, slightly
// correlated between neighbours like real demosaiced sensor noise).
// ---------------------------------------------------------------------------------------
const TILE = 512;
let grainTile: Float32Array | null = null;

function getGrain(): Float32Array {
  if (grainTile) return grainTile;
  let seed = 0x2f6e2b1;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => {
    let u = 0;
    while (u === 0) u = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
  };
  const n = TILE * TILE;
  const base = new Float32Array(n);
  for (let i = 0; i < n; i++) base[i] = gauss();
  const tile = new Float32Array(n * 3);
  const m = TILE - 1;
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const i = y * TILE + x;
      const around =
        base[y * TILE + ((x + 1) & m)] +
        base[y * TILE + ((x - 1) & m)] +
        base[((y + 1) & m) * TILE + x] +
        base[((y - 1) & m) * TILE + x];
      const lum = (0.72 * base[i] + 0.07 * around) / 0.7335;
      tile[i * 3] = lum * 0.9 + gauss() * 0.35;
      tile[i * 3 + 1] = lum * 0.9 + gauss() * 0.3;
      tile[i * 3 + 2] = lum * 0.9 + gauss() * 0.4;
    }
  }
  grainTile = tile;
  return tile;
}

/** Applies tone curves and/or grain to every visible pixel of a layer. */
function processPixels(ctx: CanvasRenderingContext2D, size: number, lut: ToneLut | null, grain: number, monoGrain: boolean) {
  const useLut = !!lut && !lut.identity;
  if (!useLut && grain <= 0) return;
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  const tile = grain > 0 ? getGrain() : null;
  const lr = lut?.r;
  const lg = lut?.g;
  const lb = lut?.b;
  const sat = lut?.sat ?? 1;
  const m = TILE - 1;
  for (let y = 0; y < size; y++) {
    const by = y >> 9;
    for (let x = 0; x < size; x++) {
      const p = (y * size + x) * 4;
      if (d[p + 3] === 0) continue;
      let r = d[p];
      let g = d[p + 1];
      let b = d[p + 2];
      if (useLut) {
        r = lr![r];
        g = lg![g];
        b = lb![b];
        if (sat !== 1) {
          const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          r = l + (r - l) * sat;
          g = l + (g - l) * sat;
          b = l + (b - l) * sat;
        }
      }
      if (tile) {
        // Shift the tile differently in each 512px block so the pattern never visibly repeats.
        const bx = x >> 9;
        const ox = (bx * 193 + by * 71) & m;
        const oy = (bx * 37 + by * 151) & m;
        const t = (((y + oy) & m) * TILE + ((x + ox) & m)) * 3;
        if (monoGrain) {
          const v = tile[t + 1] * grain;
          r += v;
          g += v;
          b += v;
        } else {
          r += tile[t] * grain;
          g += tile[t + 1] * grain;
          b += tile[t + 2] * grain;
        }
      }
      d[p] = r;
      d[p + 1] = g;
      d[p + 2] = b;
    }
  }
  ctx.putImageData(img, 0, 0);
}

// ---------------------------------------------------------------------------------------
// Backgrounds
// ---------------------------------------------------------------------------------------
const blurCache = new WeakMap<LowImage, Map<number, HTMLCanvasElement>>();

/** Lens-style blur: done in linear light so bright highlights stay bright instead of going grey. */
function blurredCanvas(low: LowImage, amount: number): HTMLCanvasElement {
  const long = Math.max(low.w, low.h);
  const radius = Math.max(1, Math.round(clamp(amount, 0, 1) * 0.045 * long));
  let cache = blurCache.get(low);
  if (!cache) {
    cache = new Map();
    blurCache.set(low, cache);
  }
  const hit = cache.get(radius);
  if (hit) return hit;
  const { w, h } = low;
  const r = boxBlur(low.r, w, h, radius, 3);
  const g = boxBlur(low.g, w, h, radius, 3);
  const b = boxBlur(low.b, w, h, radius, 3);
  const img = new ImageData(w, h);
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    img.data[j] = Math.sqrt(r[i]) * 255;
    img.data[j + 1] = Math.sqrt(g[i]) * 255;
    img.data[j + 2] = Math.sqrt(b[i]) * 255;
    img.data[j + 3] = 255;
  }
  const canvas = createCanvas(w, h);
  ctx2d(canvas).putImageData(img, 0, 0);
  if (cache.size >= 12) cache.delete(cache.keys().next().value as number);
  cache.set(radius, canvas);
  return canvas;
}

/** A studio backdrop: one colour, lit from the front so it is brighter behind the head and falls off to the corners. */
function drawBackdrop(ctx: CanvasRenderingContext2D, size: number, color: string, light: number, mono: boolean) {
  let [r, g, b] = hexToRgb(color);
  if (mono) r = g = b = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const css = (t: number) => {
    const f = (v: number) => Math.round(clamp(t >= 0 ? v + (255 - v) * t : v * (1 + t), 0, 255));
    return `rgb(${f(r)},${f(g)},${f(b)})`;
  };
  ctx.fillStyle = css(0);
  ctx.fillRect(0, 0, size, size);
  if (light <= 0) return;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const up = light * (0.09 + 0.1 * (1 - lum));
  const down = light * 0.24;
  const grad = ctx.createRadialGradient(size * 0.5, size * 0.4, size * 0.04, size * 0.5, size * 0.5, size * 0.92);
  grad.addColorStop(0, css(up));
  grad.addColorStop(0.3, css(up * 0.62));
  grad.addColorStop(0.55, css(0));
  grad.addColorStop(0.8, css(-down * 0.5));
  grad.addColorStop(1, css(-down));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
}

const MONO_ONLY: ToneLut = (() => {
  const id = new Uint8Array(256);
  for (let i = 0; i < 256; i++) id[i] = i;
  return { r: id, g: id, b: id, sat: 0, identity: false };
})();

/** True when this look needs the person separated from the background. */
export function needsCutout(settings: Settings): boolean {
  const bg = settings.background;
  return !(bg.kind === 'original' && bg.blur <= 0);
}

// ---------------------------------------------------------------------------------------
// The compositor
// ---------------------------------------------------------------------------------------
export function render(target: HTMLCanvasElement, sizeIn: number, photo: Photo, settings: Settings, extras: RenderExtras = {}) {
  const size = Math.max(16, Math.round(sizeIn));
  if (target.width !== size) target.width = size;
  if (target.height !== size) target.height = size;
  const { W, H, cut } = photo;
  const { crop, background: bg, tone, finish } = settings;
  const scale = size / crop.size;
  const rad = (crop.rot * Math.PI) / 180;
  const place = (c: CanvasRenderingContext2D, dx = 0, dy = 0) => {
    c.setTransform(1, 0, 0, 1, size / 2 + dx, size / 2 + dy);
    c.rotate(rad);
    c.scale(scale, scale);
    c.translate(-crop.cx, -crop.cy);
  };
  const reset = (c: CanvasRenderingContext2D) => {
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
  };

  const work = getScratch('work', size);
  const wctx = work.ctx;
  const maskView = !!extras.maskView && !!cut;
  const plain =
    maskView ||
    extras.plain || !cut || (bg.kind === 'original' && bg.blur <= 0) || (bg.kind === 'image' && !extras.custom);
  const lut = extras.plain || maskView ? null : buildTone(tone, photo.stats);

  if (plain) {
    wctx.fillStyle = '#1c1d1f';
    wctx.fillRect(0, 0, size, size);
    place(wctx);
    wctx.drawImage(pickMip(photo.src, scale), 0, 0, W, H);
    reset(wctx);
    processPixels(wctx, size, lut, 0, false);
    if (maskView && cut) {
      const tint = getScratch('tint', size);
      const tctx = tint.ctx;
      tctx.fillStyle = 'rgb(232, 62, 48)';
      tctx.fillRect(0, 0, size, size);
      place(tctx);
      tctx.globalCompositeOperation = 'destination-out';
      tctx.drawImage(cut.mask, 0, 0, W, H);
      reset(tctx);
      wctx.globalAlpha = 0.6;
      wctx.drawImage(tint.canvas, 0, 0);
      reset(wctx);
    }
  } else {
    // New or blurred backgrounds are perfectly clean; real photos are not. Matching the
    // photo's own grain is what stops the person looking pasted on.
    const grain = finish.grain ? clamp(cut.noise * Math.min(1, scale), 0.5, 4.5) : 0;

    if (bg.kind === 'original') {
      wctx.fillStyle = '#808080';
      wctx.fillRect(0, 0, size, size);
      place(wctx);
      wctx.drawImage(blurredCanvas(cut.bg, bg.blur), 0, 0, W, H);
      reset(wctx);
      processPixels(wctx, size, lut, grain, tone.mono);
    } else if (bg.kind === 'backdrop') {
      drawBackdrop(wctx, size, bg.color, bg.light, tone.mono);
      processPixels(wctx, size, null, grain, tone.mono);
      if (finish.shadow > 0) {
        wctx.globalAlpha = finish.shadow * 0.38;
        place(wctx, size * 0.012, size * 0.022);
        wctx.drawImage(cut.shadow, 0, 0, W, H);
        reset(wctx);
      }
    } else {
      const custom = extras.custom!;
      const source = bg.blur > 0 ? blurredCanvas(custom.low, bg.blur) : custom.canvas;
      const cover = Math.max(size / source.width, size / source.height);
      const dw = source.width * cover;
      const dh = source.height * cover;
      wctx.drawImage(source, (size - dw) / 2, (size - dh) / 2, dw, dh);
      processPixels(wctx, size, tone.mono ? MONO_ONLY : null, grain, tone.mono);
    }

    const layer = getScratch('subject', size);
    const lctx = layer.ctx;
    lctx.clearRect(0, 0, size, size);
    place(lctx);
    lctx.drawImage(pickMip(cut.fg, scale), 0, 0, W, H);
    reset(lctx);
    processPixels(lctx, size, lut, 0, false);

    if (finish.wrap > 0) {
      // Light wrap: a trace of the background's colour spills onto the very edge of the
      // subject, as real light does, so the outline sits in the scene instead of on top of it.
      const tiny = getScratch('tiny', 24);
      tiny.ctx.drawImage(work.canvas, 0, 0, 24, 24);
      const spill = getScratch('spill', size);
      const sctx = spill.ctx;
      sctx.clearRect(0, 0, size, size);
      place(sctx);
      sctx.drawImage(cut.wrap, 0, 0, W, H);
      reset(sctx);
      sctx.globalCompositeOperation = 'source-in';
      sctx.drawImage(tiny.canvas, 0, 0, size, size);
      reset(sctx);
      lctx.globalCompositeOperation = 'source-atop';
      lctx.globalAlpha = finish.wrap * 0.55;
      lctx.drawImage(spill.canvas, 0, 0);
      reset(lctx);
    }
    wctx.drawImage(layer.canvas, 0, 0);
  }

  if (extras.circle) {
    wctx.globalCompositeOperation = 'destination-in';
    wctx.beginPath();
    wctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    wctx.fill();
    reset(wctx);
  }

  const out = target.getContext('2d');
  if (!out) return;
  out.setTransform(1, 0, 0, 1, 0, 0);
  out.globalAlpha = 1;
  out.globalCompositeOperation = 'source-over';
  out.clearRect(0, 0, size, size);
  out.drawImage(work.canvas, 0, 0);
}
