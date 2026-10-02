# RMBG — Product & Engineering Specification

Version: 1.0
License: MIT (code). Model weights carry their own licenses — see §5.
Status: Implemented. V1 is live at https://velmet44.github.io/rmbg; this
revision is 2026-10-02. Parts of this document are still targets rather than
shipped behaviour — anything labelled **NOT DONE** has not been built or
measured. §13 carries the per-stage status.

## 0. Summary

RMBG is a free, open-source, local-first image background remover.

Core loop:

```text
Upload → Remove → Inspect → Correct if needed → Export
```

Defining characteristics:

- Processing runs on the user's device. No account, no credits, no mandatory server-side image processing.
- No artificial resolution limit. If the hardware can do it, RMBG exports at original resolution.
- Original image pixels are never destroyed. All edits operate on a separate alpha mask.
- The underlying segmentation model is swappable without changing product behavior.

RMBG is not a general photo editor. Editing exists only to fix cutout mistakes and finish the export (background, edges, shadow, sizing).

## 1. Goals and non-goals

Goals (V1):

- Drop an image in, get a professional cutout out with minimal effort.
- Hair, fur, fingers, glasses, thin objects, and semi-transparent edges handled to a professional bar.
- Manual correction when the AI is wrong: erase, restore, region recompute, guided select, mask inspection.
- Transparent / solid-color / custom-image background, subject transform when a replacement background is active.
- PNG / WebP / JPEG export at original resolution; AVIF where the runtime can encode it.
- Single and batch workflows. Mobile and desktop functional parity.
- Fully working offline after model and app assets are cached.

Non-goals (V1):

- General Photoshop replacement, graphic-design suite, templates, AI generation.
- Cloud storage, accounts, collaboration, video.
- Server-side processing pipeline (except static hosting of app + model files).

## 2. Product principles

1. **Removal first.** A first-time user gets a result without learning masks, layers, or models. Complexity is disclosed progressively.
2. **Simple surface, professional output.** Capabilities are deep; the default path stays narrow.
3. **Local-first privacy.** Default flow never uploads image bytes to an RMBG server. Model download is separate from image upload and is messaged as such.
4. **No silent quality loss.** Never silently downscale, flatten transparency, or change resolution. If a limitation applies, state it and offer an explicit choice.
5. **Preserve the original.** Edits modify the mask representation, not source pixels. Undo/redo is operation-based.
6. **Contextual capability.** Controls that are irrelevant to the current state stay hidden (e.g. background-position controls when output is transparent; brush parameters when no brush is active).

## 3. Functional flow (behavior, not layout)

### 3.1 Ingest

Inputs accepted:

- File picker, drag-and-drop, clipboard paste.
- Mobile: camera/gallery selection via native picker where the platform supports it.

On ingest the app must:

1. Validate format and decode locally.
2. Start (or reuse) the local inference session.
3. Produce a foreground alpha mask and composite a preview.
4. Keep the original file bytes + decoded RGB available for full-resolution export and restore operations.

Unsupported or undecodable input must produce: format name (when known), why it failed, and what to try next. No silent failure, no hang on a spinner.

### 3.2 Remove

- The primary action is the **Remove background** switch in the Remove panel. It defaults to on once segmentation completes; the automatic flow is unchanged.
- Toggling it **off shows the original photo and does not discard the mask**, so turning it back on restores the same cutout instantly with no second inference. Turning it on for an image that has never been segmented runs segmentation and reports progress.
- Recompute is available only while removal is on and a mask exists. The old cutout stays visible until a replacement is ready; a failure keeps the old result and reports why.
- Recompute, region recompute, guided select and the brushes all stand down while removal is off — they would edit pixels that are not on screen.
- Detection mode: general subject. V1 ships no subject-hint control — the gated checkpoint has one behaviour, so a `person` / `product` / `animal` selector would have been a choice between options the model cannot honour. Reintroduce it with the first model that genuinely varies by subject (§4.2).
- Quality mode: single automatic tier in V1 (fast model). The user must not need to understand the model to use it.
- Recompute: re-run segmentation. Old result stays visible until the new result is ready. A progress overlay runs for exactly as long as the work does — never on a fixed timer, which read as "finished" mid-compute — and the previous result survives a failure.

