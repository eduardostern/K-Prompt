import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  // ROM images and tapes are imported with ?url and served as files.
  assetsInclude: ['**/*.rom', '**/*.tap'],
  // The modem's relay runs in the Worker: `npx wrangler dev` serves it on 8787.
  server: { proxy: { '/relay': { target: 'ws://localhost:8787', ws: true } } },
  build: {
    target: 'es2020',
    outDir: 'dist',
    rollupOptions: {
      // The emulator, and the history page beside it.
      input: {
        main: resolve(__dirname, 'index.html'),
        history: resolve(__dirname, 'history.html'),
        zx81: resolve(__dirname, 'zx81.html'),
      },
    },
  },
});
