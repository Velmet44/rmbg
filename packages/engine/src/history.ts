import type { AlphaMask, BBox } from './types.js';
import { clampBox } from './mask.js';
import { restoreRegion, snapshotRegion } from './ops.js';

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
