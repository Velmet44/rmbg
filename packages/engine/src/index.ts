import type {
  AlphaMask, Background, BrushStroke, Effects, ImageRef, QualityTier, SubjectHint,
} from './types.js';
import type { SegmentationAdapter } from './types.js';
import { boxDownsampleRGB, createMask, upsampleAlphaBilinear } from './mask.js';
import { applyBrushStroke, contractInPlace, featherInPlace } from './ops.js';
import { composite as compositePure, type CompositeResult } from './composite.js';
import { OpLog } from './history.js';

export * from './types.js';
export { createMask, cloneMask, boxDownsampleRGB, upsampleAlphaBilinear, packRGBA } from './mask.js';
export { applyBrushStroke, featherInPlace, contractInPlace } from './ops.js';
export { composite } from './composite.js';
export { OpLog } from './history.js';
export { TransformersAdapter, type TransformersDevice } from './transformers-adapter.js';

/** Longest side used for neural inference. Full-res output comes from upsampling.
 *  512px: browser-compatible exports (patched ScatterND-free graphs) top out
 *  here, and it is 4x cheaper than 1024 for CPU inference. */
export const WORKING_LONG_SIDE = 512;

export interface Engine {
  readonly adapter: SegmentationAdapter;
  removeBackground(image: ImageRef, opts?: { hint?: SubjectHint; tier?: QualityTier }): Promise<AlphaMask>;
  applyBrush(mask: AlphaMask, log: OpLog, stroke: BrushStroke, mode: 'erase' | 'restore'): void;
  refineEdges(mask: AlphaMask, fx: Pick<Effects, 'feather' | 'defringe'>): void;
  composite(image: ImageRef, mask: AlphaMask, bg: Background, fx: Effects): CompositeResult;
}

function workingSize(w: number, h: number): { w: number; h: number } {
  const long = Math.max(w, h);
  if (long <= WORKING_LONG_SIDE) return { w, h };
  const s = WORKING_LONG_SIDE / long;
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

export function createEngine(adapter: SegmentationAdapter): Engine {
  return {
    adapter,

    async removeBackground(image, opts = {}) {
      const size = workingSize(image.width, image.height);
      const small: ImageRef = size.w === image.width && size.h === image.height
        ? image
        : {
            id: image.id + '#working',
            width: size.w, height: size.h,
            rgb: boxDownsampleRGB(image.rgb, image.width, image.height, size.w, size.h),
          };
      const smallMask = await adapter.segment(small, {
        hint: opts.hint ?? 'auto', tier: opts.tier ?? 'quality',
      });
      if (smallMask.width === image.width && smallMask.height === image.height) return smallMask;
      return {
        width: image.width, height: image.height,
        alpha: upsampleAlphaBilinear(
          smallMask.alpha, smallMask.width, smallMask.height, image.width, image.height,
        ),
      };
    },

    applyBrush(mask, log, stroke, mode) {
      log.commitRegion(mask, mode === 'erase' ? 'erase' : 'restore', (m) => {
        const box = applyBrushStroke(m, stroke, mode);
        return box.w === 0 ? { x: 0, y: 0, w: 0, h: 0 } : box;
      });
    },

    refineEdges(mask, fx) {
      if (fx.defringe > 0) contractInPlace(mask, fx.defringe);
      if (fx.feather > 0) featherInPlace(mask, fx.feather);
    },

    composite(image, mask, bg, fx) {
      return compositePure(image, mask, bg, fx);
    },
  };
}
