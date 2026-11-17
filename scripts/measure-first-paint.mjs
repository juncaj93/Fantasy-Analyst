/**
 * Round 35: time to first useful paint, per screen, on a throttled phone.
 *
 * Runs the built app against a local dev server (`FA_SEED=1`, in season by
 * the same overrides the e2e suite uses) in Chromium with Lighthouse's mobile
 * profile: CPU 4x slower, 150 ms round trip, 1.6 Mbps down, 750 kbps up. Every
 * `/api/` answer is held for the time production took to answer it in the
 * Round 29 audit (docs/audit/round29-probe.txt), so a screen waiting on a slow
 * server read shows that wait here too.
 *
 * "First useful paint" is the first frame the screen's answer is on the glass:
 * Team's first lineup row, Matchup's scoreboard, a Waivers row, a Trades offer,
 * a Players row, a Compare pool row. It is recorded inside the page by a
 * MutationObserver, so the number is the app's and not Playwright's polling.
 *
 *   node scripts/measure-first-paint.mjs --base http://127.0.0.1:8790 [--revamp] [--runs 3] [--out file.json]
 *
 * `--revamp` answers the status read with `uiRevamp: true` (the UI_REVAMP
 * switch), which is how the after numbers are taken without changing the
 * server.
 *
 * Round 36 adds Setup (from the gear, or the Setup tab without the switch)
 * and, with `--trades URL --players URL`, the preview's made-up world: the
 * Trades reads from a server run with PREVIEW=trades, the Players board from
 * one with PREVIEW=players, and Waivers with the preview's picks
 * (scripts/ui-preview-fixtures.mjs), so every screen has rows to paint.
 */

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { withPreviewWaivers } from './ui-preview-fixtures.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const BASE = arg('--base', 'http://127.0.0.1:8790');
const RUNS = Number(arg('--runs', '3'));
const REVAMP = args.includes('--revamp');
const OUT = arg('--out', null);
const TRADES = arg('--trades', null);
const PLAYERS = arg('--players', null);

/** Production answer times from the Round 29 probe, in milliseconds. */
const SERVER_MS = [
  [/\/api\/overview$/, 116],
  [/\/api\/leagues$/, 139],
  [/\/api\/auth\/status$/, 116],
  [/\/roster$/, 233],
  [/\/lineup$/, 474],
  [/\/waivers$/, 1236],
  [/\/matchup$/, 421],
  [/\/compare-pool/, 302],
  [/\/api\/players\/season/, 1338],
  [/\/api\/trades\/screens\/offers/, 1285],
  [/\/api\/trades\/screens\/teams/, 139],
  /* Not in the Round 29 probe: assumed, the same for before and after. */
  [/\/api\/setup\/status$/, 600],
];
const serverMs = (url) => SERVER_MS.find(([re]) => re.test(new URL(url).pathname))?.[1] ?? 150;

/** What counts as the screen's answer being on the glass. */
const USEFUL = {
  team: '[data-testid="starter-row"]',
  matchup: '[data-testid="matchup-score"]',
  waivers: '[data-testid="waivers-recommended"] button, [data-testid="waivers-others"] button, [data-testid="waivers-unscored"], [data-testid="waivers-no-move"]',
  trades: '[data-testid="t2-offer-card"], [data-testid="t2-offers-none"]',
  players: '[data-testid="players-list"] button',
  compare: '[data-testid="compare-candidate"]',
  /* The first thing Setup draws from its read: the Data fold (before) or the first row (after). */
  setup: '[data-testid="setup-group-data-toggle"], [data-testid="setup-step-sleeper"]',
};