### 3.3 Inspect

The user must be able to verify quality before exporting:

- Before / after toggle.
- Side-by-side split comparison with movable divider.
- Mask view: white = foreground, black = background, gray = partial/uncertain.
- Overlay view: mask superimposed on original for finding missed regions. Foreground
  renders untouched, background is veiled toward a warning tint, and the transition
  is continuous across partial alpha (hair and semi-transparent edges only read
  correctly without a hard threshold). Inspect-only, like Split.
- Zoom to 100% and fit-to-view. Inspection at 100% must be practical (pan, no fighting the canvas).

### 3.4 Correct

Correction tools (all operate on the alpha mask):

- **Erase (manual):** paint transparency. Adjustable size, hardness/softness.
- **Restore (manual):** paint back original pixels incorrectly removed. Same brush model as erase.
- **Guided select:** click a region to select its boundary, then apply erase or restore to the whole region instead of hand-painting it.
- **Recompute region:** user marks a rectangular (V1) problematic region; the engine re-runs segmentation for that region with surrounding context and patches only that area. All other manual corrections are preserved.
- **Object eraser (conditional, see §4.5):** remove an object and reconstruct the background behind it. Semantically distinct from erase (erase = make transparent; object eraser = fill in background). Must not be merged into the erase brush.

### 3.5 Finish

- Background: transparent (default), solid color (with recent-color memory), custom image (upload/drop).
- Subject transform (scale, position, rotation, reset) appears only when a replacement background is active.
- Finishing: drop shadow (on/off, opacity, blur, distance, angle), edge feather, defringe. Small, conservative ranges. No unexplained slider laboratory.
- Background is a presentation layer. It must not mutate the stored mask or original.

### 3.6 Export

Export is a compact settings step, not just a download link:

- Format: PNG (primary, preserves transparency), WebP, JPEG, AVIF where the runtime supports encoding.
- Resolution: Original (default, dimensions shown, e.g. `4032 × 3024`) or Custom.
- Background: Transparent or Current background. `Current` means whatever the Background panel set, so the file matches what is on screen; `Transparent` forces the cutout only, for this export, without touching the stored background. The drawer states which of the two will actually be written.
- With removal switched off the file is the untouched original photo: the background choice and the finishing effects cannot apply to it, and the export note says so rather than dropping them silently.
- JPEG cannot carry transparency: selecting JPEG with transparency active must force an explicit background choice (white / black / current / custom color). Never silently flatten.
- Export button labels the exact outcome (e.g. `Export PNG`), shows progress, and reports the written file (format, dimensions, bytes).

### 3.7 Batch

- Entry splits into single-image and batch paths; batch never clutters the single-image flow.
- Batch = sequential job queue (not parallel inference): queued → processing → done/failed per item, with overall progress and per-item retry.
- Any batch item can be opened in the full single-image flow (same engine, same mask model).
  V1 has a single editing session, so opening an item replaces it. That is a
  destructive action and must be confirmed, naming the cost, whenever the session
  holds work — undo history is destroyed and cannot be recovered.
- The editor must offer a route back to the queue without going through the landing page.
- Batch export: individual files plus combined archive. Failures export independently without blocking the rest.

### 3.8 History

Undo/redo covers: AI removal, recomputation, guided ops, brush strokes, background changes, effects, transforms.

Implementation rule: operation-based history over the mask + parameters, not full-image snapshots. Stroke coalescing (one undo step per stroke, not per pointermove). Redo stack clears on new branching operation. Keyboard: `Ctrl/Cmd+Z` undo, `Ctrl/Cmd+Shift+Z` redo.

## 4. Engine architecture

Layering (dependencies point downward only):

```text
App
 ↓
RMBG Engine (pure TypeScript, no DOM)
 ↓
Segmentation adapter (swappable model backend)
 ↓
Mask store (Float32 alpha + op log)
 ↓
Refinement ops
 ↓
Compositor + Exporter
```

