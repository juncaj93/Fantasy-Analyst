import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** The modules that make a chunk the Draft screen's own. See `chunkFileNames`. */
const DRAFT_SCREEN_MODULES = ['/web/screens/DraftScreen.tsx', '/web/components/mockDraft.tsx'];

/** The modules that make a chunk the Setup screen's own (October 2026). See `chunkFileNames`. */
const SETUP_SCREEN_MODULES = ['/web/screens/SetupScreen.tsx', '/web/screens/ReviewScreen.tsx'];

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
        /*
         * The Draft screen ships as `draft-*.js`, for the same reason.
         *
         * `App.tsx` reaches it only through `lazy()`, and only while the season
         * says a draft is still ahead (see `draftScreenWanted` there), so for
         * most of the year no page load fetches it. The prefix lets the budget
         * count it on its own line rather than against the shell.
         */
        /*
         * And Setup as `setup-*.js` (October 2026), for the same reason again.
         *
         * The largest screen left in the entry chunk (about 16KB gzipped with
         * Review and Data health under it) and the one a reader opens least:
         * nothing about a lineup, a claim or a trade needs it to render.
         * `App.tsx` reaches it through `lazy()` and fetches it once the first
         * screen is up, so it is in the browser's cache before anybody taps
         * the tab. Budgeted on its own line in `perf-budgets.json`.
         */
        chunkFileNames: (chunk) =>
          chunk.moduleIds.some((id) => id.includes('/core/demo/') || id.includes('/web/demo/'))
            ? 'assets/demo-[hash].js'
            : chunk.moduleIds.some((id) => DRAFT_SCREEN_MODULES.some((m) => id.endsWith(m)))
              ? 'assets/draft-[hash].js'
              : chunk.moduleIds.some((id) => SETUP_SCREEN_MODULES.some((m) => id.endsWith(m)))
                ? 'assets/setup-[hash].js'
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
