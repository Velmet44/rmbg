// Environment + capability capture.
//
// Every field here is chosen with one question: does it help interpret a
// measurement without identifying the person who produced it? Exact RAM and an
// exact GPU string are both identifying; buckets and booleans are not. Nothing
// here is a stable identifier, and the whole `hardware` block is opt-in.
//
// Capability probes answer questions the SPEC makes claims about but cannot
// test: which image formats can THIS browser actually decode, and can it
// encode AVIF. A claim like "AVIF where your browser can encode it" is only
// honest if something checks.

import { probeGPU } from '@rmbg/engine';
import type { Report } from './types';

export interface Captured {
  environment: Report['environment'];
  hardware: Report['hardware'];
  capabilities: Report['capabilities'];
}

/** Minimal valid 1×1 GIF (the classic 43-byte transparent GIF). Used because no
 *  browser encodes GIF, so the decode probe cannot manufacture its own input. */
const TINY_GIF_B64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** Minimal valid 2×2 24-bit BMP. Same reason: nothing encodes BMP. */
function tinyBmp(): Blob {
  const w = 2, h = 2, row = 8; // 2px * 3 bytes padded to a 4-byte boundary
  const size = 14 + 40 + row * h;
  const b = new Uint8Array(size);
  const dv = new DataView(b.buffer);
  b[0] = 0x42; b[1] = 0x4d;              // 'BM'
  dv.setUint32(2, size, true);
  dv.setUint32(10, 14 + 40, true);         // pixel data offset
  dv.setUint32(14, 40, true);              // DIB header size
  dv.setInt32(18, w, true); dv.setInt32(22, h, true);
  dv.setUint16(26, 1, true);               // planes
  dv.setUint16(28, 24, true);              // bpp
  dv.setUint32(34, row * h, true);         // image size
  for (let i = 0; i < row * h; i++) b[14 + 40 + i] = (i * 37) & 0xff; // arbitrary pixels
  return new Blob([b], { type: 'image/bmp' });
}

function tinyBytes(b64: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: 'image/gif' });
}

async function probeEncode(mime: string): Promise<boolean> {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 8;
    const blob: Blob | null = await new Promise((r) => c.toBlob(r, mime));
    if (!blob || blob.size === 0) return false;
    // A runtime that cannot encode the requested type silently returns PNG;
    // only the blob's own type tells the truth.
    return blob.type === mime;
  } catch {
    return false;
  }
}

async function probeDecode(blob: Blob): Promise<boolean> {
  try {
    const bmp = await createImageBitmap(blob);
    const ok = bmp.width > 0 && bmp.height > 0;
    bmp.close();
    return ok;
  } catch {
    return false;
  }
}

async function probeDecodeMime(mime: string): Promise<boolean> {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 8;
    const blob: Blob | null = await new Promise((r) => c.toBlob(r, mime));
    return blob ? probeDecode(blob) : false;
  } catch {
    return false;
  }
}

function browserInfo(): { name: string; version: string | null } {
  const nav = navigator as Navigator & { userAgentData?: { brands?: { brand: string; version: string }[] } };
  const ua = nav.userAgent ?? '';
  const brands = nav.userAgentData?.brands ?? [];
  const fromBrands = brands.find((b) => !/not.a.brand/i.test(b.brand) && b.brand !== 'Chromium');
  const versionFromBrands = fromBrands?.version ?? null;
  const edge = brands.find((b) => /Edge/i.test(b.brand));
  if (edge) return { name: 'Edge', version: versionFromBrands };
  const pick = (re: RegExp, name: string) => {
    const m = ua.match(re);
    return m ? { name, version: m[1] ?? versionFromBrands } : null;
  };
  return pick(/Edg(?:e|A|iOS)?\/([\d.]+)/, 'Edge')
    ?? pick(/OPR\/([\d.]+)/, 'Opera')
    ?? pick(/SamsungBrowser\/([\d.]+)/, 'Samsung Internet')
    ?? pick(/Firefox\/([\d.]+)/, 'Firefox')
    ?? pick(/Chrome\/([\d.]+)/, 'Chrome')
    ?? pick(/Version\/([\d.]+).*Safari/, 'Safari')
    ?? { name: fromBrands?.brand ?? 'unknown', version: versionFromBrands };
}

function osInfo(): { name: string; version: string | null } {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const ua = nav.userAgent ?? '';
  const platform = nav.userAgentData?.platform ?? '';
  const m = (re: RegExp) => ua.match(re)?.[1] ?? null;
  if (/Windows NT 10/.test(ua)) return { name: 'Windows', version: '10+' };
  if (/Windows NT ([\d.]+)/.test(ua)) return { name: 'Windows', version: m(/Windows NT ([\d.]+)/) };
  if (/Android (\d+)/.test(ua)) return { name: 'Android', version: m(/Android ([\d+]+)/) };
  if (/iPhone|iPad|iPod/.test(ua)) return { name: 'iOS', version: m(/OS (\d+)_/) };
  if (/Mac OS X (\d+[_.]\d+)/.test(ua)) return { name: 'macOS', version: (m(/Mac OS X ([\d+_.]+)/) ?? '').split('_')[0] };
  if (/CrOS/.test(ua)) return { name: 'ChromeOS', version: null };
  if (/Linux/.test(ua)) return { name: platform || 'Linux', version: null };
  return { name: platform || 'unknown', version: null };
}

