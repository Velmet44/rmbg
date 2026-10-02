import type { AlphaMask, BBox, BrushStroke } from './types.js';
import { clampBox } from './mask.js';
import { applyBrushStroke, restoreRegion, snapshotRegion } from './ops.js';
import { dbg } from './log.js';

/**
 * Operation-based history. Entries are closures, so mask patches and
 * parameter snapshots interleave in ONE timeline (AI ops, brush strokes,
 * effect/background/transform changes all undo together, in order).
 */
export interface LogEntry {
  label: string;
  undo(): void;
  redo(): void;
  /** Approximate bytes this entry retains for its snapshots, so the stack can
   *  be bounded by MEMORY as well as by depth. Cheap param-only entries pass 0. */
  bytes?: number;
}

/** Retained-bytes ceiling for the undo stack. Each full-res mask snapshot is
 *  w*h*4 bytes, so an entry-count-only cap retains gigabytes on a large image
 *  (40 snapshots at 4000x3000 is ~3.6 GB) and long sessions OOM the tab. */
const HISTORY_BYTE_BUDGET = 256 * 1024 * 1024;
/** Never evict down past this many entries, whatever the byte budget says. */
const MIN_DEPTH = 3;

export class OpLog {
  private undoStack: LogEntry[] = [];
  private redoStack: LogEntry[] = [];
  private redoBytes = 0;
  /** Approximate retained bytes per stack slot. Entries carry closures over
   *  snapshot arrays, so this is accounted for by the caller that knows them. */
  private undoBytes = 0;
  constructor(private maxDepth = 40, private byteBudget = HISTORY_BYTE_BUDGET) {}

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  get depth(): number { return this.undoStack.length; }
  /** Approximate bytes retained by undo + redo snapshots. */
  get retainedBytes(): number { return this.undoBytes + this.redoBytes; }

  /** Generic entry (parameter snapshots, etc.). */
  commit(label: string, undo: () => void, redo: () => void): void {
    dbg('history', `commit "${label}"`);
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
    dbg('history', `replaceMask "${label}" · previous ${prev ? `${prev.width}×${prev.height}` : 'none'} → ${next.width}×${next.height}`);
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
    if (stroke.points.length === 0) {
      dbg('history', 'applyBrush skipped — stroke had no points');
      return;
    }
    dbg('history', `applyBrush ${mode} · ${stroke.points.length} point(s) · size=${stroke.size} softness=${stroke.softness}`);
    this.commitRegion(mask, label, (m) => applyBrushStroke(m, stroke, mode));
  }

  /** Run `mut` against the mask and record the changed region for undo. */
  commitRegion(mask: AlphaMask, label: string, mut: (m: AlphaMask) => BBox | null): void {
    dbg('history', `commitRegion "${label}" on ${mask.width}×${mask.height}`);
    // Snapshot lazily: run mutation on a clone-diff via full pre-copy of affected area is
    // impossible before knowing the box, so capture a full pre-copy only for AI-scale ops
    // flagged by a null box. Brush ops return their bbox.
    // preFull is needed to capture the pre-image of the region BEFORE `mut` runs,
    // and the box is not known until after. That costs one full-frame Float32
    // copy per call — pure GC pressure on the region path, where only the box
    // is retained afterwards. Unavoidable without splitting the mutator into a
    // dry-run phase, which would change every call site for no correctness gain.
    const preFull = new Float32Array(mask.alpha);
    const box = mut(mask);
    if (box === null || box.w * box.h > mask.width * mask.height * 0.5) {
      const postFull = new Float32Array(mask.alpha);
      const refW = mask.width, refH = mask.height;
      this.push({
        label,
        undo: () => { this.assertSame(mask, refW, refH); mask.alpha.set(preFull); },
        redo: () => { this.assertSame(mask, refW, refH); mask.alpha.set(postFull); },
        bytes: preFull.byteLength + postFull.byteLength,
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
      bytes: before.data.byteLength + after.data.byteLength,
    });
  }

  undo(): string | null {
    const e = this.undoStack.pop();
    if (!e) return null;
    e.undo();
    this.redoStack.push(e);
    this.redoBytes += e.bytes ?? 0;
    this.undoBytes -= e.bytes ?? 0;
    dbg('history', `undo "${e.label}" · depth=${this.undoStack.length} redo=${this.redoStack.length} retained≈${(this.retainedBytes / 1048576).toFixed(1)}MB`);
    return e.label;
  }

  redo(): string | null {
    const e = this.redoStack.pop();
    if (!e) return null;
    e.redo();
    this.undoStack.push(e);
    this.redoBytes -= e.bytes ?? 0;
    this.undoBytes += e.bytes ?? 0;
    dbg('history', `redo "${e.label}" · depth=${this.undoStack.length} redo=${this.redoStack.length} retained≈${(this.retainedBytes / 1048576).toFixed(1)}MB`);
    return e.label;
  }

  private push(e: LogEntry): void {
    this.undoStack.push(e);
    this.undoBytes += e.bytes ?? 0;
    // Evict oldest-first until BOTH limits hold. Keep a floor of a few entries
    // so a single huge image can never make undo unusable outright.
    while (
      (this.undoStack.length > this.maxDepth || this.undoBytes > this.byteBudget)
      && this.undoStack.length > MIN_DEPTH
    ) {
      const dropped = this.undoStack.shift();
      this.undoBytes -= dropped?.bytes ?? 0;
      if (dropped) {
        dbg('history', `evicted "${dropped.label}" · depth=${this.undoStack.length} retained≈${(this.undoBytes / 1048576).toFixed(1)}MB`);
      }
    }
    this.redoStack = [];
    this.redoBytes = 0;
  }

  private regionOf(full: Float32Array, w: number, b: BBox): Float32Array {
    const data = new Float32Array(b.w * b.h);
    for (let y = 0; y < b.h; y++) {
      for (let x = 0; x < b.w; x++) data[y * b.w + x] = full[(b.y + y) * w + (b.x + x)];
    }
    return data;
  }

  /** Guard the assumption every region/full snapshot rests on: undo is writing
   *  back into the SAME mask object at the SAME size.
   *
   *  A size check alone cannot catch the dangerous case, which is a *different
   *  mask object of identical dimensions* (what `replaceMask` produces). Then
   *  undo writes into an orphaned mask, the label still reports success, and
   *  nothing on screen changes. Callers that swap the canonical mask must
   *  therefore route those swaps through `replaceMask`, which owns holder
   *  identity itself. */
  private assertSame(m: AlphaMask, w: number, h: number): void {
    if (m.width !== w || m.height !== h) {
      throw new Error(`OpLog: mask size changed (${m.width}x${m.height} vs ${w}x${h})`);
    }
    if (m.alpha.length !== w * h) {
      throw new Error(`OpLog: mask alpha length ${m.alpha.length} does not match ${w}x${h}`);
    }
  }
}
