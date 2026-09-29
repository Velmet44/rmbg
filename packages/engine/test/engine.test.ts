import { describe, expect, it } from 'vitest';
import { createEngine } from '../src/index.js';
import type { AlphaMask, ImageRef, SegmentationAdapter, SegmentOpts } from '../src/types.js';

/** Fake adapter: returns a centered-circle alpha. Never touches a network. */
class FakeAdapter implements SegmentationAdapter {
  readonly modelId = 'fake';
  async init(): Promise<void> {}
  async segment(image: ImageRef, _opts: SegmentOpts): Promise<AlphaMask> {
    const alpha = new Float32Array(image.width * image.height);
    const cx = image.width / 2, cy = image.height / 2, r = Math.min(image.width, image.height) / 4;
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        alpha[y * image.width + x] = Math.hypot(x - cx, y - cy) <= r ? 1 : 0;
      }
    }
    return { width: image.width, height: image.height, alpha };
  }
  async recomputeRegion(_image: ImageRef, mask: AlphaMask): Promise<AlphaMask> {
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
    const engine = createEngine(new FakeAdapter());
    const mask = await engine.removeBackground(testImage(2000, 1500));
    expect(mask.width).toBe(2000);
    expect(mask.height).toBe(1500);
    // center kept, corner removed
    expect(mask.alpha[750 * 2000 + 1000]).toBe(1);
    expect(mask.alpha[0]).toBe(0);
  });

  it('never mutates the source RGB', async () => {
    const engine = createEngine(new FakeAdapter());
    const img = testImage(64, 64);
    const before = new Uint8ClampedArray(img.rgb);
    await engine.removeBackground(img);
    expect(img.rgb).toEqual(before);
  });
});
