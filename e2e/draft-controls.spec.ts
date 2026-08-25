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

  /**
   * The bar's own controls, measured as a thumb meets them rather than as they
   * are drawn.
   *
   * The two are not the same number here and are not meant to be. §5 of the
   * design system says a target stays 44px even when the visible control is
   * smaller, and the board glyph and the three sort segments are all smaller:
   * 36px and 30px of painted control respectively, chosen so the bar costs the
   * board no rows. What was missing was the other half of that rule — the
   * target itself, which each of them now carries as an inset `::after`.
   *
   * So this hit-tests rather than reading `getBoundingClientRect`, because a box
   * measurement cannot tell the two halves apart and would have passed happily
   * on the day the target was eight pixels short.
   *
   * Height only. These sit shoulder to shoulder in one track, so growing a
   * target sideways would put it under its neighbour — asserted below, and it
   * is the reason the widths here are deliberately left as they are.
   */
  test('the board glyph and the sort segments are 44px to a thumb', async ({ page }) => {
    await openDraft(page);

    const measured = await page.evaluate(() => {
      const owns = (el: Element, x: number, y: number) => {
        const hit = document.elementFromPoint(x, y);
        return hit === el || el.contains(hit);
      };
      const reach = (el: Element) => {
        const b = el.getBoundingClientRect();
        const cx = b.left + b.width / 2;
        const cy = b.top + b.height / 2;
        let top = b.top;
        let bottom = b.bottom;
        for (let y = b.top - 1; y > b.top - 24; y -= 1) {
          if (!owns(el, cx, y)) break;
          top = y;
        }
        for (let y = b.bottom + 1; y < b.bottom + 24; y += 1) {
          if (!owns(el, cx, y)) break;
          bottom = y;
        }
        let left = b.left;
        let right = b.right;
        for (let x = b.left - 1; x > b.left - 24; x -= 1) {
          if (!owns(el, x, cy)) break;
          left = x;
        }
        for (let x = b.right + 1; x < b.right + 24; x += 1) {
          if (!owns(el, x, cy)) break;
          right = x;
        }
        return { hitH: bottom - top, hitW: right - left, boxW: b.width };
      };

      const ids = ['draft-board-open', 'sort-score', 'sort-adp', 'sort-dog', 'sort-pts'];
      return ids
        .map((id) => ({ id, el: document.querySelector(`[data-testid="${id}"]`) }))
        .filter((e): e is { id: string; el: Element } => e.el != null)
        .map((e) => ({ id: e.id, ...reach(e.el) }));
    });

    expect(measured.length, 'the bar lost a control').toBe(5);
    for (const m of measured) {
      // Two pixels of slack: the probe steps in whole pixels from the edges.
      expect(m.hitH, `${m.id} answers over ${Math.round(m.hitH)}px of height`).toBeGreaterThanOrEqual(42);
      // Sideways it must NOT have grown, or it is stealing its neighbour's taps.
      expect(m.hitW, `${m.id} reaches past its own box sideways`).toBeLessThanOrEqual(m.boxW + 1);
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

/**
 * WHAT IS LEFT TO FILL, READABLE WITHOUT A SIDEWAYS DRAG.
 *
 * The strip used to scroll horizontally, and in a league that starts a defence
 * it had to: seven counts at eight pixels of gap *plus* an interpunct with
 * eight of its own spent about twenty pixels on every join, so the bench — the
 * count a drafter checks most in the late rounds — sat off the right-hand edge
 * behind a scroll nothing announced.
 *
 * Measured here on injected roster shapes rather than on the seeded league,
 * which starts no defence and would leave the reported case untested. Three
 * shapes: a small one, the reported one, and a superflex league with a deep
 * bench that genuinely cannot fit a phone. All of them are derived from what
 * the board publishes, so nothing here hardcodes anybody's league.
 */
const ROSTER_SHAPES = {
  /** Six slots, no defence: the shape the seeded league has. */
  small: [
    { slot: 'QB', filled: 0, required: 1, accepts: ['QB'] },
    { slot: 'RB', filled: 1, required: 2, accepts: ['RB'] },
    { slot: 'WR', filled: 0, required: 2, accepts: ['WR'] },
    { slot: 'TE', filled: 0, required: 1, accepts: ['TE'] },
    { slot: 'FLEX', filled: 0, required: 1, accepts: ['RB', 'WR', 'TE'] },
    { slot: 'BN', filled: 0, required: 5, accepts: [], bench: true },
  ],
  /** The reported one: seven slots, a defence among them, a six-deep bench. */
  reported: [
    { slot: 'QB', filled: 0, required: 1, accepts: ['QB'] },
    { slot: 'RB', filled: 1, required: 2, accepts: ['RB'] },
    { slot: 'WR', filled: 3, required: 3, accepts: ['WR'] },
    { slot: 'TE', filled: 0, required: 1, accepts: ['TE'] },
    { slot: 'FLEX', filled: 0, required: 2, accepts: ['RB', 'WR', 'TE'] },
    { slot: 'DEF', filled: 0, required: 1, accepts: ['DEF'] },
    { slot: 'BN', filled: 0, required: 6, accepts: [], bench: true },
  ],
  /** Eight slots, superflex, and two-digit counts on both ends. */
  large: [
    { slot: 'QB', filled: 0, required: 1, accepts: ['QB'] },
    { slot: 'RB', filled: 12, required: 12, accepts: ['RB'] },
    { slot: 'WR', filled: 3, required: 3, accepts: ['WR'] },
    { slot: 'TE', filled: 0, required: 1, accepts: ['TE'] },
    { slot: 'FLEX', filled: 0, required: 2, accepts: ['RB', 'WR', 'TE'] },
    { slot: 'SUPER_FLEX', filled: 0, required: 1, accepts: ['QB', 'RB', 'WR', 'TE'] },
    { slot: 'DEF', filled: 0, required: 1, accepts: ['DEF'] },
    { slot: 'BN', filled: 10, required: 12, accepts: [], bench: true },
  ],
} as const;

/** Open Draft with the board's roster strip replaced by one of the shapes above. */
async function openWithShape(page: Page, shape: keyof typeof ROSTER_SHAPES) {
  await page.route('**/api/drafts/*/board*', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.rosterProgress = ROSTER_SHAPES[shape];
    await route.fulfill({ response, body: JSON.stringify(body) });
  });
  await openDraft(page);
  await expect(page.getByTestId('roster-progress')).toBeVisible();
}

/** Everything the strip is drawing, and whether any of it is out of reach. */
async function stripGeometry(page: Page) {
  return page.evaluate(() => {
    const strip = document.querySelector('[data-testid="roster-progress"]') as HTMLElement;
    const slots = [...strip.querySelectorAll('.slot')] as HTMLElement[];
    const viewport = document.documentElement.clientWidth;
    return {
      slots: slots.map((slot) => ({
        name: slot.getAttribute('data-slot'),
        text: (slot.textContent ?? '').replace(/\s+/g, ' ').trim(),
        title: slot.getAttribute('title'),
        // `+1` for the sub-pixel a fractional layout leaves behind.
        clipped: slot.scrollWidth > slot.clientWidth + 1,
        offscreen: slot.getBoundingClientRect().right > viewport + 1,
        top: Math.round(slot.getBoundingClientRect().top),
      })),
      // The strip itself must not be a scroller, whatever it holds.
      scrolls: strip.scrollWidth > strip.clientWidth + 1,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}

test.describe('the roster strip', () => {
  /**
   * The order, which is the chip row's order and is shared with it.
   *
   * Sleeper lists a defence among the positions, so the strip used to read
   * `… TE · DEF · FLX · BN` — the defence interrupting the four positions a
   * drafter is choosing between, and the flex that spans three of them landing
   * after it.
   */
  test('reads QB, RB, WR, TE, FLX, DEF, then the bench', async ({ page }) => {
    await openWithShape(page, 'reported');
    const { slots } = await stripGeometry(page);
    expect(slots.map((s) => s.name)).toEqual(['QB', 'RB', 'WR', 'TE', 'FLEX', 'DEF', 'BN']);
    // The labels the reader sees, not the slot names Sleeper uses.
    expect(slots.map((s) => s.text)).toEqual([
      '0/1 QB',
      '1/2 RB',
      '3/3 WR',
      '0/1 TE',
      '0/2 FLX',
      '0/1 DEF',
      '0/6 BN',
    ]);
  });

  for (const shape of ['small', 'reported', 'large'] as const) {
    test(`fits a ${shape} roster on the screen, without scrolling or clipping`, async ({ page }) => {
      await openWithShape(page, shape);
      const { slots, scrolls, pageOverflow } = await stripGeometry(page);

      expect(slots.length, 'the strip drew nothing').toBeGreaterThan(4);
      expect(scrolls, 'the strip is a horizontal scroller again').toBe(false);
      expect(pageOverflow, 'the page scrolls sideways').toBeLessThanOrEqual(0);

      for (const slot of slots) {
        expect(slot.clipped, `${slot.name} is clipped`).toBe(false);
        expect(slot.offscreen, `${slot.name} is off the right-hand edge`).toBe(false);
        // Counts are never abbreviated: `0/6` is the reading, `0/…` is not.
        expect(slot.text, `${slot.name} lost its count`).toMatch(/^\d+\/\d+ \S+$/);
        // ...and the sentence behind the count survives at every width.
        expect(slot.title, `${slot.name} lost its accessible description`).toBeTruthy();
      }

      /*
       * Bench is the count that was off the edge, so it gets its own assertion
       * rather than being one of the loop's many.
       */
      const bench = slots.find((s) => s.name === 'BN')!;
      expect(bench.offscreen, 'the bench is off the edge again').toBe(false);

      /*
       * Compact, said as a number so "denser" cannot drift back into an
       * opinion. Two lines is the ceiling: the reported shape takes one at 430,
       * 390 and 375 and two at 360, and the superflex league takes two
       * everywhere — which is the wrap this preferred over a sideways drag.
       */
      const lines = new Set(slots.map((s) => s.top)).size;
      expect(lines, `the strip ran to ${lines} lines`).toBeLessThanOrEqual(2);
    });
  }
});
