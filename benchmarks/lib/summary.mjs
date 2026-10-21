// Cohort aggregation + the generated README snapshot.
//
// The rule that shapes everything here: numbers are NEVER pooled across
// backends, cache states or modes. A WebGPU warm pass and a WASM cold pass on
// different browsers are different experiments; averaging them produces a
// number that describes nothing. Every row states its cohort.
//
// Cohort statistic: the MEDIAN OF PER-RUN MEDIANS. Pooling raw samples would
// let one machine that ran 50 iterations define a cohort of five people.
// Each report contributes one observation (its own median), so every machine
// weighs the same, and `reports` is visible next to the number.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { summarize, fmtMs, fmtBytes, fmtCount } from './stats.mjs';
import { validateReport } from './validate.mjs';

export const ACCEPTED_DIR = 'benchmarks/results/accepted';
const START = '<!-- bench:start -->';
const END = '<!-- bench:end -->';

export async function loadAccepted(root, { validate = true } = {}) {
  const dir = join(root, ACCEPTED_DIR);
  if (!existsSync(dir)) return { reports: [], rejected: [] };
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  const reports = [];
  const rejected = [];
  for (const f of files) {
    const path = join(dir, f);
    let report;
    try {
      report = JSON.parse(await readFile(path, 'utf8'));
    } catch (e) {
      rejected.push({ file: f, why: `unparseable: ${e.message}` });
      continue;
    }
    if (validate) {
      const { ok, errors } = await validateReport(report);
      if (!ok) { rejected.push({ file: f, why: errors[0] }); continue; }
    }
    report.__file = f;
    reports.push(report);
  }
  return { reports, rejected };
}

/** Cohort label for one case of one report. */
export function cohortOf(report, kase) {
  const l = kase.labels ?? {};
  const parts = [
    l.backend ?? 'no-model',
    l.cache ?? (kase.suite === 'inference' ? 'unknown' : 'n/a'),
    `${report.environment?.browser?.name ?? '?'}`,
  ];
  if (kase.suite === 'inference') parts.push(report.run.mode);
  return parts.join(' · ');
}

function fmtStat(m, stats) {
  if (m.unit === 'ms') return `${fmtMs(stats.median)}${stats.p95 !== null ? ` (p95 ${fmtMs(stats.p95)})` : ''}`;
  if (m.unit === 'B') return `${fmtBytes(stats.median)}${stats.p95 !== null ? ` (p95 ${fmtBytes(stats.p95)})` : ''}`;
  if (m.unit === 'px') return fmtCount(stats.median);
  if (m.unit === 'MPix/s' || m.unit === 'MB/s' || m.unit === 'fps') return `${stats.median}`;
  if (m.unit === 'ratio' || m.unit === 'score') return `${stats.median}`;
  if (m.unit === 'frames' || m.unit === 'count') return fmtCount(stats.median);
  return `${stats.median}`;
}

/** Every (case, measurement) in one report, keyed for grouping. */
function observations(report) {
  const out = [];
  for (const kase of report.cases ?? []) {
    if (kase.skipped) continue;
    for (const m of kase.measurements ?? []) {
      if (m.stats) {
        out.push({ key: `${kase.id}::${m.name}`, unit: m.unit, cohort: cohortOf(report, kase), value: m.stats.median });
      } else if (m.value !== null && m.value !== undefined) {
        out.push({ key: `${kase.id}::${m.name}`, unit: m.unit, cohort: cohortOf(report, kase), value: m.value, isValue: true });
      }
    }
  }
  return out;
}

export function aggregate(reports) {
  const groups = new Map();
  for (const report of reports) {
    for (const obs of observations(report)) {
      const id = `${obs.cohort}||${obs.key}||${obs.unit}`;
      if (!groups.has(id)) {
        groups.set(id, {
          cohort: obs.cohort, caseId: obs.key.split('::')[0], measurement: obs.key.split('::')[1],
          unit: obs.unit, values: [], isValue: obs.isValue ?? false, reports: new Set(),
        });
      }
      const g = groups.get(id);
      g.values.push(obs.value);
      g.reports.add(report.run.id);
    }
  }
  const rows = [];
  for (const g of groups.values()) {
    const stats = summarize(g.values);
    if (!stats) continue;
    rows.push({
      cohort: g.cohort, caseId: g.caseId, measurement: g.measurement, unit: g.unit,
      reports: g.reports.size, samples: g.values.length, stats,
    });
  }
  rows.sort((a, b) => a.cohort.localeCompare(b.cohort) || a.caseId.localeCompare(b.caseId) || a.measurement.localeCompare(b.measurement));
  return rows;
}

function headlineRows(rows, limit = 14) {
  // The README shows a SMALL snapshot. Inference latency is the number a reader
  // actually wants; everything else is one click away in SUMMARY.md.
  const preferred = [
    /^segment\./,
    /^model\.init/,
    /^recompute\./,
    /^engine\.composite\./,
    /^export\.encode\./,
    /^ingest\.decode\./,
  ];
  const picked = [];
  const seen = new Set();
  for (const re of preferred) {
    for (const r of rows) {
      const key = `${r.caseId}|${r.measurement}`;
      if (seen.has(key)) continue;
      if (!re.test(r.caseId)) continue;
      seen.add(key);
      picked.push(r);
      if (picked.length >= limit) return picked;
    }
  }
  for (const r of rows) {
    if (picked.length >= limit) break;
    const key = `${r.caseId}|${r.measurement}`;
    if (!seen.has(key)) { seen.add(key); picked.push(r); }
  }
  return picked;
}

