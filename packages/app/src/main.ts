// RMBG app wiring. The mockup shell in index.html owns all UI behavior;
// this module overrides the ingest/remove/export paths with the real local
// engine. Model download + session + segmentation run in a Web Worker, so
// the page stays responsive; compositing/export stay on the main thread.
// Everything runs on-device: model bytes go to the browser cache once,
// image pixels never leave. Single model tier (fast).

import {
  OpLog,
  RUNTIME_CACHE_NAME,
  boxDownsampleRGB,
  composite,
  growRegion,
  invertTransformPoint,
  isIdentityTransform,
  refineEdges,
  transformSubject,
  compositeOverlay,
  type CompositeResult,
  upsampleAlphaBilinear,
  type AlphaMask,
  type Background,
  type BBox,
  type BrushStroke,
  type Effects,
  type ImageRef,
  type ModelProgress,
  type SubjectTransform,
} from '@rmbg/engine';
import { MODEL_ID, MODEL_REV, MODEL_WEIGHTS_RE } from './model-config';

const W = window as unknown as Record<string, any>;
const $ = (s: string) => document.querySelector(s) as HTMLElement;
const $$ = (s: string) => Array.from(document.querySelectorAll(s)) as HTMLElement[];

const FX_OFF: Effects = {
  shadow: { on: false, opacity: 0.4, blur: 18, dx: 0, dy: 12 },
  feather: 0,
  defringe: 0,
};
const BG_TRANSPARENT: Background = { kind: 'transparent' };
const TR_IDENTITY: SubjectTransform = { scale: 1, rotation: 0, dx: 0, dy: 0 };

interface AppState {
  image: ImageRef | null;
  previewURL: string | null;
  mask: AlphaMask | null;
  /** The Remove panel's switch. FALSE does NOT mean "no cutout exists" — the
   *  mask is always kept, so turning removal back on is instant and lossless.
   *  It means "do not apply the mask", i.e. show and export the original photo. */
  removeBg: boolean;
  backend: string;
  log: OpLog;
  fx: Effects;
  bg: Background;
  tr: SubjectTransform;
}

const state: AppState = {
  image: null, previewURL: null, mask: null, removeBg: false, backend: '…', log: new OpLog(),
  fx: JSON.parse(JSON.stringify(FX_OFF)), bg: { ...BG_TRANSPARENT }, tr: { ...TR_IDENTITY },
};

/** Is a cutout actually being applied? Every consumer (display, export, undo,
 *  refine tools) must ask this rather than testing `state.mask`, because a mask
 *  can exist while the user has deliberately switched removal off. */
function removalOn(): boolean {
  return state.removeBg && state.mask !== null;
}

/** All-ones mask ("keep everything"), cached per size. Lets the original photo
 *  flow through the SAME composite/export path instead of branching in each
 *  consumer — over any background an opaque subject hides it completely, and
 *  feather/defringe/shadow are provably no-ops on a constant 1.0 field. */
let opaqueCache: { w: number; h: number; mask: AlphaMask } | null = null;
function opaqueMask(w: number, h: number): AlphaMask {
  if (!opaqueCache || opaqueCache.w !== w || opaqueCache.h !== h) {
    opaqueCache = { w, h, mask: { width: w, height: h, alpha: new Float32Array(w * h).fill(1) } };
  }
  return opaqueCache.mask;
}

function snapshotParams() {
  return {
    fx: JSON.parse(JSON.stringify(state.fx)) as Effects,
    bg: { ...state.bg } as Background,
    tr: { ...state.tr } as SubjectTransform,
  };
}
type ParamSnap = ReturnType<typeof snapshotParams>;
function restoreParams(s: ParamSnap) {
  state.fx = JSON.parse(JSON.stringify(s.fx));
  state.bg = { ...s.bg };
  state.tr = { ...s.tr };
  syncFxControls();
}

/** Commit a finishing change (effects/background/transform) as one undo step. */
function commitFx(label: string, mut: () => void) {
  const before = snapshotParams();
  mut();
  const after = snapshotParams();
  state.log.commit(label, () => { restoreParams(before); refreshDisplay(); }, () => { restoreParams(after); refreshDisplay(); });
  refreshDisplay();
  syncFxControls();
}

/** Canonical mask + finishing params → the pixels actually shown/exported.
 *  Transform applies only over a replacement background (SPEC); feather/
 *  defringe are presentation-time on a copy — the canonical mask is never
 *  touched except by AI, brushes, guided, and recompute.
 *
 *  Removal off: the untouched original. Transform and finishing are skipped
 *  entirely because there is no cutout for them to act on. */
function derivedView(): { image: ImageRef; mask: AlphaMask } {
  const img = state.image!;
  if (!removalOn()) return { image: img, mask: opaqueMask(img.width, img.height) };
  const msk = state.mask!;
  let image = img, mask = msk;
  if (state.bg.kind !== 'transparent' && !isIdentityTransform(state.tr)) {
    const t = transformSubject(img, msk, state.tr);
    image = t.image; mask = t.mask;
  }
  if (state.fx.feather > 0 || state.fx.defringe > 0) {
    const copy: AlphaMask = { width: mask.width, height: mask.height, alpha: new Float32Array(mask.alpha) };
    refineEdges(copy, state.fx);
    mask = copy;
  }
  return { image, mask };
}

/** Replace the canonical mask as ONE undoable step, capturing the previous mask
 *  BEFORE the swap. The bookkeeping lives in `OpLog.replaceMask` so it is unit
 *  tested; this only supplies the app's redraw hook. */
function commitMaskSwap(label: string, next: AlphaMask): AlphaMask {
  state.log.replaceMask(state, label, next, refreshDisplay);
  return next;
}

// ---------- worker client ----------
// One request at a time (the worker enforces it too); responses route by id.
// Progress events stream separately so the bar and phase text stay live.
const worker = new Worker(new URL('./infer-worker.ts', import.meta.url), { type: 'module' });
/** GPU description from the worker probe (unknown until first init). */
let gpuDesc = 'unknown';
/** Cache bucket to probe for "already downloaded". Seeded from the engine's
 *  constant, then overwritten by the runtime's own value once it reports in. */
let cacheName: string = RUNTIME_CACHE_NAME;
let reqId = 0;interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  onProgress?: (p: WorkerProgress) => void;
}
/** Progress events flowing worker → UI, including worker lifecycle phases. */
type WorkerProgress = {
  id: number;
  type: string;
  status: ModelProgress['status'] | 'runtime';
  file: string;
  loaded?: number;
  total?: number;
};
const pending = new Map<number, Pending>();
worker.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m?.type === 'progress') {
    // Fan-out, not routing: single-flight init means the pipeline runs once
    // (usually won by the page-load prefetch), but EVERY in-flight caller
    // with a progress listener must see the events — otherwise the visible
    // flow gets zero bytes-events while another silent request consumes them.
    pending.forEach((p) => p.onProgress?.(m));
    return;
  }
  const p = pending.get(m?.id);
  if (!p) return;
  pending.delete(m.id);
  if (m?.type === 'error') p.reject(new Error(m.message || 'worker failed'));
  else p.resolve(m);
};
/** A crashed worker is terminated, not restarted: every later postMessage is
 *  silently dropped, so each request would hang forever. Latch the failure and
 *  reject immediately instead. */
let workerDead = false;
function failAllPending(message: string) {
  workerDead = true;
  const err = new Error(message);
  const waiters = [...pending.values()];
  pending.clear();
  for (const p of waiters) p.reject(err);
}
worker.onerror = (e) => {
  const msg = (e as ErrorEvent).message || 'unknown error';
  stopElapsed();
  failAllPending(`worker crashed: ${msg}`);
  W.toast?.(`Background worker crashed: ${msg.slice(0, 120)} — reload to retry`, true);
};
worker.onmessageerror = (e) => {
  stopElapsed();
  failAllPending(`worker message could not be deserialized: ${String(e).slice(0, 120)}`);
  W.toast?.('Worker communication failed — reload to retry', true);
};
function callWorker(
  msg: Record<string, any>, transfer?: Transferable[],
  onProgress?: Pending['onProgress'],
): Promise<any> {
  if (workerDead) {
    return Promise.reject(new Error('The inference worker crashed — reload the page to retry'));
  }
  const id = ++reqId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    worker.postMessage({ ...msg, id }, transfer ?? []);
  });
}

// ---------- helpers ----------

/**
 * Loading-screen progress.
 *
 * `frac === null` means INDETERMINATE: we genuinely do not know how far along
 * we are (the runtime ESM fetch emits no byte events, ORT session construction
 * has no progress API, and a single-shot segmentation has no intermediate
 * steps). Those phases shimmer and show no percentage.
 *
 * The old version invented numbers — it mapped the weights download onto the
 * first 60% of the bar, then jumped to 50% for "session build", 65% after it,
 * and 85% before inference. None of those were measurements. Now a percentage
 * appears only when it is `loaded / total` for real bytes.
 */
function setBar(frac: number | null, mbText: string, totalText?: string) {
  const bar = $('#prepBar') as HTMLElement;
  const track = bar.parentElement as HTMLElement | null;
  const determinate = frac !== null;
  if (determinate) {
    const pct = Math.min(100, Math.max(0, frac! * 100));
    bar.style.width = `${pct}%`;
    // Only a determinate bar earns a fill; an indeterminate one stays empty and
    // shimmers, so the two states are never confused.
    $('#prepPct').textContent = `${Math.round(pct)}%`;
  } else {
    bar.style.width = '0%';
    $('#prepPct').textContent = '';
  }
  track?.classList.toggle('shimmer', !determinate);
  // The "·" separator lives with the percentage, so an indeterminate phase
  // shows just the phase text rather than a dangling separator.
  const pctWrap = $('#prepPctWrap') as HTMLElement | null;
  if (pctWrap) pctWrap.style.display = determinate ? '' : 'none';
  $('#prepMB').textContent = mbText;
  // The "/ total" segment only exists when a total is known (determinate
  // download). Otherwise it hides, so cached runs never show a dangling "/ …".
  const totalWrap = $('#prepTotalWrap') as HTMLElement | null;
  const t = $('#prepTotal') as HTMLElement | null;
  if (totalText !== undefined && t && totalWrap) {
    t.textContent = totalText;
    totalWrap.style.display = '';
  } else if (totalWrap) {
    totalWrap.style.display = 'none';
  }
}

function fmtMB(n: number): string {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

/** True cache check: the WEIGHTS file must be present, not just configs.
 *  (A partial cache — config.json without the ~100 MB onnx — must read as
 *  a miss, or the UI claims "cached" and then stalls with no byte events.) */
async function isModelCached(): Promise<boolean> {
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    return keys.some((r) => MODEL_WEIGHTS_RE.test(r.url));
  } catch {
    return false; // Cache API unavailable (private mode etc.) → assume miss
  }
}

/** Wall-clock heartbeat for long phases. A ticking clock proves the page is
 *  alive even when the runtime emits no byte events (cached fetches, silent
 *  session build, CPU inference). Frozen clock = actually stuck. */