UI is thin. All pixel logic lives in the engine and is unit-testable without a browser DOM (typed arrays + pure functions; canvas only at the compositor/export boundary).

### 4.1 Data model

```text
Original:  RGB pixels (immutable) + width + height + source metadata
Mask:      Float32Array alpha in [0,1], length = width * height (working res + full-res mapping)
Ops:       append-only log of mask mutations + parameter changes
Background: { kind: transparent | color | image, params... } (presentation only)
Export:    derived artifact; never stored as source of truth
```

Alpha is float, not binary. This preserves hair and semi-transparency and makes feather/defringe well-defined.

### 4.2 Engine API contract (as shipped, 2026-10-02)

The adapter is the only seam to a model backend:

```ts
type ImageRef = { id: string; width: number; height: number; rgb: Uint8ClampedArray };
type AlphaMask = { width: number; height: number; alpha: Float32Array };

interface SegmentationAdapter {
  readonly modelId: string;
  init(progress?: (p: ModelProgress) => void): Promise<void>;
  segment(image: ImageRef): Promise<AlphaMask>;
  recomputeRegion(image: ImageRef, mask: AlphaMask, bbox: BBox): Promise<AlphaMask>;
  dispose(): Promise<void>;
}
```

Everything else is consumed as free functions, with `OpLog` owning history:

```ts
// working-res inference + full-res upsample
removeBackground(adapter, image): Promise<AlphaMask>

// in-place mask mutation; recorded through OpLog when it must be undoable
OpLog#applyBrush(mask, stroke, "erase" | "restore")
applyBrushStroke(mask, stroke, mode): void        // unlogged, pure
refineEdges(mask, { feather, defringe }): void   // in place

// guided select (§4.4)
growRegion(image, px, py, opts): GrownRegion

// presentation only (§4.3)
composite(image, mask, background, effects): CompositeResult
compositeOverlay(image, mask, options)           // inspect-only, never exported
transformSubject(image, transform): Transformed
```

`OpLog` also owns `replaceMask`, `commitRegion` and `undo`/`redo`: an operation
that changes alpha is only undoable if the log captured the pre-image, and the
log is the single place that knows how.

Reconciliation against the 1.0 draft of this section:

- **`createEngine()` and the `Engine` facade are deleted.** The facade wrapped four operations the app called as free functions anyway, so it cost an object graph and added a second logging surface with no behaviour of its own.
- **`applyBrush` returned an `AlphaMask`; it returns `void`.** The operation mutates the mask buffer in place. A returned "mask" was the same array, so the return value promised an isolation that did not exist. Undo comes from `OpLog`, not from a copy.
- **`feather` and `defringe` are one in-place call**, `refineEdges(mask, fx)`, not two functions returning new masks.
- **`guidedSelect` shipped as `growRegion`** — the deterministic fallback of §4.4, not a promptable model. No promptable model passed a gate, so none is claimed.
- **`export` was never an engine function.** Encoding and the file write need a canvas and a browser; the engine stays DOM-free (§4 preamble). Export is app-layer and works off `composite`.
- **`tier` and `hint` are removed** from `segment`, `recomputeRegion` and `removeBackground`. V1 ships exactly one model at exactly one working resolution, so both parameters were accepted and then dropped on the floor by the adapter (`async segment(image, _opts)`). A control that promises to bias the model and does not is worse than no control. They come back with the second gated model; constraint §5.5 already requires this interface to stay stable across that swap.

Behavioural notes:

- `segment` runs at working resolution (longest side ≤ `WORKING_LONG_SIDE` = 512 — the largest size the gated browser-compatible exports accept) and returns working-res alpha; `removeBackground` upsamples to full-res against the original RGB.
- `recomputeRegion` patches only the bbox area (with context padding + a 6 px edge blend); outside the region the mask is bit-identical.
- Brush ops are synchronous, pure, and undoable as single ops.

### 4.3 Compositor

`composite = original RGB × final alpha over background + shadow/effects`.

Background replacement, shadow, feather, and defringe affect only the composite/export, never `Original.rgb` or the stored canonical mask except through explicit logged ops.

### 4.4 Guided select

