// Deterministic synthetic images with ground truth that is EXACT BY
// CONSTRUCTION: one parametric description produces both the pixels and the
// alpha, so the reference mask is not an annotation that can be wrong.
//
// What this does and does not prove — stated here because it is the difference
// between a real gate and a decoration:
//
//   PROVES  the mask pipeline is geometrically correct: no transposed axes, no
//           flipped image, no working-resolution/off-by-one mis-mapping, alpha
//           extracted from the right channel, region patches landing where the
//           box said.
//   DOES NOT PROVE  photographic cutout quality. BiRefNet is trained on natural
//           photographs; a synthetic disc is out of distribution. A low score on
//           a synthetic case is a finding about the MODEL, not about this
//           pipeline, and must never be presented as cutout quality.
//
// The photo corpus that would cover hair/fur/glasses/fingers is a separate,
// documented gap (benchmarks/corpus/README.md). It is not faked here.

export interface Synthetic {
  id: string;
  width: number;
  height: number;
  rgb: Uint8ClampedArray;
  /** Reference alpha in [0,1], same size as the image. */
  gt: Float32Array;
}

/** Deterministic noise. Same bytes on every machine, so a score change means a
 *  code change, not a reseed. */
function lcg(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0 || 1e-9)));
  return t * t * (3 - 2 * t);
}

class Painter {
  readonly rgb: Uint8ClampedArray;
  readonly gt: Float32Array;
  constructor(readonly width: number, readonly height: number) {
    this.rgb = new Uint8ClampedArray(width * height * 3);
    this.gt = new Float32Array(width * height);
  }
  /** Blend the subject colour over the background by coverage `a`, and record
   *  the same coverage as ground truth. One source of truth for both. */
  paint(i: number, a: number, r: number, g: number, b: number): void {
    if (a <= 0) return;
    const o = i * 3;
    this.rgb[o] += (r - this.rgb[o]) * a;
    this.rgb[o + 1] += (g - this.rgb[o + 1]) * a;
    this.rgb[o + 2] += (b - this.rgb[o + 2]) * a;
    if (a > this.gt[i]) this.gt[i] = a;
  }
  setBg(i: number, r: number, g: number, b: number): void {
    const o = i * 3;
    this.rgb[o] = r; this.rgb[o + 1] = g; this.rgb[o + 2] = b;
  }
}

/** A cool, gently graded background with light noise: not flat (a flat field
 *  makes colour-threshold region growing trivially easy and uninformative). */
function paintBackground(
  p: Painter, seed: number, tint: readonly [number, number, number] = [70, 92, 118],
): void {
  const rnd = lcg(seed);
  for (let y = 0; y < p.height; y++) {
    for (let x = 0; x < p.width; x++) {
      const t = (x / p.width) * 0.6 + (y / p.height) * 0.4;
      const n = (rnd() - 0.5) * 10;
      p.setBg(y * p.width + x, tint[0] + t * 26 + n, tint[1] + t * 20 + n, tint[2] + t * 14 + n);
    }
  }
}

function paintDisc(
  p: Painter, cx: number, cy: number, r: number, colour: readonly [number, number, number], feather = 1.5,
): void {
  const x0 = Math.max(0, Math.floor(cx - r - 2)), x1 = Math.min(p.width - 1, Math.ceil(cx + r + 2));
  const y0 = Math.max(0, Math.floor(cy - r - 2)), y1 = Math.min(p.height - 1, Math.ceil(cy + r + 2));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy);
      const a = 1 - smoothstep(r - feather, r + feather, d);
      p.paint(y * p.width + x, a, colour[0], colour[1], colour[2]);
    }
  }
}

function paintEllipse(
  p: Painter, cx: number, cy: number, rx: number, ry: number, colour: readonly [number, number, number],
): void {
  const x0 = Math.max(0, Math.floor(cx - rx - 2)), x1 = Math.min(p.width - 1, Math.ceil(cx + rx + 2));
  const y0 = Math.max(0, Math.floor(cy - ry - 2)), y1 = Math.min(p.height - 1, Math.ceil(cy + ry + 2));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot((x - cx) / rx, (y - cy) / ry);
      p.paint(y * p.width + x, 1 - smoothstep(0.985, 1.015, d), colour[0], colour[1], colour[2]);
    }
  }
}

const WARM: readonly [number, number, number] = [214, 150, 96];

export function synthDisc(width: number, height: number, id = 'disc'): Synthetic {
  const p = new Painter(width, height);
  paintBackground(p, 0x5eed1);
  paintDisc(p, width * 0.5, height * 0.52, Math.min(width, height) * 0.3, WARM);
  return { id, width, height, rgb: p.rgb, gt: p.gt };
}

/** Thin objects: the failure mode where a 512px working resolution smears a
 *  6px-wide structure away entirely. */
