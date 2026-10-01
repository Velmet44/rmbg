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
  boxDownsampleRGB,
  composite,
  contractInPlace,
  featherInPlace,
  growRegion,
  invertTransformPoint,
  isIdentityTransform,
  transformSubject,
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
  backend: string;
  log: OpLog;
  fx: Effects;
  bg: Background;
  tr: SubjectTransform;
}

const state: AppState = {
  image: null, previewURL: null, mask: null, backend: '…', log: new OpLog(),
  fx: JSON.parse(JSON.stringify(FX_OFF)), bg: { ...BG_TRANSPARENT }, tr: { ...TR_IDENTITY },
};

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
 *  touched except by AI, brushes, guided, and recompute. */
function derivedView(): { image: ImageRef; mask: AlphaMask } {
  const img = state.image!, msk = state.mask!;
  let image = img, mask = msk;
  if (state.bg.kind !== 'transparent' && !isIdentityTransform(state.tr)) {
    const t = transformSubject(img, msk, state.tr);
    image = t.image; mask = t.mask;
  }
  if (state.fx.feather > 0 || state.fx.defringe > 0) {
    const copy: AlphaMask = { width: mask.width, height: mask.height, alpha: new Float32Array(mask.alpha) };
    if (state.fx.defringe > 0) contractInPlace(copy, state.fx.defringe);
    if (state.fx.feather > 0) featherInPlace(copy, state.fx.feather);
    mask = copy;
  }
  return { image, mask };
}

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

/** True cache check: the WEIGHTS file must be present, not just configs.
 *  (A partial cache — config.json without the ~100 MB onnx — must read as
 *  a miss, or the UI claims "cached" and then stalls with no byte events.) */
async function isModelCached(): Promise<boolean> {
  try {
    const cache = await caches.open('transformers-cache');
    const keys = await cache.keys();
    return keys.some((r) => /birefnet-lite-512.*\.onnx/i.test(r.url));
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
 *  - initiate with no later download = served from cache.
 *  - download + progress = bytes flowing (determinate MB bar).
 *  - all done = session build ("Loading into memory…"). */
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
    if (t > 0) setBar(l / t, `${fmtMB(l)}`, `${fmtMB(t)} · cached after first visit`);
  };
  // Stall reporter (informational only — never changes state): if bytes were
  // flowing and then stop for 20 s, say so instead of freezing silently.
  const stallTimer = setInterval(() => {
    if (finished || !sawDownload || stallNoted) return;
    if (Date.now() - lastEventAt > 20000) {
      stallNoted = true;
      setBar(0.05, 'download stalled — connection may be slow, still trying…');
    }
  }, 5000);
  return {
    onEvent(p: ModelProgress) {
      if (finished) return;
      lastEventAt = Date.now();
      if (p.status === 'initiate') pendingFiles.add(p.file);
      else if (p.status === 'download') { sawDownload = true; pendingFiles.add(p.file); }
      else if (p.status === 'progress') {
        sawDownload = true;
        if (p.total) {
          bytes.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
          draw();
        } else {
          // Chunked response without content-length: show bytes flowing and
          // keep the bar indeterminate (CSS shimmer) rather than frozen 0%.
          stallNoted = false;
          setBar(0.05, `${fmtMB(p.loaded ?? 0)} downloaded…`);
        }
      } else if (p.status === 'done') {
        pendingFiles.delete(p.file);
        if (sawDownload && pendingFiles.size === 0) {
          $('#prepTitle').textContent = 'Preparing local AI…';
          setBar(1, 'download complete — loading into memory…');
        }
      }
    },
    finish() { finished = true; clearInterval(stallTimer); },
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
    div.style.cssText = 'position:absolute;top:0;bottom:0;width:2px;background:var(--accent);cursor:ew-resize;box-shadow:0 0 12px rgba(52,211,153,.8);z-index:5';
    ui.appendChild(div);
    let dragging = false;
    const pos = (e: PointerEvent) => {
      const r = (checker as HTMLElement).getBoundingClientRect();
      splitPos = Math.max(2, Math.min(98, ((e.clientX - r.left) / r.width) * 100));
      rHalf.style.clipPath = `inset(0 0 0 ${splitPos}%)`;
      div.style.left = splitPos + '%';
    };
    ui.addEventListener('pointerdown', (e) => { dragging = true; (ui as HTMLElement).setPointerCapture?.(e.pointerId); pos(e as PointerEvent); });
    ui.addEventListener('pointermove', (e) => { if (dragging) pos(e as PointerEvent); });
    ui.addEventListener('pointerup', () => { dragging = false; });
    ui.addEventListener('pointercancel', () => { dragging = false; });
    lc = $('#splitLC') as HTMLCanvasElement;
  }
  // Re-assert clip on rebuild.
  const rHalf = lc.parentElement?.nextElementSibling as HTMLElement | null;
  const div = $('#splitDiv2') as HTMLElement | null;
  if (rHalf) rHalf.style.clipPath = `inset(0 0 0 ${splitPos}%)`;
  if (div) div.style.left = splitPos + '%';
  void img;
}

