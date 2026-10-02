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
3. Inspect (before/after, split view, mask), refine if needed, Export PNG/WebP/JPEG.

Reloads skip the download entirely and work offline.

## What works today

- Single-image flow: upload → remove → inspect → correct → export
- A Remove background switch: turn it off to see and export the original photo — the cutout is kept, so turning it back on is instant
- Inspect: before/after, split with a movable divider, mask, and an overlay view that veils what was removed so you can spot what the AI wrongly kept
- Erase/restore brushes (Apply commits, Clear discards), guided click-to-region, drag-a-box AI recompute
- Backgrounds: transparent, solid color, custom image — with subject scale/rotation/position
- Finishing: drop shadow, edge feather + defringe
- One undo timeline across AI, brushes, and settings
- Sequential batch queue with per-item retry, open-in-editor, and ZIP export
- Original-resolution export; JPEG transparency guard (never silently flattened)

## Roadmap

Custom export resolution, batch queue, guided-selection model upgrade,
self-hosted weights, Web Worker tuning. See [SPEC.md](SPEC.md) for the plan
and [benchmarks/GATE.md](benchmarks/GATE.md) for measured gate evidence.

## How it works

- Segmentation: BiRefNet-lite 512px ONNX (MIT), via Transformers.js — WebGPU fp16, WASM fallback
- Masks are float alpha (hair and semi-transparency survive); the original pixels are never mutated
- One swappable `SegmentationAdapter`; the engine is pure TypeScript with 45 unit tests
- No backend, no analytics, no tracking — static hosting only ([ARCHITECTURE](SPEC.md#4-engine-architecture))

Model provenance (revisions, licenses, checksums): [models/manifest.json](models/manifest.json).

## Develop

Requires Node.js 20+.

```sh
npm install
npm test --workspace @rmbg/engine   # 45 unit tests, DOM-free
cd packages/app && npx vite         # dev server
./serve.bat                         # build + serve production (localhost:8901)
npm run measure --workspace @rmbg/harness -- --model=studioludens/birefnet-lite-512 --device=webgpu
```

## License

MIT — see [LICENSE](LICENSE). Third-party model weights retain their own
licenses, recorded in [models/manifest.json](models/manifest.json) and
[models/LICENSE-AUDIT.md](models/LICENSE-AUDIT.md).
