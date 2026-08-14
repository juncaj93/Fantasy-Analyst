/**
 * Photograph the deployed app, every screen, both themes, at 390x844.
 *
 *   node scripts/screenshot-production.mjs <url> <outdir>
 *
 * This is evidence rather than a test: nothing here asserts anything, and it
 * never fails the job it runs in. It exists so that "does it look right on a
 * phone" can be answered by looking, from a machine that has one deployed site
 * and no phone. It is read-only — it opens screens and takes pictures.
 */

import { chromium, webkit } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';

const url = process.argv[2];
const out = process.argv[3] ?? 'screenshots';
if (!url) {
  console.error('usage: node scripts/screenshot-production.mjs <url> [outdir]');
  process.exit(2);
}
mkdirSync(out, { recursive: true });

const TABS = ['draft', 'team', 'trades', 'players', 'review', 'setup'];

/**
 * WebKit is the truth on an iPhone; Chromium is the fallback where it is absent.
 *
 * The fallback takes an explicit binary the same way playwright.config.ts does,
 * because some sandboxes ship a Chromium whose build number does not match this
 * Playwright release and would otherwise be ignored.
 */
async function launch() {
  try {
    return await webkit.launch();
  } catch {
    const candidates = [
      process.env.PW_CHROMIUM_PATH,
      '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
      '/usr/bin/chromium',
      '/usr/bin/google-chrome',
    ].filter(Boolean);
    const executablePath = candidates.find((p) => existsSync(p));
    return await chromium.launch(executablePath ? { executablePath } : {});
  }
}

const browser = await launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  hasTouch: true,
});
const page = await context.newPage();

for (const theme of ['light', 'dark']) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => window.localStorage.setItem('fa.appearance', t), theme);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="tab-draft"]', { timeout: 30_000 });

  for (const tab of TABS) {
    await page.getByTestId(`tab-${tab}`).click();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${out}/${tab}-${theme}.png` });
    console.log(`photographed ${tab} (${theme})`);
  }

  // One expanded player, which is the densest thing the app draws.
  await page.getByTestId('tab-draft').click();
  await page.waitForTimeout(800);
  const row = page.getByTestId('recommendation-row').first();
  if (await row.count()) {
    await row.click();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${out}/draft-expanded-${theme}.png` });
    console.log(`photographed the expanded player (${theme})`);
  }
}

// Leave the stored preference as it was found: System.
await page.evaluate(() => window.localStorage.removeItem('fa.appearance'));
await browser.close();
console.log(`screenshots written to ${out}/`);
