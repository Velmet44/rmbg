import type { AlphaMask, BBox, BrushStroke, Effects } from './types.js';
import { clampBox } from './mask.js';

/** Paint one soft stamp. target 0 = erase, 1 = restore. Returns affected bbox. */
function stamp(
  m: AlphaMask, cx: number, cy: number, size: number, softness: number, target: 0 | 1,
): BBox {
  const r = size / 2;
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(m.width - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(m.height - 1, Math.ceil(cy + r));
  const core = r * (1 - softness);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > r) continue;
      const k = d <= core ? 1 : 1 - (d - core) / Math.max(1e-6, r - core);
      const i = y * m.width + x;
      m.alpha[i] = m.alpha[i] * (1 - k) + target * k;
    }
  }
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Paint a stroke; interpolates between points so fast moves don't gap. */
export function applyBrushStroke(
  m: AlphaMask, stroke: BrushStroke, mode: 'erase' | 'restore',
): BBox {
  const target = mode === 'erase' ? 0 : 1;
  const pts = stroke.points;
  if (pts.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let agg: BBox | null = null;
  const step = Math.max(1, stroke.size / 4);
  const at = (p: { x: number; y: number }) => {
    const b = stamp(m, p.x, p.y, stroke.size, stroke.softness, target);
    agg = agg
      ? {
          x: Math.min(agg.x, b.x), y: Math.min(agg.y, b.y),
          w: Math.max(agg.x + agg.w, b.x + b.w) - Math.min(agg.x, b.x),
          h: Math.max(agg.y + agg.h, b.y + b.h) - Math.min(agg.y, b.y),
        }
      : b;
  };
  at(pts[0]);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(dist / step));
    for (let s = 1; s <= n; s++) at({ x: a.x + ((b.x - a.x) * s) / n, y: a.y + ((b.y - a.y) * s) / n });
  }
  return clampBox(agg!, m.width, m.height);
}

function boxBlurAlpha(m: AlphaMask, radius: number): Float32Array {
  if (radius <= 0) return new Float32Array(m.alpha);
  const { width: w, height: h } = m;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const win = 2 * radius + 1;
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = -radius; x <= radius; x++) acc += m.alpha[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / win;
      acc += m.alpha[y * w + Math.min(w - 1, x + radius + 1)] - m.alpha[y * w + Math.max(0, x - radius)];
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

/** Soften edges in place (conservative: 2 passes max by caller). */
export function featherInPlace(m: AlphaMask, radiusPx: number): void {
  if (radiusPx <= 0) return;
  m.alpha.set(boxBlurAlpha(m, Math.round(radiusPx)));
}

/** Contract the mask (box-minimum) to pull fringes back into the subject. */
export function contractInPlace(m: AlphaMask, px: number): void {
  const r = Math.round(px);
  if (r <= 0) return;
  const { width: w, height: h } = m;
  const src = new Float32Array(m.alpha);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let mn = 1;
      for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) {
        for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) {
          const v = src[yy * w + xx];
          if (v < mn) mn = v;
        }
      }
      m.alpha[y * w + x] = mn;
    }
  }
}

/** Contract (defringe) then feather, in place, in that order: pulling the
 *  fringe in before softening keeps the feather from re-spreading it.
 *
 *  This is the only definition of "refine edges" — the Engine facade and the
 *  app both call it, so the finishing maths cannot drift between them. The
 *  caller owns whether it runs on the canonical mask or on a presentation
 *  copy; the engine only owns the math. */
export function refineEdges(m: AlphaMask, fx: Pick<Effects, 'feather' | 'defringe'>): void {
  if (fx.defringe > 0) contractInPlace(m, fx.defringe);
  if (fx.feather > 0) featherInPlace(m, fx.feather);
}

export function snapshotRegion(m: AlphaMask, b: BBox): { box: BBox; data: Float32Array } {
  const box = clampBox(b, m.width, m.height);
  const data = new Float32Array(box.w * box.h);
  for (let y = 0; y < box.h; y++) {
    for (let x = 0; x < box.w; x++) data[y * box.w + x] = m.alpha[(box.y + y) * m.width + (box.x + x)];
  }
  return { box, data };
}

export function restoreRegion(m: AlphaMask, box: BBox, data: Float32Array): void {
  const b = clampBox(box, m.width, m.height);
  for (let y = 0; y < b.h; y++) {
    for (let x = 0; x < b.w; x++) m.alpha[(b.y + y) * m.width + (b.x + x)] = data[y * b.w + x];
  }
}
