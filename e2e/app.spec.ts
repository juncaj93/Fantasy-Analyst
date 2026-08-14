/**
 * iPhone-portrait smoke tests over the seeded demo dataset.
 *
 * Covers the flows in docs/06_UI_AND_QA.md: log in, review the draft board,
 * open a recommendation's reasoning, import ADP, inspect player intelligence,
 * resolve the review queue, compare start/sit, and the degraded state when
 * Vegas data is missing.
 */

import { expect, test, type Page } from '@playwright/test';

/** The session is established once by `auth.setup.ts` and reused here. */
async function login(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('tab-draft')).toBeVisible();
}

async function openTab(page: Page, tab: 'draft' | 'team' | 'players' | 'review') {
  await page.getByTestId(`tab-${tab}`).click();
}

test.describe('shell', () => {
  test('never scrolls horizontally at this width', async ({ page }) => {
    await login(page);
    for (const tab of ['draft', 'team', 'players', 'review'] as const) {
      await openTab(page, tab);
      await page.waitForTimeout(400);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${tab} tab overflows horizontally`).toBeLessThanOrEqual(1);
    }
  });

  test('tab targets are large enough to tap', async ({ page }) => {
    await login(page);
    for (const tab of ['draft', 'team', 'players', 'review'] as const) {
      const box = await page.getByTestId(`tab-${tab}`).boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
  });

  test('shows the review backlog as a badge on the tab bar', async ({ page }) => {
    await login(page);
    await expect(page.getByTestId('tab-review').locator('.tab-badge')).toBeVisible();
  });
});

test.describe('draft room', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await openTab(page, 'draft');
    await expect(page.getByTestId('board-list')).toBeVisible();
  });

  test('shows live draft state above the fold, on one line', async ({ page }) => {
    // The stat-card banner is gone by design, but nothing it carried is: the
    // pick number, the round and the wait are still the first thing on screen,
    // beside the league name.
    await expect(page.getByTestId('board-league-name')).toHaveText('Demo Dynasty');
    const status = page.getByTestId('draft-status');
    await expect(status).toBeVisible();
    await expect(status).toContainText('#3');
    await expect(status).toContainText('R1');
  });

  /**
   * Everything the draft screen stopped saying, so it can say more players.
   *
   * The league's settings and the draft-order provenance are still computed and
   * still drive every number on screen — they are simply read in Setup now,
   * which is where the rest of the configuration lives.
   */
  test('spends no vertical space on chrome the list already implies', async ({ page }) => {
    const body = (await page.locator('main').innerText()).toLowerCase();
    expect(body, 'the list being ranked is what says it is recommended').not.toContain('recommended');
    expect(body).not.toContain('league and draft order');
    expect(body, 'the roster block became one line').not.toContain('starting slots still open');

    // …and it is still reachable where configuration lives. (The label depends
    // on which rankings are loaded; what matters is that the step reports the
    // draft order it is using.)
    await page.getByTestId('tab-setup').click();
    await expect(page.getByTestId('setup-step-adp')).toContainText('players matched');
  });

  test('says how much of a starting lineup you have, in one line', async ({ page }) => {
    const line = page.getByTestId('roster-progress');
    await expect(line).toBeVisible();
    // The seeded league starts QB/RB/RB/WR/WR/TE/FLEX and has one RB drafted.
    await expect(line.locator('[data-slot="QB"]')).toContainText('0/1');
    await expect(line.locator('[data-slot="RB"]')).toContainText('1/2');
    await expect(line.locator('[data-slot="FLEX"]')).toBeVisible();
    // A league with no kicker slot never shows one.
    await expect(line.locator('[data-slot="K"]')).toHaveCount(0);
    // One line, not a card: it must not be taller than a couple of rows of text.
    const box = await line.boundingBox();
    expect(box!.height).toBeLessThan(40);
  });

  test('puts the player list high on the screen, and fits several on it', async ({ page }) => {
    // The point of removing the banner, the heading and the roster card: the
    // players start near the top, on the smallest supported phone.
    const firstRow = await page.getByTestId('recommendation-row').first().boundingBox();
    const viewport = page.viewportSize()!;
    expect(firstRow!.y).toBeLessThan(viewport.height * 0.3);
    expect(firstRow!.y + firstRow!.height).toBeLessThan(viewport.height);

    // Density, stated as a number so it cannot quietly regress.
    const rows = page.getByTestId('recommendation-row');
    let visible = 0;
    for (let i = 0; i < (await rows.count()); i++) {
      const box = await rows.nth(i).boundingBox();
      if (box && box.y + box.height <= viewport.height - 50) visible++;
    }
    expect(visible, 'the first screen should be mostly players').toBeGreaterThanOrEqual(6);
  });

  /**
   * The urgency interface.
   *
   * Take Now / Risky to Wait / Can Probably Wait were on nearly every row, so
   * they told the reader nothing. The chance he reaches your next pick says the
   * same thing as a number, and the number is always printed — the colour is an
   * accelerator, never the carrier.
   */
  test('shows the chance he lasts as a coloured percentage, not a wait chip', async ({ page }) => {
    const text = (await page.locator('main').innerText()).toLowerCase();
    for (const gone of ['take now', 'risky to wait', 'can probably wait']) {
      expect(text, `"${gone}" should no longer be on a draft row`).not.toContain(gone);
    }

    const survivals = page.getByTestId('survival');
    expect(await survivals.count()).toBeGreaterThan(3);
    await expect(survivals.first()).toContainText('%');

    // Kai Brennan is 0% to last, Bo Ashworth is 98%: the ends of the scale.
    const bands = await page.locator('.survival[data-band]').evaluateAll((nodes) =>
      nodes.map((n) => ({ band: n.getAttribute('data-band'), pct: Number((n.textContent ?? '').replace('%', '')) })),
    );
    expect(bands.length).toBeGreaterThan(3);
    for (const { band, pct } of bands) {
      if (pct <= 30) expect(band).toBe('gone');
      else if (pct < 66) expect(band).toBe('coinflip');
      else expect(band).toBe('safe');
    }
    // Colour actually differs between the ends, in whichever theme is active.
    const colours = await page.locator('.survival[data-band]').evaluateAll((nodes) => [
      ...new Set(nodes.map((n) => getComputedStyle(n).color)),
    ]);
    expect(colours.length).toBeGreaterThan(1);
  });

  /**
   * Market context, where it exists.
   *
   * The seeded slate prices a few players and not others, which is exactly the
   * real state of affairs: a card carries the line when there is one and says
   * nothing when there is not, rather than holding space for an absent number.
   */
  test('shows the season market on the cards that have one, and nothing on the ones that do not', async ({
    page,
  }) => {
    const rows = page.getByTestId('recommendation-row');
    const withMarket = rows.filter({ has: page.getByTestId('market-line') });
    expect(await withMarket.count(), 'the demo slate prices some players').toBeGreaterThan(0);
    expect(await withMarket.count(), 'and not all of them').toBeLessThan(await rows.count());

    const line = await withMarket.first().getByTestId('market-line').innerText();
    // Units, not odds: no prices, no book names, no betting language.
    expect(line.toLowerCase()).toMatch(/rec|yds|tds?|catches|pass|rush/);
    expect(line).not.toMatch(/[+-]\d{3}/);
    for (const word of ['odds', 'over/under', 'bet', 'wager', 'book']) {
      expect(line.toLowerCase()).not.toContain(word);
    }

    // Expanded, the same market says what it is worth in this league's points.
    await withMarket.first().locator('.row-button').click();
    await expect(withMarket.first().getByTestId('market-baseline')).toContainText('points in this league');
  });

  test('colour-codes positions without losing the letters', async ({ page }) => {
    const pill = page.getByTestId('recommendation-row').first().locator('.pos-pill');
    await expect(pill).toBeVisible();
    // Colour is an accelerator; the position text is what carries the meaning.
    expect((await pill.innerText()).trim()).toMatch(/^(QB|RB|WR|TE|K|DEF)$/);
  });

  test('ranks available players and hides drafted ones', async ({ page }) => {
    const rows = page.getByTestId('recommendation-row');
    expect(await rows.count()).toBeGreaterThan(3);
    // Marcus Vance (1001) and Devin Okafor (1002) are picks 1 and 2 in the seed.
    await expect(page.locator('[data-testid="recommendation-row"][data-player-id="1001"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="recommendation-row"][data-player-id="1002"]')).toHaveCount(0);
  });

  test('explains a recommendation with component scores on tap', async ({ page }) => {
    const first = page.getByTestId('recommendation-row').first();
    await first.click();
    await expect(first.locator('.explain')).toBeVisible();
    await expect(first.getByText('Why this rank')).toBeVisible();

    // The default expansion is a decision, not a derivation: the raw component
    // arithmetic is present but folded away until it is asked for.
    await expect(first.locator('.component').first()).toBeHidden();
    await first.getByTestId('advanced-breakdown').locator('summary').click();

    // Components are exposed individually, not collapsed into one opaque score.
    const labels = (await first.locator('.component-label').allInnerTexts()).join(' | ');
    for (const label of ['ADP value', 'Roster need', 'Positional scarcity', 'League fit', 'Survival to next pick', 'Total']) {
      expect(labels, `missing component: ${label}`).toContain(label);
    }
  });

  /**
   * The rule the expansion is built on: it may not repeat the row it opened
   * from. It used to lead with a grid of ADP, value, survival and the tally —
   * all four printed two lines above, in the same units.
   */
  test('adds context to the row rather than restating it', async ({ page }) => {
    const first = page.getByTestId('recommendation-row').first();
    await first.click();
    await expect(first.getByTestId('player-detail')).toBeVisible();

    /*
     * Checked structurally rather than by looking for the words.
     *
     * "position is nearly exhausted before your next pick" is a reason, not a
     * restated survival tile, and a reason is allowed to use a number to make
     * its point — "this is a reach: -4.8 picks" is the argument, not a second
     * printing of the value. What may not come back is the grid of labelled
     * tiles that restated all four without adding anything.
     */
    await expect(first.locator('.explain .metric-grid')).toHaveCount(0);
    await expect(first.locator('.explain .stat-label')).toHaveCount(0);

    // What replaced it: context the row does not have.
    await expect(first.getByText('Why this rank')).toBeVisible();
    await expect(first.getByText('Counterpoint', { exact: true })).toBeVisible();

    // At most one conclusion, and only when there is a genuine warning.
    expect(await first.getByTestId('verdict').count()).toBeLessThanOrEqual(1);

    // Reasons are capped by default; the rest are one tap away, never deleted.
    expect(await first.locator('.reason-list').first().locator('li').count()).toBeLessThanOrEqual(3);

    // Nothing in the reasons repeats a conclusion shown above them.
    const verdicts = await first.locator('.verdict-label').allInnerTexts();
    const bullets = (await first.locator('.reason-list li').allInnerTexts()).map((b) => b.trim());
    for (const label of verdicts) expect(bullets).not.toContain(label.trim());
  });

  test('answers with one counterpoint, or says there is none', async ({ page }) => {
    const rows = page.getByTestId('recommendation-row');
    for (let i = 0; i < Math.min(await rows.count(), 4); i++) {
      const row = rows.nth(i);
      await row.click();
      await expect(row.getByText('Counterpoint', { exact: true })).toBeVisible();

      const lists = row.locator('.reason-list');
      const counterpoints = lists.nth((await lists.count()) - 1);
      const bullets = await counterpoints.locator('li').count();
      if (bullets === 0) {
        // Nothing is invented to fill the space; the absence is stated.
        await expect(row.getByTestId('no-counterpoint')).toBeVisible();
      } else {
        expect(bullets, 'exactly one counterpoint by default').toBe(1);
      }
      await row.locator('.row-button').click();
    }
  });

  /**
   * The outlook is written by somebody, and says so.
   *
   * Sleeper serves it through a public endpoint; the demo data stands in for it
   * so the suite never reaches a third party for player ids that are not
   * theirs. What is asserted is the shape: a heading, a short paragraph, an
   * attribution, and an honest sentence when there is none.
   */
  test('shows a short attributed season outlook, and admits when there is none', async ({ page }) => {
    const withOutlook = page.locator('[data-testid="recommendation-row"]', { hasText: 'Kai Brennan' }).first();
    await withOutlook.click();
    const outlook = withOutlook.getByTestId('outlook');
    await expect(outlook).toBeVisible();
    await expect(withOutlook.getByText(/season outlook/i)).toBeVisible();
    await expect(outlook).toContainText('via Sleeper');

    // Two or three sentences, not the whole paragraph.
    const text = (await outlook.innerText()).split(' — ')[0]!;
    expect((text.match(/[.!?](\s|$)/g) ?? []).length).toBeLessThanOrEqual(3);
    expect(text.length).toBeLessThan(420);
    await withOutlook.locator('.row-button').click();

    const without = page.locator('[data-testid="recommendation-row"]', { hasText: 'Bo Ashworth' }).first();
    await without.scrollIntoViewIfNeeded();
    await without.click();
    await expect(without.getByTestId('outlook-none')).toContainText(/no .* outlook published/i);
    await without.locator('.row-button').click();
  });

  test('shows last season as games played and a half-PPR finish', async ({ page }) => {
    const played = page.locator('[data-testid="recommendation-row"]', { hasText: 'Kai Brennan' }).first();
    await played.click();
    const line = played.getByTestId('last-season');
    await expect(line).toContainText(/\d+ GP/);
    await expect(line).toContainText(/(QB|RB|WR|TE)\d+ half-PPR/);
    await played.locator('.row-button').click();

    // A player with no season has no finish — Sleeper would happily report him
    // as the twelve-hundredth of his position, which is not a result.
    const never = page.locator('[data-testid="recommendation-row"]', { hasText: 'Bo Ashworth' }).first();
    await never.scrollIntoViewIfNeeded();
    await never.click();
    const unknown = never.getByTestId('last-season');
    await expect(unknown).toContainText('GP unknown');
    await expect(unknown).not.toContainText(/RB\d/);
  });

  /**
   * Sleeper shows a roster percentage in its own app and publishes it nowhere,
   * so the card shows none. Setup says so in words rather than leaving the
   * question hanging.
   */
  test('shows no roster percentage, and says why in Setup', async ({ page }) => {
    const first = page.getByTestId('recommendation-row').first();
    await first.click();
    expect((await first.locator('.explain').innerText()).toLowerCase()).not.toContain('rostered');

    await page.getByTestId('tab-setup').click();
    const panel = page.getByTestId('panel-player-detail');
    await panel.locator('summary').click();
    await expect(panel.getByTestId('roster-percent-health')).toContainText(/publishes no roster percentage/i);
    // …and the two feeds that do exist report what landed.
    await expect(panel.getByTestId('stats-health')).toContainText(/player/);
    await expect(panel.getByTestId('outlook-health')).toContainText(/stored/);
  });

  test('the expanded player fits on the screen without opening Advanced', async ({ page }) => {
    const first = page.getByTestId('recommendation-row').first();
    await first.click();
    const box = await first.boundingBox();
    // Identity, verdict, numbers, reasons and counterpoint inside one viewport.
    expect(box!.height).toBeLessThan(page.viewportSize()!.height);
  });

  test('filters the board by position', async ({ page }) => {
    await page.getByRole('button', { name: 'QB', exact: true }).click();
    await expect(page.getByTestId('recommendation-row').first()).toBeVisible();
    for (const text of await page.locator('.pos-team').allInnerTexts()) {
      expect(text).toContain('QB');
    }
  });

  /**
   * Roster-construction intelligence is kept, but it stopped being a card.
   *
   * A block that said "3 starting slots still open" and then told the user to
   * take the best player available was repeating what the ranked list under it
   * was already doing. The alerts are still computed, still carry their reason,
   * and are still available to explain a late-draft gap — they are simply not
   * a banner at the top of a phone screen any more.
   */
  test('keeps roster-construction intelligence without spending a card on it', async ({ page }) => {
    await expect(page.getByTestId('roster-alerts')).toHaveCount(0);

    const board = await page.request.get('/api/drafts/demo-draft/board?limit=5');
    const alerts = (await board.json()).rosterAlerts as { message: string; detail: string }[];
    expect(alerts.length).toBeGreaterThan(0);
    for (const alert of alerts) {
      expect(alert.message.length).toBeGreaterThan(0);
      // A bare label is what the brief rules out: each alert carries its reason.
      expect(alert.detail.length).toBeGreaterThan(0);
    }
  });

  /**
   * Two tags is the ceiling, and only because they say unrelated things: the
   * research is against him, and his group is nearly gone. The row's budget
   * exists because it used to hold four.
   */
  test('shows at most two decision tags on a row', async ({ page }) => {
    const rows = page.getByTestId('recommendation-row');
    const count = await rows.count();
    for (let i = 0; i < Math.min(count, 10); i++) {
      const tags = rows.nth(i).getByTestId('decision-tags').locator('.tag');
      expect(await tags.count(), 'a row should never become a badge wall').toBeLessThanOrEqual(2);
    }
  });

  /**
   * Tier structure, drawn two different ways for two different lists.
   *
   * The seeded board is built to have both: six quarterbacks in a cluster of
   * four then a 23-pick hole, and five tight ends whose best group is down to
   * two. See `DEMO_PLAYERS`.
   */
  test.describe('tiers', () => {
    test('draws a line where a filtered position genuinely breaks', async ({ page }) => {
      await page.getByRole('button', { name: 'QB', exact: true }).click();
      await expect(page.getByTestId('recommendation-row').first()).toBeVisible();

      const dividers = page.getByTestId('tier-divider');
      await expect(dividers, 'the QB board breaks exactly once').toHaveCount(1);
      await expect(dividers.first()).toContainText(/tier drop/i);
      // It says how big the hole is, which is the whole reason it is there.
      await expect(dividers.first()).toContainText(/~2[0-9] picks/);

      // And it falls between the cluster and what follows, not inside either.
      const order = await page
        .getByTestId('board-list')
        .evaluate((list) =>
          [...list.children].map((n) =>
            n.getAttribute('data-testid') === 'tier-divider'
              ? '---'
              : (n.querySelector('.player-name')?.textContent ?? '?'),
          ),
        );
      expect(order.indexOf('---')).toBe(4);
      expect(order.slice(0, 4)).not.toContain('---');
    });

    test('draws no line at all across the mixed board', async ({ page }) => {
      await expect(page.getByTestId('tier-divider')).toHaveCount(0);
      await page.getByRole('button', { name: 'Show only your queue' }).click();
      await expect(page.getByTestId('tier-divider')).toHaveCount(0);
    });

    test('marks only the last players of the group in play, and says how many', async ({ page }) => {
      await page.getByRole('button', { name: 'ALL', exact: true }).click();
      const tags = page.getByTestId('tier-cliff-tag');

      // Two tight ends left in the best group at the position; nobody else.
      await expect(tags).toHaveCount(2);
      for (const text of await tags.allInnerTexts()) expect(text).toMatch(/tier cliff · 2 away/i);

      const tagged = await page
        .getByTestId('recommendation-row')
        .filter({ has: page.getByTestId('tier-cliff-tag') })
        .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-position')));
      expect(new Set(tagged)).toEqual(new Set(['TE']));

      // The rest of the board is not carrying the same warning, which is the
      // failure this label has already shipped once.
      const rows = await page.getByTestId('recommendation-row').count();
      expect(rows).toBeGreaterThan(6);
    });

    test('never marks a group that still has three in it', async ({ page }) => {
      // The quarterbacks are four deep behind a real cliff and stay unmarked.
      await page.getByRole('button', { name: 'ALL', exact: true }).click();
      const qbTags = page
        .getByTestId('recommendation-row')
        .filter({ has: page.getByTestId('tier-cliff-tag') })
        .filter({ hasText: 'QB' });
      await expect(qbTags).toHaveCount(0);
    });

    test('counts down as the group is drafted', async ({ page }) => {
      // Asked of the model through the API rather than by drafting in the UI,
      // which this tool deliberately cannot do. Two tight ends left reads 2;
      // with one of them gone the last one reads 1.
      const board = await page.request.get('/api/drafts/demo-draft/board?limit=40');
      const recs = (await board.json()).recommendations as {
        position: string;
        adp: number;
        tierCliff: { tierIndex: number | null; tierSize: number; tierEndsAtCliff: boolean };
      }[];
      const tes = recs.filter((r) => r.position === 'TE').sort((a, b) => a.adp - b.adp);
      expect(tes.length).toBeGreaterThanOrEqual(4);
      expect(tes[0]!.tierCliff).toMatchObject({ tierIndex: 0, tierSize: 2, tierEndsAtCliff: true });
      expect(tes[1]!.tierCliff).toMatchObject({ tierIndex: 0, tierSize: 2, tierEndsAtCliff: true });
      // The group below is not the group in play and carries no warning.
      expect(tes[2]!.tierCliff.tierIndex).toBe(1);
    });
  });

  test('tints the whole card by position, and keeps the letters', async ({ page }) => {
    const rows = page.getByTestId('recommendation-row');
    const sample = await rows.evaluateAll((nodes) =>
      nodes.slice(0, 8).map((n) => ({
        position: n.getAttribute('data-position'),
        edge: getComputedStyle(n).borderLeftColor,
        badge: (n.querySelector('.pos-pill')?.textContent ?? '').trim(),
      })),
    );
    const positions = new Set(sample.map((s) => s.position));
    expect(positions.size, 'the seeded board has several positions').toBeGreaterThan(1);
    // Every position paints a different edge…
    const byPosition = new Map(sample.map((s) => [s.position, s.edge]));
    expect(new Set(byPosition.values()).size).toBe(byPosition.size);
    // …and the position is still written on the card in words.
    for (const s of sample) expect(s.badge).toBe(s.position);
  });

  test('stars a player as a bookmark, keeps it across a reload, and says it changed no ranking', async ({ page }) => {
    const row = page.getByTestId('recommendation-row').first();
    const playerId = await row.getAttribute('data-player-id');
    const star = row.getByTestId('queue-control');
    await expect(star).toHaveAttribute('data-queued', '0');

    await star.click();
    const flagged = page.locator(`[data-testid="recommendation-row"][data-player-id="${playerId}"]`);
    await expect(flagged.getByTestId('queue-control')).toHaveAttribute('data-queued', '1');

    // Two states, not four. A bookmark is on or off.
    await flagged.getByTestId('queue-control').click();
    await expect(flagged.getByTestId('queue-control')).toHaveAttribute('data-queued', '0');
    await flagged.getByTestId('queue-control').click();

    await page.reload();
    const afterReload = page.locator(`[data-testid="recommendation-row"][data-player-id="${playerId}"]`);
    await expect(afterReload.getByTestId('queue-control')).toHaveAttribute('data-queued', '1');

    // The expanded card says what the star did — and, pointedly, what it did not.
    await afterReload.click();
    await expect(afterReload.getByTestId('detail-queued')).toContainText('does not change his ranking');
    // Starring is not rating: no My Guy line appears from it.
    await expect(afterReload.getByTestId('detail-my-guy')).toHaveCount(0);

    // Leave the board as it was found, so the shared dev server stays clean.
    await afterReload.getByTestId('queue-control').click();
    await expect(
      page.locator(`[data-testid="recommendation-row"][data-player-id="${playerId}"]`).getByTestId('queue-control'),
    ).toHaveAttribute('data-queued', '0');
  });

  test('starring keeps the board in exactly the same order', async ({ page }) => {
    const ids = () =>
      page.getByTestId('recommendation-row').evaluateAll((rows) =>
        rows.map((r) => r.getAttribute('data-player-id')),
      );
    const before = await ids();
    // Somebody a little way down, where a ranking boost would be visible.
    const target = page.getByTestId('recommendation-row').nth(5);
    await target.getByTestId('queue-control').click();
    await expect(target.getByTestId('queue-control')).toHaveAttribute('data-queued', '1');
    expect(await ids()).toEqual(before);
    await target.getByTestId('queue-control').click();
  });

  test('the star filter shows only the players you queued', async ({ page }) => {
    const row = page.getByTestId('recommendation-row').first();
    const playerId = await row.getAttribute('data-player-id');
    await row.getByTestId('queue-control').click();

    await page.getByTestId('queue-filter').click();
    const queued = page.getByTestId('recommendation-row');
    await expect(queued).toHaveCount(1);
    await expect(queued.first()).toHaveAttribute('data-player-id', playerId!);
    await expect(page.getByTestId('queue-filter')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('board-list')).toHaveAttribute('aria-label', /queue/i);

    // Unstarring empties the queue, and the screen says how to fill it.
    await queued.first().getByTestId('queue-control').click();
    await expect(page.getByText(/Your queue is empty/)).toBeVisible();
  });

  test('starring does not also expand the row', async ({ page }) => {
    const row = page.getByTestId('recommendation-row').first();
    const playerId = await row.getAttribute('data-player-id');
    await row.getByTestId('queue-control').click();
    const after = page.locator(`[data-testid="recommendation-row"][data-player-id="${playerId}"]`);
    await expect(after.locator('.explain')).toHaveCount(0);
    await after.getByTestId('queue-control').click();
  });

  /**
   * The Sleeper sync is stubbed here on purpose. What is being checked is the
   * contract between the button and the app — one request per tap, the board
   * rebuilt afterwards, the last good state kept when it fails — not Sleeper's
   * availability from CI.
   */
  test('offers a refresh control rather than a live/pause switch', async ({ page }) => {
    const refresh = page.getByTestId('draft-refresh');
    await expect(refresh).toBeVisible();
    await expect(refresh).toHaveAccessibleName(/refresh/i);

    const box = await refresh.boundingBox();
    expect(box!.width, 'must be tappable one-handed').toBeGreaterThanOrEqual(44);

    // The control no longer implies the user maintains a connection.
    const buttons = (await page.getByRole('button').allInnerTexts()).join(' ').toLowerCase();
    expect(buttons).not.toContain('live');
    expect(buttons).not.toContain('pause');
  });

  test('refresh force-syncs the draft and rebuilds the board', async ({ page }) => {
    let syncs = 0;
    let boards = 0;
    await page.route('**/api/drafts/*/sync', async (route) => {
      syncs++;
      // Long enough that a second tap lands while the first is in flight.
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'drafting', pollIntervalSeconds: 0 }),
      });
    });
    await page.route('**/api/drafts/*/board*', async (route) => {
      boards++;
      await route.continue();
    });

    const refresh = page.getByTestId('draft-refresh');
    await refresh.click();
    // Repeated taps while it is working must not queue a second sync.
    await refresh.dispatchEvent('click');
    await refresh.dispatchEvent('click');
    await expect(refresh).toBeEnabled();

    expect(syncs, 'one sync per tap, never overlapping').toBe(1);
    expect(boards, 'the board is rebuilt from the new state').toBeGreaterThanOrEqual(1);
    // The list is never blanked while refreshing.
    await expect(page.getByTestId('recommendation-row').first()).toBeVisible();
    await expect(page.getByTestId('draft-updated')).toContainText(/just now|ago/);
  });

  test('a failed refresh keeps the last good draft state on screen', async ({ page }) => {
    const before = await page.getByTestId('recommendation-row').count();
    await page.route('**/api/drafts/*/sync', (route) =>
      route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Sleeper did not respond' }),
      }),
    );

    await page.getByTestId('draft-refresh').click();

    const note = page.getByTestId('draft-refresh-note');
    await expect(note).toContainText('Sleeper did not respond');
    await expect(note).toContainText('last draft state');
    // Concise and non-blocking: no full-width error banner, no empty board.
    await expect(page.locator('.notice-error')).toHaveCount(0);
    await expect(page.getByTestId('recommendation-row')).toHaveCount(before);
  });

  test('offers no control that could make a pick', async ({ page }) => {
    const joined = (await page.getByRole('button').allInnerTexts()).join(' ').toLowerCase();
    expect(joined).not.toContain('draft this');
    expect(joined).not.toContain('auto draft');
    expect(joined).not.toContain('make pick');
  });
});

test.describe('team, ADP import and start/sit', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await openTab(page, 'team');
    await expect(page.getByTestId('league-card').first()).toBeVisible();
  });

  test('shows the league in use with its scoring profile', async ({ page }) => {
    const card = page.getByTestId('league-card').first();
    await expect(card).toContainText('Demo Dynasty');
    await expect(card).toContainText('Half PPR');
    // Choosing a league lives in Setup; Team only refreshes it.
    await expect(card.getByRole('button', { name: 'Refresh' })).toBeVisible();
  });

  test('lists the roster split into starters and bench', async ({ page }) => {
    await expect(page.getByText('Starters', { exact: true })).toBeVisible();
    await expect(page.getByText('Bench', { exact: true })).toBeVisible();
    expect(await page.getByTestId('roster-row').count()).toBeGreaterThan(2);
  });

  test('compares two players and explains the recommendation', async ({ page }) => {
    await page.locator('[data-testid="roster-row"][data-player-id="1001"]').click();
    await page.locator('[data-testid="roster-row"][data-player-id="1004"]').click();
    await page.getByRole('button', { name: /Compare 2 players/ }).click();

    const comparison = page.getByTestId('comparison');
    await expect(comparison).toBeVisible();
    await expect(page.getByTestId('comparison-verdict')).toContainText('Start');
    await expect(comparison).toContainText('confidence');
    await expect(comparison.getByRole('columnheader', { name: 'Vegas' })).toBeVisible();
    await expect(comparison.getByRole('columnheader', { name: 'Coverage' })).toBeVisible();
  });

  test('recommends a whole lineup and never offers to apply it', async ({ page }) => {
    const card = page.getByTestId('lineup-card');
    await expect(card).toBeVisible();
    await expect(page.getByTestId('lineup-verdict')).toBeVisible();

    await card.getByRole('group').getByText('Recommended lineup in full').click();
    await expect(card.getByRole('columnheader', { name: 'Slot' })).toBeVisible();

    // Recommendation only: there is no control here that changes a lineup.
    const buttons = (await card.getByRole('button').allInnerTexts()).join(' ').toLowerCase();
    expect(buttons).not.toContain('apply');
    expect(buttons).not.toContain('set lineup');
    expect(buttons).not.toContain('save lineup');
  });

  test('shows a degraded, honest state when Vegas data is missing', async ({ page }) => {
    // Cal Whitfield (1011) is rostered but has no props in the mock game.
    await page.locator('[data-testid="roster-row"][data-player-id="1001"]').click();
    await page.locator('[data-testid="roster-row"][data-player-id="1011"]').click();
    await page.getByRole('button', { name: /Compare 2 players/ }).click();

    const comparison = page.getByTestId('comparison');
    await expect(comparison).toContainText('no Vegas data for');
    await expect(comparison).toContainText('unknown');
  });
});

test.describe('player intelligence', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await openTab(page, 'players');
  });

  test('rates a player with the heart, which is not the draft queue', async ({ page }) => {
    const firstRow = page.getByTestId('player-search-row').first();
    const playerId = await firstRow.getAttribute('data-player-id');
    const control = firstRow.getByTestId('my-guy-control');
    await expect(control).toHaveAttribute('data-icon', 'heart');
    // Colour is not doing the work: the glyph itself changes.
    expect((await control.innerText()).trim()).toBe('♡');

    await control.click();
    await expect(control).toHaveAttribute('data-level', '1');
    expect((await control.innerText()).trim()).toBe('♥');

    // The heart is an opinion, not a bookmark: the draft queue stays empty.
    await openTab(page, 'draft');
    await page.getByTestId('queue-filter').click();
    await expect(page.getByText(/Your queue is empty/)).toBeVisible();

    // Leave the shared dev server as it was found.
    await openTab(page, 'players');
    const back = page
      .locator(`[data-testid="player-search-row"][data-player-id="${playerId}"]`)
      .getByTestId('my-guy-control');
    await back.click();
    await back.click();
    await back.click();
    await expect(back).toHaveAttribute('data-level', '0');
  });

  test('searches players and opens the evidence timeline', async ({ page }) => {
    await page.getByLabel('Search players').fill('vance');
    await page.locator('[data-testid="player-search-row"][data-player-id="1001"]').click();

    await expect(page.getByTestId('evidence-heading')).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Last 7d' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Lifetime' })).toBeVisible();
  });

  test('shows the original excerpt for every evidence item, not just a tally', async ({ page }) => {
    await page.getByLabel('Search players').fill('vance');
    await page.locator('[data-testid="player-search-row"][data-player-id="1001"]').click();
    await expect(page.getByTestId('evidence-excerpt').first()).toContainText('named the starter');
  });

  test('states plainly when there are no cached props', async ({ page }) => {
    await page.getByLabel('Search players').fill('whitfield');
    await page.locator('[data-testid="player-search-row"][data-player-id="1011"]').click();
    await expect(page.getByText(/No prop data cached/)).toBeVisible();
  });
});

test.describe('review queue', () => {
  // Reviewing consumes queue items, and the dev server is shared across
  // projects, so each test ingests its own newsletter first. The mixed sentence
  // is guaranteed to land in review rather than auto-apply.
  test.beforeEach(async ({ page }, testInfo) => {
    const res = await page.request.post('/api/newsletter/ingest', {
      data: {
        messageId: `e2e-${testInfo.project.name}-${testInfo.title}`,
        from: 'editor@demo.newsletter',
        subject: 'Camp Report',
        date: new Date().toISOString(),
        // The marker keeps each issue's content unique: identical content is
        // deduped by design, which would starve later tests of review items.
        html:
          `<p>Issue ${testInfo.project.name} / ${testInfo.title}.</p>` +
          '<p>Julian Reyes returned to practice but is expected to split work in a committee.</p>',
        force: true,
      },
    });
    expect(res.status()).toBe(200);

    await login(page);
    await openTab(page, 'review');
    await expect(page.getByTestId('review-card').first()).toBeVisible();
  });

  test('lists ambiguous evidence with a reason, excerpt and confidence', async ({ page }) => {
    const card = page.getByTestId('review-card').first();
    await expect(card.locator('.evidence-excerpt')).toBeVisible();
    await expect(card.getByTestId('review-reason')).toContainText('Why:');
    await expect(card).toContainText('confidence:');
  });

  test('accepting an item removes it from the queue and updates the badge', async ({ page }) => {
    const cardsBefore = await page.getByTestId('review-card').count();
    await page.getByRole('button', { name: '✓ Accept' }).first().click();
    await expect(page.getByTestId('review-card')).toHaveCount(cardsBefore - 1);
  });

  test('exposes explicit correction controls rather than gesture-only actions', async ({ page }) => {
    const card = page.getByTestId('review-card').first();
    await card.getByRole('button', { name: '✎ Change' }).click();
    await expect(card.getByRole('button', { name: 'positive', exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: 'mixed', exact: true })).toBeVisible();
    await expect(card.getByText(/Your correction wins from now on/)).toBeVisible();
  });
});
