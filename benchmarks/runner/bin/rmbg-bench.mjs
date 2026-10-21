#!/usr/bin/env node
// RMBG benchmark CLI.
//
//   rmbg-bench validate [file...]   check reports against the schema, the
//                                  derived-statistics rule and the privacy scan
//   rmbg-bench accept <file>        validate, then copy into results/accepted
//   rmbg-bench summary              regenerate SUMMARY.md + the README block
//   rmbg-bench corpus               print corpus coverage (what is and is not
//                                  measured)
//   rmbg-bench serve [--port]       serve the built app so bench.html can run
//   rmbg-bench browser --mode=...   drive bench.html headlessly and save the
//                                  report (maintainer path; needs the CLI)
//
// No dependencies. Every number it prints comes from the same statistics module
// the browser runner used to measure.

import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { extname, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReport } from '../../lib/validate.mjs';
import { loadAccepted, updateReadme, writeSummary } from '../../lib/summary.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const DIST = join(ROOT, 'packages/app/dist');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.map': 'application/json',
};

const args = process.argv.slice(2);
const cmd = args[0] ?? 'help';
const flags = Object.fromEntries(
  args.filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? '1'];
  }),
);
const rest = args.slice(1).filter((a) => !a.startsWith('--'));

const say = (m) => console.log(m);
const die = (m, code = 1) => { console.error(m); process.exit(code); };

function defaultReports() {
  const dir = join(ROOT, 'benchmarks/results/accepted');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => join(dir, f));
}

async function cmdValidate() {
  const files = rest.length ? rest.map((f) => resolve(process.cwd(), f)) : defaultReports();
  if (!files.length) {
    say('No reports to validate.');
    say('  Validate submitted ones:  rmbg-bench validate path/to/report.json');
    say('  Accepted reports live in: benchmarks/results/accepted/');
    return;
  }
  let failed = 0;
  for (const f of files) {
    let report;
    try {
      report = JSON.parse(await readFile(f, 'utf8'));
    } catch (e) {
      console.error(`✗ ${f}: not JSON — ${e.message}`);
      failed++;
      continue;
    }
    const { ok, errors } = await validateReport(report);
    if (ok) {
      const m = report.cases.reduce((t, c) => t + c.measurements.length, 0);
      say(`✓ ${f} — ${report.cases.length} cases, ${m} measurements, ${report.run.mode}, ${report.run.completed ? 'complete' : 'partial'}`);
    } else {
      failed++;
      console.error(`✗ ${f} — ${errors.length} problem(s):`);
      for (const e of errors.slice(0, 20)) console.error(`    ${e}`);
    }
  }
  if (failed) die(`${failed} report(s) failed validation.`);
}

async function cmdAccept() {
  if (!rest.length) die('usage: rmbg-bench accept <report.json> [...]');
  const dir = join(ROOT, 'benchmarks/results/accepted');
  await mkdir(dir, { recursive: true });
  for (const f of rest) {
    const src = resolve(process.cwd(), f);
    const report = JSON.parse(await readFile(src, 'utf8'));
    const { ok, errors } = await validateReport(report);
    if (!ok) {
      console.error(`✗ refusing to accept ${f}:`);
      for (const e of errors.slice(0, 20)) console.error(`    ${e}`);
      die('Fix the report or do not submit it.');
    }
    // Filename carries the environment, not the reporter: `run.id` is random and
    // proves nothing, and a name that identifies a person must not reach git.
    const env = report.environment;
    const at = report.run.startedAt.slice(0, 16).replace(/[:T]/g, '-');
    const name = `${at}-${env.os.name}-${env.browser.name}-${report.run.mode}.json`;
    await copyFile(src, join(dir, name));
    say(`✓ accepted → benchmarks/results/accepted/${name}`);
  }
}

async function cmdSummary() {
  const { reports, rejected } = await loadAccepted(ROOT);
  if (rejected.length) {
    say(`${rejected.length} accepted-folder file(s) failed validation and were excluded:`);
    for (const r of rejected) say(`  · ${r.file}: ${r.why}`);
  }
  const target = await writeSummary(ROOT, reports, rejected);
  say(`✓ wrote ${target.replace(ROOT + '\\', '')} from ${reports.length} report(s)`);
  const readme = await updateReadme(ROOT, reports);
  say(readme ? `✓ updated the README benchmark block` : '! README has no bench markers — add <!-- bench:start --> / <!-- bench:end -->');
}