let elapsedTimer: number | null = null;
function startElapsed(label: string) {
  stopElapsed();
  const t0 = Date.now();
  const el = $('#prepElapsed') as HTMLElement | null;
  const tick = () => {
    if (!el) return;
    const s = Math.floor((Date.now() - t0) / 1000);
    el.textContent = `${label} ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  tick();
  elapsedTimer = window.setInterval(tick, 1000);
}
function stopElapsed() {
  if (elapsedTimer !== null) { clearInterval(elapsedTimer); elapsedTimer = null; }
  const el = $('#prepElapsed') as HTMLElement | null;
  if (el) el.textContent = '';
}
function makeInitProgress() {
  const pendingFiles = new Set<string>();
  const bytes = new Map<string, { loaded: number; total: number }>();
  let sawDownload = false;
  let finished = false;
  let lastEventAt = Date.now();
  let stallNoted = false;
  const draw = () => {
    let l = 0, t = 0;
    for (const f of bytes.values()) { l += f.loaded; t += f.total; }
    // Real bytes over a real total. The old code scaled this into the first
    // 60% of the bar "because session build and inference follow", which made
    // every number on this screen a guess. A determinate bar now means
    // exactly `loaded / total` and nothing else.
    if (t > 0) setBar(l / t, `${fmtMB(l)}`, `${fmtMB(t)} · cached after first visit`);
  };
  // Stall reporter (informational only — never changes state).
  // Covers three silences distinctly: runtime fetch, queued-but-no-bytes,
  // and mid-download stalls.
  let firstInitiateAt = 0;
  const stallTimer = setInterval(() => {
    if (finished) return;
    const idle = Date.now() - lastEventAt;
    if (!sawDownload && pendingFiles.size > 0 && firstInitiateAt > 0 && Date.now() - firstInitiateAt > 30000 && idle > 10000) {
      setBar(null, `waiting for bytes… (${pendingFiles.size} file(s) queued, connection slow?)`);
    } else if (sawDownload && !stallNoted && idle > 20000) {
      stallNoted = true;
      // A stall means we genuinely lost the flow of bytes, so the percentage is
      // withheld rather than left frozen at a number that no longer holds.
      setBar(null, 'download stalled — connection may be slow, still trying…');
    }
  }, 5000);
  // Session build starts after the last file resolves (downloaded or cached)
  // and emits no byte events, so announce it on a short debounce: a new
  // initiate/download/progress arriving first cancels it (files can resolve
  // interleaved). Without this the cached path sits with no UI for ~12s.
  // Indeterminate: ORT session construction reports no progress, so any
  // percentage here would be invented.
  let buildTimer: number | null = null;
  const queueBuildNote = () => {
    if (buildTimer !== null) clearTimeout(buildTimer);
    buildTimer = window.setTimeout(() => {
      buildTimer = null;
      if (finished || pendingFiles.size > 0) return;
      setBar(null, sawDownload
        ? 'download complete — building the model session…'
        : 'cached model found — building the model session…');
    }, 600);
  };
  return {
    onEvent(p: WorkerProgress) {
      if (finished) return;
      lastEventAt = Date.now();
      if (p.status !== 'done' && buildTimer !== null) { clearTimeout(buildTimer); buildTimer = null; }
      if (p.status === 'runtime') {
        // The runtime is a dynamic import(): no byte events are observable, so
        // this phase is honestly indeterminate rather than a made-up 3%.
        setBar(null, 'Loading AI engine… (one-time code download)');
      } else if (p.status === 'initiate') {
        if (firstInitiateAt === 0) firstInitiateAt = Date.now();
        pendingFiles.add(p.file);
      } else if (p.status === 'download') { sawDownload = true; pendingFiles.add(p.file); }
      else if (p.status === 'progress') {
        sawDownload = true;
        if (p.total) {
          bytes.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
          draw();
        } else {
          // Chunked response without content-length: bytes are flowing but the
          // total is unknown, so no percentage is possible — indeterminate.
          stallNoted = false;
          setBar(null, `${fmtMB(p.loaded ?? 0)} downloaded…`);
        }
      } else if (p.status === 'done') {
        pendingFiles.delete(p.file);
        if (pendingFiles.size === 0) queueBuildNote();
      }
    },
    finish() {
      finished = true;
      clearInterval(stallTimer);
      if (buildTimer !== null) { clearTimeout(buildTimer); buildTimer = null; }
    },
  };
}

/** Is the live session genuinely on a GPU? Derived from the backend the adapter
 *  reports, which is re-read after every segment because the adapter can fall
 *  back from WebGPU to WASM when execution fails. Never assert "GPU" from the
 *  init-time value alone. */
function runningOnGpu(): boolean {
  return state.backend.startsWith('webgpu');
}
function backendLabel(): string {
  return runningOnGpu() ? 'GPU' : state.backend.startsWith('wasm') ? 'CPU' : 'unknown';
}

/** Put the verified backend in the status bar and the privacy popover. */
function syncBackendUI() {
  const label = backendLabel();
  const known = state.backend !== '…' && state.backend !== 'unknown';
  const text = $('#localBtnText') as HTMLElement | null;
  if (text) text.textContent = known ? `Local processing · ${label}` : 'Local processing';
  const btn = $('#localBtn') as HTMLElement | null;
  btn?.classList.toggle('on', runningOnGpu());
  const line = $('#localBackendLine') as HTMLElement | null;
  if (line) {
    line.textContent = !known
      ? 'Checking which device this browser can use…'
      : runningOnGpu()
        ? `Running on GPU · ${gpuDesc} (${state.backend}).`
        : `Running on CPU · ${state.backend}. This browser could not give us a usable GPU adapter, so inference is on the processor.`;
  }
  const gpu = $('#gpuLine') as HTMLElement | null;
  if (gpu) gpu.textContent = known ? `Running on ${label} · ${gpuDesc} · ${state.backend}` : '';
}

/** Adopt the backend the worker reports alongside a result. */
function adoptBackend(res: any): void {
  if (typeof res?.backend === 'string' && res.backend) state.backend = res.backend;
  if (typeof res?.gpu === 'string' && res.gpu) gpuDesc = res.gpu;
  syncBackendUI();
}

async function ensureReady(): Promise<void> {
  const tracker = makeInitProgress();
  try {
    const res = await callWorker({ type: 'init' }, undefined, (p) => tracker.onEvent(p));
    state.backend = res.backend ?? 'unknown';
    gpuDesc = res.gpu ?? 'unknown';
    // Trust the runtime's own cache bucket over our seed.
    if (typeof res.cacheName === 'string' && res.cacheName) cacheName = res.cacheName;
  } finally {
    tracker.finish();
    syncBackendUI();
  }
}

async function decodeToImageRef(f: File, id: string): Promise<ImageRef> {
  const bmp = await createImageBitmap(f);
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width; canvas.height = bmp.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  const rgb = new Uint8ClampedArray(bmp.width * bmp.height * 3);
  for (let i = 0; i < bmp.width * bmp.height; i++) {
    rgb[i * 3] = data[i * 4]; rgb[i * 3 + 1] = data[i * 4 + 1]; rgb[i * 3 + 2] = data[i * 4 + 2];
  }
  bmp.close();
  return { id, width: canvas.width, height: canvas.height, rgb };
}

// ---------- result display ----------

let resultCanvas: HTMLCanvasElement | null = null;
let lastCompare = 'after';

function fitChecker(w: number, h: number) {
  const checker = $('#checker') as HTMLElement;
  const s = Math.min(640 / w, 460 / h, 1);
  checker.style.width = `${Math.max(64, Math.round(w * s))}px`;
  checker.style.height = `${Math.max(64, Math.round(h * s))}px`;
}

function ensureCanvases(img: ImageRef) {
  const checker = $('#checker') as HTMLElement;
  fitChecker(img.width, img.height);
  if (!resultCanvas) {
    resultCanvas = document.createElement('canvas');
    resultCanvas.id = 'resultCanvas';
    resultCanvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
    checker.appendChild(resultCanvas);
  }
  resultCanvas.width = img.width; resultCanvas.height = img.height;
  ensureSplit(img);
  // Paint must stay on top of every image layer (result canvas included).
  const paint = $('#paintLayer') as HTMLCanvasElement | null;
  if (paint) checker.appendChild(paint);
}

/** Split layers live INSIDE the checker (so they inherit zoom/pan) as two
 *  full-res canvases at identical size — the divider can never disagree
 *  about scale again. */
let splitPos = 50;
function ensureSplit(img: ImageRef) {
  const checker = $('#checker') as HTMLElement;
  const ui = $('#splitUI') as HTMLElement;
  if (ui.parentElement !== checker) checker.appendChild(ui);
  ui.style.inset = '0';
  let lc = $('#splitLC') as HTMLCanvasElement | null;
  if (!lc) {
    ui.innerHTML = '';
    const mk = (id: string, tag: string, side: 'left' | 'right') => {
      const half = document.createElement('div');
      half.className = 'half';
      half.style.cssText = 'position:absolute;inset:0;';
      const cv = document.createElement('canvas');
      cv.id = id;
      cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
      const tg = document.createElement('span');
      tg.className = 'tag';
      tg.style[side] = '10px';
      tg.textContent = tag;
      half.appendChild(cv); half.appendChild(tg);
      ui.appendChild(half);
      return half;
    };
    mk('splitLC', 'ORIGINAL', 'left');
    const rHalf = mk('splitRC', 'CUTOUT', 'right');
    const div = document.createElement('div');
    div.id = 'splitDiv2';
    // Wide grab zone (14px) with a centered 2px visual line + grip pill.
    // Drag starts ONLY on the handle — clicks elsewhere on the pane pan/zoom
    // as usual and never jump the divider.
    div.style.cssText = 'position:absolute;top:0;bottom:0;width:14px;margin-left:-7px;cursor:ew-resize;z-index:5;touch-action:none';
    div.innerHTML = '<div style="position:absolute;top:0;bottom:0;left:6px;width:2px;background:var(--accent);box-shadow:0 0 12px rgba(52,211,153,.8)"></div>' +
      '<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:var(--accent);color:#06281c;font-size:9px;font-weight:800;border-radius:99px;padding:4px 7px;white-space:nowrap">◂ ▸</div>';
    ui.appendChild(div);
    let dragging = false;
    const pos = (clientX: number) => {
      const r = (checker as HTMLElement).getBoundingClientRect();
      splitPos = Math.max(2, Math.min(98, ((clientX - r.left) / r.width) * 100));
      rHalf.style.clipPath = `inset(0 0 0 ${splitPos}%)`;
      div.style.left = splitPos + '%';
    };
    div.addEventListener('pointerdown', (e) => {
      dragging = true;
      try { div.setPointerCapture?.((e as PointerEvent).pointerId); } catch { /* noop */ }
      pos((e as PointerEvent).clientX);
      e.stopPropagation(); // must not start paint/pan/guided on the stage below
    });
    div.addEventListener('pointermove', (e) => { if (dragging) pos((e as PointerEvent).clientX); });
    const stop = () => { dragging = false; };
    div.addEventListener('pointerup', stop);
    div.addEventListener('pointercancel', stop);
    lc = $('#splitLC') as HTMLCanvasElement;
  }
  // Re-assert clip on rebuild.
  const rHalf = lc.parentElement?.nextElementSibling as HTMLElement | null;
  const div = $('#splitDiv2') as HTMLElement | null;
  if (rHalf) rHalf.style.clipPath = `inset(0 0 0 ${splitPos}%)`;
  if (div) div.style.left = splitPos + '%';
  void img;
}

/** Blit an engine CompositeResult into a canvas, via the shared `blit`
 *  scratch canvas so each redraw does not allocate a full-res buffer. */
function blitResult(target: HTMLCanvasElement, out: CompositeResult, maxSide = 0) {
  blit.width = out.width; blit.height = out.height;
  blit.getContext('2d')!.putImageData(
    new ImageData(out.rgba as unknown as Uint8ClampedArray<ArrayBuffer>, out.width, out.height), 0, 0,
  );
  let dw = out.width, dh = out.height;
  if (maxSide > 0) {
    const s = Math.min(1, maxSide / Math.max(dw, dh));
    dw = Math.max(1, Math.round(dw * s)); dh = Math.max(1, Math.round(dh * s));
  }
  target.width = dw; target.height = dh;
  const ctx = target.getContext('2d')!;
  ctx.clearRect(0, 0, dw, dh);
  ctx.drawImage(blit, 0, 0, dw, dh);
}

function drawComposite(target: HTMLCanvasElement, view: { image: ImageRef; mask: AlphaMask }, bg: Background, fx: Effects, maxSide = 0) {
  blitResult(target, composite(view.image, view.mask, bg, fx), maxSide);
}

const blit = document.createElement('canvas');

/** Overlay view: original pixels with the mask veiled on top, so a region the
 *  AI wrongly kept is obvious. Uses the CANONICAL mask, not the derived view —
 *  the point is to audit the cutout itself, not the finishing effects. */
function drawOverlay(target: HTMLCanvasElement, img: ImageRef, mask: AlphaMask) {
  blitResult(target, compositeOverlay(img, mask));
}

function drawMaskGray(target: HTMLCanvasElement, mask: AlphaMask) {
  const ctx = target.getContext('2d')!;
  target.width = mask.width; target.height = mask.height;
  const id = ctx.createImageData(mask.width, mask.height);
  for (let i = 0; i < mask.width * mask.height; i++) {
    const v = Math.round(Math.min(1, Math.max(0, mask.alpha[i])) * 255);
    id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v;
    id.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
}

/** Redraw the canvas stack. Coalesced onto one animation frame: every mode
 *  switch re-derives a FULL-RESOLUTION composite (a Float32 clone plus a
 *  full-res putImageData), and the finishing sliders fire `input` per pointer
 *  move — so firing this directly re-composited a 12 MP image dozens of times
 *  per drag and pinned the main thread. Coalescing also removes any re-entrancy
 *  risk against the shared `blit` scratch canvas. */
let displayRaf: number | null = null;
function refreshDisplay(): void {
  if (displayRaf !== null) return;
  displayRaf = requestAnimationFrame(() => {
    displayRaf = null;
    renderDisplay();
  });
}

function renderDisplay() {
  if (!state.image || !resultCanvas) return;
  syncUndoRedo();
  syncStrokeButtons();
  syncRemoveSwitch();
  const demo = $('#demoSubject') as HTMLElement;
  demo.style.display = 'none';
  const up = $('#uploadedImg') as HTMLImageElement;
  // Removal off (or no cutout yet): the original photo is the only truthful
  // thing to show. Cutout views are meaningless here, so Original wins and the
  // split overlay is torn down rather than left showing stale panes.
  const mask = state.mask;
  if (!state.removeBg || !mask) {
    up.style.display = 'block';
    resultCanvas.style.display = 'none';
    ($('#splitUI') as HTMLElement).classList.remove('on');
    return;
  }
  if (lastCompare === 'split') {
    up.style.display = 'none';
    resultCanvas.style.display = 'none';
    const lc = $('#splitLC') as HTMLCanvasElement | null;
    const rc = $('#splitRC') as HTMLCanvasElement | null;
    if (lc && rc) {
      drawOriginal(lc, state.image);
      const view = derivedView();
      drawComposite(rc, view, state.bg, state.fx);
    }
    return;
  }
  if (lastCompare === 'before') {
    up.style.display = 'block';
    resultCanvas.style.display = 'none';
  } else if (lastCompare === 'mask') {
    up.style.display = 'none';
    resultCanvas.style.display = 'block';
    drawMaskGray(resultCanvas, mask);
  } else if (lastCompare === 'overlay') {
    up.style.display = 'none';
    resultCanvas.style.display = 'block';
    drawOverlay(resultCanvas, state.image, mask);
  } else {
    up.style.display = 'none';
    resultCanvas.style.display = 'block';
    const view = derivedView();
    drawComposite(resultCanvas, view, state.bg, state.fx);
  }
}

/** Draw the original photo into a full-res canvas (split-view left half). */
function drawOriginal(target: HTMLCanvasElement, img: ImageRef) {
  target.width = img.width; target.height = img.height;
  const ctx = target.getContext('2d')!;
  const id = ctx.createImageData(img.width, img.height);
  for (let i = 0; i < img.width * img.height; i++) {
    id.data[i * 4] = img.rgb[i * 3];
    id.data[i * 4 + 1] = img.rgb[i * 3 + 1];
    id.data[i * 4 + 2] = img.rgb[i * 3 + 2];
    id.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
}

// ---------- real flows (override mockup globals) ----------

/** Cancel token: Back during preparing invalidates the in-flight run, so a
 *  late worker result is discarded instead of popping the editor open. */
let prepToken = 0;

async function realLoadFile(f: File) {
  if (!f.type.startsWith('image/')) { W.toast('Not an image file', true); return; }
  // Reset the picker so re-selecting the SAME file still fires change.
  const picker = $('#fileInput') as HTMLInputElement | null;
  if (picker) picker.value = '';
  try {
    const ref = await decodeToImageRef(f, f.name);
    state.image = ref;
    state.mask = null;
    state.removeBg = false;
    state.log = new OpLog();
    if (state.previewURL) URL.revokeObjectURL(state.previewURL);
    state.previewURL = URL.createObjectURL(f);
    const up = $('#uploadedImg') as HTMLImageElement;
    up.src = state.previewURL;
    $('#dimLbl').textContent = `${ref.width} × ${ref.height}`;
    ensureCanvases(ref);
    if (!finishingWired) { wireFinishing(); finishingWired = true; }
    // resetExportRes() ends in refreshExpDims(), which owns #expDims.
    resetExportRes();
    W.startPreparing(false);
  } catch (e) {
    W.toast(`Could not decode that image: ${String(e)}`, true);
  }
}

/** Run full-image segmentation and return the new mask. Does NOT touch
 *  `state.mask` or the history — callers wrap it in `commitMaskSwap` so the
 *  previous mask is captured before it is replaced. */
async function segmentCurrent(): Promise<AlphaMask> {
  const img = state.image!;
  // Copy: the buffer is transferred to the worker (neutering the copy keeps
  // the main-thread original intact for compositing).
  const copy = new Uint8ClampedArray(img.rgb);
  const res = await callWorker({ type: 'segment', imageId: img.id, w: img.width, h: img.height, rgb: copy.buffer }, [copy.buffer]);
  // Adopt the backend this call used: a WebGPU session can fail during
  // execution and the adapter silently rebuilds on WASM.
  adoptBackend(res);
  return { width: res.w, height: res.h, alpha: new Float32Array(res.alpha) };
}

async function realStart(_withDemo: boolean) {
  if (!state.image) { W.toast('Pick an image first', true); W.showView('view-landing'); return; }
  const my = ++prepToken;
  W.showView('view-preparing');
  ($('#prepRing') as HTMLElement).style.display = 'block';
  ($('#prepError') as HTMLElement)?.classList.add('hidden');
  $('#prepTitle').textContent = 'Preparing local AI…';
  setBar(null, 'Checking cache…');
  // From here on the segment phase runs on the CANVAS with the progress overlay,
  // so the preparing screen's own elapsed clock is done.
  let handedOff = false;
  const backToPreparing = () => {
    if (!handedOff) return;
    handedOff = false;
    W.showView('view-preparing');
  };
  try {
    // Real cache verdict (Cache API), never a timing guess: the label must
    // not claim "cached" unless the files are actually there.
    if (await isModelCached()) {
      $('#prepTitle').textContent = 'Model cached — loading…';
      setBar(null, 'found in this browser, no download needed');
    } else {
      setBar(null, 'Downloading model… (one-time, ~98 MB)');
    }
    startElapsed('working');
    // Model load (runtime + weights + session). Indeterminate unless bytes.
    await ensureReady();
    if (my !== prepToken) return; // Back hit mid-init: warm session stays, but show nothing
    // ---- Hand off: everything that can still take a long time (the actual
    // segmentation) belongs on the canvas, not on a loading card. The user sees
    // their own photo with the progress overlay instead of a progress bar for
    // something they cannot see.
    handedOff = true;
    stopElapsed();
    const label = backendLabel();
    W.showView('view-editor');
    lastCompare = 'after';
    W.compareMode = 'after';
    // No mask yet, so the editor shows the original — the cutout arrives when
    // the worker returns.
    startScan(`Removing background on-device (${label})…`);
    refreshDisplay();
    const t0 = performance.now();
    try {
      commitMaskSwap('ai', await segmentCurrent());
    } catch (e) {
      // Put the user back on the loading card, which owns the error reporting.
      stopScan();
      backToPreparing();
      throw e;
    }
    state.removeBg = true;
    if (my !== prepToken) return; // Back hit mid-inference: discard, don't pop the editor open
    stopScan();
    // The user can leave the editor while this runs (Back is not the preparing
    // screen's cancel button any more), so re-assert the view: a finished
    // result is always shown rather than stranded on a hidden canvas.
    W.showView('view-editor');
    refreshDisplay();
    // Reveal, don't flash: the wipe is the payoff moment after the overlay.
    runReveal();
    W.toast(`Background removed in ${((performance.now() - t0) / 1000).toFixed(1)}s · ${state.backend}`);
    setTimeout(() => $('#fb').classList.add('on'), 2500);
    // The bubble overlaps the canvas: dismiss it automatically, it stays
    // one tap away via Refine if the user disagrees later.
    setTimeout(() => $('#fb').classList.remove('on'), 14000);
  } catch (e) {
    stopScan(); // idempotent; covers a failure before or after the hand-off
    if (my !== prepToken) return; // cancelled: landing is already showing
    backToPreparing();
    stopElapsed();
    const msg = String((e as Error)?.message ?? e);
    $('#prepTitle').textContent = 'Could not start the local model';
    ($('#prepRing') as HTMLElement).style.display = 'none';
    // Error gets its own line — the MB line keeps neutral progress state
    // instead of a 300-char message beside a stale total and a stale percentage.
    setBar(null, 'failed');
    const errEl = $('#prepError') as HTMLElement | null;
    if (errEl) {
      errEl.textContent = msg.slice(0, 300);
      errEl.classList.remove('hidden');
    }
    W.toast(`Model start failed: ${msg.slice(0, 160)}`, true);
  }
}

async function rerun() {
  if (!state.image) return;
  if (!removalOn()) { W.toast('Turn on “Remove background” first', true); return; }
  if (isScanning()) { noteEditBlocked('Still working — one moment'); return; }
  startScan('Recomputing background…');
  try {
    // The old cutout stays on screen until the new one is ready (SPEC 3.2):
    // commitMaskSwap only fires after the worker returns.
    commitMaskSwap('recompute', await segmentCurrent());
    state.removeBg = true;
    refreshDisplay();
    W.toast('Recomputed');
  } catch (e) {
    // Failure keeps the previous cutout — nothing was swapped.
    W.toast(`Recompute failed: ${String(e).slice(0, 120)}`, true);
  } finally {
    stopScan();
  }
}

/** Reveal wipe: after segmentation the editor opens on the ORIGINAL, then a
 *  left-to-right wipe reveals the cutout (remove.bg-style), instead of
 *  flashing the result instantly. Skipped for reduced-motion users.
 *  Bump revealToken to cancel (compare switches, new image). */
let revealToken = 0;
function runReveal() {
  if (!state.image) return;
  const checker = $('#checker') as HTMLElement;
  let ov = $('#revealUI') as HTMLElement | null;
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'revealUI';
    ov.style.cssText = 'position:absolute;inset:0;display:none;z-index:8;overflow:hidden;border-radius:6px';
    const cv = document.createElement('canvas');
    cv.id = 'revealC';
    cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
    const line = document.createElement('div');
    line.id = 'revealLine';
    line.style.cssText = 'position:absolute;top:0;bottom:0;width:2px;background:var(--accent);box-shadow:0 0 14px rgba(52,211,153,.9)';
    ov.appendChild(cv); ov.appendChild(line);
    checker.appendChild(ov);
  }
  const cv = $('#revealC') as HTMLCanvasElement;
  const line = $('#revealLine') as HTMLElement;
  drawOriginal(cv, state.image);
  const my = ++revealToken;
  ov.style.display = 'block';
  const finish = () => { if (my === revealToken) ov!.style.display = 'none'; };
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { finish(); return; }
  // Brief beat so the cutout is visible before the wipe starts (this used to
  // hold for 2 s, which felt like a second wait after the overlay cleared),
  // then wipe over ~1.1 s. Cancel-safe via the token.
  setTimeout(() => {
    if (my !== revealToken) return;
    const t0 = performance.now(), DUR = 1100;
    const frame = (t: number) => {
      if (my !== revealToken) return;
      const k = Math.min(1, (t - t0) / DUR);
      const e = 1 - Math.pow(1 - k, 3);
      cv.style.clipPath = `inset(0 0 0 ${e * 100}%)`;
      line.style.left = `${e * 100}%`;
      if (k < 1) requestAnimationFrame(frame);
      else finish();
    };
    requestAnimationFrame(frame);
  }, 500);
}

// ---------- progress overlay ----------
// Recompute (whole image and region) and on-demand segmentation all keep the
// previous result on screen and work in the background, so the overlay has to
// run for exactly as long as the work does. The old implementation showed a
// halo and hid it on a hardcoded 2600 ms timer: on a slow CPU pass that meant
// the overlay vanished while inference was still running, which reads as
// "finished". Nothing here is time-based except the visible clock, which is
// there to prove liveness.
let scanTimer: number | null = null;
let scanBusy = false;

function isScanning(): boolean {
  return scanBusy;
}

/** The overlay must track the canvas under zoom/pan, so it has to live INSIDE
 *  #checker. The markup ships #scan as a sibling of #viewport (inside #stage),
 *  where `inset:0` covered the whole stage and the beam swept the dark
 *  background instead of the image. Same reason ensureSplit() relocates
 *  #splitUI. */
function ensureScanOverlay() {
  const el = $('#scan') as HTMLElement | null;
  const checker = $('#checker') as HTMLElement | null;
  if (el && checker && el.parentElement !== checker) checker.appendChild(el);
}

function startScan(label: string) {
  ensureScanOverlay();
  const lbl = $('#scanLbl') as HTMLElement | null;
  if (lbl) lbl.textContent = label;
  const time = $('#scanTime') as HTMLElement | null;
  const t0 = performance.now();
  const tick = () => {
    if (!time) return;
    const s = Math.floor((performance.now() - t0) / 1000);
    time.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  tick();
  scanBusy = true;
  ($('#scan') as HTMLElement | null)?.classList.add('on');
  if (scanTimer !== null) clearInterval(scanTimer);
  scanTimer = window.setInterval(tick, 500);
}

function stopScan() {
  if (scanTimer !== null) { clearInterval(scanTimer); scanTimer = null; }
  scanBusy = false;
  ($('#scan') as HTMLElement | null)?.classList.remove('on');
  const time = $('#scanTime') as HTMLElement | null;
  if (time) time.textContent = '0:00';
}

/** Shared 2.5 s throttle for "you can't do that right now" toasts. */
let editNoteAt = 0;
function noteEditBlocked(msg: string): boolean {
  const now = Date.now();
  if (now - editNoteAt <= 2500) return true;
  editNoteAt = now;
  W.toast(msg);
  return true;
}

/** Guard for anything that mutates the mask or stages new paint. Three reasons
 *  to stand down: work is already running (the mask it would edit is about to
 *  be replaced), no cutout is applied, or an inspect-only compare mode is up. */
function guardEditing(): boolean {
  if (isScanning()) return noteEditBlocked('Still working — one moment');
  if (!removalOn()) return noteEditBlocked('Turn on “Remove background” to edit the cutout');
  return guardSplit();
}

function guardSplit(): boolean {
  if (lastCompare !== 'split' && lastCompare !== 'overlay') return false;
  return noteEditBlocked(`Exit ${lastCompare === 'overlay' ? 'Overlay' : 'Split'} view to edit`);
}

function realCompare(m: string) {
  revealToken++;
  lastCompare = m;
  // Mirror into the shell's compareMode: the `B` shortcut there reads its own
  // binding to decide which way to toggle, and a module can assign to a global
  // `var` but never to a script-scoped `let`. Left unsynced, `B` always
  // resolved to "before" and the second press did nothing.
  W.compareMode = m;
  // The shell's stage painting must stand down in every inspect-only mode.
  (W as any).__rmbgSplitLock = (m === 'split' || m === 'overlay');
  ($('#splitUI') as HTMLElement).classList.toggle('on', m === 'split');
  $$('.seg button').forEach((b) => (b as HTMLElement).classList.toggle('on', (b as HTMLElement).dataset.view === m));
  if (!removalOn()) {
    // Without a cutout there is nothing to compare against; the switch and the
    // compare group are what the user should be looking at instead.
    W.toast('Turn on “Remove background” to use cutout views');
    return;
  }
  refreshDisplay();
  if (m === 'before') W.toast('Original pixels — never destroyed');
  if (m === 'mask') W.toast('Mask: white kept · black removed · gray partial');
  if (m === 'overlay') W.toast('Overlay: kept pixels stay, removed areas are tinted red');
}

function selectedFormat(): string {
  const on = document.querySelector('.fmt.on') as HTMLElement | null;
  return on?.dataset.fmt ?? 'PNG';
}

// ---------- the Remove panel switch ----------

/** Compare modes that only mean something with a cutout on screen. */
const CUTOUT_MODES = ['split', 'overlay', 'mask'];

/** Reflect removal state into the switch, the status line, the Recompute row
 *  and the compare group. Called from every redraw so undo/redo and toggling
 *  can never leave the controls describing a state that is not on screen. */
function syncRemoveSwitch() {
  const sw = $('#removeSwitch') as HTMLElement | null;
  const on = removalOn();
  if (sw) {
    sw.classList.toggle('on', on);
    sw.setAttribute('aria-checked', String(on));
  }
  const status = $('#removeStatus') as HTMLElement | null;
  if (status) {
    status.textContent = !state.image ? 'No image loaded'
      : on ? 'Background removed'
      : state.mask ? 'Original photo · cutout kept'
      : 'Original photo';
  }
  // Recompute is meaningful only when there is a cutout to recompute.
  ($('#recomputeRow') as HTMLElement | null)?.classList.toggle('hidden', !on);
  $$('.seg button').forEach((b) => {
    const v = (b as HTMLElement).dataset.view ?? '';
    (b as HTMLButtonElement).disabled = !on && CUTOUT_MODES.includes(v);
  });
  // The export drawer's background choice has no effect on the original photo.
  $$('#exportWrap .radio').forEach((r) => (r as HTMLElement).classList.toggle('muted', !on));
  // The drawer's derived text depends on removal state too, and this function
  // is the single owner of that state — including when callers set
  // `state.removeBg` directly (realStart, rerun, openBatchItem) rather than
  // going through setRemoval().
  refreshExpDims();
}

/** Turn removal on/off as one undo step, then reconcile the view. */
function setRemoval(next: boolean, opts: { silent?: boolean } = {}) {
  if (next === state.removeBg) { syncRemoveSwitch(); return; }
  const prev = state.removeBg;
  state.removeBg = next;
  state.log.commit(
    next ? 'remove background on' : 'remove background off',
    () => { state.removeBg = prev; afterRemovalChange(); },
    () => { state.removeBg = next; afterRemovalChange(); },
  );
  afterRemovalChange();
  if (!opts.silent) {
    W.toast(next ? 'Background removed' : 'Showing the original photo');
  }
}

function afterRemovalChange() {
  // Turning removal off from a cutout view lands on Original; turning it back
  // on returns to the cutout the user was last looking at.
  if (!state.removeBg && lastCompare !== 'before') {
    lastCompare = 'before';
    W.compareMode = 'before';
    $$('.seg button').forEach((b) => (b as HTMLElement).classList.toggle('on', (b as HTMLElement).dataset.view === 'before'));
  }
  if (state.removeBg && lastCompare === 'before') {
    lastCompare = 'after';
    W.compareMode = 'after';
    $$('.seg button').forEach((b) => (b as HTMLElement).classList.toggle('on', (b as HTMLElement).dataset.view === 'after'));
  }
  refreshDisplay();
  syncFxControls();
  syncUndoRedo();
}

/** Turning removal ON for an image that has never been segmented (an
 *  unprocessed batch item, say) has to actually do the work rather than
 *  silently showing the original. */
async function enableRemoval() {
  if (!state.image) return;
  if (isScanning()) { noteEditBlocked('Still working — one moment'); return; }
  setRemoval(true, { silent: true });
  if (state.mask) { syncRemoveSwitch(); refreshDisplay(); return; }
  // This one can include a cold model load, so the chip's clock is the only
  // honest signal for a while; it must not disappear on a timer.
  startScan('Removing background…');
  syncRemoveSwitch();
  try {
    await ensureReady();
    commitMaskSwap('ai', await segmentCurrent());
    state.removeBg = true;
    W.showView('view-editor');
    lastCompare = 'after';
    W.compareMode = 'after';
    refreshDisplay();
    W.toast('Background removed');
  } catch (e) {
    state.removeBg = false;
    W.toast(`Could not remove background: ${String(e).slice(0, 120)}`, true);
  } finally {
    stopScan();
    syncRemoveSwitch();
    refreshDisplay();
  }
}

function installRemoveSwitch() {
  const sw = $('#removeSwitch') as HTMLButtonElement;
  // A <button role="switch"> already handles Enter/Space; this just prevents
  // the Space-to-pan shortcut on the stage from stealing the keypress.
  sw.addEventListener('click', () => { void (state.removeBg ? setRemovalOff() : enableRemoval()); });
}
async function setRemovalOff() {
  if (state.mask) { setRemoval(false); return; }
  // Nothing was ever segmented: the switch is already showing the original and
  // there is no state change worth recording.
  state.removeBg = false;
  syncRemoveSwitch();
  refreshDisplay();
}

/** Export drawer's BACKGROUND choice.
 *  'current'    — use whatever the Background panel set, so the file matches
 *                 what is on screen (the default; exporting what you see).
 *  'transparent'— force the cutout only, ignoring the on-screen background.
 *  This is per-export intent, never written back into `state.bg`: the stored
 *  background belongs to the editing session, not to one download. */
let exportBg: 'transparent' | 'current' = 'current';

function effectiveExportBg(): Background {
  return exportBg === 'transparent' ? { kind: 'transparent' } : state.bg;
}

function bgHexOf(color: [number, number, number]): string {
  return '#' + color.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('');
}

/** JPEG cannot carry alpha. Driven from ONE place: the shell used to toggle
 *  the warning on format click while syncFxControls toggled it on background
 *  kind, so the two fought and the warning did not describe the choice the
 *  export would actually make. Irrelevant with removal off — the original photo
 *  is opaque, so JPEG needs no flattening. */
function refreshJpegWarn(): void {
  const el = $('#jpegWarn') as HTMLElement | null;
  if (!el) return;
  const lossy = selectedFormat() === 'JPEG' && removalOn() && effectiveExportBg().kind === 'transparent';
  el.classList.toggle('hidden', !lossy);
}

/** Explain what the chosen background will actually produce. */
function refreshExpBgNote(): void {
  const el = $('#expBgNote') as HTMLElement | null;
  if (!el) return;
  if (!removalOn()) {
    el.textContent = 'Removal is off — this exports the original photo, so the background choice does not apply.';
  } else if (exportBg === 'transparent') {
    el.textContent = 'Cutout only — alpha preserved.';
  } else if (state.bg.kind === 'color') {
    el.textContent = `Solid ${bgHexOf(state.bg.color ?? [255, 255, 255]).toUpperCase()} from the Background panel.`;
  } else if (state.bg.kind === 'image') {
    el.textContent = 'The image from the Background panel.';
  } else {
    el.textContent = 'The Background panel is transparent, so this is a cutout.';
  }
}

/** Export drawer is static markup: bind format + background once, on load. */
function wireExportDrawer(): void {
  // The drawer's derived text (dims, JPEG guard, background note) depends on
  // state that can change while it is closed, so re-derive on open.
  ($('#btnExport') as HTMLElement)?.addEventListener('click', refreshExpDims);
  $$('.fmt').forEach((b) => b.addEventListener('click', () => {
    $$('.fmt').forEach((x) => x.classList.toggle('on', x === b));
    ($('#btnDoExport') as HTMLElement).textContent = `Export ${(b as HTMLElement).dataset.fmt}`;
    refreshExpDims();
  }));
  const pairs: [HTMLElement, 'transparent' | 'current'][] = [
    [$('#expBgTransparent') as HTMLElement, 'transparent'],
    [$('#expBgCurrent') as HTMLElement, 'current'],
  ];
  const pick = (choice: 'transparent' | 'current') => {
    exportBg = choice;
    for (const [el, c] of pairs) {
      el.classList.toggle('on', c === choice);
      el.setAttribute('aria-checked', String(c === choice));
    }
    refreshExpDims();
  };
  for (const [el, choice] of pairs) {
    el.addEventListener('click', () => pick(choice));
    // The radios are divs, so Enter/Space are not wired for us.
    el.addEventListener('keydown', (e) => {
      const k = (e as KeyboardEvent).key;
      if (k === 'Enter' || k === ' ') { e.preventDefault(); pick(choice); }
    });
  }
  pick('current');
}

/** Export size state. null = original dimensions. */
let customRes: { w: number; h: number } | null = null;
let resLocked = true;

function exportSize(): { w: number; h: number; custom: boolean } {
  if (customRes) return { w: customRes.w, h: customRes.h, custom: true };
  const img = state.image!;
  return { w: img.width, h: img.height, custom: false };
}

function refreshExpDims() {
  // Guard + background note do not need a loaded image, so refresh them even
  // before one exists (a format can be picked from the landing build).
  refreshJpegWarn();
  refreshExpBgNote();
  if (!state.image) return;
  const { w, h } = exportSize();
  const fmt = selectedFormat();
  const bg = !removalOn() ? 'original photo'
    : effectiveExportBg().kind === 'transparent' ? 'transparent' : 'with background';
  $('#expDims').textContent = `${w} × ${h} · ${fmt} · ${bg}${customRes ? ' · custom' : ''}`;
}

function refreshResNote() {
  const el = $('#resNote') as HTMLElement | null;
  if (!el || !state.image || !customRes) return;
  const { w, h } = customRes;
  const same = w === state.image.width && h === state.image.height;
  const pct = Math.round((100 * w) / state.image.width);
  const dir = same ? 'same as original'
    : pct < 100 ? `${pct}% — downscale, stays sharp` : `${pct}% — upscale, may soften`;
  const stretched = !resLocked
    && Math.abs(w / h - state.image.width / state.image.height) > 0.01;
  el.textContent = `${w} × ${h} · ${dir}${stretched ? ' · aspect stretched' : ''}`;
}

function resetExportRes() {
  customRes = null;
  resLocked = true;
  ($('#resOrig') as HTMLElement)?.classList.add('on');
  ($('#resCustom') as HTMLElement)?.classList.remove('on');
  ($('#resCustomBox') as HTMLElement)?.classList.add('hidden');
  const l = $('#resLock') as HTMLElement | null;
  if (l) l.textContent = 'Aspect locked';
  refreshExpDims();
}

/** AVIF encode support varies by browser/runtime — detect, never assume. */
let avifCache: boolean | null = null;
async function avifSupported(): Promise<boolean> {
  if (avifCache !== null) return avifCache;
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 8;
    avifCache = c.toDataURL('image/avif').startsWith('data:image/avif');
  } catch {
    avifCache = false;
  }
  return avifCache;
}

/** Full-res composite, then a single high-quality resample to export size. */
function exportCanvas(view: { image: ImageRef; mask: AlphaMask }, bg: Background, fx: Effects, w: number, h: number): HTMLCanvasElement {
  const full = document.createElement('canvas');
  drawComposite(full, view, bg, fx);
  if (full.width === w && full.height === h) return full;
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(full, 0, 0, w, h);
  return out;
}

async function realExport() {
  if (!state.image) { W.toast('Nothing to export yet', true); return; }
  let fmt = selectedFormat();
  if (fmt === 'AVIF' && !(await avifSupported())) {
    W.toast('AVIF not supported in this browser — exporting PNG instead', true);
    fmt = 'PNG';
  }
  ($('#btnDoExport') as HTMLElement).textContent = `Export ${fmt}`;
  const wrap = $('#expProgWrap') as HTMLElement;
  wrap.classList.remove('hidden');
  ($('#expBar') as HTMLElement).style.width = '15%';
  try {
    const cutout = removalOn();
    const view = derivedView();
    const size = exportSize();
    // Removal off: the file is the original photo, so the drawer's background
    // choice and the finishing effects cannot apply to it. Say so, never
    // silently drop them.
    let bg: Background = cutout ? effectiveExportBg() : { kind: 'transparent' };
    const fxUsed = cutout ? state.fx : FX_OFF;
    let note = `${size.w} × ${size.h} · ${fmt}`;
    if (!cutout) {
      note += ' · original photo (removal off)';
    } else if (fmt === 'JPEG' && bg.kind === 'transparent') {
      // JPEG cannot carry transparency: composite onto white for this export
      // only (stated, never silent), without touching the stored mask or the
      // drawer's background choice.
      bg = { kind: 'color', color: [255, 255, 255] };
      note += ' · flattened onto white (JPEG has no transparency)';
    } else {
      note += bg.kind === 'transparent' ? ' · transparent' : ' · with background';
    }
    if (size.custom && state.image) {
      const pct = Math.round((100 * size.w) / state.image.width);
      note += pct === 100 ? ' · custom size' : pct < 100 ? ` · downscaled to ${pct}%` : ` · upscaled to ${pct}%`;
    }
    const canvas = exportCanvas(view, bg, fxUsed, size.w, size.h);
    ($('#expBar') as HTMLElement).style.width = '60%';
    const mime = fmt === 'PNG' ? 'image/png'
      : fmt === 'WebP' ? 'image/webp'
      : fmt === 'AVIF' ? 'image/avif' : 'image/jpeg';
    const quality = fmt === 'AVIF' ? 0.85 : 0.92;
    const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, mime, quality));
    if (!blob) throw new Error('encoder returned nothing');
    ($('#expBar') as HTMLElement).style.width = '100%';
    const ext = fmt === 'PNG' ? 'png' : fmt === 'WebP' ? 'webp' : fmt === 'AVIF' ? 'avif' : 'jpg';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `rmbg-export-${size.w}x${size.h}.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    $('#expNote').textContent = `Done: ${a.download} · ${(blob.size / 1048576).toFixed(2)} MB · ${note}`;
    W.toast('Export complete');
    syncUndoRedo();
  } catch (e) {
    $('#expNote').textContent = `Export failed: ${String(e).slice(0, 140)} — retry or try PNG.`;
    W.toast('Export failed', true);
  }
}

