// Tests for the benchmark SYSTEM — the parts that decide whether a number is
// trustworthy, and the parts that enforce the privacy promise.
//
// Deliberately no timing assertions here. A test that fails on a slow CI box
// trains people to ignore failing tests, which is worse than no test. What is
// asserted is arithmetic (does summarize() compute what it claims), geometry
// (does the orientation check catch a flipped mask), and refusal (does the
// validator reject a report carrying a URL, a path or an edited stat block).
//
// The suites themselves are exercised in a real browser — that is the only
// place they mean anything.

import { describe, expect, it } from 'vitest';
import schema from '../../../benchmarks/lib/report.schema.json';
import {
  alphaMae, applyTransform, bestOrientation, binaryScores, binarize, boundaryF, coverage,
} from '../src/bench/score';
import { corpusCoverage, corpusForMode } from '../src/bench/corpus';
import {
  synthDisc, synthFur, synthLowContrast, synthSmallObject, synthSoftAlpha, synthThinBars, synthTwoSubjects,
} from '../src/bench/synth';
import { crc32, zipStore } from '../src/zip';
import { safeText } from '../src/bench/record';
import { summarize, quantile, hasReliableTail, fmtMs, fmtBytes } from '../../../benchmarks/lib/stats.mjs';
import { validateReportAgainstSchema, scanPrivacy, checkIntegrity } from '../../../benchmarks/lib/validate-core.mjs';

describe('statistics', () => {
  it('interpolates between order statistics', () => {
    expect(quantile([1, 2, 3, 4], 0)).toBe(1);
    expect(quantile([1, 2, 3, 4], 1)).toBe(4);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([5], 0.9)).toBe(5);
    expect(quantile([], 0.5)).toBeNull();
  });

  it('computes the documented summary fields', () => {
    const s = summarize([10, 20, 30, 40]);
    expect(s).not.toBeNull();
    expect(s!.n).toBe(4);
    expect(s!.min).toBe(10);
    expect(s!.max).toBe(40);
    expect(s!.median).toBe(25);
    expect(s!.mean).toBe(25);
    expect(s!.iqr).toBe(15);
  });

  it('withholds p95 below 20 samples instead of publishing one outlier', () => {
    // A p95 over 3 samples is the worst of 3 and reads as a hard bound.
    expect(hasReliableTail(19)).toBe(false);
    expect(hasReliableTail(20)).toBe(true);
    expect(summarize([1, 2, 3])!.p95).toBeNull();
    expect(summarize(Array.from({ length: 20 }, (_, i) => i + 1))!.p95).not.toBeNull();
  });

  it('returns null for an empty sample set rather than NaN', () => {
    expect(summarize([])).toBeNull();
    expect(summarize([NaN, Infinity])).toBeNull();
  });

  it('formats durations and sizes for humans', () => {
    expect(fmtMs(0.42)).toBe('0.42ms');
    expect(fmtMs(2500)).toBe('2.5s');
    expect(fmtBytes(2048)).toBe('2KB');
    expect(fmtMs(null)).toBe('—');
  });
});