V1 requirement: click-to-region with explicit erase/restore intent. **Shipped as the deterministic fallback** — `growRegion` flood-grows on image colour from the click point (threshold 28, capped at half the frame) and returns the region's box plus a filled working-size patch that the caller applies as erase or restore. No promptable segmentation model passed the Stage 0 gate, so none is claimed and no quality number exists for it. Its known weakness is that a click on a gradient or a busy background grows a region that does not match what the user saw; that is a documented limitation, not a bug to be fixed silently. Raising the quality bar here means gating a promptable model as an independent feature (§9), not retuning the flood fill.

### 4.5 Object eraser (conditional)

Object eraser requires an inpainting model (background reconstruction), which is a different model class from segmentation. Rule: ship in V1 only if a local inpainting pipeline passes the quality gate without smearing or heavy latency. Otherwise defer — do not emulate it with the erase brush.

## 5. Model policy

Binding constraints:

1. **Default model must be MIT-compatible** (code and weights). Shipped default: **BiRefNet-lite 512** (`studioludens/birefnet-lite-512`, MIT, rev `4a3c40c3`) — the only shipped model, at one working resolution (512). Exact checkpoint, source URL and pinned commit/revision are recorded in `models/manifest.json`; its SHA-256 was computed once, by hand, on 2026-09-29. **No automated step verifies the checksum at fetch time** (§5.6) — a revision bump that keeps the same id would be loaded silently.
2. **RMBG-1.4 / RMBG-2.0 weights are non-commercial source-available** and must not be distributed as the default or claimed as MIT. They are supported only as user-supplied BYOM (bring-your-own-model): the user provides a URL or local file and explicitly accepts the upstream license. The app must surface the license notice at BYOM load time.
3. **Never commit weights to git.** `models/` contains manifests only: model id, display name, source, revision, license, license URL, attribution, checksum, expected input size, tier (`fast` | `quality`).
4. Every bundled or referenced model documents: name, source, version/commit, license, attribution, modifications (e.g. quantization, opset conversion), checksum.
5. The segmentation adapter interface (§4.2) is stable across model swaps. Changing models must not require product-flow changes.

#### 5.6 What is enforced, and what is only written down

`models/manifest.schema.json` exists and `models/manifest.json` points at it via `$schema`, but **nothing validates that pointer**: no validator, no npm script, no test, no CI step. The schema's `required` list is only `["modelId","tier","role","source","revision","license"]`, so `rmbg-1.4` — which ships `"checksum": null` and `"files": []` — satisfies it today. Three consequences a reader must not assume away:

- The manifest is a **record kept by hand**, not a gate. Typos in it are not caught.
- The MIT-only default rule and the license-refusal rule in `models/LICENSE-AUDIT.md` are **policy enforced by review, by a human**.
- The harness takes `--model=<hf-id>` free-form and does not read the manifest, so it can and will measure a non-MIT artifact. Its recorded attempts to do so are failures, not results (`benchmarks/GATE.md`).

Turning §5 into an actual gate — a `validate:manifest` script wired into CI that checks the schema, the MIT rule and the checksum — is a Stage 4 item, not current behaviour.

## 6. Instant-first loading strategy

First-run model download is the primary abandonment risk. The following are requirements, not suggestions:

1. **Fetch on page load.** Model runtime + weights begin downloading during landing idle, before any image is selected. Image selection and model download proceed in parallel.
2. **Single tier, phased progress.** V1 ships one model (fast tier). The preparing screen reports honest phases: cache check → runtime code download → determinate weight download → session build. A cached run shows "cached, no download needed" instead of a frozen bar. Inference runs in a Web Worker so the page stays interactive throughout.
   - **Percentages are shown only when they are real.** The weight download is determinate (`loaded / total` bytes). The runtime fetch, session build, and segmentation emit no byte events, so those phases are indeterminate — a shimmer with a phase label and a wall-clock, never an invented number.
   - **The long phase belongs on the canvas.** Once the model is ready, the flow hands off from the loading card to the editor and shows the progress overlay over the user's own photo. A loading bar for work whose result the user can already see is a worse feedback signal than the image itself.