// Introspection for verification/debugging (harmless in production).
(window as unknown as Record<string, any>).__rmbg = { state };

// ---------- brush strokes → real mask ----------
// The overlay canvas is display-space paint. Strokes are recorded here as
// vectors (in overlay pixels) and committed to the full-res mask on Apply,
// so nothing touches the cutout until the user says so. Each Apply is one
// undo step per stroke via the OpLog.
interface PendingStroke { mode: 'erase' | 'restore'; points: { x: number; y: number }[]; size: number; softness: number }
let pendingStrokes: PendingStroke[] = [];
let curStroke: PendingStroke | null = null;

function paintPoint(e: PointerEvent): { x: number; y: number } | null {
  const checker = $('#checker') as HTMLElement;
  const paint = $('#paintLayer') as HTMLCanvasElement | null;
  if (!checker || !paint || paint.width === 0) return null;
  const r = checker.getBoundingClientRect();
  return {
    x: ((e.clientX - r.left) / r.width) * paint.width,
    y: ((e.clientY - r.top) / r.height) * paint.height,
  };
}

function brushActive(): boolean {
  return ($('#stage') as HTMLElement)?.classList.contains('brushing') ?? false;
}

function activeBrushMode(): 'erase' | 'restore' {
  const on = document.querySelector('[data-br].on') as HTMLElement | null;
  return on?.dataset.br === 'restore' ? 'restore' : 'erase';
}

