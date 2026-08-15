/**
 * The Draft controls, as a contract.
 *
 * The search field used to hold a whole row of the phone, directly above the
 * list it is about — on the one screen where a row is a player, the most
 * expensive row on the page. It is now folded into a glyph sitting immediately
 * left of the position filters, and unfolds when it is asked for.
 *
 * Two things are being defended here and they pull in opposite directions.
 * **The row must be shorter** — that is the entire point, and it is asserted as
 * a number, because "denser" is otherwise an opinion that drifts back. And
 * **nothing about searching may have changed**: the same player universe, the
 * same matching, the same clear, the same board ranks, the same filters. A fold
 * that quietly narrowed what could be found would be a far worse trade than the
 * row it saved.
 */

import { expect, test, type Page } from '@playwright/test';

/**
 * Draft, as a reader arrives at it.
 *
 * Deliberately no tap on the Draft destination: Draft is where the app lands,
 * and tapping the destination you are already on is the "clear this screen"
 * gesture — it folds the search away. Going through it would mean every test
 * below measured a control that had just been reset, and a search field that
 * never folded at all would look exactly like one that always does.
 */
async function openDraft(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('board-list')).toBeVisible();
  await expect(page.getByTestId('tab-draft')).toHaveAttribute('aria-current', 'page');
}

/** Everything between the roster line and the first player, in pixels. */
async function controlsHeight(page: Page) {
  return page.evaluate(() => {
    const controls = document.querySelector('[data-testid="draft-search-controls"]')!.getBoundingClientRect();
    const first = document.querySelector('[data-testid="recommendation-row"]')!.getBoundingClientRect();
    const roster = document.querySelector('[data-testid="roster-progress"]')!.getBoundingClientRect();
    return {
      row: Math.round(controls.height),
      // From the bottom of the roster line to the top of the first card: the
      // measurement a reader actually feels.
      band: Math.round(first.top - roster.bottom),
      firstCardTop: Math.round(first.top),
    };
  });
}

test.describe('collapsed', () => {
  test('is a search button beside the filters, and no field', async ({ page }) => {
    await openDraft(page);
    const controls = page.getByTestId('draft-search-controls');
    await expect(controls).toHaveAttribute('data-search', 'closed');

    // The button is there, named, and the field is not in the page at all.
    const button = page.getByTestId('draft-search-open');
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute('aria-label', 'Search the board');
    await expect(page.getByTestId('draft-search')).toHaveCount(0);

    // The filters are still one tap away, on the same row.
    for (const label of ['ALL', 'QB', 'RB', 'WR', 'TE']) {
      await expect(controls.getByRole('button', { name: label, exact: true })).toBeVisible();
    }
    const rows = await page.evaluate(
      () => new Set([...document.querySelectorAll('.control-row')].map((r) => Math.round(r.getBoundingClientRect().top))).size,
    );
    expect(rows, 'the controls must be one row, not two').toBe(1);
  });

  /**
   * The number the fold exists for.
   *
   * A search field of its own is ~46px including its margin. The whole control
   * band — roster line to first card — has to stay well under what two rows
   * would cost, and the first card has to begin high on the screen.
   */
  test('costs one row of controls, not two', async ({ page }) => {
    await openDraft(page);
    const h = await controlsHeight(page);
    expect(h.row, `the control row is ${h.row}px`).toBeLessThanOrEqual(52);
    expect(h.band, `the controls band is ${h.band}px`).toBeLessThanOrEqual(60);
    // Roughly a quarter of the shortest supported phone, before any player.
    expect(h.firstCardTop, `the first player starts at ${h.firstCardTop}px`).toBeLessThanOrEqual(210);
  });

  test('every control on the row is a full target', async ({ page }) => {
    await openDraft(page);
    /*
     * The visible chip is deliberately smaller than the thing you tap: 36px of
     * pill inside a 44px button. What matters is the button.
     */
    const targets = await page.evaluate(() => {
      const row = document.querySelector('[data-testid="draft-search-controls"]')!;
      return [...row.querySelectorAll('button')].map((b) => {
        const box = b.getBoundingClientRect();
        return { name: b.textContent?.trim() || b.getAttribute('aria-label') || '?', w: box.width, h: box.height };
      });
    });
    expect(targets.length).toBeGreaterThan(3);
    for (const t of targets) {
      expect(t.h, `${t.name} is ${Math.round(t.h)}px tall`).toBeGreaterThanOrEqual(36);
      expect(t.w, `${t.name} is ${Math.round(t.w)}px wide`).toBeGreaterThanOrEqual(38);
    }
  });

  test('fits this width without wrapping or overflowing', async ({ page }) => {
    await openDraft(page);
    const fit = await page.evaluate(() => {
      const row = document.querySelector('[data-testid="draft-search-controls"]')!;
      /* Centres, not tops: the two occupants are deliberately different heights
         — a 36px field beside 44px filters — and share one line. */
      const centres = [...row.children].map((c) => {
        const box = c.getBoundingClientRect();
        return Math.round(box.top + box.height / 2);
      });
      return {
        spread: Math.max(...centres) - Math.min(...centres),
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        inside: [...row.children].every((c) => {
          const box = c.getBoundingClientRect();
          const outer = row.getBoundingClientRect();
          return box.top >= outer.top - 1 && box.bottom <= outer.bottom + 1;
        }),
      };
    });
    expect(fit.spread, 'the search button and the filters are on one line').toBeLessThanOrEqual(1);
    expect(fit.inside, 'something escaped the control row').toBe(true);
    expect(fit.pageOverflow, 'the row pushed the page sideways').toBeLessThanOrEqual(1);
  });
});

