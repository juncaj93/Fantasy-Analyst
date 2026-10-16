/**
 * Phone check round 2 (16 October 2026), at every width the suite runs
 * (360, 375, 390, 430):
 *
 *  - Compare cards are one centred column: name, position and team logo,
 *    photo, score, Start; no verdict sentence under them;
 *  - a Sleeper fallback number carries one marker everywhere (italic, dotted
 *    underline, no "Sleeper" word), only fallback numbers carry it, and a
 *    marked number keeps the same width and line height as a normal one;
 *  - Matchup rows stay aligned with a marked number among them.
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

async function compareRunningBacksAndTightEnds(page: Page, count: number) {
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
  await page.getByTestId('compare-add').click();
  await expect(page.getByTestId('comparison')).toBeVisible();
  await page.waitForTimeout(400);
}

/** Make the first non-pick a Sleeper fallback, as the server reports one. */
async function withSleeperFallback(page: Page) {
  await page.route('**/api/startsit/compare', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const other = body.evaluations.find((e: { playerId: string }) => e.playerId !== body.recommendedPlayerId);
    other.decision = { ...other.decision, basis: 'published' };
    await route.fulfill({ response, body: JSON.stringify(body) });
  });
}

const styleOf = (page: Page, selector: string) =>
  page.locator(selector).evaluateAll((els) =>
    els.map((el) => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return { italic: s.fontStyle, deco: s.textDecorationStyle, line: s.lineHeight, size: s.fontSize, width: r.width, height: r.height, right: r.right, cls: el.className };
    }),
  );

for (const count of [2, 3, 4] as const) {
  test(`${count} Compare cards are one centred column with a team logo, and no verdict sentence`, async ({ page }) => {
    await openCompare(page);
    await compareRunningBacksAndTightEnds(page, count);
    await expect(page.getByTestId('comparison-verdict')).toHaveCount(0);

    for (const card of await page.getByTestId('compare-column').all()) {
      const box = (await card.boundingBox())!;
      const middle = box.x + box.width / 2;
      for (const sel of ['.cmp2-col-name', '.cmp2-col-meta', '.cmp2-face', '[data-testid="compare-score"]']) {
        const b = (await card.locator(sel).boundingBox())!;
        expect(Math.abs(b.x + b.width / 2 - middle), `${sel} centred`).toBeLessThanOrEqual(2);
      }
      // The team is the logo the rest of the app uses, not the abbreviation.
      await expect(card.getByTestId('team-logo')).toHaveCount(1);
      // Top to bottom: name, team line, photo, score.
      const top = async (sel: string) => (await card.locator(sel).boundingBox())!.y;
      expect(await top('.cmp2-col-name')).toBeLessThan(await top('.cmp2-col-meta'));
      expect(await top('.cmp2-col-meta')).toBeLessThan(await top('.cmp2-face'));
      expect(await top('.cmp2-face')).toBeLessThan(await top('[data-testid="compare-score"]'));
    }
    // Start sits under the pick's score, centred.
    const pick = page.locator('[data-testid="compare-column"][data-pick="true"]');
    if (await pick.count()) {
      const card = (await pick.boundingBox())!;
      const start = (await pick.locator('.cmp2-start').boundingBox())!;
      const score = (await pick.getByTestId('compare-score').boundingBox())!;
      expect(start.y).toBeGreaterThan(score.y);
      expect(Math.abs(start.x + start.width / 2 - (card.x + card.width / 2))).toBeLessThanOrEqual(2);
    }

    const viewport = page.viewportSize()!;
    const total = (await page.getByTestId('compare-total').boundingBox())!;
    expect(total.y + total.height, 'still one screen').toBeLessThanOrEqual(viewport.height);
  });
}

test('the fallback marker sits on fallback numbers only, at the same size as the rest', async ({ page }) => {
  await withSleeperFallback(page);
  await openCompare(page);
  await compareRunningBacksAndTightEnds(page, 2);

  const cards = await styleOf(page, '[data-testid="compare-score"]');
  const marked = cards.filter((c) => c.cls.includes('num-sleeper'));
  const plain = cards.filter((c) => !c.cls.includes('num-sleeper'));
  expect(marked).toHaveLength(1);
  expect(marked[0]!.italic).toBe('italic');
  expect(marked[0]!.deco).toBe('dotted');
  for (const p of plain) {
    expect(p.italic).toBe('normal');
    expect(p.line, 'same line height').toBe(marked[0]!.line);
    expect(p.size, 'same size').toBe(marked[0]!.size);
    expect(Math.abs(p.height - marked[0]!.height), 'same height').toBeLessThanOrEqual(1);
  }

  // In the table: Base and Score carry it in that column; a grey missing line does not.
  const score = await styleOf(page, '[data-testid="compare-total"] [role="cell"]');
  const markedCell = score.find((c) => c.cls.includes('num-sleeper'))!;
  const plainCell = score.find((c) => !c.cls.includes('num-sleeper'))!;
  expect(markedCell.italic).toBe('italic');
  expect(Math.abs(markedCell.width - plainCell.width), 'cells keep one width').toBeLessThanOrEqual(1);
  expect(markedCell.line).toBe(plainCell.line);
  const dashes = await styleOf(page, '[data-testid="compare-cell"][data-muted="true"]:not(.num-sleeper)');
  for (const d of dashes) expect(d.italic, 'a missing line is grey, not marked').toBe('normal');

  await expect(page.getByTestId('compare-sheet')).not.toContainText(/Sleeper only|\bSleeper\b(?! projection)/);
});

