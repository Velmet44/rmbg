# Benchmarks

Two separate things live here, and conflating them is how the previous attempt
went wrong:

| | What it answers | Reproducible from a fresh clone? |
|---|---|---|
| **The benchmark system** (this directory + `packages/app/src/bench`) | How fast is this machine running RMBG, and does the app behave correctly? | **Yes** — run it |
| **The Stage 0 model gate** (`GATE.md`, `harness/`) | Is the shipped model good enough to ship? | **No** — never has been |

## Run it

Two paths, same measurements.

**In a browser — no install, the intended contributor path.**

```sh
npm run bench
```

That builds the app and serves it; open the printed URL and go to
`/bench.html`. The page also ships with the deployed app, so a contributor can
run it without cloning anything at all. Pick a mode, press **Run benchmark**,
review the JSON, download it, submit it.

**Headless, for maintainers and CI — best effort.**

```sh
npm run build --workspace @rmbg/app
npm run bench:browser -- --mode=quick
```

Drives the same page through the Playwright CLI and writes the report to
`benchmarks/results/`. This is a convenience wrapper around the page, not a
parallel implementation: a bug fixed in the page is fixed for both paths.

**It depends on a healthy `@playwright/cli` session daemon**, and that is not
guaranteed. `open` can return while the session cannot accept a command — the
CLI prints nothing and is killed by its timeout — so the driver probes first and,
if the probe fails, exits 2 with instructions instead of a cryptic error. When
that happens, use the browser path; it produces the identical report through the
**Download** button, which `bench:accept` files. Nothing is lost.

Known sharp edges in that CLI, recorded so they are not rediscovered:

- A `.cmd` shim cannot be spawned without a shell (`EINVAL`), but `shell: true`
  joins argv unquoted, so eval expressions containing spaces get split. Pass the
  **argv array** and let Node quote it; hand-rolling a quoted command string
  produces commands the CLI cannot parse.
- Session selection comes from `PLAYWRIGHT_CLI_SESSION` only. Passing `-s=` to
  `open` makes it print usage and launch nothing.
- Stale sessions accumulate and wedge the daemon. Close them explicitly:
  `npx @playwright/cli@0.1.22 playwright-cli -s=<session> close`.
- `window.__rmbgBench.auto()` must return synchronously. A driver that awaits it
  blocks for the whole run and gets the browser killed mid-measurement.

### Other commands

```sh
npm run bench:validate -- <report.json>   # schema + statistics + privacy scan
npm run bench:accept -- <report.json>     # validate, then file into results/accepted
npm run bench:summary                      # regenerate SUMMARY.md and the README block
npm run bench:corpus                       # what the corpus covers, and what it does not
npm run bench:serve                        # serve dist/ without rebuilding
```

## Modes

| Mode | Suites | Model download | Time |
|---|---|---|---|
| **Quick** | engine, ingest, display, export, batch, reliability | no | ~1 min |
| **Full** | all of the above + model init phases, segmentation, quality scoring, memory matrix | yes (~98 MB) | 5–30 min |
| **Stress** | full + 24/50 MP composites, an allocation-failure probe, the largest corpus | yes | 10–60 min, high memory |

Quick mode is the good first run: it needs no model, works offline, and takes
about a minute. It is also the mode most contributors should submit, because it
is the one every machine can actually complete.

## What is measured

| Suite | Cases | Measurements |
|---|---|---|
| `engine` | brush ×3 brush sizes ×3 image sizes, guided select, feather/defringe/both, composite ×4 background variants, overlay, working-resolution round trip, RGBA pack, mask clone, transform, history | ms at 0.26 / 1.9 / 12 (and 24) MP, plus retained undo bytes and eviction depth |
| `ingest` | decode ×4 formats from real encoded bytes | decode ms vs RGB-pack ms, throughput, decoded and packed dimensions |
| `display` | after / before / mask / overlay, animation-frame coalescing, responsiveness | draw ms, composites per 12 requests, frames observed during full-res work |
| `export` | encode ×4 formats, custom size down- and up-scaling, JPEG-opacity check | composite ms and encode ms separately, output bytes, compression ratio, MPix/s |
| `batch` | CRC-32 vector, ZIP ×3 payload mixes, per-item PNG pipeline, admission arithmetic | zip ms and MB/s, per-item ms, items/minute, accepted item count |
| `reliability` | undecodable input, empty input, size mismatch, truncated RGB, region-grow cap, 0×0 encode, empty ZIP, undo after mask swap, byte-budget eviction, no-op refine, encoder support, export round trip | pass/fail per expectation, plus the rejection latency |
| `memory` | 1.9 / 12 / 24 (and 50) MP allocation and composite, with and without shadow, repeat stability, allocation-failure probe | estimated bytes (labelled), JS heap delta (labelled), where the machine stops |
| `inference` | model init phases, single-flight reuse, segmentation per corpus case, determinism, region recompute at 3 box sizes, dispose/re-init, corpus coverage | init/download/session ms, downloaded bytes, round-trip ms, IoU, Dice, boundary F, alpha MAE |

