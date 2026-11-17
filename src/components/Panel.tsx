import { useEffect, useRef, useState } from 'react';
import { freeEdges, maxCropSize, minCropSize } from '../lib/framing';
import { applyPreset, BOLD, BOLD_LIGHT, PRESETS, STUDIO, STUDIO_LIGHT, type Preset, type Swatch } from '../lib/presets';
import { needsCutout, render } from '../lib/render';
import type { Background, Crop, CustomBg, ExportOptions, Framing, Photo, Settings, Tone } from '../lib/types';
import { Section, Segmented, Slider, Toggle } from './ui';

export type CutState =
  | { status: 'working'; label: string; ratio: number | null }
  | { status: 'ready' }
  | { status: 'error'; message: string };

interface Props {
  photo: Photo;
  settings: Settings;
  custom: CustomBg | null;
  cut: CutState;
  update: (fn: (s: Settings) => Settings) => void;
  previewFor: (settings: Settings) => Settings;
  onPreset: (preset: Preset) => void;
  onFraming: (framing: Framing) => void;
  onCrop: (crop: Crop) => void;
  onCustomFile: (file: File) => void;
  onRetry: () => void;
  onExport: (options: ExportOptions, mode: 'download' | 'copy') => Promise<string>;
  /** The optional AI section, rendered right after the styles. */
  ai?: React.ReactNode;
}