function syncStrokeButtons() {
  const apply = $('#btnApplyStrokes') as HTMLButtonElement | null;
  if (apply) {
    apply.disabled = pendingStrokes.length === 0 || !state.mask;
    apply.textContent = `Apply (${pendingStrokes.length})`;
  }
}

function clearOverlay() {
  const paint = $('#paintLayer') as HTMLCanvasElement | null;
  paint?.getContext('2d')?.clearRect(0, 0, paint.width, paint.height);
  pendingStrokes = [];
  curStroke = null;
  syncStrokeButtons();
}

function installStrokeCapture() {
  const stage = $('#stage') as HTMLElement;
  stage.addEventListener('pointerdown', (e) => {
    if (!brushActive() || (e.button !== 0 && e.pointerType === 'mouse')) return;
    if (guardEditing()) return;
    const pt = paintPoint(e as PointerEvent);
    if (!pt) return;
    const size = +(( $('#brushSize') as HTMLInputElement)?.value ?? 48);
    const soft = +(( $('#brushSoft') as HTMLInputElement)?.value ?? 40) / 100;
    curStroke = { mode: activeBrushMode(), points: [pt], size, softness: soft };
  });
  stage.addEventListener('pointermove', (e) => {
    if (!curStroke || !brushActive()) return;
    if (e.buttons === 0 && e.pointerType === 'mouse') return;
    const pt = paintPoint(e as PointerEvent);
    if (pt) curStroke.points.push(pt);
  });
  const end = () => {
    if (curStroke && curStroke.points.length > 0) pendingStrokes.push(curStroke);
    curStroke = null;
    syncStrokeButtons();
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', () => { curStroke = null; });
  ($('#btnClearStrokes') as HTMLButtonElement)?.addEventListener('click', () => {
    clearOverlay();
    W.toast('Strokes discarded');
  });
  ($('#btnApplyStrokes') as HTMLButtonElement)?.addEventListener('click', () => {
    if (!state.mask || pendingStrokes.length === 0) return;
    if (guardEditing()) return;
    const paint = $('#paintLayer') as HTMLCanvasElement | null;
    const sx = paint && paint.width > 0 ? state.mask.width / paint.width : 1;
    const sy = paint && paint.height > 0 ? state.mask.height / paint.height : 1;
    // Overlay paint aligns with the DISPLAYED (possibly transformed) subject;
    // map back to canonical mask space so strokes land where the user painted.
    const warped = state.bg.kind !== 'transparent' && !isIdentityTransform(state.tr);
    try {
      for (const s of pendingStrokes) {
        const pts = s.points.map((p) => ({ x: p.x * sx, y: p.y * sy }));
        const mapped = warped
          ? pts.map((p) => invertTransformPoint(state.tr, state.mask!.width, state.mask!.height, p.x, p.y))
          : pts;
        const stroke: BrushStroke = {
          points: mapped,
          size: (s.size * sx) / (warped ? state.tr.scale : 1),
          softness: s.softness,
        };
        // One undo step per stroke.
        state.log.applyBrush(state.mask, stroke, s.mode);
      }
      const n = pendingStrokes.length;
      clearOverlay();
      refreshDisplay();
      W.toast(`Applied ${n} stroke${n === 1 ? '' : 's'}`);
    } catch (err) {
      W.toast(`Apply failed: ${String(err).slice(0, 120)}`, true);
    }
  });
}

// ---------- finishing: effects / background / transform ----------

function num(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}
function paintSliderLabel(id: string, fmt: (v: number) => string) {
  const lbl = document.getElementById(id + 'V');
  if (lbl) lbl.textContent = fmt(+num(id).value);
}

/** Keep every finishing control visually in sync with state (also after undo). */
function syncFxControls() {
  if (!state.image) return;
  $$('#p-effects [data-sh]').forEach((r) => {
    (r as HTMLElement).classList.toggle('on', ((r as HTMLElement).dataset.sh === 'on') === state.fx.shadow.on);
  });
  ($('#shadowCtrls') as HTMLElement)?.classList.toggle('hidden', !state.fx.shadow.on);
  const set = (id: string, v: number, fmt: (x: number) => string) => {
    num(id).value = String(v); paintSliderLabel(id, fmt);
  };
  const pct = (v: number) => `${v}%`, px = (v: number) => `${v}px`, deg = (v: number) => `${v}°`;
  set('shOp', state.fx.shadow.opacity, pct);
  set('shBlur', state.fx.shadow.blur, px);
  set('shDist', state.fx.shadow.dx, px);
  set('feather', state.fx.feather, px);
  set('defringe', state.fx.defringe, (v) => `${v}`);
  set('subScale', Math.round(state.tr.scale * 100), pct);
  set('subRot', state.tr.rotation, deg);
  set('subX', Math.round((state.tr.dx / state.image.width) * 100), pct);
  set('subY', Math.round((state.tr.dy / state.image.height) * 100), pct);
  $$('#p-background [data-bg]').forEach((r) => {
    (r as HTMLElement).classList.toggle('on', (r as HTMLElement).dataset.bg === state.bg.kind);
  });
  ($('#bgColorBox') as HTMLElement)?.classList.toggle('hidden', state.bg.kind !== 'color');
  ($('#bgImageBox') as HTMLElement)?.classList.toggle('hidden', state.bg.kind !== 'image');
  ($('#subjectCard') as HTMLElement)?.classList.toggle('hidden', state.bg.kind === 'transparent');
  // #jpegWarn is NOT toggled here: refreshExpDims (called at the end of this
  // function) owns it, because it depends on the export drawer's background
  // choice as well as the panel's. Setting it from both places is what made the
  // warning describe neither reliably.
  const checker = $('#checker') as HTMLElement;
  checker.style.background = '';
  checker.style.backgroundSize = '';
  if (state.bg.kind === 'color' && state.bg.color) {
    const hex = '#' + state.bg.color.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('');
    num('bgColor').value = hex;
    ($('#bgHex') as HTMLElement).textContent = hex.toUpperCase();
    $$('.sw').forEach((s) => (s as HTMLElement).classList.toggle('on', (s as HTMLElement).dataset.c === hex));
  }
  refreshExpDims();
}

/** Slider keys that mutate a range input's value. */
const SLIDER_KEYS = new Set([
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown',
]);

/** Bind a finishing slider so one gesture = one undo step, from BOTH mouse and
 *  keyboard. Two traps this closes:
 *  - `focus` fires once, so arming the snapshot there meant every arrow-key
 *    nudge after the first committed outside the history (silently un-undoable).
 *  - committing on every `change` made a held arrow key or a scrub land dozens
 *    of entries, so the snapshot is debounced instead.
 *  Snapshotting on `pointerdown`/`keydown` and ignoring re-arms mid-gesture
 *  collapses a drag or a key-repeat into a single entry. */
function bindFxSlider(id: string, label: string, set: (v: number) => void, fmt: (v: number) => string) {
  const el = num(id);
  let before: ParamSnap | null = null;
  let timer: number | null = null;
  const begin = () => { if (before === null) before = snapshotParams(); };
  const commit = () => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    const b = before;
    before = null;
    if (!b) return;
    const after = snapshotParams();
    // A gesture that changed nothing (click without drag, refocus) is not history.
    if (JSON.stringify(b) === JSON.stringify(after)) return;
    state.log.commit(label, () => { restoreParams(b); refreshDisplay(); }, () => { restoreParams(after); refreshDisplay(); });
    syncUndoRedo();
  };
  const schedule = () => {
    if (timer !== null) clearTimeout(timer);
    timer = window.setTimeout(commit, 400);
  };
  el.addEventListener('pointerdown', begin);
  el.addEventListener('keydown', (e) => { if (SLIDER_KEYS.has(e.key)) begin(); });
  el.addEventListener('blur', commit);
  el.addEventListener('input', () => { set(+el.value); paintSliderLabel(id, fmt); refreshDisplay(); schedule(); });
  el.addEventListener('change', () => { paintSliderLabel(id, fmt); refreshDisplay(); schedule(); });
}

