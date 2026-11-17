/**
 * Round 35: capture the UI preview's answers (src/web/preview/uiResponses.json).
 *
 * Walks the app on a local dev server seeded with the made-up league and the
 * fuller roster, in season, with every switch that is on for the live site on:
 *
 *   FA_SEED=1 FA_SEED_FULL=1 WAIVERS_LOOKAHEAD=on TRIM_OLD_ROWS=on UI_REVAMP=on \
 *     APP_PASSPHRASE=e2e-passphrase node scripts/dev-server.mjs --port 8791
 *   node scripts/capture-ui-preview.mjs --base http://127.0.0.1:8791
 *
 * Every GET the screens make is kept as the server answered it (with the same
 * in-season overrides the e2e suite uses), and Compare's verdict is kept for
 * every pair on the roster, by slot. The preview serves these in the browser.
 */

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const BASE = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'http://127.0.0.1:8791';
const OUT = 'src/web/preview/uiResponses.json';
const launch = process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {};

const got = {};
const compare = {};
const compareKey = (body) => `${body?.slot ?? ''}|${[...(body?.playerIds ?? [])].sort().join(',')}`;

function override(path, body) {
  if (path === '/api/overview') {
    return {
      ...body,
      season: { phase: 'regular', draftVisible: false, reason: 'the regular season is under way (week 11)', assumed: false },
      lifecycle: { ...(body.lifecycle ?? {}), lifecycle: 'regular_season', phase: 'regular', draftVisible: false, matchupVisible: true, draftLive: false },
    };
  }
  if (path.endsWith('/roster')) return { ...body, live: false, drafted: [] };
  if (path === '/api/auth/status') return { ...body, unlocked: false, canUnlock: false, features: { ...(body.features ?? {}), uiRevamp: true } };
  return body;
}

const browser = await chromium.launch(launch);
const context = await browser.newContext({ viewport: { width: 420, height: 912 }, hasTouch: true });
await context.request.post(BASE + '/api/auth/login', { data: { passphrase: process.env.E2E_PASSPHRASE ?? 'e2e-passphrase' } });
await context.route('**/api/**', async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const key = url.pathname + url.search;
  const response = await route.fetch();
  let body;
  try {
    body = await response.json();
  } catch {
    return route.fulfill({ response });
  }
  if (request.method() === 'GET') {
    body = override(url.pathname, body);
    got[key] = { status: response.status(), body };
  } else if (url.pathname === '/api/startsit/compare' && response.status() === 200) {
    compare[compareKey(request.postDataJSON())] = body;
  }
  return route.fulfill({ response, body: JSON.stringify(body) });
});

const page = await context.newPage();
const pause = (ms = 500) => page.waitForTimeout(ms);
const tapAll = async (selector, limit = 12) => {
  const n = Math.min(await page.locator(selector).count(), limit);
  for (let i = 0; i < n; i += 1) {
    await page.locator(selector).nth(i).click().catch(() => {});
    await pause(400);
    await page.keyboard.press('Escape').catch(() => {});
    await pause(200);
  }
};

await page.goto(BASE + '/');
await page.getByTestId('starter-row').first().waitFor();
await pause(1500);
// Team: every starter's card, the bench and its cards, the waiver rows.
await tapAll('[data-testid="starter-row"]');
await page.getByTestId('bench-toggle').first().click().catch(() => {});
await tapAll('[data-testid="bench-row"]');
await tapAll('[data-testid="waiver-card"] button', 4);
// Compare's lists.
await page.getByTestId('compare-open').click();
await pause(800);
for (const label of ['Waivers', 'All players', 'My team']) {
  await page.getByRole('button', { name: label, exact: true }).first().click().catch(() => {});
  await pause(700);
}
await page.keyboard.press('Escape');
// Matchup: the score's sheet and every card.
await page.getByTestId('tab-matchup').click();
await page.getByTestId('matchup-score').waitFor();
await page.getByTestId('matchup-win').click().catch(() => {});
await pause(500);
await page.keyboard.press('Escape');
await tapAll('[data-testid="matchup-player"]', 16);
// Waivers, Trades, Players, Setup: what each screen reads first.
for (const id of ['waivers', 'trades', 'players']) {
  await page.getByTestId(`tab-${id}`).click();
  await pause(2500);
}
await tapAll('[data-testid="players-list"] button', 6);
await page.getByTestId('tab-trades').click();
for (const tab of ['t2-tab-build', 't2-tab-check']) {
  await page.getByTestId(tab).click().catch(() => {});
  await pause(1200);
}
await page.getByTestId('tab-team').click();
await page.getByTestId('nav-setup').click().catch(() => {});
await pause(2000);

/*
 * Compare's verdict for the pairs a tap can reach: any two from the header (no
 * slot), and a lineup row's player against anyone (that row's slot).
 */
const lineupKey = Object.keys(got).find((k) => /\/lineup$/.test(k));
const rosterKey = Object.keys(got).find((k) => /\/roster$/.test(k));
const roster = got[rosterKey].body;
const lineup = got[lineupKey].body;
const leagueId = rosterKey.split('/')[3];
const ids = [...(roster.starters ?? []), ...(roster.bench ?? [])].map((p) => p.playerId);
const pairs = [];
for (let i = 0; i < ids.length; i += 1) for (let j = i + 1; j < ids.length; j += 1) pairs.push([null, ids[i], ids[j]]);
for (const row of lineup.slots ?? []) {
  if (!row.playerId) continue;
  for (const other of ids) if (other !== row.playerId) pairs.push([row.slot, row.playerId, other]);
}
for (const [slot, a, b] of pairs) {
  const body = { leagueId, playerIds: [a, b], slot, ...(lineup.mode ? { mode: lineup.mode } : {}) };
  if (compare[compareKey(body)]) continue;
  const res = await context.request.post(BASE + '/api/startsit/compare', { data: body });
  if (res.ok()) compare[compareKey(body)] = await res.json();
}

await browser.close();
writeFileSync(OUT, JSON.stringify({ get: got, compare }));
console.log(`kept ${Object.keys(got).length} reads and ${Object.keys(compare).length} Compare verdicts in ${OUT}`);
