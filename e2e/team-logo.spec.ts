/**
 * Club marks where the abbreviation used to be.
 *
 * The claim being defended has three parts, and each one is asserted against
 * the running app rather than against the mapping table, because the mapping
 * table is already covered by `tests/nflTeams.test.ts` and is not the thing
 * that breaks:
 *
 *  1. **the mark actually arrives.** Not "an `<img>` is in the DOM" — that is
 *     true of a broken image too — but `naturalWidth > 0`, which is only true
 *     when the browser decoded a real file from a real path.
 *  2. **it costs the row nothing.** The mark fits inside the line the player's
 *     name already sets, so a board of marks is exactly as tall as a board of
 *     three-letter codes was.
 *  3. **losing it is survivable.** With the asset route blocked, every row
 *     falls back to the abbreviation it used to print. No gaps, no broken-image
 *     glyphs, and nothing about the player's numbers changes.
 */

import { expect, test, type Page } from '@playwright/test';

async function openDraft(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('board-list')).toBeVisible();
}

/**
 * Marks the browser finished with and got nothing from.
 *
 * `complete && naturalWidth === 0` is the only state that means *failed*. A
 * mark that is merely `!complete` is a mark below the fold that lazy loading
 * has not asked for yet, which is the feature working, not a fault — counting
 * those would make this whole file fail intermittently by design.
 */
async function brokenMarks(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      [...document.querySelectorAll('img.team-logo')].filter((img) => {
        const image = img as HTMLImageElement;
        return image.complete && image.naturalWidth === 0;
      }).length,
  );
}

/** Marks that actually decoded a file. */
async function decodedMarks(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      [...document.querySelectorAll('img.team-logo')].filter((img) => (img as HTMLImageElement).naturalWidth > 0)
        .length,
  );
}

test.describe('the club mark on a player row', () => {
  test('draws every club on the board, and draws them for real', async ({ page }) => {
    await openDraft(page);

    expect(await page.getByTestId('team-logo').count()).toBeGreaterThan(4);
    // Decoded, not merely present: a broken image is an `<img>` too.
    await expect.poll(() => decodedMarks(page)).toBeGreaterThan(4);
    expect(await brokenMarks(page)).toBe(0);

    // Nothing on the board is still spelling a club out.
    await expect(page.getByTestId('team-code')).toHaveCount(0);
  });

  test('says the club name out loud even though the letters are gone', async ({ page }) => {
    await openDraft(page);

    // The seeded board's top card is a Buffalo receiver. A screen reader must
    // get "Buffalo Bills", which is more than `BUF` ever told it.
    const first = page.getByTestId('recommendation-row').first();
    const mark = first.getByTestId('team-logo');
    await expect(mark).toHaveAttribute('alt', /^[A-Z][a-zA-Z. ]+ [A-Za-z0-9]+$/);
    const alt = await mark.getAttribute('alt');
    expect(alt?.length ?? 0).toBeGreaterThan(6);
  });

  test('fits inside the line the name already sets', async ({ page }) => {
    await openDraft(page);

    const first = page.getByTestId('recommendation-row').first();
    const line = await first.locator('.player-row-top').boundingBox();
    const mark = await first.getByTestId('team-logo').boundingBox();

    // The mark may not be what decides how tall the row is.
    expect(mark!.height).toBeLessThanOrEqual(line!.height);
    // A square box, so every row lines up on the same vertical edge.
    expect(Math.abs(mark!.width - mark!.height)).toBeLessThan(1);
  });

  /**
   * The mark leads the name now, and still never collides with it.
   *
   * This asserted the mark was to the *right* of the name, because the club sat
   * on the trailing edge beside the star. It has moved into the identity
   * cluster — position, club, name, in the order a reader asks for them — so
   * the same claim is the same claim with the sides swapped: the mark ends
   * before the name begins, and the name still gets enough of the row to be a
   * name. Neither number was relaxed on the way.
   */
  test('never lets a mark push the player name off the row', async ({ page }) => {
    await openDraft(page);

    for (const row of await page.getByTestId('recommendation-row').all()) {
      const name = await row.locator('.player-name').boundingBox();
      const mark = await row.getByTestId('team-logo').boundingBox();
      if (!name || !mark) continue;
      // The mark ends before the name starts.
      expect(mark.x + mark.width).toBeLessThanOrEqual(name.x + 1);
      expect(name.width).toBeGreaterThan(60);
    }
  });

  /**
   * And the cluster is a column, not a cluster-shaped thing.
   *
   * The whole reason the pill went from a minimum width to a fixed one: with
   * the club's mark following it, a `WR` pill 1.4px wider than a `QB` one would
   * start every receiver's mark — and every receiver's name — on its own
   * column. Forty rows of that reads as a rendering fault to somebody who could
   * not say what was wrong with it.
   */
  test('starts every mark and every name on one column', async ({ page }) => {
    await openDraft(page);

    const columns = await page.getByTestId('recommendation-row').evaluateAll((rows) => {
      const left = (row: Element, sel: string) => {
        const el = row.querySelector(sel);
        return el ? Math.round(el.getBoundingClientRect().left) : null;
      };
      return {
        marks: [...new Set(rows.map((r) => left(r, '.team-logo, [data-testid="team-code"]')).filter((x) => x != null))],
        names: [...new Set(rows.map((r) => left(r, '.player-name')).filter((x) => x != null))],
        positions: [...new Set(rows.map((r) => (r.querySelector('.pos-pill')?.textContent ?? '').trim()))],
      };
    });

    expect(columns.marks, `marks started at ${columns.marks.join(', ')}`).toHaveLength(1);
    expect(columns.names, `names started at ${columns.names.join(', ')}`).toHaveLength(1);
    // …and the board really does mix positions, so a uniform one could not pass
    // this by accident. `WR` is the wide one, and it is what broke this before.
    expect(columns.positions.length).toBeGreaterThan(1);
  });
});

