// Page wiring for the benchmark runner. All the measurement logic lives in the
// suites; this file is the UI around them: pick, run, review, download.

import {
  MODES, SUITES, cancelRun, clearPartial, loadPartial, runBenchmark,
  type BenchState,
} from './main';
import type { Mode, Report } from './types';
import { fmtBytes, fmtMs, summarize } from '../../../../benchmarks/lib/stats.mjs';
import { validateReport } from './validate-client';

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector(sel) as T;

let mode: Mode = 'quick';
const chosen = new Set<string>(['engine', 'ingest', 'display', 'export', 'batch', 'reliability']);
let running = false;
let lastReport: Report | null = null;
let ticker: number | null = null;

function renderModes(): void {
  const host = $('#modes');
  host.innerHTML = '';
  for (const m of MODES) {
    const el = document.createElement('div');
    el.className = `mode${m.id === mode ? ' on' : ''}`;
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.innerHTML = `<div class="t">${m.label}</div><div class="m">${m.blurb}</div>`
      + `<div class="m" style="margin-top:5px">${m.needsModel ? '⚠ may download the model' : 'no download'}</div>`
      + `<div class="w">${m.minutes}</div>`;
    const pick = () => { mode = m.id; renderModes(); renderSuites(); };
    el.onclick = pick;
    el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } };
    host.appendChild(el);
  }
  const active = MODES.find((m) => m.id === mode)!;
  $('#modeNote').innerHTML = active.needsModel
    ? 'This mode runs the real model in a worker. First run downloads the weights; afterwards they come from cache.'
    : 'This mode never touches the model, so it works offline and takes about a minute.';
  ($('#coldRow') as HTMLElement).style.display = active.needsModel ? '' : 'none';
  ($('#optCold') as HTMLInputElement).checked = false;
}

function renderSuites(): void {
  const host = $('#suites');
  host.innerHTML = '';
  const modelSuite = SUITES.find((s) => s.needsModel);
  for (const s of SUITES) {
    const blocked = mode === 'quick' && s.needsModel;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !blocked && chosen.has(s.id);
    input.disabled = blocked;
    const label = document.createElement('label');
    label.className = 'opt';
    label.style.opacity = blocked ? '.45' : '1';
    label.appendChild(input);
    const text = document.createElement('span');
    text.innerHTML = `<strong>${s.label}</strong>${blocked ? ' <span class="pill">needs the model</span>' : ''}`
      + `<span class="d">${s.blurb}</span>`;
    label.appendChild(text);
    input.onchange = () => {
      if (input.checked) chosen.add(s.id); else chosen.delete(s.id);
    };
    host.appendChild(label);
  }
  void modelSuite;
}

function setRunning(on: boolean): void {
  running = on;
  ($('#btnRun') as HTMLButtonElement).disabled = on;
  ($('#btnCancel') as HTMLButtonElement).disabled = !on;
}

function startTicker(): void {
  stopTicker();
  const t0 = Date.now();
  ticker = window.setInterval(() => {
    $('#statTime').textContent = `${((Date.now() - t0) / 1000).toFixed(0)}s`;
  }, 250);
}
function stopTicker(): void {
  if (ticker !== null) { clearInterval(ticker); ticker = null; }
}

function applyState(s: BenchState): void {
  const log = $('#log');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.textContent = s.log.length ? s.log.join('\n') : 'Ready. Nothing has run yet.';
  if (atBottom) log.scrollTop = log.scrollHeight;
  $('#statDone').textContent = String(s.completed);
  $('#statCur').textContent = s.current || '—';
  if (s.phase === 'running' && s.completed > 0) {
    // Bars need a denominator; the honest one is the count of cases the
    // selected suites plan to produce, which is not known ahead of time, so
    // this is a progress indicator and not a percentage claim.
    const est = Math.max(s.completed, 1);
    ($('#bar') as HTMLElement).style.width = `${Math.min(92, 92 * (s.completed / Math.max(est, s.completed + 12)))}%`;
  }
}

