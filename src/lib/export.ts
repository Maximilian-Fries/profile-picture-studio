import { createCanvas } from './canvas';
import { releaseScratch, render } from './render';
import type { CustomBg, ExportOptions, Photo, Settings } from './types';

export function renderExport(photo: Photo, settings: Settings, custom: CustomBg | null, options: ExportOptions): Promise<Blob> {
  const canvas = createCanvas(options.size, options.size);
  render(canvas, options.size, photo, settings, { custom, circle: options.circle });
  releaseScratch(options.size);
  // A circle needs transparent corners, which JPEG cannot store.
  const type = options.circle || options.format === 'png' ? 'image/png' : 'image/jpeg';
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The image could not be saved.'))), type, 0.93);
  });
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
