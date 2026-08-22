/**
 * The columns a player row is built on, and the tag that no longer sits on one.
 *
 * The club marks used to land at slightly different distances from the *right*
 * edge depending on how wide the number beside them was — a two-character tally
 * pushed the mark one way, a three-character one the other, and a row with no
 * tally at all a third. Nothing was wrong with any single row; the *column* was
 * ragged, which reads as a rendering fault to somebody who could not say what
 * was wrong with it.
 *
 * The marks have since moved to the leading edge, into the identity cluster
 * with the position and the name, and the claim survives the move intact: every
 * mark on a list starts at the same x, to the pixel. What holds it there is
 * different — a fixed pill width rather than a fixed trailing field — and the
 * trailing field is still doing its own job for the tally and the availability
 * tag, so both mechanisms are asserted below.
 *
 * And the AVOID chip is gone from the cards. The tally it was describing is
 * still beside the name, negative sign and all, which is what the reader
 * actually interprets.
 */

import { expect, test, type Page } from '@playwright/test';

async function openDraft(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('board-list')).toBeVisible();
}

/**
 * Position, then club, then name — the order every list in the app opens with.
 *
 * Read as geometry rather than as a DOM order, because the DOM can be right
 * while the layout is not: a `row-reverse` or an `order` property would put the
 * pill last on screen with the markup unchanged. What a reader sees is three
 * boxes left to right, and that is what is checked.
 */
async function identityReadsLeftToRight(page: Page, rowTestId: string, atLeast = 5) {
  const rows = await page.locator(`[data-testid="${rowTestId}"]`).evaluateAll((all) =>
    all.slice(0, 12).map((row) => {
      const box = (sel: string) => row.querySelector(sel)?.getBoundingClientRect() ?? null;
      const pill = box('.pos-pill');
      const mark = box('.team-logo, [data-testid="team-code"]');
      const name = box('.player-name');
      return pill && mark && name
        ? { pill: pill.right, markLeft: mark.left, markRight: mark.right, name: name.left }
        : null;
    }),
  );
  const drawn = rows.filter((r): r is NonNullable<typeof r> => r != null);
  expect(drawn.length, `${rowTestId} should be drawing identity clusters`).toBeGreaterThanOrEqual(atLeast);
  for (const r of drawn) {
    expect(r.pill, 'the pill ends before the club begins').toBeLessThanOrEqual(r.markLeft + 1);
    expect(r.markRight, 'and the club ends before the name begins').toBeLessThanOrEqual(r.name + 1);
  }
}

/** Where each club mark begins, rounded to the pixel the eye can see. */
async function markLeftEdges(page: Page, within: string): Promise<number[]> {
  return page.evaluate((selector) => {
    const rows = [...document.querySelectorAll(selector)];
    return rows
      .map((row) => row.querySelector('.team-logo, .team-code'))
      .filter((mark): mark is Element => mark != null)
      .map((mark) => Math.round(mark.getBoundingClientRect().left));
  }, within);
}

test.describe('the club marks line up', () => {
  test('every mark on the draft board starts on the same edge', async ({ page }) => {
    await openDraft(page);
    const edges = await markLeftEdges(page, '[data-testid="recommendation-row"]');
    expect(edges.length, 'the board should be drawing marks at all').toBeGreaterThan(4);
    expect(new Set(edges).size, `marks started at ${[...new Set(edges)].join(', ')}`).toBe(1);
  });

  /**
   * The case that used to break it.
   *
   * A row with a tally, a row without one and a row with an availability tag
   * are the three widths that produced three different offsets. All three are
   * on the board at once, and the assertion above covers them — this one proves
   * the board actually contains the mix, so a board that happened to be uniform
   * could not pass by accident.
   */
  test('and the board really does mix rows with and without a tally', async ({ page }) => {
    await openDraft(page);
    const rows = page.locator('[data-testid="recommendation-row"]');
    const withTally = await rows.locator('[data-testid="compact-tally"]').count();
    expect(withTally, 'some rows carry a tally').toBeGreaterThan(0);
    expect(withTally, 'and some do not').toBeLessThan(await rows.count());
  });

  test('and the same is true down the players list', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('tab-players').click();
    await expect(page.locator('[data-testid="player-search-row"]').first()).toBeVisible();
    const edges = await markLeftEdges(page, '[data-testid="player-search-row"]');
    expect(edges.length).toBeGreaterThan(4);
    expect(new Set(edges).size).toBe(1);
  });
});

/**
 * One identity, four screens.
 *
 * The point of moving the club's mark off the trailing edge was never the
 * trailing edge — it was that a reader who learns to read a player on the draft
 * board should not have to learn again on Players, on Trades or on Waivers.
 * Position, club, name, in that order, on all four, as one cluster. A screen
 * that quietly keeps its own arrangement is exactly the divergence this replaced.
 */
