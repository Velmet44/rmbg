// Stage 0 measurement rig — step-wise driver with logging + timeouts.
//
// Serves this directory over localhost, drives it with the Playwright CLI
// browser, and writes results JSON + mask PNGs for human rating.
//
// Fully local: the page downloads model bytes into its own browser cache
// and segments local fixture files. No image ever leaves the machine.
//
// Why step-wise: each phase (open / init / infer) runs as its own CLI call
// with its own timeout, so a hang is reported as TIMEOUT on that step
// instead of silence. Page-side progress is also visible via `progress`.
//
// Usage:
//   $env:PLAYWRIGHT_CLI_SESSION='rmbg'
//   npm run measure --workspace @rmbg/harness -- --model=onnx-community/BiRefNet_lite-ONNX --device=webgpu --headed=1
//   Options: --port=8902 --warmups=2 --initTimeoutMs=1800000 --inferTimeoutMs=1800000

import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')),
);
const MODEL = args.model || 'onnx-community/BiRefNet_lite-ONNX';
const DEVICE = args.device || 'webgpu';
const PORT = Number(args.port || 8902);
const HEADED = args.headed === '1' || args.headed === 'true';
const WARMUPS = Number(args.warmups ?? 2);
const INFER_SIZE = Number(args.inferSize ?? 0);
const INIT_TIMEOUT = Number(args.initTimeoutMs ?? 30 * 60 * 1000);
const INFER_TIMEOUT = Number(args.inferTimeoutMs ?? 30 * 60 * 1000);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json' };
const stamp = () => new Date().toISOString().slice(11, 19);
const say = (m) => console.log(`[${stamp()}] ${m}`);

function serve() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://x');
        const p = join(root, decodeURIComponent(url.pathname === '/' ? '/page.html' : url.pathname));
        const data = await readFile(p);
        res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' });
        res.end(data);
      } catch {
        res.writeHead(404); res.end('nf');
      }
    });
    server.on('error', async (e) => {
      if (e.code === 'EADDRINUSE') {
        // Another harness server may already hold the port (e.g. a manual
        // probe server). Verify it serves OUR page, then share it.
        try {
          const r = await fetch(`http://localhost:${PORT}/page.html`);
          const t = await r.text();
          if (r.ok && t.includes('__rmbgHarness')) {
            say(`port ${PORT} busy but serves our harness page — sharing it`);
            resolve(null);
            return;
          }
        } catch {}
      }
      say('FATAL: cannot serve harness page: ' + (e.code || e.message));
      process.exit(1);
    });
    server.listen(PORT, () => resolve(server));
  });
}

/** Run one CLI call with a hard timeout. Never hangs silently. */
function cli(step, timeoutMs, ...a) {
  say(`>> ${step} (timeout ${Math.round(timeoutMs / 1000)}s)`);
  const t0 = Date.now();
  const r = spawnSync('npx', ['--package', '@playwright/cli@latest', 'playwright-cli', ...a], {
    encoding: 'utf8', shell: true, timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024,
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.error) {
    say(`!! ${step} FAILED after ${dt}s: ${r.error.code || r.error.message}`);
    return { ok: false, output: '', error: r.error.code || String(r.error.message) };
  }
  say(`<< ${step} done in ${dt}s`);
  return { ok: true, output: (r.stdout || '') + (r.stderr || '') };
}

/** Extract the JSON value printed by `eval` (between ### Result and ### Ran). */
function extractJson(output) {
  const start = output.indexOf('### Result');
  const seg = (start >= 0 ? output.slice(start) : output).split('### Ran')[0];
  const m = seg.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON object in output');
  return JSON.parse(m[0]);
}

const fixtures = readdirSync(join(root, 'fixtures')).filter((f) => /\.(jpe?g|png)$/i.test(f));
if (fixtures.length === 0) {
  console.error('No fixtures in benchmarks/harness/fixtures/. See fixtures/README.md.');
  process.exit(1);
}

const server = await serve();
say(`harness server on :${PORT}`);

let r = cli('open page', 120000, 'open', ...(HEADED ? ['--headed'] : []), `http://localhost:${PORT}/page.html`);
if (!r.ok) { console.error('FATAL: cannot open page'); process.exit(1); }

const outDir = join(root, 'results', MODEL.replace('/', '_'), DEVICE);
mkdirSync(outDir, { recursive: true });
const summary = { model: MODEL, requestedDevice: DEVICE, at: new Date().toISOString(), runs: [] };

// Init once per model (cached session reused across fixtures).
r = cli('init model', INIT_TIMEOUT, 'eval', `__rmbgHarness.init({modelId:'${MODEL}',device:'${DEVICE}'})`);
if (!r.ok) {
  summary.fatal = 'init TIMEOUT/failed: ' + r.error;
} else {
  let initInfo;
  try {
    initInfo = extractJson(r.output);
  } catch (e) {
    summary.fatal = 'init result unparseable';
    writeFileSync(join(outDir, 'init.raw.txt'), r.output);
  }
  if (initInfo) {
    say(`init: ${initInfo.key} in ${(initInfo.initMs / 1000).toFixed(1)}s (dl ${(initInfo.downloadMs / 1000).toFixed(1)}s + session ${(initInfo.sessionMs / 1000).toFixed(1)}s), ${(initInfo.bytes.total / 1048576).toFixed(1)}MB [${initInfo.note}]`);
    summary.init = initInfo;

    for (const f of fixtures) {
      say(`--- ${f} ---`);
      const imageUrl = `http://localhost:${PORT}/fixtures/${encodeURIComponent(f)}`;
      const times = [];
      let last = null, failed = null;
      for (let i = 0; i <= WARMUPS; i++) {
        r = cli(`infer ${f} pass ${i}`, INFER_TIMEOUT, 'eval', `__rmbgHarness.infer({imageUrl:'${imageUrl}'${INFER_SIZE ? `,maxSide:${INFER_SIZE}` : ''}})`);
        if (!r.ok) { failed = `pass ${i} TIMEOUT/failed: ` + r.error; break; }
        try {
          last = extractJson(r.output);
          times.push(last.inferMs);
          say(`${f} pass ${i}: ${(last.inferMs / 1000).toFixed(1)}s`);
        } catch (e) {
          failed = `pass ${i} unparseable result`;
          writeFileSync(join(outDir, f + `.pass${i}.raw.txt`), r.output);
          break;
        }
      }
      if (failed) {
        summary.runs.push({ fixture: f, failed });
        say(`!! ${f}: ${failed}`);
        continue;
      }
      const { maskPng, ...meta } = last;
      if (maskPng) writeFileSync(join(outDir, f + '.mask.png'), Buffer.from(maskPng.split(',')[1], 'base64'));
      summary.runs.push({ fixture: f, coldInferMs: times[0], warmInferMs: times.slice(1), ...meta });
    }
  }
}

writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
say('wrote ' + join(outDir, 'summary.json'));
if (server) server.close();
if (summary.fatal) process.exit(1);
