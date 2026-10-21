// Reliability: failure injection against the shipped code.
//
// SPEC §11 promises an actionable message for every fallible step, and lists
// error-injection tests as the Stage 4 work that was never done. This is that
// work, scoped to what a browser can actually force:
//
//   * a file the browser cannot decode            -> must reject, not hang
//   * a mask whose size does not match its image   -> must throw a NAMED error
//   * a truncated RGB buffer into region grow      -> must throw, not return the
//                                                      whole image as a selection
//   * a 0x0 encode                                 -> must not produce a silent
//                                                      zero-byte "success"
//   * an empty ZIP                                  -> must stay a valid archive
//   * undo after the canonical mask was replaced  -> must restore the OLD mask
//
// Each expectation is asserted, not assumed: a case that fails records the real
// behaviour, so this suite is evidence rather than a claim.

import { OpLog, composite, growRegion, refineEdges, type AlphaMask, type ImageRef } from '@rmbg/engine';
import type { Bench } from '../record';
import { makeScene } from './engine';
import { decodeToImageRefTimed } from '../../decode';
import { canEncode, compositeExportCanvas, encodeCanvas } from '../../canvas-out';
import { zipStore } from '../../zip';

const FX_OFF = { shadow: { on: false, opacity: 0, blur: 0, dx: 0, dy: 0 }, feather: 0, defringe: 0 } as const;

