# Stage 0 exit record

Date: 2026-09-29. Machine: CPU-only, 8 GB RAM, ~90 Mbps line but ~6–60 Mbps
effective to HF CDN (US AWS from India). No usable GPU (SwiftShader only).

> **Read this first (2026-10-02).** This file mixes three different kinds of
> claim, and they are not equally trustworthy:
>
> 1. **Engine unit tests and license audit** — reproducible, still true, cheap to
>    re-check.
> 2. **Node ORT CPU smoke test** — a real script (`node-smoke.mjs`) writing real
>    artefacts to `results/node-smoke-lite512-fp16/`. Reproducible on a CPU box,
>    slow, and it is not a browser measurement.
> 3. **In-browser WebGPU numbers** — a **manual Playwright session on a machine
>    with no usable GPU**, with **no harness artefact**. Not reproducible. See
>    [Not reproducible](#not-reproducible--ad-hoc-session-no-harness-artefact).
>
> **The benchmark harness itself has never produced a single successful
> measurement.** All three committed `summary.json` files are failure records.
> Nothing under `results/` can be reproduced from a fresh clone, because
> `results/` and `fixtures/` are both gitignored. See
> [The harness has no passing run](#the-harness-has-no-passing-run).

## PASS — verified findings, 2026-09-29

Everything in this section was checked on the date above. Anything from a later
ad-hoc browser session has been moved out to
[Not reproducible](#not-reproducible--ad-hoc-session-no-harness-artefact) and is
not part of this pass.

- **License audit** (`models/LICENSE-AUDIT.md`): BiRefNet + BiRefNet-lite
  (code and browser-export weights) MIT, verified via HF API tags.
  RMBG-1.4 confirmed non-commercial → BYOM-only, never default.
  *Still true; enforced by review, not by code — see the policy note in that file.*
- **Manifest** (`models/manifest.json`): revision pinned;
  lite-512 fp16 98,484,532 B / fp32 191,877,254 B. These match the shipped
  model (`packages/app/src/model-config.ts`) and are the only artifact the app
  loads. The manifest is maintained by hand and nothing validates it.
  *(The `general-512` fp16 473,435,223 B figure that used to sit here is
  **superseded** — that quality checkpoint was cut on 2026-09-29 and is not in
  the manifest, not in the app, and not measured. Provenance survives in git
  history and `models/LICENSE-AUDIT.md`.)*
- **Engine unit tests**: 16/16 green at the time (mask math, brush,
  feather/defringe, composite incl. shadow, operation-based history, engine
  contract w/ fake adapter). *The suite has grown a lot since; that count is
  what was true on this date, not what it is now — run `npm run test
  --workspace @rmbg/engine`.*
- **Real-weights smoke, BiRefNet-lite 512 fp16** (`node-smoke.mjs`, ORT CPU):
  session build ~11 s, inference **6–11 s @512px**, synthetic-circle mask
  exact (fg 0.266 vs truth 0.264, crisp boundary). See
  `benchmarks/harness/results/node-smoke-lite512-fp16/`.
  (Earlier 1024px unpatched builds also segmented exactly at 60 s/pass but
  are rejected for browser use: shader-binding overflow on WebGPU,
  execution failure on WASM.)
- **Return visit**: reload + same image re-segments in ~30 s with no
  re-download (browser cache persists); cutout identical. *Manual session, no
  artefact.*

## The harness has no passing run

Every committed summary is a failure. Quoted verbatim:

| File | `runs` | `fatal` |
|---|---|---|
| `results/studioludens_birefnet-lite-512/webgpu/summary.json` | `[]` | `"init result unparseable"` |
| `results/onnx-community_BiRefNet_lite-ONNX/webgpu/summary.json` | `[]` | `"init TIMEOUT/failed: ETIMEDOUT"` |
| `results/onnx-community_BiRefNet_lite-ONNX/wasm/summary.json` | `[]` | `"init TIMEOUT/failed: ETIMEDOUT"` |

All three died during `init()`. Not one reached inference, so the harness has
**no** cold/warm latency, **no** download byte count and **no** quality score for
any model. The `runs: []` in each file is the authoritative statement; any
number attributed to "the harness" in this project came from somewhere else.

Sibling evidence that the failures are environmental as much as harness bugs:
`results/onnx-community_BiRefNet_lite-ONNX/webgpu/init.raw.txt` ends in
`Target page, context or browser has been closed` — the box was killed
mid-session.

## A fresh clone reproduces nothing

`.gitignore` excludes `benchmarks/harness/fixtures/*.jpg|*.jpeg|*.png` and
`benchmarks/harness/results/*`. Only the READMEs in those directories are
tracked. Consequences:

- A clone has **zero fixtures**. `measure.mjs` reads `fixtures/`, filters for
  image files, and hard-exits with `No fixtures in benchmarks/harness/fixtures/`
  if it finds none. You must drop an image in yourself before the harness does
  anything at all.
- A clone has **zero measurements**. Nothing in `results/` can be restored from
  git, and the harness has never succeeded anyway.
- Only `results/giraffe-mask.png` and the two `node-smoke*` directories survive
  in this working tree because they predate the ignore rules or were force-added.
  They are evidence of a past run, not something CI or a new contributor can
  regenerate.

The torture set this gate was supposed to fix therefore does not exist: one
fixture (`rmbg14-example.jpg`, supplied by hand), no ground truth, and the
scoring the SPEC asks for — IoU, boundary F-measure, a rating sheet — was never
implemented. The harness writes per-phase timings and one mask PNG per run.
Full accounting in [SPEC §9](../SPEC.md#9-quality-bar-and-benchmark-gate).

## Not reproducible — ad-hoc session, no harness artefact

The following came from a **manual Playwright session**, driven by hand against
a local page, on the same CPU-only box. They are recorded because they were
observed; they are **not** benchmark results and no command in this repo
regenerates them.

- **In-browser, BiRefNet-lite 512 fp16, "real WebGPU"** (headless Chromium w/
  hardware adapter, Transformers v4): init 28.4 s (dl 12.7 s + session
  12.3 s), inference **20.5 s** on the giraffe fixture. On a box documented
  above as having **no usable GPU (SwiftShader only)** — so the "hardware
  adapter" claim and the machine description contradict each other, and this
  line should not be read as a WebGPU measurement at all.
- **Visual evidence:** `benchmarks/harness/results/giraffe-mask.png` — both
  giraffes cleanly separated, thin legs and ossicones intact, zebras and tree
  correctly excluded. **Captured manually, outside the harness.** It is a real
  result from a real run; it is one image on one box, not a score.
- The 20 s figure reflects that machine's software GPU plus Dawn overhead. It is
  not a product ceiling and not a floor.

Read the two together: the harness's own attempt to measure in-browser
inference is the `"init result unparseable"` record above. Manual number good,
automated number failed — and the automated one is the one that would have
counted as a gate.

## Stage 3 evidence (2026-09-30, giraffe fixture, in-app)

Manual verification in a real browser against the built app, one fixture, no
automated assertion. Evidence is per-item and was read off the running page.

- Background color + subject transform (70% scale screenshot), shadow +
  feather sliders (screenshot), guided click-to-region (history depth grew,
  zero errors), manual brush Apply + Undo restore (screenshots), region
  recompute commit (depth grew, no errors), unified undo across AI/brush/
  param ops (button-state cycle). Engine suite: 29 green.

`measure.mjs` step-wise with per-phase timeouts, timestamped logging,
download/session-build split timing, software-WebGPU auto-skip,
WebGPU→WASM fallback, `--inferSize` bisection support. *(Tooling capability,
not a passing measurement — see above.)*

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

## Overlay view, session-loss guard, dead-code sweep (2026-10-02)

Follow-up to the same review. 41 engine tests, 27 targeted browser checks and a
23-check regression pass over the fixes above are green.

| Fix | Evidence |
|---|---|
| `#btnOverlay` only toggled a CSS class and toasted "Overlay on/off" — the SPEC §3.3 overlay view did not exist (`renderDisplay` had no `overlay` branch). Replaced by a real fifth compare mode built on a new pure engine fn `compositeOverlay` (foreground untouched, background veiled toward a red tint, continuous across partial alpha, always opaque — inspection only, never an export path). | exact blend arithmetic verified: base (2.55, 90, 197.3) veiled 0.55 → (138, 103, 151); mask-1 pixel stays (128, 90, 100) |
| Opening a batch item silently replaced the single global editor session — image, mask, entire undo history, effects, background, and the previous preview URL — with no undo and no warning. Now asks first via a promise-based confirm modal (danger-styled, Escape = cancel, safe choice focused) naming the exact cost. | prompt appears only with unsaved work; cancel/Escape keep `state.image`; confirm replaces it |
| The editor had no route back to the queue (Back and New image both go to landing; the only Batch button is on the landing page). Added a "Batch queue" rail button, shown only when the queue is non-empty (SPEC §2.6 contextual capability). | visible once items exist; clicking lands on `#view-batch` |
| Overlay treated as inspect-only alongside Split (painting onto a tinted background would land against pixels that do not exist). | `__rmbgSplitLock` true in both, false after leaving |
| Removing the batch baseline history entry also removed one of the two instances of the item-#1 no-op-undo defect (`commitRegion(mask, 'batch', () => null)` snapshotted the mask as its own pre-image). | adopting a mask now leaves log depth 0 instead of 1 |
| Dead code removed: `#skel`/`.skblock`, `#statesWrap`/`#statesDrawer`, `#hqBanner` (CSS with no markup at all), `#maskView`, `#btnOverlay`, "Save state" (toast-only lie), the `[data-ai]` handler (no markup), the mock `runExport` body, the dead shell `setCompare` copy (which referenced the removed `#maskView`), `paintMove`/`paintMoveAlias`. | absent from the live CSSOM and from `window`; `.seg` now has exactly 5 modes |
| `drawComposite` split so the scratch-canvas blit is shared by the cutout, split, overlay, export and batch-PNG paths instead of duplicated. | regression pass: cutout/split/export pixels unchanged, export still writes a real `rmbg-export-1000x400.png` |

## Remove-panel switch, and the AI undo defect (2026-10-02)

45 engine tests, 30 targeted browser checks and a 20-check regression pass are green.

| Fix | Evidence |
|---|---|
| The Remove panel showed a static "Background removed" line with a Recompute button beside it, so there was no way to choose *not* to remove. Replaced with a real `<button role="switch">` (binary ⇒ a switch, not a range slider: a range would be ambiguous and keyboard-hostile). Recompute now appears only while removal is on and a mask exists. | `BUTTON role=switch`, `aria-checked` tracks state, Recompute row hidden when off |
| Turning removal off keeps the mask and shows the original; turning it back on restores the *same mask object* with no inference. | 24.6 ms, same object identity, restored cutout pixel-identical |
| With removal off the editor, the cutout compare modes (Split/Overlay/Mask), Recompute, the refine tools and the export background choice all stand down — they would act on pixels that are not on screen. | those three seg buttons disabled; `guardEditing()` blocks brushes, guided and region recompute |
| Export follows the switch: removal off writes the untouched original, ignoring the background choice and effects, and says so. | note reads `original photo (removal off)`; JPEG flattening warning correctly suppressed for an already-opaque original |
| **AI removal was not actually undoable** (item #1, open since the first review). `segmentCurrent` committed the *new* mask as its own pre-image, so Undo reported success, changed nothing and burned a slot. Fixed by `OpLog.replaceMask`, which captures `holder.mask` before the swap; the same defect in `openBatchItem` was already gone. | 4 new engine tests incl. undo→`null` before any cutout, undo→old values after a recompute, redo-stack clearing, redraw hook. 45 total green |
| The switch is one undo step, so toggling interacts correctly with brush/effect history. | depth +1 per toggle; undo/redo restore both `removeBg` and the control |
| Fixed a real bug found by the switch: after the first automatic removal the export drawer still read "original photo", because `realStart`/`rerun`/`openBatchItem` set `removeBg` directly and nothing refreshed the drawer. `syncRemoveSwitch()` now owns that refresh. | dims reads `PNG · transparent` immediately after segmentation |
| The same flow also fixed an export/display inconsistency: `realExport` required `state.mask` even when removal was off, making "export the original" impossible. | file written with removal off |

## Recompute progress overlay (2026-10-02)

15 targeted checks plus a 22-check consolidated regression across all four
review rounds are green.

| Fix | Evidence |
|---|---|
| **The overlay ran for a fixed 2600 ms regardless of the work.** `runScan` in the shell did `setTimeout(() => hide, 2600)`, so on a slow pass (GATE.md: CPU inference is minutes per pass) it vanished mid-compute and read as "finished" while the mask was still being rebuilt. `main.ts` now owns `startScan`/`stopScan`; all three work sites sit in `try/finally`. | held open and still showing at 0.5/2/3.5/5/6.5 s; a real Recompute click tears it down only when the worker settles |
| New visual: a sensor sweep (glowing vertical beam over faint scanlines, dimmed veil) instead of a pulsing inset rectangle, plus a bottom-centre chip with a pulsing dot, the phase label and a live elapsed clock. | `sweep 2.1s infinite`; chip is `role="status"`; clock read `0:00 → 0:02 → 0:03 → 0:05` |
| The elapsed clock is the honest signal: true progress is unknowable for a single-shot segmentation, so wall-clock beats a fake percentage (SPEC §6.7). | clock advances and resets to `0:00` on stop |
| `#scan` was a sibling of `#viewport` inside `#stage`, so `inset:0` covered the whole stage (1016×892) and the beam swept the dark background. It is now relocated into `#checker`, so it tracks the canvas under zoom/pan (same trick as `ensureSplit`). | `parent=checker`, rect `956×478` == checker `956×478` |
| Editing now stands down while work is in flight (`isScanning()` in `guardEditing`). Previously you could brush mid-recompute: the stroke would be recorded and then the mask replaced underneath it. | paint attempt during a scan leaves log depth unchanged |
| The shell's duplicate `#btnRecompGo` handler (which started the overlay a second time) is gone; `main.ts` owns that flow. | single owner |
| `prefers-reduced-motion` stops the sweep and the pulsing dot but keeps the clock, so reduced-motion users retain the "still working" signal. | CSS media query |

## Overlay toning-down, canvas hand-off, honest percentages (2026-10-02)

23 targeted checks plus a 19-check consolidated regression are green.

| Fix | Evidence |
|---|---|
| **Overlay toned down.** The bloom was the loud part: a 2px line with two stacked glows (`0 0 16px` + `0 0 46px`), a 30%-wide green gradient band, green scanlines and a green chip border with a drop shadow. Now a 1px hairline with one `0 0 5px` shadow, a 26% trail at ≤.09 alpha, neutral `rgba(255,255,255,.03)` scanlines, a neutral chip border and no drop shadow. The sweep also slowed 2.1s → 2.6s. | line `1px`; single `rgba(52,211,153,0.22) 0px 0px 5px`; chip border `rgba(255,255,255,0.08)`, shadow `none`; scanlines `rgba(255,255,255,0.03)`; veil `rgba(8,9,11,0.2)`; `2.6s` |
| The chip dot still glowed: a global `.dot` rule sets `box-shadow:0 0 8px var(--accent)` and my override missed it. Explicitly reset to `none`, and the expanding ring replaced by a calm 2.4 s opacity fade. | computed `box-shadow: none`, `animation-name: softPulse` |
| **Hand-off to the canvas.** The loading card used to hold the user through segmentation, showing a progress bar for work whose result they could already see on the image. Now, the moment the model is ready, the app switches to the editor and shows the progress overlay over the user's own photo; the loading card is reserved for download/session phases. | `view-editor on + #scan on`, `view-preparing off`, label `Removing background on-device (GPU)…` |
| A segmentation failure after the hand-off returns to the loading card, which owns error reporting, and clears the overlay. | model-load failure: `preparing=true, scan=false`, `#prepError` shown |
| A finished result is never stranded: `showView('view-editor')` is re-asserted after the await, since Back is no longer the preparing screen's cancel button. | after releasing the mask: editor on, mask set, `removeBg` true |
| **Percentages are now real.** The old screen invented them: weights mapped onto the first 60% of the bar "because session build and inference follow", then 3%/5% for the runtime, 50% or 65% for session build, 85% before inference. `setBar(frac \| null)` now shows a percentage only for measured bytes; every other phase is indeterminate (shimmer, no number). | 41 MB of 98 MB → label `42%`, bar `41.8367%` (the true fraction); indeterminate phases show `pct=""` and `shimmer=true` |
| The `·` separator moved inside `#prepPctWrap` so an indeterminate phase shows only its phase text instead of a dangling `·`. | `prepPctWrap display=none` when indeterminate |

## Backend truthfulness, overlay opacity, reveal timing (2026-10-02)

| Fix | Evidence |
|---|---|
| **"GPU" was not a verified claim.** `state.backend` came from the *init* response, but `TransformersAdapter.segment()` can fall back from WebGPU to WASM when execution fails — and the worker reported no backend with the result, so the UI kept saying GPU while inference ran on the processor. The worker now reports `backend` + `gpu` alongside every mask, and the app adopts it (`adoptBackend`) after each segment and region recompute. | GPU case: `Local processing · GPU`. Fallback case (`wasm/fp32-fallback` reported with the result): button corrects to `Local processing · CPU`, popover reads "Running on CPU · wasm/fp32-fallback. This browser could not give us a usable GPU adapter, so inference is on the processor." |
| The status bar said only "Local processing" — true but useless. It now names the verified device, and the privacy popover gains a `#localBackendLine` that explains a CPU fallback. | `localBtnText` + `localBackendLine`, both driven by `runningOnGpu()` |
| Overlay veil raised `rgba(8,9,11,.2)` → `rgba(7,8,10,.46)` so the canvas clearly sits *under* the overlay instead of looking like a bright photo with a line across it. Scanlines dimmed `.03` → `.025`. | computed `rgba(7, 8, 10, 0.46)` |
| Reveal delay cut from a 2 s hold + 1.6 s wipe to a 0.5 s hold + 1.1 s wipe. The 2 s hold read as a second wait after the overlay had already cleared. | measured gap from overlay-clear to first wipe frame: **542 ms** |

## PENDING — none of this has been measured

Blocked on hardware the project does not have: a real GPU, or a much stronger
CPU than the 8 GB SwiftShader box above. Listed as pending so it is not mistaken
for a claim.

- In-browser cold/warm inference numbers, on any device, from the harness. The
  only in-browser figures on record are the manual WebGPU session under
  [Not reproducible](#not-reproducible--ad-hoc-session-no-harness-artefact).
- Peak memory at 12 / 24 / 50 MP. `harness/page.html` records no memory reading
  at all, so the matrix SPEC §7 asks for has no data behind it.
- Torture-set expansion (currently **1** real fixture; hair/fur/glasses cases
  still to add), ground-truth masks, IoU / boundary F-measure scoring, and human
  ratings of real-fixture masks.
- A per-device-class latency table. There is no GPU data in this repo to build
  one from — the only machine that ever ran the harness had none.
- Full apple-to-apple quality comparison vs server tools.
- A full network-off run of the shipped flow (return-visit-no-download is
  verified; full offline is not).

## Decided from measurement (not pending)

These conclusions came out of real runs and stand:

- Quality tier (BiRefNet-512 fp16) is GPU-only: node ORT dies with
  `bad allocation` in the deformable-attention block even at 512px on an
  8 GB CPU box. CPU users stay on the fast tier by design; the app's
  upgrade path targets WebGPU only. *(Checkpoint cut 2026-09-29; not shipped.)*
- 1024px BiRefNet exports are rejected for browser use: shader-binding overflow
  on WebGPU, execution failure on WASM. 512 is the working ceiling.
- Fast-tier download is ~98 MB (fp16/WebGPU) / ~183 MB (fp32/WASM CPU).
  First-run honesty (determinate MB progress) is mandatory; a truly tiny
  fast model + self-hosted weights are open items.
- CPU inference is minutes-per-pass class on weak hardware. ~~inference must
  move to a Web Worker (Stage 2)~~ — **done, and no longer a concern**: inference
  has run in a Web Worker since Stage 2, so the page stays interactive during a
  slow pass. What is still true is the reason the number is bad: the browser WASM
  fallback is **single-threaded**, because the COOP/COEP headers that
  multithreading needs would block the cross-origin model download (see the note
  in `packages/app/vite.config.ts`). Self-hosting the weights so those headers
  can be served is what would unblock it.
