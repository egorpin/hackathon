import { defineConfig } from 'vite';
import { goldbergPreview } from './dev/goldberg-preview.js';
import { fileURLToPath } from 'node:url';

const backend = process.env.MARS_BACKEND_URL || 'http://127.0.0.1:8000';

export default defineConfig({
  plugins: [goldbergPreview()],
  server: {
    fs: { allow: [fileURLToPath(new URL('.', import.meta.url))] },
    proxy: {
      '/api': { target: backend },
      '/ws': { target: backend, ws: true },
    },
  },
});
