import { describe, expect, it } from 'vitest';
import { boxDownsampleRGB, createMask, packRGBA, upsampleAlphaBilinear } from '../src/mask.js';

describe('mask', () => {
  it('downsamples a flat field to the same value', () => {
    const src = new Uint8ClampedArray(8 * 8 * 3).fill(200);
    const out = boxDownsampleRGB(src, 8, 8, 4, 4);
    expect(out.length).toBe(4 * 4 * 3);
    for (const v of out) expect(v).toBeCloseTo(200, 5);
  });

  it('downsamples a half-black/half-white row to mid gray', () => {
    const src = new Uint8ClampedArray(4 * 1 * 3);
    for (let x = 0; x < 4; x++) {
      const v = x < 2 ? 0 : 255;
      src[x * 3] = src[x * 3 + 1] = src[x * 3 + 2] = v;
    }
    const out = boxDownsampleRGB(src, 4, 1, 2, 1);
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[3]).toBeCloseTo(255, 5);
  });

  it('packs RGB to opaque RGBA preserving order', () => {
    const out = packRGBA(new Uint8ClampedArray([10, 20, 30, 40, 50, 60]));
    expect(Array.from(out)).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
  });

  it('upsamples then holds corners on a gradient', () => {
    const m = createMask(4, 4, 0);
    for (let i = 0; i < 16; i++) m.alpha[i] = i / 15;
    const up = upsampleAlphaBilinear(m.alpha, 4, 4, 8, 8);
    expect(up.length).toBe(64);
    expect(up[0]).toBeCloseTo(0, 5);
    expect(up[63]).toBeCloseTo(1, 5);
    for (const v of up) {
      expect(v).toBeGreaterThanOrEqual(-1e-6);
      expect(v).toBeLessThanOrEqual(1 + 1e-6);
    }
  });
});
