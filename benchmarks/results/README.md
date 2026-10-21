# Accepted benchmark reports

One JSON file per machine per run, validated before it lands here.

## What may be committed

Small JSON reports. **No** image bytes, no masks, no screenshots, no fixtures.
`npm run bench:validate` enforces this: it scans every string in every report
for URLs, filesystem paths, email addresses, `data:` URIs and base64-shaped
payloads, and rejects the file if one appears. So does the browser runner, using
the same code, before you are even offered the download.

This directory is deliberately separate from `benchmarks/harness/results/`, which
is gitignored. The harness holds raw local measurements and mask PNGs; this
directory holds the small validated reports a README table can be regenerated
from. A number in `benchmarks/SUMMARY.md` must be traceable to a file in here,
or it does not get published.

## What a filename may contain

`<timestamp>-<os>-<browser>-<mode>.json`, for example:

```
2026-10-03T14-22-05-Windows-Chrome-quick.json
```

No hostnames, no usernames. The report's `run.id` is random per run and proves
nothing about identity; the timestamp is UTC.

## Adding one

```sh
npm run bench:accept -- ~/Downloads/rmbg-bench-full-Windows-Chrome-20261003-1422.json
```

That validates first and refuses to copy a report that fails. Then regenerate
the tables:

```sh
npm run bench:summary
```

which rewrites `benchmarks/SUMMARY.md` and the block in the root `README.md`.

## Aggregation rules

- **Cohorts are never pooled.** A WebGPU warm pass and a WASM cold pass on
  different browsers are different experiments; one average over both describes
  neither. Every row states its cohort: backend · cache state · browser · mode.
- **Median of per-run medians**, so a machine that ran 50 iterations does not
  outweigh five people who ran five.
- **p95 only appears with at least 20 samples** in a cohort. Below that it is
  null rather than a number that one outlier defines.
- **Estimates are labelled.** A memory figure from `performance.memory` carries
  `method: js-heap-delta-nonisolated`; a computed allocation figure carries
  `method: allocation-shape-estimate`. Read the label with the number.