A missing capability is recorded as `skipped` with a reason. It is never
silently omitted — "not measured" and "measured, fast" are different claims.

## Methodology

**Raw samples are the source of truth.** Every measurement stores its individual
samples; `stats` is derived from them by `benchmarks/lib/stats.mjs`, and the
validator recomputes it and rejects a mismatch. A hand-edited median cannot be
published.

**Warm-ups are discarded, not averaged.** The first call after a size change
pays for a fresh allocation and a JIT tier-up.

**Cold and warm are separate cases.** A cold figure is mostly the network; a warm
figure is mostly the hardware. Averaging them describes neither.

**The backend is whatever the worker reported for that call**, not what init
requested — `TransformersAdapter.segment()` can fall back from WebGPU to WASM on
execution failure, and a CPU pass labelled "GPU" is worse than no number.

**Percentiles use linear interpolation between order statistics** (the NumPy
default). `p95` is `null` below 20 samples rather than a number one outlier
defines.

**Memory numbers carry their method.** `performance.memory` sees this realm's JS
heap only — not ORT's WASM memory, not GPU buffers, not the compositor — so it is
a lower bound and is labelled `js-heap-delta-nonisolated`. Computed allocation
figures are labelled `allocation-shape-estimate`. Read the label with the number.

**Cohorts are never pooled** across backend, cache state, browser or mode. See
[results/README.md](results/README.md).

## Quality: what is and is not measured

The synthetic corpus has ground truth that is **exact by construction** — one
parametric description produces both the pixels and the reference alpha. It
proves the mask pipeline is geometrically correct (no transposed axes, no flip,
no working-resolution mis-mapping, region patches inside their box).

It does **not** measure photographic cutout quality. The model is trained on
natural photographs and a synthetic disc is out of distribution, so a low IoU
there is information about the model, not about this codebase.

Photographic hair, fur, fingers and glasses transparency have **no** automated
coverage, and every report says so in its `quality.coverage` case. The full gap,
and how to close it, is in [corpus/README.md](corpus/README.md).

## Contributing a report

1. Run it (`/bench.html`, Quick mode is ideal).
2. Review the JSON preview. Tick "include hardware detail" only if you want your
   GPU adapter string and exact RAM in the file — off by default, because those
   identify a machine more precisely than they help compare one.
3. Download it.
4. Attach it to a GitHub issue, or open a PR adding it to
   `benchmarks/results/accepted/`.

Then `npm run bench:summary` regenerates [SUMMARY.md](SUMMARY.md) and the table
in the root README.

**The report contains no image bytes, no file names and no URLs.** That is not
a promise, it is a check: the validator scans every string for URLs, filesystem
paths, email addresses, `data:` URIs and base64 payloads, and rejects the report
if one appears. The page runs the same validator before offering the download,
using the same module CI uses.

There is no upload path anywhere in the runner. The report never leaves your
machine unless you move it.

## The Stage 0 gate is still open

`GATE.md` records that the original model gate **never passed**: all three
committed harness summaries are failure records with `"runs": []`. The harness in
`harness/` is kept as historical evidence and is not what this system replaced —
it measured the Transformers.js pipeline directly, not the app.

The benchmark system above does not close that gap. It measures the app and the
model as shipped; the gate question — "is this model good enough for the quality
bar in SPEC §9?" — needs the photo corpus with annotated ground truth that
[corpus/README.md](corpus/README.md) describes. That work has not been done.