// Benchmark orchestrator + page wiring.
//
// Flow: choose a mode -> run -> review the exact JSON -> download -> submit.
// There is NO upload path anywhere in this file, and no network call of any kind
// except the model weights the app itself already downloads. That is the whole
// privacy design: the contributor keeps the file and decides what to do with it.
//
// A partial run is a first-class outcome. Progress is written to localStorage
// after every case, so a tab that crashes at 90% still leaves evidence behind.

import { WORKING_LONG_SIDE } from '@rmbg/engine';
import { Bench } from './record';
import { captureEnvironment } from './env';
import { MODEL_ID, MODEL_REV } from '../model-config';
import {
  quietEngine, restoreEngineLog,
  runBatchSuite, runDisplaySuite, runExportSuite, runIngestSuite,
} from './suites/pipeline';
import { runEngineSuite } from './suites/engine';
import { runInferenceSuite } from './suites/inference';
import { runMemorySuite } from './suites/memory';
import { runReliabilitySuite } from './suites/reliability';
import { SCHEMA_VERSION, type Mode, type Report } from './types';

const STORE_KEY = 'rmbg-bench-partial';

export interface SuiteDef {
  id: string;
  label: string;
  blurb: string;
  /** Needs the model: may download ~98MB and take minutes on CPU. */
  needsModel: boolean;
  runs: (mode: Mode) => string[];
}

export const SUITES: SuiteDef[] = [
  { id: 'engine', label: 'Engine pixel ops', blurb: 'Brush, guided select, refine, composite, transform, undo — the DOM-free maths.', needsModel: false, runs: (m) => ['engine'] },
  { id: 'ingest', label: 'Ingest / decode', blurb: 'Decode PNG, WebP, JPEG, AVIF by real encoded bytes and packed-RGB cost.', needsModel: false, runs: (m) => ['ingest'] },
  { id: 'display', label: 'Display', blurb: 'Each compare mode, animation-frame coalescing, and whether the page keeps moving.', needsModel: false, runs: (m) => ['display'] },
  { id: 'export', label: 'Export', blurb: 'Composite and encode timed separately, per format and custom size.', needsModel: false, runs: (m) => ['export'] },
  { id: 'batch', label: 'Batch', blurb: 'ZIP writer, per-item PNG cost, and the pixel-budget admission arithmetic.', needsModel: false, runs: (m) => ['batch'] },
  { id: 'reliability', label: 'Reliability', blurb: 'Failure injection: undecodable input, size mismatches, history contracts.', needsModel: false, runs: (m) => ['reliability'] },
  { id: 'memory', label: 'Memory matrix', blurb: '12 / 24 / 50 MP allocation and composite cost, and where this machine stops.', needsModel: false, runs: (m) => ['memory'] },
  { id: 'inference', label: 'Model & quality', blurb: 'Worker init phases, segmentation, region recompute, mask scoring. Downloads the model.', needsModel: true, runs: (m) => ['inference', 'quality'] },
];

export function suitesForMode(mode: Mode): SuiteDef[] {
  if (mode === 'quick') {
    return SUITES.filter((s) => ['engine', 'ingest', 'display', 'export', 'batch', 'reliability'].includes(s.id));
  }
  return SUITES;
}

/** Modes, in the words a person would use. */
export const MODES: { id: Mode; label: string; blurb: string; needsModel: boolean; minutes: string }[] = [
  { id: 'quick', label: 'Quick', blurb: 'No model download. Engine, decode, display, export, batch, reliability. Good first run.', needsModel: false, minutes: '~1 min' },
  { id: 'full', label: 'Full', blurb: 'Everything, including the model: init phases, segmentation, quality scoring, memory matrix.', needsModel: true, minutes: '5–30 min (CPU fallback is slow)' },
  { id: 'stress', label: 'Stress', blurb: 'Adds 24/50 MP composites, an allocation-failure probe, and the largest corpus. Use when hunting the limits.', needsModel: true, minutes: '10–60 min, high memory use' },
];

export interface RunOptions {
  mode: Mode;
  suites: string[];
  includeHardware: boolean;
  cold: boolean;
  hostLabel?: string | null;
  verboseLog: boolean;
  onUpdate: (state: BenchState) => void;
}

export interface BenchState {
  phase: 'idle' | 'running' | 'done';
  current: string;
  completed: number;
  total: number;
  log: string[];
  report: Report | null;
}

let active: Bench | null = null;

