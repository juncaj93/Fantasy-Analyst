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
    rollupOptions: {
      output: {
        /*
         * Demo Mode ships as `demo-*.js`, and nothing else does.
         *
         * Not a performance trick — the code is already split by the dynamic
         * imports that reach it — but a naming one, and the name is what makes
         * the page-weight budgets honest. `perf-budgets.json` measures what a
         * phone must fetch *to render*, and a chunk only a demo can pull in is
         * not part of that; giving it a stable prefix is what lets the budget
         * say so out loud and cap it separately, instead of either counting it
         * against the shell or quietly ignoring a hashed filename.
         */
        chunkFileNames: (chunk) =>
          chunk.moduleIds.some((id) => id.includes('/core/demo/') || id.includes('/web/demo/'))
            ? 'assets/demo-[hash].js'
            : 'assets/[name]-[hash].js',
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
});
