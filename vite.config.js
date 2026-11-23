import { defineConfig } from 'vite';

// `base: './'` makes the build work both at a sub-path (GitHub Pages:
// https://<user>.github.io/circumnavigate/) and at a domain root (Vercel).
export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2020', chunkSizeWarningLimit: 900 },
});
