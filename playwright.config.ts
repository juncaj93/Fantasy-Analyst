/**
 * Browser smoke tests at iPhone Safari portrait sizes.
 *
 * WebKit is the target engine (iPhone Safari is the primary interface). The
 * `chromium-*` projects exist so the same specs can run in environments
 * where the WebKit build cannot be downloaded; they are a fallback, not a
 * replacement — CI runs the WebKit projects.
 *
 *   npm run e2e            # WebKit, all four widths
 *   npm run e2e:chromium   # fallback engine, all four widths
 */

import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';
import { AUTH_STATE } from './e2e/constants.ts';

const PORT = Number(process.env.E2E_PORT ?? 8788);
const baseURL = `http://127.0.0.1:${PORT}`;

/**
 * Some sandboxes ship a preinstalled Chromium whose build number does not match
 * this Playwright release. `PW_CHROMIUM_PATH`, or any of these known locations,
 * lets the fallback projects use it instead of downloading one.
 */
const CHROMIUM_CANDIDATES = [
  process.env.PW_CHROMIUM_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].filter((p): p is string => !!p);

const chromiumPath = CHROMIUM_CANDIDATES.find((p) => existsSync(p));

/**
 * The portrait widths called out in docs/06_UI_AND_QA.md.
 *
 * 430 is the Pro Max class of phone and is here for the opposite reason to 360:
 * the narrow one catches anything that overflows, and the wide one catches
 * anything that was only ever tuned for a narrow screen and falls apart with
 * room to spare — a control row that stretches, a fixed field that stops
 * looking fixed, a list that goes sparse.
 */
const VIEWPORTS = [
  { name: 'iphone-430', width: 430, height: 932 },
  { name: 'iphone-390', width: 390, height: 844 },
  { name: 'iphone-375', width: 375, height: 812 },
  { name: 'small-360', width: 360, height: 800 },
];

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  timeout: 30_000,
  expect: { timeout: 7_000 },
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    // Logs in once and shares the session, so the server's brute-force limiter
    // stays enabled during the run.
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
      use: chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : {},
    },
    ...VIEWPORTS.map((v) => ({
      name: `webkit-${v.name}`,
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Safari'],
        browserName: 'webkit' as const,
        viewport: { width: v.width, height: v.height },
        isMobile: false, // WebKit does not support isMobile emulation
        hasTouch: true,
        deviceScaleFactor: 3,
        storageState: AUTH_STATE,
      },
    })),
    ...VIEWPORTS.map((v) => ({
      name: `chromium-${v.name}`,
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        browserName: 'chromium' as const,
        viewport: { width: v.width, height: v.height },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 3,
        storageState: AUTH_STATE,
        ...(chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : {}),
      },
    })),
  ],
  webServer: {
    command: `npm run build && node scripts/build-server.mjs && FA_SEED=1 FA_INSECURE_COOKIES=1 NEWSLETTER_ADDRESS=fantasy-news@demo.example APP_PASSPHRASE=e2e-passphrase SESSION_SECRET=e2e-session-secret-value-32-chars node scripts/dev-server.mjs --port ${PORT}`,
    url: `${baseURL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
