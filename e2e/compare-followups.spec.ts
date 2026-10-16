/**
 * Compare follow-ups from Alex's phone check (16 October 2026), at every
 * phone width the suite runs (360, 375, 390, 430):
 *
 *  1. photos scale with the number of players, and 2 to 4 still fit one screen;
 *  2. no preview of the answer while choosing;
 *  3. an X closes Compare (44px, "Close"), the header is one row, the picker's
 *     sections sit about 8px apart; other sheets keep Done;
 *  4. the first tab reads "My team";
 *  5. a Sleeper-only player is a marked second choice, never a second Start;
 *  6. up to four chips on one line with nothing cut off.
 */
import { expect, test, type Page } from '@playwright/test';
import { inSeason } from './helpers.ts';

async function openCompare(page: Page) {
  await inSeason(page);
  await page.goto('/');
  await page.getByTestId('tab-team').click();
  await expect(page.getByTestId('starters-title')).toBeVisible();
  await page.getByTestId('compare-open').click();
  await expect(page.getByTestId('compare-candidate').first()).toBeVisible();
}

/** Choose the first `count` players on All players, skipping the two QBs at the top. */
async function choose(page: Page, count: number) {
  await page.getByTestId('compare-tab-all').click();
  await expect(page.getByTestId('compare-candidate').first()).toBeVisible();
  await page.waitForTimeout(250);
  const ids = await page
    .getByTestId('compare-candidate')
    .evaluateAll((els, n) => els.slice(2, 2 + n).map((e) => e.getAttribute('data-player-id')!), count);
  for (const id of ids) {
    const row = page.locator(`[data-testid="compare-candidate"][data-player-id="${id}"]`);
    await row.click();
    await expect(row).toHaveAttribute('data-chosen', 'true');
  }
}

async function showComparison(page: Page) {
  await page.getByTestId('compare-add').click();
  await expect(page.getByTestId('comparison')).toBeVisible();
  await page.waitForTimeout(400);
}

/** Elements under the given roots whose own text is wider than their box. */
async function clipped(page: Page, testIds: string[]): Promise<string[]> {
  return page.evaluate((ids) => {
    const bad: string[] = [];
    for (const id of ids) {
      const root = document.querySelector(`[data-testid="${id}"]`);
      if (!root) continue;
      for (const el of root.querySelectorAll<HTMLElement>('*')) {
        const ownText = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '');
        if (!ownText || getComputedStyle(el).display === 'inline' || el.classList.contains('sr-only')) continue;
        if (el.scrollWidth > el.clientWidth + 1) bad.push(`${el.className || el.tagName}: "${el.textContent?.trim()}"`);
      }
    }
    return bad;
  }, testIds);
}

/** Every chip on one line, inside the strip, with nothing drawn past its own edge. */
async function expectChipsFit(page: Page, count: number) {
  const chips = page.getByTestId('compare-chosen');
  await expect(chips).toHaveCount(count);
  const strip = (await page.getByTestId('compare-chips').boundingBox())!;
  const boxes = await chips.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect));
  expect(new Set(boxes.map((b) => Math.round(b.top))).size, 'every chip on one line').toBe(1);
  for (const b of boxes) expect(b.right, 'no chip runs past the strip').toBeLessThanOrEqual(strip.x + strip.width + 0.5);
  const scroll = await page.getByTestId('compare-chips').evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(scroll, 'the chip row does not scroll to hide one').toBeLessThanOrEqual(0);
  expect(await clipped(page, ['compare-chips']), 'no chip text cut off').toEqual([]);
}

const FACE: Record<number, number> = { 2: 60, 3: 46, 4: 36 };

for (const count of [2, 3, 4] as const) {
  test(`${count} players: bigger photos, one screen, chips and cards whole`, async ({ page }) => {
    await openCompare(page);
    await choose(page, count);
    await expectChipsFit(page, count);
    await showComparison(page);

    const viewport = page.viewportSize()!;
    const total = (await page.getByTestId('compare-total').boundingBox())!;
    expect(total.y + total.height, 'the Score row is on screen without scrolling').toBeLessThanOrEqual(viewport.height);
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(sideways).toBeLessThanOrEqual(0);

    const faces = page.locator('[data-testid="compare-column"] .cmp2-face');
    await expect(faces).toHaveCount(count);
    for (const face of await faces.all()) {
      const box = (await face.boundingBox())!;
      expect(Math.round(box.width), 'photo size for this many players').toBe(FACE[count]);
      expect(box.width, 'bigger than the 32px it was').toBeGreaterThan(32);
    }

    await expectChipsFit(page, count);
    expect(await clipped(page, ['comparison', 'compare-grid']), 'no text cut off').toEqual([]);
  });
}

test('no preview of the answer while choosing: it shows only after Compare', async ({ page }) => {
  await openCompare(page);
  await choose(page, 2);
  await page.waitForTimeout(600);
  await expect(page.getByTestId('compare-mini-verdict')).toHaveCount(0);
  await expect(page.getByTestId('comparison')).toHaveCount(0);
  await expect(page.getByTestId('compare-add')).toHaveText('Compare');
  await showComparison(page);
  await expect(page.getByTestId('comparison-verdict')).toBeVisible();
});

