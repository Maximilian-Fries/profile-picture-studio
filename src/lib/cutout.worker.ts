// Runs the segmentation model and all mask post-processing off the main thread.
import { segmentForeground, type Config } from '@imgly/background-removal';
import { analyse, buildBackground, buildForeground, estimateNoise, refineAlpha, type Img } from './cutout-core';

interface CutJob {
  type: 'cut';
  id: number;
  key: number;
  full: { w: number; h: number; data: ArrayBuffer };
  small: { w: number; h: number; data: ArrayBuffer };
}

/** Re-builds every layer from a mask the user has corrected by hand (no model run). */
interface RecutJob {
  type: 'recut';
  id: number;
  key: number;
  alpha: ArrayBuffer;
}

type Job = CutJob | RecutJob;

// The most recent photo is kept so hand corrections can be re-processed without re-sending it.
let kept: { key: number; full: Img; noise: number } | null = null;

const scope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<Job>) => void) | null;
};

function finish(id: number, full: Img, alpha: Float32Array, noise: number) {
  const info = analyse(alpha, full.w, full.h);
  if (info.coverage < 0.01) throw new Error('No person could be found in this photo.');
  const bg = buildBackground(full, alpha);
  const fg = buildForeground(full, alpha, bg);
  scope.postMessage(
    { type: 'done', id, W: full.w, H: full.h, fg: fg.buffer, bg, noise, free: info.free, head: info.head, top: info.top },
    [fg.buffer, bg.r.buffer, bg.g.buffer, bg.b.buffer, bg.shadow.buffer, bg.wrap.buffer],
  );
}

scope.onmessage = async (event) => {
  const job = event.data;
  const { id } = job;
  const progress = (label: string, ratio: number | null) => scope.postMessage({ type: 'progress', id, label, ratio });
  if (job.type === 'recut') {
    try {
      if (!kept || kept.key !== job.key) throw new Error('This photo is no longer loaded.');
      const bytes = new Uint8Array(job.alpha);
      const alpha = new Float32Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) alpha[i] = bytes[i] / 255;
      finish(id, kept.full, alpha, kept.noise);
    } catch (error) {
      scope.postMessage({ type: 'error', id, message: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  const { full: fullRaw, small: smallRaw } = job;
  try {
    const full: Img = { w: fullRaw.w, h: fullRaw.h, data: new Uint8ClampedArray(fullRaw.data) };
    const small: Img = { w: smallRaw.w, h: smallRaw.h, data: new Uint8ClampedArray(smallRaw.data) };

    progress('Loading the cut-out model', null);
    const totals = new Map<string, [number, number]>();
    const config: Config = {
      model: 'isnet_fp16',
      device: 'cpu',
      output: { format: 'image/x-rgba8', quality: 1 },
      progress: (key, current, total) => {
        if (!key.startsWith('fetch:')) return;
        totals.set(key, [current, total]);
        let done = 0;
        let all = 0;
        for (const [c, t] of totals.values()) {
          done += c;
          all += t;
        }
        if (all > 0 && done >= all) progress('Finding you in the photo', null);
        else progress('Downloading the cut-out model (first time only)', all > 0 ? done / all : null);
      },
    };
    // The library reads raw RGBA when the blob type carries the dimensions; give it a copy
    // because it writes the mask into the same buffer.
    const input = new Blob([small.data.slice()], { type: `image/x-rgba8;width=${small.w};height=${small.h}` });
    progress('Finding you in the photo', null);
    const out = await segmentForeground(input, config);
    const raw = new Uint8Array(await out.arrayBuffer());
    const n = small.w * small.h;
    const aSmall = new Uint8Array(n);
    if (raw.length >= n * 4) for (let i = 0; i < n; i++) aSmall[i] = raw[i * 4 + 3];
    else if (raw.length >= n) aSmall.set(raw.subarray(0, n));
    else throw new Error('The cut-out model returned an unexpected result.');

    progress('Refining edges', null);
    const alpha = refineAlpha(aSmall, small, full);
    const noise = estimateNoise(full);
    kept = { key: job.key, full, noise };
    finish(id, full, alpha, noise);
  } catch (error) {
    scope.postMessage({ type: 'error', id, message: error instanceof Error ? error.message : String(error) });
  }
};