export async function runBenchmark(opts: RunOptions): Promise<Report> {
  const selected = SUITES.filter((s) => opts.suites.includes(s.id));
  const names = selected.flatMap((s) => s.runs(opts.mode));
  const log: string[] = [];
  const state: BenchState = { phase: 'running', current: '', completed: 0, total: 0, log, report: null };

  if (!opts.verboseLog) quietEngine();
  const bench = new Bench(opts.mode, {
    suites: names,
    progress: (ev) => {
      if (ev.type === 'case-start') {
        state.current = ev.case?.id ?? '';
        log.push(`→ ${ev.case?.id ?? ''}`);
      } else if (ev.type === 'case-done') {
        const k = ev.case;
        state.completed++;
        state.total = Math.max(state.total, state.completed);
        const verdict = k?.skipped ? `SKIP ${k.skipReason ?? ''}`
          : k?.failed ? `FAIL ${k.failReason ?? ''}`
            : `${k?.measurements.length ?? 0} measurement(s)`;
        log.push(`  ${k?.id ?? ''} — ${verdict}`);
        if (log.length > 400) log.splice(0, log.length - 400);
        savePartial(state, opts);
        opts.onUpdate({ ...state, log: [...log] });
      } else if (ev.message) {
        log.push(ev.message);
        opts.onUpdate({ ...state, log: [...log] });
      }
    },
  });
  active = bench;
  opts.onUpdate({ ...state, log: [...log] });

  const cold = opts.cold;
  try {
    for (const suite of selected) {
      if (bench.cancelled) break;
      log.push(`— ${suite.label}`);
      switch (suite.id) {
        case 'engine': await runEngineSuite(bench, opts.mode); break;
        case 'ingest': await runIngestSuite(bench, opts.mode); break;
        case 'display': await runDisplaySuite(bench, opts.mode); break;
        case 'export': await runExportSuite(bench, opts.mode); break;
        case 'batch': await runBatchSuite(bench, opts.mode); break;
        case 'reliability': await runReliabilitySuite(bench, opts.mode); break;
        case 'memory': await runMemorySuite(bench, opts.mode); break;
        case 'inference': {
          const r = await runInferenceSuite(bench, opts.mode, {
            cold,
            signal: { get cancelled() { return bench.cancelled; } },
            onLog: (m) => { log.push(m); opts.onUpdate({ ...state, log: [...log] }); },
          });
          bench.note(`model=${r.modelId}@${r.revision} backend=${r.backend ?? 'unknown'} workingLongSide=${r.workingLongSide}`);
          break;
        }
      }
    }
  } finally {
    if (!opts.verboseLog) restoreEngineLog(true);
    const env = await captureEnvironment({ includeHardware: opts.includeHardware });
    const report = bench.report({
      app: {
        commit: detectCommit(),
        buildKind: detectBuildKind(),
        model: { id: MODEL_ID, revision: MODEL_REV },
        runtime: { id: 'transformers.js-cdn-esm', version: null },
        engine: { workingLongSide: WORKING_LONG_SIDE },
      },
      environment: env.environment,
      hardware: env.hardware,
      capabilities: env.capabilities,
      privacy: {
        includeHardwareDetails: opts.includeHardware,
        forbiddenFieldsChecked: true,
        toolkit: `rmbg-bench/${SCHEMA_VERSION}`,
      },
      hostLabel: opts.hostLabel ?? null,
    });
    state.report = report;
    state.phase = 'done';
    active = null;
    clearPartial();
    opts.onUpdate({ ...state, log: [...log] });
    return report;
  }
}

export function cancelRun(): void {
  if (active) active.cancelled = true;
}

function detectCommit(): string | null {
  // The build has no commit stamped in, and guessing one would be worse than
  // saying so. `null` renders as "unknown build" in the report.
  return null;
}

function detectBuildKind(): string {
  const port = location.port;
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    if (port === '5173' || port === '8901' || port === '8902') return port === '8901' ? 'preview' : 'dev';
    return location.hostname.includes('github.io') ? 'deployed' : 'unknown';
  }
  return 'unknown';
}

// ---------- partial-run persistence ----------

interface PartialState { at: string; mode: Mode; state: BenchState; options: Omit<RunOptions, 'onUpdate'> }

function savePartial(state: BenchState, opts: RunOptions): void {
  try {
    const payload: PartialState = {
      at: new Date().toISOString(), mode: opts.mode, state,
      options: {
        mode: opts.mode, suites: opts.suites, includeHardware: opts.includeHardware,
        cold: opts.cold, hostLabel: opts.hostLabel ?? null, verboseLog: opts.verboseLog,
      },
    };
    localStorage.setItem(STORE_KEY, JSON.stringify(payload));
  } catch {
    /* private mode / quota: a partial run is a convenience, never a requirement */
  }
}

export function loadPartial(): PartialState | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PartialState;
  } catch {
    return null;
  }
}

export function clearPartial(): void {
  try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
}