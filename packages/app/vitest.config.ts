import { defineConfig } from 'vitest/config';

// Scope note: this config lives in packages/app, so Vitest's `root` is
// packages/app and `include` can only ever collect packages/app/test/**. The
// engine suite (packages/engine/test) has its own root and is never picked up —
// do not widen `include` to `**/*.test.ts`, that is how the engine's suite would
// get collected a second time under the jsdom environment.
//
// `deps` is deliberately left at its default: node_modules stay external (so
// `@rmbg/engine` — an npm workspace symlink — resolves normally) while linked
// packages are inlined and transformed from their TypeScript source, which is
// what makes `import ... from '@rmbg/engine'` work in main.ts under test.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.ts'],
    // The app shells out to Worker/canvas/URL APIs that jsdom does not
    // implement; every gap is filled by test/harness.ts before the app module
    // is imported, so no setupFiles are needed here.
    globals: false,
    restoreMocks: true,
    // Surface unhandled rejections instead of letting them fail a later,
    // unrelated test: the app fires promises (worker round trips) that a test
    // may legitimately leave in flight.
    dangerouslyIgnoreUnhandledErrors: false,
  },
});
