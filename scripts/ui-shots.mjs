/**
 * Screenshot and measure the app at the four iPhone portrait widths.
 *
 * A development aid, not a test: the e2e suite asserts, this looks. It logs in
 * once, walks the screens named on the command line, and writes a PNG per
 * screen per width plus a JSON of whatever measurements the screen declares.
 *
 *   node scripts/ui-shots.mjs --out /tmp/shots --widths 390,360 draft team
 *
 * With no screen names it does all of them. The server is expected to be
 * running already (npm run dev, or the e2e webServer command).
 */

import { chromium, webkit } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
}

const OUT = flag('out', '/tmp/shots');
const BASE = flag('base', 'http://127.0.0.1:8788');
const ENGINE = flag('engine', 'chromium');
const WIDTHS = flag('widths', '430,390,375,360').split(',').map(Number);
const PASSPHRASE = process.env.E2E_PASSPHRASE ?? 'e2e-passphrase';
const names = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));

const CHROMIUM_CANDIDATES = [
  process.env.PW_CHROMIUM_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium',
  '/usr/bin/chromium',
].filter((p) => p && existsSync(p));

/** Every screen this can visit, and what it measures once it is there. */
const SCREENS = {
  draft: {
    async go(page) {
      await page.goto(`${BASE}/`);
      await page.getByTestId('board-list').waitFor({ state: 'visible' });
    },
    measure: () => {
      const rows = [...document.querySelectorAll('[data-testid="recommendation-row"]')];
      const marks = rows
        .map((r) => r.querySelector('.team-logo, .team-code'))
        .filter(Boolean)
        .map((m) => Math.round(m.getBoundingClientRect().left));
      const names = rows
        .map((r) => r.querySelector('.player-name'))
        .filter(Boolean)
        .map((n) => Math.round(n.getBoundingClientRect().left));
      const seg = document.querySelector('[data-testid="draft-sort"]');
      return {
        rows: rows.length,
        rowHeight: rows[0] ? Math.round(rows[0].getBoundingClientRect().height) : null,
        markLefts: [...new Set(marks)],
        nameLefts: [...new Set(names)],
        sortWidth: seg ? Math.round(seg.getBoundingClientRect().width) : null,
      };
    },
  },
  team: {
    async go(page) {
      await page.goto(`${BASE}/`);
      await page.getByTestId('tab-team').click();
      await page.locator('[data-testid="drafted-line"]').first().waitFor({ state: 'visible' });
    },
    measure: () => {
      const lines = [...document.querySelectorAll('[data-testid="drafted-line"]')];
      const card = document.querySelector('[data-testid="live-draft-card"]');
      return {
        lines: lines.length,
        lineHeight: lines[0] ? Math.round(lines[0].getBoundingClientRect().height) : null,
        cardHeight: card ? Math.round(card.getBoundingClientRect().height) : null,
        aboveFold: lines.filter((l) => l.getBoundingClientRect().bottom <= window.innerHeight).length,
      };
    },
  },
  trades: {
    async go(page) {
      await page.goto(`${BASE}/`);
      await page.getByTestId('tab-trades').click();
      await page.locator('[data-testid="trade-row"]').first().waitFor({ state: 'visible' });
    },
    measure: () => {
      const rows = [...document.querySelectorAll('[data-testid="trade-row"]')];
      return {
        rows: rows.length,
        rowHeight: rows[0] ? Math.round(rows[0].getBoundingClientRect().height) : null,
      };
    },
  },
  players: {
    async go(page) {
      await page.goto(`${BASE}/`);
      await page.getByTestId('tab-players').click();
      await page.locator('[data-testid="player-search-row"]').first().waitFor({ state: 'visible' });
    },
    measure: () => {
      const rows = [...document.querySelectorAll('[data-testid="player-search-row"]')];
      const marks = rows
        .map((r) => r.querySelector('.team-logo, .team-code'))
        .filter(Boolean)
        .map((m) => Math.round(m.getBoundingClientRect().left));
      return {
        rows: rows.length,
        rowHeight: rows[0] ? Math.round(rows[0].getBoundingClientRect().height) : null,
        markLefts: [...new Set(marks)],
      };
    },
  },
  waivers: {
    async go(page) {
      await page.goto(`${BASE}/?demo=waivers-tuesday-active`);
      await page.getByTestId('tab-waivers').click();
      await page.locator('[data-testid="waiver-row"]').first().waitFor({ state: 'visible' });
    },
    measure: () => {
      const rows = [...document.querySelectorAll('[data-testid="waiver-row"]')];
      return {
        rows: rows.length,
        rowHeight: rows[0] ? Math.round(rows[0].getBoundingClientRect().height) : null,
      };
    },
  },
  ...Object.fromEntries(
    ['matchup-live-leading', 'matchup-live-trailing', 'matchup-live-close', 'matchup-final'].map((id) => [
      id,
      matchupScreen(id),
    ]),
  ),
  /* The same two screens under a named draft scenario, to prove they are not
     tuned to whichever league the seed happens to carry. */
  ...Object.fromEntries(
    ['draft-best-ball', 'draft-mid', 'draft-early'].flatMap((id) => [
      [`${id}-draft`, scenarioScreen(id, null, 'board-list')],
      [`${id}-team`, scenarioScreen(id, 'team', 'drafted-line')],
    ]),
  ),
};

