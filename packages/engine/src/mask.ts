import type { AlphaMask, BBox, ImageRef } from './types.js';

export function createMask(w: number, h: number, fill = 0): AlphaMask {
  return { width: w, height: h, alpha: new Float32Array(w * h).fill(fill) };
}

export function cloneMask(m: AlphaMask): AlphaMask {
  return { width: m.width, height: m.height, alpha: new Float32Array(m.alpha) };
}

export function clampBox(b: BBox, w: number, h: number): BBox {
  const x = Math.max(0, Math.min(w, Math.round(b.x)));
  const y = Math.max(0, Math.min(h, Math.round(b.y)));
  const w2 = Math.max(0, Math.min(w - x, Math.round(b.w)));
  const h2 = Math.max(0, Math.min(h - y, Math.round(b.h)));
  return { x, y, w: w2, h: h2 };
}

/** Expand packed RGB to RGBA (opaque). The segmentation runtime's image
 *  loader convention is 4-channel; feeding 3-channel data yields empty masks. */
export function packRGBA(rgb: Uint8ClampedArray): Uint8ClampedArray {
  const n = Math.floor(rgb.length / 3);
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = rgb[i * 3];
    out[i * 4 + 1] = rgb[i * 3 + 1];
    out[i * 4 + 2] = rgb[i * 3 + 2];
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** Average-downsample packed RGB. Pure function, no DOM. */
export function boxDownsampleRGB(
  src: Uint8ClampedArray, sw: number, sh: number, dw: number, dh: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(dw * dh * 3);
  const sx = sw / dw, sy = sh / dh;
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.min(sw, Math.ceil((x + 1) * sx));
      const y0 = Math.floor(y * sy), y1 = Math.min(sh, Math.ceil((y + 1) * sy));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * sw + xx) * 3;
          r += src[i]; g += src[i + 1]; b += src[i + 2]; n++;
        }
      }
      const o = (y * dw + x) * 3;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n;
    }
  }
  return out;
}

/** Bilinear upsample of a single-channel float field. */
export function upsampleAlphaBilinear(
  src: Float32Array, sw: number, sh: number, dw: number, dh: number,
): Float32Array {
  const out = new Float32Array(dw * dh);
  // Endpoint-aligned (corner) sampling: index 0 of `src` lands on index 0 of the
  // destination and the far edge on the far edge. A pixel-CENTRE-aligned variant
  // ((x+0.5)*fx-0.5) was measured and makes no practical difference here —
  // (sw-1)/(dw-1) and sw/dw agree to well under a sub-pixel over any real ratio,
  // and the residual half-pixel edge offset is inherent to quantising a hard
  // edge onto the 512px inference grid, not to this interpolation.
  const fx = (sw - 1) / Math.max(1, dw - 1);
  const fy = (sh - 1) / Math.max(1, dh - 1);
  for (let y = 0; y < dh; y++) {
    const gy = y * fy, y0 = Math.floor(gy), y1 = Math.min(sh - 1, y0 + 1), ty = gy - y0;
    for (let x = 0; x < dw; x++) {
      const gx = x * fx, x0 = Math.floor(gx), x1 = Math.min(sw - 1, x0 + 1), tx = gx - x0;
      const a = src[y0 * sw + x0], b = src[y0 * sw + x1];
      const c = src[y1 * sw + x0], d = src[y1 * sw + x1];
      out[y * dw + x] = a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
    }
  }
  return out;
}

export function cropRGB(img: ImageRef, box: BBox): ImageRef {
  const b = clampBox(box, img.width, img.height);
  const out = new Uint8ClampedArray(b.w * b.h * 3);
  for (let y = 0; y < b.h; y++) {
    for (let x = 0; x < b.w; x++) {
      const s = ((b.y + y) * img.width + (b.x + x)) * 3;
      const d = (y * b.w + x) * 3;
      out[d] = img.rgb[s]; out[d + 1] = img.rgb[s + 1]; out[d + 2] = img.rgb[s + 2];
    }
  }
  return { id: img.id + '#crop', width: b.w, height: b.h, rgb: out };
}

/** Paste a patch into dst with a linear edge blend over `feather` px. */
export function pasteAlphaFeathered(
  dst: AlphaMask, patch: AlphaMask, dx: number, dy: number, feather: number,
): void {
  // A patch only reaches k = 1 once it is at least 2*feather+1 across, so a small
  // recompute box would apply a fraction of the new mask while the app reported
  // "region recomputed". Cap the feather to what the patch can actually support.
  const f = Math.max(0, Math.min(feather, Math.floor((Math.min(patch.width, patch.height) - 1) / 2)));
  for (let y = 0; y < patch.height; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= dst.height) continue;
    for (let x = 0; x < patch.width; x++) {
      const tx = dx + x;
      if (tx < 0 || tx >= dst.width) continue;
      const ex = Math.min(x, patch.width - 1 - x, y, patch.height - 1 - y);
      const k = f <= 0 ? 1 : Math.min(1, (ex + 1) / (f + 1));
      const i = ty * dst.width + tx;
      const p = patch.alpha[y * patch.width + x];
      dst.alpha[i] = dst.alpha[i] * (1 - k) + p * k;
    }
  }
}
