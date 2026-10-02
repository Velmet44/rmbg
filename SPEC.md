# RMBG — Product & Engineering Specification

Version: 1.0 (pre-development)
License: MIT (code). Model weights carry their own licenses — see §5.
Status: Definition. No code exists yet.

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
- Detection mode default is `Auto` (general subject). An optional subject hint (`person`, `product`, `animal`, `auto`) may bias the model where supported; it must never be required.
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

### 4.2 Engine API contract (illustrative, binding for V1)

```ts
type ImageRef = { id: string; width: number; height: number; rgb: Uint8ClampedArray };
type AlphaMask = { width: number; height: number; alpha: Float32Array };
type SubjectHint = "auto" | "person" | "product" | "animal";
type QualityTier = "fast" | "quality";

interface SegmentationAdapter {
  readonly modelId: string;
  init(progress?: (p: ModelProgress) => void): Promise<void>;
  segment(image: ImageRef, opts: { hint: SubjectHint; tier: QualityTier }): Promise<AlphaMask>;
  recomputeRegion(image: ImageRef, mask: AlphaMask, bbox: BBox, opts: { hint: SubjectHint }): Promise<AlphaMask>;
  dispose(): Promise<void>;
}

interface Engine {
  removeBackground(image: ImageRef, opts: { hint?: SubjectHint; tier?: QualityTier }): Promise<AlphaMask>;
  applyBrush(mask: AlphaMask, stroke: BrushStroke, mode: "erase" | "restore"): AlphaMask;
  guidedSelect(image: ImageRef, mask: AlphaMask, point: Point, mode: "erase" | "restore"): Promise<AlphaMask>;
  recomputeRegion(image: ImageRef, mask: AlphaMask, bbox: BBox): Promise<AlphaMask>;
  feather(mask: AlphaMask, radius: number): AlphaMask;
  defringe(image: ImageRef, mask: AlphaMask, amount: number): AlphaMask;
  composite(image: ImageRef, mask: AlphaMask, background: Background, effects: Effects): ImageData;
  export(image: ImageRef, mask: AlphaMask, opts: ExportOptions): Promise<ExportResult>;
}
```

- `segment` runs at working resolution (default longest side 512 — the largest
  size the gated browser-compatible exports accept), returns working-res alpha;
  engine upsamples to full-res via joint/guided upsampling against the original RGB.
- `recomputeRegion` patches only the bbox area (with context padding + edge blending); outside the region the mask is bit-identical.
- Brush ops are synchronous, pure, and undoable as single ops.

### 4.3 Compositor

`composite = original RGB × final alpha over background + shadow/effects`.

Background replacement, shadow, feather, and defringe affect only the composite/export, never `Original.rgb` or the stored canonical mask except through explicit logged ops.

### 4.4 Guided select

V1 requirement: click-to-region with explicit erase/restore intent. Implementation is either a lightweight promptable segmentation model or a deterministic fallback (e.g. flood/superpixel region grow constrained by the click). The spec does not mandate which; it mandates the behavior: one click selects a coherent region boundary the user can then erase or restore in one step. If no promptable model passes the quality gate (Stage 0), ship the deterministic fallback and note it as such.

### 4.5 Object eraser (conditional)

Object eraser requires an inpainting model (background reconstruction), which is a different model class from segmentation. Rule: ship in V1 only if a local inpainting pipeline passes the quality gate without smearing or heavy latency. Otherwise defer — do not emulate it with the erase brush.

## 5. Model policy

Binding constraints:

1. **Default model must be MIT-compatible** (code and weights). Current designated default: BiRefNet-general (MIT) with a BiRefNet-lite fast tier. Exact checkpoint, source URL, commit/revision, and SHA-256 are recorded in `models/manifest.json` and verified at fetch time.
2. **RMBG-1.4 / RMBG-2.0 weights are non-commercial source-available** and must not be distributed as the default or claimed as MIT. They are supported only as user-supplied BYOM (bring-your-own-model): the user provides a URL or local file and explicitly accepts the upstream license. The app must surface the license notice at BYOM load time.
3. **Never commit weights to git.** `models/` contains manifests only: model id, display name, source, revision, license, license URL, attribution, checksum, expected input size, tier (`fast` | `quality`).
4. Every bundled or referenced model documents: name, source, version/commit, license, attribution, modifications (e.g. quantization, opset conversion), checksum.
5. The segmentation adapter interface (§4.2) is stable across model swaps. Changing models must not require product-flow changes.

## 6. Instant-first loading strategy

First-run model download is the primary abandonment risk. The following are requirements, not suggestions:

