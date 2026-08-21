/**
 * Phase 5 of the ranking-integrity audit: can an old answer win?
 *
 * The board is fetched from several places — a filter chip, the automatic poll,
 * pull-to-refresh, a revisit painting from cache and correcting itself — and
 * over a phone connection any of them can be in flight when another starts.
 * The question this file exists to answer is narrow and absolute:
 *
 *   **whatever is on screen must be the answer to the newest question asked.**
 *
 * Reading the code says it is: `load` guards on `positionRef.current === pos`
 * before applying, and the refresh controller holds a single `flight` promise
 * with a `generation` counter so a superseded sync cannot apply. But reading is
 * not proof, and this is exactly the class of defect that reads fine and fails
 * on a slow train — so each path below is driven with the responses
 * deliberately delivered in the wrong order.
 *
 * The technique throughout: intercept `/board`, hold the first response open,
 * let a later one through first, then release the first and assert the screen
 * still shows the later one.
 */

import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * A one-shot latch a route handler can wait on.
 *
 * `open()` releases whatever is waiting; `armed` says whether it has already
 * been used, so only the first matching request is held and the rest flow.
 */
function gate() {
  let release: (() => void) | null = null;
  let used = false;
  const waited = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    get armed() {
      return !used;
    },
    hold() {
      used = true;
      return waited;
    },
    open() {
      release?.();
    },
  };
}

/**
 * Which positions the board is actually showing, read off the rows.
 *
 * Deliberately not read from the chip: the chip is the question and the rows
 * are the answer, and the whole point of these tests is that the two can
 * disagree when a stale response wins.
 */
async function shownPositions(page: Page): Promise<Set<string>> {
  const positions = await page.$$eval('[data-testid="recommendation-row"] .pos-pill', (pills) =>
    pills.map((p) => p.getAttribute('data-position') ?? ''),
  );
  return new Set(positions.filter(Boolean));
}

/** Player ids on the board, in drawn order. */
const shownIds = (page: Page) =>
  page.$$eval('[data-testid="recommendation-row"]', (rows) =>
    rows.map((r) => r.getAttribute('data-player-id') ?? ''),
  );

