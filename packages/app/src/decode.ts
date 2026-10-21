// Ingest: Blob/File -> ImageRef (immutable packed RGB).
//
// Extracted from main.ts so the benchmark runner measures the SAME decode path
// the app ships. A benchmark that re-implemented decoding would drift from
// production within one commit, and the number would quietly stop meaning
// anything.
import { dbg, now, type ImageRef } from '@rmbg/engine';

export interface DecodeTimings {
  /** createImageBitmap + drawImage only — excludes the RGBA->RGB pack. */
  decodeMs: number;
  /** The whole call, including the packed-RGB conversion. */
  totalMs: number;
}

/** Timed form. The app uses `decodeToImageRef`; the benchmark uses this so it
 *  can separate "the browser could not decode this format" from "converting to
 *  packed RGB cost this much", which are different failures with different fixes. */
export async function decodeToImageRefTimed(f: Blob, id: string): Promise<{ image: ImageRef; timings: DecodeTimings }> {
  const t0 = now();
  const bmp = await createImageBitmap(f);
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width; canvas.height = bmp.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  const decodeMs = now() - t0;
  const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  const rgb = new Uint8ClampedArray(bmp.width * bmp.height * 3);
  for (let i = 0; i < bmp.width * bmp.height; i++) {
    rgb[i * 3] = data[i * 4]; rgb[i * 3 + 1] = data[i * 4 + 1]; rgb[i * 3 + 2] = data[i * 4 + 2];
  }
  bmp.close();
  const totalMs = now() - t0;
  dbg('ingest', `decode "${id}" → ${canvas.width}×${canvas.height} in ${totalMs.toFixed(0)}ms`);
  return { image: { id, width: canvas.width, height: canvas.height, rgb }, timings: { decodeMs, totalMs } };
}

export async function decodeToImageRef(f: Blob, id: string): Promise<ImageRef> {
  return (await decodeToImageRefTimed(f, id)).image;
}

/** Bytes an ImageRef occupies: 3 B/px packed RGB. The engine never stores
 *  alpha alongside it — coverage lives in the mask — so this is the whole
 *  per-image RGB cost. */
export function rgbBytes(image: ImageRef): number {
  return image.rgb.length;
}

/** Bytes a full-res alpha mask costs: 4 B/px Float32. */
export function maskBytes(width: number, height: number): number {
  return width * height * 4;
}

/** Every large buffer one editing session can hold at once, for the memory
 *  matrix. Deliberately an over-estimate of the peak: composite() allocates an
 *  RGBA result and, with shadow on, two extra Float32 planes of the same size. */
export function sessionBytesEstimate(image: ImageRef, opts: { shadow: boolean } = { shadow: false }): {
  rgb: number; mask: number; composite: number; scratch: number; total: number;
} {
  const px = image.width * image.height;
  const rgb = px * 3;
  const mask = px * 4;
  const composite = px * 4;
  // feather/defringe clone the mask; shadow adds two more Float32 planes.
  const scratch = px * 4 + (opts.shadow ? px * 8 : 0);
  return { rgb, mask, composite, scratch, total: rgb + mask + composite + scratch };
}