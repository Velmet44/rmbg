# rmbg

Free, open-source, local-first image background remover. No account, no credits, original-resolution export.

Processing runs entirely on your device (Transformers.js + ONNX, WebGPU with WASM fallback). The model downloads once into the browser cache; images never leave the machine.

See [AGENTS.md](AGENTS.md) for the working map and [SPEC.md](SPEC.md) for the product/engineering spec.

## Getting started

Prerequisites: Node.js 20+ and npm.

```sh
npm install
```

Run the app (dev):

```sh
cd packages/app
npx vite
```

Wired in Stage 1 (real, local): ingest (picker/drop/paste), fast-first
remove with background HQ upgrade, before/after/split/mask inspect, zoom/pan,
PNG/WebP/JPEG export at original resolution. Refine brushes, background,
effects, and batch UI exist as shell and land in later stages.

Or serve the production build with the untracked local helper:

```sh
./serve.bat   # builds if needed, serves http://localhost:8901/
```

## Verify

```sh
npm test --workspace @rmbg/engine   # engine unit tests (21, DOM-free)
npm run measure --workspace @rmbg/harness -- --model=studioludens/birefnet-lite-512 --device=webgpu
```

Stage 0 gate record: [benchmarks/GATE.md](benchmarks/GATE.md) (license audit,
manifest pins, engine tests, real-weights smoke + in-browser numbers).

## License

MIT — see [LICENSE](LICENSE). Model weights carry their own licenses, recorded in [models/manifest.json](models/manifest.json) (see [models/LICENSE-AUDIT.md](models/LICENSE-AUDIT.md)). RMBG-family weights are non-commercial and BYOM-only.
