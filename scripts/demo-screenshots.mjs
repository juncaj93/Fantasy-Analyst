/**
 * Capture the demo, at every width a phone actually is.
 *
 * A launch showcase is looked at before it is read, and the four portrait
 * widths in `playwright.config.ts` are where this app has historically broken:
 * 430 goes sparse, 360 overflows. This walks the scenarios the showcase is
 * about, at each width, and writes a PNG per screen — so a reviewer can see the
 * first viewport of every surface without standing up a device.
 *
 * Not a test and deliberately not in `e2e/`: it asserts nothing. It uses the
 * same `?demo=` hook the audit uses, against a server the caller has already
 * started.
 *
 *   node scripts/demo-screenshots.mjs [--base http://127.0.0.1:8788] [--out artifacts/demo]
 */

import { chromium } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);

const BASE = args.get('--base') ?? `http://127.0.0.1:${process.env.E2E_PORT ?? 8788}`;
const OUT = resolve(args.get('--out') ?? 'artifacts/demo');

/** The same widths the browser gate runs at. */
const WIDTHS = [430, 390, 375, 360];

/**
 * What to capture, and where.
 *
 * One entry per thing the showcase has to be able to show, rather than one per
 * scenario: the point is the screen, and several scenarios exist to put a
 * different state on the same one.
 */
const SHOTS = [
  { scenario: 'draft-mid', tab: 'draft', name: 'draft-board' },
  { scenario: 'sunday-pregame', tab: 'team', name: 'team-lineup' },
  { scenario: 'sunday-pregame', tab: 'matchup', name: 'matchup-pregame-hold' },
  { scenario: 'matchup-injury-swing', tab: 'matchup', name: 'matchup-best-move' },
  { scenario: 'matchup-live-close', tab: 'matchup', name: 'matchup-live' },
  { scenario: 'waivers-tuesday-active', tab: 'waivers', name: 'waivers-claim-plan' },
  { scenario: 'waivers-tuesday-active', tab: 'team', name: 'team-dst-line' },
  { scenario: 'trade-window', tab: 'trades', name: 'smart-trades' },
  { scenario: 'sunday-pregame', tab: 'players', name: 'players' },
  { scenario: 'playoff-week', tab: 'waivers', name: 'waivers-playoff-dst' },
];

const CHROMIUM_CANDIDATES = [
  process.env.PW_CHROMIUM_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/chromium',
].filter(Boolean);

async function main() {
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  const executablePath = CHROMIUM_CANDIDATES.find((p) => existsSync(p));
  const browser = await chromium.launch(executablePath ? { executablePath } : {});

  for (const width of WIDTHS) {
    const context = await browser.newContext({
      viewport: { width, height: Math.round(width * 2.15) },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();

    for (const shot of SHOTS) {
      await page.goto(`${BASE}/?demo=${shot.scenario}`);
      await page.getByTestId('demo-bar').waitFor({ state: 'visible', timeout: 15_000 });
      const tab = page.getByTestId(`tab-${shot.tab}`);
      if ((await tab.count()) === 0) {
        console.log(`skip ${shot.name} at ${width}: no ${shot.tab} tab in ${shot.scenario}`);
        continue;
      }
      await tab.click();
      /* Let the fetch, the render and the transition settle before the shutter. */
      await page.waitForTimeout(900);
      const file = `${OUT}/${shot.name}-${width}.png`;
      await page.screenshot({ path: file });
      console.log(file);
    }

    await context.close();
  }

  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
