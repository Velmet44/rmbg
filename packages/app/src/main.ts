// RMBG app wiring (Stage 1). The mockup shell in index.html owns all UI
// behavior; this module overrides the ingest/remove/export paths with the
// real local engine. Everything runs on-device: Transformers.js downloads
// model bytes into the browser cache once, image pixels never leave.
//
// Not yet wired (later stages, UI toasts as such): refine brushes affect only
// a visual overlay layer, background/effects panels, custom resolution, batch.

import {
  OpLog,
  TransformersAdapter,
  composite,
  createEngine,
  type AlphaMask,
  type Background,
  type Effects,
  type ImageRef,
  type QualityTier,
} from '@rmbg/engine';

const W = window as unknown as Record<string, any>;
const $ = (s: string) => document.querySelector(s) as HTMLElement;
const $$ = (s: string) => Array.from(document.querySelectorAll(s)) as HTMLElement[];

const MANIFEST: Record<QualityTier, string> = {
  fast: 'studioludens/birefnet-lite-512',
  quality: 'naddy24/birefnet-512-webgpu',
};

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
  tier: QualityTier;
  backend: string;
  log: OpLog;
}

const state: AppState = { image: null, previewURL: null, mask: null, tier: 'fast', backend: '…', log: new OpLog() };
const adapters: Record<QualityTier, TransformersAdapter> = {
  fast: new TransformersAdapter(MANIFEST.fast, { device: 'auto' }),
  quality: new TransformersAdapter(MANIFEST.quality, { device: 'auto' }),
};
const engines = {
  fast: createEngine(adapters.fast),
  quality: createEngine(adapters.quality),
};

// ---------- helpers ----------

function setBar(frac: number, mbText: string) {
  ($('#prepBar') as HTMLElement).style.width = `${Math.min(100, Math.max(0, frac * 100))}%`;
  $('#prepMB').textContent = mbText;
  $('#prepPct').textContent = `${Math.round(frac * 100)}%`;
}

