import type { AlphaMask, BBox } from './types.js';
import { clampBox } from './mask.js';
import { restoreRegion, snapshotRegion } from './ops.js';

/**
 * Operation-based history over the mask. Each entry stores only the
 * changed region (before/after), never full-image snapshots per stroke.
 * Full-mask entries are used only for AI ops and are depth-bounded.
 */
interface Entry {
  label: string;
  undo(m: AlphaMask): void;
  redo(m: AlphaMask): void;
}

export class OpLog {
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  constructor(private maxDepth = 40) {}

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  get depth(): number { return this.undoStack.length; }

  /** Run `mut` against the mask and record the changed region for undo. */
  commitRegion(mask: AlphaMask, label: string, mut: (m: AlphaMask) => BBox | null): void {
    // Snapshot lazily: run mutation on a clone-diff via full pre-copy of affected area is
    // impossible before knowing the box, so capture a full pre-copy only for AI-scale ops
    // flagged by a null box. Brush ops return their bbox.
    const preFull = new Float32Array(mask.alpha);
    const box = mut(mask);
    if (box === null || box.w * box.h > mask.width * mask.height * 0.5) {
      const postFull = new Float32Array(mask.alpha);
      this.push({
        label,
        undo: (m) => { this.assertSize(m, mask); m.alpha.set(preFull); },
        redo: (m) => { this.assertSize(m, mask); m.alpha.set(postFull); },
      });
      return;
    }
    const b = clampBox(box, mask.width, mask.height);
    const after = snapshotRegion(mask, b);
    const before = { box: b, data: this.regionOf(preFull, mask.width, b) };
    this.push({
      label,
      undo: (m) => restoreRegion(m, before.box, before.data),
      redo: (m) => restoreRegion(m, after.box, after.data),
    });
  }

  undo(mask: AlphaMask): string | null {
    const e = this.undoStack.pop();
    if (!e) return null;
    e.undo(mask);
    this.redoStack.push(e);
    return e.label;
  }

  redo(mask: AlphaMask): string | null {
    const e = this.redoStack.pop();
    if (!e) return null;
    e.redo(mask);
    this.undoStack.push(e);
    return e.label;
  }

  private push(e: Entry): void {
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

  private assertSize(m: AlphaMask, ref: AlphaMask): void {
    if (m.width !== ref.width || m.height !== ref.height) {
      throw new Error(`OpLog: mask size changed (${m.width}x${m.height} vs ${ref.width}x${ref.height})`);
    }
  }
}
