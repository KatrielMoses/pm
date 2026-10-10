import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The browser bundle may import only browser-safe workspace modules (lint-enforced).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@pm/config/public': fileURLToPath(
        new URL('../../packages/config/src/public.ts', import.meta.url),
      ),
      '@pm/contracts/shell': fileURLToPath(
        new URL('../../packages/contracts/src/shell.ts', import.meta.url),
      ),
      '@pm/contracts/rich-text': fileURLToPath(
        new URL('../../packages/contracts/src/rich-text.ts', import.meta.url),
      ),
    },
  },
  build: { outDir: 'dist', sourcemap: false, assetsInlineLimit: 0 },
  server: {
    port: 5173,
    // Same-origin in production; in development Vite proxies the API process.
    proxy: { '/v1': 'http://127.0.0.1:3000' },
  },
});
