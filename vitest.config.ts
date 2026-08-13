import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@core': r('./src/core'),
      '@server': r('./src/server'),
      '@web': r('./src/web'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
    reporters: ['default'],
  },
});
