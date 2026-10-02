// Core data model: original RGB is immutable; all edits live on a float alpha mask.
export type SubjectHint = 'auto' | 'person' | 'product' | 'animal';
export type QualityTier = 'fast' | 'quality';

export interface ImageRef {
  id: string;
  width: number;
  height: number;
  /** Packed RGB, length = width * height * 3. Never mutated by the engine. */
  rgb: Uint8ClampedArray;
}

export interface AlphaMask {
  width: number;
  height: number;
  /** Foreground opacity in [0, 1]. 1 = keep, 0 = transparent. */
  alpha: Float32Array;
}

export interface BBox { x: number; y: number; w: number; h: number; }
export interface Point { x: number; y: number; }
export interface BrushStroke { points: Point[]; size: number; softness: number; }

export type BgKind = 'transparent' | 'color' | 'image';
export interface Background {
  kind: BgKind;
  color?: [number, number, number];
  image?: ImageRef;
}

export interface Effects {
  shadow: { on: boolean; opacity: number; blur: number; dx: number; dy: number };
  feather: number;
  defringe: number;
}

export interface ModelProgress {
  /** initiate: file started (no download event after = served from cache).
   *  download: fetch began (cache miss). progress: bytes flowing.
   *  done: file complete. */
  status: 'initiate' | 'download' | 'progress' | 'done';
  file: string;
  loaded?: number;
  total?: number;
}

export interface SegmentationAdapter {
  readonly modelId: string;
  init(progress?: (p: ModelProgress) => void): Promise<void>;
  /** Segment one image. No hint or tier: V1 ships exactly one model at exactly
   *  one working resolution, so both parameters used to be accepted here and
   *  then discarded by the implementation. A control that promises to bias the
   *  model and does not is worse than no control; they return with the second
   *  gated model. */
  segment(image: ImageRef): Promise<AlphaMask>;
  recomputeRegion(image: ImageRef, mask: AlphaMask, bbox: BBox): Promise<AlphaMask>;
  dispose(): Promise<void>;
}
