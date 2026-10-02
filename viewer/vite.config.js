import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { apiPlugin } from '../server/api.js';

export default defineConfig({
  plugins: [apiPlugin()],
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
