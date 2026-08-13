import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  root: r('./src/web'),
  publicDir: false,
  resolve: {
    alias: {
      '@core': r('./src/core'),
      '@server': r('./src/server'),
      '@web': r('./src/web'),
    },
  },
  build: {
    outDir: r('./dist/web'),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
});
