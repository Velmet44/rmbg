import type { AlphaMask, ImageRef, SegmentationAdapter } from './types.js';
import { boxDownsampleRGB, upsampleAlphaBilinear } from './mask.js';
import { dbg, now } from './log.js';

export * from './types.js';
export {
  dbg, dbgWarn, dbgTable, dbgThrottled, now, setLogLevel, setLogTag, setLogEnabled,
  resetLogThrottle, type LogLevel,
} from './log.js';
export { createMask, cloneMask, boxDownsampleRGB, upsampleAlphaBilinear, packRGBA } from './mask.js';
export { applyBrushStroke, featherInPlace, contractInPlace, refineEdges } from './ops.js';
export { composite, compositeOverlay, OVERLAY_TINT, type OverlayOptions } from './composite.js';
export type { CompositeResult } from './composite.js';
export { OpLog, type LogEntry } from './history.js';
export {
  TransformersAdapter, probeGPU, type TransformersDevice, DEFAULT_RUNTIME_URL, RUNTIME_CACHE_NAME,
} from './transformers-adapter.js';
export { transformSubject, invertTransformPoint, isIdentityTransform, IDENTITY_TRANSFORM, type SubjectTransform, type Transformed } from './transform.js';
export { growRegion, type GrownRegion } from './guided.js';

/** Longest side used for neural inference. Full-res output comes from upsampling.
 *  512px: browser-compatible exports (patched ScatterND-free graphs) top out
 *  here, and it is 4x cheaper than 1024 for CPU inference. */
export const WORKING_LONG_SIDE = 512;

/** Inference size for one image: the long side is capped, the short side follows
 *  its own aspect. Exported so the app can derive other working-size operations
 *  (guided selection) from the SAME number inference uses, instead of a second
 *  constant that can silently drift. */
export function workingSize(width: number, height: number): { w: number; h: number } {
  const long = Math.max(width, height);
  if (long <= WORKING_LONG_SIDE) return { w: width, h: height };
  const s = WORKING_LONG_SIDE / long;
  return {
    w: Math.max(1, Math.round(width * s)),
    h: Math.max(1, Math.round(height * s)),
  };
}

/** Full-image cutout at original resolution.
 *
 *  Segmentation runs on a downsampled copy (long side ≤ `WORKING_LONG_SIDE`)
 *  and the alpha is bilinearly upsampled back against the original RGB. The
 *  mask is float alpha, never binary, so hair and semi-transparency survive.
 *  The caller's pixels are never mutated.
 *
 *  This used to be a method on a `createEngine()` facade whose other three
 *  methods only wrapped functions the app called directly anyway — and whose
 *  `refineEdges` mutated a mask in place with NO OpLog entry, so wiring it up
 *  would have made feather un-undoable. The facade is gone; this free function
 *  is the whole public surface for segmentation. */
export async function removeBackground(
  adapter: SegmentationAdapter,
  image: ImageRef,
): Promise<AlphaMask> {
  const t0 = now();
  const size = workingSize(image.width, image.height);
  dbg('engine', `removeBackground · ${image.width}×${image.height} → working ${size.w}×${size.h} (long side ≤ ${WORKING_LONG_SIDE})`);
  const small: ImageRef = size.w === image.width && size.h === image.height
    ? image
    : {
        id: image.id + '#working',
        width: size.w, height: size.h,
        rgb: boxDownsampleRGB(image.rgb, image.width, image.height, size.w, size.h),
      };
  const smallMask = await adapter.segment(small);
  if (smallMask.width === image.width && smallMask.height === image.height) {
    dbg('engine', `removeBackground done in ${(now() - t0).toFixed(0)}ms · mask already at full res`);
    return smallMask;
  }
  dbg('engine', `removeBackground inference took ${(now() - t0).toFixed(0)}ms · upsampling ${smallMask.width}×${smallMask.height} → ${image.width}×${image.height}`);
  return {
    width: image.width, height: image.height,
    alpha: upsampleAlphaBilinear(
      smallMask.alpha, smallMask.width, smallMask.height, image.width, image.height,
    ),
  };
}