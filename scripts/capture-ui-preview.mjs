/**
 * Round 35, widened in Round 36: capture the UI preview's answers
 * (src/web/preview/uiResponses.json) for every screen.
 *
 * Walks the app in the preview's made-up world (`answerInWorld` in
 * ui-preview-fixtures.mjs), with every switch that is on for the live site on
 * and UI_REVAMP on: three local dev servers, the seeded league with the fuller
 * roster, one with PREVIEW=trades and one with PREVIEW=players.
 *
 *   FA_SEED=1 FA_SEED_FULL=1 WAIVERS_LOOKAHEAD=on TRIM_OLD_ROWS=on UI_REVAMP=on \
 *     APP_PASSPHRASE=e2e-passphrase node scripts/dev-server.mjs --port 8791
 *   (the same with PREVIEW=trades on 8792 and PREVIEW=players on 8793)
 *   node scripts/capture-ui-preview.mjs
 *
 * Every GET the screens make is kept as the world answered it, and Compare's
 * verdict is kept for every pair a tap can reach: the roster's pairs, a lineup
 * row's player against anyone (that row's slot), and each waiver pick against
 * the roster. The preview serves these in the browser.
 */

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { answerInWorld } from './ui-preview-fixtures.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const BASE = arg('--base', 'http://127.0.0.1:8791');
const WORLD = { trades: arg('--trades', 'http://127.0.0.1:8792'), players: arg('--players', 'http://127.0.0.1:8793'), revamp: true };
const OUT = 'src/web/preview/uiResponses.json';
const launch = process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {};

const got = {};
const compare = {};
const compareKey = (body) => `${body?.slot ?? ''}|${[...(body?.playerIds ?? [])].sort().join(',')}`;

const browser = await chromium.launch(launch);
const context = await browser.newContext({ viewport: { width: 420, height: 912 }, hasTouch: true });
await context.request.post(BASE + '/api/auth/login', { data: { passphrase: process.env.E2E_PASSPHRASE ?? 'e2e-passphrase' } });
await context.route('**/api/**', async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  try {
    if (request.method() !== 'GET') {
      const response = await route.fetch();
      if (url.pathname === '/api/startsit/compare' && response.status() === 200) compare[compareKey(request.postDataJSON())] = await response.json();
      return route.fulfill({ response });
    }
    let { response, body } = await answerInWorld(route, WORLD);
    if (body === undefined) return route.fulfill({ response });
    /* The preview never unlocks: it is read only. */
    if (url.pathname === '/api/auth/status') body = { ...body, unlocked: false, canUnlock: false };
    got[url.pathname + url.search] = { status: response.status(), body };
    return route.fulfill({ response, body: JSON.stringify(body) });
  } catch {
    /* the page closed while a read was out */
  }
});

const page = await context.newPage();
const pause = (ms = 500) => page.waitForTimeout(ms);
const escape = async () => {
  await page.keyboard.press('Escape').catch(() => {});
  await pause(250);
};
const tapAll = async (selector, limit = 12, after = escape) => {
  const n = Math.min(await page.locator(selector).count(), limit);
  for (let i = 0; i < n; i += 1) {
    await page.locator(selector).nth(i).click().catch(() => {});
    await pause(450);
    await after(i);
  }
};

