// Inference benchmarks: the real worker, the real adapter, the real model.
//
// This is the only suite that can be slow (it may download ~98MB of weights) and
// the only one whose numbers depend on the machine's GPU. Three things it is
// careful about:
//
//  * COLD vs WARM are separate cases, never one number. A cold figure is mostly
//    the network; a warm figure is mostly the hardware. Averaging them produces
//    a number that describes neither.
//  * The backend is whatever the worker REPORTS for the call that produced the
//    mask, not what init requested. The adapter falls back WebGPU -> WASM on
//    execution failure, and a CPU pass labelled "GPU" is worse than no number.
//  * A cache wipe is opt-in and says exactly what it deletes.

import { RUNTIME_CACHE_NAME, WORKING_LONG_SIDE, workingSize } from '@rmbg/engine';
import type { Bench } from '../record';
import { safeText } from '../record';
import { MODEL_ID, MODEL_REV, MODEL_WEIGHTS_RE } from '../../model-config';
import type {
  WorkerMaskMessage, WorkerReadyMessage, WorkerRequest, WorkerResponse,
} from '../../worker-protocol';
import type { AlphaMask, BBox, ImageRef } from '@rmbg/engine';
import { corpusCoverage, corpusForMode } from '../corpus';
import { alphaMae, alphaStats, bestOrientation, binaryScores, binarize, boundaryF, coverage, maxAbsDiff } from '../score';
import type { Mode } from '../types';

export interface InitPhases {
  totalMs: number;
  /** Time until the first progress event: the pinned CDN runtime fetch. */
  runtimeMs: number | null;
  /** First progress event -> last byte event: the weights download. */
  downloadMs: number | null;
  /** Last byte event -> init resolved: graph compile + memory planning. */
  sessionMs: number | null;
  bytesTotal: number | null;
  bytesByFile: Record<string, number>;
  sawByteEvents: boolean;
  backend: string | null;
  gpu: string;
  cacheName: string;
}

/** Minimal client for the worker protocol. Not a copy of main.ts's client:
 *  that one also owns session epochs, the crash latch and UI state, none of
 *  which belong in a measurement tool. The WIRE FORMAT is shared, via
 *  src/worker-protocol.ts. */