test.describe('the identity cluster', () => {
  test('reads position, club, name on the draft board', async ({ page }) => {
    await openDraft(page);
    await identityReadsLeftToRight(page, 'recommendation-row');
  });

  test('and on Players', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('tab-players').click();
    await expect(page.locator('[data-testid="player-search-row"]').first()).toBeVisible();
    await identityReadsLeftToRight(page, 'player-search-row');
  });

  /*
   * Three rather than five, and only here.
   *
   * Trades lists players the newsletter has an opinion about, so how many rows
   * exist is a property of the evidence rather than of the layout — the seed
   * carries three. Skipping when the fixture is small would be a test that
   * quietly stops running; asking for what the fixture actually has is a test
   * that keeps working.
   */
  test('and on Trades', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('tab-trades').click();
    await expect(page.locator('[data-testid="trade-row"]').first()).toBeVisible();
    await identityReadsLeftToRight(page, 'trade-row', 3);
  });

  /**
   * And on Waivers, which draws the same cluster from its own component.
   *
   * A different file builds this row — the waiver card is not a
   * `CompactPlayerRow` — so "one identity everywhere" is a claim about two
   * implementations agreeing rather than about one being reused, and it is
   * worth checking rather than assuming.
   */
  test('and on Waivers', async ({ page }) => {
    await page.goto('/?demo=waivers-tuesday-active');
    await page.getByTestId('tab-waivers').click();
    await expect(page.locator('[data-testid="waiver-row"]').first()).toBeVisible();
    await identityReadsLeftToRight(page, 'waiver-row', 2);
  });

  /**
   * The mark is smaller inside a name than it is standing on its own.
   *
   * At 22px beside a 16px name it was the loudest object in the row, which is
   * how a decoration stops being one. The size is scoped to the cluster rather
   * than changed in the token, so a mark that is *not* inside a name — a
   * matchup lineup row, a player's own page — is still the size the token was
   * chosen for.
   */
  test('draws the club quietly enough to be part of the name', async ({ page }) => {
    await openDraft(page);
    const [mark, name] = await Promise.all([
      page.locator('[data-testid="recommendation-row"] .team-logo').first().boundingBox(),
      page.locator('[data-testid="recommendation-row"] .player-name').first().boundingBox(),
    ]);
    expect(mark!.width, 'the club is no louder than the name it qualifies').toBeLessThanOrEqual(name!.height + 1);
    expect(mark!.width, 'and is still big enough to recognise').toBeGreaterThanOrEqual(12);
  });

  /**
   * Alignment is not padding.
   *
   * The field is reserved whether or not anything is in it, so the fix must not
   * have been bought by faking a value into the empty rows — no zero-padded
   * `08`, no placeholder dash where a tally would be.
   */
  test('without inventing a value for the rows that have none', async ({ page }) => {
    await openDraft(page);
    const fields = await page
      .locator('[data-testid="recommendation-row"] .player-row-meta')
      .evaluateAll((nodes) => nodes.map((n) => n.textContent!.trim()));
    expect(fields.length).toBeGreaterThan(4);
    for (const text of fields) {
      // Either a real signed tally (with a status tag beside it or not), or
      // genuinely empty. Never a padded or placeholder number.
      expect(text).not.toMatch(/^0\d/);
      expect(text).not.toBe('—');
    }
    expect(fields.some((t) => t === ''), 'some rows leave the field empty').toBe(true);
  });
});

test.describe('the AVOID tag', () => {
  /**
   * Removed from the card, and only from the card.
   *
   * The tally underneath it is untouched: the API still carries the flag, the
   * engine still applies its bounded penalty, and the negative number the
   * reader interprets is still printed beside the name.
   */
  test('no longer appears on any player card', async ({ page }) => {
    await openDraft(page);
    await expect(page.getByTestId('avoid-tag')).toHaveCount(0);
    await expect(page.locator('[data-testid="board-list"]')).not.toContainText('AVOID');
  });

  test('but the tally it described is still on the row, sign and all', async ({ page }) => {
    await openDraft(page);
    const board = await (await page.request.get('/api/drafts/demo-draft/board?limit=40')).json();
    const scored = (board.recommendations as { name: string; newsLifetimeNet: number }[]).filter(
      (r) => r.newsLifetimeNet !== 0,
    );
    expect(scored.length, 'the demo board has players the research has an opinion about').toBeGreaterThan(0);

    // The signed number is still printed beside the name — which is the thing
    // the reader interprets now that nothing interprets it for them.
    for (const rec of scored.slice(0, 3)) {
      const row = page.locator('[data-testid="recommendation-row"]', { hasText: rec.name }).first();
      const expected = rec.newsLifetimeNet > 0 ? `+${rec.newsLifetimeNet}` : `${rec.newsLifetimeNet}`;
      await expect(row.getByTestId('compact-tally')).toContainText(expected);
      await expect(row).not.toContainText('AVOID');
    }
  });

  /**
   * The flag itself is untouched.
   *
   * The API still carries it and the engine still applies its bounded penalty
   * below the threshold — this change removed a label from a card, not a
   * judgement from the model.
   */
  test('and the model still computes it', async ({ page }) => {
    const board = await (await page.request.get('/api/drafts/demo-draft/board?limit=40')).json();
    const recommendations = board.recommendations as { avoid?: { active: boolean; lifetimeNet: number } }[];
    expect(recommendations.every((r) => typeof r.avoid?.active === 'boolean')).toBe(true);
  });
});
