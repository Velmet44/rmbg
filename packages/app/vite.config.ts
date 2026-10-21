import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = dirname(fileURLToPath(import.meta.url));

// NOTE: no COOP/COEP headers on purpose. Requiring them would block the
// cross-origin model download (fully-local inference still works; the WASM
// backend simply falls back to single-threaded). Multithreaded WASM +
// same-origin model hosting is a Stage-2 optimization, not an S1 requirement.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    target: 'esnext',
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      input: {
        // The app itself.
        main: resolve(APP_ROOT, 'index.html'),
        // The benchmark runner, published alongside it so contributors need no
        // Node, no Playwright and no clone — just a browser and the deployed
        // page. It is a separate entry, so it costs the app nothing until
        // someone opens it.
        bench: resolve(APP_ROOT, 'bench.html'),
      },
    },
  },
  server: {
    // The benchmark runner shares statistics and validation code with the Node
    // CLI under benchmarks/lib, which lives outside this package. Vite's default
    // allow-list already covers the workspace root; stated explicitly so a
    // future change to the workspace layout fails loudly instead of silently
    // serving nothing.
    fs: { allow: [resolve(APP_ROOT, '../..')] },
  },
  preview: {
    port: 8901,
    strictPort: true,
  },
});
