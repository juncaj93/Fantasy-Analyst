/**
 * Team, while a draft is running.
 *
 * A deliberately different screen from the regular-season one, and the
 * difference is the product decision rather than an inconsistency: mid draft
 * this list is *scanned* between picks, so it is denser than a screen read one
 * slot at a time. What it holds is what has been drafted and what to do next;
 * everything about a week waits for the week.
 *
 * The layout it replaced put two players on a row. That bought vertical space
 * and cost too much for it — half a phone is not enough for a name, so most
 * cells truncated, and a cell needing two lines for three short things read as
 * a grid of boxes rather than a roster. The claims here are the ones that
 * decision rests on, measured rather than asserted by class name, so that
 * reintroducing a grid fails them.
 *
 * The demo league is permanently mid-draft, which is what makes this view
 * render at all — see `live` on the roster response.
 */

import { expect, test, type Page } from '@playwright/test';
import { inSeason } from './helpers.ts';

/** What a full-width row costs on the regular-season screen. */
const FULL_ROW = 38;

async function openTeam(page: Page) {
  await page.goto('/');
  await page.getByTestId('tab-team').click();
  await expect(page.getByTestId('league-card').first()).toBeVisible();
}

test.describe('the drafted roster', () => {
  test.beforeEach(async ({ page }) => {
    await openTeam(page);
    await expect(page.getByTestId('drafted-line').first()).toBeVisible();
  });

  /**
   * One column, and one line to the player.
   *
   * Both halves matter and they fail differently. Two columns would put two
   * rows at the same height with different left edges; a two-line cell would
   * put the club's mark below the name instead of beside it. So the test asks
   * for a shared left edge *and* for the trailing cluster to sit on the name's
   * own line.
   */
  test('puts one player on a line, in one column', async ({ page }) => {
    const rows = await page.getByTestId('drafted-line').all();
    expect(rows.length, 'the demo roster has players on it').toBeGreaterThan(1);

    const boxes = await Promise.all(rows.map((row) => row.boundingBox()));
    const lefts = new Set(boxes.map((box) => Math.round(box!.x)));
    expect(lefts.size, 'every row starts on the same edge — one column, not two').toBe(1);

    for (const [i, box] of boxes.entries()) {
      if (i === 0) continue;
      expect(box!.y, 'no two players share a row').toBeGreaterThan(boxes[i - 1]!.y + 1);
    }

    // The pick on the name's line, not under it.
    const first = rows[0]!;
    const [name, value] = await Promise.all([
      first.locator('.player-name').boundingBox(),
      first.locator('.row-value').boundingBox(),
    ]);
    expect(Math.abs(name!.y - value!.y), 'the pick sits on the name’s line').toBeLessThan(8);
    expect(value!.x, 'and on the trailing edge').toBeGreaterThan(name!.x + name!.width);
  });

  /**
   * The club leads the line and the pick ends it, each on its own column.
   *
   * The mark used to sit on the trailing edge paired with the pick, which put
   * the two facts that identify a player — his club and his name — at opposite
   * ends of a row that holds almost nothing else, and let the width of the mark
   * push the pick sideways line by line. Both are columns now, and both are
   * asserted here because either one drifting is invisible on a single row and
   * obvious down twenty-two of them.
   */
  test('lines the clubs up on the left and the picks up on the right', async ({ page }) => {
    const columns = await page.getByTestId('drafted-line').evaluateAll((rows) => {
      const box = (row: Element, sel: string) => row.querySelector(sel)?.getBoundingClientRect() ?? null;
      return rows.map((row) => {
        const mark = box(row, '.team-logo, [data-testid="team-code"]');
        const name = box(row, '.player-name');
        const pick = box(row, '[data-testid="roster-row-label"]');
        return {
          markLeft: mark ? Math.round(mark.left) : null,
          markEnd: mark ? mark.right : null,
          nameLeft: name ? name.left : null,
          pickRight: pick ? Math.round(pick.right) : null,
        };
      });
    });

    expect(columns.length).toBeGreaterThan(1);
    expect(new Set(columns.map((c) => c.markLeft)).size, 'every club starts on one x').toBe(1);
    expect(new Set(columns.map((c) => c.pickRight)).size, 'every pick ends on one x').toBe(1);
    for (const c of columns) {
      expect(c.markEnd!, 'the club ends before the name begins').toBeLessThanOrEqual(c.nameLeft! + 1);
    }
  });

  /**
   * Denser than the row it replaced, which is the whole point of the view.
   *
   * Measured over the card so padding and separators are counted rather than
   * argued about. A later edit that restores comfortable spacing here — the
   * regular-season screen's spacing — passes every other test in this file and
   * fails this one.
   */
  test('is denser than a regular-season row', async ({ page }) => {
    const card = page.locator('.roster-list').first();
    const height = (await card.boundingBox())!.height;
    const players = await card.getByTestId('drafted-line').count();
    expect(height / players, `${players} players in ${Math.round(height)}px`).toBeLessThan(FULL_ROW);
  });

  /** A name that does not fit clips inside its own row rather than escaping it. */
  test('keeps every name inside its row', async ({ page }) => {
    for (const row of await page.getByTestId('drafted-line').all()) {
      const [box, name, text] = await Promise.all([
        row.boundingBox(),
        row.locator('.player-name').boundingBox(),
        row.locator('.player-name').innerText(),
      ]);
      expect(name!.x + name!.width, `"${text}" runs past its row`).toBeLessThanOrEqual(box!.x + box!.width + 1);
    }
  });

  /**
   * The draft card says what to do, in one line, from the engine's own signal.
   *
   * The text is not pinned here — it is a conclusion about a live roster and
   * `tests/draft.bestMove.test.ts` owns which conclusion. What this holds is
   * that the line exists, that it is one line rather than a paragraph, and that
   * it names something rather than being a platitude.
   */
  test('carries one concise next move', async ({ page }) => {
    const move = page.getByTestId('best-move');
    await expect(move).toBeVisible();
    await expect(move).toContainText('Best move:');

    const text = await move.innerText();
    expect(text.length, `the advice runs to ${text.length} characters`).toBeLessThan(120);

    const card = page.getByTestId('live-draft-card');
    expect((await card.boundingBox())!.height, 'the draft card stays compact').toBeLessThan(140);
  });

  /**
   * …and carries nothing else.
   *
   * The card opened with a `Live draft` dot, a count of picks made, slots
   * filled and slots left, and a sentence naming the open starting slots or
   * saying there were none. All true, none of it worth the height: a reader on
   * this screen is mid-draft and knows it, the roster underneath is the count
   * group heading by group heading, and the open slots are the *input* to the
   * advice rather than a second reading of it.
   *
   * The counts themselves are untouched on the roster response and still feed
   * the recommendation — this asserts they are not printed, not that they are
   * gone. `computeNeed` still receives every one of them.
   */
  test('and no live-status or slot-coverage prose above it', async ({ page }) => {
    const card = page.getByTestId('live-draft-card');
    const text = (await card.innerText()).replace(/\s+/g, ' ');

    expect(text, 'the card is the advice and nothing else').toMatch(/^★? ?Best move:/);
    for (const gone of ['Live draft', 'filled', 'left', 'Still need', 'Every starting slot is covered']) {
      expect(text, `"${gone}" is still on the card`).not.toContain(gone);
    }
    await expect(card.locator('.live-dot')).toHaveCount(0);

    // The numbers behind it are still being sent, and still feed the sentence.
    const roster = await (await page.request.get('/api/leagues/demo-league/roster')).json();
    expect(typeof roster.filled, 'the roster still reports how many slots are filled').toBe('number');
    expect(Array.isArray(roster.openStarters), 'and which starters are open').toBe(true);
    expect(roster.bestMove?.text, 'which is what the sentence is derived from').toBeTruthy();
  });

  /**
   * Nothing about a week, during a draft.
   *
   * These are not hidden because they are ugly. `Recommended starters` over
   * eight `Nobody eligible yet` rows, a `Bench (0)`, changes to consider and
   * waiver upgrades are all answers to questions that do not exist while half
   * the roster is unpicked — and they were drawn under the roster for the whole
   * draft, between it and the bottom of the page.
   */
  test('draws no lineup, bench or waiver advice', async ({ page }) => {
    for (const id of ['starters-title', 'starters-group', 'bench-toggle', 'lineup-card', 'waiver-row']) {
      await expect(page.getByTestId(id), `${id} is drawn during a draft`).toHaveCount(0);
    }
    await expect(page.getByTestId('team-pull')).not.toContainText('Nobody eligible yet');
  });
});

/**
 * And none of it reaches the screen this is not about.
 *
 * The patch is explicitly scoped to the live-draft view. The regular-season
 * Team screen keeps its lineup, its bench and its spacing, so the same run that
 * proves the draft view is dense has to prove the other one was left alone.
 */
test.describe('the regular-season roster, once the draft is done', () => {
  test('keeps its lineup, its bench and its own spacing', async ({ page }) => {
    await inSeason(page);
    await openTeam(page);

    await expect(page.getByTestId('starters-title')).toBeVisible();
    await expect(page.getByTestId('bench-toggle')).toBeVisible();
    // None of the draft-mode furniture leaks into it.
    await expect(page.getByTestId('live-draft-card')).toHaveCount(0);
    await expect(page.getByTestId('best-move')).toHaveCount(0);
    await expect(page.getByTestId('drafted-line')).toHaveCount(0);
  });
});
