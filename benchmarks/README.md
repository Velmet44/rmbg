# Benchmarks

Stage 0 rig. `harness/` measures candidate models in a real browser
(download bytes, cold init, cold/warm inference, peak conditions) and saves
mask PNGs for human rating until ground-truth masks enable automatic scoring.

- Fixtures: `harness/fixtures/` (bytes git-ignored, manifest in README).
- Results: `harness/results/` (git-ignored).
- Run: `npm run measure --workspace @rmbg/harness -- --model=<hf-id> --device=webgpu|wasm`
  with `PLAYWRIGHT_CLI_SESSION=rmbg` set.
