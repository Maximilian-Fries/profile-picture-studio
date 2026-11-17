import { createCanvas, ctx2d, makeMips, resizeCanvas, toLowImage } from './canvas';
import type { CustomBg, Face, Mips, Photo, ToneStats } from './types';

/** Longest side of the working copy. Plenty for a 2000px square export, light enough to stay responsive. */
const WORKING_MAX = 2400;

let nextId = 1;

async function decode(file: Blob): Promise<{ source: CanvasImageSource; w: number; h: number; close: () => void }> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return { source: bitmap, w: bitmap.width, h: bitmap.height, close: () => bitmap.close() };
  } catch {
    // Fall through to <img>, which can decode a few formats createImageBitmap cannot.
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return { source: img, w: img.naturalWidth, h: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    throw new Error("This file couldn't be opened as an image. Try a JPG, PNG or WebP (HEIC only works in Safari).");
  }
}

async function toWorkingCanvas(file: Blob, maxLong: number): Promise<HTMLCanvasElement> {
  const { source, w, h, close } = await decode(file);
  try {
    if (!w || !h) throw new Error('This image appears to be empty.');
    const scale = Math.min(1, maxLong / Math.max(w, h));
    return resizeCanvas(source, w, h, w * scale, h * scale);
  } finally {
    close();
  }
}

export function measureTone(src: Mips, face: Face | null): ToneStats {
  const base = src[0];
  const small = src[src.length - 1];
  const { width: w, height: h } = small;
  const data = ctx2d(small, true).getImageData(0, 0, w, h).data;
  const hist = new Uint32Array(256);
  const faceHist = new Uint32Array(256);
  let faceCount = 0;
  const k = w / base.width;
  // Sample the inner part of the face box, which is mostly skin.
  const fx0 = face ? (face.cx - face.w * 0.3) * k : 0;
  const fx1 = face ? (face.cx + face.w * 0.3) * k : 0;
  const fy0 = face ? (face.cy - face.h * 0.3) * k : 0;
  const fy1 = face ? (face.cy + face.h * 0.35) * k : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const l = Math.round(0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]);
      hist[l]++;
      if (face && x >= fx0 && x <= fx1 && y >= fy0 && y <= fy1) {
        faceHist[l]++;
        faceCount++;
      }
    }
  }
  const percentile = (h: Uint32Array, total: number, q: number) => {
    let acc = 0;
    for (let i = 0; i < 256; i++) {
      acc += h[i];
      if (acc >= total * q) return i / 255;
    }
    return 1;
  };
  const total = w * h;
  return {
    lo: percentile(hist, total, 0.005),
    hi: percentile(hist, total, 0.995),
    median: percentile(hist, total, 0.5),
    faceMedian: faceCount > 20 ? percentile(faceHist, faceCount, 0.5) : null,
  };
}

export async function loadPhoto(file: Blob, name: string): Promise<Photo> {
  const canvas = await toWorkingCanvas(file, WORKING_MAX);
  if (Math.min(canvas.width, canvas.height) < 160) {
    throw new Error('This photo is too small to make a good profile picture. Use one at least 400 pixels wide.');
  }
  const src = makeMips(canvas);
  return {
    id: nextId++,
    name,
    W: canvas.width,
    H: canvas.height,
    src,
    stats: measureTone(src, null),
    face: null,
    cut: null,
  };
}

export async function loadCustomBackground(file: Blob): Promise<CustomBg> {
  const canvas = await toWorkingCanvas(file, 1600);
  const thumb = createCanvas(96, 96);
  const cover = Math.max(96 / canvas.width, 96 / canvas.height);
  ctx2d(thumb).drawImage(
    canvas,
    (96 - canvas.width * cover) / 2,
    (96 - canvas.height * cover) / 2,
    canvas.width * cover,
    canvas.height * cover,
  );
  return { id: nextId++, canvas, low: toLowImage(canvas, 512), thumb: thumb.toDataURL('image/jpeg', 0.8) };
}
