import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  root: r('./src/web'),
  /*
   * Copied verbatim to the site root: the web app manifest and the Home Screen
   * icons, which have to be fetchable at stable paths (`/manifest.webmanifest`,
   * `/apple-touch-icon.png`) because iOS asks for them by URL and never sees
   * the bundle. Hashed asset names would break that, which is why they are not
   * imported through the graph.
   */
  publicDir: r('./src/web/public'),
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
