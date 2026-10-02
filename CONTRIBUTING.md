# Contributing

## Quick start

1. Fork and clone: `git clone https://github.com/Velmet44/rmbg.git`
2. Install: `npm install` (Node 20+; CI runs Node 22)
3. Create a branch: `git checkout -b <scope>/<short-name>`
4. Make a focused change, keep `AGENTS.md` updated if you add toolchain quirks.
5. Open a PR with what changed and how you verified it.

## Commands

Both packages are npm workspaces, so every command runs from the repo root.

```sh
npm run typecheck --workspace @rmbg/engine   # tsc --noEmit
npm run test --workspace @rmbg/engine        # vitest run — DOM-free engine suite
npm run typecheck --workspace @rmbg/app      # tsc --noEmit
npm run test --workspace @rmbg/app           # app suite
npm run build --workspace @rmbg/app          # tsc --noEmit && vite build -> packages/app/dist

npm run dev --workspace @rmbg/app            # dev server
npm run build --workspace @rmbg/app && npm run preview --workspace @rmbg/app
                                            # production build on localhost:8901
```

`npm test` at the root runs `test` in every workspace that defines one, and
`npm run build` does the same for `build`. CI (`.github/workflows/ci.yml`) runs
the steps above individually so a failure names the package that broke.

The benchmark harness is not part of CI and needs input you supply yourself —
its fixtures are gitignored, and `measure.mjs` exits immediately if
`benchmarks/harness/fixtures/` holds no image:

```sh
npm run measure --workspace @rmbg/harness -- --model=studioludens/birefnet-lite-512 --device=webgpu
```

## Expectations

- Keep PRs small and scoped.
- Do not commit secrets, credentials, or local env files.
- Add tests for behavior changes. The test runner exists (Vitest, in
  `packages/engine`); a behavior change in the engine without a test will not
  pass review. UI changes need a screenshot or the exact steps to reproduce.
- `npm run typecheck` is a gate for both packages — the app `build` runs
  `tsc --noEmit` first, so a type error fails the build.
- The engine must stay DOM-free and the app must stay thin. Pixel logic belongs
  in the engine so it is unit-testable without a browser.
- If you change anything a document states — a command, a model revision, a
  measurement, a stage status — update that document in the same PR. Numbers in
  `README.md`, `SPEC.md` and `benchmarks/GATE.md` are traceable to an artefact;
  do not add one you cannot point at.
