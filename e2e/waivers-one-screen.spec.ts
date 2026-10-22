/**
 * Waivers on one screen, and the sheet a move opens (22 October 2026).
 *
 * The page: Do this, Worth considering (three, then "Show all"), and the long
 * lists folded like Team's bench. In its default state it needs no vertical
 * scroll at 390 x 844 or 430 x 932, over the seeded demo league the support
 * fixture is captured from. The content height at 360 x 740 and 375 x 667 is
 * measured and attached for the report, not asserted.
 *
 * The sheet: the two players side by side, and nothing else. This week's
 * numbers are the Compare screen's for the same two players; a three-week
 * total is the sum of its weeks; it fits 390 x 844 without scrolling and a
 * swipe still closes it.
 */

import { expect, test, type Page } from '@playwright/test';
import { inSeason, swipeSheetAway } from './helpers.ts';

async function openWaivers(page: Page) {
  await inSeason(page);
  await page.route('**/api/overview', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      body: JSON.stringify({ ...body, season: { phase: 'regular', draftVisible: false, reason: 'the regular season is under way', assumed: false } }),
    });
  });
  await page.goto('/');
  await page.getByTestId('tab-waivers').click();
  await expect(page.getByTestId('waivers-nav')).toBeVisible();
  await expect(page.getByTestId('waiver-tier-row').first()).toBeVisible();
}

/** How tall the page is, and how far past the screen it runs. */
async function pageHeight(page: Page): Promise<{ content: number; overflow: number }> {
  await page.waitForTimeout(300);
  return page.evaluate(() => {
    /* Where the last thing on the page ends, the tab bar included: the document is never shorter than the screen. */
    let bottom = 0;
    for (const el of document.querySelectorAll('.app-main *')) {
      const r = el.getBoundingClientRect();
      if (r.height > 0 && getComputedStyle(el).position !== 'fixed') bottom = Math.max(bottom, r.bottom + window.scrollY);
    }
    const bar = document.querySelector('.tabbar') as HTMLElement | null;
    const barHeight = bar && getComputedStyle(bar).position === 'fixed' ? bar.getBoundingClientRect().height : 0;
    const main = document.querySelector('.app-main') as HTMLElement;
    const pad = parseFloat(getComputedStyle(main).paddingBottom) || 0;
    return { content: Math.round(bottom + Math.max(pad, barHeight)), overflow: document.documentElement.scrollHeight - window.innerHeight };
  });
}

test.describe('the page fits one screen', () => {
  test('needs no vertical scroll at 390 x 844 and 430 x 932; measures 360 x 740 and 375 x 667', async ({ page }, testInfo) => {
    await openWaivers(page);
    /* The folded lists start folded, and Worth considering shows three at most. */
    for (const toggle of await page.locator('.wfold .bench-toggle').all()) await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(await page.getByTestId('tier-consider').getByTestId('waiver-tier-row').count()).toBeLessThanOrEqual(3);
    await expect(page.getByTestId('waivers-info-button')).toHaveCount(0);

    const heights: Record<string, number> = {};
    for (const [width, height, fits] of [
      [390, 844, true],
      [430, 932, true],
      [360, 740, false],
      [375, 667, false],
    ] as const) {
      await page.setViewportSize({ width, height });
      const h = await pageHeight(page);
      heights[`${width}x${height}`] = h.content;
      if (fits) expect(h.overflow, `the page scrolls at ${width} x ${height} (${h.content}px of content)`).toBeLessThanOrEqual(0);
    }
    await testInfo.attach('content-heights', { body: JSON.stringify(heights, null, 2), contentType: 'application/json' });
    console.log(`[waivers-one-screen] ${testInfo.project.name} content heights ${JSON.stringify(heights)}`);
  });

  test('a busy week still fits 390 x 844 and 430 x 932 with the lists folded', async ({ page }, testInfo) => {
    await busyWeek(page);
    await openWaivers(page);
    await expect(page.getByTestId('tier-consider-more')).toHaveText('Show all (5)');
    await expect(page.getByTestId('tier-watch-title')).toHaveText('Watch list (8)');
    const heights: Record<string, number> = {};
    for (const [width, height, fits] of [
      [390, 844, true],
      [430, 932, true],
      [360, 740, false],
      [375, 667, false],
    ] as const) {
      await page.setViewportSize({ width, height });
      const h = await pageHeight(page);
      heights[`${width}x${height}`] = h.content;
      if (fits) expect(h.overflow, `a busy week scrolls at ${width} x ${height} (${h.content}px of content)`).toBeLessThanOrEqual(0);
    }
    await testInfo.attach('busy-content-heights', { body: JSON.stringify(heights, null, 2), contentType: 'application/json' });
    console.log(`[waivers-one-screen] ${testInfo.project.name} busy content heights ${JSON.stringify(heights)}`);
    await page.setViewportSize({ width: 390, height: 844 });
    await testInfo.attach('busy-390', { body: await page.screenshot({ path: testInfo.outputPath('busy-390.png') }), contentType: 'image/png' });
  });
});

