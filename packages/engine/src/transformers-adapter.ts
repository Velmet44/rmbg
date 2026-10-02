import type {
  AlphaMask, BBox, ImageRef, ModelProgress, SegmentationAdapter, SegmentOpts, SubjectHint,
} from './types.js';
import { clampBox, cropRGB, packRGBA, pasteAlphaFeathered, upsampleAlphaBilinear } from './mask.js';

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
    const { pipeline, RawImage, env } = await this.runtime();
    this.RawImageCtor = RawImage;
    if (env?.cacheName) this.cacheName = env.cacheName;
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
      const probe = await probeGPU();
      softwareGPU = probe.software;
      gpuDesc = probe.desc;
      this.gpuDescription = gpuDesc;
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
      try {
        this.seg = await pipeline('image-segmentation', this.modelId, {
          device: attempt.device as any,
          dtype: attempt.dtype as any,
          progress_callback: cb,
        });
        this.deviceUsed = `${attempt.device}/${attempt.dtype}`;
        return;
      } catch (e) {
        lastErr = e;
        this.seg = null;
      }
    }
    throw new Error(
      `TransformersAdapter: could not start ${this.modelId} (tried ${attempts.map((a) => `${a.device}/${a.dtype}`).join(', ')}): ${String(lastErr)}`,
    );
  }

  async segment(image: ImageRef, _opts: SegmentOpts): Promise<AlphaMask> {
    if (!this.seg) throw new Error('TransformersAdapter: init() first');
    try {
      return await this.runOnce(image);
    } catch (e) {
      let err: unknown = e;
      // Transient device loss on weak GPUs (MapAsync/bad_alloc): rebuild the
      // session once from cached files and retry before changing backends.
      if (this.deviceUsed?.startsWith('webgpu') && isDeviceLoss(String(e))) {
        try {
          await this.dispose();
          await this.init();
          return await this.runOnce(image);
        } catch (e2) {
          err = e2;
        }
      }
      if (!this.deviceUsed?.startsWith('webgpu')) throw err;
      // One automatic backend fallback: WebGPU execution can fail on
      // headless/weak GPUs even when session creation succeeds.
      // Fall through to WASM fp32 and retry once.
      await this.dispose();
      try {
        const { pipeline, RawImage } = await this.runtime();
        this.RawImageCtor = RawImage;
        this.seg = await pipeline('image-segmentation', this.modelId, {
          device: 'wasm' as any,
          dtype: 'fp32' as any,
        });
        this.deviceUsed = 'wasm/fp32-fallback';
        return await this.runOnce(image);
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
    const rgba = packRGBA(image.rgb);
    const raw = new this.RawImageCtor(rgba, image.width, image.height, 4);
    const out = await this.seg(raw);
    const best = pickBest(out);
    const mask = best.mask;
    const mw = mask.width as number, mh = mask.height as number;
    const data = mask.data as Uint8ClampedArray | Uint8Array;
    const alpha = new Float32Array(mw * mh);
    const channels = Math.round(data.length / (mw * mh));
    for (let i = 0; i < mw * mh; i++) alpha[i] = (data[i * channels] ?? data[i]) / 255;
    if (mw === image.width && mh === image.height) {
      return { width: mw, height: mh, alpha };
    }
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
    const pad = Math.round(Math.max(bbox.w, bbox.h) * 0.35);
    const ctx = clampBox(
      { x: bbox.x - pad, y: bbox.y - pad, w: bbox.w + pad * 2, h: bbox.h + pad * 2 },
      image.width, image.height,
    );
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
    return next;
  }

  async dispose(): Promise<void> {
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
      if (!adapter) return { software: true, desc: 'no WebGPU adapter' };
      const info = adapter?.info || {};
      const desc =
        info.description || info.device || [info.vendor, info.architecture].filter(Boolean).join(' ') || 'gpu';
      const software = /swiftshader|llvmpipe|software|basic render/i.test(
        `${info.device || ''} ${info.architecture || ''} ${info.description || ''} ${info.vendor || ''}`,
      );
      return { software, desc: software ? `${desc} (software)` : desc };
    } catch {
      return { software: true, desc: 'WebGPU unavailable' };
    }
  };
  const first = await read();
  if (first && !first.software) return first;
  // Possible early-load fallback adapter: wait for the GPU process, retry once.
  await new Promise((r) => setTimeout(r, 3000));
  const second = await read();
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
