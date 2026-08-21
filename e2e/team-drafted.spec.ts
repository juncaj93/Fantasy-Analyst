/**
 * Team, mid-draft: the drafted roster, two players wide.
 *
 * A drafted player is a name, a club and the pick he cost. Each of those used
 * to take a full-width row, most of which was the gap between the name and the
 * mark on its far edge — and mid draft this is the list a manager checks
 * between picks, so what it costs vertically is most of what it costs at all.
 *
 * The pass puts two players on a row. What that buys is measurable, so this
 * file measures it rather than asserting a class name: how tall a player is,
 * whether two of them genuinely sit side by side, whether a name that will not
 * fit clips instead of running through the column beside it, and whether a
 * player with nobody next to him is spared the second line he does not need.
 *
 * The demo league is permanently mid-draft, which is what makes this list
 * render at all — see `live` on the roster response.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';

/** A full-width row's floor, which is the number this pass has to beat. */
const FULL_WIDTH_ROW = 38;

async function openTeam(page: Page) {
  await page.goto('/');
  await page.getByTestId('tab-team').click();
  await expect(page.getByTestId('league-card').first()).toBeVisible();
}

/**
 * The position groups on screen, as {@link Locator}s over their cards.
 *
 * Grouping is by position and the demo roster is small, so which groups hold
 * one player and which hold several is the fixture's business rather than this
 * file's. Every test here asks for the shape it needs and skips if the
 * deployment does not currently have one.
 */
async function groups(page: Page): Promise<{ one: Locator[]; many: Locator[] }> {
  const cards = await page.locator('.roster-grid').all();
  const one: Locator[] = [];
  const many: Locator[] = [];
  for (const card of cards) {
    const count = await card.getByTestId('drafted-line').count();
    if (count === 1) one.push(card);
    else if (count > 1) many.push(card);
  }
  return { one, many };
}

test.describe('the drafted roster', () => {
  test.beforeEach(async ({ page }) => {
    await openTeam(page);
    await expect(page.getByTestId('drafted-line').first()).toBeVisible();
  });

  /**
   * Two players to a row, and the row is one row.
   *
   * Side by side is two claims, and a layout can pass one while failing the
   * other: two cells can share a top edge and overlap, or sit apart and be
   * stacked. So both are checked — the first two cells of a group start at the
   * same height, and the left one ends before the right one begins.
   */
  test('puts two players on a row', async ({ page }) => {
    const { many } = await groups(page);
    test.skip(many.length === 0, 'no position group on this roster holds two players');

    const cells = await many[0]!.getByTestId('drafted-line').all();
    const [first, second] = await Promise.all([cells[0]!.boundingBox(), cells[1]!.boundingBox()]);

    expect(Math.abs(first!.y - second!.y), 'two players share a row').toBeLessThan(2);
    expect(first!.x + first!.width, 'and do not overlap').toBeLessThanOrEqual(second!.x + 1);
  });

  /**
   * The saving, in pixels.
   *
   * This is the whole reason for the change, and it is the one claim that a
   * later well-meant edit — a larger club mark, roomier padding — can quietly
   * undo while every other assertion here still passes. A player costs less
   * than the full-width row he used to have, measured over the card so the
   * separators and the padding are counted rather than argued about.
   */
  test('costs less per player than the row it replaced', async ({ page }) => {
    const { many } = await groups(page);
    test.skip(many.length === 0, 'no position group on this roster holds two players');

    const card = many[0]!;
    const height = (await card.boundingBox())!.height;
    const players = await card.getByTestId('drafted-line').count();

    expect(height / players, `${players} players in ${Math.round(height)}px`).toBeLessThan(FULL_WIDTH_ROW);
  });

  /**
   * A name too long for half a phone clips; it does not escape.
   *
   * Half-width columns mean some names will not fit, which is the accepted
   * trade. What is not acceptable is a name drawn straight through the rule
   * into the cell beside it — the failure mode of every attempt at this layout
   * that sizes the name to its own text instead of to its column. Checked as
   * geometry, because that is what the reader sees: no name's painted box
   * reaches past its own cell.
   */
  test('keeps every name inside its own cell', async ({ page }) => {
    for (const cell of await page.getByTestId('drafted-line').all()) {
      const [box, name, text] = await Promise.all([
        cell.boundingBox(),
        cell.locator('.player-name').boundingBox(),
        cell.locator('.player-name').innerText(),
      ]);
      expect(name!.x + name!.width, `"${text}" runs past its cell`).toBeLessThanOrEqual(box!.x + box!.width + 1);
    }
  });

  /**
   * A player with nobody beside him keeps his one line.
   *
   * The second line is what a narrow column costs, and an only child has no
   * narrow column — the track beside him collapses and he has the card's full
   * width. Spending a second line there would be the pass paying for itself on
   * the big groups and handing it back on the small ones, so he goes back to
   * the single flex row every other one-value row on this screen uses: the club
   * and the pick on the same line as the name, over on the trailing edge.
   */
  test('leaves a lone player on a single line', async ({ page }) => {
    const { one } = await groups(page);
    test.skip(one.length === 0, 'every position group on this roster holds two or more players');

    const cell = one[0]!.getByTestId('drafted-line');
    const [name, value] = await Promise.all([
      cell.locator('.player-name').boundingBox(),
      cell.locator('.row-value').boundingBox(),
    ]);

    expect(Math.abs(name!.y - value!.y), 'the club sits on the name’s line').toBeLessThan(6);
    // And on the far side of it, which is the layout it shares with its neighbours.
    expect(value!.x).toBeGreaterThan(name!.x + name!.width);
  });
});