async function run(): Promise<void> {
  if (running) return;
  setRunning(true);
  applyState({ phase: 'running', current: '', completed: 0, total: 0, log: [], report: null });
  startTicker();
  try {
    const report = await runBenchmark({
      mode,
      suites: [...chosen],
      includeHardware: ($('#optHardware') as HTMLInputElement).checked,
      cold: ($('#optCold') as HTMLInputElement).checked,
      hostLabel: ($('#hostLabel') as HTMLInputElement).value.trim() || null,
      verboseLog: ($('#optVerbose') as HTMLInputElement).checked,
      onUpdate: applyState,
    });
    lastReport = report;
    showReport(report);
  } catch (e) {
    $('#log').textContent += `\nRUNNER ERROR: ${String(e)}`;
  } finally {
    stopTicker();
    ($('#bar') as HTMLElement).style.width = '100%';
    setRunning(false);
  }
}

function showReport(r: Report): void {
  $('#resultCard').style.display = '';
  const c = r.cases;
  const failed = c.filter((k) => k.failed);
  const skipped = c.filter((k) => k.skipped);
  const measurements = c.reduce((t, k) => t + k.measurements.length, 0);
  const ok = c.filter((k) => k.derived && 'passed' in k.derived && k.derived.passed === true).length;
  const okTotal = c.filter((k) => k.derived && 'passed' in k.derived).length;
  $('#resultStats').innerHTML = `
    <div>cases<b>${c.length}</b></div>
    <div>measurements<b>${measurements}</b></div>
    <div>failed<b class="${failed.length ? 'bad' : 'ok'}">${failed.length}</b></div>
    <div>skipped<b class="skip">${skipped.length}</b></div>
    <div>reliability checks passed<b class="${ok === okTotal ? 'ok' : 'warn'}">${ok}/${okTotal}</b></div>
    <div>duration<b>${fmtMs(r.run.durationMs)}</b></div>`;

  const headline = c
    .filter((k) => !k.skipped && k.measurements.some((m) => m.name === 'roundTripMs' || m.name === 'compositeMs' || m.name === 'strokeMs'))
    .slice(0, 12);
  const rows = headline.map((k) => {
    const ms = k.measurements.find((m) => m.name === 'roundTripMs' || m.name === 'compositeMs' || m.name === 'strokeMs');
    return `<tr><td class="mono">${k.id}</td><td class="num">${ms?.stats ? fmtMs(ms.stats.median) : '—'}</td>`
      + `<td class="num">${ms?.stats?.n ?? 0}</td></tr>`;
  }).join('');
  $('#summaryTable').innerHTML = headline.length
    ? `<table><thead><tr><th>case</th><th style="text-align:right">median</th><th style="text-align:right">n</th></tr></thead><tbody>${rows}</tbody></table>`
    : '';

  $('#jsonPreview').textContent = JSON.stringify(r, null, 1).slice(0, 40000);
}

function download(): void {
  if (!lastReport) return;
  const json = JSON.stringify(lastReport, null, 2);
  const at = new Date(lastReport.run.startedAt);
  const stamp = `${at.getFullYear()}${String(at.getMonth() + 1).padStart(2, '0')}${String(at.getDate()).padStart(2, '0')}`
    + `-${String(at.getHours()).padStart(2, '0')}${String(at.getMinutes()).padStart(2, '0')}`;
  const env = lastReport.environment;
  const name = `rmbg-bench-${lastReport.run.mode}-${env.os.name}-${env.browser.name}-${stamp}.json`;
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  $('#validateOut').textContent = `Saved as ${name} (${fmtBytes(blob.size)}).`;
}

async function selfValidate(): Promise<void> {
  if (!lastReport) return;
  const out = $('#validateOut');
  out.textContent = 'Checking…';
  const { ok, errors } = await validateReport(lastReport);
  if (ok) {
    const bytes = lastReport.cases.reduce((t, k) => t + k.measurements.length, 0);
    out.innerHTML = `<span class="ok">✓ Valid.</span> Schema, derived-statistics integrity and the privacy scan all pass. `
      + `${lastReport.cases.length} cases, ${bytes} measurements.`;
  } else {
    out.innerHTML = `<span class="bad">✗ ${errors.length} problem(s) — this report should not be submitted:</span><br />`
      + errors.slice(0, 10).map((e) => `· ${e}`).join('<br />');
  }
}

