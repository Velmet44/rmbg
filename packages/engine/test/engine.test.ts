import { describe, expect, it } from 'vitest';
import { removeBackground, workingSize, WORKING_LONG_SIDE } from '../src/index.js';
import type { AlphaMask, BBox, ImageRef, SegmentationAdapter } from '../src/types.js';

/** Fake adapter: returns a centered-circle alpha. Never touches a network. */
class FakeAdapter implements SegmentationAdapter {
  readonly modelId = 'fake';
  async init(): Promise<void> {}
  async segment(image: ImageRef): Promise<AlphaMask> {
    const alpha = new Float32Array(image.width * image.height);
    const cx = image.width / 2, cy = image.height / 2, r = Math.min(image.width, image.height) / 4;
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        alpha[y * image.width + x] = Math.hypot(x - cx, y - cy) <= r ? 1 : 0;
      }
    }
    return { width: image.width, height: image.height, alpha };
  }
  async recomputeRegion(_image: ImageRef, mask: AlphaMask, _bbox: BBox): Promise<AlphaMask> {
    return { width: mask.width, height: mask.height, alpha: new Float32Array(mask.alpha) };
  }
  async dispose(): Promise<void> {}
}

function testImage(w: number, h: number): ImageRef {
  const rgb = new Uint8ClampedArray(w * h * 3);
  for (let i = 0; i < w * h; i++) { rgb[i * 3] = i % 256; rgb[i * 3 + 1] = (i * 2) % 256; rgb[i * 3 + 2] = (i * 3) % 256; }
  return { id: 't', width: w, height: h, rgb };
}

describe('engine contract', () => {
  it('removeBackground returns full-resolution masks for large inputs', async () => {
    const mask = await removeBackground(new FakeAdapter(), testImage(2000, 1500));
    expect(mask.width).toBe(2000);
    expect(mask.height).toBe(1500);
    // center kept, corner removed
    expect(mask.alpha[750 * 2000 + 1000]).toBe(1);
    expect(mask.alpha[0]).toBe(0);
  });

  it('never mutates the source RGB', async () => {
    const img = testImage(64, 64);
    const before = new Uint8ClampedArray(img.rgb);
    await removeBackground(new FakeAdapter(), img);
    expect(img.rgb).toEqual(before);
  });

  it('segment is called at working resolution, upsampled back to full res', async () => {
    // The whole point of WORKING_LONG_SIDE: inference is 4x cheaper on the
    // small copy, and the mask is upsampled against the ORIGINAL dimensions.
    const seen: { w: number; h: number }[] = [];
    const spy: SegmentationAdapter = {
      modelId: 'spy',
      async init() {},
      async segment(image) { seen.push({ w: image.width, h: image.height }); return new FakeAdapter().segment(image); },
      async recomputeRegion(i, m) { return new FakeAdapter().recomputeRegion(i, m, { x: 0, y: 0, w: 1, h: 1 }); },
      async dispose() {},
    };
    const mask = await removeBackground(spy, testImage(2000, 1500));
    expect(seen).toHaveLength(1);
    expect(Math.max(seen[0].w, seen[0].h)).toBeLessThanOrEqual(WORKING_LONG_SIDE);
    expect(mask.width).toBe(2000);
  });

  it('leaves a small image at its own resolution (no pointless down/up)', async () => {
    const seen: { w: number; h: number }[] = [];
    const spy: SegmentationAdapter = {
      modelId: 'spy',
      async init() {},
      async segment(image) { seen.push({ w: image.width, h: image.height }); return new FakeAdapter().segment(image); },
      async recomputeRegion(i, m) { return new FakeAdapter().recomputeRegion(i, m, { x: 0, y: 0, w: 1, h: 1 }); },
      async dispose() {},
    };
    const mask = await removeBackground(spy, testImage(320, 240));
    expect(seen[0]).toEqual({ w: 320, h: 240 });
    expect(mask.width).toBe(320);
  });
});

describe('workingSize', () => {
  it('preserves aspect ratio at any size', () => {
    // Guided selection used to floor its working size at 8px per axis, which
    // stretched a 4000x100 image into 256x8 and grew regions against a
    // geometrically wrong picture. The error is now pure integer rounding of
    // the derived axis, so it shrinks as the image gets larger.
    const wide = workingSize(4000, 100);
    expect(wide.w).toBe(512);
    // 12.8 rounds to 13, so 512/13 = 39.4 against a true 40.
    expect(wide.w / wide.h).toBeGreaterThan(38);
    expect(wide.w / wide.h).toBeLessThanOrEqual(40);
    // A large square keeps its ratio to within a pixel.
    const sq = workingSize(4000, 4000);
    expect(Math.abs(sq.w - sq.h)).toBeLessThanOrEqual(1);
  });

  it('caps the long side and never returns a zero dimension', () => {
    for (const [w, h] of [[4000, 3000], [1000, 5000], [513, 1], [1, 1], [20000, 10]] as const) {
      const s = workingSize(w, h);
      expect(Math.max(s.w, s.h)).toBeLessThanOrEqual(WORKING_LONG_SIDE);
      expect(s.w).toBeGreaterThanOrEqual(1);
      expect(s.h).toBeGreaterThanOrEqual(1);
    }
  });

  it('returns the input unchanged when it is already small enough', () => {
    expect(workingSize(64, 48)).toEqual({ w: 64, h: 48 });
    expect(workingSize(512, 512)).toEqual({ w: 512, h: 512 });
  });
});
