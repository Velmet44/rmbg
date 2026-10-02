import type {
  AlphaMask, BBox, ImageRef, ModelProgress, SegmentationAdapter, SegmentOpts, SubjectHint,
} from './types.js';
import { clampBox, cropRGB, packRGBA, pasteAlphaFeathered, upsampleAlphaBilinear } from './mask.js';
import { dbg, dbgTable, dbgWarn, now } from './log.js';

const SCOPE = 'adapter';

export type TransformersDevice = 'auto' | 'webgpu' | 'wasm';

/**
 * SegmentationAdapter backed by a Transformers.js `image-segmentation` pipeline.
 *
 * The runtime is loaded from a pinned CDN ESM build at runtime (never
 * vite-bundled: bundling the inference runtime has produced silently broken
 * sessions in verification). Everything still runs on-device: model bytes go
 * into the browser cache, image pixels never leave.
 * The library is dynamically imported inside init() so the rest of the
 * engine (and its unit tests) never load ONNX runtimes.
 */
export const DEFAULT_RUNTIME_URL =
  'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/+esm';

/** Cache bucket the Transformers.js runtime writes weights into (`env.cacheName`
 *  default). The app probes this bucket to answer "already cached?" before the
 *  session is built; hardcoding the string in the app meant a runtime change
 *  silently reported "not cached" forever and re-downloaded ~98 MB. Read back
 *  from the runtime after load (see `cacheName`) so drift is self-correcting. */
export const RUNTIME_CACHE_NAME = 'transformers-cache';

async function loadRuntime(url: string): Promise<any> {
  // @vite-ignore: absolute URL, resolved by the browser at runtime.
  return import(/* @vite-ignore */ url);
}

export class TransformersAdapter implements SegmentationAdapter {
  private seg: any = null;
  private RawImageCtor: any = null;
  private deviceUsed: string | null = null;
  // Single-flight: pipeline() for the same model must never run twice
  // concurrently (double download + Cache API write races can poison the
  // cached weights, producing silently broken sessions).
  private initPromise: Promise<void> | null = null;

  constructor(
    readonly modelId: string,
    private opts: {
      device?: TransformersDevice;
      dtype?: string;
      runtimeUrl?: string;
      /** Injected runtime loader (tests). Defaults to the pinned CDN ESM. */
      loadRuntime?: (url: string) => Promise<any>;
    } = {},
  ) {}

  get backend(): string | null { return this.deviceUsed; }

  /** Human-readable GPU description from probing (for UI + diagnostics). */
  gpuDescription: string = 'unknown';

  /** Cache bucket in force. Defaults to `RUNTIME_CACHE_NAME`; replaced with the
   *  runtime's own value once the library is loaded, so consumers (the app's
   *  pre-flight cache probe) never probe a bucket the runtime does not use. */
  cacheName: string = RUNTIME_CACHE_NAME;

  get runtimeUrl(): string { return this.opts.runtimeUrl ?? DEFAULT_RUNTIME_URL; }

  private runtime(): Promise<any> {
    const load = this.opts.loadRuntime ?? loadRuntime;
    return load(this.runtimeUrl);
  }

  async init(progress?: (p: ModelProgress) => void): Promise<void> {
    if (this.seg) return;
    if (!this.initPromise) {
      this.initPromise = this.doInit(progress).catch((e) => {
        // Allow retry after failure; concurrent callers share the rejection.
        this.initPromise = null;
        throw e;
      });
    }
    return this.initPromise;
  }