export function synthThinBars(width: number, height: number, id = 'thin-bars'): Synthetic {
  const p = new Painter(width, height);
  paintBackground(p, 0xba12);
  const bw = Math.max(3, Math.round(width * 0.012));
  for (const [fx, fy] of [[0.28, 0.5], [0.5, 0.42], [0.72, 0.58]]) {
    const x0 = Math.round(width * fx - bw / 2), y0 = Math.round(height * fy - height * 0.28);
    const x1 = x0 + bw, y1 = y0 + Math.round(height * 0.56);
    for (let y = Math.max(0, y0); y < Math.min(height, y1); y++) {
      for (let x = Math.max(0, x0); x < Math.min(width, x1); x++) {
        const edge = Math.min(x - x0, x1 - 1 - x, 0.9);
        p.paint(y * width + x, Math.min(1, edge), 236, 226, 210);
      }
    }
  }
  return { id, width, height, rgb: p.rgb, gt: p.gt };
}

/** Fur-like: a body plus many tapered strands. Exercises the partial-alpha and
 *  thin-structure paths that binary masks throw away. */
export function synthFur(width: number, height: number, id = 'fur'): Synthetic {
  const p = new Painter(width, height);
  paintBackground(p, 0xf0f0 + 7);
  const cx = width * 0.5, cy = height * 0.52;
  const R = Math.min(width, height);
  paintEllipse(p, cx, cy, R * 0.24, R * 0.3, [188, 142, 104]);
  const rnd = lcg(0x51ee9);
  const strands = Math.round(180 * (R / 512));
  for (let s = 0; s < strands; s++) {
    const ang = (s / strands) * Math.PI * 2;
    const len = R * (0.1 + rnd() * 0.12);
    const half = Math.max(0.6, R * 0.006);
    const x0 = cx + Math.cos(ang) * R * 0.2, y0 = cy + Math.sin(ang) * R * 0.26;
    const x1 = cx + Math.cos(ang) * (R * 0.2 + len), y1 = cy + Math.sin(ang) * (R * 0.26 + len);
    const steps = Math.max(2, Math.ceil(len / 0.9));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const px = x0 + (x1 - x0) * t, py = y0 + (y1 - y0) * t;
      const w = half * (1 - t);
      if (w <= 0.1) continue;
      const ix = Math.round(px), iy = Math.round(py);
      if (ix < 0 || iy < 0 || ix >= width || iy >= height) continue;
      p.paint(iy * width + ix, Math.min(1, w * 2), 226, 190, 150);
    }
  }
  return { id, width, height, rgb: p.rgb, gt: p.gt };
}

/** Similar foreground/background tones — the case where a threshold-based
 *  guided-select grows the wrong region (SPEC §4.4's documented weakness). */
export function synthLowContrast(width: number, height: number, id = 'low-contrast'): Synthetic {
  const p = new Painter(width, height);
  paintBackground(p, 0x10c07, [96, 108, 120]);
  paintDisc(p, width * 0.46, height * 0.5, Math.min(width, height) * 0.28, [110, 122, 134], 2.5);
  paintDisc(p, width * 0.62, height * 0.58, Math.min(width, height) * 0.1, [128, 138, 148], 2.5);
  return { id, width, height, rgb: p.rgb, gt: p.gt };
}

/** Two subjects: catches mask merging and the "did it keep the background
 *  subject" class of error. */
export function synthTwoSubjects(width: number, height: number, id = 'two-subjects'): Synthetic {
  const p = new Painter(width, height);
  paintBackground(p, 0x22055);
  const r = Math.min(width, height) * 0.2;
  paintDisc(p, width * 0.32, height * 0.5, r, WARM);
  paintDisc(p, width * 0.68, height * 0.46, r * 0.82, [150, 168, 190]);
  return { id, width, height, rgb: p.rgb, gt: p.gt };
}

/** Genuinely soft alpha: a radial ramp with no hard edge anywhere. Only this
 *  case can validate the soft-alpha metric, and it is the one that proves the
 *  float mask survives the pipeline instead of being thresholded to 0/1. */
export function synthSoftAlpha(width: number, height: number, id = 'soft-alpha'): Synthetic {
  const p = new Painter(width, height);
  paintBackground(p, 0x5017);
  const cx = width * 0.5, cy = height * 0.5;
  const rOut = Math.min(width, height) * 0.42, rIn = rOut * 0.6;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x - cx, y - cy);
      const a = 1 - smoothstep(rIn, rOut, d);
      p.paint(y * width + x, a, 226, 214, 198);
    }
  }
  return { id, width, height, rgb: p.rgb, gt: p.gt };
}

/** A small subject in a large frame: where a 512px working resolution turns
 *  the subject into a handful of pixels. */
export function synthSmallObject(width: number, height: number, id = 'small-object'): Synthetic {
  const p = new Painter(width, height);
  paintBackground(p, 0xbeef1);
  paintDisc(p, width * 0.5, height * 0.5, Math.min(width, height) * 0.025, [240, 196, 120]);
  return { id, width, height, rgb: p.rgb, gt: p.gt };
}