import type { AlphaMask, ImageRef } from './types.js';

export interface SubjectTransform {
  /** Uniform scale about the image center. 1 = identity. */
  scale: number;
  /** Clockwise rotation in degrees about the image center. */
  rotation: number;
  /** Translation in output pixels. */
  dx: number;
  dy: number;
}

export const IDENTITY_TRANSFORM: SubjectTransform = { scale: 1, rotation: 0, dx: 0, dy: 0 };

export function isIdentityTransform(t: SubjectTransform): boolean {
  return t.scale === 1 && t.rotation === 0 && t.dx === 0 && t.dy === 0;
}

export interface Transformed {
  image: ImageRef;
  mask: AlphaMask;
}

/**
 * Warp image + mask by an affine subject transform (scale/rotate/translate
 * about the center), same-size output, bilinear sampling, transparent
 * outside. Pure function — the canonical pixels are never touched; the
 * caller composites the result over the background.
 */
export function transformSubject(image: ImageRef, mask: AlphaMask, t: SubjectTransform): Transformed {
  const { width: w, height: h } = image;
  if (image.width !== mask.width || image.height !== mask.height) {
    throw new Error('transformSubject: image and mask sizes differ');
  }
  const rad = (t.rotation * Math.PI) / 180;
  const cos = Math.cos(rad) / Math.max(1e-9, t.scale);
  const sin = Math.sin(rad) / Math.max(1e-9, t.scale);
  const cx = w / 2, cy = h / 2;
  const rgb = new Uint8ClampedArray(w * h * 3);
  const alpha = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Inverse map: output -> source (clockwise rotation inverts by transpose).
      const ox = x - cx - t.dx, oy = y - cy - t.dy;
      const sx = cos * ox + sin * oy + cx;
      const sy = -sin * ox + cos * oy + cy;
      const i = y * w + x;
      if (sx < 0 || sy < 0 || sx > w - 1 || sy > h - 1) continue;
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
      const tx = sx - x0, ty = sy - y0;
      const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
      const s00 = (y0 * w + x0) * 3, s10 = (y0 * w + x1) * 3;
      const s01 = (y1 * w + x0) * 3, s11 = (y1 * w + x1) * 3;
      const o = i * 3;
      rgb[o] = image.rgb[s00] * w00 + image.rgb[s10] * w10 + image.rgb[s01] * w01 + image.rgb[s11] * w11;
      rgb[o + 1] = image.rgb[s00 + 1] * w00 + image.rgb[s10 + 1] * w10 + image.rgb[s01] * w01 + image.rgb[s11] * w11;
      rgb[o + 2] = image.rgb[s00 + 2] * w00 + image.rgb[s10 + 2] * w10 + image.rgb[s01] * w01 + image.rgb[s11] * w11;
      const m00 = y0 * w + x0, m10 = y0 * w + x1, m01 = y1 * w + x0, m11 = y1 * w + x1;
      alpha[i] = mask.alpha[m00] * w00 + mask.alpha[m10] * w10 + mask.alpha[m01] * w01 + mask.alpha[m11] * w11;
    }
  }
  return {
    image: { id: image.id + '#warped', width: w, height: h, rgb },
    mask: { width: w, height: h, alpha },
  };
}

/** Map a display-space point back to canonical mask space (inverse transform). */
export function invertTransformPoint(
  t: SubjectTransform, w: number, h: number, x: number, y: number,
): { x: number; y: number } {
  const rad = (t.rotation * Math.PI) / 180;
  const cos = Math.cos(rad) / Math.max(1e-9, t.scale);
  const sin = Math.sin(rad) / Math.max(1e-9, t.scale);
  const cx = w / 2, cy = h / 2;
  const ox = x - cx - t.dx, oy = y - cy - t.dy;
  return { x: cos * ox + sin * oy + cx, y: -sin * ox + cos * oy + cy };
}
