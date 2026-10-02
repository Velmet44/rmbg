// Verbose console logger. DOM-free so the engine and the worker can use it.
//
// Every line carries a millisecond offset from module load, which is what
// makes it useful for "why is inference slow" questions: the worker has its
// own module instance (and so its own clock), so worker timings are relative to
// the worker rather than to the page — the `main` side stamps the round trip.
//
// Mute without a rebuild:
//   window.__rmbgDebug = false        (one-liner in the console)
//   localStorage.setItem('rmbg-debug','off')
// Both are checked on every call, so no reload is needed.

export type LogLevel = 'debug' | 'info' | 'warn';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30 };

const clock = (): number =>
  (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
const started = clock();

let minLevel: number = ORDER.debug;
let tag = 'RMBG';
const overrides: { value?: boolean } = {};

export function setLogLevel(level: LogLevel): void { minLevel = ORDER[level]; }
export function setLogTag(next: string): void { tag = next; }
export function setLogEnabled(on: boolean): void { overrides.value = on; }

/** Milliseconds since this module loaded. */
export function now(): number { return clock() - started; }

/** localStorage is read on EVERY log call (including inside per-frame
 *  throttled call sites), so cache it and invalidate only via setLogEnabled. */
let storageMute: boolean | null = null;

function muted(): boolean {
  if (overrides.value !== undefined) return !overrides.value;
  // Documented escape hatch: `window.__rmbgDebug = false` (or true) must work.
  // It previously did nothing at all, because nothing ever read the global —
  // leaving per-frame floods unmuteable short of a rebuild.
  const g = (globalThis as { __rmbgDebug?: unknown }).__rmbgDebug;
  if (typeof g === 'boolean') return !g;
  if (storageMute === null) {
    try {
      storageMute = typeof localStorage !== 'undefined'
        && localStorage.getItem('rmbg-debug') === 'off';
    } catch {
      storageMute = false; // private mode / no storage → log
    }
  }
  return storageMute;
}

function stamp(): string {
  return `+${now().toFixed(0).padStart(6)}ms`;
}

export function dbg(scope: string, msg: string, data?: unknown): void {
  if (muted() || ORDER.debug < minLevel) return;
  if (data === undefined) console.log(`${tag} ${stamp()} [${scope}] ${msg}`);
  else console.log(`${tag} ${stamp()} [${scope}] ${msg}`, data);
}

export function dbgWarn(scope: string, msg: string, data?: unknown): void {
  if (muted() || ORDER.warn < minLevel) return;
  if (data === undefined) console.warn(`${tag} ${stamp()} [${scope}] ${msg}`);
  else console.warn(`${tag} ${stamp()} [${scope}] ${msg}`, data);
}

/** Tabular dump for structured state (backend, device probe, export result). */
export function dbgTable(scope: string, msg: string, rows: Record<string, unknown>): void {
  if (muted()) return;
  console.log(`${tag} ${stamp()} [${scope}] ${msg}`);
  console.table(rows);
}

/**
 * For call sites that run per frame (composite, redraw, pointermove) where an
 * unconditional log would flood the console. Emits at most once per `everyMs`
 * per (scope,msg) and reports how many calls it swallowed, so a throttled line
 * still tells you the real call rate.
 */
const lastAt = new Map<string, number>();
const swallowed = new Map<string, number>();

/** Throttle channels are distinct by the SHAPE of their data, not its values:
 *  all numbers share a channel, each string a channel of its own. Bounded by
 *  construction, and stable for the varying payloads that actually stream. */
function throttleKeyOf(data: unknown): string {
  if (data === undefined) return '';
  if (typeof data === 'number') return '#';
  if (Array.isArray(data)) return `a${data.length}`;
  return 'o';
}

export function dbgThrottled(scope: string, msg: string, everyMs = 1000, data?: unknown): void {
  if (muted()) return;
  // Key on a STABLE channel, never on `msg`. A message built from live values
  // (a percentage, a byte count) is a new key on every call, so the throttle
  // never fires AND both maps grow without bound — one permanent entry per
  // progress event. Callers with varying content pass it as `data` instead.
  const key = `${scope}|${throttleKeyOf(data)}`;
  const t = clock();
  const last = lastAt.get(key);
  if (last !== undefined && t - last < everyMs) {
    swallowed.set(key, (swallowed.get(key) ?? 0) + 1);
    return;
  }
  const n = swallowed.get(key) ?? 0;
  lastAt.set(key, t);
  swallowed.set(key, 0);
  dbg(scope, n > 0 ? `${msg} (+${n} in the last ${everyMs}ms)` : msg, data);
}

/** Reset every throttle — call after an event that invalidates the rates. */
export function resetLogThrottle(): void {
  lastAt.clear();
  swallowed.clear();
}
