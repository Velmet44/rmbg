// Statistics for benchmark samples. ONE implementation, imported by both the
// browser runner (benchmarks) and the Node validator/aggregator (CLI), so a
// number in the README is computed by the same code that measured it.
//
// Plain ESM with no dependencies on purpose: it must run in a browser bundle,
// in Node, and inside a `node --experimental-*` free script alike.
//
// Percentile method: linear interpolation between order statistics (the "type 7"
// / NumPy default). Documented in benchmarks/README.md so the numbers are
// reproducible rather than merely plausible.

/** @param {number[]} xs @param {number} q 0..1 */
export function quantile(xs, q) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const pos = (s.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export function median(xs) {
  return quantile(xs, 0.5);
}

export function mean(xs) {
  if (!xs.length) return null;
  let t = 0;
  for (const x of xs) t += x;
  return t / xs.length;
}

/**
 * Samples below this count do not support a tail percentile. A p95 over 3
 * samples is the 2nd-worst of 3 and reads as a hard bound it is not, so the
 * README and the validator treat it as "no tail".
 */
export const TAIL_MIN_SAMPLES = 20;

/** Is a p95 over n samples meaningful enough to publish? */
export function hasReliableTail(n) {
  return n >= TAIL_MIN_SAMPLES;
}

export function round(x, digits = 4) {
  if (x === null || x === undefined || !Number.isFinite(x)) return null;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

/**
 * Summarise raw samples. This is a DERIVED value: the report stores raw
 * samples and the validator recomputes this, so a hand-edited stats block is
 * caught instead of being published.
 *
 * @param {number[]} xs
 */
export function summarize(xs) {
  const clean = xs.filter((x) => typeof x === 'number' && Number.isFinite(x));
  const n = clean.length;
  if (n === 0) return null;
  const q1 = quantile(clean, 0.25);
  const q3 = quantile(clean, 0.75);
  const m = median(clean);
  const avg = mean(clean);
  const variance = n > 1 ? clean.reduce((t, x) => t + (x - avg) ** 2, 0) / (n - 1) : 0;
  return {
    n,
    min: round(Math.min(...clean)),
    median: round(m),
    // p95 stays null below TAIL_MIN_SAMPLES rather than publishing a number
    // that one outlier can define.
    p95: hasReliableTail(n) ? round(quantile(clean, 0.95)) : null,
    max: round(Math.max(...clean)),
    iqr: round(q3 - q1),
    mean: round(avg),
    stdev: round(Math.sqrt(variance)),
  };
}

/** Human-readable duration for log lines and tables. */
export function fmtMs(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1) return `${round(ms, 2)}ms`;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${round(ms / 1000, 2)}s`;
}

export function fmtBytes(b) {
  if (b === null || b === undefined || !Number.isFinite(b)) return '—';
  if (b < 1024) return `${b}B`;
  if (b < 1048576) return `${round(b / 1024, 1)}KB`;
  return `${round(b / 1048576, 2)}MB`;
}

export function fmtCount(n) {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e6) return `${round(n / 1e6, 2)}M`;
  if (n >= 1e3) return `${round(n / 1e3, 1)}k`;
  return String(Math.round(n));
}

/** Ratio guard used everywhere a "throughput" number could divide by zero. */
export function safeDiv(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return round(a / b, 4);
}