test.describe('an old board answer can never win', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('board-list')).toBeVisible();
    await expect(page.getByTestId('recommendation-row').first()).toBeVisible();
  });

  /**
   * Two chips, tapped faster than the first one answers.
   *
   * This is the case that actually shipped once: the first filter's players
   * arrived last and sat under the second filter's chip. The guard is applied
   * where the answer lands rather than where the request leaves, so the slow
   * answer is dropped instead of cancelled — a cancelled request would also
   * throw away a cache confirmation that is still valid.
   */
  test('a slow filter answer does not land under a newer chip', async ({ page }) => {
    const rb = gate();
    await page.route('**/board*', async (route: Route) => {
      // Hold the running backs open until the receivers have been drawn.
      if (route.request().url().includes('position=RB') && rb.armed) await rb.hold();
      await route.continue();
    });

    await page.getByRole('button', { name: 'RB', exact: true }).click();
    await page.getByRole('button', { name: 'WR', exact: true }).click();
    await expect
      .poll(async () => [...(await shownPositions(page))].join(), { timeout: 15_000 })
      .toBe('WR');

    // Now let the running backs answer. It must be discarded.
    rb.open();
    await page.waitForTimeout(1200);
    expect(
      [...(await shownPositions(page))],
      'the slow RB answer landed under the WR chip',
    ).toEqual(['WR']);
    await expect(page.getByRole('button', { name: 'WR', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  /**
   * The same race, run the other way round.
   *
   * A guard that only ever drops the *first* response would pass the test above
   * by accident. Here the second request is the slow one, so the correct
   * behaviour is the opposite: its answer must be the one that lands.
   */
  test('a slow answer to the newest chip is still the one that lands', async ({ page }) => {
    const te = gate();
    await page.route('**/board*', async (route: Route) => {
      if (route.request().url().includes('position=TE') && te.armed) await te.hold();
      await route.continue();
    });

    await page.getByRole('button', { name: 'RB', exact: true }).click();
    await expect.poll(async () => [...(await shownPositions(page))].join(), { timeout: 15_000 }).toBe('RB');
    await page.getByRole('button', { name: 'TE', exact: true }).click();

    // The tight ends are still in flight, so the backs are what is drawn.
    await page.waitForTimeout(600);
    te.open();
    await expect
      .poll(async () => [...(await shownPositions(page))].join(), { timeout: 15_000 })
      .toBe('TE');
  });

  /**
   * Three chips tapped in one go, faster than any of them can answer.
   *
   * This is the pile-up case: several requests genuinely in flight at once,
   * for different filters, resolving in whatever order the network gives. The
   * screen has to end on the last chip tapped, and the rows it draws have to be
   * one answer rather than two spliced together.
   */
  test('a pile-up of overlapping requests still ends on the last chip', async ({ page }) => {
    let requests = 0;
    await page.route('**/board*', async (route: Route) => {
      requests++;
      // A little latency on every board request, so they genuinely overlap
      // rather than completing one at a time.
      await new Promise((resolve) => setTimeout(resolve, 250));
      await route.continue();
    });

    await page.getByRole('button', { name: 'RB', exact: true }).click();
    await page.getByRole('button', { name: 'WR', exact: true }).click();
    await page.getByRole('button', { name: 'TE', exact: true }).click();

    await expect.poll(async () => [...(await shownPositions(page))].join(), { timeout: 20_000 }).toBe('TE');
    // And it stays there once everything in flight has landed.
    await page.waitForTimeout(1500);
    expect([...(await shownPositions(page))], 'an earlier chip answered last and won').toEqual(['TE']);

    const ids = await shownIds(page);
    expect(new Set(ids).size, 'the same player is drawn twice, so two answers were merged').toBe(ids.length);
    expect(requests, 'no board request was intercepted, so nothing was actually raced').toBeGreaterThan(1);
  });

  /**
   * Sorting and searching must not go to the server at all.
   *
   * Both are pure rearrangements of a board the reader already has, so neither
   * can be raced by definition — but only while that stays true. If either ever
   * starts refetching, it inherits every race above, and this is the tripwire.
   */
  test('sorting and searching never refetch, so they cannot race', async ({ page }) => {
    let requests = 0;
    await page.route('**/board*', async (route: Route) => {
      requests++;
      await route.continue();
    });

    await page.getByRole('button', { name: 'WR', exact: true }).click();
    await expect(page.getByTestId('recommendation-row').first()).toBeVisible();
    await page.waitForTimeout(400);
    const afterFilter = requests;

    for (const testid of ['sort-adp', 'sort-dog', 'sort-score']) {
      const control = page.getByTestId(testid);
      if ((await control.count()) === 0 || (await control.isDisabled())) continue;
      await control.click();
      await page.waitForTimeout(250);
    }

    const search = page.getByTestId('draft-search-open');
    if ((await search.count()) > 0) {
      await search.click();
      await page.getByTestId('draft-search').fill('a');
      await page.waitForTimeout(400);
      await page.getByTestId('draft-search-close').click();
    }

    await page.waitForTimeout(400);
    expect(
      requests - afterFilter,
      'a sort or a search went back to the server, which puts it in the path of every race above',
    ).toBe(0);
  });

  /**
   * Leaving and coming back.
   *
   * A revisit paints from cache and then corrects itself, which is two applies
   * for one visit. The correction is guarded on the filter still being the one
   * that asked, so a chip tapped during the round trip must win.
   */
  test('a cached revisit correction cannot overwrite a newer chip', async ({ page }) => {
    await page.getByRole('button', { name: 'ALL', exact: true }).click();
    await expect(page.getByTestId('recommendation-row').first()).toBeVisible();

    await page.getByTestId('tab-team').click();
    await page.waitForTimeout(300);

    const unfiltered = gate();
    await page.route('**/board*', async (route: Route) => {
      if (!route.request().url().includes('position=') && unfiltered.armed) await unfiltered.hold();
      await route.continue();
    });

    await page.getByTestId('tab-draft').click();
    await expect(page.getByTestId('recommendation-row').first()).toBeVisible();
    // While the unfiltered correction is held, move to a chip.
    await page.getByRole('button', { name: 'TE', exact: true }).click();
    await expect.poll(async () => [...(await shownPositions(page))].join(), { timeout: 15_000 }).toBe('TE');

    unfiltered.open();
    await page.waitForTimeout(1200);
    expect(
      [...(await shownPositions(page))],
      'the revisit correction overwrote the chip the reader had moved to',
    ).toEqual(['TE']);
  });
});
