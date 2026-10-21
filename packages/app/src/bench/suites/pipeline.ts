// Pipeline benchmarks: ingest, on-screen display, export and batch, all through
// the SAME modules the app ships (src/decode.ts, src/canvas-out.ts, src/zip.ts).
// A copy of these functions in the benchmark would be a number about code that
// nobody runs.

import { setLogEnabled, type Background, type Effects } from '@rmbg/engine';
import type { Bench } from '../record';
import { makeScene, sizesFor } from './engine';
import { decodeToImageRefTimed, sessionBytesEstimate } from '../../decode';
import {
  canEncode, compositeExportCanvas, compositeInto, encodeCanvas, exportMime,
  maskGrayInto, originalInto, overlayInto, EXPORT_FORMATS, type ExportFormat,
} from '../../canvas-out';
import { crc32, zipStore } from '../../zip';
import { synthDisc } from '../synth';
import { syntheticToBlob } from '../corpus';

const FX_OFF: Effects = { shadow: { on: false, opacity: 0, blur: 0, dx: 0, dy: 0 }, feather: 0, defringe: 0 };
const BG_COLOR: Background = { kind: 'color', color: [22, 28, 34] };

/** Count animation frames over a window. The honest way to answer "did the page
 *  keep moving", which is the only responsiveness question a user has. */
function frameCounter(ms: number): Promise<{ frames: number; elapsedMs: number }> {
  return new Promise((resolve) => {
    let frames = 0;
    const t0 = performance.now();
    const step = () => {
      frames++;
      if (performance.now() - t0 < ms) requestAnimationFrame(step);
      else resolve({ frames, elapsedMs: performance.now() - t0 });
    };
    requestAnimationFrame(step);
  });
}

export async function runIngestSuite(bench: Bench, mode: 'quick' | 'full' | 'stress'): Promise<void> {
  const sizes = mode === 'quick'
    ? [{ label: '1.9MP', w: 1600, h: 1200, mp: 1.92 }]
    : sizesFor(mode).filter((s) => s.mp <= 12.2);

  for (const s of sizes) {
    for (const fmt of EXPORT_FORMATS) {
      const blob = await syntheticToBlob(synthDisc(s.w, s.h), exportMime(fmt));
      if (!blob) {
        bench.skip('ingest', 'decode', { size: s.label, format: fmt, mp: s.mp },
          `this browser cannot encode ${fmt}, so there is no ${fmt} file here to decode`);
        continue;
      }
      const encBytes = blob.size;
      await bench.run('ingest', 'decode', { size: s.label, format: fmt, mp: s.mp }, async (c) => {
        const res = await c.measureAsync('totalMs', 'ms', async () => decodeToImageRefTimed(blob, 'bench'),
          { samples: 3, warmups: 1 });
        if (!res) return;
        // Split straight out of the app's own decode call: "the browser could
        // not decode this" and "packing RGB cost 900ms" are different failures
        // with different fixes.
        const { image, timings } = res;
        c.value('decodeMs', 'ms', +timings.decodeMs.toFixed(3));
        c.value('packMs', 'ms', +(timings.totalMs - timings.decodeMs).toFixed(3));
        c.value('throughput', 'MPix/s', +(s.mp / (timings.totalMs / 1000)).toFixed(2));
        c.derived('width', image.width);
        c.derived('height', image.height);
        c.derived('encodedBytes', encBytes);
        c.derived('rgbBytes', image.rgb.length);
      });
    }
  }
}

