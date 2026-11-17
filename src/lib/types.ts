export interface Face {
  /** Centre and size of the face box (brow to chin), in source pixels. */
  cx: number;
  cy: number;
  w: number;
  h: number;
  /** Midpoint between the eyes. */
  eyeX: number;
  eyeY: number;
  /** Head tilt in degrees (positive = clockwise in the image). */
  roll: number;
  /** False when the face position was only estimated from the silhouette. */
  detected: boolean;
}

export interface Crop {
  /** Centre of the square crop in source pixels. */
  cx: number;
  cy: number;
  /** Side length of the crop in source pixels. */
  size: number;
  /** Rotation in degrees. */
  rot: number;
}

/** Edges of the photo the crop may extend past (only where the subject does not touch them). */
export interface EdgeFree {
  l: boolean;
  r: boolean;
  t: boolean;
  b: boolean;
}

export type Framing = 'close' | 'classic' | 'wide';

export type Background =
  | { kind: 'original'; blur: number }
  | { kind: 'backdrop'; color: string; light: number }
  | { kind: 'image'; blur: number };

export interface Tone {
  auto: boolean;
  brightness: number;
  contrast: number;
  warmth: number;
  saturation: number;
  mono: boolean;
}

export interface Finish {
  shadow: number;
  wrap: number;
  grain: boolean;
}

export interface Settings {
  presetId: string | null;
  background: Background;
  crop: Crop;
  framing: Framing;
  tone: Tone;
  finish: Finish;
}

export interface ToneStats {
  lo: number;
  hi: number;
  median: number;
  faceMedian: number | null;
}

/** A canvas plus progressively halved copies, for clean and fast downscaling. */
export type Mips = HTMLCanvasElement[];

/** Low-resolution background with the person painted out, stored in linear-ish light. */
export interface LowImage {
  w: number;
  h: number;
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
}

export interface Cutout {
  fg: Mips;
  /** The cut-out mask (alpha channel only). Painted on directly by the touch-up brush. */
  mask: HTMLCanvasElement;
  /** The mask as the model produced it, for "reset". */
  autoMask: HTMLCanvasElement;
  bg: LowImage;
  shadow: HTMLCanvasElement;
  wrap: HTMLCanvasElement;
  free: EdgeFree;
  noise: number;
  /** Top of the subject's silhouette in source pixels. */
  subjectTop: number;
  headGuess: Face | null;
}

export interface Photo {
  id: number;
  name: string;
  W: number;
  H: number;
  src: Mips;
  stats: ToneStats;
  face: Face | null;
  cut: Cutout | null;
}

export interface CustomBg {
  id: number;
  canvas: HTMLCanvasElement;
  low: LowImage;
  thumb: string;
}

export interface ExportOptions {
  size: number;
  format: 'jpeg' | 'png';
  circle: boolean;
}
