// RMBG inference worker: model download + session + segmentation run here,
// the main thread stays responsive (progress, zoom/pan, cancel-safe).
// No DOM in this file: engine + adapter only. Everything stays on-device;
// the worker fetches model bytes into the same browser cache as the page.
import {
  TransformersAdapter,
  dbg,
  dbgTable,
  now,
  removeBackground,
  type ImageRef,
} from '@rmbg/engine';
import { MODEL_ID } from './model-config';

// This module instance has its own clock (the log module is loaded fresh in
// the worker), so every "+Nms" below is relative to worker start, not to the
// page. The main thread stamps the round trip.
dbg('wk', `worker module evaluated · model=${MODEL_ID} · base=${location.origin}`);

const adapter = new TransformersAdapter(MODEL_ID, { device: 'auto' });
let busy = false;

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  dbg('wk', `recv ${msg?.type} id=${msg?.id}${busy ? ' (ALREADY BUSY — will reject)' : ''}`);
  if (msg?.type === 'init') {
    const t0 = now();
    try {
      // The runtime itself (~MBs of JS/WASM) downloads before any model
      // byte can flow; announce it so this phase is never silent.
      (self as any).postMessage({ id: msg.id, type: 'progress', status: 'runtime', file: 'runtime' });
      await adapter.init((p) =>
        (self as any).postMessage({ id: msg.id, type: 'progress', ...p }),
      );
      // Report the model identity and the cache bucket actually in force, so
      // the main thread probes the bucket this runtime writes to.
      (self as any).postMessage({
        id: msg.id, type: 'ready',
        backend: adapter.backend, gpu: adapter.gpuDescription,
        model: MODEL_ID, cacheName: adapter.cacheName,
      });
      dbgTable('wk', `init complete in ${(now() - t0).toFixed(0)}ms`, {
        backend: adapter.backend, gpu: adapter.gpuDescription, cacheName: adapter.cacheName,
      });
    } catch (err) {
      dbg('wk', `init FAILED after ${(now() - t0).toFixed(0)}ms`, String(err));
      (self as any).postMessage({ id: msg.id, type: 'error', message: String(err).slice(0, 300) });
    }
    return;
  }
  if (msg?.type === 'segment') {
    if (busy) {
      dbg('wk', `segment rejected — busy`);
      (self as any).postMessage({ id: msg.id, type: 'error', message: 'busy' });
      return;
    }
    busy = true;
    const t0 = now();
    try {
      const image: ImageRef = {
        id: msg.imageId,
        width: msg.w,
        height: msg.h,
        rgb: new Uint8ClampedArray(msg.rgb),
      };
      const mask = await removeBackground(adapter, image);
      // Report the backend THIS call actually used. The adapter can fall back
      // from WebGPU to WASM mid-segment when execution fails, so the backend
      // from init time is stale by the time a result exists — and a UI still
      // claiming "GPU" while running on the CPU is exactly the wrong claim.
      (self as any).postMessage(
        {
          id: msg.id, type: 'mask', w: mask.width, h: mask.height,
          alpha: mask.alpha.buffer, backend: adapter.backend, gpu: adapter.gpuDescription,
        },
        [mask.alpha.buffer],
      );
      dbgTable('wk', `segment done in ${(now() - t0).toFixed(0)}ms`, {
        in: `${msg.w}×${msg.h}`, out: `${mask.width}×${mask.height}`,
        backend: adapter.backend, gpu: adapter.gpuDescription,
      });
    } catch (err) {
      dbg('wk', `segment FAILED after ${(now() - t0).toFixed(0)}ms`, String(err));
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
      dbg('wk', 'recompute rejected — busy');
      (self as any).postMessage({ id: msg.id, type: 'error', message: 'busy' });
      return;
    }
    busy = true;
    const t0 = now();
    try {
      const image: ImageRef = {
        id: msg.imageId, width: msg.w, height: msg.h, rgb: new Uint8ClampedArray(msg.rgb),
      };
      const mask = {
        width: msg.mw, height: msg.mh, alpha: new Float32Array(msg.alpha),
      };
      const next = await adapter.recomputeRegion(image, mask, msg.bbox);
      (self as any).postMessage(
        {
          id: msg.id, type: 'mask', w: next.width, h: next.height,
          alpha: next.alpha.buffer, backend: adapter.backend, gpu: adapter.gpuDescription,
        },
        [next.alpha.buffer],
      );
      dbg('wk', `recompute done in ${(now() - t0).toFixed(0)}ms · bbox=${msg.bbox?.x},${msg.bbox?.y} ${msg.bbox?.w}×${msg.bbox?.h}`);
    } catch (err) {
      dbg('wk', `recompute FAILED after ${(now() - t0).toFixed(0)}ms`, String(err));
      (self as any).postMessage({ id: msg.id, type: 'error', message: String(err).slice(0, 300) });
    } finally {
      busy = false;
    }
  }
};

export {};
