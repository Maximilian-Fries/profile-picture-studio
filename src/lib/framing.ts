import { clamp } from './imageops';
import type { Background, Crop, EdgeFree, Face, Framing, Photo } from './types';

export const NO_FREE: EdgeFree = { l: false, r: false, t: false, b: false };

const FRAMING: Record<Framing, { face: number; eye: number }> = {
  // face = share of the frame taken by the detector's face box (about forehead to chin, ear to ear);
  // eye = how far down the frame the eye line sits.
  close: { face: 0.5, eye: 0.43 },
  classic: { face: 0.4, eye: 0.41 },
  wide: { face: 0.31, eye: 0.38 },
};

/** A new backdrop can extend past photo edges the person does not touch; the original scene cannot. */
export function freeEdges(photo: Photo, background: Background): EdgeFree {
  if (background.kind === 'original' || !photo.cut) return NO_FREE;
  return photo.cut.free;
}

export function minCropSize(photo: Photo): number {
  const face = photo.face ?? photo.cut?.headGuess ?? null;
  const base = face ? face.h * 1.05 : Math.min(photo.W, photo.H) * 0.18;
  return Math.max(48, Math.min(base, Math.min(photo.W, photo.H)));
}

export function maxCropSize(W: number, H: number, rot: number, free: EdgeFree): number {
  const rad = (rot * Math.PI) / 180;
  const k = Math.abs(Math.cos(rad)) + Math.abs(Math.sin(rad));
  const limitW = free.l || free.r ? Infinity : W / k;
  const limitH = free.t || free.b ? Infinity : H / k;
  return Math.min(limitW, limitH, Math.max(W, H) * 1.25);
}

/** Keeps the crop inside the photo, except across edges that may be extended with backdrop. */
export function clampCrop(crop: Crop, W: number, H: number, free: EdgeFree, minSize: number): Crop {
  const rot = clamp(crop.rot, -20, 20);
  const rad = (rot * Math.PI) / 180;
  const k = Math.abs(Math.cos(rad)) + Math.abs(Math.sin(rad));
  const maxSize = maxCropSize(W, H, rot, free);
  const size = clamp(crop.size, Math.min(minSize, maxSize), maxSize);
  const half = (size * k) / 2;

  const axis = (value: number, extent: number, freeLo: boolean, freeHi: boolean) => {
    let lo = freeLo ? 0 : half;
    let hi = freeHi ? extent : extent - half;
    if (lo > hi) {
      if (freeLo && !freeHi) lo = hi;
      else if (!freeLo && freeHi) hi = lo;
      else lo = hi = extent / 2;
    }
    return clamp(value, lo, hi);
  };
  return {
    cx: axis(crop.cx, W, free.l, free.r),
    cy: axis(crop.cy, H, free.t, free.b),
    size,
    rot,
  };
}

/** Composes the portrait the way a photographer would: eyes in the upper third, face centred. */
export function autoCrop(photo: Photo, framing: Framing, free: EdgeFree, rot = 0): Crop {
  const face: Face | null = photo.face ?? photo.cut?.headGuess ?? null;
  const { W, H } = photo;
  if (!face) {
    const size = Math.min(W, H);
    return clampCrop({ cx: W / 2, cy: Math.min(H / 2, size / 2 + H * 0.04), size, rot }, W, H, free, minCropSize(photo));
  }
  const spec = FRAMING[framing];
  const min = minCropSize(photo);
  let size = face.h / spec.face;
  // Where the photo ends at an edge we cannot extend, a slightly tighter crop that keeps the
  // eyes in the right place looks better than a wide one with the face pushed off-centre.
  let fits = Infinity;
  if (!free.b) fits = Math.min(fits, (H - face.eyeY) / (1 - spec.eye));
  if (!free.t) fits = Math.min(fits, face.eyeY / spec.eye);
  if (!free.l) fits = Math.min(fits, 2 * face.eyeX);
  if (!free.r) fits = Math.min(fits, 2 * (W - face.eyeX));
  const tightest = Math.min(size, face.h / FRAMING.close.face);
  size = Math.max(Math.min(size, fits), tightest);
  let cy = face.eyeY + (0.5 - spec.eye) * size;
  // Don't slice off the top of the hair if moving the frame up a little avoids it
  // (the eyes may drop to the middle of the frame, never below).
  if (photo.cut && framing !== 'close') {
    const wantedTop = photo.cut.subjectTop - size * 0.045;
    const lift = cy - size / 2 - wantedTop;
    if (lift > 0) cy -= Math.min(lift, (0.5 - spec.eye) * size);
  }
  return clampCrop({ cx: face.eyeX, cy, size, rot }, W, H, free, min);
}
