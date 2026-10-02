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

  it('throws on a short rgb buffer instead of growing the whole image', () => {
    // An out-of-range read yields undefined; undefined - number is NaN and
    // NaN > t2 is FALSE, so the similarity test used to ACCEPT every pixel —
    // a truncated buffer returned the entire image, which the app then applies
    // as an erase.
    const short: ImageRef = { id: 't', width: 4, height: 4, rgb: new Uint8ClampedArray(10) };
    expect(() => growRegion(short, 1, 1)).toThrow(/rgb/);
  });

  it('grows through a diagonal link (8-connectivity)', () => {
    // Two areas touching only at a corner. 4-connectivity would stop after
    // one pixel and leave a staircased island.
    const rgb = new Uint8ClampedArray(8 * 8 * 3).fill(255);
    for (let i = 0; i < 8 * 8 * 3; i += 3) { rgb[i] = 0; rgb[i + 1] = 0; rgb[i + 2] = 0; }
    const set = (x: number, y: number) => {
      const o = (y * 8 + x) * 3; rgb[o] = 255; rgb[o + 1] = 255; rgb[o + 2] = 255;
    };
    set(1, 1); set(2, 2); // diagonal neighbours only
    const r = growRegion({ id: 't', width: 8, height: 8, rgb }, 1, 1);
    expect(r.alpha[1 * 8 + 1]).toBe(1);
    expect(r.alpha[2 * 8 + 2]).toBe(1);
  });

  it('flags truncation so a cap-stopped sliver is not mistaken for a region', () => {
    const r = growRegion(twoTone(), 8, 8, 28, 0.01);
    expect(r.truncated).toBe(true);
  });

  it('a complete grow reports truncated=false', () => {
    expect(growRegion(twoTone(), 8, 8).truncated).toBe(false);
  });

  it('respects the size cap on huge uniform areas', () => {
    const img: ImageRef = { id: 't', width: 64, height: 64, rgb: new Uint8ClampedArray(64 * 64 * 3).fill(128) };
    const r = growRegion(img, 32, 32, 28, 0.1);
    let n = 0;
    for (const v of r.alpha) n += v;
    expect(n).toBeLessThanOrEqual(Math.ceil(64 * 64 * 0.1) + 8);
  });
});
