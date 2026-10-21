// Engine benchmarks: the DOM-free pixel and history operations, timed on the
// real exported functions.
//
// These are the numbers that tell you whether a regression is a model problem
// or OUR problem: the model is a constant, so a change in composite/brush/undo
// cost with the same model revision is a change in this codebase.

import {
  OpLog, applyBrushStroke, boxDownsampleRGB, composite, compositeOverlay, growRegion, packRGBA,
  refineEdges, transformSubject, upsampleAlphaBilinear, workingSize,
  type AlphaMask, type BrushStroke, type Effects, type ImageRef,
} from '@rmbg/engine';
import type { Bench } from '../record';
import { synthDisc } from '../synth';

export interface Size { label: string; w: number; h: number; mp: number }

/** Photo-realistic sizes. 4032x3024 is the iPhone/classic DSLR frame the SPEC
 *  names, so 12 MP is measured by default rather than as an extreme. */
export const SIZES: Record<string, Size> = {
  s05: { label: '0.26MP', w: 512, h: 512, mp: 0.26 },
  s2: { label: '1.9MP', w: 1600, h: 1200, mp: 1.92 },
  s12: { label: '12MP', w: 4032, h: 3024, mp: 12.19 },
  s24: { label: '24MP', w: 6000, h: 4000, mp: 24 },
  s50: { label: '50MP', w: 8000, h: 6250, mp: 50 },
};

export function sizesFor(mode: 'quick' | 'full' | 'stress'): Size[] {
  if (mode === 'quick') return [SIZES.s05, SIZES.s2];
  if (mode === 'full') return [SIZES.s05, SIZES.s2, SIZES.s12];
  return [SIZES.s05, SIZES.s2, SIZES.s12, SIZES.s24];
}

/** Cheap synthetic ImageRef + a plausible mask, so no suite needs a fixture
 *  file or a network download. Deterministic, hence comparable across runs. */
export function makeScene(w: number, h: number): { image: ImageRef; mask: AlphaMask } {
  const syn = synthDisc(w, h, `scene-${w}x${h}`);
  return { image: { id: `scene-${w}x${h}`, width: w, height: h, rgb: syn.rgb }, mask: { width: w, height: h, alpha: syn.gt } };
}

const FX_OFF: Effects = {
  shadow: { on: false, opacity: 0, blur: 0, dx: 0, dy: 0 },
  feather: 0, defringe: 0,
};
const FX_SHADOW: Effects = {
  shadow: { on: true, opacity: 0.35, blur: 4, dx: 6, dy: 8 },
  feather: 0, defringe: 0,
};

function stroke(w: number, h: number, size: number, points: number): BrushStroke {
  const pts = [];
  for (let i = 0; i < points; i++) {
    const t = i / Math.max(1, points - 1);
    pts.push({ x: w * (0.15 + 0.7 * t), y: h * (0.4 + 0.2 * Math.sin(t * Math.PI * 3)) });
  }
  return { points: pts, size, softness: 0.4 };
}