3. **Download vs upload messaging.** Any progress indicator distinguishes `Local AI model download (MB / total, cached after first visit)` from image handling. The image is never described as uploading to a server.
4. **Working resolution first.** Inference runs at working resolution; full-resolution output is produced by upsampling the mask against original RGB (see §7). This bounds latency and memory while honoring original-resolution export.
5. **Persistent cache.** Runtime and weights persist via the Cache API under one bucket name (`RUNTIME_CACHE_NAME`) — exactly one owner, no dual caches. Return visits skip the download entirely — **except** that "diffed by checksum" is **NOT DONE**: nothing compares a checksum at runtime, so version skew between a cached artifact and the manifest goes unnoticed (§11).
   The inference runtime itself loads from a pinned CDN ESM build at runtime
   (verified: vite-bundling the runtime produced silently broken sessions).
   Self-hosting that runtime file alongside the weights is still open — it is on
   the README roadmap, not a Stage-2 leftover.
6. **Degradation paths.** No WebGPU → WASM fallback with adjusted time estimate. OOM or memory pressure → explicit message + technical expand + suggested action (smaller image, close tabs, stay on Fast tier). No generic spinner over a frozen image: old result stays visible during recompute; export shows determinate progress.
7. **Progress is tied to the work, never to a clock.** A busy indicator's lifetime must equal the lifetime of the operation it describes — a fixed timeout reads as "finished" while the mask is still being rebuilt. Show elapsed time instead of a percentage when the true progress is unknowable. While work is in flight, editing stands down: the mask a brush would edit is about to be replaced.

## 7. Performance and memory requirements

- Targets after caching (ordinary photos, working-res inference): high-end GPU on the order of 1–3 s; mid-range GPU several seconds; CPU/WASM fallback substantially slower. These are **targets, not measurements** — no harness run has produced a comparable figure (see §9 and `benchmarks/GATE.md`), and the one in-browser WebGPU number on record came from an ad-hoc session that cannot be reproduced.
- Session reuse: one inference session per tier, reused across images and batch items. Session init cost is paid once and measured separately from per-image latency.
- Large images: never attempt naive full-resolution neural inference. Required path is working-res inference + full-res mask upsampling, or tiled inference with overlap and edge blending where working-res loses too much detail. **NOT DONE:** peak memory is not yet measured. `benchmarks/harness/page.html` records no memory reading at all, so the 12 MP / 24 MP / 50 MP matrix below has no data behind it.
- Batch is sequential. Parallel model executions are forbidden in V1 (memory blowup).
- Batch admission is bounded by total pixels, not file count: a queued item holds
  full-res RGB plus a Float32 mask (~7 B/px), and the ZIP export additionally
  buffers every PNG. Over-budget drops are refused with the running total shown,
  never silently truncated.
- **NOT DONE:** the per-model, per-tier, per-device-class table (download bytes, cold/warm latency, peak memory, mask quality on the torture set) has not been produced. All three committed harness summaries are failure records with `"runs": []`. There is also no device-class data to tabulate: the gate machine was CPU-only with no usable GPU, so nothing in this repo describes a real high-end or mid-range GPU.

## 8. Format policy

Input priority: PNG, JPEG/JPG, WebP. Then AVIF (where the runtime decodes it), BMP, GIF/APNG (first frame in V1). HEIC/HEIF and TIFF/JPEG-XL only if a bundled local decoder ships and is tested — otherwise the app reports `This image format isn't supported in your current browser` with the detected format name. No silent failure.

Output: PNG primary; WebP and JPEG secondary; AVIF only where the runtime can encode. JPEG-with-transparency is blocked by an explicit background choice (see §3.6). Export preserves original dimensions by default; custom resolution is explicit width × height with aspect handling stated before export runs.

## 9. Quality bar and benchmark gate

Target: professional cutout quality comparable to the best server tools on ordinary creator photos, with particular attention to hair, fur, fine strands, fingers, glasses, thin objects, semi-transparent edges, similar foreground/background colors, complex backgrounds, multiple subjects, small objects, boundaries, and shadows.

