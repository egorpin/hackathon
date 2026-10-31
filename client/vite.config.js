import { defineConfig } from 'vite';
import { goldbergPreview } from './dev/goldberg-preview.js';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [goldbergPreview()],
  server: {
    fs: { allow: [fileURLToPath(new URL('.', import.meta.url))] },
    proxy: {
      '/api': 'http://127.0.0.1:8000',
      '/ws': { target: 'ws://127.0.0.1:8000', ws: true },
    },
  },
});
