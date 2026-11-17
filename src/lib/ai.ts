import { BOLD, STUDIO } from './presets';
import type { Settings } from './types';

export type OutfitId = 'keep' | 'blazer' | 'shirt' | 'knit' | 'tee' | 'custom';

export const OUTFITS: { id: OutfitId; label: string; text?: string }[] = [
  { id: 'keep', label: 'Keep mine' },
  { id: 'blazer', label: 'Blazer', text: 'a well-fitted dark navy blazer over a plain light shirt with an open collar, no tie' },
  { id: 'shirt', label: 'Shirt', text: 'a crisp, plain light-blue button-up shirt with the collar open' },
  { id: 'knit', label: 'Knit', text: 'a fine-knit crew-neck jumper in a muted neutral colour' },
  { id: 'tee', label: 'T-shirt', text: 'a plain, good-quality crew-neck t-shirt in a solid neutral colour' },
  { id: 'custom', label: 'Describe…' },
];

export interface AiOptions {
  lighting: boolean;
  background: boolean;
  retouch: boolean;
  outfit: OutfitId;
  customOutfit: string;
  quality: 'medium' | 'high';
}

export const DEFAULT_AI: AiOptions = {
  lighting: true,
  background: true,
  retouch: true,
  outfit: 'keep',
  customOutfit: '',
  quality: 'medium',
};

export interface AiStatus {
  configured: boolean;
  model: string;
}

const HEADERS = { 'X-PFP': '1' };

/** Null when the app is served without its local server (for example as static files). */
export async function aiStatus(): Promise<AiStatus | null> {
  try {
    const res = await fetch('/api/ai/status', { headers: HEADERS, cache: 'no-store' });
    if (!res.ok || !res.headers.get('content-type')?.includes('json')) return null;
    return (await res.json()) as AiStatus;
  } catch {
    return null;
  }
}

export function outfitText(o: AiOptions): string | null {
  if (o.outfit === 'keep') return null;
  if (o.outfit === 'custom') return o.customOutfit.trim() || null;
  return OUTFITS.find((x) => x.id === o.outfit)?.text ?? null;
}

export function hasAnyEdit(o: AiOptions): boolean {
  return o.lighting || o.background || o.retouch || !!outfitText(o);
}

function describeBackground(settings: Settings, hasReference: boolean): string {
  const bg = settings.background;
  if (bg.kind === 'backdrop') {
    const known = [...STUDIO, ...BOLD].find((s) => s.color.toLowerCase() === bg.color.toLowerCase());
    const colour = known ? `${known.name.toLowerCase()} (${bg.color})` : bg.color;
    return `Place the person in front of a seamless studio backdrop in ${colour}, lit softly so it is slightly brighter behind the head and falls off gently toward the corners.`;
  }
  if (bg.kind === 'image' && hasReference) {
    return 'Use the scene shown behind the person in the second image as the background, softly out of focus, lit consistently with the person.';
  }
  if (bg.blur > 0) {
    return 'Keep the same real location as in the first image, but render it softly out of focus, as if shot with a fast portrait lens at a wide aperture.';
  }
  return 'Keep the same background as the first image, cleaned up only where it is distracting.';
}

/**
 * The instruction sent to the image model. The first part is a fixed identity lock: the whole
 * point of this tool is that the result still looks like the person and like a real photograph.
 */
export function buildPrompt(o: AiOptions, settings: Settings, hasReference: boolean): string {
  const outfit = outfitText(o);
  const parts: string[] = [];
  parts.push(
    'Edit the first image into a square profile picture. It is a real photograph of a real person and the result must be unmistakably the same person, looking like an unedited photograph taken by a skilled portrait photographer.',
  );
  if (hasReference) {
    parts.push(
      'The second image is only a rough mock-up of the desired background and colour mood. Its cut-out edges are imperfect: do not copy its edge artefacts, halos or missing parts. Always take the person (face, hair, body) from the first image.',
    );
  }
  parts.push(
    'Preserve exactly: face shape and proportions, eyes (shape, colour, spacing), eyebrows, nose, mouth, teeth, ears, skin tone, age, moles, freckles, scars and wrinkles, hairline, hair colour, length and style, facial hair, glasses and jewellery, expression, gaze, head pose, body shape, and the framing and composition of the first image.',
  );
  parts.push(
    'Never reshape, slim, enlarge eyes, change makeup, whiten teeth, or smooth skin into a plastic or airbrushed look. Keep real skin texture with visible pores. No HDR, no painterly, illustrated or CGI look, no added text, logos, watermark, border or vignette.',
  );

  parts.push(
    o.lighting
      ? 'Lighting: relight naturally with a large soft key light slightly above eye level and to one side, gentle fill on the shadow side, natural catchlights in the eyes. Correct exposure and remove colour casts so skin tone is accurate. The light on the person and on the background must agree.'
      : 'Lighting: keep the light on the person as it is in the first image.',
  );
  parts.push(
    o.background
      ? `Background: ${describeBackground(settings, hasReference)} Hair and shoulder edges must blend into it the way they would in a real photo, with fine strands intact and no outline or halo.`
      : 'Background: keep the background exactly as it is in the first image.',
  );
  parts.push(
    o.retouch
      ? 'Retouch very lightly, as a careful human retoucher would: even out blotchy or red patches, reduce shine, soften temporary blemishes and under-eye shadows a little, tidy stray flyaway hairs and lint on clothing. Keep every permanent feature.'
      : 'Retouching: none. Leave skin and hair exactly as they are.',
  );
  parts.push(
    outfit
      ? `Clothing: replace what they are wearing with ${outfit}. It must fit their real body shape and posture, with realistic fabric, folds and collar, lit by the same light as the face. Keep the neck and shoulders where they are.`
      : 'Clothing: keep exactly what they are wearing.',
  );
  if (settings.tone.mono) parts.push('Render the final image as a black and white photograph with natural tonal range.');
  parts.push('Output a photorealistic 1:1 image with the head and shoulders framed as in the first image.');
  return parts.join('\n\n');
}

export async function aiEnhance(images: string[], prompt: string, quality: AiOptions['quality']): Promise<Blob> {
  const res = await fetch('/api/ai/enhance', {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ images, prompt, quality }),
  });
  let payload: any = null;
  try {
    payload = await res.json();
  } catch {
    // handled below
  }
  if (!res.ok || !payload?.image) {
    throw new Error(payload?.error || `The AI request failed (${res.status}).`);
  }
  return await (await fetch(payload.image)).blob();
}
