/**
 * Round 35: before and after screenshots of Team, Matchup and Compare.
 *
 * Three views per screen, each in light and dark, at the iPhone Air's width
 * (420 x 912 points), against a local dev server (`FA_SEED=1`) put in season
 * by the same overrides the e2e suite uses. `--revamp` answers the status read
 * with the UI_REVAMP switch on.
 *
 *   node scripts/ui-screenshots.mjs --base http://127.0.0.1:8790 --label before --out docs/ui/shots
 *   node scripts/ui-screenshots.mjs --base http://127.0.0.1:8790 --label after --revamp --out docs/ui/shots
 *   node scripts/ui-screenshots.mjs --pair docs/ui/shots --out docs/ui
 *
 * `--pair` writes one picture per view: before on the left, after on the
 * right, light above dark.
 */

import { chromium } from 'playwright';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const BASE = arg('--base', 'http://127.0.0.1:8790');
const LABEL = arg('--label', 'before');
const OUT = arg('--out', 'docs/ui/shots');
const PAIR = arg('--pair', null);
const REVAMP = args.includes('--revamp');
const launch = process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {};

const VIEWS = [
  ['team', 'top'],
  ['team', 'bench'],
  ['team', 'card'],
  ['matchup', 'top'],
  ['matchup', 'rows'],
  ['matchup', 'card'],
  ['compare', 'picker'],
  ['compare', 'result'],
  ['compare', 'detail'],
];

async function inSeason(context) {
  await context.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!/\/api\/overview$|\/roster$|\/api\/auth\/status$/.test(path)) return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    let next = body;
    if (path.endsWith('/overview')) {
      next = {
        ...body,
        season: { phase: 'regular', draftVisible: false, reason: 'the regular season is under way (week 11)', assumed: false },
        lifecycle: { ...(body.lifecycle ?? {}), lifecycle: 'regular_season', phase: 'regular', draftVisible: false, matchupVisible: true, draftLive: false },
      };
    } else if (path.endsWith('/roster')) next = { ...body, live: false, drafted: [] };
    else if (REVAMP) next = { ...body, features: { ...(body.features ?? {}), uiRevamp: true } };
    return route.fulfill({ response, body: JSON.stringify(next) });
  });
}

const settle = (page) => page.waitForTimeout(700);

async function show(page, screen, view) {
  await page.goto(BASE + '/');
  await page.getByTestId('starter-row').first().waitFor();
  if (screen === 'team') {
    if (view === 'bench') {
      await page.getByTestId('bench-toggle').first().click();
      await page.getByTestId('bench-toggle').first().scrollIntoViewIfNeeded();
      await page.evaluate(() => window.scrollBy(0, 120));
    }
    if (view === 'card') await page.getByTestId('starter-row').nth(1).click();
  }
  if (screen === 'matchup') {
    await page.getByTestId('tab-matchup').click();
    await page.getByTestId('matchup-score').waitFor();
    if (view === 'rows') {
      await page.getByTestId('bench-toggle').first().click();
      await page.waitForTimeout(300);
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    }
    if (view === 'card') await page.getByTestId('matchup-player').first().click();
  }
  if (screen === 'compare') {
    await page.getByTestId('compare-open').click();
    await page.getByTestId('compare-candidate').first().waitFor();
    if (view !== 'picker') {
      await page.getByTestId('compare-candidate').nth(0).click();
      await page.getByTestId('compare-candidate').nth(1).click();
      // The new look has a Compare button in its bottom bar (Round 36); the old one's is in the header.
      const go = page.getByTestId('compare-go');
      await ((await go.count()) ? go : page.getByTestId('compare-add')).click();
      await page.getByTestId('comparison').waitFor();
      if (view === 'detail') {
        // Three players: "+ Add", a third, then back to the answer.
        await page.getByTestId('compare-add').click();
        await page.getByTestId('compare-candidate').nth(2).click();
        const again = page.getByTestId('compare-go');
        await ((await again.count()) ? again : page.getByTestId('compare-add')).click();
        await page.getByTestId('comparison').waitFor();
      }
    }
  }
  await settle(page);
}

if (PAIR) {
  const browser = await chromium.launch(launch);
  const page = await browser.newPage({ viewport: { width: 1720, height: 1880 }, deviceScaleFactor: 1 });
  mkdirSync(OUT, { recursive: true });
  for (const [screen, view] of VIEWS) {
    const src = (label, theme) => {
      const file = resolve(join(PAIR, `${screen}-${view}-${theme}-${label}.png`));
      return existsSync(file) ? `data:image/png;base64,${readFileSync(file).toString('base64')}` : '';
    };
    const cell = (label, theme) => `<figure><figcaption>${label}, ${theme}</figcaption><img src="${src(label, theme)}"></figure>`;
    await page.setContent(`<!doctype html><style>
      body{margin:0;background:#888;font:600 28px system-ui;color:#fff}
      main{display:grid;grid-template-columns:repeat(4,420px);gap:12px;padding:12px}
      figure{margin:0}figcaption{padding:4px 0 8px}img{width:420px;height:912px;display:block;border-radius:10px}
    </style><main>${cell('before', 'light')}${cell('after', 'light')}${cell('before', 'dark')}${cell('after', 'dark')}</main>`);
    await page.setViewportSize({ width: 4 * 420 + 5 * 12, height: 912 + 70 });
    await page.screenshot({ path: join(OUT, `${screen}-${view}.jpg`), type: 'jpeg', quality: 72 });
  }
  await browser.close();
} else {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch(launch);
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 420, height: 912 }, deviceScaleFactor: 1, colorScheme: theme, hasTouch: true });
    await inSeason(context);
    // Compare's verdict is a POST, which needs the passphrase (the e2e one by default).
    await context.request.post(BASE + '/api/auth/login', { data: { passphrase: process.env.E2E_PASSPHRASE ?? 'e2e-passphrase' } });
    const page = await context.newPage();
    for (const [screen, view] of VIEWS) {
      await show(page, screen, view);
      await page.screenshot({ path: join(OUT, `${screen}-${view}-${theme}-${LABEL}.png`) });
    }
    await context.close();
  }
  await browser.close();
}