export async function runEngineSuite(bench: Bench, mode: 'quick' | 'full' | 'stress'): Promise<void> {
  const sizes = sizesFor(mode);
  const heavy = mode !== 'quick';

  for (const s of sizes) {
    const scene = makeScene(s.w, s.h);
    const px = s.w * s.h;

    // --- brush: the cost of a stroke, which is what "feels" laggy ---
    for (const [brushPx, points] of [[8, 24], [48, 60], [128, 40]] as const) {
      await bench.run('engine', 'brush', { size: s.label, mp: s.mp, brushPx, points }, async (c) => {
        // Each sample starts from a fresh clone: applyBrushStroke mutates in
        // place, so reusing the mask would let strokes accumulate into a
        // denser and denser blob and report a cost that is not a stroke's cost.
        await c.measure('strokeMs', 'ms', () => {
          const m = { width: s.w, height: s.h, alpha: new Float32Array(scene.mask.alpha) };
          return applyBrushStroke(m, stroke(s.w, s.h, brushPx, points), 'erase');
        }, { samples: heavy ? 3 : 5 });
        c.derived('areaPx', Math.round(px));
      });
    }

    // --- guided select (deterministic fallback) ---
    if (s.mp <= 12.2) {
      await bench.run('engine', 'growRegion', { size: s.label, mp: s.mp, threshold: 28 }, async (c) => {
        const grown = await c.measure('growMs', 'ms', () => {
          const g = growRegion(scene.image, s.w * 0.5, s.h * 0.52);
          return g;
        }, { samples: heavy ? 3 : 5 });
        if (grown) {
          c.derived('coverageRatio', +(grown.box.w * grown.box.h / px).toFixed(4));
          c.derived('truncated', grown.truncated);
          c.value('regionPx', 'px', grown.box.w * grown.box.h);
        }
      });
    }

    // --- finishing ops ---
    for (const [op, px_, heavyOps] of [
      ['feather', 2, true], ['defringe', 2, heavy && s.mp <= 2], ['both', 2, heavy && s.mp <= 2],
    ] as const) {
      await bench.run('engine', 'refineEdges', { size: s.label, mp: s.mp, op, px: px_ }, async (c) => {
        await c.measure('refineMs', 'ms', () => {
          const m: AlphaMask = { width: s.w, height: s.h, alpha: new Float32Array(scene.mask.alpha) };
          refineEdges(m, { feather: op === 'feather' || op === 'both' ? px_ : 0, defringe: op === 'defringe' || op === 'both' ? px_ : 0 });
          return m;
        }, { samples: heavyOps ? 2 : 4 });
      });
    }

    // --- composite: the dominant full-res cost in every interaction ---
    for (const [bgKind, fx] of [
      ['transparent', FX_OFF], ['color', FX_OFF], ['image', FX_OFF], ['transparent+shadow', FX_SHADOW],
    ] as const) {
      await bench.run('engine', 'composite', { size: s.label, mp: s.mp, bg: bgKind, shadow: fx.shadow.on }, async (c) => {
        const bg = bgKind === 'color'
          ? { kind: 'color' as const, color: [24, 32, 40] as [number, number, number] }
          : bgKind === 'image'
            ? { kind: 'image' as const, image: { id: 'bg', width: 64, height: 64, rgb: new Uint8ClampedArray(64 * 64 * 3).fill(90) } }
            : { kind: 'transparent' as const };
        const out = await c.measure('compositeMs', 'ms', () => composite(scene.image, scene.mask, bg, fx),
          { samples: heavy ? 2 : 4 });
        if (out) c.value('outputBytes', 'B', out.rgba.length);
      });
    }

    await bench.run('engine', 'compositeOverlay', { size: s.label, mp: s.mp }, async (c) => {
      await c.measure('overlayMs', 'ms', () => compositeOverlay(scene.image, scene.mask), { samples: heavy ? 2 : 4 });
    });

    // --- the non-model half of removeBackground: downsample + upsample ---
    await bench.run('engine', 'workingRoundTrip', { size: s.label, mp: s.mp }, async (c) => {
      const ws = workingSize(s.w, s.h);
      c.derived('workingW', ws.w);
      c.derived('workingH', ws.h);
      c.value('upscaleFactor', 'ratio', +(s.mp / ((ws.w * ws.h) / 1e6)).toFixed(2));
      await c.measure('downsampleMs', 'ms', () => boxDownsampleRGB(scene.image.rgb, s.w, s.h, ws.w, ws.h),
        { samples: heavy ? 3 : 5 });
      await c.measure('upsampleMs', 'ms', () =>
        upsampleAlphaBilinear(new Float32Array(ws.w * ws.h), ws.w, ws.h, s.w, s.h), { samples: heavy ? 2 : 4 });
    });

    await bench.run('engine', 'packRGBA', { size: s.label, mp: s.mp }, async (c) => {
      await c.measure('packMs', 'ms', () => packRGBA(scene.image.rgb), { samples: heavy ? 3 : 5 });
    });

    await bench.run('engine', 'clone', { size: s.label, mp: s.mp }, async (c) => {
      // Timed inside the measured call so throughput is derived from the same
      // clock as the duration, rather than from a separately-taken sample.
      await c.measure('cloneMs', 'ms', () => {
        const t = performance.now();
        const copy = new Float32Array(scene.mask.alpha);
        return { copy, ms: performance.now() - t };
      }, { samples: heavy ? 3 : 5 });
      // A Float32 copy is pure memory bandwidth — the floor under every full-res
      // operation in the editor, and the cheapest way to tell "this machine is
      // slow" apart from "this code is slow".
      c.derived('cloneBytes', scene.mask.alpha.byteLength);
    });

    if (s.mp <= 12.2) {
      await bench.run('engine', 'transform', { size: s.label, mp: s.mp, transform: 'scale0.8+rot7' }, async (c) => {
        await c.measure('transformMs', 'ms', () =>
          transformSubject(scene.image, scene.mask, { scale: 0.8, rotation: 7, dx: 12, dy: -6 }),
        { samples: heavy ? 2 : 4 });
      });
    }

    // --- history: undo cost AND what it retains ---
    await bench.run('engine', 'history', { size: s.label, mp: s.mp, entries: 30 }, async (c) => {
      // The log is built INSIDE the measured function. Reusing one across
      // samples would measure a log that already holds 30 entries, i.e. a
      // different (and larger) workload than the one being reported.
      const log = new OpLog();
      const depthAtEnd = await c.measure('commitMs', 'ms', () => {
        for (let i = 0; i < 30; i++) {
          log.commitRegion(scene.mask, `op-${i}`, (m) => {
            m.alpha[i % m.alpha.length] = i % 2 ? 0.2 : 0.9;
            return { x: i % 100, y: 0, w: 32, h: 32 };
          });
        }
        return log.depth;
      }, { samples: 1, warmups: 0 });
      // Depth and retained bytes are RESULTS, not samples: the byte budget is a
      // fixed 256MB, so what matters is whether eviction happened at all.
      c.derived('depthAfter30', depthAtEnd ?? null);
      c.derived('retainedMB', +(log.retainedBytes / 1048576).toFixed(2));
      await c.measure('undoRedoMs', 'ms', () => {
        for (let i = 0; i < 10; i++) log.undo();
        for (let i = 0; i < 10; i++) log.redo();
      }, { samples: 3, warmups: 1 });
      c.derived('finalDepth', log.depth);
      c.derived('canUndo', log.canUndo);
    });
  }
}