export function renderSummary(reports, { rejected = [] } = {}) {
  const rows = aggregate(reports);
  const now = new Date().toISOString().slice(0, 10);
  const models = new Map();
  for (const r of reports) models.set(r.app.model.revision, r.app.model.id);
  const out = [];
  out.push(`<!-- generated by \`npm run bench:summary\` — do not edit by hand -->`);
  out.push('');
  out.push(`**Generated ${now} from ${reports.length} accepted report(s)**` +
    (rejected.length ? ` · ${rejected.length} rejected` : '') + '.');
  out.push('');
  if (!reports.length) {
    out.push('No accepted reports yet. Run the benchmark in your browser (`npm run bench` → open the page, or visit `/bench.html` on the deployed app) and submit the downloaded JSON.');
    out.push('');
    out.push(acceptedHowto());
    return out.join('\n');
  }
  out.push('Model revisions represented:');
  for (const [rev, id] of models) out.push(`- \`${id}\` @ \`${rev}\``);
  out.push('');
  out.push('## Aggregated measurements');
  out.push('');
  out.push('Median of per-run medians, so each machine weighs once. p95 appears only where a cohort has');
  out.push('enough samples to support a tail. Cohorts are never pooled across backends or cache states.');
  out.push('');
  out.push('| Cohort | Case | Measurement | n reports | Median | Range |');
  out.push('|---|---|---|---:|---|---|');
  for (const r of rows) {
    out.push(`| ${r.cohort} | \`${r.caseId}\` | ${r.measurement} | ${r.reports} | ${fmtStat({ unit: r.unit }, r.stats)} | ${fmtStat({ unit: r.unit }, { ...r.stats, p95: null, median: r.stats.min })}–${fmtStat({ unit: r.unit }, { ...r.stats, p95: null, median: r.stats.max })} |`);
  }
  out.push('');
  out.push('## Cases seen');
  out.push('');
  const bySuite = new Map();
  for (const r of reports) {
    for (const kase of r.cases ?? []) {
      if (!bySuite.has(kase.suite)) bySuite.set(kase.suite, new Set());
      bySuite.get(kase.suite).add(kase.case);
    }
  }
  for (const [suite, cases] of [...bySuite].sort()) {
    out.push(`- **${suite}** — ${[...cases].sort().map((c) => `\`${c}\``).join(', ')}`);
  }
  out.push('');
  out.push(acceptedHowto());
  return out.join('\n');
}

function acceptedHowto() {
  return [
    '## Contributing a report',
    '',
    '1. Open the benchmark page (`npm run bench` locally, or `/bench.html` on the deployed app).',
    '2. Pick a mode and press **Run benchmark**. Quick mode needs no model download.',
    '3. Review the exact JSON in the preview, then download it.',
    '4. Attach it to a GitHub issue titled `Benchmark report`, or open a PR adding it to',
    '   `benchmarks/results/accepted/`.',
    '',
    'Reports contain no image bytes, no file names and no URLs — `npm run bench:validate`',
    'enforces that by scanning every string, and rejects the report if one appears.',
  ].join('\n');
}

/** The compact block embedded in the root README between markers. */
export function renderReadmeBlock(reports) {
  const rows = headlineRows(aggregate(reports));
  const now = new Date().toISOString().slice(0, 10);
  const out = [];
  out.push(START);
  out.push(`<!-- generated by \`npm run bench:summary\` (${now}) — do not edit by hand -->`);
  if (!rows.length) {
    out.push('');
    out.push('_No accepted reports yet._ Run the benchmark on your machine and submit the JSON — see');
    out.push('[benchmarks/README.md](benchmarks/README.md#contributing-a-report).');
  } else {
    out.push('');
    out.push('| What | Cohort | Median | Reports |');
    out.push('|---|---|---|---:|');
    for (const r of rows) {
      out.push(`| \`${r.caseId}\` · ${r.measurement} | ${r.cohort} | ${fmtStat({ unit: r.unit }, r.stats)} | ${r.reports} |`);
    }
    out.push('');
    out.push(`Full table, including quality and reliability cases: [benchmarks/SUMMARY.md](benchmarks/SUMMARY.md) (${now}).`);
  }
  out.push(END);
  return out.join('\n');
}

export async function writeSummary(root, reports, rejected) {
  const target = join(root, 'benchmarks/SUMMARY.md');
  await writeFile(target, renderSummary(reports, { rejected }), 'utf8');
  return target;
}

export async function updateReadme(root, reports) {
  const file = join(root, 'README.md');
  if (!existsSync(file)) return null;
  const text = await readFile(file, 'utf8');
  const block = renderReadmeBlock(reports);
  if (!text.includes(START) || !text.includes(END)) return null;
  const next = `${text.slice(0, text.indexOf(START))}${block}${text.slice(text.indexOf(END) + END.length)}`;
  await writeFile(file, next, 'utf8');
  return file;
}