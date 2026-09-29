# AGENTS.md

> Initialized 2026-09-29. Stack not chosen yet — update this file when toolchain lands; omit anything unverified.

## Status
- Docs scaffold only: `README.md`, `SPEC.md`, `CONTRIBUTING.md`, `CONTRIBUTORS.md`, `LICENSE` (MIT), `.gitignore` (OS/editor/env/logs only, no stack assumptions).
- No toolchain, code, or models yet. `SPEC.md` is the source of truth for product/scope/build order; it specifies no UI design.

## Working agreement
- Prefer executable sources of truth (`package.json` scripts, `Makefile`, CI workflows) over prose once they exist.
- When a stack/commands are added, record here only the exact non-obvious commands (e.g. single-test, codegen, migration order).
- Keep this file compact: only lines an agent would likely miss without help.
