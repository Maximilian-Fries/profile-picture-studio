import { useCallback, useEffect, useRef, useState } from 'react';
import { AiPanel, type Version } from './components/AiPanel';
import { Panel, type CutState } from './components/Panel';
import { Stage, type TouchTool } from './components/Stage';
import { recut, restoreMask, runCutout, snapshotMask } from './lib/cutout';
import { downloadBlob, renderExport } from './lib/export';
import { detectFace } from './lib/face';
import { autoCrop, clampCrop, freeEdges, minCropSize } from './lib/framing';
import { loadCustomBackground, loadPhoto, measureTone } from './lib/photo';
import { applyPreset, DEFAULT_FINISH, NEUTRAL_TONE, type Preset } from './lib/presets';
import type { Crop, CustomBg, ExportOptions, Framing, Photo, Settings } from './lib/types';

const INITIAL: Settings = {
  presetId: 'natural',
  background: { kind: 'original', blur: 0 },
  crop: { cx: 0, cy: 0, size: 100, rot: 0 },
  framing: 'classic',
  tone: NEUTRAL_TONE,
  finish: DEFAULT_FINISH,
};

/** Keeps the crop valid for the current photo and background; re-composes it until the user takes over. */
function fit(settings: Settings, photo: Photo, touched: boolean): Settings {
  const free = freeEdges(photo, settings.background);
  const crop = touched
    ? clampCrop(settings.crop, photo.W, photo.H, free, minCropSize(photo))
    : autoCrop(photo, settings.framing, free, settings.crop.rot);
  return { ...settings, crop };
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export default function App() {
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [settings, setSettings] = useState<Settings>(INITIAL);
  const [cut, setCut] = useState<CutState>({ status: 'ready' });
  const [custom, setCustom] = useState<CustomBg | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [over, setOver] = useState(false);
  const photoRef = useRef<Photo | null>(null);
  const touched = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [versions, setVersions] = useState<Version[]>([]);
  const [activeVersion, setActiveVersion] = useState(0);
  const versionSeq = useRef(0);
  const aiCount = useRef(0);
  const [touch, setTouch] = useState<TouchTool | null>(null);
  const [touchBusy, setTouchBusy] = useState(false);
  const [undoCount, setUndoCount] = useState(0);
  const undoStack = useRef<HTMLCanvasElement[]>([]);
  const recutTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const recutSeq = useRef(0);

  const patchPhoto = useCallback((id: number, patch: Partial<Photo>) => {
    const current = photoRef.current;
    if (!current || current.id !== id) return;
    const next = { ...current, ...patch };
    photoRef.current = next;
    setPhoto(next);
    setSettings((s) => fit(s, next, touched.current));
  }, []);

  const update = useCallback((fn: (s: Settings) => Settings) => {
    setSettings((prev) => {
      const next = fn(prev);
      const current = photoRef.current;
      return current ? fit(next, current, touched.current) : next;
    });
  }, []);

  const startCut = useCallback(
    (p: Photo) => {
      const isCurrent = () => photoRef.current?.id === p.id;
      setCut({ status: 'working', label: 'Preparing', ratio: null });
      runCutout(p.src, p.id, (progress) => {
        if (isCurrent()) setCut({ status: 'working', ...progress });
      })
        .then((result) => {
          if (!isCurrent()) return;
          patchPhoto(p.id, { cut: result });
          setCut({ status: 'ready' });
        })
        .catch((err) => {
          if (isCurrent()) setCut({ status: 'error', message: message(err) });
        });
    },
    [patchPhoto],
  );

  /** Loads an image into the editor (the user's upload or one of the AI versions). */
  const loadInto = useCallback(
    async (file: Blob, name: string): Promise<boolean> => {
      setError(null);
      setOpening(true);
      try {
        const p = await loadPhoto(file, name);
        touched.current = false;
        clearTimeout(recutTimer.current);
        recutSeq.current++;
        undoStack.current = [];
        setUndoCount(0);
        setTouch(null);
        setTouchBusy(false);
        photoRef.current = p;
        setPhoto(p);
        setSettings(fit({ ...INITIAL }, p, false));
        detectFace(p.src[0])
          .then((face) => {
            if (face) patchPhoto(p.id, { face, stats: measureTone(p.src, face) });
          })
          .catch((err) => console.warn('Face detection unavailable:', err));
        startCut(p);
        return true;
      } catch (err) {
        setError(message(err));
        return false;
      } finally {
        setOpening(false);
      }
    },
    [patchPhoto, startCut],
  );

  const addVersion = useCallback((blob: Blob, label: string): Version => {
    const version: Version = { id: ++versionSeq.current, label, blob, thumb: URL.createObjectURL(blob) };
    return version;
  }, []);

  /** A new upload: starts a fresh list of versions with this photo as the original. */
  const openFile = useCallback(
    async (file: Blob, name: string) => {
      if (!(await loadInto(file, name))) return;
      aiCount.current = 0;
      const original = addVersion(file, 'Original');
      setVersions((old) => {
        old.forEach((v) => URL.revokeObjectURL(v.thumb));
        return [original];
      });
      setActiveVersion(original.id);
    },
    [addVersion, loadInto],
  );

  const openVersion = useCallback(
    async (version: Version) => {
      if (await loadInto(version.blob, version.label)) setActiveVersion(version.id);
    },
    [loadInto],
  );

  const onAiResult = useCallback(
    (blob: Blob) => {
      aiCount.current += 1;
      const version = addVersion(blob, `AI ${aiCount.current}`);
      setVersions((old) => [...old, version]);
      void openVersion(version);
    },
    [addVersion, openVersion],
  );

  // ----- Touch-up brush -----
  const scheduleRecut = useCallback(() => {
    const p = photoRef.current;
    if (!p?.cut) return;
    clearTimeout(recutTimer.current);
    const seq = ++recutSeq.current;
    setTouchBusy(true);
    recutTimer.current = setTimeout(async () => {
      try {
        const current = photoRef.current;
        if (!current?.cut || current.id !== p.id) return;
        const next = await recut(current.id, current.cut);
        if (seq === recutSeq.current) patchPhoto(p.id, { cut: next });
      } catch (err) {
        if (seq === recutSeq.current) setError(message(err));
      } finally {
        if (seq === recutSeq.current) setTouchBusy(false);
      }
    }, 250);
  }, [patchPhoto]);

  const onTouch = useCallback((next: TouchTool | null) => {
    // Once you are correcting details, the frame should stop re-composing itself.
    if (next) touched.current = true;
    setTouch(next);
  }, []);
  const onStrokeStart = useCallback(() => {
    const cut = photoRef.current?.cut;
    if (!cut) return;
    undoStack.current.push(snapshotMask(cut.mask));
    if (undoStack.current.length > 8) undoStack.current.shift();
    setUndoCount(undoStack.current.length);
  }, []);
  const onUndo = useCallback(() => {
    const p = photoRef.current;
    const previous = undoStack.current.pop();
    if (!p?.cut || !previous) return;
    restoreMask(p.cut.mask, previous);
    setUndoCount(undoStack.current.length);
    patchPhoto(p.id, {});
    scheduleRecut();
  }, [patchPhoto, scheduleRecut]);
  const onResetMask = useCallback(() => {
    const p = photoRef.current;
    if (!p?.cut) return;
    onStrokeStart();
    restoreMask(p.cut.mask, p.cut.autoMask);
    patchPhoto(p.id, {});
    scheduleRecut();
  }, [onStrokeStart, patchPhoto, scheduleRecut]);

  const pick = (files: FileList | null | undefined) => {
    const file = files && [...files].find((f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name));
    if (file) void openFile(file, file.name);
    else if (files?.length) setError('That file is not an image. Choose a JPG, PNG or WebP photo.');
  };

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
      if (file) {
        e.preventDefault();
        void openFile(file, 'pasted-photo');
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [openFile]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    // Test hook for automated checks during development; not present in production builds.
    (window as any).__pfp = {
      loadUrl: async (url: string) => openFile(await (await fetch(url)).blob(), 'sample'),
      open: openFile,
      photo: () => photoRef.current,
      settings: () => settingsRef.current,
    };
  }, [openFile]);

  const onCrop = useCallback(
    (crop: Crop) => {
      touched.current = true;
      update((s) => ({ ...s, crop }));
    },
    [update],
  );
  const onFraming = useCallback(
    (framing: Framing) => {
      touched.current = false;
      update((s) => ({ ...s, framing, crop: { ...s.crop, rot: 0 } }));
    },
    [update],
  );
  const onPreset = useCallback((preset: Preset) => update((s) => applyPreset(s, preset)), [update]);
  const previewFor = (s: Settings) => (photo ? fit(s, photo, touched.current) : s);

  const onCustomFile = async (file: File) => {
    try {
      const next = await loadCustomBackground(file);
      setCustom(next);
      update((s) => ({ ...s, presetId: null, background: { kind: 'image', blur: s.background.kind === 'image' ? s.background.blur : 0.3 } }));
    } catch (err) {
      setError(message(err));
    }
  };

  const onExport = async (options: ExportOptions, mode: 'download' | 'copy'): Promise<string> => {
    const p = photoRef.current;
    if (!p) throw new Error('Open a photo first.');
    if (mode === 'copy') {
      if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
        throw new Error('This browser cannot copy images. Use Download instead.');
      }
      const blob = await renderExport(p, settings, custom, { ...options, format: 'png' });
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return 'Copied. Paste it anywhere.';
    }
    const blob = await renderExport(p, settings, custom, options);
    const ext = blob.type === 'image/png' ? 'png' : 'jpg';
    const filename = `profile-picture-${settings.presetId ?? 'custom'}-${options.size}.${ext}`;
    downloadBlob(blob, filename);
    return `Saved ${filename} (${Math.max(1, Math.round(blob.size / 1024))} KB).`;
  };

  const dropHandlers = {
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes('Files')) {
        e.preventDefault();
        setOver(true);
      }
    },
    onDragLeave: (e: React.DragEvent) => {
      if (e.currentTarget === e.target) setOver(false);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setOver(false);
      pick(e.dataTransfer.files);
    },
  };

  const fileInput = (
    <input
      ref={inputRef}
      type="file"
      accept="image/*,.heic,.heif"
      hidden
      onChange={(e) => {
        pick(e.target.files);
        e.target.value = '';
      }}
    />
  );

  if (!photo) {
    return (
      <main className={`welcome${over ? ' is-over' : ''}`} {...dropHandlers}>
        {fileInput}
        <div className="welcome-card">
          <p className="eyebrow">Profile Picture Studio</p>
          <h1>Turn a photo of you into a profile picture that still looks like you.</h1>
          <p className="lede">
            Professional, casual, or anything in between. It frames your face, swaps or softens the background and balances the light. It
            never redraws your face.
          </p>
          <button type="button" className="btn btn-primary btn-large" disabled={opening} onClick={() => inputRef.current?.click()}>
            {opening ? 'Opening…' : 'Choose a photo'}
          </button>
          <p className="drop-hint">or drop one anywhere, or paste from the clipboard</p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <ul className="tips">
            <li>
              <b>Face the light</b>
              <span>A window in front of you beats any filter.</span>
            </li>
            <li>
              <b>Leave some room</b>
              <span>Head and shoulders in frame gives the best crops.</span>
            </li>
            <li>
              <b>Stays on your device</b>
              <span>Your photo is processed in this browser and never uploaded.</span>
            </li>
          </ul>
        </div>
      </main>
    );
  }

  return (
    <div className={`app${over ? ' is-over' : ''}`} {...dropHandlers}>
      {fileInput}
      <header className="topbar">
        <span className="brand">Profile Picture Studio</span>
        <span className="private">Processed on your device. Nothing is uploaded.</span>
        <button type="button" className="btn" disabled={opening} onClick={() => inputRef.current?.click()}>
          {opening ? 'Opening…' : 'New photo'}
        </button>
      </header>
      {error && (
        <p className="error error-bar" role="alert">
          {error}
          <button type="button" className="link" onClick={() => setError(null)}>
            Dismiss
          </button>
        </p>
      )}
      <div className="workspace">
        <Stage
          photo={photo}
          settings={settings}
          custom={custom}
          onCrop={onCrop}
          touch={touch}
          canTouch={!!photo.cut}
          touchBusy={touchBusy}
          canUndo={undoCount > 0}
          onTouch={onTouch}
          onStrokeStart={onStrokeStart}
          onStrokeEnd={scheduleRecut}
          onUndo={onUndo}
          onResetMask={onResetMask}
        />
        <Panel
          photo={photo}
          settings={settings}
          custom={custom}
          cut={cut}
          update={update}
          previewFor={previewFor}
          onPreset={onPreset}
          onFraming={onFraming}
          onCrop={onCrop}
          onCustomFile={onCustomFile}
          onRetry={() => startCut(photo)}
          onExport={onExport}
          ai={
            <AiPanel
              photo={photo}
              settings={settings}
              custom={custom}
              versions={versions}
              activeVersion={activeVersion}
              onOpenVersion={openVersion}
              onResult={onAiResult}
            />
          }
        />
      </div>
    </div>
  );
}