const INIT = `(() => {
  const want = ${JSON.stringify(USEFUL)};
  window.__marks = {};
  window.__tapAt = null;
  const check = () => {
    for (const [k, sel] of Object.entries(want)) {
      if (window.__marks[k] != null && window.__marks[k] > (window.__tapAt ?? -1)) continue;
      const el = document.querySelector(sel);
      if (el && el.getBoundingClientRect().height > 0) window.__marks[k] = performance.now();
    }
  };
  new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true });
  addEventListener('click', () => { window.__tapAt = performance.now(); }, true);
})();`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function install(context) {
  await context.addInitScript(INIT);
  await context.route('**/api/**', async (route) => {
    const url = route.request().url();
    await sleep(serverMs(url));
    const { pathname: path, search } = new URL(url);
    const from = TRADES && path.startsWith('/api/trades/screens/') ? TRADES : PLAYERS && /^\/api\/players\/season$/.test(path) ? PLAYERS : null;
    if (from) {
      await route.fulfill({ response: await route.fetch({ url: from + path + search }) });
      return;
    }
    if (TRADES && path.endsWith('/waivers')) {
      const response = await route.fetch();
      await route.fulfill({ response, body: JSON.stringify(withPreviewWaivers(await response.json())) });
      return;
    }
    if (/\/api\/overview$|\/roster$|\/api\/auth\/status$/.test(path)) {
      const response = await route.fetch();
      const body = await response.json();
      let next = body;
      if (path.endsWith('/overview')) {
        next = {
          ...body,
          season: { phase: 'regular', draftVisible: false, reason: 'the regular season is under way (week 11)', assumed: false },
          lifecycle: { ...(body.lifecycle ?? {}), lifecycle: 'regular_season', phase: 'regular', draftVisible: false, matchupVisible: true, draftLive: false },
        };
      } else if (path.endsWith('/roster')) {
        next = { ...body, live: false, drafted: [] };
      } else if (REVAMP) {
        next = { ...body, features: { ...(body.features ?? {}), uiRevamp: true } };
      }
      await route.fulfill({ response, body: JSON.stringify(next) });
      return;
    }
    await route.continue();
  });
}

async function throttle(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 150,
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
}

async function mark(page, key, since) {
  await page.waitForFunction(
    ([k, s]) => window.__marks[k] != null && window.__marks[k] > s,
    [key, since],
    { timeout: 30_000, polling: 50 },
  );
  return page.evaluate(([k, s]) => Math.round(window.__marks[k] - s), [key, since]);
}

async function tapTo(page, tab, key) {
  const before = await page.evaluate(() => performance.now());
  await page.getByTestId(`tab-${tab}`).click();
  const tapAt = await page.evaluate(() => window.__tapAt);
  return mark(page, key, Math.max(tapAt ?? before, before));
}

async function visit(page) {
  const out = {};
  out.team = await mark(page, 'team', 0);
  out.matchup = await tapTo(page, 'matchup', 'matchup');
  out.waivers = await tapTo(page, 'waivers', 'waivers');
  out.trades = await tapTo(page, 'trades', 'trades');
  out.players = await tapTo(page, 'players', 'players');
  {
    const before = await page.evaluate(() => performance.now());
    const gear = page.getByTestId('nav-setup');
    await ((await gear.count()) ? gear.first() : page.getByTestId('tab-setup')).click();
    const tapAt = await page.evaluate(() => window.__tapAt);
    out.setup = await mark(page, 'setup', Math.max(tapAt ?? before, before));
  }
  await page.getByTestId('tab-team').click();
  await page.getByTestId('starter-row').first().waitFor();
  const before = await page.evaluate(() => performance.now());
  await page.getByTestId('compare-open').click();
  const tapAt = await page.evaluate(() => window.__tapAt);
  out.compare = await mark(page, 'compare', Math.max(tapAt ?? before, before));
  return out;
}

const browser = await chromium.launch(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {});
const results = { first: [], again: [] };
for (let run = 0; run < RUNS; run += 1) {
  const context = await browser.newContext({ viewport: { width: 420, height: 912 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
  await install(context);
  const page = await context.newPage();
  await throttle(page);
  await page.goto(BASE + '/');
  results.first.push(await visit(page));
  // Coming back later: a new page load in the same browser (storage kept, memory gone).
  await page.goto('about:blank');
  await page.goto(BASE + '/');
  results.again.push(await visit(page));
  await context.unrouteAll({ behavior: 'ignoreErrors' });
  await context.close();
}
await browser.close();

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const summary = {};
for (const kind of ['first', 'again']) {
  summary[kind] = {};
  for (const key of Object.keys(USEFUL)) summary[kind][key] = median(results[kind].map((r) => r[key]));
}
console.log(JSON.stringify({ revamp: REVAMP, runs: RUNS, summary }, null, 2));
if (OUT) writeFileSync(OUT, JSON.stringify({ revamp: REVAMP, runs: RUNS, summary, results }, null, 2));
