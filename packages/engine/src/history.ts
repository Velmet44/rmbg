import type { AlphaMask, BBox, BrushStroke } from './types.js';
import { clampBox } from './mask.js';
import { applyBrushStroke, restoreRegion, snapshotRegion } from './ops.js';

/**
 * Operation-based history. Entries are closures, so mask patches and
 * parameter snapshots interleave in ONE timeline (AI ops, brush strokes,
 * effect/background/transform changes all undo together, in order).
 */
export interface LogEntry {
  label: string;
  undo(): void;
  redo(): void;
}

export class OpLog {
  private undoStack: LogEntry[] = [];
  private redoStack: LogEntry[] = [];
  constructor(private maxDepth = 40) {}

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  get depth(): number { return this.undoStack.length; }

  /** Generic entry (parameter snapshots, etc.). */
  commit(label: string, undo: () => void, redo: () => void): void {
    this.push({ label, undo, redo });
  }

  /** Replace the held mask as a single undo step.
   *
   *  `holder` is any `{ mask: AlphaMask | null }` — the app's state object
   *  satisfies it directly, so there is no adapter layer.
   *
   *  This exists because committing a replacement mask the naive way
   *  (`commitRegion(newMask, label, () => null)`) snapshots the NEW mask as its
   *  own pre-image: undo then reports success, changes nothing on screen, and
   *  still consumes a slot. Capturing `holder.mask` BEFORE the swap is the whole
   *  point, so undo restores a genuinely different previous result. */
  replaceMask(
    holder: { mask: AlphaMask | null }, label: string, next: AlphaMask,
    onChange?: () => void,
  ): void {
    const prev = holder.mask;
    holder.mask = next;
    this.push({
      label,
      undo: () => { holder.mask = prev; onChange?.(); },
      redo: () => { holder.mask = next; onChange?.(); },
    });
  }

  /** Paint one brush stroke into the mask as a single undo step. Strokes with
   *  no points are ignored rather than recorded as a no-op entry. */
  applyBrush(
    mask: AlphaMask, stroke: BrushStroke, mode: 'erase' | 'restore', label: string = mode,
  ): void {
    if (stroke.points.length === 0) return;
    this.commitRegion(mask, label, (m) => applyBrushStroke(m, stroke, mode));
  }

  /** Run `mut` against the mask and record the changed region for undo. */
  commitRegion(mask: AlphaMask, label: string, mut: (m: AlphaMask) => BBox | null): void {
    // Snapshot lazily: run mutation on a clone-diff via full pre-copy of affected area is
    // impossible before knowing the box, so capture a full pre-copy only for AI-scale ops
    // flagged by a null box. Brush ops return their bbox.
    const preFull = new Float32Array(mask.alpha);
    const box = mut(mask);
    if (box === null || box.w * box.h > mask.width * mask.height * 0.5) {
      const postFull = new Float32Array(mask.alpha);
      const refW = mask.width, refH = mask.height;
      this.push({
        label,
        undo: () => { this.assertSize(mask, refW, refH); mask.alpha.set(preFull); },
        redo: () => { this.assertSize(mask, refW, refH); mask.alpha.set(postFull); },
      });
      return;
    }
    const b = clampBox(box, mask.width, mask.height);
    const after = snapshotRegion(mask, b);
    const before = { box: b, data: this.regionOf(preFull, mask.width, b) };
    this.push({
      label,
      undo: () => restoreRegion(mask, before.box, before.data),
      redo: () => restoreRegion(mask, after.box, after.data),
    });
  }

  undo(): string | null {
    const e = this.undoStack.pop();
    if (!e) return null;
    e.undo();
    this.redoStack.push(e);
    return e.label;
  }

  redo(): string | null {
    const e = this.redoStack.pop();
    if (!e) return null;
    e.redo();
    this.undoStack.push(e);
    return e.label;
  }

  private push(e: LogEntry): void {
    this.undoStack.push(e);
    if (this.undoStack.length > this.maxDepth) this.undoStack.shift();
    this.redoStack = [];
  }

  private regionOf(full: Float32Array, w: number, b: BBox): Float32Array {
    const data = new Float32Array(b.w * b.h);
    for (let y = 0; y < b.h; y++) {
      for (let x = 0; x < b.w; x++) data[y * b.w + x] = full[(b.y + y) * w + (b.x + x)];
    }
    return data;
  }

  private assertSize(m: AlphaMask, w: number, h: number): void {
    if (m.width !== w || m.height !== h) {
      throw new Error(`OpLog: mask size changed (${m.width}x${m.height} vs ${w}x${h})`);
    }
  }
}
