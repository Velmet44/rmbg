# AGENTS.md

> Initialized 2026-09-29. Stack: npm workspaces + TypeScript + Vite + Vitest + Playwright CLI. Engine runs fully local via Transformers.js (ONNX/WebGPU/WASM).

## Status
- Docs: `README.md`, `SPEC.md`, `CONTRIBUTING.md`, `CONTRIBUTORS.md`, `LICENSE` (MIT).
- `packages/engine` — pure-TS cutout engine, DOM-free. Test: `npx vitest run` in `packages/engine`.
- `packages/app` — Vite app (mockup shell + real S1 wiring). Dev: `npx vite` in `packages/app`. Build: `npm run build --workspace @rmbg/app`. Serve built app: untracked `serve.bat` (localhost:8901).
- `benchmarks/harness` — Stage 0 rig. Measure: `npm run measure --workspace @rmbg/harness -- --model=<id> --device=webgpu|wasm` (needs Playwright CLI session `rmbg`).
- `models/manifest.json` — model provenance (schema + `LICENSE-AUDIT.md` beside it). Never commit weights, fixtures, or results (see `.gitignore`).
- No UI framework. Engine must stay DOM-free; app owns canvas/DOM.

## Working agreement
- Prefer executable sources of truth (`package.json` scripts, `Makefile`, CI workflows) over prose once they exist.
- When a stack/commands are added, record here only the exact non-obvious commands (e.g. single-test, codegen, migration order).
- Keep this file compact: only lines an agent would likely miss without help.