Gate rule: **no editor work beyond Stage 1 until the Stage 0 benchmark passes.** The project must not claim the target merely because a model runs. Concretely:

- A checked-in `benchmarks/` harness (kept out of the shipped bundle; large images via LFS or external fixture store, never raw in git) with a fixed torture set and fixed scoring (mask IoU / boundary F-measure where ground truth exists, plus blind human rating for hair/edge cases).
- Default fast and quality tiers each have minimum bar + latency ceiling per device class. Guided select and inpaint-erase have independent gates; failure defers them without blocking the core remove → export path.
- Results are recorded per model revision so regressions are visible.

**What this gate actually delivered (honest accounting).** The rig exists (`benchmarks/harness/`), but the gate did not pass in the sense this section intends, and the record says so. Editor work shipped past Stage 1 anyway.

- The harness writes per-phase timings and one mask PNG per run. It computes **no IoU, no boundary F-measure, and no rating sheet** — there is no ground truth in the repo and no scoring code. Every quality claim in this project currently rests on a human looking at a mask.
- The torture set is **one fixture** (`rmbg14-example.jpg`), not the nine cases listed above. No hair, no fur, no glasses, no white-on-white, no small object.
- Fixture and result bytes are gitignored, so a fresh clone reproduces nothing; a contributor must supply an image by hand or `npm run measure` exits immediately.
- All three committed harness summaries are failures (`"runs": []` plus a `fatal` reason), and `results/` cannot be repopulated from git.
- Consequence: **the target in this section is unverified.** It is a design goal for the product, not a measured property of the shipped build.

## 10. Privacy and security requirements

- Default flow: no account, no image upload, no server-side processing, no analytics, no tracking, no advertising.
- **First visit makes two third-party requests, both code and weights, never image bytes**: the pinned CDN ESM runtime bundle (jsDelivr, §6.5) and the model weights (Hugging Face). Any statement implying the model file is the only download is false and must not appear in the UI or the docs. After the first visit both are served from cache and the app makes no outbound request at all; the app itself adds none, and decorative counters that needed an API were removed rather than kept. Image pixels are never part of any of these requests, which is the promise the product actually makes.
- After model + runtime assets are cached, the full single-image flow must pass with network disabled (subject to browser limits). **NOT DONE:** a full network-off run of the shipped flow has not been performed; only a return-visit-no-download check exists (`benchmarks/GATE.md`).
- Clipboard, file, and camera inputs are handled in-memory/locally. No image bytes in URLs, logs, or error reports.
- Optional quality-feedback prompt (`Fine` / `Needs fixing` + reason) is local-only unless the user explicitly opts into sending a diagnostic payload. Any opt-in payload excludes original pixels by default.
- BYOM URLs are fetched directly by the client; upstream license text is shown before download.

## 11. Reliability and error handling

Every fallible step has an explicit, actionable message:

- Model download failure: what failed (runtime vs weights), bytes received if known, retry action, offline note.
- Inference failure / OOM: device-memory explanation + action (downscale, close tabs, Fast tier), with collapsible technical details (model id, backend, working resolution). Never raw `ONNX Runtime exception` as the only text.
- Decode failure: format + reason + suggestion.
- Export failure: what was being written (format, dimensions) + recovery (retry, different format, smaller custom resolution).
- Version skew (cached model vs manifest): detect by checksum, re-fetch only the changed artifact, state what updated. **NOT DONE:** nothing in the repo computes or compares a checksum at runtime, so a same-id/different-revision change is invisible to the app.

## 12. Repository structure (as shipped)

```text
rmbg/
  SPEC.md
  README.md / LICENSE / CONTRIBUTING.md / CONTRIBUTORS.md / AGENTS.md
  .github/workflows/       # ci.yml (typecheck + tests + build), deploy.yml (Pages)
  docs/images/             # README before/after sample images
  models/
    manifest.json          # tier, source, revision, license, checksum per artifact
    manifest.schema.json   # declared only — nothing validates against it (§5.6)
    LICENSE-AUDIT.md       # license conclusions and the MIT-only default rule
  packages/
    engine/                # pure TS engine + adapters + vitest suite (no DOM)
    app/                   # thin web client over the engine
  benchmarks/
    GATE.md                # Stage 0 exit record
    harness/               # measure.mjs, node-smoke.mjs, page.html
      fixtures/            # images here are gitignored; README tracked
      results/             # measurements gitignored; README tracked
```

