import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { apiPlugin } from '../server/api.js';

const { version } = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'package.json'), 'utf8'));

export default defineConfig({
  plugins: [apiPlugin()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: {
    target: 'es2022', // top-level await in the viewer
    rollupOptions: {
      input: {
        home: resolve(import.meta.dirname, 'index.html'),
        viewer: resolve(import.meta.dirname, 'viewer.html'),
      },
    },
  },
});
