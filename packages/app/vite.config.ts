import { defineConfig } from 'vite';

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
  },
  preview: {
    port: 8901,
    strictPort: true,
  },
});