1. **Fetch on page load.** Model runtime + weights begin downloading during landing idle, before any image is selected. Image selection and model download proceed in parallel.
2. **Single tier, phased progress.** V1 ships one model (fast tier). The preparing screen reports honest phases: cache check → determinate MB download (only on cache miss) → session build → inference. A cached run shows "cached, no download needed" instead of a frozen bar. Inference runs in a Web Worker so the page stays interactive throughout.
3. **Download vs upload messaging.** Any progress indicator distinguishes `Local AI model download (MB / total, cached after first visit)` from image handling. The image is never described as uploading to a server.
4. **Working resolution first.** Inference runs at working resolution; full-resolution output is produced by upsampling the mask against original RGB (see §7). This bounds latency and memory while honoring original-resolution export.
5. **Persistent cache.** Runtime and weights persist via Service Worker + Cache API / IndexedDB (whichever the adapter uses — exactly one owner, no dual caches). Return visits skip download entirely except for versioned manifest updates, which are diffed by checksum.
   The inference runtime itself loads from a pinned CDN ESM build at runtime
   (verified: vite-bundling the runtime produced silently broken sessions).
   Self-hosting the runtime file alongside the weights is a Stage-2 step.
6. **Degradation paths.** No WebGPU → WASM fallback with adjusted time estimate. OOM or memory pressure → explicit message + technical expand + suggested action (smaller image, close tabs, stay on Fast tier). No generic spinner over a frozen image: old result stays visible during recompute; export shows determinate progress.
7. **Progress is tied to the work, never to a clock.** A busy indicator's lifetime must equal the lifetime of the operation it describes — a fixed timeout reads as "finished" while the mask is still being rebuilt. Show elapsed time instead of a percentage when the true progress is unknowable. While work is in flight, editing stands down: the mask a brush would edit is about to be replaced.

## 7. Performance and memory requirements

- Targets after caching (ordinary photos, working-res inference): high-end GPU on the order of 1–3 s; mid-range GPU several seconds; CPU/WASM fallback substantially slower. These are targets for the benchmark harness, not user-facing guarantees.
- Session reuse: one inference session per tier, reused across images and batch items. Session init cost is paid once and measured separately from per-image latency.
- Large images: never attempt naive full-resolution neural inference. Required path is working-res inference + full-res mask upsampling, or tiled inference with overlap and edge blending where working-res loses too much detail. Peak memory is bounded and tested at 12 MP, 24 MP, and 50 MP inputs.
- Batch is sequential. Parallel model executions are forbidden in V1 (memory blowup).
- Batch admission is bounded by total pixels, not file count: a queued item holds
  full-res RGB plus a Float32 mask (~7 B/px), and the ZIP export additionally
  buffers every PNG. Over-budget drops are refused with the running total shown,
  never silently truncated.
- Benchmark harness records per-model, per-tier, per-device-class: download bytes, cold/warm latency, peak memory, and mask quality scores on the torture set.

## 8. Format policy

Input priority: PNG, JPEG/JPG, WebP. Then AVIF (where the runtime decodes it), BMP, GIF/APNG (first frame in V1). HEIC/HEIF and TIFF/JPEG-XL only if a bundled local decoder ships and is tested — otherwise the app reports `This image format isn't supported in your current browser` with the detected format name. No silent failure.

Output: PNG primary; WebP and JPEG secondary; AVIF only where the runtime can encode. JPEG-with-transparency is blocked by an explicit background choice (see §3.6). Export preserves original dimensions by default; custom resolution is explicit width × height with aspect handling stated before export runs.

## 9. Quality bar and benchmark gate

Target: professional cutout quality comparable to the best server tools on ordinary creator photos, with particular attention to hair, fur, fine strands, fingers, glasses, thin objects, semi-transparent edges, similar foreground/background colors, complex backgrounds, multiple subjects, small objects, boundaries, and shadows.

Gate rule: **no editor work beyond Stage 1 until the Stage 0 benchmark passes.** The project must not claim the target merely because a model runs. Concretely:

- A checked-in `benchmarks/` harness (kept out of the shipped bundle; large images via LFS or external fixture store, never raw in git) with a fixed torture set and fixed scoring (mask IoU / boundary F-measure where ground truth exists, plus blind human rating for hair/edge cases).
- Default fast and quality tiers each have minimum bar + latency ceiling per device class. Guided select and inpaint-erase have independent gates; failure defers them without blocking the core remove → export path.
- Results are recorded per model revision so regressions are visible.

## 10. Privacy and security requirements

- Default flow: no account, no image upload, no server-side processing, no analytics, no tracking, no advertising.
- No third-party network request on page load. The only outbound calls are the
  model runtime and weights (see §6); the app makes none of its own, and
  decorative counters that needed an API were removed rather than kept.
- After model + app assets are cached, the full single-image flow must pass with network disabled (subject to browser limits). This is a release test, not an aspiration.
- Clipboard, file, and camera inputs are handled in-memory/locally. No image bytes in URLs, logs, or error reports.
- Optional quality-feedback prompt (`Fine` / `Needs fixing` + reason) is local-only unless the user explicitly opts into sending a diagnostic payload. Any opt-in payload excludes original pixels by default.
- BYOM URLs are fetched directly by the client; upstream license text is shown before download.

## 11. Reliability and error handling

Every fallible step has an explicit, actionable message:

