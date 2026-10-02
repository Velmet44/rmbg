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
    expect(log.undo()).toBe('erase');
    expect(m.alpha[16 * 32 + 16]).toBe(1);
    expect(log.canRedo).toBe(true);
    expect(log.redo()).toBe('erase');
    expect(m.alpha[16 * 32 + 16]).toBe(0);
  });

  it('redo clears on a new commit and outside-region pixels are untouched', () => {
    const m = createMask(32, 32, 1);
    const log = new OpLog();
    const s1 = { points: [{ x: 6, y: 6 }], size: 8, softness: 0 };
    const s2 = { points: [{ x: 25, y: 25 }], size: 8, softness: 0 };
    log.commitRegion(m, 'a', (mm) => applyBrushStroke(mm, s1, 'erase'));
    log.undo();
    log.commitRegion(m, 'b', (mm) => applyBrushStroke(mm, s2, 'erase'));
    expect(log.canRedo).toBe(false);
    expect(m.alpha[6 * 32 + 6]).toBe(1); // first stroke undone and never redone
    expect(m.alpha[25 * 32 + 25]).toBe(0);
    expect(m.alpha[0]).toBe(1); // far corner untouched throughout
  });

  it('interleaves mask and parameter ops in one timeline', () => {
    const m = createMask(16, 16, 1);
    const log = new OpLog();
    const fx = { feather: 0 };
    log.commitRegion(m, 'ai', (mm) => {
      mm.alpha.fill(0.5);
      return null;
    });
    log.commit('feather=3', () => { fx.feather = 0; }, () => { fx.feather = 3; });
    fx.feather = 3;
    expect(log.undo()).toBe('feather=3');
    expect(fx.feather).toBe(0);
    expect(log.undo()).toBe('ai');
    expect(m.alpha[0]).toBe(1);
    expect(log.redo()).toBe('ai');
    expect(m.alpha[0]).toBeCloseTo(0.5);
    expect(log.redo()).toBe('feather=3');
    expect(fx.feather).toBe(3);
  });

  it('AI-scale ops fall back to full snapshots', () => {
    const m = createMask(16, 16, 1);
    const log = new OpLog();
    log.commitRegion(m, 'ai', (mm) => {
      mm.alpha.fill(0.25);
      return null;
    });
    expect(m.alpha[0]).toBeCloseTo(0.25);
    log.undo();
    expect(m.alpha[0]).toBe(1);
  });

  describe('applyBrush', () => {
    it('paints and records one undoable step', () => {
      const m = createMask(32, 32, 1);
      const log = new OpLog();
      log.applyBrush(m, { points: [{ x: 16, y: 16 }], size: 12, softness: 0 }, 'erase');
      expect(m.alpha[16 * 32 + 16]).toBe(0);
      expect(log.depth).toBe(1);
      expect(log.undo()).toBe('erase');
      expect(m.alpha[16 * 32 + 16]).toBe(1);
      expect(log.redo()).toBe('erase');
      expect(m.alpha[16 * 32 + 16]).toBe(0);
    });

    it('uses the caller label and defaults to the mode', () => {
      const m = createMask(32, 32, 1);
      const log = new OpLog();
      log.applyBrush(m, { points: [{ x: 4, y: 4 }], size: 8, softness: 0 }, 'restore', 'restore brush');
      expect(log.undo()).toBe('restore brush');
      log.applyBrush(m, { points: [{ x: 8, y: 8 }], size: 8, softness: 0 }, 'erase');
      expect(log.undo()).toBe('erase');
    });

    it('records nothing for an empty stroke', () => {
      // A no-op entry would consume an undo slot and toasts "Undone: erase"
      // while changing nothing on screen.
      const m = createMask(16, 16, 1);
      const log = new OpLog();
      log.applyBrush(m, { points: [], size: 12, softness: 0 }, 'erase');
      expect(log.canUndo).toBe(false);
      expect(log.depth).toBe(0);
      expect(m.alpha[0]).toBe(1);
    });
  });
});