test.describe('when the marks cannot be loaded', () => {
  /*
   * The whole point of the fallback: a reader whose network ate the asset
   * directory still has a completely usable draft board, reading exactly as it
   * read before any of this existed.
   */
  test('falls back to the abbreviation rather than a gap', async ({ page }) => {
    await page.route('**/logos/nfl/*.webp', (route) => route.abort());
    await openDraft(page);

    await expect(page.getByTestId('team-code').first()).toBeVisible();
    expect(await page.getByTestId('team-code').count()).toBeGreaterThan(4);
    expect(await brokenMarks(page)).toBe(0);

    // Still the club, still three letters, still beside the position pill.
    await expect(page.getByTestId('team-code').first()).toHaveText(/^[A-Z]{2,3}$/);
  });

  test('leaves the board and its numbers exactly as they were', async ({ page }) => {
    /*
     * Everything on the card except the position/team cluster itself, which is
     * the only place the fallback is allowed to show. Read that way the claim
     * is exact rather than approximate: the score, the ADP, the value, the
     * survival percentage and the tier warning are the same characters whether
     * the marks loaded or not.
     */
    const cardWithoutTheCluster = () =>
      page.getByTestId('recommendation-row').first().evaluate((row) => {
        const copy = row.cloneNode(true) as HTMLElement;
        /*
         * The club's mark, however it is currently drawn.
         *
         * This removed `.pos-team`, the wrapper that used to hold the position
         * pill and the logo together on the trailing edge. The row rule split
         * those two apart — the pill sits left of the name now and the mark
         * stayed on the right — so there is no wrapper any more, and stripping
         * it removed nothing: the abbreviation the fallback draws was left in
         * the text being compared, which is exactly the difference this test
         * exists to ignore.
         *
         * Both forms are named, so the comparison is of everything *except*
         * the mark whether it loaded or not.
         */
        copy.querySelectorAll('.pos-team, .team-logo, [data-testid="team-code"]').forEach((el) => el.remove());
        return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
      });

    await openDraft(page);
    const withMarks = await cardWithoutTheCluster();

    await page.route('**/logos/nfl/*.webp', (route) => route.abort());
    await page.reload();
    await expect(page.getByTestId('board-list')).toBeVisible();
    await expect(page.getByTestId('team-code').first()).toBeVisible();

    expect(await cardWithoutTheCluster()).toBe(withMarks);
  });
});

test.describe('both appearances', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`draws every mark in ${theme} mode`, async ({ page }) => {
      await page.addInitScript((mode) => window.localStorage.setItem('fa.appearance', mode), theme);
      await page.emulateMedia({ colorScheme: theme });
      await openDraft(page);

      await expect(page.getByTestId('team-logo').first()).toBeVisible();
      await expect.poll(() => decodedMarks(page)).toBeGreaterThan(4);
      expect(await brokenMarks(page)).toBe(0);
      expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe(theme);
    });
  }
});

test.describe('the same mark everywhere', () => {
  test('the roster uses the club mark too', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('tab-team').click();

    await expect(page.getByTestId('team-logo').first()).toBeVisible();
    await expect.poll(() => decodedMarks(page)).toBeGreaterThan(0);
    expect(await brokenMarks(page)).toBe(0);
  });

  test('the marks are the same size on every screen', async ({ page }) => {
    await openDraft(page);
    const onBoard = await page.getByTestId('team-logo').first().boundingBox();

    await page.getByTestId('tab-team').click();
    await expect(page.getByTestId('team-logo').first()).toBeVisible();
    const onRoster = await page.getByTestId('team-logo').first().boundingBox();

    expect(onRoster!.width).toBeCloseTo(onBoard!.width, 1);
    expect(onRoster!.height).toBeCloseTo(onBoard!.height, 1);
  });
});
