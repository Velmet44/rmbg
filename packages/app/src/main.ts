// RMBG app wiring. The mockup shell in index.html owns all UI behavior;
// this module overrides the ingest/remove/export paths with the real local
// engine. Model download + session + segmentation run in a Web Worker, so
// the page stays responsive; compositing/export stay on the main thread.
// Everything runs on-device: model bytes go to the browser cache once,
// image pixels never leave. Single model tier (fast).
//
// Not yet wired (later stages, UI toasts as such): refine brushes affect only
// a visual overlay layer, background/effects panels, custom resolution, batch.

import {
  OpLog,
  applyBrushStroke,
  composite,
  type AlphaMask,
  type Background,
  type BrushStroke,
  type Effects,
  type ImageRef,
  type ModelProgress,
} from '@rmbg/engine';

const W = window as unknown as Record<string, any>;
const $ = (s: string) => document.querySelector(s) as HTMLElement;
const $$ = (s: string) => Array.from(document.querySelectorAll(s)) as HTMLElement[];

const FX_OFF: Effects = {
  shadow: { on: false, opacity: 0.4, blur: 18, dx: 0, dy: 12 },
  feather: 0,
  defringe: 0,
};
const BG_TRANSPARENT: Background = { kind: 'transparent' };

interface AppState {
  image: ImageRef | null;
  previewURL: string | null;
  mask: AlphaMask | null;
  backend: string;
  log: OpLog;
}

const state: AppState = { image: null, previewURL: null, mask: null, backend: '…', log: new OpLog() };

// ---------- worker client ----------
// One request at a time (the worker enforces it too); responses route by id.
// Progress events stream separately so the bar and phase text stay live.
const worker = new Worker(new URL('./infer-worker.ts', import.meta.url), { type: 'module' });
let reqId = 0;
interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  onProgress?: (p: ModelProgress & { id: number; type: string }) => void;
}
const pending = new Map<number, Pending>();
worker.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m?.type === 'progress') {
    pending.get(m.id)?.onProgress?.(m);
    return;
  }
  const p = pending.get(m?.id);
  if (!p) return;
  pending.delete(m.id);
  if (m?.type === 'error') p.reject(new Error(m.message || 'worker failed'));
  else p.resolve(m);
};
worker.onerror = (e) => {
  W.toast?.(`Background worker crashed: ${(e as ErrorEvent).message || 'unknown'} — reload to retry`, true);
};
function callWorker(
  msg: Record<string, any>, transfer?: Transferable[],
  onProgress?: Pending['onProgress'],
): Promise<any> {
  const id = ++reqId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    worker.postMessage({ ...msg, id }, transfer ?? []);
  });
}

// ---------- helpers ----------

function setBar(frac: number, mbText: string, totalText?: string) {
  ($('#prepBar') as HTMLElement).style.width = `${Math.min(100, Math.max(0, frac * 100))}%`;
  $('#prepMB').textContent = mbText;
  $('#prepPct').textContent = `${Math.round(frac * 100)}%`;
  if (totalText !== undefined) {
    const t = $('#prepTotal') as HTMLElement | null;
    if (t) t.textContent = totalText;
  }
}

