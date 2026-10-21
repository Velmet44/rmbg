// The recorder: runs cases, stores RAW SAMPLES, and derives stats from the
// same module the Node validator uses.
//
// Two decisions worth stating, because they are what make a number trustworthy:
//
//  1. Raw samples are stored; `stats` is derived. The validator recomputes it,
//     so an edited summary is caught rather than published.
//  2. Warm-ups are discarded, not averaged in. The first call after a size
//     change pays for a fresh allocation and a JIT tier-up; including it is how
//     "median latency" ends up describing nobody's real experience.
//
// The reporter is also where the privacy guarantee is enforced on the WRITE
// side: every error string passes through `safeText` before it can reach a
// report, so a stack trace containing a local path cannot leak even if a case
// throws with one attached.

import { summarize } from '../../../../benchmarks/lib/stats.mjs';
import type { CaseResult, Labels, Measurement, Mode, Report, Stats, Unit } from './types';
import { SCHEMA_VERSION, SUITE_VERSION } from './types';

/** Strip anything that could carry a path, URL, email or raw data out of a
 *  message. Failure text reaches reports constantly (that is the point of a
 *  reliability suite) so this is on the hot path of trust, not a nicety. */
export function safeText(input: unknown, max = 200): string {
  let s = input instanceof Error ? `${input.name}: ${input.message}` : String(input);
  s = s
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]*/gi, '[url]')
    .replace(/[a-z]:[\\/][^\s"']*/gi, '[path]')
    .replace(/\/(?:home|users|root|tmp|var|mnt|opt)\/[^\s"']*/g, '[path]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]{2,}/g, '[email]')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Statistical noise in a browser benchmark is not small. Repeats exist so the
 *  spread is visible; they are not a licence to publish a single sample. */
export const DEFAULT_SAMPLES = 5;
export const DEFAULT_WARMUPS = 1;

export interface CaseBuilder {
  /** Timed repeat. Returns the last result so callers can derive from it. */
  measure<T>(name: string, unit: Unit, fn: () => T, opts?: MeasureOpts): Promise<T>;
  /** Timed repeat for ASYNC work. Awaited inside the timed window — timing a
   *  promise without awaiting it measures the scheduler, not the operation. */
  measureAsync<T>(name: string, unit: Unit, fn: () => Promise<T>, opts?: MeasureOpts): Promise<T>;
  /** Timed, exactly once — for operations that cannot be repeated (a cold
   *  download, a cache wipe, a memory probe that may not survive a rerun). */
  timeOnce<T>(name: string, unit: Unit, fn: () => Promise<T> | T, method?: string): Promise<T>;
  /** A single non-timed observation. */
  value(name: string, unit: Unit, v: number | null, method?: string): void;
  derived(key: string, v: number | boolean | string | null): void;
  note(text: string): void;
}

export interface MeasureOpts {
  samples?: number;
  warmups?: number;
  /** Run the case once, discard, then measure — for first-call costs. */
  method?: string;
}

export type ProgressFn = (event: { type: 'case-start' | 'case-done' | 'note'; case?: CaseResult; message?: string }) => void;

export class Bench {
  readonly cases: CaseResult[] = [];
  readonly notes: string[] = [];
  readonly startedAtMs = performance.now();
  cancelled = false;
  suites: string[] = [];
  private progress: ProgressFn | null = null;

  constructor(readonly mode: Mode, opts: { progress?: ProgressFn; suites?: string[] } = {}) {
    this.progress = opts.progress ?? null;
    this.suites = opts.suites ?? [];
  }

  setSuites(s: string[]): void { this.suites = s; }

  note(text: string): void {
    this.notes.push(safeText(text, 300));
    this.progress?.({ type: 'note', message: text });
  }

  /** Run one case. Never throws: a failing case is recorded and the run
   *  continues, because one broken capability must not cost the whole report. */
  async run<T>(
    suite: string, name: string, labels: Labels, fn: (c: CaseBuilder) => Promise<T> | T,
  ): Promise<T | undefined> {
    if (this.cancelled) return undefined;
    const id = `${suite}.${name}${labelSuffix(labels)}`;
    const result: CaseResult = { id, suite, case: name, labels, measurements: [] };
    const samples = new Map<string, number[]>();
    const units = new Map<string, Unit>();
    const warmups = new Map<string, number>();
    const single = new Map<string, Measurement>();
    const builder: CaseBuilder = {
      measure: async <T,>(mName: string, unit: Unit, mfn: () => T, o: MeasureOpts = {}) => {
        const n = o.samples ?? DEFAULT_SAMPLES;
        const w = o.warmups ?? DEFAULT_WARMUPS;
        for (let i = 0; i < w; i++) mfn();
        const out: number[] = [];
        let last: unknown;
        for (let i = 0; i < n; i++) {
          const t0 = performance.now();
          last = mfn();
          out.push(performance.now() - t0);
        }
        samples.set(mName, out);
        units.set(mName, unit);
        warmups.set(mName, w);
        return last as T;
      },
      measureAsync: async <T,>(mName: string, unit: Unit, mfn: () => Promise<T>, o: MeasureOpts = {}) => {
        const n = o.samples ?? DEFAULT_SAMPLES;
        const w = o.warmups ?? DEFAULT_WARMUPS;
        for (let i = 0; i < w; i++) await mfn();
        const out: number[] = [];
        let last: unknown;
        for (let i = 0; i < n; i++) {
          const t0 = performance.now();
          last = await mfn();
          out.push(performance.now() - t0);
        }
        samples.set(mName, out);
        units.set(mName, unit);
        warmups.set(mName, w);
        return last as T;
      },
      timeOnce: async <T,>(mName: string, unit: Unit, fn1: () => Promise<T> | T, method?: string) => {
        const t0 = performance.now();
        const v = await fn1();
        single.set(mName, {
          name: mName, unit, warmups: 0, samples: [performance.now() - t0],
          stats: null, method: method ?? null,
        });
        return v;
      },
      value: (mName, unit, v, method) => {
        single.set(mName, { name: mName, unit, warmups: 0, samples: null, value: v, stats: null, method: method ?? null });
      },
      derived: (k, v) => {
        result.derived ??= {};
        result.derived[k] = v;
      },
      note: (text) => {
        result.notes ??= [];
        result.notes.push(safeText(text, 200));
      },
    };

    this.progress?.({ type: 'case-start', case: result });
    try {
      await fn(builder);
    } catch (e) {
      result.failed = true;
      result.failReason = safeText(e);
    }
    // Assemble measurements last so a case that throws halfway still keeps
    // everything it did measure — a partial measurement is evidence, a dropped
    // one is a lost measurement.
    for (const [mName, xs] of samples) {
      const m: Measurement = {
        name: mName, unit: units.get(mName) ?? 'ms', warmups: warmups.get(mName) ?? 0,
        samples: xs, stats: summarize(xs) as Stats, method: null,
      };
      result.measurements.push(m);
    }
    for (const m of single.values()) {
      if (m.samples && !m.stats) m.stats = summarize(m.samples) as Stats;
      result.measurements.push(m);
    }
    this.cases.push(result);
    this.progress?.({ type: 'case-done', case: result });
    return undefined;
  }

  /** Record a case that cannot run here (capability gate, deliberate skip). */
  skip(suite: string, name: string, labels: Labels, reason: string): void {
    const result: CaseResult = {
      id: `${suite}.${name}${labelSuffix(labels)}`, suite, case: name, labels,
      skipped: true, skipReason: safeText(reason, 200), measurements: [],
    };
    this.cases.push(result);
    this.progress?.({ type: 'case-done', case: result });
  }

  report(ctx: Omit<Report, 'schemaVersion' | 'suiteVersion' | 'run' | 'cases' | 'notes'> & { hostLabel?: string | null }): Report {
    const now = performance.now();
    const abortedReason = this.cancelled ? 'cancelled by the person running it' : null;
    // Pulled out of `ctx` explicitly: spreading it would land `hostLabel` at the
    // TOP level of the report, where the schema does not allow it. It belongs to
    // `run`.
    const { hostLabel, ...rest } = ctx;
    return {
      schemaVersion: SCHEMA_VERSION,
      suiteVersion: SUITE_VERSION,
      ...rest,
      run: {
        id: newRunId(),
        // Wall clock, NOT performance.now(). `performance.now()` is
        // milliseconds since the page loaded, so feeding it to `new Date()`
        // produced 1970-01-01 — a timestamp that looks like data and is not.
        // The elapsed arithmetic below still uses the monotonic clock, which is
        // the right one for durations.
        startedAt: new Date().toISOString(),
        mode: this.mode,
        completed: !this.cancelled,
        abortedReason,
        durationMs: Math.round(now - this.startedAtMs),
        suites: this.suites,
        hostLabel: hostLabel ?? null,
      },
      cases: this.cases,
      notes: this.notes,
    };
  }
}

function labelSuffix(labels: Labels): string {
  const keys = Object.keys(labels).filter((k) => labels[k] !== null && labels[k] !== undefined);
  if (!keys.length) return '';
  return `@${keys.map((k) => `${k}=${String(labels[k]).replace(/[^A-Za-z0-9_.-]+/g, '')}`).join(',')}`;
}

export function newRunId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}