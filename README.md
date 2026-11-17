# Profile Picture Studio

Turns a photo of you into a profile picture: professional, casual, bold or black & white.
Everything runs in your browser. The photo is never uploaded.

## Run it

```bash
npm install
npm run dev
```

Then open http://localhost:5183. `npm run build` produces a static site in `dist/`
(serve it with the two cross-origin isolation headers from `vite.config.ts` for full speed).

The first photo downloads the cut-out model (about 80 MB, cached afterwards) and a small
face detector. Only those model files are fetched; your image stays on your machine.

## What it does

- **Styles**: Natural, Casual (blurred background), Professional, Bright, Executive, Warm studio, Bold, Black & white.
- **Backgrounds**: original, blurred original, ten studio backdrops, eight colours, any custom colour, or your own image.
- **Framing**: automatic face-aware crop (close-up, head & shoulders, wider), drag, zoom, straighten, level eyes.
- **Light & colour**: gentle auto exposure, brightness, contrast, warmth, saturation.
- **Export**: 400 to 2000 px, JPG or PNG, square or circle, download or copy.

## Fixing a cut-out by hand

If part of you was cut off, or a bit of background was left in, press **Fix cut-out** under
the preview. Everything the cut-out removes is tinted red. Paint with *Bring back* or *Remove*,
and the edges, shadow and background are rebuilt from your corrected mask. Undo and Reset are there.

## AI enhance (optional, needs an OpenAI key)

Relights, lightly retouches, re-renders the background with realistic edges, and can change the
outfit. Unlike everything else, this sends the photo to OpenAI and costs API credit per image.

1. Create a key at https://platform.openai.com/api-keys
2. Copy `.env.example` to `.env.local` and put the key after `OPENAI_API_KEY=`
3. Press *Check again* in the AI enhance section (no restart needed)

The key stays in the local server (`server/ai-plugin.ts`); the browser never sees it. Each result
is added as a version next to your original, opens in the editor like any photo, and is 1024 px.
Set `OPENAI_IMAGE_MODEL` in `.env.local` to use a different image model. AI enhance only works
while the app is served by `npm run dev` or `npm run preview`, not from static files.

A generative model can subtly change a face. The prompt (see `src/lib/ai.ts`) locks identity as
hard as a prompt can, but always compare with your original.

## Why results look natural

Nothing is generated. Your face, hair and clothes are your own pixels. The work goes into the seams:

- the mask is re-aligned to the full-resolution photo so edges stay crisp;
- old background colour is un-mixed from edge pixels instead of leaving a fringe;
- blurred backgrounds are built from a copy with you painted out, so there is no halo;
- new backdrops are lit like a studio wall, get a soft shadow, and receive the same grain as your photo;
- a trace of the backdrop's colour wraps onto your outline, as real light would.

## Code map

- `src/lib/cutout-core.ts` mask refinement, edge clean-up, background reconstruction (runs in a worker)
- `src/lib/render.ts` the compositor
- `src/lib/framing.ts` auto-crop rules
- `src/lib/tone.ts` light and colour curves
- `src/lib/ai.ts` and `server/ai-plugin.ts` the optional AI enhance feature
- `src/components/` the interface

## Licence

This project is licensed under the [GNU Affero General Public License v3.0](LICENSE).

It has to be: the cut-out library it builds on, `@imgly/background-removal`, is AGPL-3.0.
In short, if you run a modified version as a public service, you must publish your changes
under the same licence. MediaPipe (face detection) is Apache-2.0.
