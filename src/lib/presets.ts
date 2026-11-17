import type { Background, Finish, Settings, Tone } from './types';

export interface Swatch {
  id: string;
  name: string;
  color: string;
}

/** Seamless studio backdrops, lit from the front. */
export const STUDIO: Swatch[] = [
  { id: 'cloud', name: 'Cloud', color: '#e4e4e1' },
  { id: 'dove', name: 'Dove grey', color: '#c3c5c7' },
  { id: 'stone', name: 'Warm stone', color: '#b8b0a5' },
  { id: 'sand', name: 'Sand', color: '#d5c6af' },
  { id: 'mist', name: 'Blue mist', color: '#a8b8c5' },
  { id: 'sage', name: 'Sage', color: '#a7b29f' },
  { id: 'slate', name: 'Slate', color: '#5e6770' },
  { id: 'navy', name: 'Navy', color: '#22304a' },
  { id: 'forest', name: 'Forest', color: '#2b3a33' },
  { id: 'charcoal', name: 'Charcoal', color: '#2b2d31' },
];

/** Saturated colours for avatars that should stand out in a feed. */
export const BOLD: Swatch[] = [
  { id: 'coral', name: 'Coral', color: '#ec6a58' },
  { id: 'marigold', name: 'Marigold', color: '#f0b537' },
  { id: 'teal', name: 'Teal', color: '#1f9b91' },
  { id: 'cobalt', name: 'Cobalt', color: '#2f60d6' },
  { id: 'lilac', name: 'Lilac', color: '#b5a2ea' },
  { id: 'mint', name: 'Mint', color: '#9edabc' },
  { id: 'rose', name: 'Rose', color: '#eea6b6' },
  { id: 'ink', name: 'Ink', color: '#121418' },
];

export const STUDIO_LIGHT = 0.7;
export const BOLD_LIGHT = 0.22;

export const NEUTRAL_TONE: Tone = { auto: true, brightness: 0, contrast: 0, warmth: 0, saturation: 0, mono: false };
export const DEFAULT_FINISH: Finish = { shadow: 0.45, wrap: 0.5, grain: true };

export interface Preset {
  id: string;
  name: string;
  hint: string;
  background: Background;
  tone: Partial<Tone>;
}

const studio = (id: string): Background => ({
  kind: 'backdrop',
  color: STUDIO.find((s) => s.id === id)!.color,
  light: STUDIO_LIGHT,
});

export const PRESETS: Preset[] = [
  { id: 'natural', name: 'Natural', hint: 'Your photo, framed well', background: { kind: 'original', blur: 0 }, tone: {} },
  { id: 'soft', name: 'Casual', hint: 'Softly blurred background', background: { kind: 'original', blur: 0.42 }, tone: { warmth: 0.06 } },
  { id: 'professional', name: 'Professional', hint: 'Grey studio backdrop', background: studio('dove'), tone: { contrast: 0.06 } },
  { id: 'bright', name: 'Bright', hint: 'Light and friendly', background: studio('cloud'), tone: { brightness: 0.04 } },
  { id: 'executive', name: 'Executive', hint: 'Dark, formal backdrop', background: studio('charcoal'), tone: { contrast: 0.08 } },
  { id: 'warm', name: 'Warm studio', hint: 'Sand backdrop, warm tone', background: studio('sand'), tone: { warmth: 0.08 } },
  {
    id: 'bold',
    name: 'Bold',
    hint: 'Colour that stands out',
    background: { kind: 'backdrop', color: BOLD.find((s) => s.id === 'teal')!.color, light: BOLD_LIGHT },
    tone: { saturation: 0.04 },
  },
  { id: 'mono', name: 'Black & white', hint: 'Classic editorial', background: studio('slate'), tone: { mono: true, contrast: 0.14 } },
];

/** Applies a style without touching the user's framing or finishing choices. */
export function applyPreset(settings: Settings, preset: Preset): Settings {
  return {
    ...settings,
    presetId: preset.id,
    background: { ...preset.background },
    tone: { ...NEUTRAL_TONE, auto: settings.tone.auto, ...preset.tone },
  };
}