async function cmdCorpus() {
  const src = await readFile(join(ROOT, 'packages/app/src/bench/corpus.ts'), 'utf8');
  const ids = [...src.matchAll(/S\('([a-z0-9-]+)'/g)].map((m) => m[1]);
  say('Synthetic corpus cases (exact-by-construction ground truth):');
  for (const id of ids) say(`  · ${id}`);
  const cover = await readFile(join(ROOT, 'benchmarks/corpus/README.md'), 'utf8').catch(() => null);
  if (cover) say('\nSee benchmarks/corpus/README.md for the photo-corpus gap.');
}

async function cmdServe() {
  const port = Number(flags.port ?? 8903);
  if (!existsSync(DIST)) die('No build found. Run: npm run build --workspace @rmbg/app');
  const server = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/') p = '/index.html';
      const file = join(DIST, p);
      if (existsSync(file) && (await stat(file)).isDirectory()) throw new Error('dir');
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(await readFile(file));
    } catch {
      res.writeHead(404); res.end('not found');
    }
  });
  server.listen(port, () => {
    say(`serving packages/app/dist on http://localhost:${port}`);
    say(`benchmark runner:  http://localhost:${port}/bench.html`);
  });
}

/** Drive bench.html with the Playwright CLI and save the report.
 *
 *  The PAGE does the measuring; this command only supplies a browser and pulls
 *  the finished report out through localStorage. That channel was chosen
 *  deliberately: a full report is far larger than a terminal buffer, and
 *  base64 has no quotes or newlines for a shell to mangle on the way. */
async function cmdBrowser() {
  const mode = flags.mode ?? 'quick';
  const suites = flags.suites ? flags.suites.split(',') : null;
  const port = Number(flags.port ?? 8904);
  const out = flags.out ?? join(ROOT, 'benchmarks/results', `local-${mode}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`);
  if (!existsSync(DIST)) die('No build found. Run: npm run build --workspace @rmbg/app');

  const server = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/') p = '/index.html';
      const file = join(DIST, p);
      if (!existsSync(file)) throw new Error('nf');
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(await readFile(file));
    } catch {
      res.writeHead(404); res.end('nf');
    }
  });
  await new Promise((r) => server.listen(port, r));
  say(`serving dist on :${port}`);

  const env = { ...process.env, PLAYWRIGHT_CLI_SESSION: flags.session ?? 'rmbg-bench' };
  // Argument passing: pass the argv ARRAY with `shell: true` and let Node quote
// it. Hand-rolling a quoted command string (tried first) is what broke this
// driver — it produced commands the CLI could not parse, which surfaced as
// "the session never became ready". Passing `.cmd` shims with `shell: false`
// fails with EINVAL on modern Node, so `shell: true` is required.
const NPX = process.platform === 'win32' ? 'npx' : 'npx';

/** `cli('eval', 'expr', { timeout })` — the trailing options object is optional.
 *  Declared over `...args` because a rest parameter cannot be followed by
 *  another formal parameter. */
const cli = (...args) => {
    const last = args[args.length - 1];
    const opts = last && typeof last === 'object' ? args.pop() : {};
    const a = args;
    const r = spawnSync(NPX, ['--package', '@playwright/cli@0.1.22', 'playwright-cli', ...a], {
      encoding: 'utf8', shell: true, env,
      // Deliberately NOT windowsHide: with it set, every `eval` in this
      // environment returned no output at all and was killed by its timeout.
      // Generous for `open`, which pays for npx resolution and a cold browser
      // launch; shorter for polling, where a slow answer is a broken answer.
      timeout: opts.timeout ?? Number(flags.timeout ?? 180000),
      maxBuffer: 512 * 1024 * 1024,
    });
    if (!r.stdout && !r.stderr && r.error) {
      say(`  ! ${a[0]} failed: ${r.error.code || r.error.message}`);
    }
    return r;
  };

  const url = `http://localhost:${port}/bench.html`;
  say(`opening ${url}`);
  const opened = cli('open', url);
  if (!/opened with pid|Browser opened|### Page/i.test(opened.stdout ?? '')) {
    server.close();
    die(`could not open the page (status ${opened.status}):\n`
      + `${opened.stdout ?? ''}${opened.stderr ?? ''}`.replace(/\s+/g, ' ').slice(0, 400));
  }

  // The session is not attachable the instant `open` returns. Probing with a
  // trivial eval until it answers avoids handing the first real command to a
  // session that is still coming up, which otherwise blocks until the timeout.
  // `open` returning does not mean the session can take a command: this CLI
  // launches through a session daemon, and on a machine where the daemon is
  // unhealthy, wedged, or has accumulated stale sessions, `eval` never answers
  // and is killed by its timeout with no output at all. Probe before doing any
  // real work so that failure is reported as what it is.
