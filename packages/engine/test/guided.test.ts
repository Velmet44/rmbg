import { describe, expect, it } from 'vitest';
import { growRegion } from '../src/guided.js';
import type { ImageRef } from '../src/types.js';

function twoTone(): ImageRef {
  // 16x16: white circle-ish 6x6 block centered on black.
  const rgb = new Uint8ClampedArray(16 * 16 * 3);
  for (let y = 5; y < 11; y++) {
    for (let x = 5; x < 11; x++) {
      rgb[(y * 16 + x) * 3] = 255; rgb[(y * 16 + x) * 3 + 1] = 255; rgb[(y * 16 + x) * 3 + 2] = 255;
    }
  }
  return { id: 't', width: 16, height: 16, rgb };
}

describe('growRegion', () => {
  it('fills the clicked uniform area and stops at the boundary', () => {
    const r = growRegion(twoTone(), 8, 8);
    expect(r.box).toEqual({ x: 5, y: 5, w: 6, h: 6 });
    let n = 0;
    for (const v of r.alpha) n += v;
    expect(n).toBe(36);
  });

  it('clicking background grows the background, not the object', () => {
    const r = growRegion(twoTone(), 0, 0);
    expect(r.box.x).toBe(0);
    expect(r.box.y).toBe(0);
    expect(r.alpha[8 * 16 + 8]).toBe(0);
  });

  it('respects the size cap on huge uniform areas', () => {
    const img: ImageRef = { id: 't', width: 64, height: 64, rgb: new Uint8ClampedArray(64 * 64 * 3).fill(128) };
    const r = growRegion(img, 32, 32, 28, 0.1);
    let n = 0;
    for (const v of r.alpha) n += v;
    expect(n).toBeLessThanOrEqual(Math.ceil(64 * 64 * 0.1) + 8);
  });
});