class BenchWorker {
  private worker: Worker;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; onProgress?: (m: any) => void }>();
  dead = false;

  constructor() {
    this.worker = new Worker(new URL('../../infer-worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const m = e.data;
      if (m?.type === 'progress') {
        this.pending.forEach((p) => p.onProgress?.(m));
        return;
      }
      const p = this.pending.get((m as { id: number }).id);
      if (!p) return;
      this.pending.delete((m as { id: number }).id);
      if (m.type === 'error') p.reject(new Error(m.message));
      else p.resolve(m);
    };
    this.worker.onerror = (e: ErrorEvent) => {
      // Carry whatever detail the event gives. A bare "worker error" cannot be
      // acted on, and the usual causes are very different from each other: the
      // worker chunk 404s, the pinned CDN runtime is unreachable, or the
      // weights download was refused.
      const detail = [e.message, (e as unknown as { filename?: string }).filename]
        .filter(Boolean).join(' — ');
      this.failAll(new Error(detail ? `worker failed to load: ${detail}` : 'worker failed to load (no detail from the browser)'));
    };
  }

  private failAll(e: Error): void {
    this.dead = true;
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }

  send<T>(msg: WorkerRequest, transfer: Transferable[] = [], onProgress?: (m: any) => void): Promise<T> {
    if (this.dead) return Promise.reject(new Error('worker is dead'));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  init(onProgress?: (m: any) => void): Promise<WorkerReadyMessage> {
    return this.send<WorkerReadyMessage>({ type: 'init' }, [], onProgress);
  }

  async segment(image: ImageRef): Promise<{ mask: AlphaMask; backend: string | null; gpu: string }> {
    const copy = new Uint8ClampedArray(image.rgb);
    const msg = await this.send<WorkerMaskMessage>(
      { type: 'segment', imageId: image.id, w: image.width, h: image.height, rgb: copy.buffer },
      [copy.buffer],
    );
    return {
      mask: { width: msg.w, height: msg.h, alpha: new Float32Array(msg.alpha) },
      backend: msg.backend, gpu: msg.gpu,
    };
  }

  async recomputeRegion(image: ImageRef, mask: AlphaMask, bbox: BBox): Promise<{ mask: AlphaMask; backend: string | null }> {
    const rgb = new Uint8ClampedArray(image.rgb);
    const alpha = new Float32Array(mask.alpha);
    const msg = await this.send<WorkerMaskMessage>({
      type: 'recompute', imageId: image.id, w: image.width, h: image.height,
      rgb: rgb.buffer, mw: mask.width, mh: mask.height, alpha: alpha.buffer, bbox,
    }, [rgb.buffer, alpha.buffer]);
    return { mask: { width: msg.w, height: msg.h, alpha: new Float32Array(msg.alpha) }, backend: msg.backend };
  }

  dispose(): void { this.worker.terminate(); this.failAll(new Error('disposed')); }
}

async function initPhases(bench: Bench, worker: BenchWorker, label: string): Promise<InitPhases | null> {
  const t0 = performance.now();
  let firstProgress: number | null = null;
  let lastByte: number | null = null;
  const bytesByFile: Record<string, number> = {};
  let sawByteEvents = false;
  try {
    const ready = await worker.init((m) => {
      const now = performance.now();
      if (firstProgress === null) firstProgress = now;
      if (m.status === 'progress' && m.total) {
        sawByteEvents = true;
        lastByte = now;
        bytesByFile[m.file] = m.total;
      }
    });
    const end = performance.now();
    const bytesTotal = Object.values(bytesByFile).reduce((a, b) => a + b, 0) || null;
    return {
      totalMs: end - t0,
      runtimeMs: firstProgress === null ? null : firstProgress - t0,
      downloadMs: firstProgress === null || lastByte === null ? null : lastByte - firstProgress,
      sessionMs: lastByte === null ? null : end - lastByte,
      bytesTotal, bytesByFile, sawByteEvents,
      backend: ready.backend, gpu: ready.gpu, cacheName: ready.cacheName,
    };
  } catch (e) {
    await bench.run('model', 'init', { phase: label }, (c) => {
      // Record the failure WITH its explanation. A bare error here reads as a
      // broken benchmark; the usual causes are environmental and the person
      // reading the report is the only one who can tell them apart.
      c.derived('modelStarted', false);
      c.note(
        'The model did not start, so NO segmentation or quality case was produced — '
        + 'this report contains editor and memory measurements only. Usual causes, in order: '
        + '(1) the pinned CDN runtime (jsdelivr) or huggingface.co is unreachable from this '
        + 'machine or blocked by an extension/ad blocker; '
        + '(2) the ~98MB weights download was refused or interrupted; '
        + '(3) the worker chunk itself failed to load. Check the browser console and the '
        + 'Network panel for the failing request.',
      );
      throw e;
    });
    return null;
  }
}

export interface InferenceOptions {
  /** Delete the model's cache bucket first, so the cold path is measured.
   *  Opt-in, and the UI must say what it deletes. */
  cold: boolean;
  signal: { cancelled: boolean };
  onLog?: (msg: string) => void;
}

export async function runInferenceSuite(
  bench: Bench, mode: Mode, opts: InferenceOptions,
): Promise<{ modelId: string; revision: string; backend: string | null; workingLongSide: number }> {
  const log = opts.onLog ?? (() => {});
  const cacheName = RUNTIME_CACHE_NAME;

  // --- pre-flight: what is actually in the cache right now ---
  let cachedBefore = false;
  try {
    const cache = await caches.open(cacheName);
    for (const req of await cache.keys()) {
      if (MODEL_WEIGHTS_RE.test(req.url)) { cachedBefore = true; break; }
    }
  } catch {
    /* no Cache API: the case below records the verdict as unknown */
  }
  bench.run('model', 'cacheState', { cache: opts.cold ? 'cold-forced' : cachedBefore ? 'warm' : 'cold' }, async (c) => {
    c.derived('weightsCachedBefore', cachedBefore);
    c.derived('cacheBucket', cacheName);
    c.derived('cacheProbeWorked', typeof caches !== 'undefined');
  });

  if (opts.cold) {
    // Only the app's own model bucket, never the whole origin's storage.
    try { await caches.delete(cacheName); log('cache: deleted the model bucket'); } catch { /* ignore */ }
  }

  const worker = new BenchWorker();

  const cacheLabel = opts.cold ? 'cold' : cachedBefore ? 'warm' : 'cold-network';

  // --- init, with the phases split apart ---
  const phases = await initPhases(bench, worker, cacheLabel);
  if (!phases) {
    worker.dispose();
    bench.note('inference suite stopped after the init failure: no segmentation, quality or recompute case ran.');
    return { modelId: MODEL_ID, revision: MODEL_REV, backend: null, workingLongSide: WORKING_LONG_SIDE };
  }
  bench.run('model', 'init', { cache: cacheLabel }, async (c) => {
    c.value('initMs', 'ms', +phases.totalMs.toFixed(2), 'performance.now around the worker init round trip');
    if (phases.runtimeMs !== null) c.value('runtimeMs', 'ms', +phases.runtimeMs.toFixed(2));
    if (phases.downloadMs !== null) {
      c.value('downloadMs', 'ms', +phases.downloadMs.toFixed(2));
      c.value('downloadedBytes', 'B', phases.bytesTotal, 'transformers-progress-total');
    }
    if (phases.sessionMs !== null) c.value('sessionMs', 'ms', +phases.sessionMs.toFixed(2));
    c.derived('backend', phases.backend ?? 'unknown');
    c.derived('sawByteEvents', phases.sawByteEvents);
    c.derived('files', Object.keys(phases.bytesByFile).length);
    if (!phases.sawByteEvents) {
      c.note('no byte events: the weights were already cached, so there is no download time to report');
    }
    c.derived('cacheBucket', phases.cacheName);
  });

  // --- single-flight reuse: a second init must be a no-op, not a rebuild ---
  await bench.run('model', 'reuse', { cache: cacheLabel }, async (c) => {
    await c.measureAsync('secondInitMs', 'ms', () => worker.init(), { samples: 3, warmups: 0 });
  });

  // --- segment + quality per corpus case ---
  const cases = corpusForMode(mode);
  const passes = mode === 'quick' ? 1 : mode === 'full' ? 2 : 3;
  let backend = phases.backend;

  for (const corpusCase of cases) {
    if (opts.signal.cancelled) break;
    const syn = corpusCase.make();
    const image: ImageRef = { id: `corpus:${corpusCase.id}`, width: syn.width, height: syn.height, rgb: syn.rgb };
    const ws = workingSize(syn.width, syn.height);
    // Held in an object and read through a function: TypeScript's control-flow
    // analysis cannot see an assignment made inside the measured closure, so a
    // bare `let` would narrow to `never` here and hide real type errors.
    const holder: { mask: AlphaMask | null; backend: string | null } = { mask: null, backend: null };
    const result = (): { mask: AlphaMask | null; backend: string | null } => holder;

    await bench.run('inference', 'segment', {
      case: corpusCase.id, mp: +(syn.width * syn.height / 1e6).toFixed(2),
      cache: 'warm', backend: phases.backend ?? 'unknown',
    }, async (c) => {
      const out = await c.measureAsync('roundTripMs', 'ms', async () => {
        const r = await worker.segment(image);
        holder.mask = r.mask;
        holder.backend = r.backend;
        return r;
      }, { samples: passes, warmups: 1 });
      if (!out) return;
      c.derived('backend', holder.backend ?? 'unknown');
      c.derived('inW', syn.width); c.derived('inH', syn.height);
      c.derived('workingW', ws.w); c.derived('workingH', ws.h);
      c.derived('outW', out.mask.width); c.derived('outH', out.mask.height);
      c.derived('upscaleFactor', +((syn.width * syn.height) / (ws.w * ws.h)).toFixed(2));
    });

    backend = result().backend ?? backend;

    const mask = result().mask;
    if (!mask) continue;

    // --- quality against the construction-exact reference ---
    await bench.run('quality', 'mask', {
      case: corpusCase.id, kind: corpusCase.kind, threshold: 0.5,
    }, async (c) => {
      if (mask.width !== syn.width || mask.height !== syn.height) {
        c.derived('dimensionMismatch', true);
        c.note(`mask ${mask.width}x${mask.height} does not match the image ${syn.width}x${syn.height}`);
        return;
      }
      const p = binarize(mask.alpha, 0.5);
      const t = binarize(syn.gt, 0.5);
      const s = binaryScores(p, t);
      const bf = boundaryF(p, t, mask.width, mask.height, 2);
      const soft = corpusCase.categories.includes('soft-alpha');
      const orient = bestOrientation(mask.alpha, syn.gt, mask.width, mask.height);
      c.value('iou', 'score', +s.iou.toFixed(4));
      c.value('dice', 'score', +s.dice.toFixed(4));
      c.value('precision', 'score', +s.precision.toFixed(4));
      c.value('recall', 'score', +s.recall.toFixed(4));
      c.value('boundaryF2px', 'score', +bf.f.toFixed(4));
      c.derived('boundaryF2pxTolerance', bf.tolPx);
      if (soft) {
        c.value('alphaMae', 'score', +alphaMae(mask.alpha, syn.gt).toFixed(5));
        c.value('truthMeanAlpha', 'score', +alphaStats(mask.alpha, syn.gt).truthMean.toFixed(4));
      }
      const st = alphaStats(mask.alpha, syn.gt);
      c.value('predMeanAlpha', 'score', +st.predMean.toFixed(4));
      c.value('coverage', 'ratio', +coverage(mask.alpha).toFixed(4));
      c.value('truthCoverage', 'ratio', +coverage(syn.gt).toFixed(4));
      c.derived('bestOrientation', orient.best);
      c.derived('orientationOk', orient.best === 'identity');
      c.derived('emptyMask', st.predMean < 0.001);
      c.derived('categories', corpusCase.categories.join(','));
      if (corpusCase.note) c.note(corpusCase.note);
      // Interpretation guard, so a low score is never misread as a bug here.
      c.note('Synthetic input: a low IoU indicates MODEL behaviour on an out-of-distribution shape, not a pipeline fault. Use orientationOk, dimensionMismatch and emptyMask for pipeline health.');
    });

    // --- determinism: the same input must produce the same mask ---
    if (mode !== 'quick') {
      await bench.run('quality', 'determinism', { case: corpusCase.id }, async (c) => {
        const again = await worker.segment(image);
        const diff = maxAbsDiff(mask.alpha, again.mask.alpha);
        c.value('maxAbsDiff', 'score', +diff.toFixed(8));
        c.derived('bitIdentical', diff === 0);
        c.derived('closeWithin001', diff <= 0.001);
      });
    }
  }

  // --- region recompute at three box sizes ---
  const syn = cases[0]?.make();
  if (syn) {
    const image: ImageRef = { id: 'corpus:recompute', width: syn.width, height: syn.height, rgb: syn.rgb };
    const base = await worker.segment(image);
    for (const frac of [0.05, 0.2, 0.5]) {
      const w = Math.max(8, Math.round(syn.width * frac));
      const h = Math.max(8, Math.round(syn.height * frac));
      const bbox: BBox = {
        x: Math.round((syn.width - w) / 2), y: Math.round((syn.height - h) / 2), w, h,
      };
      await bench.run('inference', 'recompute', {
        case: 'centre', boxFrac: frac, backend: base.backend ?? 'unknown', cache: 'warm',
      }, async (c) => {
        const r = await c.measureAsync('roundTripMs', 'ms', async () =>
          worker.recomputeRegion(image, base.mask, bbox), { samples: 2, warmups: 0 });
        if (!r) return;
        const inside = w * h / (syn.width * syn.height);
        c.derived('boxPx', w * h);
        c.derived('fractionOfImage', +inside.toFixed(4));
        c.derived('outW', r.mask.width);
        c.derived('outH', r.mask.height);
        c.derived('backend', r.backend ?? 'unknown');
        // The contract that matters: outside the box the mask must be untouched.
        const outsideUnchanged = compareOutside(r.mask.alpha, base.mask.alpha, bbox, syn.width, syn.height);
        c.derived('outsideBoxBitIdentical', outsideUnchanged);
        c.derived('insideChanged', maxAbsDiff(
          r.mask.alpha, base.mask.alpha,
        ) > 0);
      });
    }
  }

  // --- dispose + re-init from cache: the adapter's single-flight contract ---
  await bench.run('model', 'disposeReinit', { cache: 'warm' }, async (c) => {
    worker.dispose();
    const w2 = new BenchWorker();
    try {
      const p = await initPhases(bench, w2, 'warm-reinit');
      if (p) {
        c.value('reinitMs', 'ms', +p.totalMs.toFixed(2));
        c.derived('backend', p.backend ?? 'unknown');
        c.derived('sawByteEvents', p.sawByteEvents);
      }
    } finally {
      w2.dispose();
    }
  });

  // --- what the corpus does and does not cover ---
  bench.run('quality', 'coverage', { corpus: 'synthetic' }, async (c) => {
    const cov = corpusCoverage(cases);
    for (const v of cov) {
      c.derived(`covers_${v.category.replace(/[^a-z]/g, '')}`, v.automated);
    }
    c.value('automatedCategories', 'count', cov.filter((v) => v.automated).length);
    c.value('totalCategories', 'count', cov.length);
    c.note('Categories with automated ground truth. Photographic hair, fur, glasses transparency and fingers are NOT covered — see benchmarks/corpus/README.md.');
  });

  return { modelId: MODEL_ID, revision: MODEL_REV, backend, workingLongSide: WORKING_LONG_SIDE };
}

/** Region recompute promises that only the bbox changes (SPEC §4.2). Verified
 *  here rather than trusted, because a patch that leaked one pixel outward would
 *  be invisible in the editor and irreversible. */
function compareOutside(
  next: Float32Array, prev: Float32Array, box: BBox, w: number, h: number,
): boolean {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h) continue;
      if (next[y * w + x] !== prev[y * w + x]) return false;
    }
  }
  return true;
}

export function describeModelError(e: unknown): string {
  return safeText(e);
}