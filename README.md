# RMBG — background removal on your device

**Free · Open-source (MIT) · No account · No credits · No resolution cap · No upload.**

Drop a photo, get a professional cutout. Everything runs locally in your
browser (WebGPU with CPU fallback) — your images never leave the machine.

**Try it now: https://velmet44.github.io/rmbg**

| Before | After |
|---|---|
| ![Original photo: golden retriever in a busy park](docs/images/sample-before.png) | ![Cutout with transparent background](docs/images/sample-after.png) |

*Real output from the app: busy park background removed, fur edges intact, transparent PNG.*

## Use it

1. Open the link above (desktop or mobile).
2. Drop an image — the AI model downloads once (~98 MB), then lives in your browser cache.
3. Inspect (before/after, split view, mask), refine if needed, export PNG/WebP/JPEG (plus AVIF where your browser can encode it).

Reloads skip the download entirely.

## What works today

- Single-image flow: upload → remove → inspect → correct → export
- A Remove background switch: turn it off to see and export the original photo — the cutout is kept, so turning it back on is instant
- Inspect: before/after, split with a movable divider, mask, and an overlay view that veils what was removed so you can spot what the AI wrongly kept
- Erase/restore brushes (Apply commits, Clear discards), guided click-to-region, drag-a-box AI recompute
- Backgrounds: transparent, solid color, custom image — with subject scale/rotation/position
- Finishing: drop shadow, edge feather + defringe
- One undo timeline across AI, brushes, and settings
- Sequential batch queue with per-item retry, open-in-editor, and ZIP export
- Export at original resolution or a custom size — PNG, WebP, JPEG, plus AVIF where your browser can encode it; JPEG transparency guard (never silently flattened)

## Roadmap

Self-hosted runtime + weights, multithreaded WASM (needs COOP/COEP headers,
which the current static host cannot serve), a gated promptable model for guided
select, a second quality tier, and the Stage 4 hardening items the benchmark
gate never delivered: the torture set, IoU/F-measure scoring, the 12/24/50 MP
memory matrix and the per-device-class latency table. See [SPEC.md](SPEC.md) for
the plan and [benchmarks/GATE.md](benchmarks/GATE.md) for what was and was not
actually measured.

## How it works

- Segmentation: BiRefNet-lite 512px ONNX (MIT), via Transformers.js — WebGPU fp16, WASM fallback
- **The WASM fallback is single-threaded**, because serving the COOP/COEP headers that multithreading needs would block the cross-origin model download. The only CPU figure on record is 6–11 s per 512px pass in Node ([GATE.md](benchmarks/GATE.md)); no browser WASM pass has ever been timed, so treat CPU inference on a weak machine as slow rather than fast.
- Masks are float alpha (hair and semi-transparency survive); the original pixels are never mutated
- One swappable `SegmentationAdapter`; the engine is pure TypeScript with a DOM-free unit suite
- Inference runs in a Web Worker, so the page stays interactive during a long CPU pass
- No backend, no analytics, no tracking — static hosting only ([ARCHITECTURE](SPEC.md#4-engine-architecture))
- First visit fetches two things from third parties, both code and weights and never your image: the pinned Transformers.js runtime bundle (jsDelivr) and the model weights (Hugging Face). After that, both are cached

Model provenance (revisions, licenses, checksums): [models/manifest.json](models/manifest.json).
That manifest is kept by hand — nothing in CI validates it, and its SHA-256 was
computed once, out of band (see [SPEC §5.6](SPEC.md#56-what-is-enforced-and-what-is-only-written-down)).

## Develop

Requires Node.js 20+.

```sh
npm install
npm run typecheck --workspace @rmbg/engine
npm run test --workspace @rmbg/engine       # DOM-free engine suite
npm run typecheck --workspace @rmbg/app
npm run dev --workspace @rmbg/app            # dev server
npm run build --workspace @rmbg/app && npm run preview --workspace @rmbg/app
                                           # production build on localhost:8901
```

`npm test` at the root runs every workspace that has a `test` script; CI
(`.github/workflows/ci.yml`) runs the same commands one step at a time. The
benchmark harness needs a fixture you supply yourself — its bytes are
gitignored, so a fresh clone has none and `measure` exits immediately:

```sh
npm run measure --workspace @rmbg/harness -- --model=studioludens/birefnet-lite-512 --device=webgpu
```

## License

MIT — see [LICENSE](LICENSE). Third-party model weights retain their own
licenses, recorded in [models/manifest.json](models/manifest.json) and
[models/LICENSE-AUDIT.md](models/LICENSE-AUDIT.md).