  private async doInit(progress?: (p: ModelProgress) => void): Promise<void> {
    const t0 = now();
    dbg(SCOPE, `init() begin · model=${this.modelId} · want=${this.opts.device ?? 'auto'} · runtime=${this.runtimeUrl}`);
    const { pipeline, RawImage, env } = await this.runtime();
    this.RawImageCtor = RawImage;
    if (env?.cacheName) this.cacheName = env.cacheName;
    dbg(SCOPE, `runtime module loaded in ${(now() - t0).toFixed(0)}ms · cacheBucket=${this.cacheName}`);
    const want = this.opts.device ?? 'auto';
    // Never benchmark-or-hang on a software rasterizer: SwiftShader/llvmpipe
    // can grind for tens of minutes instead of failing cleanly. Detect it
    // up front and go straight to WASM (the honest CPU path).
    // NOTE: probe the high-performance adapter with one retry — at page
    // load the GPU process may still be starting and Chrome can briefly
    // hand out a fallback (Basic Render Driver) adapter instead.
    let softwareGPU = false;
    let gpuDesc = 'unknown';
    if (want === 'auto') {
      const tp = now();
      const probe = await probeGPU();
      softwareGPU = probe.software;
      gpuDesc = probe.desc;
      this.gpuDescription = gpuDesc;
      dbgTable(SCOPE, `WebGPU probe took ${(now() - tp).toFixed(0)}ms`, {
        adapter: probe.desc, softwareRasterizer: probe.software,
        consequence: probe.software ? '→ straight to WASM fp32 (CPU)' : '→ try WebGPU fp16',
      });
    }
    const cb = progress
      ? (p: any) => {
          if (p.status === 'progress' && p.total) {
            progress({ status: 'progress', loaded: p.loaded ?? 0, total: p.total, file: p.file ?? p.name ?? 'model' });
          } else if (p.status === 'initiate' || p.status === 'download' || p.status === 'done') {
            progress({ status: p.status, file: p.file ?? p.name ?? 'model' });
          }
        }
      : undefined;
    // fp16 halves the download and suits WebGPU; WASM CPU stays on fp32
    // (fp16 CPU execution is unreliable across runtimes).
    const attempts = want === 'auto' && !softwareGPU
      ? [{ device: 'webgpu', dtype: 'fp16' }, { device: 'wasm', dtype: 'fp32' }]
      : want === 'auto'
        ? [{ device: 'wasm', dtype: 'fp32' }]
        : [{ device: want, dtype: this.opts.dtype ?? (want === 'webgpu' ? 'fp16' : 'fp32') }];
    let lastErr: unknown = null;
    for (const attempt of attempts) {
      const ts = now();
      dbg(SCOPE, `pipeline() attempt ${attempt.device}/${attempt.dtype} …`);
      try {
        this.seg = await pipeline('image-segmentation', this.modelId, {
          device: attempt.device as any,
          dtype: attempt.dtype as any,
          progress_callback: cb,
        });
        this.deviceUsed = `${attempt.device}/${attempt.dtype}`;
        dbg(SCOPE, `pipeline() OK in ${(now() - ts).toFixed(0)}ms · deviceUsed=${this.deviceUsed} · total init ${(now() - t0).toFixed(0)}ms`);
        return;
      } catch (e) {
        lastErr = e;
        this.seg = null;
        dbgWarn(SCOPE, `pipeline() failed after ${(now() - ts).toFixed(0)}ms on ${attempt.device}/${attempt.dtype}`, String(e));
      }
    }
    throw new Error(
      `TransformersAdapter: could not start ${this.modelId} (tried ${attempts.map((a) => `${a.device}/${a.dtype}`).join(', ')}): ${String(lastErr)}`,
    );
  }

  async segment(image: ImageRef, _opts: SegmentOpts): Promise<AlphaMask> {
    if (!this.seg) throw new Error('TransformersAdapter: init() first');
    const t0 = now();
    dbg(SCOPE, `segment() start · ${image.width}×${image.height} · backend=${this.deviceUsed} · gpu=${this.gpuDescription}`);
    try {
      const out = await this.runOnce(image);
      dbg(SCOPE, `segment() done in ${(now() - t0).toFixed(0)}ms · mask ${out.width}×${out.height}`);
      return out;
    } catch (e) {
      let err: unknown = e;
      dbgWarn(SCOPE, `segment() threw after ${(now() - t0).toFixed(0)}ms on ${this.deviceUsed}`, String(e));
      // Transient device loss on weak GPUs (MapAsync/bad_alloc): rebuild the
      // session once from cached files and retry before changing backends.
      if (this.deviceUsed?.startsWith('webgpu') && isDeviceLoss(String(e))) {
        dbg(SCOPE, 'looks like device loss — disposing and re-initialising once from cache');
        try {
          await this.dispose();
          await this.init();
          const out = await this.runOnce(image);
          dbg(SCOPE, `retry after device loss OK · total ${(now() - t0).toFixed(0)}ms`);
          return out;
        } catch (e2) {
          err = e2;
        }
      }
      if (!this.deviceUsed?.startsWith('webgpu')) throw err;
      // One automatic backend fallback: WebGPU execution can fail on
      // headless/weak GPUs even when session creation succeeds.
      // Fall through to WASM fp32 and retry once.
      dbgWarn(SCOPE, 'falling back to WASM fp32 — expect this run to be much slower');
      await this.dispose();
      try {
        const { pipeline, RawImage } = await this.runtime();
        this.RawImageCtor = RawImage;
        this.seg = await pipeline('image-segmentation', this.modelId, {
          device: 'wasm' as any,
          dtype: 'fp32' as any,
        });
        this.deviceUsed = 'wasm/fp32-fallback';
        const out = await this.runOnce(image);
        dbg(SCOPE, `wasm fallback done · total ${(now() - t0).toFixed(0)}ms`);
        return out;
      } catch (we) {
        throw new Error(
          `webgpu failed (${String(err).slice(0, 140)}); wasm fallback failed (${String(we).slice(0, 140)})`,
        );
      }
    }
  }