/**
 * The seeded league's moves all fill an open spot, so nobody is displaced or
 * dropped. To weigh two real players, give the first "Do this" move a drop: a
 * real player off the roster, so the Compare screen can be asked about the
 * same pair.
 */
async function withRealDrop(page: Page) {
  await page.route('**/api/leagues/*/waivers', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const tiers = body.tiers;
    const first = tiers.doThese[0];
    const offered = new Set([...tiers.doThese, ...tiers.consider, ...tiers.watch].map((r: { playerId: string }) => r.playerId));
    const [id, f] = Object.entries(tiers.weekFigures as Record<string, { name: string; position: string }>).find(([pid, fig]) => !offered.has(pid) && fig.position === first.position)
      ?? Object.entries(tiers.weekFigures as Record<string, { name: string; position: string }>).find(([pid]) => !offered.has(pid))!;
    const drop = { playerId: id, name: f.name, position: f.position, reason: 'least points on your bench', score: 0, handcuff: false };
    const moved = { ...first, drop };
    tiers.doThese = [moved, ...tiers.doThese.slice(1)];
    if (tiers.doThis?.playerId === first.playerId) tiers.doThis = moved;
    await route.fulfill({ response, body: JSON.stringify(body) });
  });
}

/** A busy week: three "Do this" moves, five worth considering, a long Watch list and Drop-ready, every row with a reason line. */
async function busyWeek(page: Page) {
  await page.route('**/api/leagues/*/waivers', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const tiers = body.tiers;
    const rows = [...tiers.doThese, ...tiers.consider, ...tiers.watch];
    const copy = (i: number, tier: string) => ({ ...rows[i % rows.length], playerId: `busy-${tier}-${i}`, tier, gain: 3 - i * 0.3, reasonCode: 'upgrade', reason: 'Starts over Braelon Allen, +1.7 pts in week 2', drop: { playerId: 'x', name: 'Jaylen Wright', position: 'RB' } });
    tiers.doThese = [0, 1, 2].map((i) => copy(i, 'do_this'));
    tiers.doThis = tiers.doThese[0];
    tiers.consider = [0, 1, 2, 3, 4].map((i) => copy(i + 3, 'consider'));
    tiers.watch = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => copy(i + 8, 'watch'));
    tiers.dropReady = [0, 1, 2].map((i) => ({ playerId: `dr-${i}`, name: `Bench Player ${i}`, position: 'WR', team: 'KC', reason: 'No start in weeks 1 to 3' }));
    await route.fulfill({ response, body: JSON.stringify(body) });
  });
}