There is no `benchmarks/torture/` directory: fixtures live in `benchmarks/harness/fixtures/` and are supplied by hand, because their bytes are gitignored.

Weights, fixtures, and exports never enter git. Bundle contains code + manifests only.

## 13. Build order (stages)

Per-stage status as of 2026-10-02. `DONE` means built and, where a claim needed evidence, the evidence is named. `PARTIAL` means the code exists but the exit criteria did not all run. `NOT DONE` means not started.

| Stage | Status | Evidence / gap |
|---|---|---|
| 0 — Model gate and harness | **PARTIAL** | Manifest, license audit and the `benchmarks/harness` rig exist. The harness has never produced a passing measurement: all three committed summaries are failure records with `"runs": []`, and the latency numbers in `GATE.md` come from an ad-hoc browser session. No torture set, no IoU/F-measure, no peak memory, no device classes (§7, §9). |
| 1 — Engine core | **DONE** | `ImageRef`, float-alpha mask store, `OpLog`, `SegmentationAdapter`, `removeBackground` + full-res upsample, `composite`, app-layer export at original resolution. Engine suite and typecheck run in CI. Verified end-to-end on the giraffe fixture (drop → remove → inspect → PNG at original resolution). |
| 2 — Loading strategy | **DONE** (absorbed into 0–1) | Web Worker inference, page-load prefetch, phased honest progress, cache persistence, return visit skips the download, mobile shell. Multithreaded WASM remains Stage 4. |
| 3 — Correction | **DONE 2026-09-30** | Brushes, mask/overlay views, guided select (deterministic fallback), region recompute, shadow/feather/defringe, background + subject transform, single operation-based history. Evidence tables in `benchmarks/GATE.md`. |
| 4 — Batch and hardening | **PARTIAL** | Batch queue, per-item retry, guarded open-in-editor and ZIP export shipped; capability-gated AVIF and custom export resolution shipped. **Not done:** error-injection tests, the 12/24/50 MP memory matrix, the device-class latency table, multithreaded WASM, a manifest validator, a real privacy audit and a full network-off run. |

An earlier draft of this section carried a second, mislabelled "Stage 3" heading and a status note claiming Stage 4 was untouched. Both are gone; the table above is the only stage record in this document.

### Stage 0 — Model gate and harness ⬜ PARTIAL

- Finalize `models/manifest.json` (default fast + quality MIT checkpoints, licenses, checksums). — manifest is complete for the shipped model; there is no quality checkpoint (cut 2026-09-29) and nothing validates the manifest (§5.6).
- Stand up `benchmarks/harness` + fixed torture set references. — rig done; **the torture set is one fixture**, referenced from a README whose image bytes are gitignored.
- Run all candidate default models in-browser (WebGPU + WASM) and record download size, cold/warm latency, peak memory, quality scores. — **not done.** Every harness run failed at init. Download size is known from the manifest; cold/warm latency exists only for one ad-hoc WebGPU session; peak memory was never recorded.
- Exit criteria: one fast tier and one quality tier pass their bars; OOM boundaries documented; license audit signed off (default MIT, BYOM path defined). — license audit signed off; **one tier passed no bar**, because no bar was ever measured.

### Stage 1 — Engine core ✅ DONE

- Implement `ImageRef`, float-alpha `Mask store`, op log, `SegmentationAdapter` for the gated checkpoints.
- Implement `removeBackground`, working-res inference + full-res upsampling, `composite`, and export at original resolution. (Export is app-layer, not engine — see §4.2.)
- Unit tests on synthetic masks (brush math, feather, composite, history) + adapter contract tests with fixture tensors.
- Exit criteria: scripted remove → export passes headless with network disabled after cache; no DOM dependency in engine. — the DOM-free engine suite and typecheck run in CI; **the network-disabled end-to-end run has not been performed** (§10).