export async function runDisplaySuite(bench: Bench, mode: 'quick' | 'full' | 'stress'): Promise<void> {
  const sizes = sizesFor(mode).filter((s) => s.mp <= 12.2);
  const heavy = mode !== 'quick';

  for (const s of sizes) {
    const scene = makeScene(s.w, s.h);
    const canvas = document.createElement('canvas');

    for (const view of ['after', 'before', 'mask', 'overlay'] as const) {
      await bench.run('display', 'draw', { size: s.label, mp: s.mp, view }, async (c) => {
        await c.measure('drawMs', 'ms', () => {
          if (view === 'before') originalInto(canvas, scene.image);
          else if (view === 'mask') maskGrayInto(canvas, scene.mask);
          else if (view === 'overlay') overlayInto(canvas, scene.image, scene.mask);
          else compositeInto(canvas, scene, BG_COLOR, FX_OFF);
        }, { samples: heavy ? 2 : 4 });
      });
    }

    // Coalescing: the app funnels every slider `input` and every mode switch
    // through one animation frame. Twelve requests must cost ONE composite.
    // This is the cheapest large win in the editor and the easiest to regress,
    // which is exactly why it is measured rather than assumed.
    await bench.run('display', 'refreshCoalesce', { size: s.label, mp: s.mp, requests: 12 }, async (c) => {
      let composites = 0;
      let raf: number | null = null;
      const request = () => {
        if (raf !== null) return;
        raf = requestAnimationFrame(() => {
          raf = null;
          composites++;
          compositeInto(canvas, scene, BG_COLOR, FX_OFF);
        });
      };
      composites = 0;
      for (let i = 0; i < 12; i++) request();
      await c.measureAsync('settleMs', 'ms', () => new Promise((r) => setTimeout(r, 150)), { samples: 2, warmups: 0 });
      c.derived('compositesFor12Requests', composites);
      c.derived('coalescingWorks', composites === 1);
    });

    // Responsiveness while full-res work runs on the main thread.
    await bench.run('display', 'responsiveness', { size: s.label, mp: s.mp, composites: 6 }, async (c) => {
      const busy = (async () => {
        for (let i = 0; i < 6; i++) compositeInto(canvas, scene, BG_COLOR, FX_OFF);
      })();
      const frames = await c.measureAsync('frames', 'frames', async () => frameCounter(500), { samples: 2, warmups: 0 });
      await busy;
      // 500ms at 60Hz is ~30 frames. A main thread pinned by full-res composites
      // shows far fewer, and that gap is the "the page froze" feeling.
      c.derived('framesObserved', frames?.frames ?? null);
      c.derived('approxFps', frames ? +(frames.frames / (frames.elapsedMs / 1000)).toFixed(1) : null);
    });
  }
}

export async function runExportSuite(bench: Bench, mode: 'quick' | 'full' | 'stress'): Promise<void> {
  const sizes = mode === 'quick' ? sizesFor('quick') : sizesFor(mode).filter((s) => s.mp <= 12.2);
  const heavy = mode !== 'quick';

  for (const s of sizes) {
    const scene = makeScene(s.w, s.h);
    for (const fmt of EXPORT_FORMATS) {
      if (!(await canEncode(fmt))) {
        bench.skip('export', 'encode', { size: s.label, format: fmt, mp: s.mp }, `this runtime cannot encode ${fmt}`);
        continue;
      }
      await bench.run('export', 'encode', { size: s.label, format: fmt, mp: s.mp }, async (c) => {
        // Composite and encode are timed separately: they fail differently (one
        // is our maths, the other is the browser's codec) and a single total
        // hides which half moved.
        const canvas = await c.measure('compositeMs', 'ms',
          () => compositeExportCanvas(scene, BG_COLOR, FX_OFF, s.w, s.h), { samples: heavy ? 2 : 3 });
        if (!canvas) return;
        const encoded = await c.measureAsync('encodeMs', 'ms', async () => {
          const t = performance.now();
          const b = await encodeCanvas(canvas, fmt as ExportFormat);
          return { b, ms: performance.now() - t };
        }, { samples: heavy ? 2 : 3 });
        if (!encoded) return;
        c.value('outputBytes', 'B', encoded.b.size);
        c.value('throughput', 'MPix/s', +((s.mp / (encoded.ms / 1000))).toFixed(2));
        c.value('compressionRatio', 'ratio', +((canvas.width * canvas.height * 4) / encoded.b.size).toFixed(3));
        c.derived('outputWidth', canvas.width);
        c.derived('outputHeight', canvas.height);
      });
    }

    for (const [tag, w, h] of [
      ['half', Math.round(s.w / 2), Math.round(s.h / 2)],
      ['150pct', Math.round(s.w * 1.5), Math.round(s.h * 1.5)],
    ] as const) {
      await bench.run('export', 'resize', { size: s.label, mp: s.mp, target: tag }, async (c) => {
        const out = await c.measure('resizeMs', 'ms',
          () => compositeExportCanvas(scene, BG_COLOR, FX_OFF, w, h), { samples: heavy ? 2 : 3 });
        c.derived('outW', out?.width ?? null);
        c.derived('outH', out?.height ?? null);
      });
    }

    // JPEG cannot carry transparency and the app flattens explicitly. Assert the
    // flattening actually happens, by reading the alpha back OUT of the encoded
    // JPEG rather than trusting the composite: a runtime that quietly keeps
    // alpha would otherwise pass this.
    await bench.run('export', 'jpegOpaque', { size: s.label, mp: s.mp }, async (c) => {
      const flat = compositeExportCanvas(scene, { kind: 'transparent' }, FX_OFF, s.w, s.h);
      const data = flat.getContext('2d')!.getImageData(0, 0, flat.width, flat.height).data;
      let minAlpha = 255;
      for (let i = 3; i < data.length; i += 4) if (data[i] < minAlpha) minAlpha = data[i];
      c.derived('minAlphaInTransparentComposite', minAlpha);
      c.derived('compositeRetainsTransparency', minAlpha < 255);
      if (await canEncode('JPEG')) {
        const blob = await encodeCanvas(flat, 'JPEG');
        try {
          const bmp = await createImageBitmap(blob);
          const cv = document.createElement('canvas');
          cv.width = bmp.width; cv.height = bmp.height;
          const ctx = cv.getContext('2d')!;
          ctx.drawImage(bmp, 0, 0);
          const jd = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
          let jmin = 255;
          for (let i = 3; i < jd.length; i += 4) if (jd[i] < jmin) jmin = jd[i];
          c.derived('jpegMinAlpha', jmin);
          c.derived('jpegIsFullyOpaque', jmin === 255);
          bmp.close();
        } catch {
          c.derived('jpegIsFullyOpaque', null);
          c.note('could not decode the JPEG back to check its alpha');
        }
        c.value('jpegBytes', 'B', blob.size);
      } else {
        // Recorded on THIS case, never as a separate `bench.skip`: a skip
        // emitted from inside a running case would carry the same case id and
        // trip the validator's duplicate-id check.
        c.derived('jpegIsFullyOpaque', null);
        c.note('this runtime cannot encode JPEG, so there is nothing to flatten-check');
      }
    });
  }
}

