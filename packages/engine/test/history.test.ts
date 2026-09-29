import { describe, expect, it } from 'vitest';
import { OpLog } from '../src/history.js';
import { createMask } from '../src/mask.js';
import { applyBrushStroke } from '../src/ops.js';

describe('OpLog', () => {
  it('undo/redo round-trips a brush stroke', () => {
    const m = createMask(32, 32, 1);
    const log = new OpLog();
    const stroke = { points: [{ x: 16, y: 16 }], size: 12, softness: 0 };
    log.commitRegion(m, 'erase', (mm) => applyBrushStroke(mm, stroke, 'erase'));
    expect(m.alpha[16 * 32 + 16]).toBe(0);
    expect(log.canUndo).toBe(true);
    expect(log.undo(m)).toBe('erase');
    expect(m.alpha[16 * 32 + 16]).toBe(1);
    expect(log.canRedo).toBe(true);
    expect(log.redo(m)).toBe('erase');
    expect(m.alpha[16 * 32 + 16]).toBe(0);
  });

  it('redo clears on a new commit and outside-region pixels are untouched', () => {
    const m = createMask(32, 32, 1);
    const log = new OpLog();
    const s1 = { points: [{ x: 6, y: 6 }], size: 8, softness: 0 };
    const s2 = { points: [{ x: 25, y: 25 }], size: 8, softness: 0 };
    log.commitRegion(m, 'a', (mm) => applyBrushStroke(mm, s1, 'erase'));
    log.undo(m);
    log.commitRegion(m, 'b', (mm) => applyBrushStroke(mm, s2, 'erase'));
    expect(log.canRedo).toBe(false);
    expect(m.alpha[6 * 32 + 6]).toBe(1); // first stroke undone and never redone
    expect(m.alpha[25 * 32 + 25]).toBe(0);
    expect(m.alpha[0]).toBe(1); // far corner untouched throughout
  });

  it('AI-scale ops fall back to full snapshots', () => {
    const m = createMask(16, 16, 1);
    const log = new OpLog();
    log.commitRegion(m, 'ai', (mm) => {
      mm.alpha.fill(0.25);
      return null;
    });
    expect(m.alpha[0]).toBeCloseTo(0.25);
    log.undo(m);
    expect(m.alpha[0]).toBe(1);
  });
});