export async function runReliabilitySuite(bench: Bench, mode: 'quick' | 'full' | 'stress'): Promise<void> {
  // --- undecodable input ---
  await bench.run('reliability', 'undecodableInput', { source: 'text-as-image' }, async (c) => {
    const junk = new Blob([new Uint8Array([0x52, 0x4d, 0x42, 0x47, 0x21, 0x00, 0x13, 0x37])], { type: 'image/png' });
    let rejected = false;
    let errName: string | null = null;
    const t0 = performance.now();
    try {
      await decodeToImageRefTimed(junk, 'junk');
    } catch (e) {
      rejected = true;
      errName = (e as Error)?.name ?? 'Error';
    }
    c.value('rejectMs', 'ms', +(performance.now() - t0).toFixed(2));
    c.derived('rejected', rejected);
    c.derived('errorName', errName);
    c.derived('passed', rejected);
    c.note('A silent hang here is the exact failure SPEC §3.1 forbids ("no silent failure, no hang on a spinner").');
  });

  await bench.run('reliability', 'emptyInput', { source: 'zero-byte' }, async (c) => {
    let rejected = false;
    try { await decodeToImageRefTimed(new Blob([], { type: 'image/png' }), 'empty'); } catch { rejected = true; }
    c.derived('rejected', rejected);
    c.derived('passed', rejected);
  });

  // --- engine guards: mismatched dimensions must be a named error ---
  await bench.run('reliability', 'compositeSizeMismatch', { sizes: '512x512 vs 256x256' }, async (c) => {
    const scene = makeScene(512, 512);
    let threw = false;
    let msg = '';
    try {
      composite(scene.image, { width: 256, height: 256, alpha: new Float32Array(256 * 256) }, { kind: 'transparent' }, FX_OFF);
    } catch (e) {
      threw = true;
      msg = (e as Error).message;
    }
    c.derived('threw', threw);
    c.derived('errorMentionsSizes', /sizes differ|256|512/.test(msg));
    c.derived('passed', threw);
  });

  // --- the short-buffer trap in growRegion ---
  // rgb.length < w*h*3 used to make the similarity test accept EVERY pixel, so
  // the "region" silently became the whole image and erasing it wiped the photo.
  await bench.run('reliability', 'growRegionShortBuffer', { corruption: 'rgb-truncated' }, async (c) => {
    const scene = makeScene(64, 64);
    const broken: ImageRef = { ...scene.image, rgb: scene.image.rgb.slice(0, 100) };
    let threw = false;
    let msg = '';
    try {
      growRegion(broken, 32, 32);
    } catch (e) {
      threw = true;
      msg = (e as Error).message;
    }
    c.derived('threw', threw);
    c.derived('errorNamesBytes', /bytes/.test(msg));
    c.derived('passed', threw);
    c.note('A grow that returns the whole image would be applied as an erase and delete the photo.');
  });

  await bench.run('reliability', 'growRegionCap', { input: 'flat-background' }, async (c) => {
    // A click on a uniform area grows until the 50% cap. `truncated` is what
    // lets a caller refuse a half-region instead of erasing a sliver.
    const flat: ImageRef = { id: 'flat', width: 128, height: 128, rgb: new Uint8ClampedArray(128 * 128 * 3).fill(120) };
    const grown = growRegion(flat, 64, 64);
    c.derived('truncated', grown.truncated);
    c.derived('coverageRatio', +(grown.box.w * grown.box.h / (128 * 128)).toFixed(3));
    c.derived('respectsCap', grown.box.w * grown.box.h <= 128 * 128 * 0.5 + 1);
    c.derived('passed', grown.truncated && grown.box.w * grown.box.h <= 128 * 128 * 0.5 + 1);
  });

  // --- encode edge cases ---
  await bench.run('reliability', 'encodeDegenerateSize', { size: '0x0' }, async (c) => {
    const cv = document.createElement('canvas');
    cv.width = 0; cv.height = 0;
    let outcome = 'produced';
    let bytes = 0;
    try {
      const blob = await encodeCanvas(cv, 'PNG');
      bytes = blob.size;
      if (blob.size === 0) outcome = 'zero-byte';
    } catch {
      outcome = 'threw';
    }
    c.value('bytes', 'B', bytes);
    c.derived('outcome', outcome);
    c.derived('notSilentlyEmpty', outcome !== 'zero-byte');
    c.derived('passed', outcome !== 'zero-byte');
  });

  await bench.run('reliability', 'emptyZip', { entries: 0 }, async (c) => {
    const zip = zipStore([], new Date(2026, 0, 1));
    // A stored, empty archive is exactly 22 bytes of end-of-central-directory.
    c.value('bytes', 'B', zip.byteLength);
    c.derived('isValidEmptyArchive', zip.byteLength === 22);
    c.derived('passed', zip.byteLength === 22);
  });

  // --- history contract: undo after a mask swap restores the OLD mask ---
  await bench.run('reliability', 'undoAfterMaskSwap', { op: 'replaceMask' }, async (c) => {
    const scene = makeScene(64, 64);
    const holder: { mask: AlphaMask | null } = { mask: scene.mask };
    const log = new OpLog();
    const first: AlphaMask = { width: 64, height: 64, alpha: new Float32Array(64 * 64).fill(0.25) };
    const second: AlphaMask = { width: 64, height: 64, alpha: new Float32Array(64 * 64).fill(0.75) };
    log.replaceMask(holder, 'first', first);
    log.replaceMask(holder, 'second', second);
    log.undo();
    const restoredFirst = holder.mask === first;
    log.undo();
    const restoredNone = holder.mask === null;
    log.redo();
    const redone = holder.mask === first;
    c.derived('undoRestoredPreviousMask', restoredFirst);
    c.derived('undoBeforeAnyCutoutIsNull', restoredNone);
    c.derived('redoRestoresMask', redone);
    c.derived('passed', restoredFirst && restoredNone && redone);
    c.note('Committing a replacement as its own pre-image made Undo report success, change nothing and burn a slot.');
  });

  await bench.run('reliability', 'historyByteBudget', { entries: 80, size: '1.9MP' }, async (c) => {
    const scene = makeScene(1600, 1200);
    const log = new OpLog();
    for (let i = 0; i < 80; i++) {
      log.commitRegion(scene.mask, `op-${i}`, (m) => {
        m.alpha[i % m.alpha.length] = i % 2 ? 0.1 : 0.9;
        return null; // null => whole-frame snapshot, the expensive path
      });
    }
    c.derived('depthAfter80', log.depth);
    c.derived('retainedMB', +(log.retainedBytes / 1048576).toFixed(1));
    c.derived('underBudget', log.retainedBytes <= 256 * 1024 * 1024 + 1);
    // A byte budget that still evicted EVERYTHING would make undo useless; the
    // floor exists so one huge image cannot do that, so assert the floor held.
    c.derived('floorHeld', log.depth >= 3);
    c.derived('passed', log.retainedBytes <= 256 * 1024 * 1024 + 1 && log.depth >= 3);
  });

  await bench.run('reliability', 'refineEdgesNoop', { feather: 0, defringe: 0 }, async (c) => {
    const scene = makeScene(128, 128);
    const before = new Float32Array(scene.mask.alpha);
    refineEdges(scene.mask, { feather: 0, defringe: 0 });
    let same = true;
    for (let i = 0; i < before.length; i++) if (before[i] !== scene.mask.alpha[i]) { same = false; break; }
    c.derived('maskUnchanged', same);
    c.derived('passed', same);
  });

  // --- encoder support matrix, recorded rather than assumed ---
  await bench.run('reliability', 'encoderSupport', { check: 'png,webp,jpeg,avif' }, async (c) => {
    for (const fmt of ['PNG', 'WebP', 'JPEG', 'AVIF'] as const) {
      c.derived(`canEncode_${fmt}`, await canEncode(fmt));
    }
    c.derived('passed', true);
  });

  // --- the export path end to end, without downloading anything ---
  await bench.run('reliability', 'exportRoundTrip', { size: '0.26MP', format: 'PNG' }, async (c) => {
    const scene = makeScene(512, 512);
    const canvas = compositeExportCanvas(scene, { kind: 'transparent' }, FX_OFF, 512, 512);
    const blob = await encodeCanvas(canvas, 'PNG');
    const bmp = await createImageBitmap(blob);
    // Read the dimensions BEFORE closing: after close() the bitmap is released.
    const w = bmp.width, h = bmp.height;
    bmp.close();
    c.derived('decodedW', w);
    c.derived('decodedH', h);
    c.derived('dimensionsPreserved', w === 512 && h === 512);
    c.derived('passed', w === 512 && h === 512);
  });
}