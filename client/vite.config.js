import { defineConfig } from 'vite';
import { modelVersions } from './dev/model-versions.js';
import { goldbergPreview } from './dev/goldberg-preview.js';
import { fileURLToPath } from 'node:url';

const backend = process.env.MARS_BACKEND_URL || 'http://127.0.0.1:8000';

export default defineConfig({
  build: { rollupOptions: { input: {
    main: fileURLToPath(new URL('./index.html', import.meta.url)),
    character: fileURLToPath(new URL('./character-review.html', import.meta.url)),
    markup: fileURLToPath(new URL('./character-markup.html', import.meta.url)),
    base: fileURLToPath(new URL('./base-review.html', import.meta.url)),
  } } },
  plugins: [modelVersions(), goldbergPreview()],
  server: {
    fs: { allow: [fileURLToPath(new URL('.', import.meta.url))] },
    proxy: {
      '/admin': { target: backend },
      '/api': { target: backend },
      '/ws': { target: backend, ws: true },
    },
  },
});
