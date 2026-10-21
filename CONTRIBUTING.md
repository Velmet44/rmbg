# Contributing

Thanks for helping improve RMBG. Bug reports, questions, documentation fixes,
small improvements, and larger contributions are all welcome. You do not need to
have a complete proposal or a perfect reproduction before opening an issue, and
you do not need an issue before opening a PR. Draft PRs are welcome when early
feedback would help.

## AI agents and AI-assisted contributions

Contributions created with AI coding agents are welcome, including agent-drafted
issues and PRs. AI assistance is optional; it is not a requirement or a reason
to reject a contribution. Any agent working in this repository must read and
follow [`AGENTS.md`](AGENTS.md), which records important project-specific
invariants. The person submitting a contribution is responsible for reviewing
the final diff, understanding what it does, and checking relevant behavior,
privacy, and licensing. AI-use disclosure is not required.

If repository guidance seems stale or conflicts with a script or CI behavior,
please mention the conflict in an issue or PR rather than guessing.

## Quick start

Requirements: Node.js 20 or newer (CI currently uses Node 22).

```sh
git clone https://github.com/Velmet44/rmbg.git
cd rmbg
npm ci
npm run dev --workspace @rmbg/app
```

When changing dependencies, use `npm install` and include the resulting lockfile
change. A branch such as `fix/short-description` is recommended, not required.

## Where things live

- `packages/engine` — pure TypeScript image and mask logic; keep it DOM-free.
- `packages/app` — the Vite app, worker, canvas/DOM code, and app tests.
- `models/manifest.json` and `models/LICENSE-AUDIT.md` — model provenance and
  license notes.
- `benchmarks/` — benchmark tools, methodology, reports, and the report
  contribution workflow.
- `SPEC.md` — product behavior and design intent. `AGENTS.md` has additional
  implementation constraints and sharp edges.

## Checks

Run the checks relevant to your change. All commands run from the repository
root:

```sh
npm run typecheck --workspace @rmbg/engine
npm run test --workspace @rmbg/engine
npm run typecheck --workspace @rmbg/app
npm run test --workspace @rmbg/app
npm run build --workspace @rmbg/app
```

`npm test` runs the test scripts across workspaces that define one. The app
build also runs its TypeScript check before Vite. CI runs the engine and app
checks and validates accepted benchmark reports. For a docs-only change, tests
may not be relevant. If you cannot run a check, say which one and why; that is
not a reason to hold back a useful issue or draft PR.

For UI changes, a screenshot or short reproduction steps are helpful, but not a
barrier to opening a PR. Please use the bundled sample or synthetic material in
screenshots rather than sharing private photos.

## Benchmarks

Measurements live in `benchmarks/` and the suites live in
`packages/app/src/bench/`. Method: [benchmarks/README.md](benchmarks/README.md).

```sh
npm run bench                                # build + serve; open /bench.html
npm run bench:serve                          # serve dist/ without rebuilding
npm run bench:browser -- --mode=quick        # headless run -> benchmarks/results/
npm run bench:validate -- <report.json>      # schema + statistics + privacy scan
npm run bench:accept -- <report.json>        # validate, then file it as accepted
npm run bench:summary                        # regenerate SUMMARY.md + README table
npm run bench:corpus                         # what the corpus covers, and what it does not
```

A report is plain JSON with no image data, no file names and no URLs; the
validator enforces that and refuses to file one that breaks it. If you add a
measurement, bump `SUITE_VERSION` in `packages/app/src/bench/types.ts` and add a
test for the maths that produces it.

`npm test` at the root runs `test` in every workspace that defines one, and
`npm run build` does the same for `build`. CI (`.github/workflows/ci.yml`) runs
the steps above individually so a failure names the package that broke.

The legacy Stage 0 model harness in `benchmarks/harness/` is not part of CI and
needs input you supply yourself — its fixtures are gitignored, and `measure.mjs`
exits immediately if `benchmarks/harness/fixtures/` holds no image:

```sh
npm run measure --workspace @rmbg/harness -- --model=studioludens/birefnet-lite-512 --device=webgpu
```

## Issues and PRs

For bug reports, include whatever details you have: browser/device, steps to
reproduce, expected versus actual behavior, and relevant error text. A minimal
reproduction is useful but not required. Please do not attach private images or
other sensitive data.

Keep changes focused where practical, add or update tests for behavior changes,
and update docs when their commands, claims, or behavior change. It is fine to
open a small or incomplete PR to get feedback. Explain what you tried and what
remains; maintainers can help decide the next step. There is no requirement to
run the full benchmark suite for an unrelated change.

The [PR template](.github/PULL_REQUEST_TEMPLATE.md) is intentionally short;
remove sections that do not apply. CI will report automated failures, and
reviewers can help with follow-up fixes.

For suspected security vulnerabilities, follow [SECURITY.md](SECURITY.md)
instead of opening a public issue.

## Privacy, assets, and models

- Never commit secrets, credentials, local environment files, private photos,
  model weights, or user exports. Keep local benchmark fixtures and raw runs out
  of PRs.
- Do not add image pixels, filenames, dimensions, or other per-image data to
  analytics, logs, or benchmark reports.
- Use synthetic or clearly licensed test assets. If changing or adding a model,
  update its provenance and license notes; do not bundle its weights in the repo.
- For benchmark reports, use the validation and acceptance workflow in
  [`benchmarks/README.md`](benchmarks/README.md); do not hand-edit measurements
  or derived statistics.
