/**
 * Round 36: before and after screenshots of Waivers, Trades, Players and Setup.
 *
 * Three views per screen, each in light and dark, at the iPhone Air's width
 * (420 x 912 points), in the preview's made-up world (`previewWorld` in
 * ui-preview-fixtures.mjs): three local dev servers, the seeded league, one
 * with PREVIEW=trades and one with PREVIEW=players.
 *
 *   FA_SEED=1 FA_SEED_FULL=1 APP_PASSPHRASE=e2e-passphrase node scripts/dev-server.mjs --port 8791
 *   (the same with PREVIEW=trades on 8792 and PREVIEW=players on 8793)
 *   node scripts/ui-screenshots-2.mjs --label before --out docs/ui/shots
 *   node scripts/ui-screenshots-2.mjs --label after --revamp --out docs/ui/shots
 *   node scripts/ui-screenshots-2.mjs --pair /tmp/shots --out docs/ui/shots
 *
 * `--pair` writes one picture per view: before and after in light, then
 * before and after in dark.
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { previewWorld } from './ui-preview-fixtures.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const BASE = arg('--base', 'http://127.0.0.1:8791');
const TRADES = arg('--trades', 'http://127.0.0.1:8792');
const PLAYERS = arg('--players', 'http://127.0.0.1:8793');
const LABEL = arg('--label', 'before');
const OUT = arg('--out', 'docs/ui/shots');
const REVAMP = args.includes('--revamp');
const PAIR = arg('--pair', null);
const launch = process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {};

export const VIEWS_2 = [
  ['waivers', 'top'],
  ['waivers', 'sheet'],
  ['waivers', 'extra'],
  ['trades', 'offers'],
  ['trades', 'sheet'],
  ['trades', 'check'],
  ['players', 'board'],
  ['players', 'card'],
  ['players', 'targets'],
  ['setup', 'top'],
  ['setup', 'more'],
  ['setup', 'health'],
];

const settle = (page) => page.waitForTimeout(700);

async function openSetup(page) {
  const gear = page.getByTestId('nav-setup');
  if (await gear.count()) await gear.first().click();
  else await page.getByTestId('tab-setup').click();
  await page.getByTestId('setup-group-data').or(page.getByTestId('setup-sections')).first().waitFor();
}

async function show(page, screen, view) {
  await page.goto(BASE + '/');
  await page.getByTestId('starter-row').first().waitFor();
  if (screen === 'waivers') {
    await page.getByTestId('tab-waivers').click();
    await page.getByTestId('waiver-tier-row').first().waitFor();
    if (view === 'sheet') await page.getByTestId('waiver-tier-row').first().click();
    if (view === 'extra') {
      const stash = page.getByTestId('waiver-stash-line');
      await stash.scrollIntoViewIfNeeded();
      if (REVAMP) {
        await stash.click();
        await page.getByTestId('compare-sheet').or(page.locator('.sheet')).first().waitFor();
      } else await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    }
  }
  if (screen === 'trades') {
    await page.getByTestId('tab-trades').click();
    await page.getByTestId('t2-offer').first().waitFor();
    if (view === 'sheet') await page.getByTestId('t2-offer').first().click();
    if (view === 'check') {
      await page.getByTestId('t2-check-this').first().click();
      await page.getByTestId('t2-check-result').waitFor();
    }
  }
  if (screen === 'players') {
    await page.getByTestId('tab-players').click();
    await page.getByTestId('player-search-row').first().waitFor();
    if (view === 'card') {
      await page.locator('[data-testid="player-search-row"] .dense-row-open').first().click();
      await page.waitForTimeout(800);
    }
    if (view === 'targets') {
      await page.getByTestId('p2-view-trade').click();
      await page.waitForTimeout(400);
    }
  }
  if (screen === 'setup') {
    await openSetup(page);
    if (view === 'more') {
      const fold = page.getByTestId('setup-group-data');
      if (await fold.count()) await fold.locator('button').first().click();
      await page.evaluate(() => window.scrollBy(0, 360));
    }
    if (view === 'health') {
      const fold = page.getByTestId('setup-group-data');
      if (await fold.count()) await fold.locator('button').first().click();
      await page.getByTestId('setup-data-health').or(page.getByText('Data health').first()).first().click();
      await page.waitForTimeout(1200);
    }
  }
  await settle(page);
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(launch);
if (PAIR) {
  const page = await browser.newPage({ viewport: { width: 1740, height: 990 }, deviceScaleFactor: 1 });
  for (const [screen, view] of VIEWS_2) {
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
  process.exit(0);
}
for (const theme of ['light', 'dark']) {
  const context = await browser.newContext({ viewport: { width: 420, height: 912 }, deviceScaleFactor: 1, colorScheme: theme, hasTouch: true });
  await previewWorld(context, { trades: TRADES, players: PLAYERS, revamp: REVAMP });
  await context.request.post(BASE + '/api/auth/login', { data: { passphrase: process.env.E2E_PASSPHRASE ?? 'e2e-passphrase' } });
  const page = await context.newPage();
  for (const [screen, view] of VIEWS_2) {
    await show(page, screen, view);
    await page.screenshot({ path: join(OUT, `${screen}-${view}-${theme}-${LABEL}.png`) });
  }
  await context.close();
}
await browser.close();