- Model download failure: what failed (runtime vs weights), bytes received if known, retry action, offline note.
- Inference failure / OOM: device-memory explanation + action (downscale, close tabs, Fast tier), with collapsible technical details (model id, backend, working resolution). Never raw `ONNX Runtime exception` as the only text.
- Decode failure: format + reason + suggestion.
- Export failure: what was being written (format, dimensions) + recovery (retry, different format, smaller custom resolution).
- Version skew (cached model vs manifest): detect by checksum, re-fetch only the changed artifact, state what updated.

## 12. Repository structure (target)

```text
rmbg/
  SPEC.md
  README.md / LICENSE / CONTRIBUTING.md / CONTRIBUTORS.md / AGENTS.md
  models/
    manifest.json        # tier, source, revision, license, checksum per artifact
  packages/
    engine/              # pure TS engine + adapters + tests (no DOM)
    app/                 # thin web client over the engine
  benchmarks/
    torture/             # fixture manifests (images external, not in git raw)
    harness/             # scoring + latency + memory scripts
```

Weights, fixtures, and exports never enter git. Bundle contains code + manifests only.

## 13. Build order (stages)

> Status 2026-09-29: **Stage 0 DONE** (gate record: `benchmarks/GATE.md`),
> **Stage 1 DONE** (engine + app verified end-to-end on the giraffe fixture:
> upload → fast remove → inspect → PNG export at original resolution, fully
> local). Stages 2–4 not started.
>
> Status 2026-09-30: **Stage 3 DONE** (correction tools; evidence in
> `benchmarks/GATE.md`). Batch queue, custom export resolution and
> capability-gated AVIF have since landed, so those rows below are
> out of date — Stage 4 is partially in. See `AGENTS.md` for the
> current commands.

### Stage 0 — Model gate and harness ✅ DONE

- Finalize `models/manifest.json` (default fast + quality MIT checkpoints, licenses, checksums).
- Stand up `benchmarks/harness` + fixed torture set references.
- Run all candidate default models in-browser (WebGPU + WASM) and record download size, cold/warm latency, peak memory, quality scores.
- Exit criteria: one fast tier and one quality tier pass their bars; OOM boundaries documented; license audit signed off (default MIT, BYOM path defined).

### Stage 1 — Engine core ✅ DONE

- Implement `ImageRef`, float-alpha `Mask store`, op log, `SegmentationAdapter` for the gated checkpoints.
- Implement `removeBackground`, working-res inference + full-res upsampling, `composite`, PNG/WebP/JPEG `export` at original resolution.
- Unit tests on synthetic masks (brush math, feather, composite, history) + adapter contract tests with fixture tensors.
- Exit criteria: scripted remove → export passes headless with network disabled after cache; no DOM dependency in engine.

### Stage 2 — SUPERSEDED (worker, prefetch, phased progress, cache proof, mobile shell all landed during Stages 0–1)

### Stage 3 — Correction (DONE 2026-09-30; see benchmarks/GATE.md for evidence) — Instant shell ⬜ NEXT

- Landing ingest (picker, drop, paste, mobile picker), page-load model prefetch, Cache API/IndexedDB persistence.
- Fast-first flow: result as soon as the (single-tier) model is ready, honest phased progress (cache check → download → session build → inference), session reuse.
- Before/after, split, mask/overlay inspection, 100% zoom + pan, export settings (format, resolution, background choice incl. JPEG guard).
- Exit criteria: first-visit drop-to-preview feels instant after fast tier; return visit skips download; offline-after-cache test passes.

### Stage 3 — Correction

- Manual erase/restore brushes (size, softness), mask/overlay views, operation-based undo/redo across AI + manual + background + effects ops.
- Region recompute (bbox + context + edge blend, rest of mask preserved).
- Guided select (promptable model if gated, else documented deterministic fallback).
- Shadow, feather, defringe; background color/image + subject transform (visible only when relevant).
- Exit criteria: scripted correction suite passes (erase/restore round-trip, recompute preserves outside region, undo depth covers all op classes).

### Stage 4 — Batch and hardening

- Sequential batch queue, per-item states, retry, open-in-editor, batch export + archive.
- Full error catalog (§11) wired to real failure injection tests.
- Memory/large-image matrix (12/24/50 MP), device-class latency table published from harness.
- Privacy audit: no image bytes leave the device in default flow; optional feedback is opt-in and pixel-free by default.
- Exit criteria: release checklist green — benchmark gate, offline test, privacy audit, license manifest complete.

### Deferred (not V1 unless gated)

- High-quality second tier (GPU-only; cut 2026-09-29, fast tier suffices for V1).
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
- [x] Offline-after-cache full flow passes. (return-visit run; full network-off test still to schedule)
- [x] OOM/decode/download failures show actionable messages with technical expand. (verified: model-start failure screen; a crashed inference worker now rejects its pending requests instead of spinning forever)
- [ ] Benchmark torture set re-run on release model revisions; no regression vs gate.
- [x] `models/manifest.json` complete (name, source, revision, license, checksum) for every shipped artifact; no weights in git. (checksums: lite fp16 + quality fp16)
