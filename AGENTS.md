# AGENTS.md

> Initialized 2026-09-29. Stack: npm workspaces + TypeScript + Vite + Vitest + Playwright CLI. Engine runs fully local via Transformers.js (ONNX/WebGPU/WASM).

## Status
- Docs: `README.md`, `SPEC.md`, `CONTRIBUTING.md`, `CONTRIBUTORS.md`, `LICENSE` (MIT).
- `packages/engine` — pure-TS cutout engine, DOM-free. Test: `npx vitest run` in `packages/engine`.
- `packages/app` — Vite app (mockup shell + real S1 wiring) + a jsdom suite that
  boots the real `index.html` against a fake Worker/canvas (`packages/app/test/harness.ts`).
  Test: `npx vitest run` in `packages/app`. Dev: `npx vite`. Build: `npm run build --workspace @rmbg/app`. Serve built app: untracked `serve.bat` (localhost:8901).
- CI (`.github/workflows/ci.yml`) runs typecheck + both suites + the build on
  every PR. `deploy.yml` only builds, and only on `packages/{app,engine}/**`.
- Typecheck is a gate: `npm run typecheck --workspace @rmbg/engine` / `--workspace @rmbg/app`.
  The app `build` runs `tsc --noEmit` first, so a type error fails the deploy.
  `W = window as Record<string, any>` in `main.ts` defeats this for anything
  crossing the shell boundary — that is the main reason to keep new logic in
  `main.ts` and out of the inline shell.
- `benchmarks/harness` — Stage 0 rig. Measure: `npm run measure --workspace @rmbg/harness -- --model=<id> --device=webgpu|wasm` (needs Playwright CLI session `rmbg`).
- `models/manifest.json` — model provenance (schema + `LICENSE-AUDIT.md` beside it). Never commit weights, fixtures, or results (see `.gitignore`).
- No UI framework. Engine must stay DOM-free; app owns canvas/DOM.
- Inference runtime loads from pinned CDN ESM at runtime (never bundle it —
  bundling produced silently broken sessions). One live inference session per
  page: dispose the idle tier on switch (adapter has single-flight init +
  dispose-reinit contract, covered by `adapter.test.ts`).
- The shell in `index.html` is a classic (non-module) inline script whose
  top-level *function declarations* land on `window`, so `main.ts` overrides
  them via `W`. Its `let`/`const` do NOT — a module cannot read or assign a
  script-scoped binding. Anything the two halves must share must be a `var`
  (e.g. `compareMode`) or moved into `main.ts`.
- Model identity lives in `packages/app/src/model-config.ts` (imported by both
  `main.ts` and `infer-worker.ts`) and must match `models/manifest.json`. The
  weights cache bucket is the engine's `RUNTIME_CACHE_NAME`, which the adapter
  re-reads from the runtime's own `env.cacheName` after load.
- `tsc` cannot see inside `index.html`; the inline shell is unchecked. Keep it
  to presentation/boilerplate only.
- Full-res composite is expensive (Float32 clone + full-res `putImageData`);
  `refreshDisplay()` coalesces onto one animation frame. Do not call
  `renderDisplay()` directly, and do not add full-res work to per-`input`
  handlers.
- A crashed worker is latched via `workerDead`; `callWorker` then rejects
  immediately. Never remove that latch — a terminated worker silently drops
  `postMessage`, so without it every later request hangs forever.
- Busy overlays are started/stopped by `main.ts` (`startScan`/`stopScan`), never
  by a `setTimeout`. The duration must equal the work's duration. `#scan` is
  relocated into `#checker` at runtime so it tracks zoom/pan; the markup ships
  it as a sibling of `#viewport`, where `inset:0` covered the whole stage.
  Anything awaiting the worker must sit in a `try/finally { stopScan() }`.
- `setBar(frac | null)`: `null` means indeterminate. A percentage may only be
  shown for measured bytes — the runtime fetch, session build and segmentation
  emit none, so they shimmer with a label instead. Do not reintroduce invented
  fractions.
- The loading card covers download + session build only. Once `ensureReady()`
  resolves, `realStart` hands off to the editor and the canvas overlay takes
  over; failures return to the card via `backToPreparing()`.
- Never claim GPU from the init-time backend. The adapter can fall back to WASM
  during `segment()`, so the worker reports `backend` with every mask and the
  app calls `adoptBackend(res)`. `runningOnGpu()` is the only GPU predicate.
- Logging goes through `packages/engine/src/log.ts` (`dbg`/`dbgTable`/
  `dbgThrottled`), re-exported from the engine index. ON by default; mute with
  `window.__rmbgDebug = false` or `localStorage['rmbg-debug']='off'` (checked
  per call, no reload). The worker gets its OWN module instance, so `[wk]`
  timestamps are relative to worker start, not to the page — the main thread
  stamps the round trip in `[worker]`. Use `dbgThrottled` at any per-frame
  call site (it reports the suppressed count, so the line still shows the rate).
- The app has ONE editing session (`state`). Anything that replaces it (opening
  a batch item) destroys the mask, the whole `OpLog`, the finishing params and
  the previous preview URL, with no undo. Route it through `confirmAction()`.
- `state.removeBg` is the Remove panel's switch. FALSE does NOT mean "no mask":
  the mask is always kept, so toggling back on is instant and lossless. Ask
  `removalOn()`, never `state.mask`, when deciding what is on screen or
  exportable — a mask can exist while the user has switched removal off.
- Replacing the canonical mask goes through `OpLog.replaceMask` (or
  `commitMaskSwap`), never `commitRegion(newMask, label, () => null)`: that
  snapshots the NEW mask as its own pre-image, so undo reports success, changes
  nothing, and still consumes a slot.
- Compare modes: `after` | `before` | `split` | `overlay` | `mask`, all driven by
  `renderDisplay`. `split` and `overlay` are inspect-only (`guardSplit`,
  `__rmbgSplitLock`) — painting onto a tinted or side-by-side view would land
  against pixels the user cannot see.

## Working agreement
- Prefer executable sources of truth (`package.json` scripts, `Makefile`, CI workflows) over prose once they exist.
- When a stack/commands are added, record here only the exact non-obvious commands (e.g. single-test, codegen, migration order).
- Keep this file compact: only lines an agent would likely miss without help.