let ready = false;
  for (let i = 0; i < 4; i++) {
    const probe = cli('eval', 'String(1+1)', { timeout: 90000 });
    if (/"2"/.test(probe.stdout ?? '')) { ready = true; break; }
  }
  if (!ready) {
    server.close();
    say('');
    say('The Playwright CLI session could not run a command.');
    say('');
    say('This does NOT block benchmarking — the page works on its own:');
    say('');
    say('  1. Serve the build:   npm run bench:serve');
    say('  2. Open               http://localhost:8903/bench.html');
    say('  3. Press "Run benchmark", then "Download report (JSON)".');
    say('  4. File it:           npm run bench:accept -- <downloaded.json>');
    say('');
    say('If stale browser sessions are the cause, close them with');
    say('  npx @playwright/cli@0.1.22 playwright-cli -s=<session> close');
    say('and retry with --session=<a fresh name>.');
    die('headless driver unavailable', 2);
  }
  say('session ready');

  const suiteArg = suites ? `,suites:${JSON.stringify(suites)}` : '';
  say(`starting mode=${mode}${suites ? ` suites=${suites.join(',')}` : ''} — this can take minutes`);
  // `auto()` returns immediately (it must not block this command for the whole
  // run), so it is a plain string and must NOT be chained.
  const start = cli('eval', `window.__rmbgBench.auto({mode:'${mode}'${suiteArg}})`);
  if (!/started/.test(start.stdout ?? '')) {
    server.close();
    die(`the page refused to start the run (status ${start.status}):\n`
      + `${start.stdout ?? ''}${start.stderr ?? ''}`.replace(/\s+/g, ' ').slice(0, 500));
  }

  const deadline = Date.now() + Number(flags.deadline ?? 3600000);
  let last = '';
  while (Date.now() < deadline) {
    const r = cli('eval', 'JSON.stringify(window.__rmbgBenchAuto||{status:"running"})', { timeout: 45000 });
    let s;
    try { s = JSON.parse(parseResult(r.stdout)); } catch { s = { status: 'unknown', cases: 0, current: '', error: null }; }
    if (s.current && s.current !== last) { last = s.current; say(`  … ${s.current} (${s.cases} cases done)`); }
    if (s.status === 'done') { say('run finished'); break; }
    if (s.status === 'error') { server.close(); die(`the page reported: ${s.error}`); }
    await new Promise((r2) => setTimeout(r2, 3000));
  }

  const got = cli('localstorage-get', 'rmbg-bench-report-b64');
  const b64 = extractBase64(got.stdout ?? '');
  if (!b64) {
    server.close();
    die(`could not read the report from the page.\n${(got.stdout ?? got.stderr ?? '').slice(0, 400)}`);
  }
  const json = Buffer.from(b64, 'base64').toString('utf8');
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, json, 'utf8');
  const report = JSON.parse(json);
  const { ok, errors } = await validateReport(report);
  say(`${ok ? '✓ valid' : '✗ INVALID'} → ${out} (${report.cases.length} cases)`);
  if (!ok) for (const e of errors.slice(0, 10)) say(`    ${e}`);
  cli('close');
  server.close();
  if (!ok) process.exit(1);
}

/** Pull a value out of the CLI's `### Result … ### Ran` envelope. Commands
 *  that print a bare value (localstorage-get) have no envelope, so the fallback
 *  is the raw text. */
function parseResult(stdout) {
  const start = stdout.indexOf('### Result');
  const body = start >= 0 ? stdout.slice(start + '### Result'.length) : stdout;
  const end = body.indexOf('### Ran');
  return (end >= 0 ? body.slice(0, end) : body).trim();
}

/** Longest run of base64 in a chunk of CLI output. Used for the report payload,
 *  which arrives as one long unbroken line surrounded by npx notices and,
 *  depending on the command, an envelope. */
function extractBase64(text) {
  const runs = text.match(/[A-Za-z0-9+/=]{200,}/g) ?? [];
  return runs.sort((a, b) => b.length - a.length)[0] ?? '';
}

function help() {
  say(`rmbg-bench <command>

  validate [file...]   check reports against the schema, the statistics rule
                       and the privacy scan (defaults to results/accepted/*)
  accept <file...>     validate, then copy into benchmarks/results/accepted/
  summary              regenerate benchmarks/SUMMARY.md and the README block
  corpus               print the synthetic corpus and point at the gap doc
  serve [--port=8903]  serve the built app (run after npm run build)
  browser --mode=quick drive bench.html through the Playwright CLI
  help                 this text`);
}

switch (cmd) {
  case 'validate': await cmdValidate(); break;
  case 'accept': await cmdAccept(); break;
  case 'summary': await cmdSummary(); break;
  case 'corpus': await cmdCorpus(); break;
  case 'serve': await cmdServe(); break;
  case 'browser': await cmdBrowser(); break;
  case 'help': case '--help': case '-h': help(); break;
  default: help(); die(`unknown command: ${cmd}`, 2);
}