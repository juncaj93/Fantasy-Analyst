/**
 * Measure what a tab switch actually costs.
 *
 * Drives a browser against a running dev-server and reports, for every
 * navigation:
 *   - time from click to the tab lighting up (visual response)
 *   - time from click to usable content on screen
 *   - whether a revisited tab showed nothing on the way back
 *   - every /api/ request the navigation caused, with durations
 *
 *   npm run build && node scripts/build-server.mjs
 *   FA_SEED=1 FA_INSECURE_COOKIES=1 APP_PASSPHRASE=x SESSION_SECRET=$(head -c32 /dev/zero | tr '\0' x) \
 *     node scripts/dev-server.mjs --port 8791 &
 *   LATENCY_MS=250 node scripts/measure-tabs.mjs
 *
 * **`LATENCY_MS` is not optional if you want a meaningful number.** A loopback
 * server answers in single-digit milliseconds and production is a Worker
 * reading D1 over a cellular link, so without it every navigation looks fine
 * and the shape of the flow — how many round trips a switch costs, and whether
 * the screen waits for them — is invisible. 250 is a good phone; 600 is a
 * normal one.
 *
 * This is a diagnostic, not a gate. The regression tests are
 * `e2e/tab-revisit.spec.ts`, which assert the structural property (content is
 * on screen while the request that would have produced it is still in flight)
 * rather than a wall-clock number that a shared runner cannot be trusted with.
 *
 * Chromium: the structural facts are engine-independent and the milliseconds
 * are relative anyway. Point `PW_CHROMIUM_PATH` at a build if the bundled one
 * does not match this Playwright.
 */

import { chromium } from '@playwright/test';

const BASE = process.env.MEASURE_URL ?? 'http://127.0.0.1:8791';

/** What "usable content" means on each tab. */
const USABLE = {
  draft: '[data-testid="board-list"]',
  team: '[data-testid="starters-title"]',
  players: '[data-testid="players-list"]',
  matchup: '[data-testid="leverage-list"]',
  waivers: '[data-testid="waivers-pending"]',
  trades: '[data-testid="trade-row"], [data-testid="trade-windows"]',
};

async function instrument(page) {
  await page.addInitScript(() => {
    window.__perf = { requests: [], marks: [] };
    const original = window.fetch;
    window.fetch = async (...args) => {
      const url = typeof args[0] === 'string' ? args[0] : args[0].url;
      const entry = { url, start: performance.now(), end: null };
      if (url.includes('/api/')) window.__perf.requests.push(entry);
      try {
        return await original(...args);
      } finally {
        entry.end = performance.now();
      }
    };
  });
}

/** Everything the page recorded, then reset the log. */
async function drain(page) {
  return page.evaluate(() => {
    const requests = window.__perf.requests.map((r) => ({
      path: new URL(r.url, location.origin).pathname + new URL(r.url, location.origin).search,
      ms: r.end === null ? null : Math.round(r.end - r.start),
    }));
    window.__perf.requests = [];
    return requests;
  });
}

/**
 * Click a tab and watch what happens, frame by frame.
 *
 * The sampler runs inside the page on requestAnimationFrame, so "the screen
 * went blank" is observed rather than inferred: it records, every frame, how
 * many usable-content nodes are present. A revisit that keeps its content
 * never reports zero; one that remounts does.
 */
const visited = new Set();