async function copyJson(): Promise<void> {
  if (!lastReport) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(lastReport, null, 2));
    $('#validateOut').textContent = 'Copied to the clipboard.';
  } catch {
    $('#validateOut').textContent = 'Clipboard blocked by the browser — use Download instead.';
  }
}

function initPartialNotice(): void {
  const p = loadPartial();
  if (!p) return;
  const when = new Date(p.at);
  $('#partialNote').innerHTML = `A partial run from ${when.toLocaleString()} (${p.state.completed} cases) is saved in this browser. `
    + `Nothing was sent anywhere. Re-run to start a fresh report, or dismiss it.`;
  $('#btnClear').style.display = '';
}

// --- boot ---
renderModes();
renderSuites();
initPartialNotice();
$('#btnRun').onclick = () => void run();
$('#btnCancel').onclick = () => { cancelRun(); $('#log').textContent += '\nCancelling — the current case will finish first.'; };
$('#btnClear').onclick = () => { clearPartial(); $('#partialNote').textContent = 'Saved partial run dismissed.'; $('#btnClear').style.display = 'none'; };
$('#btnDownload').onclick = download;
$('#btnCopy').onclick = () => void copyJson();
$('#btnValidate').onclick = () => void selfValidate();
($('#optLabel') as HTMLInputElement).onchange = (e) => {
  ($('#labelRow') as HTMLElement).style.display = (e.target as HTMLInputElement).checked ? '' : 'none';
};

// Expose the reporter for the automated runner (benchmarks/runner), which drives
// this same page rather than reimplementing it. `auto` starts a run in the
// background and hands the report back through localStorage, because a full
// report is far too large to pass back through a terminal buffer reliably.
const AUTO_KEY = 'rmbg-bench-report-b64';

const api = {
  run: (opts: Partial<Parameters<typeof runBenchmark>[0]>) => runBenchmark({
    mode: (opts?.mode ?? 'quick') as Mode,
    suites: opts?.suites ?? [...chosen],
    includeHardware: opts?.includeHardware ?? false,
    cold: opts?.cold ?? false,
    hostLabel: opts?.hostLabel ?? null,
    verboseLog: false,
    onUpdate: () => {},
  }),
  /** Start a run and return IMMEDIATELY, for a driver that polls for state.
   *
   *  This must not return the run's promise: the driver evaluates it through a
   *  terminal command with its own timeout, so awaiting here would block that
   *  command for the whole run and get the browser killed mid-measurement. */
  auto: (opts: { mode?: Mode; suites?: string[]; includeHardware?: boolean; cold?: boolean } = {}) => {
    const state = { status: 'running', cases: 0, current: '', error: null as string | null };
    (window as unknown as Record<string, unknown>).__rmbgBenchAuto = state;
    void (async () => {
      try {
        const report = await runBenchmark({
          mode: (opts.mode ?? 'quick') as Mode,
          suites: opts.suites ?? [...chosen],
          includeHardware: opts.includeHardware ?? false,
          cold: opts.cold ?? false,
          hostLabel: null,
          verboseLog: false,
          onUpdate: (s) => { state.cases = s.completed; state.current = s.current; },
        });
        lastReport = report;
        showReport(report);
        // base64 so the payload has no quotes, newlines or backslashes for a
        // terminal to mangle on the way out.
        const bytes = new TextEncoder().encode(JSON.stringify(report));
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        localStorage.setItem(AUTO_KEY, btoa(bin));
        state.status = 'done';
      } catch (e) {
        state.status = 'error';
        state.error = String(e).slice(0, 200);
      }
    })();
    return 'started';
  },
  cancel: cancelRun,
  key: AUTO_KEY,
  summarize,
};
(window as unknown as Record<string, unknown>).__rmbgBench = api;