export async function runBatchSuite(bench: Bench, mode: 'quick' | 'full' | 'stress'): Promise<void> {
  const s = mode === 'quick' ? sizesFor('quick')[1] : sizesFor('full')[2];

  // A known-value CRC check is the cheapest proof the ZIP writer is correct;
  // a corrupt archive is discovered by the user's unzip, which is too late.
  await bench.run('batch', 'crc32', { vector: 'check-123456789' }, async (c) => {
    const got = crc32(new TextEncoder().encode('123456789'));
    c.value('crc32', 'count', got >>> 0);
    c.derived('matchesKnownValue', got === 0xcbf43926);
  });

  for (const [entries, kb] of [[8, 64], [24, 64], [8, 512]] as const) {
    await bench.run('batch', 'zip', { entries, entryKb: kb }, async (c) => {
      const payload = new Uint8Array(kb * 1024);
      for (let i = 0; i < payload.length; i++) payload[i] = (i * 31) & 0xff;
      const files = Array.from({ length: entries }, (_, i) => ({ name: `item-${i}-cutout.png`, data: payload }));
      const out = await c.measure('zipMs', 'ms', () => {
        const t = performance.now();
        const z = zipStore(files, new Date(2026, 0, 1));
        return { z, ms: performance.now() - t };
      }, { samples: 3, warmups: 1 });
      if (!out) return;
      c.value('zipBytes', 'B', out.z.byteLength);
      c.value('throughput', 'MB/s', +((out.z.byteLength / 1048576) / (out.ms / 1000)).toFixed(1));
      c.derived('entries', entries);
    });
  }

  // Per-item cost of turning a finished batch item into a PNG — the loop that
  // runs once per image during batch export.
  const items = mode === 'quick' ? 4 : 8;
  await bench.run('batch', 'itemPipeline', { items, size: s.label, mp: s.mp }, async (c) => {
    const scene = makeScene(s.w, s.h);
    const total = await c.measureAsync('totalMs', 'ms', async () => {
      const t0 = performance.now();
      for (let i = 0; i < items; i++) {
        const cv = compositeExportCanvas(scene, { kind: 'transparent' }, FX_OFF, s.w, s.h);
        await encodeCanvas(cv, 'PNG');
      }
      return performance.now() - t0;
    }, { samples: 1, warmups: 0 });
    c.value('perItemMs', 'ms', total ? +(total / items).toFixed(2) : null);
    c.value('itemsPerMinute', 'count', total ? +((60000 / total) * items).toFixed(1) : null);
    c.derived('items', items);
  });

  // Admission arithmetic (SPEC §3.7: bounded by total pixels, not file count).
  await bench.run('batch', 'admission', { offered: 16, itemMp: 12.19 }, async (c) => {
    const MAX_PIXELS = 40e6;
    const per = 12.19e6;
    const accepted = Math.floor(MAX_PIXELS / per);
    c.value('acceptedItems', 'count', accepted);
    c.value('acceptedPixels', 'px', accepted * per);
    c.derived('estSessionMB', +(sessionBytesEstimate(
      { id: 'estimate', width: 4032, height: 3024, rgb: new Uint8ClampedArray(0) },
    ).total / 1048576).toFixed(1));
  });
}

/** Mute the engine's debug log for the run. It builds strings on every
 *  composite and every brush stamp, which would otherwise show up as benchmark
 *  time that belongs to the logger rather than the operation. */
export function quietEngine(): void {
  setLogEnabled(false);
}

export function restoreEngineLog(enabled: boolean): void {
  setLogEnabled(enabled);
}