test('an X closes Compare, the header is one row, and the picker is tight', async ({ page }) => {
  await openCompare(page);
  const sheet = page.getByTestId('compare-sheet');
  const close = sheet.getByTestId('sheet-close');
  await expect(close).toHaveAttribute('aria-label', 'Close');
  await expect(close).not.toHaveText('Done');
  const x = (await close.boundingBox())!;
  expect(x.width).toBeGreaterThanOrEqual(44);
  expect(x.height).toBeGreaterThanOrEqual(44);
  const viewport = page.viewportSize()!;
  expect(viewport.width - (x.x + x.width), 'at the right edge').toBeLessThanOrEqual(16);

  // One header row: the title, the list's action and the X share a line.
  const title = (await sheet.locator('.cmp-title-main').boundingBox())!;
  const add = (await page.getByTestId('compare-add').boundingBox())!;
  const middle = (b: { y: number; height: number }) => b.y + b.height / 2;
  expect(Math.abs(middle(add) - middle(title)), '+ Add / Hide list beside the title').toBeLessThanOrEqual(8);
  expect(Math.abs(middle(x) - middle(title)), 'the X beside the title').toBeLessThanOrEqual(8);
  expect(add.x + add.width).toBeLessThanOrEqual(x.x + 1);

  // About 8px between the picker's sections.
  const tabs = (await page.getByTestId('compare-tabs').boundingBox())!;
  const search = (await page.getByTestId('compare-search').boundingBox())!;
  const filter = (await page.getByRole('group', { name: 'Filter by position' }).boundingBox())!;
  const first = (await page.getByTestId('compare-candidate').first().boundingBox())!;
  for (const [label, gap] of [
    ['tabs to search', search.y - (tabs.y + tabs.height)],
    ['search to filter', filter.y - (search.y + search.height)],
    ['filter to list', first.y - (filter.y + filter.height)],
  ] as const) {
    expect(gap, label).toBeLessThanOrEqual(10);
  }

  await expect(page.getByTestId('compare-tab-mine')).toHaveText('My team');

  await close.click();
  await expect(sheet).toHaveCount(0);
  // Escape still closes it.
  await page.getByTestId('compare-open').click();
  await expect(page.getByTestId('compare-sheet')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('compare-sheet')).toHaveCount(0);
});

test('other sheets keep Done', async ({ page }) => {
  await inSeason(page);
  await page.goto('/');
  await page.getByTestId('tab-team').click();
  await page.locator('[data-testid="starter-row"][data-starter="true"]').first().click();
  await expect(page.getByTestId('weekly-sheet')).toBeVisible();
  await expect(page.getByTestId('weekly-sheet').getByTestId('sheet-close')).toHaveText('Done');
});

test('a Sleeper-only player ahead is a marked second choice, never a second Start', async ({ page }) => {
  /*
   * The demo week prices everybody, so the response is reshaped on the way in:
   * one non-pick becomes a Sleeper week 1.6 ahead, as the server now reports
   * it (`sleeperOnly`). The rule itself is unit-tested in
   * `startsit.completeFirst.test.ts`; this is how the screen draws it.
   */
  await page.route('**/api/startsit/compare', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const pick = body.evaluations.find((e: { playerId: string }) => e.playerId === body.recommendedPlayerId);
    const other = body.evaluations.find((e: { playerId: string }) => e.playerId !== body.recommendedPlayerId);
    other.decision = { ...other.decision, basis: 'published', points: pick.decision.points + 1.6 };
    body.sleeperOnly = { playerId: other.playerId, name: other.name, aheadBy: 1.6 };
    await route.fulfill({ response, body: JSON.stringify(body) });
  });
  await openCompare(page);
  await choose(page, 3);
  await showComparison(page);

  const second = page.locator('[data-testid="compare-column"][data-second="true"]');
  await expect(second).toHaveCount(1);
  await expect(second.getByTestId('compare-sleeper-only')).toHaveText('Sleeper only');
  await expect(second.getByTestId('compare-second-choice')).toHaveText('+1.6 on Sleeper, no Vegas lines yet');
  // Not a Start: no Start badge, no check, a dashed grey outline, not the pick's green one.
  await expect(second).toHaveAttribute('data-pick', 'false');
  await expect(second.locator('.cmp2-start')).toHaveCount(0);
  await expect(second.locator('svg')).toHaveCount(0);
  const pick = page.locator('[data-testid="compare-column"][data-pick="true"]');
  await expect(pick).toHaveCount(1);
  const style = (l: typeof pick) => l.evaluate((el) => ({ border: getComputedStyle(el).borderTopStyle, color: getComputedStyle(el).borderTopColor }));
  const a = await style(pick);
  const b = await style(second);
  expect(b.border).toBe('dashed');
  expect(a.border).toBe('solid');
  expect(b.color).not.toBe(a.color);
  // Second in line, beside the pick.
  const order = await page.getByTestId('compare-column').evaluateAll((els) => els.map((e) => e.getAttribute('data-second') ?? e.getAttribute('data-pick')));
  expect(order.slice(0, 2)).toEqual(['true', 'true']);
  await expect(page.getByTestId('comparison-verdict')).toHaveText(/^Start .+\. .+ projects higher on Sleeper only \(no Vegas lines yet\)\.$/);
});
