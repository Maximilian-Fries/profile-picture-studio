import { useEffect, useRef, useState } from 'react';
import { paintMask } from '../lib/cutout';
import { render } from '../lib/render';
import type { Crop, CustomBg, Photo, Settings } from '../lib/types';

export interface TouchTool {
  tool: 'restore' | 'erase';
  /** Brush diameter in screen pixels. */
  size: number;
}

interface Props {
  photo: Photo;
  settings: Settings;
  custom: CustomBg | null;
  onCrop: (crop: Crop) => void;
  /** When set, dragging paints on the cut-out mask instead of moving the photo. */
  touch: TouchTool | null;
  canTouch: boolean;
  touchBusy: boolean;
  canUndo: boolean;
  onTouch: (touch: TouchTool | null) => void;
  onStrokeStart: () => void;
  onStrokeEnd: () => void;
  onUndo: () => void;
  onResetMask: () => void;
}

const MINIS = [88, 48, 28];

export function Stage(props: Props) {
  const { photo, settings, custom, onCrop, touch, canTouch, touchBusy, canUndo, onTouch, onStrokeStart, onStrokeEnd, onUndo, onResetMask } = props;
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const miniRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  const [cssSize, setCssSize] = useState(0);
  const [compare, setCompare] = useState(false);
  const [circle, setCircle] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [paintRev, setPaintRev] = useState(0);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const painting = !!touch && !!photo.cut;
  const live = useRef({ settings, onCrop, cssSize, painting });
  live.current = { settings, onCrop, cssSize, painting };

  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setCssSize(el.clientWidth));
    observer.observe(el);
    setCssSize(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || cssSize < 8) return;
    const handle = requestAnimationFrame(() => {
      const px = Math.min(1400, Math.round(cssSize * Math.min(2, window.devicePixelRatio || 1)));
      render(canvas, px, photo, settings, { custom, plain: compare, maskView: painting && !compare });
      miniRefs.current.forEach((mini, i) => {
        if (!mini) return;
        const s = MINIS[i] * 2;
        if (mini.width !== s) mini.width = mini.height = s;
        const ctx = mini.getContext('2d');
        if (!ctx) return;
        ctx.imageSmoothingQuality = 'high';
        ctx.clearRect(0, 0, s, s);
        ctx.drawImage(canvas, 0, 0, s, s);
      });
    });
    return () => cancelAnimationFrame(handle);
  }, [photo, settings, custom, compare, cssSize, painting, paintRev]);

  // Zoom with the wheel / trackpad pinch. Needs a non-passive listener to stop the page scrolling.
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { settings: s, onCrop: emit, cssSize: size, painting: brush } = live.current;
      if (brush && !e.ctrlKey && size) {
        // While brushing, two-finger scroll moves around the photo; pinch still zooms.
        const k = s.crop.size / size;
        emit({ ...s.crop, cx: s.crop.cx + e.deltaX * k, cy: s.crop.cy + e.deltaY * k });
        return;
      }
      const factor = Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0018));
      emit({ ...s.crop, size: s.crop.size * factor });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const drag = useRef<{ x: number; y: number; crop: Crop } | null>(null);
  const stroke = useRef<{ x: number; y: number } | null>(null);

  /** Screen position inside the frame -> position in the source photo. */
  const toSource = (e: React.PointerEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const { crop } = settings;
    const k = crop.size / rect.width;
    const vx = (e.clientX - rect.left - rect.width / 2) * k;
    const vy = (e.clientY - rect.top - rect.height / 2) * k;
    const rad = (-crop.rot * Math.PI) / 180;
    return {
      x: crop.cx + vx * Math.cos(rad) - vy * Math.sin(rad),
      y: crop.cy + vx * Math.sin(rad) + vy * Math.cos(rad),
      k,
    };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (painting && touch && photo.cut) {
      onStrokeStart();
      const p = toSource(e);
      stroke.current = p;
      paintMask(photo.cut.mask, p, p, (touch.size / 2) * p.k, touch.tool === 'erase');
      setPaintRev((v) => v + 1);
      return;
    }
    drag.current = { x: e.clientX, y: e.clientY, crop: settings.crop };
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (painting) {
      const rect = e.currentTarget.getBoundingClientRect();
      setCursor({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      if (stroke.current && touch && photo.cut) {
        const p = toSource(e);
        paintMask(photo.cut.mask, stroke.current, p, (touch.size / 2) * p.k, touch.tool === 'erase');
        stroke.current = p;
        setPaintRev((v) => v + 1);
      }
      return;
    }
    const start = drag.current;
    if (!start) return;
    const { cssSize: size, onCrop: emit } = live.current;
    if (!size) return;
    const k = start.crop.size / size;
    const dx = (e.clientX - start.x) * k;
    const dy = (e.clientY - start.y) * k;
    const rad = (-start.crop.rot * Math.PI) / 180;
    const rx = dx * Math.cos(rad) - dy * Math.sin(rad);
    const ry = dx * Math.sin(rad) + dy * Math.cos(rad);
    emit({ ...start.crop, cx: start.crop.cx - rx, cy: start.crop.cy - ry });
  };
  const endDrag = () => {
    if (stroke.current) {
      stroke.current = null;
      onStrokeEnd();
    }
    drag.current = null;
    setDragging(false);
  };

  return (
    <div className="stage">
      <div
        ref={frameRef}
        className={`stage-frame${dragging ? ' is-dragging' : ''}${painting ? ' is-painting' : ''}`}
        onPointerLeave={() => setCursor(null)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <canvas ref={canvasRef} aria-label="Profile picture preview" />
        {circle && !painting && <div className="circle-guide" aria-hidden="true" />}
        {painting && touch && cursor && (
          <div
            className={`brush brush-${touch.tool}`}
            aria-hidden="true"
            style={{ width: touch.size, height: touch.size, left: cursor.x - touch.size / 2, top: cursor.y - touch.size / 2 }}
          />
        )}
        {painting && !compare && <span className="badge">Red = removed from the cut-out</span>}
        {compare && <span className="badge">Original</span>}
      </div>

      {painting && touch ? (
        <div className="stage-bar touchbar">
          <div className="segmented" role="group" aria-label="Brush">
            <button type="button" aria-pressed={touch.tool === 'restore'} onClick={() => onTouch({ ...touch, tool: 'restore' })}>
              Bring back
            </button>
            <button type="button" aria-pressed={touch.tool === 'erase'} onClick={() => onTouch({ ...touch, tool: 'erase' })}>
              Remove
            </button>
          </div>
          <label className="brush-size">
            <span>Brush</span>
            <input
              type="range"
              min={8}
              max={140}
              value={touch.size}
              style={{ '--fill': `${((touch.size - 8) / 132) * 100}%` } as React.CSSProperties}
              onChange={(e) => onTouch({ ...touch, size: Number(e.target.value) })}
            />
          </label>
          <div className="stage-actions">
            <button type="button" className="chip" disabled={!canUndo} onClick={onUndo}>
              Undo
            </button>
            <button type="button" className="chip" onClick={onResetMask}>
              Reset
            </button>
            <button type="button" className="chip chip-solid" onClick={() => onTouch(null)}>
              {touchBusy ? 'Updating…' : 'Done'}
            </button>
          </div>
          <span className="hint">Paint over anything that was cut off or left in. Scroll to move, pinch or use Zoom to get closer.</span>
        </div>
      ) : (
        <div className="stage-bar">
          <span className="hint">Drag to reposition · scroll to zoom</span>
          <div className="stage-actions">
            <button
              type="button"
              className="chip"
              disabled={!canTouch}
              title={canTouch ? 'Paint back parts that were cut off, or remove leftovers' : 'Available once the cut-out is ready'}
              onClick={() => onTouch({ tool: 'restore', size: 44 })}
            >
              Fix cut-out
            </button>
            <button type="button" className="chip" aria-pressed={circle} onClick={() => setCircle((v) => !v)}>
              Circle guide
            </button>
            <button
              type="button"
              className="chip"
              aria-pressed={compare}
              onPointerDown={() => setCompare(true)}
              onPointerUp={() => setCompare(false)}
              onPointerLeave={() => setCompare(false)}
              onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && setCompare(true)}
              onKeyUp={() => setCompare(false)}
              onBlur={() => setCompare(false)}
            >
              Hold to compare
            </button>
          </div>
        </div>
      )}

      <div className="context">
        <div className="context-item">
          <canvas ref={(el) => void (miniRefs.current[0] = el)} style={{ width: MINIS[0], height: MINIS[0] }} />
          <div className="lines">
            <i style={{ width: 120 }} />
            <i style={{ width: 84 }} className="dim" />
          </div>
        </div>
        <div className="context-item">
          <canvas ref={(el) => void (miniRefs.current[1] = el)} style={{ width: MINIS[1], height: MINIS[1] }} />
          <div className="lines">
            <i style={{ width: 92 }} />
            <i style={{ width: 150 }} className="dim" />
          </div>
        </div>
        <div className="context-item">
          <canvas ref={(el) => void (miniRefs.current[2] = el)} style={{ width: MINIS[2], height: MINIS[2] }} />
          <div className="lines">
            <i style={{ width: 70 }} />
          </div>
        </div>
      </div>
    </div>
  );
}