function LiveThumb({ photo, settings, custom }: { photo: Photo; settings: Settings; custom: CustomBg | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const waiting = needsCutout(settings) && !photo.cut;
  const key = JSON.stringify(settings);
  useEffect(() => {
    if (waiting) return;
    const timer = setTimeout(() => {
      if (ref.current) render(ref.current, 132, photo, settings, { custom });
    }, 80);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo, key, custom, waiting]);
  return waiting ? <span className="thumb thumb-wait" /> : <canvas ref={ref} className="thumb" width={132} height={132} />;
}

const pct = (v: number) => (v > 0 ? `+${Math.round(v * 100)}` : String(Math.round(v * 100)));

export function Panel(props: Props) {
  const { photo, settings, custom, cut, update, previewFor, onPreset, onFraming, onCrop, onCustomFile, onRetry, onExport } = props;
  const { background: bg, tone, finish, crop } = settings;
  const ready = !!photo.cut;
  const fileRef = useRef<HTMLInputElement>(null);
  const [size, setSize] = useState(800);
  const [format, setFormat] = useState<'jpeg' | 'png'>('jpeg');
  const [circle, setCircle] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const setBackground = (background: Background) => update((s) => ({ ...s, presetId: null, background }));
  const setTone = (patch: Partial<Tone>) => update((s) => ({ ...s, presetId: s.presetId, tone: { ...s.tone, ...patch } }));

  const free = freeEdges(photo, bg);
  const minSize = minCropSize(photo);
  const maxSize = Math.max(minSize + 1, maxCropSize(photo.W, photo.H, crop.rot, free));
  const zoom = (Math.log(crop.size / maxSize) / Math.log(minSize / maxSize)) * 100;
  const roll = photo.face?.detected ? photo.face.roll : 0;
  const canLevel = Math.abs(roll) > 0.8 && Math.abs(roll) <= 15 && Math.abs(crop.rot + roll) > 0.3;

  const swatch = (s: Swatch, light: number) => {
    const active = bg.kind === 'backdrop' && bg.color.toLowerCase() === s.color.toLowerCase();
    return (
      <button
        key={s.id}
        type="button"
        className="swatch"
        title={s.name}
        aria-label={s.name}
        aria-pressed={active}
        disabled={!ready}
        style={{ '--c': s.color } as React.CSSProperties}
        onClick={() => setBackground({ kind: 'backdrop', color: s.color, light })}
      />
    );
  };

  const run = async (mode: 'download' | 'copy') => {
    setBusy(true);
    setNote(null);
    try {
      setNote(await onExport({ size, format, circle }, mode));
    } catch (error) {
      setNote(error instanceof Error ? error.message : 'Something went wrong while saving.');
    } finally {
      setBusy(false);
    }
  };

  const native = Math.round(crop.size);

  return (
    <aside className="panel">
      <div className="panel-scroll">
        {cut.status === 'working' && (
          <div className="status" role="status">
            <div className="status-text">
              <span>{cut.label}…</span>
              {cut.ratio != null && <span>{Math.round(cut.ratio * 100)}%</span>}
            </div>
            <div className={`bar${cut.ratio == null ? ' is-indeterminate' : ''}`}>
              <i style={{ width: cut.ratio == null ? undefined : `${Math.round(cut.ratio * 100)}%` }} />
            </div>
            {!ready && <p>Natural is ready now. Studio styles unlock as soon as this finishes.</p>}
          </div>
        )}
        {cut.status === 'error' && (
          <div className="status is-error" role="alert">
            <div className="status-text">
              <span>Studio styles aren't available for this photo</span>
            </div>
            <p>{cut.message}</p>
            <button type="button" className="btn btn-small" onClick={onRetry}>
              Try again
            </button>
          </div>
        )}

        <Section title="Style">
          <div className="presets">
            {PRESETS.map((preset) => {
              const locked = preset.background.kind !== 'original' || preset.background.blur > 0 ? !ready : false;
              return (
                <button
                  key={preset.id}
                  type="button"
                  className="preset"
                  aria-pressed={settings.presetId === preset.id}
                  disabled={locked}
                  title={preset.hint}
                  onClick={() => onPreset(preset)}
                >
                  <LiveThumb
                    photo={photo}
                    custom={custom}
                    settings={previewFor(applyPreset(settings, preset))}
                  />
                  <span>{preset.name}</span>
                </button>
              );
            })}
          </div>
        </Section>

        {props.ai}

        <Section title="Background">
          <div className="group-label">From your photo</div>
          <div className="tiles">
            <button
              type="button"
              className="tile"
              aria-pressed={bg.kind === 'original' && bg.blur <= 0}
              onClick={() => setBackground({ kind: 'original', blur: 0 })}
            >
              Original
            </button>
            <button
              type="button"
              className="tile"
              disabled={!ready}
              aria-pressed={bg.kind === 'original' && bg.blur > 0}
              onClick={() => setBackground({ kind: 'original', blur: 0.42 })}
            >
              Blurred
            </button>
            <button
              type="button"
              className="tile tile-image"
              disabled={!ready}
              aria-pressed={bg.kind === 'image'}
              style={custom ? { backgroundImage: `linear-gradient(#0008,#0008),url(${custom.thumb})` } : undefined}
              onClick={() => (custom && bg.kind !== 'image' ? setBackground({ kind: 'image', blur: 0.3 }) : fileRef.current?.click())}
            >
              {custom ? (bg.kind === 'image' ? 'Change image' : 'Your image') : 'Upload image'}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onCustomFile(file);
                e.target.value = '';
              }}
            />
          </div>

          <div className="group-label">Studio backdrops</div>
          <div className="swatches">{STUDIO.map((s) => swatch(s, STUDIO_LIGHT))}</div>

          <div className="group-label">Colour</div>
          <div className="swatches">
            {BOLD.map((s) => swatch(s, BOLD_LIGHT))}
            <label className={`swatch swatch-custom${ready ? '' : ' is-disabled'}`} title="Pick any colour">
              <input
                type="color"
                disabled={!ready}
                value={bg.kind === 'backdrop' ? bg.color : '#c3c5c7'}
                onChange={(e) => setBackground({ kind: 'backdrop', color: e.target.value, light: bg.kind === 'backdrop' ? bg.light : 0.5 })}
              />
              <span aria-hidden="true">+</span>
            </label>
          </div>

          {bg.kind === 'original' && bg.blur > 0 && (
            <Slider
              label="Background blur"
              value={Math.round(bg.blur * 100)}
              min={5}
              max={100}
              reset={42}
              onChange={(v) => setBackground({ kind: 'original', blur: v / 100 })}
            />
          )}
          {bg.kind === 'image' && (
            <Slider
              label="Background blur"
              value={Math.round(bg.blur * 100)}
              min={0}
              max={100}
              reset={30}
              onChange={(v) => setBackground({ kind: 'image', blur: v / 100 })}
            />
          )}
          {bg.kind === 'backdrop' && (
            <Slider
              label="Backdrop lighting"
              value={Math.round(bg.light * 100)}
              min={0}
              max={100}
              reset={70}
              onChange={(v) => setBackground({ ...bg, light: v / 100 })}
            />
          )}
        </Section>

        <Section
          title="Framing"
          aside={
            <button type="button" className="link" onClick={() => onFraming(settings.framing)}>
              Re-centre
            </button>
          }
        >
          <Segmented<Framing>
            label="Framing"
            value={settings.framing}
            onChange={onFraming}
            options={[
              { value: 'close', label: 'Close-up' },
              { value: 'classic', label: 'Head & shoulders' },
              { value: 'wide', label: 'Wider' },
            ]}
          />
          <Slider
            label="Zoom"
            value={Math.max(0, Math.min(100, zoom))}
            min={0}
            max={100}
            step={0.5}
            display={(v) => `${Math.round(v)}`}
            onChange={(v) => onCrop({ ...crop, size: maxSize * Math.pow(minSize / maxSize, v / 100) })}
          />
          <Slider
            label="Straighten"
            value={crop.rot}
            min={-15}
            max={15}
            step={0.1}
            reset={0}
            display={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}°`}
            onChange={(v) => onCrop({ ...crop, rot: v })}
          />
          {canLevel && (
            <button type="button" className="btn btn-small" onClick={() => onCrop({ ...crop, rot: -roll })}>
              Level my eyes ({Math.abs(roll).toFixed(1)}° tilt)
            </button>
          )}
        </Section>

        <Section
          title="Light & colour"
          aside={
            <button
              type="button"
              className="link"
              onClick={() => setTone({ brightness: 0, contrast: 0, warmth: 0, saturation: 0, mono: false, auto: true })}
            >
              Reset
            </button>
          }
        >
          <Toggle
            label="Auto-balance exposure"
            hint="Gently corrects photos that are too dark, too bright or flat. Leaves well-exposed photos alone."
            checked={tone.auto}
            onChange={(auto) => setTone({ auto })}
          />
          <Slider label="Brightness" value={tone.brightness * 100} min={-60} max={60} reset={0} display={(v) => pct(v / 100)} onChange={(v) => setTone({ brightness: v / 100 })} />
          <Slider label="Contrast" value={tone.contrast * 100} min={-60} max={60} reset={0} display={(v) => pct(v / 100)} onChange={(v) => setTone({ contrast: v / 100 })} />
          <Slider label="Warmth" value={tone.warmth * 100} min={-60} max={60} reset={0} display={(v) => pct(v / 100)} onChange={(v) => setTone({ warmth: v / 100 })} />
          <Slider
            label="Saturation"
            value={tone.saturation * 100}
            min={-60}
            max={60}
            reset={0}
            disabled={tone.mono}
            display={(v) => pct(v / 100)}
            onChange={(v) => setTone({ saturation: v / 100 })}
          />
          <Toggle label="Black & white" checked={tone.mono} onChange={(mono) => setTone({ mono })} />
        </Section>

        {ready && needsCutout(settings) && (
          <Section title="Blend">
            <p className="help">These keep you sitting naturally in the new background.</p>
            {bg.kind === 'backdrop' && (
              <Slider
                label="Backdrop shadow"
                value={Math.round(finish.shadow * 100)}
                min={0}
                max={100}
                reset={45}
                onChange={(v) => update((s) => ({ ...s, finish: { ...s.finish, shadow: v / 100 } }))}
              />
            )}
            <Slider
              label="Edge blending"
              value={Math.round(finish.wrap * 100)}
              min={0}
              max={100}
              reset={50}
              onChange={(v) => update((s) => ({ ...s, finish: { ...s.finish, wrap: v / 100 } }))}
            />
            <Toggle
              label="Match photo grain"
              hint="Adds the same fine grain your camera produced to the new background, so it doesn't look pasted in."
              checked={finish.grain}
              onChange={(grain) => update((s) => ({ ...s, finish: { ...s.finish, grain } }))}
            />
          </Section>
        )}
      </div>

      <div className="export">
        <div className="export-row">
          <Segmented<number>
            label="Size"
            value={size}
            onChange={setSize}
            options={[400, 800, 1200, 2000].map((v) => ({ value: v, label: String(v) }))}
          />
        </div>
        <div className="export-row">
          <Segmented<'jpeg' | 'png'>
            label="Format"
            value={circle ? 'png' : format}
            onChange={setFormat}
            options={[
              { value: 'jpeg', label: 'JPG' },
              { value: 'png', label: 'PNG' },
            ]}
          />
          <Segmented<string>
            label="Shape"
            value={circle ? 'circle' : 'square'}
            onChange={(v) => setCircle(v === 'circle')}
            options={[
              { value: 'square', label: 'Square' },
              { value: 'circle', label: 'Circle' },
            ]}
          />
        </div>
        <p className="help">
          {size > native * 1.15
            ? `Your crop is about ${native}px wide, so ${size}px will be slightly enlarged. ${size > 800 ? 'A smaller size will look sharper.' : ''}`
            : circle
              ? 'Circle saves as PNG with transparent corners.'
              : `${size} × ${size}px. Most sites crop this square to a circle themselves.`}
        </p>
        <div className="export-row">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => run('download')}>
            {busy ? 'Saving…' : 'Download'}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => run('copy')}>
            Copy
          </button>
        </div>
        {note && (
          <p className="help note" role="status">
            {note}
          </p>
        )}
      </div>
    </aside>
  );
}