  private async runOnce(image: ImageRef): Promise<AlphaMask> {
    // NOTE: RawImage must carry 4 channels (RGBA), matching the library's own
    // fromURL/fromCanvas loaders. A packed-RGB 3-channel image silently yields
    // empty masks from the segmentation pipeline.
    const t0 = now();
    const rgba = packRGBA(image.rgb);
    const raw = new this.RawImageCtor(rgba, image.width, image.height, 4);
    dbg(SCOPE, `runOnce: RawImage ${image.width}×${image.height}×4 built in ${(now() - t0).toFixed(0)}ms — entering the pipeline`);
    const out = await this.seg(raw);
    const inferred = now() - t0;
    const best = pickBest(out);
    const mask = best.mask;
    const mw = mask.width as number, mh = mask.height as number;
    const data = mask.data as Uint8ClampedArray | Uint8Array;
    const alpha = new Float32Array(mw * mh);
    const channels = Math.round(data.length / (mw * mh));
    let sum = 0;
    for (let i = 0; i < mw * mh; i++) { alpha[i] = (data[i * channels] ?? data[i]) / 255; sum += alpha[i]; }
    dbgTable(SCOPE, `runOnce: pipeline returned in ${inferred.toFixed(0)}ms`, {
      input: `${image.width}×${image.height}`,
      maskOut: `${mw}×${mh}`,
      candidates: Array.isArray(out) ? out.length : 1,
      chosenScore: best.score ?? 'n/a',
      meanAlpha: +(sum / (mw * mh)).toFixed(4),
      note: Math.abs(sum / (mw * mh)) < 0.001 ? 'MASK LOOKS EMPTY' : '',
    });
    if (mw === image.width && mh === image.height) {
      return { width: mw, height: mh, alpha };
    }
    dbg(SCOPE, `upsampling mask ${mw}×${mh} → ${image.width}×${image.height} (bilinear)`);
    return {
      width: image.width,
      height: image.height,
      alpha: upsampleAlphaBilinear(alpha, mw, mh, image.width, image.height),
    };
  }

  async recomputeRegion(
    image: ImageRef, mask: AlphaMask, bbox: BBox, opts: { hint: SubjectHint },
  ): Promise<AlphaMask> {
    // Re-run with surrounding context, then patch only the bbox.
    const t0 = now();
    const pad = Math.round(Math.max(bbox.w, bbox.h) * 0.35);
    const ctx = clampBox(
      { x: bbox.x - pad, y: bbox.y - pad, w: bbox.w + pad * 2, h: bbox.h + pad * 2 },
      image.width, image.height,
    );
    dbg(SCOPE, `recomputeRegion · bbox=${bbox.x},${bbox.y} ${bbox.w}×${bbox.h} · pad=${pad} → crop ${ctx.w}×${ctx.h} (${(100 * ctx.w * ctx.h / (image.width * image.height)).toFixed(1)}% of the image)`);
    const crop = cropRGB(image, ctx);
    const fresh = await this.segment(crop, { hint: opts.hint, tier: 'quality' });
    const next: AlphaMask = {
      width: mask.width, height: mask.height, alpha: new Float32Array(mask.alpha),
    };
    const inner = {
      x: bbox.x - ctx.x, y: bbox.y - ctx.y,
      w: Math.min(bbox.w, fresh.width - (bbox.x - ctx.x)),
      h: Math.min(bbox.h, fresh.height - (bbox.y - ctx.y)),
    };
    const patch: AlphaMask = {
      width: Math.max(1, inner.w), height: Math.max(1, inner.h),
      alpha: cropPatch(fresh, inner.x, inner.y, Math.max(1, inner.w), Math.max(1, inner.h)),
    };
    pasteAlphaFeathered(next, patch, bbox.x, bbox.y, 6);
    dbg(SCOPE, `recomputeRegion done in ${(now() - t0).toFixed(0)}ms · patched only the bbox with a 6px blend`);
    return next;
  }