await page.goto(BASE + '/');
await page.getByTestId('starter-row').first().waitFor();
await pause(1500);
// Team: every starter's card, the bench and its cards, the waiver rows.
await tapAll('[data-testid="starter-row"]');
await page.getByTestId('bench-toggle').first().click().catch(() => {});
await tapAll('[data-testid="bench-row"]');
await tapAll('[data-testid="waiver-tier-row"]', 4);
// Compare's lists.
await page.getByTestId('compare-open').click();
await pause(800);
for (const label of ['Waivers', 'All players', 'My team']) {
  await page.getByRole('button', { name: label, exact: true }).first().click().catch(() => {});
  await pause(700);
}
await escape();
// Matchup: the score's sheet and every card.
await page.getByTestId('tab-matchup').click();
await page.getByTestId('matchup-score').waitFor();
await page.getByTestId('matchup-win').click().catch(() => {});
await pause(500);
await escape();
await tapAll('[data-testid="matchup-player"]', 16);
// Waivers: every pick's sheet and its Compare, every stash, cover and block card, the folds.
await page.getByTestId('tab-waivers').click();
await page.getByTestId('waiver-tier-row').first().waitFor();
await tapAll('[data-testid="waiver-tier-row"]', 8, async () => {
  await page.getByTestId('wsheet-compare-open').click().catch(() => {});
  await pause(900);
  await escape();
  await escape();
});
await tapAll('[data-testid^="waiver-"][data-testid$="-line"]', 6, async () => {
  await pause(700);
  await escape();
});
for (const fold of ['tier-watch-toggle', 'drop-ready-toggle']) await page.getByTestId(fold).click().catch(() => {});
// Trades: every offer's sheet, Check from each, Build from a name.
await page.getByTestId('tab-trades').click();
await page.getByTestId('t2-offer').first().waitFor();
await tapAll('[data-testid="t2-offer"]', 6);
const offers = await page.getByTestId('t2-check-this').count();
for (let i = 0; i < offers; i += 1) {
  await page.getByTestId('t2-tab-offers').click();
  await page.getByTestId('t2-check-this').nth(i).click().catch(() => {});
  await page.getByTestId('t2-check-result').waitFor({ timeout: 5000 }).catch(() => {});
  await pause(400);
}
await page.getByTestId('t2-tab-build').click();
await pause(800);
for (const name of ['Sotelo', 'Holloway', 'Vance']) {
  await page.getByTestId('t2-build-search').or(page.getByRole('searchbox')).first().fill(name).catch(() => {});
  await pause(500);
  await page.locator('[data-testid="t2-build-match"], [data-testid="t2-build-result"]').first().click().catch(() => {});
  await pause(1200);
  await page.getByTestId('t2-build-change').click().catch(() => {});
  await pause(300);
}
// Players: the board's cards, Trade targets and Injured.
await page.getByTestId('tab-players').click();
await page.getByTestId('player-search-row').first().waitFor();
await tapAll('[data-testid="player-search-row"] .dense-row-open', 10);
for (const view of ['p2-view-trade', 'p2-view-injured', 'p2-view-all']) {
  await page.getByTestId(view).click().catch(() => {});
  await pause(300);
}
// Setup and every page behind it.
await page.getByTestId('nav-setup').click();
await page.getByTestId('setup-sections').waitFor();
await pause(800);
for (const row of ['setup-step-sleeper', 'setup-step-league', 'setup-step-newsletter', 'setup-step-vegas', 'setup-review', 'setup-data-health']) {
  await page.getByTestId(row).click().catch(() => {});
  await pause(1500);
  await page.locator('.nav-bar button').first().click().catch(() => {});
  await pause(600);
}

/*
 * Compare's verdict for the pairs a tap can reach: any two from the header (no
 * slot), a lineup row's player against anyone (that row's slot), and each
 * waiver pick against the roster (no slot, as Waivers opens it).
 */
const lineupKey = Object.keys(got).find((k) => /\/lineup$/.test(k));
const rosterKey = Object.keys(got).find((k) => /\/roster$/.test(k));
const waiversKey = Object.keys(got).find((k) => /\/waivers$/.test(k));
const roster = got[rosterKey].body;
const lineup = got[lineupKey].body;
const tiers = got[waiversKey].body.tiers ?? {};
const leagueId = rosterKey.split('/')[3];
const ids = [...(roster.starters ?? []), ...(roster.bench ?? [])].map((p) => p.playerId);
const picks = [
  ...[tiers.doThis, ...(tiers.consider ?? []), ...(tiers.watch ?? [])].filter(Boolean).map((r) => r.playerId),
  tiers.upsideStash?.playerId,
  ...(tiers.cover ?? []).map((c) => c.playerId),
  tiers.block?.playerId,
].filter(Boolean);
const pairs = [];
for (let i = 0; i < ids.length; i += 1) for (let j = i + 1; j < ids.length; j += 1) pairs.push([null, ids[i], ids[j]]);
for (const row of lineup.slots ?? []) {
  if (!row.playerId) continue;
  for (const other of ids) if (other !== row.playerId) pairs.push([row.slot, row.playerId, other]);
}
for (const pick of new Set(picks)) for (const other of ids) pairs.push([null, pick, other]);
for (const [slot, a, b] of pairs) {
  const body = { leagueId, playerIds: [a, b], slot, ...(lineup.mode ? { mode: lineup.mode } : {}) };
  if (compare[compareKey(body)]) continue;
  const res = await context.request.post(BASE + '/api/startsit/compare', { data: body });
  if (res.ok()) compare[compareKey(body)] = await res.json();
}

await context.unrouteAll({ behavior: 'ignoreErrors' });
await browser.close();
writeFileSync(OUT, JSON.stringify({ get: got, compare }));
console.log(`kept ${Object.keys(got).length} reads and ${Object.keys(compare).length} Compare verdicts in ${OUT}`);
