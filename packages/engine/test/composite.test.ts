import { describe, expect, it } from 'vitest';
import { composite } from '../src/composite.js';
import type { AlphaMask, Background, Effects, ImageRef } from '../src/types.js';

const effectsOff: Effects = {
  shadow: { on: false, opacity: 0.4, blur: 8, dx: 0, dy: 8 },
  feather: 0,
  defringe: 0,
};

function img2x2(rgb: [number, number, number][]): ImageRef {
  const rgbArr = new Uint8ClampedArray(12);
  rgb.forEach((p, i) => { rgbArr[i * 3] = p[0]; rgbArr[i * 3 + 1] = p[1]; rgbArr[i * 3 + 2] = p[2]; });
  return { id: 't', width: 2, height: 2, rgb: rgbArr };
}

function mask2x2(a: number[]): AlphaMask {
  return { width: 2, height: 2, alpha: new Float32Array(a) };
}

describe('composite', () => {
  it('transparent passthrough keeps RGB and writes alpha', () => {
    const img = img2x2([[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]]);
    const bg: Background = { kind: 'transparent' };
    const out = composite(img, mask2x2([1, 0.5, 0, 1]), bg, effectsOff);
    expect(out.rgba[3]).toBe(255);
    expect(out.rgba[7]).toBe(128); // 0.5 * 255, Uint8ClampedArray rounds
    expect(out.rgba[11]).toBe(0);
    expect(out.rgba[0]).toBe(255); // red preserved
  });

  it('solid color flattens half-alpha correctly', () => {
    const img = img2x2([[255, 0, 0], [255, 0, 0], [255, 0, 0], [255, 0, 0]]);
    const bg: Background = { kind: 'color', color: [255, 255, 255] };
    const out = composite(img, mask2x2([0.5, 0.5, 0.5, 0.5]), bg, effectsOff);
    expect(out.rgba[0]).toBeCloseTo(255, 0); // red channel stays max
    expect(out.rgba[1]).toBe(128); // white * 0.5, Uint8ClampedArray rounds
    expect(out.rgba[3]).toBe(255); // opaque over solid bg
  });

  it('shadow darkens only translucent surroundings', () => {
    const img = img2x2([[200, 200, 200], [200, 200, 200], [200, 200, 200], [200, 200, 200]]);
    const bg: Background = { kind: 'color', color: [255, 255, 255] };
    const fx: Effects = { ...effectsOff, shadow: { on: true, opacity: 0.5, blur: 0, dx: 1, dy: 0 } };
    const out = composite(img, mask2x2([1, 0, 0, 0]), bg, fx);
    // pixel 1 receives shadow cast from pixel 0 (dx=1)
    expect(out.rgba[4]).toBeLessThan(255);
    expect(out.rgba[0]).toBe(200); // opaque subject pixel unaffected
  });

  it('rejects size mismatches', () => {
    const img = img2x2([[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]);
    expect(() => composite(img, { width: 3, height: 3, alpha: new Float32Array(9) }, { kind: 'transparent' }, effectsOff))
      .toThrow(/sizes differ/);
  });
});
