// Mask scoring. Every metric states its threshold and its tolerance in the
// name, because "IoU" without one is not a measurement.
//
// Definitions (also in benchmarks/README.md, and encoded in the metric name):
//   IoU, Dice, precision, recall  — on the binary mask at alpha >= THRESHOLD.
//   boundaryF(tolPx)              — F-measure of the boundary PIXEL SETS, where a
//                                    prediction counts as matching when it lies
//                                    within tolPx of a reference boundary
//                                    (chamfer distance, 3-4 neighbourhood).
//   alphaMae                      — mean |pred - reference| over all pixels, on
//                                    the raw float alpha. Only meaningful where
//                                    the reference is genuinely soft.
//
// The orientation check is the cheap one that catches the expensive bug: a
// transposed or flipped mask scores plausibly on every other metric and is
// obviously wrong here.

export const DEFAULT_THRESHOLD = 0.5;

export function binarize(alpha: ArrayLike<number>, threshold = DEFAULT_THRESHOLD): Uint8Array {
  const out = new Uint8Array(alpha.length);
  for (let i = 0; i < alpha.length; i++) out[i] = alpha[i] >= threshold ? 1 : 0;
  return out;
}

export interface BinaryScores {
  intersection: number; union: number; iou: number;
  dice: number; precision: number; recall: number;
  predArea: number; truthArea: number;
}

export function binaryScores(pred: ArrayLike<number>, truth: ArrayLike<number>): BinaryScores {
  let inter = 0, punion = 0, ps = 0, ts = 0;
  for (let i = 0; i < pred.length; i++) {
    const p = pred[i] ? 1 : 0;
    const t = truth[i] ? 1 : 0;
    if (p && t) inter++;
    if (p || t) punion++;
    ps += p; ts += t;
  }
  return {
    intersection: inter, union: punion,
    iou: punion ? inter / punion : 1,
    dice: ps + ts ? (2 * inter) / (ps + ts) : 1,
    precision: ps ? inter / ps : 1,
    recall: ts ? inter / ts : 1,
    predArea: ps, truthArea: ts,
  };
}

/** Pixels that are 1 and have at least one 4-neighbour that is 0 (or are on
 *  the edge). The boundary SET, used for the tolerance-based F-measure. */
export function boundaryOf(mask: ArrayLike<number>, width: number, height: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!mask[i]) continue;
      const left = x > 0 ? mask[i - 1] : 0;
      const right = x < width - 1 ? mask[i + 1] : 0;
      const up = y > 0 ? mask[i - width] : 0;
      const down = y < height - 1 ? mask[i + width] : 0;
      if (!left || !right || !up || !down) out[i] = 1;
    }
  }
  return out;
}

/** Chamfer distance (3-4 neighbourhood, two passes) from every pixel to the
 *  nearest set pixel. Two linear passes, no priority queue. */
function chamfer(seed: Uint8Array, width: number, height: number): Uint16Array {
  const INF = 0xffff;
  const d = new Uint16Array(width * height);
  for (let i = 0; i < d.length; i++) d[i] = seed[i] ? 0 : INF;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= width || y >= height ? INF : d[y * width + x]);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let v = d[i];
      v = Math.min(v, at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4);
      d[i] = v;
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      let v = d[i];
      v = Math.min(v, at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4);
      d[i] = v;
    }
  }
  return d;
}

export interface BoundaryF {
  precision: number; recall: number; f: number; tolPx: number;
}

/** Tolerance-based boundary F-measure at `tolPx`, where each unit of tolerance
 *  is a chamfer-3 unit (so tolPx 2 ≈ 2 orthogonal pixels or ~3 diagonal). */
export function boundaryF(
  pred: ArrayLike<number>, truth: ArrayLike<number>, width: number, height: number, tolPx: number,
): BoundaryF {
  const pb = boundaryOf(pred, width, height);
  const tb = boundaryOf(truth, width, height);
  let pCount = 0, tCount = 0, pHit = 0, tHit = 0;
  for (let i = 0; i < pb.length; i++) { if (pb[i]) pCount++; if (tb[i]) tCount++; }
  const tol = tolPx * 3;
  if (pCount && tCount) {
    const dToTruth = chamfer(tb, width, height);
    const dToPred = chamfer(pb, width, height);
    for (let i = 0; i < pb.length; i++) {
      if (pb[i] && dToTruth[i] <= tol) pHit++;
      if (tb[i] && dToPred[i] <= tol) tHit++;
    }
  }
  const precision = pCount ? pHit / pCount : 1;
  const recall = tCount ? tHit / tCount : 1;
  const f = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f, tolPx };
}

export function alphaMae(pred: ArrayLike<number>, truth: ArrayLike<number>): number {
  let t = 0;
  for (let i = 0; i < pred.length; i++) t += Math.abs(pred[i] - truth[i]);
  return t / pred.length;
}

/** Mean alpha where the reference is a hard edge vs. everywhere: separates "the
 *  mask is wrong" from "the mask is right but soft". */
export function alphaStats(pred: ArrayLike<number>, truth: ArrayLike<number>): {
  predMean: number; truthMean: number; predSoftFraction: number;
} {
  let ps = 0, ts = 0, soft = 0;
  for (let i = 0; i < pred.length; i++) {
    ps += pred[i]; ts += truth[i];
    if (pred[i] > 0.02 && pred[i] < 0.98) soft++;
  }
  return { predMean: ps / pred.length, truthMean: ts / pred.length, predSoftFraction: soft / pred.length };
}

export type Transform = 'identity' | 'hflip' | 'vflip' | 'transpose' | 'rot180';

export function applyTransform(
  mask: ArrayLike<number>, width: number, height: number, t: Transform,
): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sx = x, sy = y;
      if (t === 'hflip') sx = width - 1 - x;
      else if (t === 'vflip') sy = height - 1 - y;
      else if (t === 'rot180') { sx = width - 1 - x; sy = height - 1 - y; }
      else if (t === 'transpose') { sx = y; sy = x; }
      out[y * width + x] = mask[sy * width + sx];
    }
  }
  return out;
}

export const TRANSFORMS: Transform[] = ['identity', 'hflip', 'vflip', 'rot180', 'transpose'];

/** Which transform of the prediction best matches the reference?
 *
 *  A mask that arrives transposed or flipped is invisible to IoU-at-low-values
 *  eyeballing and to every timing metric, and it is a one-character fix. This
 *  names the bug instead of leaving it as "the score looks a bit off". */
export function bestOrientation(
  pred: ArrayLike<number>, truth: ArrayLike<number>, width: number, height: number, threshold = DEFAULT_THRESHOLD,
): { best: Transform; bestIou: number; identityIou: number; ious: Record<Transform, number> } {
  const t = binarize(truth, threshold);
  const ious = {} as Record<Transform, number>;
  for (const tr of TRANSFORMS) {
    const p = binarize(applyTransform(pred, width, height, tr), threshold);
    ious[tr] = binaryScores(p, t).iou;
  }
  let best: Transform = 'identity';
  for (const tr of TRANSFORMS) if (ious[tr] > ious[best] + 1e-9) best = tr;
  return { best, bestIou: ious[best], identityIou: ious.identity, ious };
}

export function maxAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > m) m = d;
  }
  return m;
}

export function coverage(alpha: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < alpha.length; i++) s += alpha[i];
  return s / alpha.length;
}