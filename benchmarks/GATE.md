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
