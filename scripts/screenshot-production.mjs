/**
 * Photograph the deployed app, every screen, both themes, at 390x844.
 *
 *   node scripts/screenshot-production.mjs <url> <outdir>
 *
 * This is evidence rather than a test: nothing here asserts anything, and it
 * never fails the job it runs in. It exists so that "does it look right on a
 * phone" can be answered by looking, from a machine that has one deployed site
 * and no phone. It is read-only — it opens screens and takes pictures.
 *
 * Genuinely read-only since the final audit's F-01: photographing the Matchup
 * screen used to write forecast rows to the deployed database, because the GET
 * behind it recorded to the calibration ledger.
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

/**
 * Which destinations to photograph: whichever ones the bar is actually showing.
 *
 * This used to be a list written down here, beginning with Draft, and it broke
 * the first time Draft left the bar — the wait below sat thirty seconds for a
 * destination that no longer exists and then took the whole step down with it.
 * Two of the seven destinations are seasonal and one of them is *always*
 * missing, so any list written here is wrong for part of the year. Reading the
 * bar is right for all of it.
 */
async function destinations(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.tabbar button[data-testid^="tab-"]')].map((b) =>
      (b.getAttribute('data-testid') ?? '').replace(/^tab-/, ''),
    ),
  );
}

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

/*
 * Evidence, not a test — so one screen that will not open costs that screen and
 * nothing else.
 *
 * The docblock has always said this never fails the job it runs in, and until
 * now that was only true by luck: any throw took the step down. It is enforced
 * here rather than asserted, because the picture of the other eleven screens is
 * still worth having on the day the twelfth misbehaves.
 */
async function attempt(what, fn) {
  try {
    await fn();
    console.log(`photographed ${what}`);
  } catch (err) {
    console.log(`could not photograph ${what}: ${String(err).split('\n')[0]}`);
  }
}

for (const theme of ['light', 'dark']) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => window.localStorage.setItem('fa.appearance', t), theme);
  await page.reload({ waitUntil: 'domcontentloaded' });
  // The bar itself, not a destination inside it — see `destinations` above.
  await page.waitForSelector('.tabbar button[data-testid^="tab-"]', { timeout: 30_000 });

  const tabs = await destinations(page);
  console.log(`bar is showing: ${tabs.join(', ')} (${theme})`);

  for (const tab of tabs) {
    await attempt(`${tab} (${theme})`, async () => {
      await page.getByTestId(`tab-${tab}`).click();
      await page.waitForTimeout(1200);
      await page.screenshot({ path: `${out}/${tab}-${theme}.png` });
    });
  }

  // One expanded player, which is the densest thing the app draws. Only while
  // there is a board to open one from: Draft leaves the bar at the final pick.
  if (tabs.includes('draft')) {
    await attempt(`the expanded player (${theme})`, async () => {
      await page.getByTestId('tab-draft').click();
      await page.waitForTimeout(800);
      const row = page.getByTestId('recommendation-row').first();
      if (!(await row.count())) throw new Error('no board rows to expand');
      await row.click();
      await page.waitForTimeout(1200);
      await page.screenshot({ path: `${out}/draft-expanded-${theme}.png` });
    });
  }
}

// Leave the stored preference as it was found: System.
await page.evaluate(() => window.localStorage.removeItem('fa.appearance'));
await browser.close();
console.log(`screenshots written to ${out}/`);
