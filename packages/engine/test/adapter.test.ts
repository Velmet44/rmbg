import { describe, expect, it, vi } from 'vitest';
import { TransformersAdapter } from '../src/transformers-adapter.js';
import type { ImageRef } from '../src/types.js';

function fakeRuntime(opts: { failDevices?: string[]; maskSize?: number } = {}) {
  const calls: string[] = [];
  const pipeline = vi.fn(async (task: string, model: string, cfg: any) => {
    calls.push(`${cfg.device}/${cfg.dtype}`);
    if (opts.failDevices?.includes(cfg.device)) throw new Error(`no ${cfg.device}`);
    return fakePipe(opts.maskSize ?? 8);
  });
  const RawImage = class {
    constructor(
      public data: Uint8ClampedArray,
      public width: number,
      public height: number,
      public channels: number,
    ) {}
  };
  return { calls, loadRuntime: async () => ({ pipeline, RawImage }) };
}

function fakePipe(size: number, failRuns = 0) {
  let runs = 0;
  const data = new Uint8ClampedArray(size * size).fill(200);
  return async (_raw: any) => {
    runs++;
    if (runs <= failRuns) throw new Error('MapAsyncStatus was false (simulated device loss)');
    return [{ label: 'fg', score: 0.9, mask: { width: size, height: size, data } }];
  };
}

function img(): ImageRef {
  return { id: 't', width: 16, height: 16, rgb: new Uint8ClampedArray(16 * 16 * 3).fill(128) };
}

describe('TransformersAdapter lifecycle', () => {
  it('single-flights concurrent inits (one pipeline call)', async () => {
    const rt = fakeRuntime();
    const ad = new TransformersAdapter('m', { device: 'wasm', loadRuntime: rt.loadRuntime });
    await Promise.all([ad.init(), ad.init(), ad.init()]);
    expect(rt.calls).toEqual(['wasm/fp32']);
    expect(ad.backend).toBe('wasm/fp32');
  });

  it('dispose allows a genuine rebuild', async () => {
    const rt = fakeRuntime();
    const ad = new TransformersAdapter('m', { device: 'wasm', loadRuntime: rt.loadRuntime });
    await ad.init();
    await ad.dispose();
    expect(ad.backend).toBeNull();
    await ad.init();
    expect(rt.calls).toEqual(['wasm/fp32', 'wasm/fp32']);
    const mask = await ad.segment(img(), { hint: 'auto', tier: 'fast' });
    expect(mask.width).toBe(16);
    expect(mask.alpha[0]).toBeCloseTo(200 / 255, 5);
  });

  it('falls back to wasm when webgpu fails, then segments', async () => {
    const rt = fakeRuntime({ failDevices: ['webgpu'] });
    const ad = new TransformersAdapter('m', { device: 'auto', loadRuntime: rt.loadRuntime });
    await ad.init();
    expect(ad.backend).toBe('wasm/fp32');
    const mask = await ad.segment(img(), { hint: 'auto', tier: 'fast' });
    expect(mask.width).toBe(16);
  });

  it('retries once in-place on transient device loss', async () => {
    const rt = fakeRuntime();
    let failRuns = 1;
    const loadRuntime = async () => ({
      pipeline: async () => {
        const pipe = await (async () => fakePipe(8))();
        return async (raw: any) => {
          if (failRuns > 0) { failRuns--; throw new Error('MapAsyncStatus was false'); }
          return pipe(raw);
        };
      },
      RawImage: class {},
    });
    const ad = new TransformersAdapter('m', { device: 'webgpu', loadRuntime });
    await ad.init();
    const mask = await ad.segment(img(), { hint: 'auto', tier: 'fast' });
    expect(ad.backend).toBe('webgpu/fp16');
    expect(mask.alpha[0]).toBeCloseTo(200 / 255, 5);
    void rt;
  });

  it('retries init after failure', async () => {
    let fail = true;
    const loadRuntime = async () => ({
      pipeline: async () => {
        if (fail) throw new Error('down');
        return fakePipe(8);
      },
      RawImage: class {},
    });
    const ad = new TransformersAdapter('m', { device: 'wasm', loadRuntime });
    await expect(ad.init()).rejects.toThrow('down');
    fail = false;
    await ad.init();
    expect(ad.backend).toBe('wasm/fp32');
  });
});
