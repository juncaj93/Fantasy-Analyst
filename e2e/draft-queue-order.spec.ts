/**
 * The queue holds the order the reader dragged it into.
 *
 * Reported: dragging a player in the ★ queue appeared to work, and then the
 * list snapped back to the board's ordering. The drag was never the problem —
 * the precedence was. The screen re-applied the global sort to the queue
 * whenever the selected mode was not Score, so a reader who had been reading
 * the board by ADP or DOG lost their drop on the very next render.
 *
 * The precedence itself is pinned as a pure function in
 * `tests/audit.queueOrder.test.ts`. This file exists because that is not what
 * the reader experienced: they experienced a gesture on a phone that did not
 * stick, and the only way to be sure it sticks is to make it, on a phone-sized
 * viewport, and look.
 */

import { expect, test, type Page } from '@playwright/test';

import { LONG_PRESS_MS } from '../src/core/draft/dragReorder.ts';

async function openQueue(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('board-list')).toBeVisible();
  await page.getByTestId('queue-filter').click();
  await expect(page.getByTestId('queue-filter')).toHaveAttribute('aria-pressed', 'true');
}

/** The rows currently drawn, top to bottom. */
async function order(page: Page): Promise<string[]> {
  return page.$$eval('[data-testid="recommendation-row"]', (rows) =>
    rows.map((r) => r.getAttribute('data-player-id')!),
  );
}

/**
 * Star exactly `count` players, from a queue that is known to be empty.
 *
 * The dev server keeps one database for the whole run, so the queue a previous
 * test left behind is still there — and starring a player who is already
 * starred un-stars him. Emptied first, therefore, rather than assumed empty.
 *
 * Taken from the top of the board, so the queue's initial order and the board's
 * are the same, which is what makes a later divergence meaningful.
 */
async function queueTopPlayers(page: Page, count: number): Promise<string[]> {
  await page.goto('/');
  await expect(page.getByTestId('board-list')).toBeVisible();

  // Empty whatever is in there. The ★ filter is the queue, so a row leaving it
  // is a row leaving the list.
  await page.getByTestId('queue-filter').click();
  await expect(page.getByTestId('queue-filter')).toHaveAttribute('aria-pressed', 'true');
  const rows = page.locator('[data-testid="recommendation-row"]');
  for (let guard = 0; guard < 40; guard++) {
    const remaining = await rows.count();
    if (remaining === 0) break;
    await rows.first().getByTestId('queue-control').click();
    await expect(rows).toHaveCount(remaining - 1);
  }

  await page.getByRole('button', { name: 'ALL', exact: true }).click();
  await expect(page.getByTestId('board-list')).toBeVisible();
  const ids = (await order(page)).slice(0, count);
  for (const id of ids) {
    const control = page
      .locator(`[data-testid="recommendation-row"][data-player-id="${id}"]`)
      .getByTestId('queue-control');
    await control.click();
    await expect(control).toHaveAttribute('aria-pressed', 'true');
  }
  return ids;
}

/**
 * Drag the row at `from` onto the row at `to`, through the grip.
 *
 * Pointer events rather than `dragTo`, and a **long press before any movement**.
 * Both matter, and getting either wrong tests nothing:
 *
 *  - the handle listens for `pointerdown` and carries `touch-action: none`,
 *    which is the mechanism that stops the page scrolling instead of the row
 *    moving;
 *  - the gesture is the iOS reorder gesture, so `pressVerdict` classifies any
 *    movement inside `LONG_PRESS_MS` as a scroll and abandons the drag — final,
 *    deliberately, so a slow scroll cannot turn into a drag halfway down a list.
 *    A harness that presses and moves immediately therefore reorders nothing and
 *    reports it as a product failure.
 *
 * The finger lands on the *centre* of the target row, because `targetIndex`
 * works in whole row heights from where the drag started rather than by
 * hit-testing.
 */