  async dispose(): Promise<void> {
    dbg(SCOPE, `dispose() · was ${this.deviceUsed ?? 'nothing'}`);
    if (this.seg?.dispose) await this.seg.dispose();
    this.seg = null;
    // Clear the single-flight so a later init() genuinely rebuilds.
    // Without this, init-after-dispose silently no-ops and segment()
    // throws 'init() first' on a disposed adapter.
    this.initPromise = null;
    this.deviceUsed = null;
  }
}

/** Transient GPU failure signatures worth one session rebuild before giving up. */
function isDeviceLoss(msg: string): boolean {
  return /MapAsync|bad_alloc|ERROR_CODE:\s*6|device lost|device removed/i.test(msg);
}

/** Probe for a real GPU. Requests the high-performance adapter (avoids the
 *  fallback/Basic-Render-Driver pick) and retries once after a pause, since
 *  at page load the GPU process may not be ready yet. */
export async function probeGPU(): Promise<{ software: boolean; desc: string }> {
  const read = async (): Promise<{ software: boolean; desc: string } | null> => {
    try {
      const adapter = await (navigator as any).gpu?.requestAdapter?.({ powerPreference: 'high-performance' });
      if (!adapter) {
        dbgWarn(SCOPE, 'requestAdapter returned nothing → no WebGPU, will run on CPU');
        return { software: true, desc: 'no WebGPU adapter' };
      }
      const info = adapter?.info || {};
      const desc =
        info.description || info.device || [info.vendor, info.architecture].filter(Boolean).join(' ') || 'gpu';
      const software = /swiftshader|llvmpipe|software|basic render/i.test(
        `${info.device || ''} ${info.architecture || ''} ${info.description || ''} ${info.vendor || ''}`,
      );
      dbg(SCOPE, `adapter info ${JSON.stringify(info)} → software=${software}`);
      return { software, desc: software ? `${desc} (software)` : desc };
    } catch (e) {
      dbgWarn(SCOPE, 'requestAdapter threw', String(e));
      return { software: true, desc: 'WebGPU unavailable' };
    }
  };
  const t0 = now();
  const first = await read();
  if (first && !first.software) return first;
  // Possible early-load fallback adapter: wait for the GPU process, retry once.
  dbg(SCOPE, `first probe returned software/no adapter — waiting 3s and retrying once (${(now() - t0).toFixed(0)}ms so far)`);
  await new Promise((r) => setTimeout(r, 3000));
  const second = await read();
  dbg(SCOPE, `second probe: ${second?.desc ?? 'null'} (total ${(now() - t0).toFixed(0)}ms)`);
  return second ?? first ?? { software: true, desc: 'WebGPU unavailable' };
}

function pickBest(out: any): any {  const list = Array.isArray(out) ? out : [out];
  if (list.length === 0) throw new Error('TransformersAdapter: empty model output');
  let best = list[0];
  for (const c of list) {
    if ((c.score ?? 0) > (best.score ?? 0)) best = c;
  }
  if (!best?.mask) throw new Error('TransformersAdapter: output has no mask');
  return best;
}

function cropPatch(m: AlphaMask, x: number, y: number, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const sx = Math.min(m.width - 1, Math.max(0, x + xx));
      const sy = Math.min(m.height - 1, Math.max(0, y + yy));
      out[yy * w + xx] = m.alpha[sy * m.width + sx];
    }
  }
  return out;
}