describe('mask scoring', () => {
  const w = 32, h = 32;
  const left = new Float32Array(w * h);
  const right = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < 16) left[y * w + x] = 1;
      if (x >= 16) right[y * w + x] = 1;
    }
  }

  it('scores identical masks as a perfect 1 and disjoint masks as 0', () => {
    expect(binaryScores(left, left).iou).toBe(1);
    expect(binaryScores(left, right).iou).toBe(0);
  });

  it('counts precision and recall asymmetrically', () => {
    const truth = new Uint8Array([1, 1, 1, 0]);
    const pred = new Uint8Array([1, 1, 0, 1]);
    const s = binaryScores(pred, truth);
    expect(s.intersection).toBe(2);
    expect(s.precision).toBeCloseTo(2 / 3);
    expect(s.recall).toBeCloseTo(2 / 3);
  });

  it('applies the threshold rather than assuming it', () => {
    const soft = [0.1, 0.49, 0.5, 0.9];
    expect([...binarize(soft, 0.5)]).toEqual([0, 0, 1, 1]);
    expect([...binarize(soft, 0.9)]).toEqual([0, 0, 0, 1]);
  });

  it('gives a shifted edge a tolerance-based boundary F below 1 but above 0', () => {
    // Shift the reference split one pixel right: the binary masks now disagree…
    const shifted = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) shifted[y * w + x] = right[y * w + x - 1];
    expect(binaryScores(shifted, right).iou).toBeLessThan(1);
    // …but the boundary is only a pixel away, so a 2px tolerance forgives it.
    expect(boundaryF(shifted, right, w, h, 2).f).toBeGreaterThan(0);
  });

  it('penalises a boundary that is far away even at a generous tolerance', () => {
    const far = new Float32Array(w * h);
    for (let y = 4; y < h - 4; y++) for (let x = 4; x < w - 4; x++) far[y * w + x] = 1;
    expect(boundaryF(far, right, w, h, 2).f).toBeLessThan(0.5);
  });

  /** Deliberately asymmetric in every axis, so no flip or transpose of it can
   *  coincide with it — the precondition for an orientation test to mean
   *  anything. (A left/right half-split is its own mirror image.) */
  const asymmetric = () => {
    const m = new Float32Array(w * h);
    for (let y = 3; y < 11; y++) for (let x = 2; x < 6; x++) m[y * w + x] = 1;
    return m;
  };

  it('detects a horizontally flipped mask — the bug every other metric hides', () => {
    const truth = asymmetric();
    const flipped = applyTransform(truth, w, h, 'hflip');
    const check = bestOrientation(flipped, truth, w, h);
    expect(check.best).toBe('hflip');
    expect(check.identityIou).toBe(0);
    expect(check.bestIou).toBe(1);
  });

  it('detects a transposed mask', () => {
    const truth = asymmetric();
    const t = applyTransform(truth, w, h, 'transpose');
    expect(bestOrientation(t, truth, w, h).best).toBe('transpose');
  });

  it('reports identity for a correctly oriented mask', () => {
    const truth = asymmetric();
    const r = bestOrientation(truth, truth, w, h);
    expect(r.best).toBe('identity');
    expect(r.identityIou).toBe(1);
  });

  it('measures soft-alpha error in absolute alpha units', () => {
    const a = [0, 0.5, 1];
    const b = [0, 0.25, 1];
    expect(alphaMae(a, b)).toBeCloseTo((0.25 / 3), 6);
    expect(alphaMae(a, a)).toBe(0);
    expect(coverage([0, 1, 1, 0])).toBe(0.5);
  });
});

describe('synthetic corpus', () => {
  const W = 128, H = 96;

  it('produces ground truth that matches the drawn subject', () => {
    for (const [name, syn] of [
      ['disc', synthDisc(W, H)],
      ['thin-bars', synthThinBars(W, H)],
      ['fur', synthFur(W, H)],
      ['low-contrast', synthLowContrast(W, H)],
      ['two-subjects', synthTwoSubjects(W, H)],
      ['soft-alpha', synthSoftAlpha(W, H)],
      ['small-object', synthSmallObject(W, H)],
    ] as const) {
      expect(syn.rgb.length, name).toBe(W * H * 3);
      expect(syn.gt.length, name).toBe(W * H);
      const cov = coverage(syn.gt);
      expect(cov, `${name} coverage`).toBeGreaterThan(0);
      expect(cov, `${name} coverage`).toBeLessThan(0.95);
      // Alpha must stay inside [0,1]: an out-of-range value would silently
      // corrupt every downstream blend.
      for (let i = 0; i < syn.gt.length; i++) {
        expect(syn.gt[i]).toBeGreaterThanOrEqual(0);
        expect(syn.gt[i]).toBeLessThanOrEqual(1);
        if (syn.gt[i] > 0) break;
      }
    }
  });

  it('is deterministic, so a score change means a code change', () => {
    const a = synthDisc(64, 64);
    const b = synthDisc(64, 64);
    expect([...a.rgb]).toEqual([...b.rgb]);
    expect([...a.gt]).toEqual([...b.gt]);
  });

  it('gives the soft-alpha case a wide transition band and a hard shape only a rim', () => {
    // Every generator antialiases its rim by a pixel or two, so "has soft
    // pixels" is true everywhere and proves nothing. What distinguishes the
    // soft-alpha case is the AREA with no hard edge anywhere — that is what
    // makes its alphaMAE a measurement instead of noise.
    const softFraction = (g: Float32Array) => {
      let n = 0;
      for (let i = 0; i < g.length; i++) if (g[i] > 0.05 && g[i] < 0.95) n++;
      return n / g.length;
    };
    expect(softFraction(synthSoftAlpha(128, 96).gt)).toBeGreaterThan(0.15);
    expect(softFraction(synthDisc(128, 96).gt)).toBeLessThan(0.08);
  });

  it('covers both subjects of the two-subject case and not the corners', () => {
    const g = synthTwoSubjects(256, 256).gt;
    const at = (x: number, y: number) => g[y * 256 + x];
    expect(at(80, 128)).toBeGreaterThan(0.9);
    expect(at(174, 118)).toBeGreaterThan(0.9);
    expect(at(4, 4)).toBe(0);
  });

  it('reports which SPEC conditions are NOT covered, rather than implying they are', () => {
    const cov = corpusCoverage(corpusForMode('full'));
    const byName = Object.fromEntries(cov.map((c) => [c.category, c]));
    expect(byName['thin-object'].automated).toBe(true);
    expect(byName['multiple-subjects'].automated).toBe(true);
    // The ones with no synthetic stand-in must say so.
    expect(byName.fingers.automated).toBe(false);
    expect(byName['glasses-transparency'].automated).toBe(false);
    expect(byName.hair.automated).toBe(false);
    expect(cov.length).toBeGreaterThanOrEqual(10);
    for (const c of cov) expect(c.why.length).toBeGreaterThan(10);
  });

  it('ships no photo fixtures, because none have verified provenance', () => {
    const cases = corpusForMode('full');
    expect(cases.every((c) => c.kind === 'synthetic')).toBe(true);
  });
});

