/**
 * The production smoke suite.
 *
 * Deliberately a second config rather than a project inside the main one: these
 * specs point at a deployed site, start no server, seed no data and write
 * nothing, and mixing them into `npm run e2e` would mean every local run
 * reached across the internet.
 *
 *   PRODUCTION_URL=https://… npx playwright test --config playwright.production.config.ts
 */

import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

const baseURL = process.env.PRODUCTION_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';

/** The same fallback the main config uses where WebKit cannot be downloaded. */
const CHROMIUM_CANDIDATES = [
  process.env.PW_CHROMIUM_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].filter((p): p is string => !!p);

const chromiumPath = CHROMIUM_CANDIDATES.find((p) => existsSync(p));

const VIEWPORTS = [
  { name: 'iphone-390', width: 390, height: 844 },
  { name: 'iphone-375', width: 375, height: 812 },
  { name: 'small-360', width: 360, height: 800 },
];

export default defineConfig({
  testDir: './e2e-production',
  fullyParallel: false,
  workers: 1,
  // A deployment that has just gone live can answer slowly for a few seconds.
  retries: 2,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'on',
  },
  projects: [
    ...VIEWPORTS.map((v) => ({
      name: `webkit-${v.name}`,
      use: {
        ...devices['Desktop Safari'],
        browserName: 'webkit' as const,
        viewport: { width: v.width, height: v.height },
        isMobile: false, // WebKit does not support isMobile emulation
        hasTouch: true,
        deviceScaleFactor: 3,
      },
    })),
    ...VIEWPORTS.map((v) => ({
      name: `chromium-${v.name}`,
      use: {
        ...devices['Desktop Chrome'],
        browserName: 'chromium' as const,
        viewport: { width: v.width, height: v.height },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 3,
        ...(chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : {}),
      },
    })),
  ],
});