function wireFinishing() {
  if (!state.image) return;
  // Shadow on/off (discrete → immediate history entry).
  $$('#p-effects [data-sh]').forEach((r) => {
    (r as HTMLElement).addEventListener('click', () => {
      const on = (r as HTMLElement).dataset.sh === 'on';
      if (on === state.fx.shadow.on) return;
      commitFx(`shadow ${on ? 'on' : 'off'}`, () => { state.fx.shadow.on = on; });
    });
  });
  const pct = (v: number) => `${v}%`, px = (v: number) => `${v}px`, deg = (v: number) => `${v}°`;
  bindFxSlider('shOp', 'shadow opacity', (v) => { state.fx.shadow.opacity = v; }, pct);
  bindFxSlider('shBlur', 'shadow blur', (v) => { state.fx.shadow.blur = v; }, px);
  bindFxSlider('shDist', 'shadow distance', (v) => { state.fx.shadow.dx = v; state.fx.shadow.dy = v; }, px);
  bindFxSlider('feather', 'feather', (v) => { state.fx.feather = v; }, px);
  bindFxSlider('defringe', 'defringe', (v) => { state.fx.defringe = v; }, (v) => `${v}`);
  // Background kind.
  $$('#p-background [data-bg]').forEach((b) => {
    (b as HTMLElement).addEventListener('click', () => {
      const kind = (b as HTMLElement).dataset.bg as Background['kind'];
      if (kind === state.bg.kind) return;
      commitFx(`background ${kind}`, () => {
        if (kind === 'transparent') state.bg = { kind };
        else if (kind === 'color') state.bg = { kind, color: state.bg.color ?? [255, 255, 255] };
        else state.bg = state.bg.kind === 'image' ? state.bg : { kind };
      });
    });
  });
  num('bgColor').addEventListener('input', () => {
    const hex = num('bgColor').value;
    const c: [number, number, number] = [
      parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16),
    ];
    state.bg = { kind: 'color', color: c };
    refreshDisplay();
    syncFxControls();
  });
  num('bgColor').addEventListener('change', () => {
    const hex = num('bgColor').value;
    const c: [number, number, number] = [
      parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16),
    ];
    const before = snapshotParams();
    state.bg = { kind: 'color', color: c };
    const after = snapshotParams();
    state.log.commit('background color', () => { restoreParams(before); refreshDisplay(); }, () => { restoreParams(after); refreshDisplay(); });
    refreshDisplay();
    syncUndoRedo();
  });
  $$('.sw').forEach((s) => {
    (s as HTMLElement).addEventListener('click', () => {
      const hex = (s as HTMLElement).dataset.c ?? '#ffffff';
      const c: [number, number, number] = [
        parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16),
      ];
      commitFx('background color', () => { state.bg = { kind: 'color', color: c }; });
    });
  });
  ($('#btnBgUpload') as HTMLButtonElement)?.addEventListener('click', () => bgPicker.click());
  // Subject transform (percent sliders → px against current image).
  const img = () => state.image!;
  bindFxSlider('subScale', 'subject scale', (v) => { state.tr.scale = v / 100; }, pct);
  bindFxSlider('subRot', 'subject rotation', (v) => { state.tr.rotation = v; }, deg);
  bindFxSlider('subX', 'subject position', (v) => { state.tr.dx = (v / 100) * img().width; }, pct);
  bindFxSlider('subY', 'subject position', (v) => { state.tr.dy = (v / 100) * img().height; }, pct);
  ($('#btnSubReset') as HTMLButtonElement)?.addEventListener('click', () => {
    commitFx('subject reset', () => { state.tr = { scale: 1, rotation: 0, dx: 0, dy: 0 }; });
  });
  // Export resolution radios (static drawer elements — bound once via the
  // finishingWired guard like the rest of this function).
  const resOrig = $('#resOrig') as HTMLElement;
  const resCustom = $('#resCustom') as HTMLElement;
  const resBox = $('#resCustomBox') as HTMLElement;
  resOrig.addEventListener('click', () => {
    customRes = null;
    resOrig.classList.add('on');
    resCustom.classList.remove('on');
    resBox.classList.add('hidden');
    refreshExpDims();
  });
  resCustom.addEventListener('click', () => {
    if (!state.image) return;
    if (!customRes) customRes = { w: state.image.width, h: state.image.height };
    num('resW').value = String(customRes.w);
    num('resH').value = String(customRes.h);
    resCustom.classList.add('on');
    resOrig.classList.remove('on');
    resBox.classList.remove('hidden');
    refreshResNote();
    refreshExpDims();
  });
  const onResInput = (which: 'w' | 'h') => {
    if (!state.image || !customRes) return;
    const rawW = num('resW').value, rawH = num('resH').value;
    if (!rawW || !rawH) return;
    let w = Math.max(1, Math.min(8192, Math.round(+rawW)));
    let h = Math.max(1, Math.min(8192, Math.round(+rawH)));
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;
    if (resLocked) {
      const r = state.image.width / state.image.height;
      if (which === 'w') {
        h = Math.max(1, Math.round(w / r));
        num('resH').value = String(h);
      } else {
        w = Math.max(1, Math.round(h * r));
        num('resW').value = String(w);
      }
    }
    customRes = { w, h };
    refreshResNote();
    refreshExpDims();
  };
  num('resW').addEventListener('input', () => onResInput('w'));
  num('resH').addEventListener('input', () => onResInput('h'));
  ($('#resLock') as HTMLButtonElement).addEventListener('click', (e) => {
    resLocked = !resLocked;
    (e.currentTarget as HTMLButtonElement).textContent = resLocked ? 'Aspect locked' : 'Aspect free';
    refreshResNote();
  });
  syncFxControls();
}

