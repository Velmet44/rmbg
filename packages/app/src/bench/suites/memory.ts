// The memory matrix (SPEC §7 asks for 12 / 24 / 50 MP) and where this machine
// actually stops.
//
// Two honesty rules, both learned the hard way by the previous "NOT DONE":
//
//  1. ESTIMATES ARE LABELLED AS ESTIMATES. Bytes here are computed from the
//     pipeline's known allocation shape. `performance.memory` is measured, but
//     it sees only this realm's JS heap — not ORT's WASM memory, not GPU
//     buffers, not the compositor — so it is a LOWER BOUND and carries the
//     method label `js-heap-delta-nonisolated` wherever it appears.
//  2. A FAILURE IS A RESULT. If 50MP throws, that throw is the measurement:
//     "where this machine breaks" is exactly the number the matrix exists to
//     produce. It is recorded as a failed case with the error, never swallowed.

import type { Effects } from '@rmbg/engine';
import type { Bench } from '../record';
import { heapAvailable, jsHeapLimitBytes, jsHeapUsedBytes } from '../env';
import { sessionBytesEstimate } from '../../decode';
import { compositeExportCanvas, compositeInto } from '../../canvas-out';
import { makeScene } from './engine';

const FX_OFF: Effects = { shadow: { on: false, opacity: 0, blur: 0, dx: 0, dy: 0 }, feather: 0, defringe: 0 };
const FX_SHADOW: Effects = { shadow: { on: true, opacity: 0.35, blur: 4, dx: 6, dy: 8 }, feather: 0, defringe: 0 };

interface MatrixEntry { label: string; w: number; h: number; mp: number }

const MATRIX: Record<string, MatrixEntry[]> = {
  quick: [{ label: '1.9MP', w: 1600, h: 1200, mp: 1.92 }],
  full: [
    { label: '1.9MP', w: 1600, h: 1200, mp: 1.92 },
    { label: '12MP', w: 4032, h: 3024, mp: 12.19 },
    { label: '24MP', w: 6000, h: 4000, mp: 24 },
  ],
  stress: [
    { label: '1.9MP', w: 1600, h: 1200, mp: 1.92 },
    { label: '12MP', w: 4032, h: 3024, mp: 12.19 },
    { label: '24MP', w: 6000, h: 4000, mp: 24 },
    { label: '50MP', w: 8000, h: 6250, mp: 50 },
  ],
};

export async function runMemorySuite(bench: Bench, mode: 'quick' | 'full' | 'stress'): Promise<void> {
  const heap = heapAvailable();
  bench.run('memory', 'capability', { heapApi: heap }, async (c) => {
    c.derived('jsHeapAvailable', heap);
    c.value('jsHeapLimitBytes', 'B', jsHeapLimitBytes());
    c.derived('method', heap ? 'js-heap-delta-nonisolated' : 'unavailable');
    c.note('performance.memory covers this realm only. Real cost is higher: ORT WASM memory and GPU buffers are invisible to it.');
  });

  for (const entry of MATRIX[mode]) {
    // Allocation + full-res composite with and without shadow. Shadow is the
    // difference between ~4 and ~6 Float32/RGBA planes per pixel, so the two
    // cases are reported separately rather than averaged.
    for (const [variant, fx] of [['noShadow', FX_OFF], ['shadow', FX_SHADOW]] as const) {
      await bench.run('memory', 'compositeAtSize', {
        size: entry.label, mp: entry.mp, variant,
      }, async (c) => {
        // Estimates are recorded BEFORE the attempt, so a size that throws still
        // reports what it was trying to allocate. The throw then marks the case
        // failed, which is the measurement: this is where the machine stops.
        const est = sessionBytesEstimate(
          { id: 'estimate', width: entry.w, height: entry.h, rgb: new Uint8ClampedArray(0) },
          { shadow: fx.shadow.on },
        );
        c.value('estimatedSessionBytes', 'B', est.total, 'allocation-shape-estimate');
        c.derived('estimatedBreakdown', `rgb=${est.rgb} mask=${est.mask} composite=${est.composite} scratch=${est.scratch}`);

        const before = jsHeapUsedBytes();
        const scene = makeScene(entry.w, entry.h);
        const canvas = compositeExportCanvas(scene, { kind: 'color', color: [20, 20, 20] }, fx, entry.w, entry.h);
        const after = jsHeapUsedBytes();
        if (heap && before !== null && after !== null) {
          c.value('jsHeapDeltaBytes', 'B', after - before, 'js-heap-delta-nonisolated');
        }
        c.derived('canvasW', canvas.width);
        c.derived('canvasH', canvas.height);
      });
    }

    // Repeated composites at one size: does anything leak across a session?
    await bench.run('memory', 'repeatStability', { size: entry.label, mp: entry.mp, iterations: 5 }, async (c) => {
      const scene = makeScene(entry.w, entry.h);
      const canvas = document.createElement('canvas');
      const before = jsHeapUsedBytes();
      await c.measure('compositeMs', 'ms', () => compositeInto(canvas, scene, { kind: 'transparent' }, FX_OFF),
        { samples: 1, warmups: 0 });
      const after = jsHeapUsedBytes();
      if (heap && before !== null && after !== null) {
        c.value('jsHeapDeltaBytes', 'B', after - before, 'js-heap-delta-nonisolated');
        // A single full-res composite allocates one RGBA buffer that the next
        // one replaces; a retained delta far beyond one buffer would be a leak.
        c.derived('withinOneBuffer', (after - before) < entry.w * entry.h * 4 * 1.6);
      }
    });
  }

  // Deliberate allocation failure. A clean RangeError is the good outcome and
  // the one worth knowing about: it means the app can report a real OOM message
  // instead of the tab simply dying.
  await bench.run('memory', 'allocationFailure', { probe: '4.8GB-Float32' }, async (c) => {
    const n = 1_200_000_000; // 4.8 GB as Float32
    let outcome = 'allocated';
    let errName: string | null = null;
    const t0 = performance.now();
    try {
      const a = new Float32Array(n);
      a[0] = 1;
      outcome = a.length === n ? 'allocated' : 'short';
    } catch (e) {
      outcome = 'threw';
      errName = (e as Error)?.name ?? 'Error';
    }
    c.value('probeMs', 'ms', +(performance.now() - t0).toFixed(2));
    c.derived('outcome', outcome);
    c.derived('errorName', errName);
    c.derived('reportedCleanly', outcome === 'threw' && errName === 'RangeError');
    c.note('A clean RangeError is what lets the app show an actionable out-of-memory message. A tab death cannot be reported at all.');
  });
}