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
- **Return visit**: reload + same image re-segments in ~30 s with no
  re-download (browser cache persists); cutout identical.

## Stage 3 evidence (2026-09-30, giraffe fixture, in-app)

- Background color + subject transform (70% scale screenshot), shadow +
  feather sliders (screenshot), guided click-to-region (history depth grew,
  zero errors), manual brush Apply + Undo restore (screenshots), region
  recompute commit (depth grew, no errors), unified undo across AI/brush/
  param ops (button-state cycle). Engine suite: 29 green.

`measure.mjs` step-wise with per-phase timeouts, timestamped logging,
download/session-build split timing, software-WebGPU auto-skip,
WebGPU→WASM fallback, `--inferSize` bisection support.

## App-layer defect fixes (2026-10-02, no model change)

Behaviour defects found by review and then verified in a real browser against
the production build. No inference, mask, or model-provenance change — the
engine's own maths is untouched apart from being deduplicated.

| Fix | Evidence |
|---|---|
| Export drawer's `Transparent` / `Current background` radios had no ids or handlers; the choice was silently ignored and always used the on-screen background. Now wired, with the outcome stated in the drawer. | both radios toggle; `#expDims` reads `transparent` vs `with background`; note names the actual background (`Solid #FF0000…`) |
| JPEG-transparency warning was toggled from two places (shell on format click, `syncFxControls` on background kind) and so described neither. Single owner now, driven by the effective choice. | JPEG+transparent warns, JPEG+background hidden, PNG+transparent hidden |
| `object-fit:cover` on `#uploadedImg` cropped the original; the checker's `1px` border under `box-sizing:border-box` also shrank the content box 2px, so the img, result/split canvases and paint overlay disagreed by a hair. Border → inset shadow; `contain`. | content box == border box (delta `[0,0]`); 1000×400 image → 640×256 box, 0.00px crop; paint backing == box == `640×256` |
| Two undo histories existed (mockup `undoStack` + real `OpLog`); `pushHist` re-enabled `#btnUndo` and fought the real sync. Mock stack and all 12 call sites deleted. | `pushHist`/`syncHist`/`undoStack` absent from the page; one timeline |
| A crashed inference worker never rejected its pending requests, so the preparing screen spun forever. Now rejects all in-flight work, stops the clock, and latches so later calls fail fast instead of hanging on a dead worker. | forced crash surfaces the error in ~110ms; retry fails fast in ~110ms |
| Keyboard slider edits after the first nudge never entered the history (`focus` fires once). Now arms on `pointerdown`/`keydown` and debounces, so a drag or a key-repeat burst is one entry. | 4 arrow presses → depth +1; undo restores; a second gesture → +1 again |
| Full-res composite ran on every slider `input` (Float32 clone + full-res `putImageData`). Coalesced onto one animation frame. | 12 `input` events → 1 `putImageData` |
| Batch capped at 24 files regardless of size (~1.7 GB at 12 MP). Now bounded by total pixels and the cap is stated in the UI. | 16 × 3 MP offered → 13 queued; toast `Batch memory budget reached (39 / 40 MP, ~1 MP left)` |
| `B` compare shortcut could not toggle back: the shell's `let compareMode` is invisible to a module. Now `var`, mirrored by `realCompare`. | after → before → after |
| Footer star counter called `api.github.com` on load, contradicting the no-tracking promise. Removed. | zero non-localhost requests on load |
| `MODEL_ID`/`MODEL_REV`/cache-bucket name duplicated across `main.ts` and the worker. Single `src/model-config.ts`; bucket re-read from the runtime's `env.cacheName`. | typecheck clean; `Model:` diagnostic line reports both |
| `Engine.applyBrush`/`refineEdges` were dead (app called raw fns). Both now share one implementation (`OpLog.applyBrush`, `refineEdges`). | +5 engine tests (35 total, all green) |
| No `tsc` gate — `vite build` never typechecked. Both packages now typecheck, and the app `build` runs `tsc --noEmit` first. | `npm run build` fails on a type error |

## PENDING (need adequate hardware: real GPU or stronger CPU)

- In-browser cold/warm inference numbers for the quality tier.
- Torture-set expansion (1 real fixture + synthetic now; hair/fur/glasses
  cases still to add) and human ratings of real-fixture masks.
- Full apple-to-apple quality comparison vs server tools.

## Decided from measurement (not pending)

- Quality tier (BiRefNet-512 fp16) is GPU-only: node ORT dies with
  `bad allocation` in the deformable-attention block even at 512px on an
  8 GB CPU box. CPU users stay on the fast tier by design; the app's
  upgrade path targets WebGPU only.
- Fast-tier download is ~98 MB (fp16/WebGPU) / ~183 MB (fp32/WASM CPU).
  First-run honesty (determinate MB progress) is mandatory; a truly tiny
  fast model + self-hosted weights are Stage-2 work.
- CPU inference is minutes-per-pass class on weak hardware: inference must
  move to a Web Worker (Stage 2) so the page never looks dead while working.