const bgPicker = (() => {
  const el = document.createElement('input');
  el.type = 'file';
  el.accept = 'image/*';
  el.hidden = true;
  document.body.appendChild(el);
  el.addEventListener('change', async () => {
    const f = el.files?.[0];
    el.value = '';
    if (!f) return;
    try {
      const before = snapshotParams();
      const ref = await decodeToImageRef(f, f.name);
      state.bg = { kind: 'image', image: ref };
      const after = snapshotParams();
      state.log.commit('background image', () => { restoreParams(before); refreshDisplay(); }, () => { restoreParams(after); refreshDisplay(); });
      refreshDisplay();
      syncUndoRedo();
      W.toast('Background image set');
    } catch (e) {
      W.toast(`Could not decode background: ${String(e).slice(0, 100)}`, true);
    }
  });
  return el;
})();

// ---------- recompute region + guided select ----------

function refineMode(): string | null {
  return (document.querySelector('[data-br].on') as HTMLElement | null)?.dataset.br ?? null;
}
function guidedMode(): 'erase' | 'restore' {
  const on = document.querySelector('[data-g].on') as HTMLElement | null;
  return on?.dataset.g === 'restore' ? 'restore' : 'erase';
}
function updateNoPan() {
  (W as any).__rmbgNoPan = refineMode() === 'recompute';
}

function toImageCoords(e: PointerEvent): { x: number; y: number } | null {
  const img = state.image;
  const checker = $('#checker') as HTMLElement;
  if (!img || !checker) return null;
  const r = checker.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  return {
    x: ((e.clientX - r.left) / r.width) * img.width,
    y: ((e.clientY - r.top) / r.height) * img.height,
  };
}

let recompBox: BBox | null = null;
function boxEl(): HTMLDivElement {
  let el = $('#recompBox') as HTMLDivElement | null;
  if (!el) {
    el = document.createElement('div');
    el.id = 'recompBox';
    el.style.cssText = 'position:absolute;border:1.5px dashed var(--accent);background:rgba(52,211,153,.08);display:none;z-index:6;pointer-events:none;border-radius:4px';
    ($('#checker') as HTMLElement).appendChild(el);
  }
  return el;
}

function installRefineCapture() {
  const stage = $('#stage') as HTMLElement;
  let anchor: { x: number; y: number } | null = null;
  let downAt: { x: number; y: number } | null = null;
  const boxToClient = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    // Percentages of the checker box: immune to zoom/pan, unlike screen px.
    // (Screen px matched only at 100% zoom — every other zoom drew the box
    // away from the cursor.)
    const img = state.image!;
    const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const el = boxEl();
    el.style.display = 'block';
    el.style.left = `${(x0 / img.width) * 100}%`;
    el.style.top = `${(y0 / img.height) * 100}%`;
    el.style.width = `${((x1 - x0) / img.width) * 100}%`;
    el.style.height = `${((y1 - y0) / img.height) * 100}%`;
  };
  stage.addEventListener('pointerdown', (e) => {
    if (!state.mask) return;
    if (refineMode() === 'recompute' && (e.button === 0 || e.pointerType !== 'mouse')) {
      if (guardEditing()) return;
      const pt = toImageCoords(e as PointerEvent);
      if (pt) { anchor = pt; boxToClient(pt, pt); }
    }
    downAt = { x: e.clientX, y: e.clientY };
  });
  stage.addEventListener('pointermove', (e) => {
    if (!anchor || refineMode() !== 'recompute') return;
    const pt = toImageCoords(e as PointerEvent);
    if (pt) boxToClient(anchor, pt);
  });
  stage.addEventListener('pointerup', (e) => {
    const moved = downAt ? Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) : 999;
    downAt = null;
    if (refineMode() === 'recompute') {
      const pt = anchor && toImageCoords(e as PointerEvent);
      if (anchor && pt) {
        const x = Math.round(Math.min(anchor.x, pt.x)), y = Math.round(Math.min(anchor.y, pt.y));
        const w = Math.round(Math.abs(pt.x - anchor.x)), h = Math.round(Math.abs(pt.y - anchor.y));
        if (w >= 8 && h >= 8 && state.image) {
          recompBox = {
            x: Math.max(0, x), y: Math.max(0, y),
            w: Math.min(state.image.width - Math.max(0, x), w),
            h: Math.min(state.image.height - Math.max(0, y), h),
          };
          W.toast('Region marked — hit Recompute selection');
        } else {
          recompBox = null;
          boxEl().style.display = 'none';
        }
      }
      anchor = null;
      return;
    }
    // Guided: a clean click (not a drag) selects + applies a region.
    if (refineMode() === 'guided' && moved < 6 && state.image && state.mask) {
      if (guardEditing()) return;
      const pt = toImageCoords(e as PointerEvent);
      if (pt) void guidedApply(pt.x, pt.y);
    }
    anchor = null;
  });
  ($('#btnRecompGo') as HTMLButtonElement)?.addEventListener('click', () => { void recomputeApply(); });
  $$('[data-tool],[data-br]').forEach((b) => b.addEventListener('click', () => {
    updateNoPan();
    if (refineMode() !== 'recompute') {
      recompBox = null;
      const el = $('#recompBox') as HTMLDivElement | null;
      if (el) el.style.display = 'none';
    }
  }));
  updateNoPan();
}

async function recomputeApply() {
  if (!state.image || !state.mask) return;
  if (guardEditing()) return;
  if (!recompBox) { W.toast('Drag a box over the problem area first'); return; }
  const box = { ...recompBox };
  startScan('Re-evaluating selection…');
  try {
    const img = state.image;
    const imgCopy = new Uint8ClampedArray(img.rgb);
    const maskCopy = new Float32Array(state.mask.alpha);
    const res = await callWorker({
      type: 'recompute', imageId: img.id,
      w: img.width, h: img.height, rgb: imgCopy.buffer,
      mw: state.mask.width, mh: state.mask.height, alpha: maskCopy.buffer,
      bbox: box,
    }, [imgCopy.buffer, maskCopy.buffer]);
    adoptBackend(res);
    commitMaskSwap('recompute region', { width: res.w, height: res.h, alpha: new Float32Array(res.alpha) });
    recompBox = null;
    (boxEl() as HTMLElement).style.display = 'none';
    refreshDisplay();
    W.toast('Region recomputed — rest untouched');
  } catch (e) {
    // Nothing was swapped, so the previous mask is still intact.
    W.toast(`Recompute failed: ${String(e).slice(0, 140)}`, true);
  } finally {
    stopScan();
  }
}

async function guidedApply(x: number, y: number) {
  // Caller already ran guardEditing(); this is belt-and-braces for the batch
  // path, which can reach here with removal switched off.
  if (!removalOn() || lastCompare === 'split') return;
  const img = state.image!, mask = state.mask!;
  const mode = guidedMode();
  // Grow on a downsampled copy: texture (spots, grain, fur) averages out so
  // one click selects the coherent subject, not a single spot. The grown
  // region is bilinearly upsampled back, which also softens its boundary.
  const S = 256;
  const s = Math.min(1, S / Math.max(img.width, img.height));
  const dw = Math.max(8, Math.round(img.width * s)), dh = Math.max(8, Math.round(img.height * s));
  const small: ImageRef = {
    id: img.id + '#guided', width: dw, height: dh,
    rgb: boxDownsampleRGB(img.rgb, img.width, img.height, dw, dh),
  };
  const grown = growRegion(small, x * s, y * s);
  if (grown.box.w < 3 || grown.box.h < 3) { W.toast('No clear region there — try another spot'); return; }
  const target = mode === 'erase' ? 0 : 1;
  const full = upsampleAlphaBilinear(grown.alpha, dw, dh, img.width, img.height);
  const { box } = grown;
  const fx0 = box.x / dw * img.width, fy0 = box.y / dh * img.height;
  const fx1 = (box.x + box.w) / dw * img.width, fy1 = (box.y + box.h) / dh * img.height;
  const fb = {
    x: Math.max(0, Math.floor(fx0)), y: Math.max(0, Math.floor(fy0)),
    w: Math.min(img.width, Math.ceil(fx1)) - Math.max(0, Math.floor(fx0)),
    h: Math.min(img.height, Math.ceil(fy1)) - Math.max(0, Math.floor(fy0)),
  };
  let touched = 0;
  state.log.commitRegion(mask, `guided ${mode}`, (m) => {
    for (let yy = 0; yy < fb.h; yy++) {
      for (let xx = 0; xx < fb.w; xx++) {
        if (full[(fb.y + yy) * img.width + (fb.x + xx)] > 0.5) {
          m.alpha[(fb.y + yy) * m.width + (fb.x + xx)] = target;
          touched++;
        }
      }
    }
    return touched === 0 ? { x: 0, y: 0, w: 0, h: 0 } : { ...fb };
  });
  if (touched === 0) { W.toast('No clear region there — try another spot'); return; }
  refreshDisplay();
  W.toast(`Guided ${mode}: region applied (undoable)`);
}

