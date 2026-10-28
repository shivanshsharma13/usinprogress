import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// VITE_BASE is the sub-path the site is served from: "/usinprogress/" on GitHub Pages, "/" locally.
export default defineConfig({
  root: 'web',
  base: process.env.VITE_BASE ?? '/',
  envDir: '..',
  plugins: [react()],
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('./shared', import.meta.url)) },
  },
  server: { port: 5173 },
  build: { outDir: '../dist', emptyOutDir: true },
});
