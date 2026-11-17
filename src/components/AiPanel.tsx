import { useCallback, useEffect, useRef, useState } from 'react';
import { aiEnhance, aiStatus, buildPrompt, DEFAULT_AI, hasAnyEdit, OUTFITS, type AiOptions, type AiStatus } from '../lib/ai';
import { createCanvas } from '../lib/canvas';
import { needsCutout, releaseScratch, render } from '../lib/render';
import type { CustomBg, Photo, Settings } from '../lib/types';
import { Section, Segmented, Toggle } from './ui';

export interface Version {
  id: number;
  label: string;
  blob: Blob;
  thumb: string;
}

interface Props {
  photo: Photo;
  settings: Settings;
  custom: CustomBg | null;
  versions: Version[];
  activeVersion: number;
  onOpenVersion: (version: Version) => void;
  onResult: (blob: Blob) => void;
}

export function AiPanel({ photo, settings, custom, versions, activeVersion, onOpenVersion, onResult }: Props) {
  const [status, setStatus] = useState<AiStatus | null | 'loading'>('loading');
  const [opts, setOpts] = useState<AiOptions>(DEFAULT_AI);
  const [busy, setBusy] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const check = useCallback(() => {
    setStatus('loading');
    void aiStatus().then((s) => alive.current && setStatus(s));
  }, []);
  useEffect(() => {
    alive.current = true;
    check();
    return () => {
      alive.current = false;
    };
  }, [check]);

  useEffect(() => {
    if (!busy) return;
    setSeconds(0);
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  const set = (patch: Partial<AiOptions>) => setOpts((o) => ({ ...o, ...patch }));

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      // First image: the untouched photo in the current framing (the source of truth for identity).
      const plain = createCanvas(1024, 1024);
      render(plain, 1024, photo, settings, { plain: true });
      const images = [plain.toDataURL('image/jpeg', 0.95)];
      // Second image: the local result, as a guide for background and mood.
      const withReference = opts.background && needsCutout(settings) && !!photo.cut;
      if (withReference) {
        const reference = createCanvas(1024, 1024);
        render(reference, 1024, photo, settings, { custom });
        images.push(reference.toDataURL('image/jpeg', 0.92));
      }
      releaseScratch(1024);
      const blob = await aiEnhance(images, buildPrompt(opts, settings, withReference), opts.quality);
      if (alive.current) onResult(blob);
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const versionStrip = versions.length > 1 && (
    <div className="versions" role="group" aria-label="Versions">
      {versions.map((v) => (
        <button key={v.id} type="button" className="version" aria-pressed={v.id === activeVersion} onClick={() => onOpenVersion(v)} disabled={busy}>
          <img src={v.thumb} alt="" />
          <span>{v.label}</span>
        </button>
      ))}
    </div>
  );

  return (
    <Section title="AI enhance" aside={<span className="tag">OpenAI · optional</span>}>
      {status === 'loading' && <p className="help">Checking for an API key…</p>}

      {status === null && (
        <p className="help">
          AI enhance needs this app's local server. Start it with <code>npm run dev</code> and open the address it prints.
        </p>
      )}

      {status !== 'loading' && status !== null && !status.configured && (
        <div className="setup">
          <p className="help">
            Everything else works without a key. To let an OpenAI image model relight, retouch or re-dress the photo, add your key once:
          </p>
          <ol className="help">
            <li>
              Create a key at <span className="mono">platform.openai.com/api-keys</span>
            </li>
            <li>
              In the app folder, copy <code>.env.example</code> to <code>.env.local</code>
            </li>
            <li>
              Put the key after <code>OPENAI_API_KEY=</code> and save
            </li>
          </ol>
          <button type="button" className="btn btn-small" onClick={check}>
            Check again
          </button>
        </div>
      )}

      {status !== 'loading' && status !== null && status.configured && (
        <>
          <Toggle label="Studio lighting" checked={opts.lighting} onChange={(lighting) => set({ lighting })} hint="Relights your face softly and fixes colour casts." />
          <Toggle
            label="Re-render background"
            checked={opts.background}
            onChange={(background) => set({ background })}
            hint="Rebuilds the background you chose above with realistic edges, instead of cutting you out."
          />
          <Toggle label="Subtle retouch" checked={opts.retouch} onChange={(retouch) => set({ retouch })} hint="Evens skin tone, reduces shine, tidies stray hairs. Keeps your features." />
          <div className="group-label">Outfit</div>
          <div className="chips">
            {OUTFITS.map((o) => (
              <button key={o.id} type="button" className="chip" aria-pressed={opts.outfit === o.id} onClick={() => set({ outfit: o.id })}>
                {o.label}
              </button>
            ))}
          </div>
          {opts.outfit === 'custom' && (
            <input
              className="text"
              type="text"
              maxLength={160}
              placeholder="e.g. a charcoal turtleneck"
              value={opts.customOutfit}
              onChange={(e) => set({ customOutfit: e.target.value })}
            />
          )}
          <div className="export-row">
            <Segmented<AiOptions['quality']>
              label="Quality"
              value={opts.quality}
              onChange={(quality) => set({ quality })}
              options={[
                { value: 'medium', label: 'Standard' },
                { value: 'high', label: 'High (slower, costs more)' },
              ]}
            />
          </div>
          <button type="button" className="btn btn-primary" disabled={busy || !hasAnyEdit(opts)} onClick={generate}>
            {busy ? `Generating… ${seconds}s` : versions.length > 1 ? 'Generate another' : 'Generate'}
          </button>
          <p className="help">
            Sends this photo to OpenAI ({status.model}) and uses your API credit. The result is 1024 px. AI can subtly change a face: compare
            with your original before using it.
          </p>
          {opts.outfit !== 'keep' && <p className="help">Outfit changes are the most likely to look edited.</p>}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </>
      )}
      {versionStrip}
    </Section>
  );
}