### Stage 2 — Loading strategy ✅ DONE (superseded as a separate stage)

Worker, prefetch, phased progress, cache proof and the mobile shell all landed during Stages 0–1, so there is nothing left under this heading. The remaining item is multithreaded WASM, tracked under Stage 4.

### Stage 3 — Correction ✅ DONE (2026-09-30)

- Manual erase/restore brushes (size, softness), mask/overlay views, operation-based undo/redo across AI + manual + background + effects ops.
- Region recompute (bbox + context + edge blend, rest of mask preserved).
- Guided select — shipped as the deterministic fallback, not a promptable model (§4.4).
- Shadow, feather, defringe; background color/image + subject transform (visible only when relevant).
- Exit criteria: scripted correction suite passes. — verified in-app against the production build, itemised in `benchmarks/GATE.md`.

### Stage 4 — Batch and hardening ⬜ PARTIAL

- ✅ Sequential batch queue, per-item states, retry, guarded open-in-editor, batch export + archive. Admitted by a total-pixel budget rather than a file count.
- ✅ Custom export resolution (explicit width × height) and capability-gated AVIF.
- ⬜ Full error catalog (§11) wired to real failure injection tests.
- ⬜ Memory/large-image matrix (12/24/50 MP) and a device-class latency table published from the harness. Both need measurements that do not exist (§7).
- ⬜ Multithreaded WASM fallback — requires COOP/COEP headers, which the current static hosting cannot serve, so the CPU fallback is single-threaded.
- ⬜ A `validate:manifest` script wired into CI (schema, MIT rule, checksum).
- ⬜ Privacy audit: a real network-off run of the shipped flow.
- Exit criteria: release checklist green — benchmark gate, offline test, privacy audit, license manifest complete. **Not met.**

### Deferred (not V1 unless gated)

- High-quality second tier (GPU-only; cut 2026-09-29, fast tier suffices for V1). `tier`/`hint` return with it (§4.2).
- Promptable segmentation for guided select (independent gate; §4.4).
- Object eraser / inpainting (independent model gate).
- AVIF export where encoding is unavailable, HEIC decode without bundled decoder.
- Accounts, cloud, templates, API service, video.

## 14. Acceptance checklist (release)

- [x] Drop → preview → export works first visit and return visit; return visit needs no download. (verified 2026-09-29, giraffe fixture)
- [x] Original-resolution export byte-checked against source dimensions for PNG/WebP/JPEG. (PNG + JPEG verified: 933 × 1405; WebP path shares the encoder call)
- [x] JPEG-with-transparency forces explicit background choice; never silently flattens. (white flatten is stated in the export note)
- [x] Undo/redo covers all op classes; stroke coalescing verified. (AI ops, brush strokes, guided, recompute, effects, background, transform — one interleaved timeline; verified button-state cycle + restore in-app 2026-09-29/30. Keyboard slider edits are one undo step per gesture, coalesced across a drag or a key-repeat burst.)
- [x] Region recompute leaves outside-region alpha bit-identical. (adapter patches bbox + 6px blend band only; commit verified in-app 2026-09-30)
- [ ] Batch of N completes sequentially with per-item retry; one failure doesn't block the rest. (queue landed; memory bounded by a pixel budget rather than a file count)
- [ ] Offline-after-cache full flow passes. (return-visit-no-download verified; **a network-off run of the full flow has not been done** — see §10)
- [x] OOM/decode/download failures show actionable messages with technical expand. (verified: model-start failure screen; a crashed inference worker now rejects its pending requests instead of spinning forever)
- [ ] Benchmark torture set re-run on release model revisions; no regression vs gate. (**nothing to regress against** — the gate produced no passing harness measurement; see §9 and `benchmarks/GATE.md`)
- [x] `models/manifest.json` complete (name, source, revision, license) for every shipped artifact; no weights in git. (one shipped artifact: `birefnet-lite`, fp16 checksum computed by hand 2026-09-29. `rmbg-1.4` is BYOM-only and ships `"checksum": null` / `"files": []`, which the unenforced schema permits — §5.6)