function drawComposite(target: HTMLCanvasElement, view: { image: ImageRef; mask: AlphaMask }, bg: Background, fx: Effects, maxSide = 0) {
  const out = composite(view.image, view.mask, bg, fx);
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
    drawMaskGray(resultCanvas, state.mask);
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

async function realLoadFile(f: File) {
  if (!f.type.startsWith('image/')) { W.toast('Not an image file', true); return; }
  // Reset the picker so re-selecting the SAME file still fires change.
  const picker = $('#fileInput') as HTMLInputElement | null;
  if (picker) picker.value = '';
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
    wireFinishing();
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
    startElapsed('working');
    await ensureReady();
    $('#prepTitle').textContent = 'Removing background…';
    setBar(1, `running on-device (${state.backend}) — the page stays usable`);
    const t0 = performance.now();
    state.mask = await segmentCurrent('ai');
    stopElapsed();
    W.showView('view-editor');
    lastCompare = 'after';
    refreshDisplay();
    // Reveal, don't flash: the editor opens on the original and wipes to
    // the cutout. The wipe itself is the processing feedback (no spinner).
    runReveal();
    W.toast(`Background removed in ${((performance.now() - t0) / 1000).toFixed(1)}s · ${state.backend}`);
    setTimeout(() => $('#fb').classList.add('on'), 2500);
    // The bubble overlaps the canvas: dismiss it automatically, it stays
    // one tap away via Refine if the user disagrees later.
    setTimeout(() => $('#fb').classList.remove('on'), 14000);
  } catch (e) {
    stopElapsed();
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
  startElapsed('recomputing');
  try {
    state.mask = await segmentCurrent('recompute');
    stopElapsed();
    refreshDisplay();
    W.toast('Recomputed');
  } catch (e) {
    stopElapsed();
    W.toast(`Recompute failed: ${String(e).slice(0, 120)}`, true);
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
  // Hold on the original for 2 s so the result lands mentally first, then
  // wipe slowly (~1.6 s). Cancel-safe via the token.
  setTimeout(() => {
    if (my !== revealToken) return;
    const t0 = performance.now(), DUR = 1600;
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
  }, 2000);
}

function realCompare(m: string) {
  revealToken++;
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
    const view = derivedView();
    let canvas = resultCanvas;
    let note = `${state.image.width} × ${state.image.height} · ${fmt}`;
    if (fmt === 'JPEG' && state.bg.kind === 'transparent') {
      // JPEG cannot carry transparency: composite onto white for this export
      // only (stated, never silent), without touching the stored mask.
      const tmp = document.createElement('canvas');
      drawComposite(tmp, view, { kind: 'color', color: [255, 255, 255] }, state.fx);
      canvas = tmp;
      note += ' · flattened onto white (JPEG has no transparency)';
    } else {
      drawComposite(resultCanvas, view, state.bg, state.fx);
      note += state.bg.kind === 'transparent' ? ' · transparent' : ' · with background';
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
  ($('#jpegWarn') as HTMLElement)?.classList.toggle('hidden', state.bg.kind !== 'transparent');
  const checker = $('#checker') as HTMLElement;
  checker.style.background = '';
  checker.style.backgroundSize = '';
  if (state.bg.kind === 'color' && state.bg.color) {
    const hex = '#' + state.bg.color.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('');
    num('bgColor').value = hex;
    ($('#bgHex') as HTMLElement).textContent = hex.toUpperCase();
    $$('.sw').forEach((s) => (s as HTMLElement).classList.toggle('on', (s as HTMLElement).dataset.c === hex));
  }
  const fmt = selectedFormat();
  $('#expDims').textContent =
    `${state.image.width} × ${state.image.height} · ${fmt} · ${state.bg.kind === 'transparent' ? 'transparent' : 'with background'}`;
}

function bindFxSlider(id: string, label: string, set: (v: number) => void, fmt: (v: number) => string) {
  const el = num(id);
  let before: ParamSnap | null = null;
  el.addEventListener('pointerdown', () => { before = snapshotParams(); });
  el.addEventListener('focus', () => { before = snapshotParams(); });
  el.addEventListener('input', () => { set(+el.value); paintSliderLabel(id, fmt); refreshDisplay(); });
  el.addEventListener('change', () => {
    paintSliderLabel(id, fmt);
    refreshDisplay();
    if (before) {
      const after = snapshotParams();
      const b = before;
      state.log.commit(label, () => { restoreParams(b); refreshDisplay(); }, () => { restoreParams(after); refreshDisplay(); });
      before = null;
      syncUndoRedo();
    }
  });
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
    const img = state.image!;
    const r = ($('#checker') as HTMLElement).getBoundingClientRect();
    const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const el = boxEl();
    el.style.display = 'block';
    el.style.left = `${(x0 / img.width) * r.width}px`;
    el.style.top = `${(y0 / img.height) * r.height}px`;
    el.style.width = `${((x1 - x0) / img.width) * r.width}px`;
    el.style.height = `${((y1 - y0) / img.height) * r.height}px`;
  };
  stage.addEventListener('pointerdown', (e) => {
    if (!state.mask) return;
    if (refineMode() === 'recompute' && (e.button === 0 || e.pointerType !== 'mouse')) {
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
  if (!recompBox) { W.toast('Drag a box over the problem area first'); return; }
  const box = { ...recompBox };
  W.runScan('Re-evaluating selection…');
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
    const prev = state.mask;
    const next = { width: res.w, height: res.h, alpha: new Float32Array(res.alpha) };
    state.mask = next;
    state.log.commit('recompute region',
      () => { state.mask = prev; refreshDisplay(); },
      () => { state.mask = next; refreshDisplay(); });
    recompBox = null;
    (boxEl() as HTMLElement).style.display = 'none';
    refreshDisplay();
    W.toast('Region recomputed — rest untouched');
  } catch (e) {
    W.toast(`Recompute failed: ${String(e).slice(0, 140)}`, true);
  }
}

async function guidedApply(x: number, y: number) {
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

// ---------- install overrides ----------

W.loadFile = realLoadFile;
W.startPreparing = realStart;
W.setCompare = realCompare;
W.runExport = realExport;
installStrokeCapture();
syncStrokeButtons();
installRefineCapture();

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