function fmtMB(n: number): string {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

/** True cache check: look for our model files in the Cache API instead of
 *  guessing from event timing. */
async function isModelCached(): Promise<boolean> {
  try {
    const cache = await caches.open('transformers-cache');
    const keys = await cache.keys();
    return keys.some((r) => r.url.includes('birefnet-lite-512'));
  } catch {
    return false; // Cache API unavailable (private mode etc.) → assume miss
  }
}

/** Phased, honest progress for worker init.
 *  - initiate with no later download = served from cache.
 *  - download + progress = bytes flowing (determinate MB bar).
 *  - all done = session build ("Loading into memory…"). */
function makeInitProgress() {
  const pendingFiles = new Set<string>();
  const bytes = new Map<string, { loaded: number; total: number }>();
  let sawDownload = false;
  let finished = false;
  const draw = () => {
    let l = 0, t = 0;
    for (const f of bytes.values()) { l += f.loaded; t += f.total; }
    if (t > 0) setBar(l / t, `${fmtMB(l)}`, `${fmtMB(t)} · cached after first visit`);
  };
  return {
    onEvent(p: ModelProgress) {
      if (finished) return;
      if (p.status === 'initiate') pendingFiles.add(p.file);
      else if (p.status === 'download') { sawDownload = true; pendingFiles.add(p.file); }
      else if (p.status === 'progress' && p.total) {
        sawDownload = true;
        bytes.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
        draw();
      } else if (p.status === 'done') {
        pendingFiles.delete(p.file);
        if (sawDownload && pendingFiles.size === 0) {
          $('#prepTitle').textContent = 'Preparing local AI…';
          setBar(1, 'download complete — loading into memory…');
        }
      }
    },
    finish() { finished = true; },
  };
}

async function ensureReady(): Promise<void> {
  const tracker = makeInitProgress();
  try {
    const res = await callWorker({ type: 'init' }, undefined, (p) => tracker.onEvent(p));
    state.backend = res.backend ?? 'unknown';
  } finally {
    tracker.finish();
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
let splitCanvas: HTMLCanvasElement | null = null;
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
  const splitR = $('#splitR') as HTMLElement;
  if (!splitCanvas) {
    splitCanvas = document.createElement('canvas');
    splitCanvas.style.cssText = 'max-width:90%;max-height:70%';
    splitR.appendChild(splitCanvas);
  }
  const splitImg = $('#splitOrig') as HTMLImageElement | null;
  const splitL = $('#splitL') as HTMLElement;
  if (!splitImg && state.previewURL) {
    // Real photo replaces the mock gradient: exact cover, same aspect as the
    // checker (fitChecker sizes the stage to the image).
    splitL.style.background = 'none';
    const svg = splitL.querySelector('svg');
    if (svg) (svg as unknown as HTMLElement).style.display = 'none';
    const el = document.createElement('img');
    el.id = 'splitOrig';
    el.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover';
    splitL.appendChild(el);
    el.src = state.previewURL;
  } else if (splitImg && state.previewURL) {
    splitImg.src = state.previewURL;
  }
}

function drawComposite(target: HTMLCanvasElement, mask: AlphaMask, bg: Background, maxSide = 0) {
  const img = state.image!;
  const out = composite(img, mask, bg, FX_OFF);
  // Reused scratch canvas: avoids a full-res allocation per redraw.
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

const blit = document.createElement('canvas');

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

function refreshDisplay() {
  if (!state.image || !state.mask || !resultCanvas) return;
  syncUndoRedo();
  syncStrokeButtons();
  const demo = $('#demoSubject') as HTMLElement;
  demo.style.display = 'none';
  const up = $('#uploadedImg') as HTMLImageElement;
  if (lastCompare === 'before') {
    up.style.display = 'block';
    resultCanvas.style.display = 'none';
  } else if (lastCompare === 'mask') {
    up.style.display = 'none';
    resultCanvas.style.display = 'block';
    drawMaskGray(resultCanvas, state.mask);
  } else {
    up.style.display = 'none';
    resultCanvas.style.display = 'block';
    drawComposite(resultCanvas, state.mask, BG_TRANSPARENT);
  }
  if (splitCanvas) drawComposite(splitCanvas, state.mask, BG_TRANSPARENT, 480);
}

// ---------- real flows (override mockup globals) ----------

async function realLoadFile(f: File) {
  if (!f.type.startsWith('image/')) { W.toast('Not an image file', true); return; }
  try {
    const ref = await decodeToImageRef(f, f.name);
    state.image = ref;
    state.mask = null;
    state.log = new OpLog();
    if (state.previewURL) URL.revokeObjectURL(state.previewURL);
    state.previewURL = URL.createObjectURL(f);
    const up = $('#uploadedImg') as HTMLImageElement;
    up.src = state.previewURL;
    $('#dimLbl').textContent = `${ref.width} × ${ref.height}`;
    $('#expDims').textContent = `${ref.width} × ${ref.height} · PNG · transparent`;
    ensureCanvases(ref);
    W.startPreparing(false);
  } catch (e) {
    W.toast(`Could not decode that image: ${String(e)}`, true);
  }
}

async function segmentCurrent(label: string): Promise<AlphaMask> {
  const img = state.image!;
  // Copy: the buffer is transferred to the worker (neutering the copy keeps
  // the main-thread original intact for compositing).
  const copy = new Uint8ClampedArray(img.rgb);
  const res = await callWorker({ type: 'segment', imageId: img.id, w: img.width, h: img.height, rgb: copy.buffer }, [copy.buffer]);
  const mask: AlphaMask = { width: res.w, height: res.h, alpha: new Float32Array(res.alpha) };
  state.log.commitRegion(mask, label, () => null);
  return mask;
}

async function realStart(_withDemo: boolean) {
  if (!state.image) { W.toast('Pick an image first', true); W.showView('view-landing'); return; }
  W.showView('view-preparing');
  ($('#prepRing') as HTMLElement).style.display = 'block';
  $('#prepTitle').textContent = 'Preparing local AI…';
  setBar(0, 'Checking cache…');
  try {
    // Real cache verdict (Cache API), never a timing guess: the label must
    // not claim "cached" unless the files are actually there.
    if (await isModelCached()) {
      $('#prepTitle').textContent = 'Model cached — loading…';
      setBar(0, 'found in this browser, no download needed');
    } else {
      setBar(0, 'Downloading model… (one-time, ~98 MB)');
    }
    await ensureReady();
    $('#prepTitle').textContent = 'Removing background…';
    setBar(1, `running on-device (${state.backend}) — the page stays usable`);
    const t0 = performance.now();
    state.mask = await segmentCurrent('ai');
    W.showView('view-editor');
    lastCompare = 'after';
    refreshDisplay();
    W.runScan('Detecting subject…');
    W.toast(`Background removed in ${((performance.now() - t0) / 1000).toFixed(1)}s · ${state.backend}`);
    setTimeout(() => $('#fb').classList.add('on'), 2500);
    // The bubble overlaps the canvas: dismiss it automatically, it stays
    // one tap away via Refine if the user disagrees later.
    setTimeout(() => $('#fb').classList.remove('on'), 14000);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    $('#prepTitle').textContent = 'Could not start the local model';
    // Full error on screen (not just the toast): failures must be diagnosable.
    setBar(0, `failed: ${msg.slice(0, 300)}`);
    W.toast(`Model start failed: ${msg.slice(0, 160)}`, true);
  }
}

async function rerun() {
  if (!state.image) return;
  W.runScan('Recomputing…');
  try {
    state.mask = await segmentCurrent('recompute');
    refreshDisplay();
    W.toast('Recomputed');
  } catch (e) {
    W.toast(`Recompute failed: ${String(e).slice(0, 120)}`, true);
  }
}

function realCompare(m: string) {
  lastCompare = m;
  ($('#splitUI') as HTMLElement).classList.toggle('on', m === 'split');
  $$('.seg button').forEach((b) => (b as HTMLElement).classList.toggle('on', (b as HTMLElement).dataset.view === m));
  if (!state.mask) { W.toast(m === 'mask' ? 'Mask: white kept · black removed' : 'Original pixels — never destroyed'); return; }
  refreshDisplay();
  if (m === 'before') W.toast('Original pixels — never destroyed');
  if (m === 'mask') W.toast('Mask: white kept · black removed · gray partial');
}

function selectedFormat(): string {
  const on = document.querySelector('.fmt.on') as HTMLElement | null;
  return on?.dataset.fmt ?? 'PNG';
}

async function realExport() {
  if (!state.image || !state.mask || !resultCanvas) { W.toast('Nothing to export yet', true); return; }
  const fmt = selectedFormat();
  ($('#btnDoExport') as HTMLElement).textContent = `Export ${fmt}`;
  const wrap = $('#expProgWrap') as HTMLElement;
  wrap.classList.remove('hidden');
  ($('#expBar') as HTMLElement).style.width = '15%';
  try {
    let canvas = resultCanvas;
    let note = `${state.image.width} × ${state.image.height} · ${fmt}`;
    if (fmt === 'JPEG' && (document.querySelector('[data-bg].on') as HTMLElement | null)?.dataset.bg !== 'color') {
      // JPEG cannot carry transparency: composite onto white for this export
      // only (stated, never silent), without touching the stored mask.
      const tmp = document.createElement('canvas');
      drawComposite(tmp, state.mask, { kind: 'color', color: [255, 255, 255] });
      canvas = tmp;
      note += ' · flattened onto white (JPEG has no transparency)';
    }
    ($('#expBar') as HTMLElement).style.width = '60%';
    const mime = fmt === 'PNG' ? 'image/png' : fmt === 'WebP' ? 'image/webp' : 'image/jpeg';
    const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, mime, 0.92));
    if (!blob) throw new Error('encoder returned nothing');
    ($('#expBar') as HTMLElement).style.width = '100%';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `rmbg-export.${fmt.toLowerCase()}`;
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
    const paint = $('#paintLayer') as HTMLCanvasElement | null;
    const sx = paint && paint.width > 0 ? state.mask.width / paint.width : 1;
    const sy = paint && paint.height > 0 ? state.mask.height / paint.height : 1;
    try {
      for (const s of pendingStrokes) {
        const stroke: BrushStroke = {
          points: s.points.map((p) => ({ x: p.x * sx, y: p.y * sy })),
          size: s.size * sx,
          softness: s.softness,
        };
        // One undo step per stroke.
        applyBrushDirect(state.mask, stroke, s.mode);
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

function applyBrushDirect(mask: AlphaMask, stroke: BrushStroke, mode: 'erase' | 'restore') {
  state.log.commitRegion(mask, mode, (m) => {
    const box = applyBrushStroke(m, stroke, mode);
    return box.w === 0 ? { x: 0, y: 0, w: 0, h: 0 } : box;
  });
}

// ---------- install overrides ----------

W.loadFile = realLoadFile;
W.startPreparing = realStart;
W.setCompare = realCompare;
W.runExport = realExport;
installStrokeCapture();
syncStrokeButtons();

$('#btnRecompute').addEventListener('click', () => { void rerun(); });
function syncUndoRedo() {
  ( $('#btnUndo') as HTMLButtonElement).disabled = !state.log.canUndo || !state.mask;
  ( $('#btnRedo') as HTMLButtonElement).disabled = !state.log.canRedo || !state.mask;
}

// Real undo/redo over the operation log (the mockup shell binds mock
// handlers directly, so rebind). Covers AI removal and recomputation;
// brush-level ops arrive with Stage 3.
($('#btnUndo') as HTMLButtonElement).onclick = () => {
  if (!state.mask) return;
  const label = state.log.undo(state.mask);
  if (label) { refreshDisplay(); W.toast(`Undone: ${label}`); }
  syncUndoRedo();
};
($('#btnRedo') as HTMLButtonElement).onclick = () => {
  if (!state.mask) return;
  const label = state.log.redo(state.mask);
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