async function dragRow(page: Page, from: number, to: number) {
  const rows = page.locator('[data-testid="recommendation-row"]');
  const handle = rows.nth(from).getByTestId('queue-drag-handle');
  const source = await handle.boundingBox();
  const target = await rows.nth(to).boundingBox();
  if (!source || !target) throw new Error('queue rows are not laid out');

  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  // Held still, past the long-press threshold, exactly as a thumb would be.
  await page.waitForTimeout(LONG_PRESS_MS + 250);
  // Several steps: a single jump can land outside every row's hit box on the
  // way past, which is not what a finger does.
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 });
  await page.mouse.up();
}

/**
 * Put the queue back the way this spec found it: empty.
 *
 * The dev server keeps one database for the whole run, so a queue left behind
 * here is a queue every later spec has to cope with — and several of them
 * reasonably assume the ★ list starts empty. Done through the API rather than
 * the UI because it is a teardown, not a thing being tested, and it must not
 * fail a passing test by being slow.
 */
async function emptyQueue(page: Page) {
  const res = await page.request.get('/api/drafts/demo-draft/board?limit=200&queued=1');
  if (!res.ok()) return;
  const board = (await res.json()) as { recommendations: { playerId: string }[] };
  for (const rec of board.recommendations ?? []) {
    await page.request.post(`/api/players/${rec.playerId}/queue`, { data: { queued: false } });
  }
}