function fmtMB(n: number): string {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

/** Aggregate per-file progress events into one determinate bar. */
function trackDownload(onFrac: (frac: number, label: string) => void) {
  const files = new Map<string, { loaded: number; total: number }>();
  return (p: { file: string; loaded: number; total: number }) => {
    files.set(p.file, { loaded: p.loaded, total: p.total });
    let l = 0, t = 0;
    for (const f of files.values()) { l += f.loaded; t += f.total; }
    onFrac(t ? l / t : 0, `${fmtMB(l)} / ${fmtMB(t)} · cached after first visit`);
  };
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
  if (!splitImg && state.previewURL) {
    const el = document.createElement('img');
    el.id = 'splitOrig';
    el.style.cssText = 'width:300px;height:220px;object-fit:cover;position:absolute;inset:0;margin:auto';
    ($('#splitL') as HTMLElement).appendChild(el);
    el.src = state.previewURL;
  } else if (splitImg && state.previewURL) {
    splitImg.src = state.previewURL;
  }
}

function drawComposite(target: HTMLCanvasElement, mask: AlphaMask, bg: Background, maxSide = 0) {
  const img = state.image!;
  const out = composite(img, mask, bg, FX_OFF);
  const src = document.createElement('canvas');
  src.width = out.width; src.height = out.height;
  src.getContext('2d')!.putImageData(
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
  ctx.drawImage(src, 0, 0, dw, dh);
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

function refreshDisplay() {
  if (!state.image || !state.mask || !resultCanvas) return;
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

async function ensureAdapter(tier: QualityTier): Promise<void> {
  const ad = adapters[tier];
  if ((ad as any).backend) { state.backend = (ad as any).backend; return; }
  await ad.init(trackDownload((frac, label) => {
    setBar(frac, label);
  }));
  state.backend = ad.backend ?? 'unknown';
}

async function realStart(_withDemo: boolean) {
  if (!state.image) { W.toast('Pick an image first', true); W.showView('view-landing'); return; }
  W.showView('view-preparing');
  ($('#prepRing') as HTMLElement).style.display = 'block';
  $('#prepTitle').textContent = 'Preparing local AI…';
  setBar(0, 'starting…');
  try {
    // Fast tier first for an instant result (SPEC §6); HQ refines in background.
    await ensureAdapter('fast');
    state.tier = 'fast';
    const t0 = performance.now();
    const mask = await engines.fast.removeBackground(state.image, { tier: 'fast' });
    state.mask = mask;
    state.log.commitRegion(mask, 'ai', () => null);
    syncTierRadios();
    W.showView('view-editor');
    lastCompare = 'after';
    refreshDisplay();
    W.runScan('Detecting subject…');
    W.toast(`Fast preview in ${((performance.now() - t0) / 1000).toFixed(1)}s · HQ refining in background (${state.backend})`);
    setTimeout(() => $('#fb').classList.add('on'), 2500);
    upgradeToQuality();
  } catch (e) {
    $('#prepTitle').textContent = 'Could not start the local model';
    setBar(0, 'failed — check connection once for the one-time download, then retry');
    W.toast(`Model start failed: ${String(e).slice(0, 160)}`, true);
  }
}

async function upgradeToQuality() {
  if (!state.image) return;
  try {
    await ensureAdapter('quality');
    if (!state.image) return; // user moved on
    const mask = await engines.quality.removeBackground(state.image, { tier: 'quality' });
    state.mask = mask;
    state.log.commitRegion(mask, 'ai-hq', () => null);
    state.tier = 'quality';
    syncTierRadios();
    lastCompare = lastCompare === 'before' ? 'before' : 'after';
    refreshDisplay();
    ($('#hqBanner') as HTMLElement).classList.add('on');
  } catch (e) {
    W.toast('HQ model unavailable — staying on fast tier', true);
  }
}

function syncTierRadios() {
  $$('[data-ai]').forEach((r) => {
    const el = r as HTMLElement;
    el.classList.toggle('on', (el.dataset.ai === 'hq') === (state.tier === 'quality'));
  });
}

async function rerunCurrentTier() {
  if (!state.image) return;
  W.runScan('Recomputing…');
  try {
    const mask = await engines[state.tier].removeBackground(state.image, { tier: state.tier });
    state.mask = mask;
    state.log.commitRegion(mask, 'recompute', () => null);
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
    state.log.commitRegion(state.mask, 'export', () => ({ x: 0, y: 0, w: 0, h: 0 }));
  } catch (e) {
    $('#expNote').textContent = `Export failed: ${String(e).slice(0, 140)} — retry or try PNG.`;
    W.toast('Export failed', true);
  }
}

// Introspection for verification/debugging (harmless in production).
(window as unknown as Record<string, any>).__rmbg = { state, adapters, engines };

// ---------- install overrides ----------

W.loadFile = realLoadFile;
W.startPreparing = realStart;
W.setCompare = realCompare;
W.runExport = realExport;

$('#btnRecompute').addEventListener('click', () => { void rerunCurrentTier(); });
// The mockup shell binds the mock export directly; rebind to the real one.
($('#btnDoExport') as HTMLButtonElement).onclick = () => { void realExport(); };
$$('[data-ai]').forEach((r) => {
  (r as HTMLElement).addEventListener('click', async () => {
    const want: QualityTier = (r as HTMLElement).dataset.ai === 'hq' ? 'quality' : 'fast';
    if (!state.image || want === state.tier) return;
    W.toast(`Switching to ${want} tier…`);
    W.showView('view-preparing');
    $('#prepTitle').textContent = 'Preparing local AI…';
    try {
      await ensureAdapter(want);
      state.tier = want;
      const mask = await engines[want].removeBackground(state.image, { tier: want });
      state.mask = mask;
      state.log.commitRegion(mask, 'tier-switch', () => null);
      syncTierRadios();
      W.showView('view-editor');
      refreshDisplay();
    } catch (e) {
      W.showView('view-editor');
      W.toast(`Tier switch failed: ${String(e).slice(0, 120)}`, true);
    }
  });
});

// Prefetch the fast model on page load so the first drop feels instant.
// One-time download into the browser cache; silent unless it fails.
adapters.fast.init().then(
  () => { state.backend = adapters.fast.backend ?? 'cached'; },
  () => { /* first real use will surface the error with UI */ },
);

export {};
