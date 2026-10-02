import { describe, expect, it } from 'vitest';
import { createMask } from '../src/mask.js';
import { applyBrushStroke, contractInPlace, featherInPlace, refineEdges } from '../src/ops.js';

describe('brush ops', () => {
  it('erase drives the center to 0, restore brings it back', () => {
    const m = createMask(32, 32, 1);
    const stroke = { points: [{ x: 16, y: 16 }], size: 12, softness: 0 };
    const box = applyBrushStroke(m, stroke, 'erase');
    expect(box.w).toBeGreaterThan(0);
    expect(m.alpha[16 * 32 + 16]).toBe(0);
    applyBrushStroke(m, stroke, 'restore');
    expect(m.alpha[16 * 32 + 16]).toBe(1);
  });

  it('softness produces a partial edge', () => {
    const m = createMask(32, 32, 1);
    applyBrushStroke(m, { points: [{ x: 16, y: 16 }], size: 12, softness: 1 }, 'erase');
    expect(m.alpha[16 * 32 + 16]).toBe(0); // exact center fully applied
    const edge = m.alpha[16 * 32 + 20]; // 4px out of r=6 -> k=1/3
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(1);
  });

  it('interpolates across fast moves without gaps', () => {
    const m = createMask(64, 64, 1);
    applyBrushStroke(m, { points: [{ x: 4, y: 32 }, { x: 60, y: 32 }], size: 10, softness: 0 }, 'erase');
    expect(m.alpha[32 * 64 + 32]).toBe(0);
    expect(m.alpha[32 * 64 + 4]).toBe(0);
    expect(m.alpha[32 * 64 + 60]).toBe(0);
  });

  it('feather blurs a hard edge, contract shrinks foreground', () => {
    const m = createMask(20, 20, 0);
    for (let y = 0; y < 20; y++) for (let x = 10; x < 20; x++) m.alpha[y * 20 + x] = 1;
    featherInPlace(m, 2);
    const edge = m.alpha[10 * 20 + 10];
    expect(edge).toBeGreaterThan(0.2);
    expect(edge).toBeLessThan(0.8);
    contractInPlace(m, 3);
    expect(m.alpha[10 * 20 + 10]).toBeLessThan(edge);
  });

  it('refineEdges is a no-op at zero and mutates in place otherwise', () => {
    const build = () => {
      const m = createMask(20, 20, 0);
      for (let y = 0; y < 20; y++) for (let x = 10; x < 20; x++) m.alpha[y * 20 + x] = 1;
      return m;
    };
    const untouched = build();
    const snapshot = Float32Array.from(untouched.alpha);
    refineEdges(untouched, { feather: 0, defringe: 0 });
    expect(Array.from(untouched.alpha)).toEqual(Array.from(snapshot));

    const m = build();
    refineEdges(m, { feather: 2, defringe: 3 });
    // Same object mutated in place — callers rely on getting their copy back.
    expect(m.alpha[10 * 20 + 10]).toBeLessThan(1);
    expect(m.alpha[10 * 20 + 12]).toBeLessThan(1);
  });

  it('refineEdges contracts before it feathers', () => {
    // Order matters: feathering first would soften the fringe and then
    // contract would pull the already-spread edge back in, netting a different
    // (wider, softer) result than the intended "pull in, then soften".
    const build = () => {
      const m = createMask(24, 24, 0);
      for (let y = 4; y < 20; y++) for (let x = 4; x < 20; x++) m.alpha[y * 24 + x] = 1;
      return m;
    };
    const fx = { feather: 2, defringe: 2 };
    const combined = build();
    refineEdges(combined, fx);

    const manual = build();
    contractInPlace(manual, fx.defringe);
    featherInPlace(manual, fx.feather);

    expect(Array.from(combined.alpha)).toEqual(Array.from(manual.alpha));
  });
});