// ---------- batch queue (Stage 4) ----------
// Sequential job queue over the same worker: queued → processing →
// done/failed per item, overall progress, per-item retry. One inference
// session, never parallel (memory-bound). Failures export independently.

interface BatchItem {
  id: string;
  name: string;
  image: ImageRef;
  thumb: string;
  status: 'queued' | 'run' | 'done' | 'err';
  err?: string;
  mask?: AlphaMask;
}

const batch: BatchItem[] = [];
let batchPumping = false;
let batchBusy = false;
let batchSeq = 0;
/** A queued item holds full-res RGB (3 B/px) plus a Float32 mask (4 B/px), so
 *  the real constraint is pixels, not file count. `BATCH_MAX_ITEMS` alone let
 *  24 × 12 MP images through — ~1.7 GB — which OOMs a phone rather than
 *  degrading. 40 MP ≈ 280 MB resident, safe on ordinary mobile hardware.
 *  ZIP export additionally buffers every PNG, which the same cap bounds. */
const BATCH_MAX_PIXELS = 40e6;
const BATCH_MAX_ITEMS = 48;
let finishingWired = false;

function batchPixels(): number {
  let px = 0;
  for (const it of batch) px += it.image.width * it.image.height;
  return px;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function stem(name: string): string {
  const base = name.replace(/\.[a-z0-9]+$/i, '').replace(/[/\\?%*:|"<>]/g, '_').trim();
  return base || 'cutout';
}

/** Downscaled JPEG data-URL for the grid (never the full RGB). */
function thumbURL(img: ImageRef): string {
  const s = Math.min(1, 320 / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * s)), h = Math.max(1, Math.round(img.height * s));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  const id = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, ((x / w) * img.width) | 0);
      const sy = Math.min(img.height - 1, ((y / h) * img.height) | 0);
      const si = sy * img.width + sx, di = y * w + x;
      id.data[di * 4] = img.rgb[si * 3];
      id.data[di * 4 + 1] = img.rgb[si * 3 + 1];
      id.data[di * 4 + 2] = img.rgb[si * 3 + 2];
      id.data[di * 4 + 3] = 255;
    }
  }
  ctx.putImageData(id, 0, 0);
  return c.toDataURL('image/jpeg', 0.7);
}

function rgbToObjectURL(img: ImageRef): string {
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d')!;
  const id = ctx.createImageData(img.width, img.height);
  for (let i = 0; i < img.width * img.height; i++) {
    id.data[i * 4] = img.rgb[i * 3];
    id.data[i * 4 + 1] = img.rgb[i * 3 + 1];
    id.data[i * 4 + 2] = img.rgb[i * 3 + 2];
    id.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
  return c.toDataURL('image/png');
}

function renderBatch() {
  const g = $('#batchGrid') as HTMLElement;
  g.innerHTML = '';
  let done = 0;
  batch.forEach((it) => {
    if (it.status === 'done') done++;
    const badge = it.status === 'done' ? ['ok', '✓']
      : it.status === 'run' ? ['run', '…']
      : it.status === 'err' ? ['err', 'failed'] : ['wait', 'queued'];
    const d = document.createElement('div');
    d.className = 'bthumb';
    d.title = it.status === 'err' ? (it.err ?? 'failed') : it.name;
    d.innerHTML = `<div class="im"><img src="${it.thumb}" alt="" style="width:100%;height:100%;object-fit:cover;display:block"/>` +
      `<span class="badge ${badge[0]}" style="position:absolute;top:8px;left:8px">${badge[1]}</span></div>` +
      `<div class="meta"><span>${escapeHtml(it.name)}</span><span>${it.image.width}×${it.image.height}</span></div>` +
      `<div class="bar"><i style="width:${it.status === 'done' ? 100 : 0}%"></i></div>`;
    d.addEventListener('click', () => openBatchItem(it));
    if (it.status === 'err' || it.status === 'done') {
      const acts = document.createElement('div');
      acts.style.cssText = 'display:flex;gap:6px;padding:0 10px 10px';
      const b = document.createElement('button');
      b.className = 'btn small ghost';
      b.style.cssText = 'flex:1;justify-content:center';
      if (it.status === 'err') {
        b.textContent = 'Retry';
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          it.status = 'queued'; delete it.err;
          renderBatch();
          void pumpBatch();
        });
      } else {
        b.textContent = 'PNG ↓';
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          void downloadItemPNG(it);
        });
      }
      acts.appendChild(b);
      d.appendChild(acts);
    }
    g.appendChild(d);
  });
  $('#batchCount').textContent = `${done} / ${batch.length}`;
  // Contextual capability (SPEC §2.6): the editor only offers the queue once
  // there is a queue to go back to.
  ($('#btnToBatch') as HTMLElement)?.classList.toggle('hidden', batch.length === 0);
}

/** Strictly sequential: one worker, one inference at a time. */
async function pumpBatch(): Promise<void> {
  if (batchPumping) return;
  if (!batch.some((b) => b.status === 'queued')) return;
  batchPumping = true;
  try {
    $('#batchCount').textContent = 'loading model…';
    try {
      await ensureReady();
    } catch (e) {
      W.toast(`Model start failed: ${String(e).slice(0, 120)}`, true);
      return;
    }
    for (const it of batch) {
      if (it.status !== 'queued') continue;
      if (!($('#view-batch') as HTMLElement).classList.contains('on')) break; // paused: user left
      it.status = 'run';
      renderBatch();
      batchBusy = true;
      try {
        const copy = new Uint8ClampedArray(it.image.rgb);
        const res = await callWorker(
          { type: 'segment', imageId: it.image.id, w: it.image.width, h: it.image.height, rgb: copy.buffer },
          [copy.buffer],
        );
        it.mask = { width: res.w, height: res.h, alpha: new Float32Array(res.alpha) };
        it.status = 'done';
        delete it.err;
      } catch (e) {
        // One failure never blocks the rest of the queue.
        it.status = 'err';
        it.err = String(e).slice(0, 140);
      } finally {
        batchBusy = false;
      }
      renderBatch();
    }
  } finally {
    batchPumping = false;
    batchBusy = false;
    renderBatch();
  }
}

async function addBatchFiles(fs: FileList | File[]): Promise<void> {
  const list = [...fs].filter((f) => f.type.startsWith('image/'));
  if (list.length === 0) { W.toast('No image files', true); return; }
  for (const f of list) {
    if (batch.length >= BATCH_MAX_ITEMS) { W.toast(`Batch capped at ${BATCH_MAX_ITEMS} images`, true); break; }
    try {
      const ref = await decodeToImageRef(f, f.name || `img-${++batchSeq}`);
      // Dimensions are only known after decoding; the rejected buffer is
      // transient and collectable, so the check costs one decode, not memory.
      const used = batchPixels(), px = ref.width * ref.height;
      if (used + px > BATCH_MAX_PIXELS) {
        const left = Math.max(0, BATCH_MAX_PIXELS - used);
        W.toast(
          `Batch memory budget reached (${(used / 1e6).toFixed(0)} / ${(BATCH_MAX_PIXELS / 1e6).toFixed(0)} MP` +
          `${left > 0 ? `, ~${(left / 1e6).toFixed(0)} MP left` : ''}) — ${f.name} not added`,
          true,
        );
        break;
      }
      batch.push({
        id: `${Date.now()}-${batchSeq++}`, name: f.name || 'image',
        image: ref, thumb: thumbURL(ref), status: 'queued',
      });
    } catch {
      W.toast(`Could not decode ${f.name}`, true);
    }
  }
  renderBatch();
  void pumpBatch();
}

/** True when switching away from the current image would destroy work.
 *  `state.log.depth` is the honest signal: every brush stroke, guided select,
 *  region recompute and finishing change is one entry, and the entry carries
 *  the pixels needed to put it back. Note it is only trustworthy because the
 *  AI/batch baseline no longer commits a no-op entry — see openBatchItem. */
function hasUnsavedWork(): boolean {
  return !!state.mask && state.log.depth > 0;
}

/** Any batch item opens in the full single-image flow (same engine, same mask model). */
async function openBatchItem(it: BatchItem) {
  if (batchBusy) { W.toast('Batch is using the model — wait a few seconds', true); return; }
  // Opening an item REPLACES the one global editor session: image, mask, undo
  // history, effects, background and transform are all overwritten below, and
  // the old preview URL is revoked. There is no undo for that, so never do it
  // silently while the user has work in the session.
  if (hasUnsavedWork() && state.image !== it.image) {
    const n = state.log.depth;
    const ok = await confirmAction(
      'Discard this session?',
      `Opening "${it.name}" replaces the image you are editing. Your cutout, `
      + `${n} undo step${n === 1 ? '' : 's'}, effects and background will be reset, `
      + 'and cannot be recovered.',
      'Discard and open',
    );
    if (!ok) return;
  }
  state.image = it.image;
  state.mask = it.mask
    ? { width: it.mask.width, height: it.mask.height, alpha: new Float32Array(it.mask.alpha) }
    : null;
  // No baseline history entry for the mask we just adopted. The old code
  // committed one with a null box, which snapshotted the mask as its own
  // pre-image: undo reported "Undone: batch", changed nothing, and burned a
  // slot (the same defect the AI entry had).
  state.log = new OpLog();
  state.fx = JSON.parse(JSON.stringify(FX_OFF));
  state.bg = { ...BG_TRANSPARENT };
  state.tr = { ...TR_IDENTITY };
  // A finished batch item opens showing its cutout; an unprocessed one opens on
  // the original, and its switch is live so one tap segments it.
  state.removeBg = state.mask !== null;
  if (state.previewURL) URL.revokeObjectURL(state.previewURL);
  state.previewURL = rgbToObjectURL(it.image);
  const up = $('#uploadedImg') as HTMLImageElement;
  up.src = state.previewURL;
  ($('#demoSubject') as HTMLElement).style.display = 'none';
  $('#dimLbl').textContent = `${it.image.width} × ${it.image.height}`;
  ensureCanvases(it.image);
  if (!finishingWired) { wireFinishing(); finishingWired = true; }
  resetExportRes();
  W.showView('view-editor');
  if (state.mask) {
    lastCompare = 'after';
    refreshDisplay();
  } else {
    lastCompare = 'before';
    up.style.display = 'block';
    if (resultCanvas) resultCanvas.style.display = 'none';
    syncUndoRedo();
    W.toast('No cutout yet for this image');
  }
}

function enterBatch() {
  W.showView('view-batch');
  renderBatch();
  void pumpBatch(); // resumes anything still queued
}

