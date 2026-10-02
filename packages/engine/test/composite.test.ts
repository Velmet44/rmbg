import { describe, expect, it } from 'vitest';
import { composite, compositeOverlay, OVERLAY_TINT } from '../src/composite.js';
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

describe('compositeOverlay', () => {
  const grey = () => img2x2([[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]);

  it('leaves kept pixels untouched and veils removed pixels', () => {
    const out = compositeOverlay(grey(), mask2x2([1, 0, 1, 0]), { veil: 1 });
    // alpha 1 → original
    expect(out.rgba[0]).toBe(0);
    // alpha 0 → pure tint
    expect(out.rgba[4]).toBe(OVERLAY_TINT[0]);
    expect(out.rgba[5]).toBe(OVERLAY_TINT[1]);
    expect(out.rgba[6]).toBe(OVERLAY_TINT[2]);
  });

  it('blends continuously across partial alpha', () => {
    // Hair and semi-transparent edges are the reason this view exists: a hard
    // threshold would hide exactly the pixels the user needs to judge.
    const out = compositeOverlay(grey(), mask2x2([1, 0.5, 0, 1]), { veil: 1 });
    // Pixel order matches the mask: p0 a=1, p1 a=0.5, p2 a=0, p3 a=1.
    // Read the RED channel of each: rgba[i*4].
    const none = out.rgba[0];  // a=1   → original (0)
    const half = out.rgba[4];  // a=0.5 → half the tint
    const full = out.rgba[8];  // a=0   → full tint
    expect(none).toBe(0);
    expect(half).toBeGreaterThan(none);
    expect(half).toBeLessThan(full);
    expect(half).toBeCloseTo(full / 2, 0);
  });

  it('is always opaque — it is an inspection view, never an export', () => {
    const out = compositeOverlay(grey(), mask2x2([1, 0, 0.25, 1]), { veil: 0 });
    for (let i = 3; i < 16; i += 4) expect(out.rgba[i]).toBe(255);
  });

  it('defaults to a partial veil and clamps out-of-range options', () => {
    const out = compositeOverlay(grey(), mask2x2([0, 0, 0, 0]));
    expect(out.rgba[0]).toBeGreaterThan(OVERLAY_TINT[0] * 0.3);
    expect(out.rgba[0]).toBeLessThan(OVERLAY_TINT[0]);
    const noVeil = compositeOverlay(grey(), mask2x2([0, 0, 0, 0]), { veil: 0 });
    expect(noVeil.rgba[0]).toBe(0);
    const over = compositeOverlay(grey(), mask2x2([0, 0, 0, 0]), { veil: 9 });
    expect(over.rgba[0]).toBe(OVERLAY_TINT[0]); // clamped, no overflow wrap
  });

  it('accepts a custom tint', () => {
    const out = compositeOverlay(grey(), mask2x2([0, 0, 0, 0]), { veil: 1, tint: [0, 0, 255] });
    expect(out.rgba[6]).toBe(255);
    expect(out.rgba[0]).toBe(0);
  });

  it('rejects size mismatches and never mutates its inputs', () => {
    const img = grey();
    const mask = mask2x2([1, 0, 1, 0]);
    const rgbBefore = Float32Array.from(img.rgb);
    const alphaBefore = Float32Array.from(mask.alpha);
    compositeOverlay(img, mask);
    expect(Array.from(img.rgb)).toEqual(Array.from(rgbBefore));
    expect(Array.from(mask.alpha)).toEqual(Array.from(alphaBefore));
    expect(() => compositeOverlay(img, { width: 3, height: 3, alpha: new Float32Array(9) }))
      .toThrow(/sizes differ/);
  });
});
