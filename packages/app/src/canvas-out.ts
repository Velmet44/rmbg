// Canvas presentation + encoding boundary for engine output.
//
// Everything here is the app's *real* export/composite path, extracted from
// main.ts so the benchmark runner measures the shipped code. The engine stays
// DOM-free; this is the one module allowed to own a canvas.
//
// One shared scratch canvas backs every blit: each redraw otherwise allocates a
// full-resolution RGBA buffer on top of the one composite() already returned,
// which is what made the finishing sliders pin the main thread before
// `refreshDisplay()` coalesced them onto an animation frame.

import {
  composite,
  compositeOverlay,
  type AlphaMask,
  type Background,
  type CompositeResult,
  type Effects,
  type ImageRef,
} from '@rmbg/engine';

const scratch = document.createElement('canvas');

/** Blit an engine CompositeResult into a canvas through the shared scratch. */
export function blitCompositeInto(target: HTMLCanvasElement, out: CompositeResult, maxSide = 0): void {
  scratch.width = out.width; scratch.height = out.height;
  scratch.getContext('2d')!.putImageData(
    new ImageData(out.rgba as unknown as Uint8ClampedArray<ArrayBuffer>, out.width, out.height), 0, 0,
  );
  let dw = out.width, dh = out.height;
  if (maxSide > 0) {
    const s = Math.min(1, maxSide / Math.max(dw, dh));
    dw = Math.max(1, Math.round(dw * s)); dh = Math.max(1, Math.round(dh * s));
  }
  target.width = dw; target.height = dh;
  const ctx = target.getContext('2d')!;
  ctx.clearRect(0, 0, dw, dh);
  ctx.drawImage(scratch, 0, 0, dw, dh);
}

export interface CutoutView { image: ImageRef; mask: AlphaMask }

/** Full-resolution composite of the cutout into `target`. */
export function compositeInto(
  target: HTMLCanvasElement, view: CutoutView, bg: Background, fx: Effects, maxSide = 0,
): void {
  blitCompositeInto(target, composite(view.image, view.mask, bg, fx), maxSide);
}

/** Overlay view: original pixels with the mask veiled on top, so a region the AI
 *  wrongly kept is obvious. Uses the CANONICAL mask, not the derived view — the
 *  point is to audit the cutout itself, not the finishing effects. */
export function overlayInto(target: HTMLCanvasElement, img: ImageRef, mask: AlphaMask): void {
  blitCompositeInto(target, compositeOverlay(img, mask));
}

/** The original photo into `target` (before/after + split panes). */
export function originalInto(target: HTMLCanvasElement, img: ImageRef): void {
  const rgba = new Uint8ClampedArray(img.width * img.height * 4);
  for (let i = 0; i < img.width * img.height; i++) {
    rgba[i * 4] = img.rgb[i * 3];
    rgba[i * 4 + 1] = img.rgb[i * 3 + 1];
    rgba[i * 4 + 2] = img.rgb[i * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }
  blitCompositeInto(target, { width: img.width, height: img.height, rgba });
}

/** Mask as grayscale (white = foreground, black = background). */
export function maskGrayInto(target: HTMLCanvasElement, mask: AlphaMask): void {
  const ctx = target.getContext('2d')!;
  target.width = mask.width; target.height = mask.height;
  const id = ctx.createImageData(mask.width, mask.height);
  for (let i = 0; i < mask.width * mask.height; i++) {
    const v = Math.round(Math.min(1, Math.max(0, mask.alpha[i])) * 255);
    id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v;
    id.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
}

/** Full-res composite, then a single high-quality resample to export size. */
export function compositeExportCanvas(
  view: CutoutView, bg: Background, fx: Effects, w: number, h: number,
): HTMLCanvasElement {
  const full = document.createElement('canvas');
  compositeInto(full, view, bg, fx);
  if (full.width === w && full.height === h) return full;
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(full, 0, 0, w, h);
  return out;
}

// ---------- encoding ----------

export const EXPORT_FORMATS = ['PNG', 'WebP', 'JPEG', 'AVIF'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export function exportMime(fmt: ExportFormat): string {
  return fmt === 'PNG' ? 'image/png'
    : fmt === 'WebP' ? 'image/webp'
    : fmt === 'AVIF' ? 'image/avif' : 'image/jpeg';
}
export function exportExtension(fmt: ExportFormat): string {
  return fmt === 'PNG' ? 'png' : fmt === 'WebP' ? 'webp' : fmt === 'AVIF' ? 'avif' : 'jpg';
}
export function exportQuality(fmt: ExportFormat): number {
  return fmt === 'AVIF' ? 0.85 : 0.92;
}

/** AVIF encode support varies by browser/runtime — detect, never assume. */
let avifCache: boolean | null = null;
export async function avifSupported(): Promise<boolean> {
  if (avifCache !== null) return avifCache;
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 8;
    avifCache = c.toDataURL('image/avif').startsWith('data:image/avif');
  } catch {
    avifCache = false;
  }
  return avifCache;
}

/** Capability-gated encoder probe: can this runtime actually WRITE `fmt`?
 *  `toDataURL` is used rather than `toBlob` because a runtime that cannot
 *  encode falls back to PNG, and only the data URL's own prefix tells the
 *  truth about what came back. */
export async function canEncode(fmt: ExportFormat): Promise<boolean> {
  if (fmt === 'AVIF') return avifSupported();
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 8;
    return c.toDataURL(exportMime(fmt)).startsWith(`data:${exportMime(fmt)}`);
  } catch {
    return false;
  }
}

export async function encodeCanvas(
  canvas: HTMLCanvasElement, fmt: ExportFormat, quality: number = exportQuality(fmt),
): Promise<Blob> {
  const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, exportMime(fmt), quality));
  if (!blob) throw new Error(`encoder returned nothing for ${fmt}`);
  return blob;
}