/** The scores the sheet or the Compare screen shows, by player. */
async function scores(page: Page, scope: string): Promise<Record<string, string>> {
  return page.locator(`${scope} [data-testid="compare-column"]`).evaluateAll((els) =>
    Object.fromEntries(els.map((el) => [el.getAttribute('data-player-id')!, el.querySelector('[data-testid="compare-score"]')!.textContent!.trim()])),
  );
}

test.describe('the move sheet, against a real drop', () => {
  test('compares the move with one other player, this week, with the Compare screen’s numbers', async ({ page }) => {
    await withRealDrop(page);
    await openWaivers(page);
    await page.getByTestId('waiver-tier-row').first().click();
    const sheet = page.getByTestId('tier-detail');
    const body = sheet.getByTestId('tier-detail-body');
    const playerId = (await body.getAttribute('data-player-id'))!;
    const partnerId = (await body.getAttribute('data-partner-id'))!;
    expect(partnerId, 'the sheet has someone to compare with').not.toBe('');
    if ((await body.getAttribute('data-period')) !== 'this') await sheet.getByTestId('wsheet-period-this').click();
    await expect(sheet.getByTestId('wsheet-compare')).toBeVisible();
    await expect(sheet.getByTestId('compare-column')).toHaveCount(2);
    const onSheet = await scores(page, '[data-testid="tier-detail"]');
    expect(Object.keys(onSheet).sort()).toEqual([playerId, partnerId].sort());
    /*
     * "Better", not "Start": the sheet weighs a move, it does not set a lineup.
     * Two players who share no slot get neither, as on the Compare screen.
     */
    expect(await sheet.getByTestId('compare-better').count()).toBeLessThanOrEqual(1);
    await expect(sheet.locator('.cmp2-start')).toHaveCount(0);
    /* Two players, the score table and a drop row still fit 390 x 844. */
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => { const el = document.querySelector('.sheet-body') as HTMLElement; return el.scrollHeight - el.clientHeight; }), 'the sheet scrolls').toBeLessThanOrEqual(1);
    const names = await sheet.locator('.cmp2-col-name').allInnerTexts();
    await swipeSheetAway(page);
    await expect(sheet).toHaveCount(0);

    /* The Compare screen, for the same two players. */
    await page.getByTestId('tab-team').click();
    await page.getByTestId('compare-open').click();
    await page.getByTestId('compare-tab-all').click();
    for (const [i, id] of [playerId, partnerId].entries()) {
      await page.getByTestId('compare-search').fill(names[i]!.replace(/^\w\. /, ''));
      const row = page.locator(`[data-testid="compare-candidate"][data-player-id="${id}"]`);
      await row.click();
      await expect(row).toHaveAttribute('data-chosen', 'true');
    }
    await page.getByTestId('compare-add').click();
    await expect(page.getByTestId('comparison')).toBeVisible();
    expect(await scores(page, '[data-testid="comparison"]')).toEqual(onSheet);
  });

  test('adds three weeks up from its weeks, for both players', async ({ page }) => {
    await withRealDrop(page);
    await openWaivers(page);
    await page.getByTestId('waiver-tier-row').first().click();
    const sheet = page.getByTestId('tier-detail');
    await sheet.getByTestId('wsheet-period-three').click();
    const weeks = sheet.getByTestId('wsheet-week');
    await expect(weeks).toHaveCount(3);
    for (const col of [0, 1]) {
      let sum = 0;
      for (const w of await weeks.all()) sum += Number(await w.getByTestId('wsheet-cell').nth(col).getAttribute('data-points'));
      expect(Number(await sheet.getByTestId('wsheet-total-cell').nth(col).getAttribute('data-points'))).toBeCloseTo(sum, 6);
      expect(await sheet.getByTestId('wsheet-total-cell').nth(col).innerText()).toBe(sum.toFixed(1));
    }
    /* This week's row is the Compare answer, so the two views agree. */
    await sheet.getByTestId('wsheet-period-this').click();
    await expect(sheet.getByTestId('wsheet-compare')).toBeVisible();
  });
});

