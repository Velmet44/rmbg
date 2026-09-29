# Stage 0 exit record

Date: 2026-09-29. Machine: CPU-only, 8 GB RAM, ~90 Mbps line but ~6–60 Mbps
effective to HF CDN (US AWS from India). No usable GPU (SwiftShader only).

## PASS

- **License audit** (`models/LICENSE-AUDIT.md`): BiRefNet + BiRefNet-lite
  (code and browser-export weights) MIT, verified via HF API tags.
  RMBG-1.4 confirmed non-commercial → BYOM-only, never default.
- **Manifest** (`models/manifest.json`): revisions pinned; lite-512 fp16
  98,484,532 B / fp32 191,877,254 B; general-512 fp16 473,435,223 B
  (fp16-only → GPU-only tier).
- **Engine unit tests**: 16/16 green (mask math, brush, feather/defringe,
  composite incl. shadow, operation-based history, engine contract w/ fake adapter).
- **Real-weights smoke, BiRefNet-lite 512 fp16** (`node-smoke.mjs`, ORT CPU):
  session build ~11 s, inference **6–11 s @512px**, synthetic-circle mask
  exact (fg 0.266 vs truth 0.264, crisp boundary). See
  `benchmarks/harness/results/node-smoke-lite512-fp16/`.
  (Earlier 1024px unpatched builds also segmented exactly at 60 s/pass but
  are rejected for browser use: shader-binding overflow on WebGPU,
  execution failure on WASM.)
- **In-browser, BiRefNet-lite 512 fp16, real WebGPU** (headless Chromium w/
  hardware adapter, Transformers v4): init 28.4 s (dl 12.7 s + session
  12.3 s), inference **20.5 s** on the giraffe torture fixture; mask is
  professional quality — both giraffes cleanly separated, thin legs and
  ossicones intact, zebras/tree correctly excluded. See
  `benchmarks/harness/results/giraffe-mask.png`.
  (20 s reflects this box's weak GPU + Dawn overhead, not a product ceiling.)

## Rig

`measure.mjs` step-wise with per-phase timeouts, timestamped logging,
download/session-build split timing, software-WebGPU auto-skip,
WebGPU→WASM fallback, `--inferSize` bisection support.

## PENDING (need adequate hardware: real GPU or stronger CPU)

- In-browser cold/warm inference numbers for both tiers.
- Quality-tier (BiRefNet-general) measurement of any kind.
- Torture-set expansion (1 real fixture + synthetic now; hair/fur/glasses
  cases still to add) and human ratings of real-fixture masks.
- Full apple-to-apple quality comparison vs server tools.

## Consequences recorded (SPEC §6)

- Fast-tier download is ~109 MB (fp16/WebGPU) / ~224 MB (fp32/WASM CPU),
  not single-digit MB. First-run honesty (determinate MB progress) is
  mandatory; a truly tiny fast model + self-hosted weights are Stage-2 work.
- CPU inference is minutes-per-pass class on weak hardware: inference must
  move to a Web Worker (Stage 2) so the page never looks dead while working.
