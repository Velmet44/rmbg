import { describe, expect, it } from 'vitest';
import { createMask } from '../src/mask.js';
import {
  IDENTITY_TRANSFORM, invertTransformPoint, isIdentityTransform, transformSubject,
} from '../src/transform.js';
import type { ImageRef } from '../src/types.js';

function tiny(): { img: ImageRef; msk: { width: number; height: number; alpha: Float32Array } } {
  // 4x4: bright 2x2 block top-left on black.
  const rgb = new Uint8ClampedArray(4 * 4 * 3);
  const alpha = new Float32Array(16);
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 2; x++) {
      rgb[(y * 4 + x) * 3] = 255; rgb[(y * 4 + x) * 3 + 1] = 255; rgb[(y * 4 + x) * 3 + 2] = 255;
      alpha[y * 4 + x] = 1;
    }
  }
  return { img: { id: 't', width: 4, height: 4, rgb }, msk: { width: 4, height: 4, alpha } };
}

describe('transform', () => {
  it('identity is a byte-exact round trip', () => {
    const { img, msk } = tiny();
    expect(isIdentityTransform(IDENTITY_TRANSFORM)).toBe(true);
    const out = transformSubject(img, msk, IDENTITY_TRANSFORM);
    expect(out.image.rgb).toEqual(img.rgb);
    expect(out.mask.alpha).toEqual(msk.alpha);
  });

  it('translation shifts content', () => {
    const { img, msk } = tiny();
    const out = transformSubject(img, msk, { scale: 1, rotation: 0, dx: 2, dy: 2 });
    // Block was top-left; shifted right-down by 2, pixel (0,0) is now empty.
    expect(out.mask.alpha[0]).toBe(0);
    expect(out.mask.alpha[2 * 4 + 2]).toBeGreaterThan(0.99);
    expect(out.image.rgb[0]).toBe(0);
  });

  it('inverse mapping round-trips points', () => {
    const t = { scale: 1.5, rotation: 30, dx: 7, dy: -4 };
    expect(isIdentityTransform(t)).toBe(false);
    for (const [x, y] of [[0, 0], [10, 3], [99, 140], [512, 512]] as const) {
      const out = transformSubject(
        { id: 't', width: 200, height: 200, rgb: new Uint8ClampedArray(200 * 200 * 3) },
        createMask(200, 200, 0),
        t,
      );
      void out;
      const back = invertTransformPoint(t, 200, 200, ...(forward(t, 200, 200, x, y) as [number, number]));
      expect(back.x).toBeCloseTo(x, 6);
      expect(back.y).toBeCloseTo(y, 6);
    }
  });

  it('rejects size mismatches', () => {
    const { img } = tiny();
    expect(() => transformSubject(img, createMask(3, 3), IDENTITY_TRANSFORM)).toThrow(/sizes differ/);
  });
});

// Mirror of the forward map (test-only) to validate the inverse.
function forward(t: { scale: number; rotation: number; dx: number; dy: number }, w: number, h: number, x: number, y: number): [number, number] {
  const rad = (t.rotation * Math.PI) / 180;
  const cx = w / 2, cy = h / 2;
  const c = Math.cos(rad) * t.scale, s = Math.sin(rad) * t.scale;
  const ox = x - cx, oy = y - cy;
  return [c * ox - s * oy + cx + t.dx, s * ox + c * oy + cy + t.dy];
}