async function downloadItemPNG(it: BatchItem): Promise<void> {
  if (!it.mask) return;
  const tmp = document.createElement('canvas');
  drawComposite(tmp, { image: it.image, mask: it.mask }, { kind: 'transparent' }, FX_OFF);
  const blob: Blob | null = await new Promise((res) => tmp.toBlob(res, 'image/png'));
  if (!blob) { W.toast(`Export failed for ${it.name}`, true); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${stem(it.name)}-cutout.png`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  W.toast(`Exported ${a.download}`);
}

// Minimal stored (uncompressed) ZIP writer: one single-file download instead
// of N blocked popups, zero dependencies.
const CRC_T = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(d: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < d.length; i++) c = CRC_T[(c ^ d[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function zipStore(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const push = (p: Uint8Array) => { chunks.push(p); total += p.length; };
  const h16 = (v: number) => new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF]);
  const h32 = (v: number) => new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]);
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | ((now.getSeconds() / 2) | 0);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const central: Uint8Array[] = [];
  let cenTotal = 0;
  const cpush = (p: Uint8Array) => { central.push(p); cenTotal += p.length; };
  let off = 0;
  for (const f of files) {
    const nb = enc.encode(f.name);
    const crc = crc32(f.data);
    const head = new Uint8Array(30 + nb.length);
    const dv = new DataView(head.buffer);
    dv.setUint32(0, 0x04034B50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0x0800, true);
    dv.setUint16(8, 0, true);
    dv.setUint16(10, dosTime, true);
    dv.setUint16(12, dosDate, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, f.data.length, true);
    dv.setUint32(22, f.data.length, true);
    dv.setUint16(26, nb.length, true);
    dv.setUint16(28, 0, true);
    head.set(nb, 30);
    push(head);
    push(f.data);
    cpush(new Uint8Array([
      ...h32(0x02014B50), ...h16(20), ...h16(20), ...h16(0x0800), ...h16(0),
      ...h16(dosTime), ...h16(dosDate), ...h32(crc), ...h32(f.data.length), ...h32(f.data.length),
      ...h16(nb.length), ...h16(0), ...h16(0), ...h16(0), ...h16(0), ...h32(0), ...h32(off),
    ]));
    cpush(nb);
    off += head.length + f.data.length;
  }
  const cenOff = off;
  for (const c of central) push(c);
  push(new Uint8Array([
    ...h32(0x06054B50), ...h16(0), ...h16(0), ...h16(files.length), ...h16(files.length),
    ...h32(cenTotal), ...h32(cenOff), ...h16(0),
  ]));
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

async function exportAllZIP(): Promise<void> {
  const doneItems = batch.filter((b) => b.status === 'done' && b.mask);
  if (doneItems.length === 0) { W.toast('Nothing finished yet', true); return; }
  const files: { name: string; data: Uint8Array }[] = [];
  let i = 0;
  for (const it of doneItems) {
    $('#batchCount').textContent = `Exporting ${i} / ${doneItems.length}…`;
    const tmp = document.createElement('canvas');
    drawComposite(tmp, { image: it.image, mask: it.mask! }, { kind: 'transparent' }, FX_OFF);
    const blob: Blob | null = await new Promise((res) => tmp.toBlob(res, 'image/png'));
    if (!blob) { W.toast(`Export failed for ${it.name}`, true); continue; }
    files.push({ name: `${stem(it.name)}-cutout.png`, data: new Uint8Array(await blob.arrayBuffer()) });
    i++;
  }
  if (files.length === 0) { renderBatch(); return; }
  const zip = zipStore(files);
  const url = URL.createObjectURL(new Blob([zip.buffer as ArrayBuffer], { type: 'application/zip' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'rmbg-batch.zip';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  renderBatch();
  W.toast(`Exported ${files.length} cutout${files.length === 1 ? '' : 's'} (.zip)`);
}

const batchPicker = (() => {
  const el = document.createElement('input');
  el.type = 'file';
  el.accept = 'image/*';
  el.multiple = true;
  el.hidden = true;
  document.body.appendChild(el);
  el.addEventListener('change', () => {
    // Copy first: resetting el.value below drains the live FileList.
    const fs = [...(el.files ?? [])];
    el.value = '';
    if (fs.length > 0) void addBatchFiles(fs);
  });
  return el;
})();

// ---------- footer ----------
// NOTE: the live GitHub star counter was removed here. It fired an
// `api.github.com` request on every visitor's first load of the day, which
// discloses their IP to a third party on a page whose entire promise is
// "no analytics, no tracking, no upload" (SPEC §10). The footer keeps a plain
// link to the repository instead.

// ---------- destructive-action confirm ----------
// One small modal for actions that destroy work the user cannot get back.
// There is exactly one such action today (opening a batch item replaces the
// editor session), so a shared promise-based helper is enough; no framework.
let confirmResolve: ((v: boolean) => void) | null = null;

function confirmAction(title: string, body: string, okLabel = 'Discard'): Promise<boolean> {
  ($('#confirmTitle') as HTMLElement).textContent = title;
  ($('#confirmBody') as HTMLElement).textContent = body;
  const ok = $('#confirmOk') as HTMLButtonElement;
  ok.textContent = okLabel;
  ok.classList.toggle('danger', true);
  ($('#confirmWrap') as HTMLElement).classList.add('on');
  // Focus the safe choice, so Enter/Escape can never destroy work by accident.
  const cancel = document.querySelector('#confirmWrap [data-no-confirm]:not(.scrim)') as HTMLElement | null;
  cancel?.focus();
  return new Promise<boolean>((resolve) => { confirmResolve = resolve; });
}

function closeConfirm(result: boolean) {
  ($('#confirmWrap') as HTMLElement).classList.remove('on');
  const r = confirmResolve;
  confirmResolve = null;
  r?.(result);
}

// ---------- issue reporter ----------
// Toasts + window errors feed a small ring buffer so a GitHub issue draft
// can carry real diagnostics. Pixel-free by construction: only short text.
const diagLog: string[] = [];
function noteDiag(kind: string, msg: string) {
  const t = new Date().toISOString().slice(11, 19);
  diagLog.push(`[${t}] ${kind}: ${String(msg).slice(0, 150)}`);
  if (diagLog.length > 60) diagLog.splice(0, diagLog.length - 60);
}

function buildDiag(logLines = 30): string {
  const L: string[] = [];
  L.push('### App diagnostics (auto-collected, no image pixels included)');
  L.push(`- Time: ${new Date().toISOString()}`);
  L.push(`- Backend: ${state.backend} (GPU: ${gpuDesc})`);
  L.push(`- Model: ${MODEL_ID} rev ${MODEL_REV} (cache bucket: ${cacheName})`);
  L.push(`- Image: ${state.image ? `${state.image.width}x${state.image.height}` : 'none loaded'}`);
  L.push(`- Mask: ${state.mask ? `${state.mask.width}x${state.mask.height}` : 'none'}`);
  L.push(`- Background: ${state.bg.kind}; shadow ${state.fx.shadow.on ? 'on' : 'off'}` +
    `; feather ${state.fx.feather}; defringe ${state.fx.defringe}`);
  L.push(`- UA: ${navigator.userAgent}`);
  L.push(`- Page: ${location.origin}${location.pathname}`);
  L.push('');
  L.push('<details><summary>Recent log</summary>');
  L.push('');
  L.push('```');
  const tail = diagLog.slice(-logLines);
  L.push(tail.length > 0 ? tail.join('\n') : '(empty)');
  L.push('```');
  L.push('</details>');
  return L.join('\n');
}

function openReport() {
  ( $('#repTitle') as HTMLInputElement).value = '';
  ( $('#repBody') as HTMLTextAreaElement).value = '';
  ( $('#diagPre') as HTMLElement).textContent = buildDiag();
  ( $('#reportWrap') as HTMLElement).classList.add('on');
}

function submitReport() {
  const title = (( $('#repTitle') as HTMLInputElement).value.trim() || 'Issue report').slice(0, 200);
  const details = ( $('#repBody') as HTMLTextAreaElement).value.trim().slice(0, 3000);
  let logLines = 30;
  let url = '';
  for (;;) {
    const diag = buildDiag(logLines);
    const body = (details ? details + '\n\n' : '_No description yet — writing on GitHub._\n\n') + '---\n' + diag;
    url = `https://github.com/Velmet44/rmbg/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
    if (url.length <= 7500 || logLines <= 0) break;
    logLines = logLines > 10 ? 10 : 0;
  }
  window.open(url, '_blank', 'noopener');
  W.toast('Issue draft opened on GitHub — review and submit there');
}

// ---------- install overrides ----------

W.loadFile = realLoadFile;
W.startPreparing = realStart;
W.setCompare = realCompare;
W.runExport = realExport;
// The overlay is owned here, not by the shell: its duration has to equal the
// work's duration, which only the code awaiting the worker knows.
W.startScan = startScan;
W.stopScan = stopScan;
installStrokeCapture();
syncStrokeButtons();
installRefineCapture();
wireExportDrawer();
installRemoveSwitch();
syncRemoveSwitch();
// Scroll reveal for the FAQ (and anything else marked .reveal): fade/slide
// in on entry, once. Root is the landing scroller; reduced-motion users
// get everything visible immediately via CSS.
{
  const root = $('#view-landing') as HTMLElement | null;
  const els = Array.from(document.querySelectorAll('.reveal'));
  els.forEach((el, i) => ((el as HTMLElement).style.transitionDelay = `${Math.min(i, 10) * 40}ms`));
  if (root && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          (e.target as HTMLElement).classList.add('in');
          io.unobserve(e.target);
        }
      }
    }, { root, threshold: 0.15 });
    els.forEach((el) => io.observe(el));
  } else {
    els.forEach((el) => el.classList.add('in'));
  }
}
// Footer FAQ link smooth-scrolls to the section (href is the no-JS fallback).
document.querySelector('#faqLink')?.addEventListener('click', (e) => {
  e.preventDefault();
  ($('#faq') as HTMLElement)?.scrollIntoView({
    behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    block: 'start',
  });
});
// Grey out AVIF up front on browsers without an encoder (never silently
// encode the wrong format — realExport also guards at click time).
void avifSupported().then((ok) => {
  if (ok) return;
  const b = document.querySelector('.fmt[data-fmt="AVIF"]') as HTMLButtonElement | null;
  if (b) {
    b.disabled = true;
    b.title = 'AVIF encoding is not supported in this browser';
  }
});
// Feed the diagnostics buffer from every app toast + uncaught error.
// (Mock shell toasts bypass this — only real-flow messages are collected.)
{
  const raw = W.toast?.bind(W);
  W.toast = (m: string, e?: boolean) => {
    noteDiag(e ? 'error' : 'info', String(m));
    raw?.(m, e);
  };
  window.addEventListener('error', (ev) => noteDiag('onerror', String(ev.message ?? ev)));
}
// Footer "Report an issue" opens the prefilled-draft drawer; the href stays
// as a no-JS fallback. Drawer closes via scrim, Cancel, or Escape.
($('#btnSendReport') as HTMLButtonElement).onclick = submitReport;
$$('[data-close-report]').forEach((b) => ((b as HTMLElement).onclick = () => {
  ($('#reportWrap') as HTMLElement).classList.remove('on');
}));
document.querySelector('#landingFoot a[href*="/issues"]')?.addEventListener('click', (e) => {
  e.preventDefault();
  openReport();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') ($('#reportWrap') as HTMLElement).classList.remove('on');
  // Escape means "no" — never let it mean "destroy my work".
  if (e.key === 'Escape' && ($('#confirmWrap') as HTMLElement).classList.contains('on')) {
    e.preventDefault();
    closeConfirm(false);
  }
});
// Confirm dialog: scrim, Cancel and Confirm all settle the same promise, so
// there is exactly one exit path per outcome.
$$('[data-no-confirm]').forEach((b) => (b as HTMLElement).addEventListener('click', () => closeConfirm(false)));
($('#confirmOk') as HTMLButtonElement).onclick = () => closeConfirm(true);

$('#btnRecompute').addEventListener('click', () => { void rerun(); });
// Real Back-cancel (overrides the mockup shell's view-only binding, which
// never stopped the worker job). The warm session is kept; only the UI run
// is invalidated via prepToken.
($('#btnPrepCancel') as HTMLButtonElement).onclick = () => {
  prepToken++;
  stopElapsed();
  W.showView('view-landing');
};
// Real batch queue (overrides the mockup shell's toast/toy tiles).
($('#btnBatch') as HTMLButtonElement).onclick = enterBatch;
// The editor had no route back to the queue: Back and New image both go to the
// landing, and the only Batch button lived there. Returning to the queue is not
// destructive (the session stays intact), so it needs no confirmation — the
// queue itself pauses while the editor is open (see pumpBatch).
($('#btnToBatch') as HTMLButtonElement).onclick = enterBatch;
($('#btnBatchAdd') as HTMLButtonElement).onclick = () => batchPicker.click();
($('#btnBatchExport') as HTMLButtonElement).onclick = () => { void exportAllZIP(); };
{
  const grid = $('#batchGrid') as HTMLElement;
  grid.addEventListener('dragover', (e) => e.preventDefault());
  grid.addEventListener('drop', (e) => {
    e.preventDefault();
    const fs = e.dataTransfer?.files;
    if (fs && fs.length > 0) void addBatchFiles(fs);
  });
  const pill = document.querySelector('#view-batch .pill') as HTMLElement | null;
  // Disclose the cap rather than letting a silent refusal surprise the user.
  if (pill) pill.textContent = `On-device · sequential · ≤${BATCH_MAX_PIXELS / 1e6} MP in memory`;
  renderBatch(); // clear the mockup's toy tiles on boot
}
function syncUndoRedo() {
  ( $('#btnUndo') as HTMLButtonElement).disabled = !state.log.canUndo || !state.mask;
  ( $('#btnRedo') as HTMLButtonElement).disabled = !state.log.canRedo || !state.mask;
}

// Real undo/redo over the operation log (the mockup shell binds mock
// handlers directly, so rebind). Covers AI removal and recomputation;
// brush-level ops arrive with Stage 3.
($('#btnUndo') as HTMLButtonElement).onclick = () => {
  if (!state.mask) return;
  const label = state.log.undo();
  if (label) { refreshDisplay(); W.toast(`Undone: ${label}`); }
  syncUndoRedo();
};
($('#btnRedo') as HTMLButtonElement).onclick = () => {
  if (!state.mask) return;
  const label = state.log.redo();
  if (label) { refreshDisplay(); W.toast(`Redone: ${label}`); }
  syncUndoRedo();
};
// The mockup shell binds the mock export directly; rebind to the real one.
($('#btnDoExport') as HTMLButtonElement).onclick = () => { void realExport(); };

// Prefetch the model on page load so the first drop starts warm.
// One-time download into the browser cache; silent unless it fails.
// ?noprefetch=1 skips it (metered connections; also the deterministic way
// to exercise the cold-download path when testing).
if (!new URLSearchParams(location.search).has('noprefetch')) {
  callWorker({ type: 'init' }).then(
    (res) => { state.backend = res.backend ?? 'cached'; },
    () => { /* first real use will surface the error with UI */ },
  );
}

export {};