test.describe('expanding', () => {
  test('gives the row to a focused field, and gives it back', async ({ page }) => {
    await openDraft(page);
    const before = await controlsHeight(page);

    await page.getByTestId('draft-search-open').click();
    const field = page.getByTestId('draft-search');
    await expect(field).toBeVisible();
    await expect(field).toBeFocused();
    await expect(page.getByTestId('draft-search-controls')).toHaveAttribute('data-search', 'open');

    // The row is the same row: nothing above it moved, nothing below it jumped.
    const during = await controlsHeight(page);
    expect(Math.abs(during.firstCardTop - before.firstCardTop), 'the page jumped when search opened').toBeLessThanOrEqual(
      2,
    );

    await page.getByTestId('draft-search-close').click();
    await expect(page.getByTestId('draft-search')).toHaveCount(0);
    await expect(page.getByTestId('draft-search-open')).toBeVisible();
    expect(await controlsHeight(page)).toEqual(before);
  });

  test('leaves the draft state exactly where it was', async ({ page }) => {
    await openDraft(page);
    await page.getByRole('button', { name: 'QB', exact: true }).click();
    const rows = await page.getByTestId('recommendation-row').count();
    const first = await page.getByTestId('recommendation-row').first().locator('.player-name').innerText();

    await page.getByTestId('draft-search-open').click();
    await expect(page.getByTestId('draft-search')).toBeVisible();
    // Opening a field is not a filter: the same players, in the same order.
    await expect(page.getByTestId('recommendation-row')).toHaveCount(rows);
    expect(await page.getByTestId('recommendation-row').first().locator('.player-name').innerText()).toBe(first);
    expect(new URL(page.url()).pathname).toBe('/');

    await page.getByTestId('draft-search-close').click();
    await expect(page.getByRole('button', { name: 'QB', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'ALL', exact: true }).click();
  });
});

test.describe('the query itself', () => {
  test('searches the whole pool, not the visible forty', async ({ page }) => {
    await openDraft(page);
    const board = await (await page.request.get('/api/drafts/demo-draft/board?limit=250')).json();
    const deep = board.recommendations[board.recommendations.length - 1] as { name: string };

    await page.getByTestId('draft-search-open').click();
    await page.getByTestId('draft-search').fill(deep.name);
    const rows = page.getByTestId('recommendation-row');
    await expect(rows.first().locator('.player-name')).toHaveText(deep.name);
    // He keeps the rank he has on the board, not his place in the result.
    expect(Number(await rows.first().locator('.rank').innerText())).toBeGreaterThan(1);
    await page.getByTestId('draft-search-close').click();
  });

  /**
   * Clearing empties the field; it does not close it.
   *
   * That is the native behaviour, and it is also the rule that stops a query
   * disappearing without the user having asked for it: the only control that
   * discards the text is the one labelled Cancel.
   */
  test('the clear control empties the field and leaves it open', async ({ page }) => {
    await openDraft(page);
    const all = await page.getByTestId('recommendation-row').count();

    await page.getByTestId('draft-search-open').click();
    await page.getByTestId('draft-search').fill('sotelo');
    await expect(page.getByTestId('recommendation-row')).toHaveCount(1);

    await page.getByTestId('search-clear').click();
    await expect(page.getByTestId('draft-search')).toHaveValue('');
    await expect(page.getByTestId('draft-search'), 'clearing must not fold the field away').toBeVisible();
    await expect(page.getByTestId('recommendation-row')).toHaveCount(all);
    await page.getByTestId('draft-search-close').click();
  });

  test('an active query is never dropped by anything but Cancel', async ({ page }) => {
    await openDraft(page);
    await page.getByTestId('draft-search-open').click();
    await page.getByTestId('draft-search').fill('sotelo');
    await expect(page.getByTestId('recommendation-row')).toHaveCount(1);

    // Tapping elsewhere on the page, scrolling, and opening a player all leave
    // the query alone — the field is only closed by the control that says so.
    await page.getByTestId('recommendation-row').first().click();
    await expect(page.getByTestId('draft-search')).toHaveValue('sotelo');
    await page.evaluate(() => window.scrollTo(0, 200));
    await expect(page.getByTestId('draft-search')).toHaveValue('sotelo');

    await page.getByTestId('draft-search-close').click();
    await expect(page.getByTestId('draft-search')).toHaveCount(0);
    await expect(page.getByTestId('recommendation-row').first()).toBeVisible();
  });

  test('says so plainly when nobody matches', async ({ page }) => {
    await openDraft(page);
    await page.getByTestId('draft-search-open').click();
    await page.getByTestId('draft-search').fill('zzzznobody');
    await expect(page.getByText(/Nobody available matching/)).toBeVisible();
    await page.getByTestId('draft-search-close').click();
    await expect(page.getByTestId('recommendation-row').first()).toBeVisible();
  });
});

test.describe('search and the filters together', () => {
  test('the filters still filter after the search has been used', async ({ page }) => {
    await openDraft(page);
    const all = await page.getByTestId('recommendation-row').count();

    await page.getByTestId('draft-search-open').click();
    await page.getByTestId('draft-search').fill('a');
    await page.getByTestId('draft-search-close').click();

    await page.getByRole('button', { name: 'QB', exact: true }).click();
    /*
     * Waited for rather than counted straight away. Changing the filter refetches
     * the board, and for a frame the previous list is still on screen — counting
     * then reads the old number and calls the filter broken.
     */
    await expect(page.locator('[data-testid="recommendation-row"]:not([data-position="QB"])')).toHaveCount(0);
    const qbs = await page.getByTestId('recommendation-row').count();
    expect(qbs).toBeGreaterThan(0);
    expect(qbs).toBeLessThan(all);
    await page.getByRole('button', { name: 'ALL', exact: true }).click();
    await expect(page.getByTestId('recommendation-row')).toHaveCount(all);
  });

  test('the queue filter is untouched by any of this', async ({ page }) => {
    await openDraft(page);
    await page.getByTestId('draft-search-open').click();
    await page.getByTestId('draft-search-close').click();
    await page.getByTestId('queue-filter').click();
    await expect(page.getByText(/Your queue is empty/)).toBeVisible();
    await page.getByRole('button', { name: 'ALL', exact: true }).click();
  });
});