test.describe('the move sheet', () => {
  test.beforeEach(async ({ page }) => openWaivers(page));

  test('weighs an open-spot move against the empty slot', async ({ page }) => {
    await page.getByTestId('waiver-tier-row').first().click();
    const sheet = page.getByTestId('tier-detail');
    await expect(sheet.getByTestId('tier-detail-body')).toHaveAttribute('data-partner-id', '');
    await expect(sheet.getByTestId('wsheet-weeks')).toContainText('Empty slot');
    await expect(sheet.getByTestId('compare-better')).toHaveCount(1);
  });

  test('adds three weeks up from the weeks it shows', async ({ page }) => {
    for (const row of (await page.getByTestId('waiver-tier-row').all()).slice(0, 3)) {
      await row.click();
      const sheet = page.getByTestId('tier-detail');
      const period = sheet.getByTestId('wsheet-period-three');
      if ((await period.count()) > 0) {
        await period.click();
        const weeks = sheet.getByTestId('wsheet-week');
        await expect(weeks).toHaveCount(3);
        for (const col of [0, 1]) {
          let sum = 0;
          for (const w of await weeks.all()) sum += Number(await w.getByTestId('wsheet-cell').nth(col).getAttribute('data-points'));
          expect(Number(await sheet.getByTestId('wsheet-total-cell').nth(col).getAttribute('data-points'))).toBeCloseTo(sum, 6);
        }
      }
      await swipeSheetAway(page);
      await expect(sheet).toHaveCount(0);
    }
  });

  test('fits 390 x 844 without scrolling, with up to three drops, in every period', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const row of (await page.getByTestId('waiver-tier-row').all()).slice(0, 4)) {
      await row.click();
      const sheet = page.getByTestId('tier-detail');
      await expect(sheet).toBeVisible();
      expect(await sheet.getByTestId('tier-detail-best-drop').count()).toBeLessThanOrEqual(3);
      for (const p of ['this', 'next', 'three']) {
        const seg = sheet.getByTestId(`wsheet-period-${p}`);
        if ((await seg.count()) > 0) await seg.click();
        await page.waitForTimeout(250);
        const over = await page.evaluate(() => {
          const el = document.querySelector('.sheet-body') as HTMLElement;
          return el.scrollHeight - el.clientHeight;
        });
        expect(over, `the sheet scrolls (${p})`).toBeLessThanOrEqual(1);
      }
      await swipeSheetAway(page);
      await expect(sheet).toHaveCount(0);
    }
  });

  test('is the same sheet from Team’s waiver moves', async ({ page }) => {
    const sheet = page.getByTestId('tier-detail');
    const body = sheet.getByTestId('tier-detail-body');
    const read = async () => ({
      player: await body.getAttribute('data-player-id'),
      partner: await body.getAttribute('data-partner-id'),
      period: await body.getAttribute('data-period'),
      chips: await sheet.getByTestId('wsheet-chips').locator('[data-chip]').allInnerTexts(),
      text: await body.innerText(),
    });
    const row = page.getByTestId('waiver-card').getByTestId('waiver-tier-row').first();
    await page.getByTestId('tab-team').click();
    await expect(row).toBeVisible();
    const id = await row.getAttribute('data-player-id');
    await row.click();
    await expect(sheet.getByTestId('wsheet-compare').or(sheet.getByTestId('wsheet-weeks'))).toBeVisible();
    const onTeam = await read();
    await swipeSheetAway(page);
    await expect(sheet).toHaveCount(0);
    await page.getByTestId('tab-waivers').click();
    await page.locator(`[data-testid="waiver-tier-row"][data-player-id="${id}"]`).first().click();
    await expect(sheet.getByTestId('wsheet-compare').or(sheet.getByTestId('wsheet-weeks'))).toBeVisible();
    expect(await read()).toEqual(onTeam);
  });
});
