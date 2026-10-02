import type { BBox, ImageRef } from './types.js';
import { dbg } from './log.js';

/**
 * Deterministic guided-selection fallback: flood region-grow on image color
 * from a click point. Returns the bounding box + a filled mask patch of the
 * grown region. Used when no promptable model is gated; the caller applies
 * it as erase (alpha 0) or restore (alpha 1).
 *
 * Runs on the working-size image for speed; pure function, no DOM.
 */
export interface GrownRegion {
  box: BBox;
  /** Float mask at working size, 1 inside the region. */
  alpha: Float32Array;
  width: number;
  height: number;
  /** True when the `maxFraction` cap stopped the walk before it finished.
   *  The bbox is then a partial, DFS-ordered sliver rather than a coherent
   *  region — callers that apply it as a selection should check this first. */
  truncated: boolean;
}

export function growRegion(
  image: ImageRef, px: number, py: number, threshold = 28, maxFraction = 0.5,
): GrownRegion {
  const { width: w, height: h, rgb } = image;
  // Fail loud, not open. An out-of-range read on a Uint8ClampedArray yields
  // `undefined`; `undefined - number` is NaN and `NaN > t2` is FALSE, so a
  // short buffer makes the similarity test accept EVERY pixel — the grow then
  // returns the whole image, which the app applies as an erase.
  if (rgb.length < w * h * 3) {
    throw new Error(`growRegion: rgb has ${rgb.length} bytes, expected ${w * h * 3} for ${w}x${h}`);
  }
  const x0 = Math.max(0, Math.min(w - 1, Math.round(px)));
  const y0 = Math.max(0, Math.min(h - 1, Math.round(py)));
  const si = (y0 * w + x0) * 3;
  const sr = rgb[si], sg = rgb[si + 1], sb = rgb[si + 2];
  const t2 = threshold * threshold * 3;
  const seen = new Uint8Array(w * h);
  const alpha = new Float32Array(w * h);
  const stack: number[] = [y0 * w + x0];
  seen[y0 * w + x0] = 1;
  let count = 0;
  const cap = Math.floor(w * h * maxFraction);
  let minX = x0, maxX = x0, minY = y0, maxY = y0;
  const t0 = Date.now();
  // 8-connectivity, including the diagonals. 4-connectivity cuts a region
  // wherever two same-coloured areas meet only at a corner, which on hair, fur
  // and thin diagonals leaves staircased islands the user must erase by hand.
  const push = (i: number): void => { if (!seen[i]) { seen[i] = 1; stack.push(i); } };
  while (stack.length > 0 && count < cap) {
    const i = stack.pop()!;
    const x = i % w, y = (i / w) | 0;
    const o = i * 3;
    const dr = rgb[o] - sr, dg = rgb[o + 1] - sg, db = rgb[o + 2] - sb;
    const d2 = dr * dr + dg * dg + db * db;
    if (!Number.isFinite(d2) || d2 > t2) continue;
    alpha[i] = 1;
    count++;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
    if (x > 0 && y > 0) push(i - w - 1);
    if (x < w - 1 && y > 0) push(i - w + 1);
    if (x > 0 && y < h - 1) push(i + w - 1);
    if (x < w - 1 && y < h - 1) push(i + w + 1);
  }
  // Truncation is a RESULT the caller must be able to see: the cap can stop the
  // walk mid-region, leaving a DFS-ordered sliver whose bbox passes a
  // minimum-size check but is not a coherent selection.
  const truncated = count >= cap && stack.length > 0;
  dbg('guided', `growRegion seed=(${x0},${y0}) threshold=${threshold} cap=${(100 * maxFraction).toFixed(0)}% → grew ${count}px (${(100 * count / (w * h)).toFixed(1)}% of the image)${truncated ? ' TRUNCATED at cap' : ''} in ${Date.now() - t0}ms`);
  return {
    box: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
    alpha, width: w, height: h, truncated,
  };
}