function memoryBucket(gb: number | undefined): string | null {
  if (!gb || !Number.isFinite(gb)) return 'unknown';
  if (gb <= 2) return '<=2';
  if (gb <= 4) return '<=4';
  if (gb <= 8) return '<=8';
  return '>8';
}

function coreBucket(n: number | undefined): string | null {
  if (!n || !Number.isFinite(n)) return 'unknown';
  if (n <= 2) return '<=2';
  if (n <= 4) return '<=4';
  if (n <= 8) return '<=8';
  if (n <= 16) return '<=16';
  return '>16';
}

export interface CaptureOptions {
  /** The contributor ticked "include hardware detail". Without it the GPU
   *  adapter string and heap limit are dropped; availability stays, because
   *  "this browser has no WebGPU" is a benchmark result, not an identity. */
  includeHardware: boolean;
}

export async function captureEnvironment(opts: CaptureOptions): Promise<Captured> {
  const env: Report['environment'] = {
    browser: browserInfo(),
    os: osInfo(),
    arch: (navigator as Navigator & { userAgentData?: { platformVersion?: string; architecture?: string } })
      .userAgentData?.architecture ?? null,
    deviceMemoryGbBucket: memoryBucket((navigator as Navigator & { deviceMemory?: number }).deviceMemory),
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    hardwareConcurrencyBucket: coreBucket(navigator.hardwareConcurrency),
    devicePixelRatio: window.devicePixelRatio || null,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    crossOriginIsolated: typeof crossOriginIsolated === 'undefined' ? null : crossOriginIsolated,
    isSecureContext: window.isSecureContext ?? null,
  };

  const gpu = await probeGPU();
  const gpuAvailable = (navigator as Navigator & { gpu?: unknown }).gpu !== undefined;
  const hardware: Report['hardware'] = opts.includeHardware ? {
    gpu: {
      available: gpuAvailable,
      software: gpu.software,
      adapter: gpu.desc || null,
      maxTextureDimension2D: null,
      maxBufferSize: null,
    },
    jsHeapLimitBytes: heapLimitBytes(),
    deviceMemoryGb: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
  } : null;

  // Capabilities: booleans only, plus two numbers where a number is the honest
  // answer (storage quota is not a capability, so it is left out entirely).
  const avifEncode = await probeEncode('image/avif');
  const avifDecode = avifEncode ? await probeDecodeMime('image/avif') : false;
  const capabilities: Report['capabilities'] = {
    webgpu: gpuAvailable,
    webgpuSoftwareAdapter: gpu.software,
    webgl2: (() => { try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; } })(),
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
    createImageBitmap: typeof createImageBitmap === 'function',
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    wasmThreadsPossible: typeof SharedArrayBuffer !== 'undefined' && !!env.crossOriginIsolated,
    indexedDB: typeof indexedDB !== 'undefined',
    storageEstimate: typeof navigator.storage?.estimate === 'function',
    broadcastChannel: typeof BroadcastChannel !== 'undefined',
    performanceMemory: typeof (performance as Performance & { memory?: unknown }).memory !== 'undefined',
    performanceObserver: typeof PerformanceObserver === 'function',
    pngEncode: await probeEncode('image/png'),
    jpegEncode: await probeEncode('image/jpeg'),
    webpEncode: await probeEncode('image/webp'),
    avifEncode,
    // Only probeable when this runtime can also encode it — recorded as such
    // rather than guessed, because "AVIF decode" is not a browser-wide truth.
    avifDecodeProbed: avifEncode,
    avifDecode,
    bmpDecode: await probeDecode(tinyBmp()),
    gifDecode: await probeDecode(tinyBytes(TINY_GIF_B64)),
  };

  return { environment: env, hardware, capabilities };
}

function heapLimitBytes(): number | null {
  const m = (performance as Performance & { memory?: { jsHeapSizeLimit?: number } }).memory;
  return typeof m?.jsHeapSizeLimit === 'number' ? m.jsHeapSizeLimit : null;
}

/**
 * JS heap delta, when the browser exposes it.
 *
 * Labelled `non-isolated` because that is exactly what it is: `performance.memory`
 * covers the JS heap of the page's realm only. It does not see ORT's WASM
 * memory, GPU buffers, or the compositor, so it is a LOWER BOUND on what the
 * benchmark actually cost. Published with the label attached or not at all.
 */
export function jsHeapUsedBytes(): number | null {
  const m = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
  return typeof m?.usedJSHeapSize === 'number' ? m.usedJSHeapSize : null;
}

export function heapAvailable(): boolean {
  return typeof (performance as Performance & { memory?: unknown }).memory !== 'undefined';
}

/** The engine's own cap on this realm's heap, when the browser exposes it. */
export function jsHeapLimitBytes(): number | null {
  const m = (performance as Performance & { memory?: { jsHeapSizeLimit?: number } }).memory;
  return typeof m?.jsHeapSizeLimit === 'number' ? m.jsHeapSizeLimit : null;
}