test('Matchup rows stay aligned with a marked fallback number, and no "Sleeper" word', async ({ page }) => {
  await page.route('**/api/overview', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ json: { ...body, lifecycle: { ...(body.lifecycle ?? {}), matchupVisible: true } } });
  });
  /* One of my starters becomes a borrowed (Sleeper) figure, the way the server marks one. */
  await page.route('**/api/leagues/*/matchup*', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const slots = (body.slots ?? body.forecast?.slots ?? []) as { mine: { projectedFinal: number | null; projectionBorrowed?: boolean; onBye?: boolean } | null }[];
    const target = slots.find((s) => s.mine && s.mine.projectedFinal != null && !s.mine.onBye);
    if (target?.mine) target.mine.projectionBorrowed = true;
    await route.fulfill({ response, body: JSON.stringify(body) });
  });
  await page.goto('/');
  await page.getByTestId('tab-matchup').click();
  await expect(page.getByTestId('matchup-score')).toBeVisible();

  const projs = await styleOf(page, '[data-testid="matchup-player-proj"]');
  const marked = projs.filter((p) => p.cls.includes('num-sleeper'));
  test.skip(marked.length === 0, 'the demo matchup has no projected starter to mark');
  expect(marked[0]!.italic).toBe('italic');
  expect(marked[0]!.deco).toBe('dotted');
  const plain = projs.filter((p) => !p.cls.includes('num-sleeper') && p.italic === 'normal');
  expect(plain.length).toBeGreaterThan(0);
  for (const p of plain) {
    expect(p.line, 'same line height').toBe(marked[0]!.line);
    expect(Math.abs(p.height - marked[0]!.height), 'same height').toBeLessThanOrEqual(1);
  }
  await expect(page.getByTestId('sleeper-tag')).toHaveCount(0);

  // Aligned: the marked figure's row is as tall as an unmarked row on the same side.
  const rows = await page.getByTestId('matchup-player').evaluateAll((els) =>
    els.map((el) => ({ h: Math.round(el.getBoundingClientRect().height), marked: !!el.querySelector('.num-sleeper') })),
  );
  const markedRow = rows.find((r) => r.marked);
  if (markedRow) {
    const others = rows.filter((r) => !r.marked).map((r) => r.h);
    expect(others, 'the marked row is no taller than the others').toContain(markedRow.h);
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

/* Alex's phone check after round 2: the × on three or four chips sits where it does on two. */
test('the × on every chip is centred top to bottom, at its right edge, at one size for 2 to 4 players', async ({ page }) => {
  const xSizes: number[] = [];
  for (const count of [2, 3, 4]) {
    await openCompare(page);
    await compareRunningBacksAndTightEnds(page, count);
    for (const chip of await page.getByTestId('compare-chosen').all()) {
      const box = (await chip.boundingBox())!;
      const mark = (await chip.locator('.cmp2-chip-x [aria-hidden="true"]').boundingBox())!;
      const name = (await chip.locator('.cmp2-chip-name').boundingBox())!;
      expect(Math.abs(mark.y + mark.height / 2 - (box.y + box.height / 2)), `${count} chips: × centred top to bottom`).toBeLessThanOrEqual(1.5);
      expect(box.x + box.width - (mark.x + mark.width), `${count} chips: × at the right edge`).toBeLessThanOrEqual(14);
      expect(mark.x, `${count} chips: × clear of the name`).toBeGreaterThanOrEqual(name.x + name.width);
      xSizes.push(Math.round(mark.height));
    }
  }
  expect(new Set(xSizes).size, 'one × size whatever the count').toBe(1);
});

/* Alex's phone check after round 2: once Compare shows, the chips read in the cards' order. */
test('after Compare the chips follow the ranking, however they were chosen', async ({ page }) => {
  await openCompare(page);
  await page.getByTestId('compare-tab-all').click();
  await expect(page.getByTestId('compare-candidate').first()).toBeVisible();
  await page.waitForTimeout(250);
  // Choose three lowest first, so the order chosen is not the ranked order.
  const ids = (await page.getByTestId('compare-candidate').evaluateAll((els) => els.slice(2, 5).map((e) => e.getAttribute('data-player-id')!))).reverse();
  for (const id of ids) {
    const row = page.locator(`[data-testid="compare-candidate"][data-player-id="${id}"]`);
    await row.click();
    await expect(row).toHaveAttribute('data-chosen', 'true');
  }
  const chips = () => page.getByTestId('compare-chosen').evaluateAll((els) => els.map((e) => e.getAttribute('data-player-id')));
  const cards = () => page.getByTestId('compare-column').evaluateAll((els) => els.map((e) => e.getAttribute('data-player-id')));
  // While choosing, the chips stay in the order he tapped them.
  expect(await chips()).toEqual(ids);

  await page.getByTestId('compare-add').click();
  await expect(page.getByTestId('comparison')).toBeVisible();
  await page.waitForTimeout(400);
  const ranked = await cards();
  expect(ranked).not.toEqual(ids);
  await expect.poll(chips).toEqual(ranked);
  await expect(page.locator('[data-testid="compare-column"][data-pick="true"]')).toHaveAttribute('data-player-id', ranked[0]!);

  // Reopening the list keeps that order.
  await page.getByTestId('compare-add').click();
  expect(await chips()).toEqual(ranked);
});
