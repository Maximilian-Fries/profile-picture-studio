import { FaceDetector, FilesetResolver, type Detection } from '@mediapipe/tasks-vision';
import { createCanvas, ctx2d } from './canvas';
import type { Face } from './types';

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';

let detectorPromise: Promise<FaceDetector> | null = null;

function getDetector(): Promise<FaceDetector> {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      const fileset = await FilesetResolver.forVisionTasks(`${import.meta.env.BASE_URL}mediapipe`);
      return FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
        runningMode: 'IMAGE',
        minDetectionConfidence: 0.5,
      });
    })();
    detectorPromise.catch(() => {
      detectorPromise = null;
    });
  }
  return detectorPromise;
}

interface Hit {
  face: Face;
  score: number;
}

/** Runs the detector on one region of the photo and maps results back to photo coordinates. */
function detectRegion(detector: FaceDetector, src: HTMLCanvasElement, x: number, y: number, size: number): Hit[] {
  const target = Math.min(640, Math.round(size));
  const view = createCanvas(target, target);
  const ctx = ctx2d(view);
  ctx.fillStyle = '#777';
  ctx.fillRect(0, 0, target, target);
  ctx.drawImage(src, x, y, size, size, 0, 0, target, target);
  const k = size / target;
  const result = detector.detect(view);
  const hits: Hit[] = [];
  for (const det of result.detections as Detection[]) {
    const box = det.boundingBox;
    if (!box) continue;
    const pts = det.keypoints ?? [];
    const cx = x + (box.originX + box.width / 2) * k;
    const cy = y + (box.originY + box.height / 2) * k;
    let eyeX = cx;
    let eyeY = y + (box.originY + box.height * 0.4) * k;
    let roll = 0;
    if (pts.length >= 2) {
      const a = { x: x + pts[0].x * size, y: y + pts[0].y * size };
      const b = { x: x + pts[1].x * size, y: y + pts[1].y * size };
      const left = a.x <= b.x ? a : b;
      const right = a.x <= b.x ? b : a;
      eyeX = (a.x + b.x) / 2;
      eyeY = (a.y + b.y) / 2;
      roll = (Math.atan2(right.y - left.y, right.x - left.x) * 180) / Math.PI;
    }
    hits.push({
      face: { cx, cy, w: box.width * k, h: box.height * k, eyeX, eyeY, roll, detected: true },
      score: det.categories?.[0]?.score ?? 0.5,
    });
  }
  return hits;
}

/**
 * Finds the main face. The detector is tuned for faces that fill a good part of the image,
 * so when the whole photo yields nothing we also scan overlapping zoomed-in windows.
 */
export async function detectFace(src: HTMLCanvasElement): Promise<Face | null> {
  const detector = await getDetector();
  const W = src.width;
  const H = src.height;
  const side = Math.max(W, H);
  let hits = detectRegion(detector, src, (W - side) / 2, (H - side) / 2, side);
  if (!hits.length) {
    for (const fraction of [0.6, 0.36]) {
      const size = Math.min(W, H) * fraction;
      const stepsX = Math.max(1, Math.ceil((W - size) / (size * 0.5)));
      const stepsY = Math.max(1, Math.ceil((H - size) / (size * 0.5)));
      for (let iy = 0; iy <= stepsY; iy++) {
        for (let ix = 0; ix <= stepsX; ix++) {
          const x = ((W - size) * ix) / stepsX;
          const y = ((H - size) * iy) / stepsY;
          hits.push(...detectRegion(detector, src, x, y, size));
        }
      }
      if (hits.length) break;
    }
  }
  if (!hits.length) return null;
  // Prefer large, confident, central faces: that is the person the photo is about.
  let best = hits[0];
  let bestValue = -Infinity;
  for (const hit of hits) {
    const centrality = 1 - Math.min(1, Math.abs(hit.face.cx - W / 2) / (W / 2)) * 0.35;
    const value = hit.face.w * hit.face.h * hit.score * centrality;
    if (value > bestValue) {
      bestValue = value;
      best = hit;
    }
  }
  return best.face;
}