function scenarioScreen(scenario, tab, waitFor) {
  return {
    async go(page) {
      await page.goto(`${BASE}/?demo=${scenario}`);
      if (tab) await page.getByTestId(`tab-${tab}`).click();
      await page.locator(`[data-testid="${waitFor}"]`).first().waitFor({ state: 'visible' });
    },
    measure: () => {
      const card = document.querySelector('[data-testid="live-draft-card"]');
      const lines = [...document.querySelectorAll('[data-testid="drafted-line"]')];
      return {
        bestMove: document.querySelector('[data-testid="best-move"]')?.textContent ?? null,
        cardHeight: card ? Math.round(card.getBoundingClientRect().height) : null,
        lines: lines.length,
        aboveFold: lines.filter((l) => l.getBoundingClientRect().bottom <= window.innerHeight).length,
      };
    },
  };
}

function matchupScreen(scenario) {
  return {
    async go(page) {
      await page.goto(`${BASE}/?demo=${scenario}`);
      await page.getByTestId('tab-matchup').click();
      await page.getByTestId('matchup-score').waitFor({ state: 'visible' });
    },
    measure: () => {
      const card = document.querySelector('[data-testid="matchup-score"]');
      const bar = document.querySelector('[data-testid="matchup-win-bar"]');
      const fill = document.querySelector('.matchup-win-fill');
      const mine = document.querySelector('[data-testid="matchup-team-mine"]');
      const theirs = document.querySelector('[data-testid="matchup-team-theirs"]');
      const centre = (el) => (el ? Math.round(el.getBoundingClientRect().left + el.getBoundingClientRect().width / 2) : null);
      const pick = (root, sel) => (root ? root.querySelector(sel) : null);
      return {
        cardHeight: card ? Math.round(card.getBoundingClientRect().height) : null,
        tone: bar?.getAttribute('data-tone') ?? null,
        minePct: bar?.getAttribute('aria-valuenow') ?? null,
        fillColour: fill ? getComputedStyle(fill).backgroundColor : null,
        mineNameCentre: centre(pick(mine, '.matchup-team-name')),
        mineScoreCentre: centre(pick(mine, '.matchup-team-score')),
        theirsNameCentre: centre(pick(theirs, '.matchup-team-name')),
        theirsScoreCentre: centre(pick(theirs, '.matchup-team-score')),
      };
    },
  };
}

const wanted = names.length > 0 ? names : Object.keys(SCREENS);

await mkdir(OUT, { recursive: true });

const launch = ENGINE === 'webkit' ? webkit : chromium;
const browser = await launch.launch(
  ENGINE === 'chromium' && CHROMIUM_CANDIDATES[0] ? { executablePath: CHROMIUM_CANDIDATES[0] } : {},
);

const report = {};
for (const width of WIDTHS) {
  const context = await browser.newContext({
    viewport: { width, height: width >= 430 ? 932 : width >= 390 ? 844 : width >= 375 ? 812 : 800 },
    deviceScaleFactor: 2,
    hasTouch: true,
  });
  const login = await context.request.post(`${BASE}/api/auth/login`, { data: { passphrase: PASSPHRASE } });
  if (login.status() !== 200) throw new Error(`login failed: ${login.status()}`);

  for (const name of wanted) {
    const screen = SCREENS[name];
    if (!screen) throw new Error(`unknown screen: ${name}`);
    const page = await context.newPage();
    try {
      await screen.go(page);
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${OUT}/${name}-${width}.png`, fullPage: false });
      report[`${name}-${width}`] = {
        ...(await page.evaluate(screen.measure)),
        horizontalOverflow: await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
        ),
        scrollWidth: await page.evaluate(() => document.documentElement.scrollWidth),
      };
    } catch (err) {
      report[`${name}-${width}`] = { error: String(err).slice(0, 300) };
      await page.screenshot({ path: `${OUT}/${name}-${width}-FAILED.png` }).catch(() => {});
    }
    await page.close();
  }
  await context.close();
}

await browser.close();
await writeFile(`${OUT}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