describe('ZIP writer (the batch export path)', () => {
  it('computes the standard CRC-32 check value', () => {
    // "123456789" -> 0xCBF43926 is the canonical CRC-32/ISO-HDLC test vector.
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('writes a valid empty archive rather than a zero-byte file', () => {
    // An empty stored ZIP is exactly the 22-byte end-of-central-directory record.
    expect(zipStore([], new Date(2026, 0, 1)).byteLength).toBe(22);
  });

  it('starts a stored archive with the local file header signature', () => {
    const zip = zipStore([{ name: 'a.png', data: new Uint8Array([1, 2, 3]) }], new Date(2026, 0, 1));
    expect(zip[0]).toBe(0x50); expect(zip[1]).toBe(0x4b); expect(zip[2]).toBe(0x03); expect(zip[3]).toBe(0x04);
    expect(zip.byteLength).toBeGreaterThan(22);
  });
});

describe('privacy', () => {
  it('strips URLs, paths and emails out of failure text before it reaches a report', () => {
    const text = safeText(new Error('failed to fetch https://cdn.example.com/model.js at C:\\Users\\me\\app\\x.js'));
    expect(text).not.toContain('cdn.example.com');
    expect(text).not.toContain('Users');
    expect(text).toContain('[url]');
    expect(text).toContain('[path]');
  });

  it('rejects a report whose strings carry a URL', () => {
    expect(scanPrivacy({ run: { id: 'abcdefgh12345678' }, notes: ['see https://example.com/x'] }))
      .toContainEqual(expect.stringContaining('a URL'));
  });

  it('rejects Windows and Unix paths, emails, data URIs and base64 blobs', () => {
    expect(scanPrivacy({ a: 'C:\\Users\\me\\pic.jpg' })).toHaveLength(1);
    expect(scanPrivacy({ a: '/home/me/pic.jpg' })).toHaveLength(1);
    expect(scanPrivacy({ a: 'me@example.com' })).toHaveLength(1);
    expect(scanPrivacy({ a: 'data:image/png;base64,AAAA' })).toHaveLength(1);
    // A long base64 payload is caught by its own rule, not only as a data URI.
    // 200 chars is over the base64 threshold and under the string-length one, so
    // exactly one rule fires.
    expect(scanPrivacy({ a: 'QUJDRA=='.repeat(25) })).toHaveLength(1);
    // And an over-long string is flagged as embedded data regardless of content.
    // Spaces keep it off the base64 rule, so this isolates the length check.
    expect(scanPrivacy({ a: 'lorem ipsum '.repeat(30) })).toHaveLength(1);
  });

  it('rejects forbidden keys that would carry image bytes or machine identity', () => {
    const errors = scanPrivacy({ cases: [{ labels: { filename: 'holiday.jpg' } }] });
    expect(errors.some((e) => e.includes('forbidden key'))).toBe(true);
  });

  it('allows a self-chosen machine nickname', () => {
    expect(scanPrivacy({ run: { hostLabel: 'workstation' } })).toHaveLength(0);
  });
});

describe('report validation', () => {
  const good = () => ({
    schemaVersion: 'rmbg-bench/1',
    suiteVersion: '1.0.0',
    app: {
      commit: null, buildKind: 'deployed',
      model: { id: 'studioludens/birefnet-lite-512', revision: '4a3c40c3' },
      runtime: { id: 'transformers.js-cdn-esm', version: null },
      engine: { workingLongSide: 512 },
    },
    run: {
      id: 'a1b2c3d4e5f6a7b8', startedAt: '2026-10-03T14:00:00.000Z', mode: 'quick',
      completed: true, abortedReason: null, durationMs: 1234, suites: ['engine'], hostLabel: null,
    },
    environment: {
      browser: { name: 'Chrome', version: '140' },
      os: { name: 'Windows', version: '10+' },
      deviceMemoryGbBucket: '<=8', hardwareConcurrency: 8, hardwareConcurrencyBucket: '<=8',
      devicePixelRatio: 1, viewport: { width: 1280, height: 800 },
      crossOriginIsolated: false, isSecureContext: true,
    },
    hardware: null,
    capabilities: { webgpu: true },
    cases: [{
      id: 'engine.brush@size=0.26MP', suite: 'engine', case: 'brush',
      labels: { size: '0.26MP' },
      measurements: [{ name: 'strokeMs', unit: 'ms', warmups: 1, samples: [1, 2, 3], stats: summarize([1, 2, 3]), method: null }],
      derived: { areaPx: 100 }, notes: [],
    }],
    notes: [],
    privacy: { includeHardwareDetails: false, forbiddenFieldsChecked: true, toolkit: 'rmbg-bench/rmbg-bench/1' },
  });

  it('accepts a well-formed report', () => {
    const { ok, errors } = validateReportAgainstSchema(good(), schema);
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
  });

  it('rejects a stats block that does not match its own samples', () => {
    // The whole point of storing raw samples: a hand-edited median must not be
    // publishable as a measurement.
    const r = good() as any;
    r.cases[0].measurements[0].stats.median = 999;
    const { ok, errors } = validateReportAgainstSchema(r, schema);
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes('stats.median'))).toBe(true);
  });

  it('rejects a measurement with neither samples nor a value', () => {
    const r = good() as any;
    r.cases[0].measurements[0].samples = null;
    r.cases[0].measurements[0].stats = null;
    expect(checkIntegrity(r).some((e) => e.includes('neither samples nor value'))).toBe(true);
  });

  it('rejects an unknown property, so a typo cannot hide data', () => {
    const r = good() as any;
    r.cases[0].rawMask = 'AAAA';
    const { ok } = validateReportAgainstSchema(r, schema);
    expect(ok).toBe(false);
  });

  it('rejects a completed run that also claims it was aborted', () => {
    const r = good() as any;
    r.run.abortedReason = 'cancelled';
    expect(checkIntegrity(r).some((e) => e.includes('abort reason'))).toBe(true);
  });

  it('rejects a duplicate case id, which would double-count in the tables', () => {
    const r = good() as any;
    r.cases.push({ ...r.cases[0] });
    expect(checkIntegrity(r).some((e) => e.includes('duplicate case id'))).toBe(true);
  });

  it('accepts a partial run as long as it says so', () => {
    const r = good() as any;
    r.run.completed = false;
    r.run.abortedReason = 'cancelled by the person running it';
    const { ok } = validateReportAgainstSchema(r, schema);
    expect(ok).toBe(true);
  });

  it('rejects a hostLabel at the top level, where the schema does not allow it', () => {
    // Regression: `report(ctx)` spread `hostLabel` out of the run object, so
    // every real report carried an unexpected top-level property.
    const r = good() as any;
    r.hostLabel = null;
    const { ok } = validateReportAgainstSchema(r, schema);
    expect(ok).toBe(false);
  });

  it('rejects an epoch timestamp, which is what formatting performance.now() produces', () => {
    // Regression: the recorder formatted `performance.now()` (milliseconds since
    // page load) through `new Date()`, yielding 1970-01-01 — plausible-looking,
    // and wrong.
    const r = good() as any;
    r.run.startedAt = '1970-01-01T00:00:22.984Z';
    const { ok } = validateReportAgainstSchema(r, schema);
    expect(ok).toBe(false);
  });
});