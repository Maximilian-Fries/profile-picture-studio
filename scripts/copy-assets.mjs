// Copies the MediaPipe WASM runtime out of node_modules so the app serves it itself.
import { cp, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const from = resolve(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const to = resolve(root, 'public/mediapipe');

if (existsSync(from)) {
  await mkdir(to, { recursive: true });
  await cp(from, to, { recursive: true });
  console.log('[assets] MediaPipe runtime copied to public/mediapipe');
} else {
  console.log('[assets] @mediapipe/tasks-vision not installed yet, skipping');
}
