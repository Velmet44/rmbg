# Benchmarks

Stage 0 rig. `harness/` measures candidate models in a real browser (download
bytes, cold init, cold/warm inference) and saves one mask PNG per run for a
human to look at. It computes **no IoU, boundary F-measure or rating sheet** —
there is no ground truth in the repo and no scoring code.

- Fixtures: `harness/fixtures/` (bytes git-ignored, manifest in README).
- Results: `harness/results/` (git-ignored).
- Run: `npm run measure --workspace @rmbg/harness -- --model=<hf-id> --device=webgpu|wasm`
  with `PLAYWRIGHT_CLI_SESSION=rmbg` set.

**Status: the harness has never completed a run.** All three committed
`summary.json` files are failure records with `"runs": []`, and because both
`fixtures/` and `results/` are gitignored, a fresh clone reproduces nothing —
`measure.mjs` hard-exits if `fixtures/` holds no image. Supply a fixture by
hand first. The full accounting is in [GATE.md](GATE.md).