async function navigate(page, to, { settleMs = 4000 } = {}) {
  const selector = USABLE[to];
  const revisit = visited.has(to);
  await drain(page);

  const result = await page.evaluate(
    async ([tab, sel, settle]) => {
      const button = document.querySelector(`[data-testid="tab-${tab}"]`);
      const t0 = performance.now();
      let tabLit = null;
      let firstUsable = null;
      let wentBlank = false;
      let sawContentBefore = document.querySelectorAll(sel).length > 0;

      button.click();

      await new Promise((resolve) => {
        const tick = () => {
          const count = document.querySelectorAll(sel).length;
          if (tabLit === null && button.getAttribute('aria-current') === 'page') {
            tabLit = performance.now() - t0;
          }
          if (count === 0 && sawContentBefore) wentBlank = true;
          if (count > 0 && firstUsable === null) firstUsable = performance.now() - t0;
          if (performance.now() - t0 > settle) return resolve();
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });

      return {
        tabLitMs: tabLit === null ? null : Math.round(tabLit),
        usableMs: firstUsable === null ? null : Math.round(firstUsable),
        wentBlank,
        hadContentBefore: sawContentBefore,
      };
    },
    [to, selector, settleMs],
  );

  result.requests = await drain(page);
  result.revisit = revisit;
  if (result.usableMs !== null) visited.add(to);
  return result;
}

function line(label, r) {
  const usable = r.usableMs === null ? 'NEVER' : `${r.usableMs}ms`;
  const lit = r.tabLitMs === null ? 'n/a' : `${r.tabLitMs}ms`;
  const blank = !r.revisit
    ? 'first visit'
    : r.usableMs === null
      ? 'REVISIT — content never came back'
      : r.usableMs <= 50
        ? 'revisit — content was already there'
        : `REVISIT — ${r.usableMs}ms of nothing on screen before content returned`;
  console.log(`\n${label}`);
  console.log(`  tab lit:        ${lit}`);
  console.log(`  usable content: ${usable}`);
  console.log(`  during switch:  ${blank}`);
  console.log(`  requests:       ${r.requests.length}`);
  for (const req of r.requests) console.log(`    ${String(req.ms ?? '?').padStart(5)}ms  ${req.path}`);
}

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  hasTouch: true,
});
const page = await context.newPage();
await instrument(page);

/*
 * A phone, not a loopback socket.
 *
 * Every measurement below is worthless without this. The server here answers
 * in single-digit milliseconds because it is on the same machine; production
 * is a Cloudflare Worker reading D1 over a cellular link, and the reported
 * symptom is one to two seconds. LATENCY_MS adds a fixed delay to every /api/
 * call so the shape of the flow — how many round trips a tab switch costs, and
 * whether the screen waits for them — shows up at the scale the user sees.
 */
const LATENCY_MS = Number(process.env.LATENCY_MS ?? 0);
if (LATENCY_MS > 0) {
  await page.route('**/api/**', async (route) => {
    await new Promise((r) => setTimeout(r, LATENCY_MS));
    await route.continue();
  });
  console.log(`(simulating ${LATENCY_MS}ms of latency on every /api/ call)`);
}

console.log(`=== measuring ${BASE} ===`);

const coldStart = Date.now();
await page.goto(BASE);
await page.waitForSelector(USABLE.draft, { timeout: 30_000 });
console.log(`\ncold first open of Draft (navigation to usable board): ${Date.now() - coldStart}ms`);
visited.add('draft');
console.log('  requests during cold load:');
for (const req of await drain(page)) console.log(`    ${String(req.ms ?? '?').padStart(5)}ms  ${req.path}`);

line('1. Draft -> Team (first visit to Team)', await navigate(page, 'team'));
line('2. Team -> Draft (REVISIT: Draft was open moments ago)', await navigate(page, 'draft'));
line('3. Draft -> Players (first visit)', await navigate(page, 'players'));
line('4. Players -> Draft (REVISIT)', await navigate(page, 'draft'));
line('5. Draft -> Team (REVISIT)', await navigate(page, 'team'));
line('6. Team -> Players (REVISIT)', await navigate(page, 'players'));

const matchupTab = await page.$('[data-testid="tab-matchup"]');
if (matchupTab) {
  line('7. Players -> Matchup (first visit)', await navigate(page, 'matchup'));
  line('8. Matchup -> Team (REVISIT)', await navigate(page, 'team'));
} else {
  console.log('\n(Matchup is not in the tab bar in this lifecycle state — skipped.)');
}

console.log('\n--- idling 45s, then repeating the revisits ---');
await page.waitForTimeout(45_000);
line('9. after 45s idle: Team -> Draft (REVISIT)', await navigate(page, 'draft'));
line('10. after 45s idle: Draft -> Team (REVISIT)', await navigate(page, 'team'));

await browser.close();
