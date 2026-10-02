import type { AlphaMask, Background, Effects, ImageRef } from './types.js';
import { dbgThrottled } from './log.js';

export interface CompositeResult {
  width: number;
  height: number;
  /** Packed RGBA. Length = width * height * 4. */
  rgba: Uint8ClampedArray;
}

/**
 * composite = original RGB × final alpha over background (+ optional shadow).
 * Pure function, no DOM. Never mutates inputs.
 */
export function composite(
  image: ImageRef, mask: AlphaMask, bg: Background, fx: Effects,
): CompositeResult {
  if (image.width !== mask.width || image.height !== mask.height) {
    throw new Error('composite: image and mask sizes differ');
  }
  const { width: w, height: h } = image;
  dbgThrottled('composite', `composite ${w}×${h} bg=${bg.kind} shadow=${fx.shadow.on} feather=${fx.feather} defringe=${fx.defringe}`, 2000);
  const rgba = new Uint8ClampedArray(w * h * 4);

  // Optional drop shadow, computed from alpha, drawn under the subject.
  let shadow: Float32Array | null = null;
  if (fx.shadow.on) {
    shadow = new Float32Array(w * h);
    const dx = Math.round(fx.shadow.dx), dy = Math.round(fx.shadow.dy);
    for (let y = 0; y < h; y++) {
      const sy = y - dy;
      if (sy < 0 || sy >= h) continue;
      for (let x = 0; x < w; x++) {
        const sx = x - dx;
        if (sx < 0 || sx >= w) continue;
        shadow[y * w + x] = mask.alpha[sy * w + sx] * fx.shadow.opacity;
      }
    }
    const r = Math.max(0, Math.round(fx.shadow.blur));
    if (r > 0) shadow = boxBlur(shadow, w, h, r);
  }

  let bgRgb: Uint8ClampedArray | null = null;
  if (bg.kind === 'image' && bg.image) bgRgb = coverFit(bg.image, w, h);

  for (let i = 0; i < w * h; i++) {
    const a = Math.min(1, Math.max(0, mask.alpha[i]));
    const sr = image.rgb[i * 3], sg = image.rgb[i * 3 + 1], sb = image.rgb[i * 3 + 2];
    let br = 0, bgc = 0, bb = 0, ba = 0;
    if (bg.kind === 'color' && bg.color) {
      [br, bgc, bb] = bg.color; ba = 1;
    } else if (bg.kind === 'image' && bgRgb) {
      br = bgRgb[i * 3]; bgc = bgRgb[i * 3 + 1]; bb = bgRgb[i * 3 + 2]; ba = 1;
    }
    // Subject over background.
    let r = sr * a + br * (1 - a) * ba;
    let g = sg * a + bgc * (1 - a) * ba;
    let b = sb * a + bb * (1 - a) * ba;
    let alpha = bg.kind === 'transparent' ? a : a + ba * (1 - a);
    if (shadow) {
      // Shadow shows only where the subject is (semi-)transparent.
      const s = shadow[i] * (1 - a);
      r = r * (1 - s) ; g = g * (1 - s); b = b * (1 - s);
      if (bg.kind === 'transparent') alpha = Math.min(1, alpha + s);
    }
    const o = i * 4;
    rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = alpha * 255;
  }
  return { width: w, height: h, rgba };
}

/** Tint used to veil background in the overlay view. Matches the app's
 *  "erase" red so the overlay and the erase brush read as the same idea. */
export const OVERLAY_TINT: [number, number, number] = [248, 113, 113];

export interface OverlayOptions {
  /** How strongly to veil what the mask called background: 0 = untouched
   *  original, 1 = fully tinted. Defaults to 0.55. */
  veil?: number;
  /** Veil colour. Defaults to `OVERLAY_TINT`. */
  tint?: [number, number, number];
}

/**
 * Overlay view: the ORIGINAL pixels with the mask painted on top, so a region
 * the AI wrongly kept reads as "this should have been removed and wasn't".
 *
 * Foreground is left completely untouched; background is veiled with a tint;
 * partial alpha blends between the two, which is the whole point — hair and
 * semi-transparent edges only read correctly if the transition is continuous
 * rather than a hard threshold.
 *
 * Always fully opaque: this is an inspection view, not an export path, so it
 * never produces an artifact. Pure function, no DOM.
 */
export function compositeOverlay(
  image: ImageRef, mask: AlphaMask, opts: OverlayOptions = {},
): CompositeResult {
  if (image.width !== mask.width || image.height !== mask.height) {
    throw new Error('compositeOverlay: image and mask sizes differ');
  }
  const { width: w, height: h } = image;
  const veil = Math.min(1, Math.max(0, opts.veil ?? 0.55));
  const [tr, tg, tb] = opts.tint ?? OVERLAY_TINT;
  dbgThrottled('composite', `compositeOverlay ${w}×${h} veil=${veil}`, 2000);
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = Math.min(1, Math.max(0, mask.alpha[i]));
    const v = veil * (1 - a);
    const o = i * 4;
    rgba[o] = image.rgb[i * 3] * (1 - v) + tr * v;
    rgba[o + 1] = image.rgb[i * 3 + 1] * (1 - v) + tg * v;
    rgba[o + 2] = image.rgb[i * 3 + 2] * (1 - v) + tb * v;
    rgba[o + 3] = 255;
  }
  return { width: w, height: h, rgba };
}

/** Cover-fit an RGB image to exact dimensions (center crop). */
function coverFit(img: ImageRef, w: number, h: number): Uint8ClampedArray {
  const scale = Math.max(w / img.width, h / img.height);
  const sw = w / scale, sh = h / scale;
  const sx = (img.width - sw) / 2, sy = (img.height - sh) / 2;
  const out = new Uint8ClampedArray(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ix = Math.min(img.width - 1, Math.max(0, Math.floor(sx + x / scale)));
      const iy = Math.min(img.height - 1, Math.max(0, Math.floor(sy + y / scale)));
      const s = (iy * img.width + ix) * 3, d = (y * w + x) * 3;
      out[d] = img.rgb[s]; out[d + 1] = img.rgb[s + 1]; out[d + 2] = img.rgb[s + 2];
    }
  }
  return out;
}

function boxBlur(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const win = 2 * radius + 1;
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = -radius; x <= radius; x++) acc += src[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / win;
      acc += src[y * w + Math.min(w - 1, x + radius + 1)] - src[y * w + Math.max(0, x - radius)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -radius; y <= radius; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / win;
      acc += tmp[Math.min(h - 1, y + radius + 1) * w + x] - tmp[Math.max(0, y - radius) * w + x];
    }
  }
  return out;
}
