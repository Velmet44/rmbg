// RMBG inference worker: model download + session + segmentation run here,
// the main thread stays responsive (progress, zoom/pan, cancel-safe).
// No DOM in this file: engine + adapter only. Everything stays on-device;
// the worker fetches model bytes into the same browser cache as the page.
import { TransformersAdapter, createEngine, type ImageRef } from '@rmbg/engine';

const MODEL_ID = 'studioludens/birefnet-lite-512';

const adapter = new TransformersAdapter(MODEL_ID, { device: 'auto' });
const engine = createEngine(adapter);
let busy = false;

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  const say = (text: string) => (self as any).postMessage({ type: 'logline', text });
  if (msg?.type === 'init') {
    try {
      say('init received');
      // The runtime itself (~MBs of JS/WASM) downloads before any model
      // byte can flow; announce it so this phase is never silent.
      (self as any).postMessage({ id: msg.id, type: 'progress', status: 'runtime', file: 'runtime' });
      let counts: Record<string, number> = {};
      await adapter.init((p) => {
        counts[p.status] = (counts[p.status] ?? 0) + 1;
        const n = Object.values(counts).reduce((a, b) => a + b, 0);
        if (n === 1 || n % 25 === 1) say(`progress events so far: ${JSON.stringify(counts)}`);
        (self as any).postMessage({ id: msg.id, type: 'progress', ...p });
      });
      say('session ready');
      (self as any).postMessage({ id: msg.id, type: 'ready', backend: adapter.backend });
    } catch (err) {
      say('init failed: ' + String(err).slice(0, 200));
      (self as any).postMessage({ id: msg.id, type: 'error', message: String(err).slice(0, 300) });
    }
    return;
  }
  if (msg?.type === 'segment') {
    if (busy) {
      (self as any).postMessage({ id: msg.id, type: 'error', message: 'busy' });
      return;
    }
    busy = true;
    try {
      const image: ImageRef = {
        id: msg.imageId,
        width: msg.w,
        height: msg.h,
        rgb: new Uint8ClampedArray(msg.rgb),
      };
      const mask = await engine.removeBackground(image, { hint: 'auto', tier: 'fast' });
      (self as any).postMessage(
        { id: msg.id, type: 'mask', w: mask.width, h: mask.height, alpha: mask.alpha.buffer },
        [mask.alpha.buffer],
      );
    } catch (err) {
      (self as any).postMessage({ id: msg.id, type: 'error', message: String(err).slice(0, 300) });
    } finally {
      busy = false;
    }
    return;
  }
  if (msg?.type === 'recompute') {
    // Region recompute: re-run segmentation on bbox+context, patch only that
    // area. Transfers-voxel ownership like segment (copies stay main-side).
    if (busy) {
      (self as any).postMessage({ id: msg.id, type: 'error', message: 'busy' });
      return;
    }
    busy = true;
    try {
      const image: ImageRef = {
        id: msg.imageId, width: msg.w, height: msg.h, rgb: new Uint8ClampedArray(msg.rgb),
      };
      const mask = {
        width: msg.mw, height: msg.mh, alpha: new Float32Array(msg.alpha),
      };
      const next = await adapter.recomputeRegion(image, mask, msg.bbox, { hint: 'auto' });
      (self as any).postMessage(
        { id: msg.id, type: 'mask', w: next.width, h: next.height, alpha: next.alpha.buffer },
        [next.alpha.buffer],
      );
    } catch (err) {
      (self as any).postMessage({ id: msg.id, type: 'error', message: String(err).slice(0, 300) });
    } finally {
      busy = false;
    }
  }
};

export {};