test.describe('the queue order', () => {
  test.afterEach(async ({ page }) => {
    await emptyQueue(page);
  });

  test('survives a drag, and the list does not snap back', async ({ page }) => {
    const queued = await queueTopPlayers(page, 4);
    await openQueue(page);
    expect(await order(page)).toEqual(queued);

    await dragRow(page, 3, 0);
    const moved = await order(page);
    expect(moved[0]).toBe(queued[3]);
    expect(moved).toHaveLength(queued.length);
    // Still there a moment later, after the commit has settled.
    await expect
      .poll(async () => (await order(page))[0], { timeout: 5000 })
      .toBe(queued[3]);
  });

  test('is not re-sorted by Score, ADP or DOG', async ({ page }) => {
    const queued = await queueTopPlayers(page, 4);
    await openQueue(page);
    await dragRow(page, 3, 0);
    await expect.poll(async () => (await order(page))[0], { timeout: 5000 }).toBe(queued[3]);
    const manual = await order(page);

    /*
     * The regression, exactly. Every one of these re-sorted the queue before,
     * because the screen ran the board's sorter over the queued rows whenever
     * the selected mode was not Score.
     */
    for (const mode of ['sort-adp', 'sort-dog', 'sort-score']) {
      await page.getByTestId(mode).click();
      await expect(page.getByTestId(mode)).toHaveAttribute('aria-checked', 'true');
      expect(await order(page), `${mode} re-ordered the queue`).toEqual(manual);
    }
  });

  test('says the sort control is not the thing ordering it', async ({ page }) => {
    await queueTopPlayers(page, 3);
    await page.goto('/');
    await expect(page.getByTestId('board-list')).toBeVisible();
    // On the ordinary board the control is doing its job and looks like it.
    await expect(page.getByTestId('draft-sort')).toHaveAttribute('data-inactive', 'no');

    await page.getByTestId('queue-filter').click();
    await expect(page.getByTestId('draft-sort')).toHaveAttribute('data-inactive', 'yes');
    // Still there and still operable — leaving the queue must not cost the
    // reader the mode they had chosen.
    await expect(page.getByTestId('sort-adp')).toBeVisible();
    await expect(page.getByTestId('sort-adp')).toBeEnabled();
  });

  test('restores the chosen sort for the board on the way out', async ({ page }) => {
    await queueTopPlayers(page, 3);
    await page.goto('/');
    await expect(page.getByTestId('board-list')).toBeVisible();
    await page.getByTestId('sort-adp').click();
    const byAdp = await order(page);

    await page.getByTestId('queue-filter').click();
    await expect(page.getByTestId('sort-adp')).toHaveAttribute('aria-checked', 'true');

    // Back to the whole board: the mode they chose, still chosen, still applied.
    await page.getByRole('button', { name: 'ALL', exact: true }).click();
    await expect(page.getByTestId('sort-adp')).toHaveAttribute('aria-checked', 'true');
    expect(await order(page)).toEqual(byAdp);
  });

  test('survives leaving the screen and coming back', async ({ page }) => {
    const queued = await queueTopPlayers(page, 4);
    await openQueue(page);
    await dragRow(page, 3, 0);
    await expect.poll(async () => (await order(page))[0], { timeout: 5000 }).toBe(queued[3]);
    const manual = await order(page);

    await page.getByTestId('tab-players').click();
    await page.getByTestId('tab-draft').click();
    await expect(page.getByTestId('board-list')).toBeVisible();
    await page.getByTestId('queue-filter').click();
    // Read back from the server, which is where the order actually lives.
    await expect.poll(async () => order(page), { timeout: 5000 }).toEqual(manual);
  });

  test('survives a reload, because the order is stored rather than derived', async ({ page }) => {
    const queued = await queueTopPlayers(page, 4);
    await openQueue(page);
    await dragRow(page, 3, 0);
    await expect.poll(async () => (await order(page))[0], { timeout: 5000 }).toBe(queued[3]);
    const manual = await order(page);

    await page.reload();
    await expect(page.getByTestId('board-list')).toBeVisible();
    await page.getByTestId('queue-filter').click();
    await expect.poll(async () => order(page), { timeout: 5000 }).toEqual(manual);
  });

  test('the grip moves the row rather than scrolling the page', async ({ page }) => {
    const queued = await queueTopPlayers(page, 4);
    await openQueue(page);
    const before = await page.evaluate(() => window.scrollY);

    await dragRow(page, 3, 0);
    expect(await page.evaluate(() => window.scrollY), 'the page scrolled instead').toBe(before);
    await expect.poll(async () => (await order(page))[0], { timeout: 5000 }).toBe(queued[3]);
  });

  test('the grip is reachable, and clear of the bottom navigation', async ({ page }) => {
    await queueTopPlayers(page, 4);
    await openQueue(page);
    const grips = page.getByTestId('queue-drag-handle');
    expect(await grips.count()).toBeGreaterThan(3);

    const nav = await page.getByTestId('tab-draft').boundingBox();
    const first = await grips.first().boundingBox();
    expect(first).toBeTruthy();
    /*
     * Measured rather than aspired to.
     *
     * The grip is 22×28 at 390px. That is **below the 44px this project's own
     * design system asks for** ("touch targets stay at 44px even when the
     * visible control is smaller", `--tap: 44`), and it is not fixed here:
     * there are thirteen pixels of gutter to its left and eight to the star
     * beside it, so reaching 44 means taking the difference from the star or
     * from the row's own expand target. That is a design decision with a real
     * trade-off, not a bug with an obvious fix, and it is recorded in
     * `docs/MODEL_INTEGRITY.md` rather than decided in a test file.
     *
     * What is asserted is what must not regress: the grip exists, it is big
     * enough to hit, and it is never underneath the bottom bar.
     */
    expect(first!.width).toBeGreaterThanOrEqual(22);
    expect(first!.height).toBeGreaterThanOrEqual(22);
    if (nav) expect(first!.y + first!.height).toBeLessThan(nav.y);
  });

  test('ordering changes no number on any card', async ({ page }) => {
    const queued = await queueTopPlayers(page, 4);
    await openQueue(page);
    const metricsOf = () =>
      page.evaluate(() => {
        const out: Record<string, string> = {};
        for (const row of document.querySelectorAll('[data-testid="recommendation-row"]')) {
          out[row.getAttribute('data-player-id')!] = (
            row.querySelector('.player-row-metrics')?.textContent ?? ''
          )
            .replace(/\s+/g, ' ')
            .trim();
        }
        return out;
      });

    const before = await metricsOf();
    await dragRow(page, 3, 0);
    await expect.poll(async () => (await order(page))[0], { timeout: 5000 }).toBe(queued[3]);
    // Score, ADP, DOG, Val, Next — per player, unchanged by having been moved.
    expect(await metricsOf()).toEqual(before);
  });
});
