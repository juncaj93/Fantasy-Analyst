/**
 * Team: the recommendation, drawn.
 *
 * The claims this file defends are the ones a reader makes with their eyes in
 * two seconds — which cards are the recommended lineup, which are backups, and
 * whether anything on waivers is worth a move — plus the one interaction that
 * has real edges in it: choosing between two and four players to compare, from
 * a pool that is deliberately not limited to the roster.
 *
 * The demo league starts QB, RB, RB, WR, WR, TE and a FLEX, and the demo roster
 * is four players — one of them on injured reserve. That is not a tidy fixture
 * and it is the better one: most slots have nobody legal for them, which is
 * exactly the state the screen has to be honest about.
 */

import { expect, test, type Page } from '@playwright/test';

async function openTeam(page: Page) {
  await page.goto('/');
  await page.getByTestId('tab-team').click();
  await expect(page.getByTestId('league-card').first()).toBeVisible();
  await expect(page.getByTestId('starters-title')).toBeVisible();
}

/** Pick one player in the open comparison sheet. */
async function choose(page: Page, playerId: string) {
  const row = page.locator(`[data-testid="compare-candidate"][data-player-id="${playerId}"]`);
  await row.click();
  await expect(row).toHaveAttribute('data-chosen', 'true');
}

test.describe('the recommended lineup, at a glance', () => {
  test.beforeEach(async ({ page }) => openTeam(page));

  /**
   * Starters carry the position tint; backups do not.
   *
   * Read from the class the card actually renders with, because that is the
   * thing the colour comes from — asserting a computed background would be
   * asserting the design's current opinion about opacity rather than the
   * property that matters.
   */
  test('tints recommended starters and leaves backups neutral', async ({ page }) => {
    const filled = page.locator('[data-testid="starter-row"][data-starter="true"]');
    expect(await filled.count(), 'the demo roster fills three slots').toBe(3);

    for (const card of await filled.all()) {
      const position = (await card.getAttribute('data-position'))!;
      await expect(card).toHaveClass(new RegExp(`card-pos-${position}\\b`));
    }

    for (const card of await page.getByTestId('bench-row').all()) {
      await expect(card).not.toHaveClass(/card-pos/);
      // ...and the badge stays, because which position he plays is still a fact.
      await expect(card.locator('.pos-pill')).toHaveCount(1);
    }
  });

  /**
   * The tint is never the only cue.
   *
   * A card says which slot it is filling and says the word "Starter"; a bench
   * card says "Bench". Both carry it in the accessible name too, so the answer
   * survives a screen reader, a monochrome display and bright sunlight.
   */
  test('says starter and bench in words, not only in colour', async ({ page }) => {
    const starter = page.locator('[data-testid="starter-row"][data-starter="true"]').first();
    await expect(starter).toContainText('Starter');
    await expect(starter).toHaveAttribute('aria-label', /recommended starter at/i);

    const bench = page.getByTestId('bench-row').first();
    await expect(bench).toContainText('Bench');
    await expect(bench).toHaveAttribute('aria-label', /bench/i);
  });

  /**
   * The order is the league's slots, not a cross-position ranking.
   *
   * A backup quarterback sorted above a starting flex player by raw score is
   * the specific failure this prevents: the lineup is a set of slots, and the
   * slots are what the reader is reading down.
   */
  test('orders starters by lineup slot', async ({ page }) => {
    const slots = await page.getByTestId('starter-row').evaluateAll((rows) =>
      rows.map((r) => r.getAttribute('data-slot')),
    );
    expect(slots).toEqual(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX']);
  });

  /** A slot nothing can fill says so, rather than being quietly dropped. */
  test('shows an unfillable slot honestly', async ({ page }) => {
    const empty = page.locator('[data-testid="starter-row"][data-starter="empty"]');
    expect(await empty.count()).toBeGreaterThan(0);
    await expect(empty.first()).toContainText('Nobody eligible to start here');
  });

  /**
   * Nate Kowalski is on injured reserve and is one of two tight ends here. He
   * is on the bench, untinted, and the tight-end slot went to the other one.
   */
  test('never highlights a player who cannot play', async ({ page }) => {
    const kowalski = page.locator('[data-testid="bench-row"][data-player-id="1009"]');
    await expect(kowalski).toBeVisible();
    await expect(kowalski).not.toHaveClass(/card-pos/);
    await expect(page.locator('[data-testid="starter-row"][data-player-id="1009"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="starter-row"][data-slot="TE"]')).toContainText('Andre Sotelo');
  });
});

test.describe('waiver upgrades', () => {
  test.beforeEach(async ({ page }) => openTeam(page));

  test('puts each player on one row: how strong, where he fits, what he is worth', async ({ page }) => {
    const card = page.getByTestId('waiver-card');
    await expect(card).toBeVisible();
    const row = page.locator('[data-testid="waiver-row"]').first();
    await expect(row).toContainText('Trey Halloran');
    await expect(row.getByTestId('waiver-fit')).toContainText(/Upgrades|Fills/);
    await expect(row.getByTestId('waiver-short-term')).toContainText('pts');
    await expect(row.getByTestId('waiver-why')).not.toBeEmpty();
  });

  /**
   * The row is a decision, not a paragraph.
   *
   * The card this replaced spent five lines and a control per candidate. Three
   * lines is the budget, and it is asserted as a height rather than as a line
   * count because what matters is how much of the phone a suggestion costs.
   */
  test('keeps a suggestion to about three lines', async ({ page }) => {
    const row = page.locator('[data-testid="waiver-row"]').first();
    const height = (await row.boundingBox())!.height;
    expect(height, 'a waiver row should not be taller than a small card').toBeLessThan(120);
  });

  /**
   * What it does not know, it does not invent.
   *
   * Expected cost is a fact about this league's managers and arrives with the
   * league-intelligence pass. Until then the field is a dash — never a number
   * that looks like a bid.
   */
  test('shows expected cost as unknown rather than estimating it', async ({ page }) => {
    const row = page.locator('[data-testid="waiver-row"]').first();
    await expect(row.getByTestId('waiver-cost')).toContainText('—');
    await expect(row.getByTestId('waiver-unknown')).toHaveAttribute('title', /not known yet/);
    // And no digit anywhere in that field that could be read as a bid.
    expect(await row.getByTestId('waiver-cost').innerText()).not.toMatch(/\d/);
  });

  /** Everything the row left out is one tap away, and still not a transaction. */
  test('opens the detail on tap', async ({ page }) => {
    await page.locator('[data-testid="waiver-row"]').first().click();
    const sheet = page.getByTestId('waiver-detail');
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('Expected cost');
    await expect(sheet).toContainText('Competition');
    await expect(sheet).toContainText('Beyond this week');
    await expect(sheet).toContainText('add or drop in Sleeper');
  });

  /** Advisory, and it says so. Nothing here executes anything. */
  test('offers no control that would make a transaction', async ({ page }) => {
    const card = page.getByTestId('waiver-card');
    await expect(card).toContainText('add or drop in Sleeper');
    const buttons = (await card.getByRole('button').allInnerTexts()).join(' ').toLowerCase();
    for (const forbidden of ['add', 'drop', 'claim', 'bid', 'submit']) {
      expect(buttons, `a control reading "${forbidden}" would imply a transaction`).not.toContain(forbidden);
    }
  });

  /**
   * A player another manager owns is never offered.
   *
   * Devin Okafor is the rival's receiver and outscores the one this roster
   * starts; the API is asked directly because "he is not on the screen" could
   * be true for the wrong reason.
   */
  test('never recommends a rostered player', async ({ page }) => {
    const waivers = await (await page.request.get('/api/leagues/demo-league/waivers')).json();
    const offered = (waivers.upgrades as { candidates: { playerId: string }[] }[]).flatMap((u) =>
      u.candidates.map((c) => c.playerId),
    );
    expect(offered).not.toContain('1002');
    expect(offered.length, 'and it does offer somebody').toBeGreaterThan(0);
  });
});

/**
 * Tapping one of your own players.
 *
 * The sheet that opens is the answer to "what about him this week", and its
 * whole reason for existing is that it is *short* — so the assertions are about
 * length and about absence as much as about content.
 */
test.describe('the weekly card', () => {
  test.beforeEach(async ({ page }) => openTeam(page));

  test('opens on a starter with the lineup’s own verdict', async ({ page }) => {
    const starter = page.locator('[data-testid="starter-row"][data-starter="true"]').first();
    const slot = (await starter.getAttribute('data-slot'))!;
    await starter.click();

    const sheet = page.getByTestId('weekly-sheet');
    await expect(sheet).toBeVisible();
    const verdict = page.getByTestId('weekly-verdict');
    await expect(verdict).toHaveAttribute('data-verdict', 'start');
    await expect(verdict).toContainText(`Start at ${slot}`);
  });

  test('and on a bench player with the other one', async ({ page }) => {
    await page.getByTestId('bench-row').first().click();
    await expect(page.getByTestId('weekly-verdict')).toHaveAttribute('data-verdict', /bench|not_playable|unknown/);
  });

  /**
   * Not a stat dump.
   *
   * The full breakdown is still one tap further on in Compare; what arrives
   * here is the short list that changes a decision. Two screen-heights is the
   * budget the brief sets, and this measures against the actual viewport.
   */
  test('fits in about a screen', async ({ page }) => {
    await page.locator('[data-testid="starter-row"][data-starter="true"]').first().click();
    const card = page.getByTestId('weekly-card');
    await expect(card).toBeVisible();
    const height = (await card.boundingBox())!.height;
    expect(height).toBeLessThan(page.viewportSize()!.height * 2);
    // At most five labelled lines, whatever the engine knows.
    expect(await card.locator('.weekly-line').count()).toBeLessThanOrEqual(5);
  });

  /** Unknown is absent, and named once — never printed as a row of dashes. */
  test('does not print a row for something nobody knows', async ({ page }) => {
    await page.locator('[data-testid="starter-row"][data-starter="true"]').first().click();
    const lines = page.getByTestId('weekly-lines');
    if (await lines.count()) await expect(lines).not.toContainText('unknown');
  });

  /** It never offers to change a lineup. It is a card about a decision. */
  test('offers no control that would edit a lineup', async ({ page }) => {
    await page.locator('[data-testid="starter-row"][data-starter="true"]').first().click();
    const buttons = (await page.getByTestId('weekly-sheet').getByRole('button').allInnerTexts())
      .join(' ')
      .toLowerCase();
    for (const forbidden of ['start him', 'bench him', 'swap', 'apply', 'save']) {
      expect(buttons).not.toContain(forbidden);
    }
  });
});

test.describe('the comparison tool', () => {
  test.beforeEach(async ({ page }) => openTeam(page));

  test('opens as a sheet from a compact entry point', async ({ page }) => {
    await page.getByTestId('compare-open').click();
    await expect(page.getByTestId('compare-sheet')).toBeVisible();
    await expect(page.getByTestId('compare-run')).toBeDisabled();
  });

  for (const count of [2, 3, 4] as const) {
    test(`ranks ${count} players`, async ({ page }) => {
      await page.getByTestId('compare-open').click();
      for (const id of ['1001', '1005', '1008', '1012'].slice(0, count)) await choose(page, id);
      await page.getByTestId('compare-run').click();

      const order = page.getByTestId('comparison-order');
      await expect(order).toBeVisible();
      await expect(order.locator('li')).toHaveCount(count);
      await expect(order.locator('li').first()).toContainText('Start:');
    });
  }

  test('refuses a fifth player out loud, and keeps the four already chosen', async ({ page }) => {
    await page.getByTestId('compare-open').click();
    for (const id of ['1001', '1005', '1008', '1012']) await choose(page, id);

    const fifth = page.locator('[data-testid="compare-candidate"][data-player-id="1007"]');
    await fifth.click();
    await expect(fifth).toHaveAttribute('data-chosen', 'false');
    await expect(page.getByTestId('compare-sheet')).toContainText('Up to 4 players at once');
    await expect(page.getByTestId('compare-chosen')).toHaveCount(4);
  });

  test('cannot choose the same player twice', async ({ page }) => {
    await page.getByTestId('compare-open').click();
    await choose(page, '1001');
    // The second tap is the only thing it can be: a removal.
    await page.locator('[data-testid="compare-candidate"][data-player-id="1001"]').click();
    await expect(page.getByTestId('compare-chosen')).toHaveCount(0);
    await choose(page, '1001');
    await expect(page.getByTestId('compare-chosen')).toHaveCount(1);
  });

  /**
   * The pool is not the roster.
   *
   * Marcus Vance is owned here and Kai Brennan is a free agent, and comparing
   * them is an ordinary question — the picker says which is which rather than
   * refusing one of them.
   */
  test('compares a rostered player against a free agent', async ({ page }) => {
    await page.getByTestId('compare-open').click();
    await expect(page.locator('[data-testid="compare-candidate"][data-player-id="1001"]')).toContainText(
      'Your roster',
    );
    await expect(page.locator('[data-testid="compare-candidate"][data-player-id="1005"]')).toContainText(
      'Free agent',
    );
    await expect(page.locator('[data-testid="compare-candidate"][data-player-id="1002"]')).toContainText(
      'Rostered elsewhere',
    );

    await choose(page, '1001');
    await choose(page, '1005');
    await page.getByTestId('compare-run').click();
    await expect(page.getByTestId('comparison-verdict')).toContainText('Start');
  });

  /**
   * Two players who cannot share a slot get an honest answer instead of a
   * ranking. Trey Halloran is a quarterback and Kai Brennan a receiver; this
   * league starts one quarterback and a W/R/T flex, so there is no lineup in
   * which the question means anything.
   */
  test('says so when the players are not the same lineup decision', async ({ page }) => {
    await page.getByTestId('compare-open').click();
    await choose(page, '1003');
    await choose(page, '1005');
    await page.getByTestId('compare-run').click();

    await expect(page.getByTestId('comparison-verdict')).toContainText('Not the same lineup decision');
    await expect(page.getByTestId('comparison-slot')).toContainText('do not share a lineup slot');
    // The per-player numbers are still there — honest, just not a verdict.
    await expect(page.getByTestId('comparison')).toContainText('Trey Halloran');
  });

  /**
   * Launching from a slot keeps the comparison about that slot.
   *
   * Tapping a player now opens his week rather than the comparison — that is
   * the question a reader is asking nine times out of ten — and Compare is the
   * way out of it. The slot survives the trip, which is the part that matters.
   */
  test('opens narrowed when launched from a lineup slot', async ({ page }) => {
    await page.locator('[data-testid="starter-row"][data-slot="TE"]').click();
    await expect(page.getByTestId('weekly-sheet')).toBeVisible();
    await page.getByTestId('weekly-compare').click();
    const sheet = page.getByTestId('compare-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('Compare for TE');
    // The player whose card was tapped is already in the comparison.
    await expect(page.getByTestId('compare-chosen')).toHaveCount(1);

    await choose(page, '1009');
    await page.getByTestId('compare-run').click();
    await expect(page.getByTestId('comparison-slot')).toContainText('TE');
  });

  /**
   * One engine, not two.
   *
   * The sheet's ranking and the lineup card's own numbers come from the same
   * evaluation, so the score a player is given in the comparison is the score
   * the recommended lineup gave him.
   */
  test('uses the same start/sit engine the lineup does', async ({ page }) => {
    const lineup = await (await page.request.get('/api/leagues/demo-league/lineup')).json();
    const te = (lineup.slots as { slot: string; playerId: string | null; score: number | null }[]).find(
      (s) => s.slot === 'TE',
    )!;

    await page.getByTestId('compare-open').click();
    await choose(page, te.playerId!);
    await choose(page, '1001');
    await page.getByTestId('compare-run').click();

    const row = page.getByTestId('comparison').locator('tbody tr', { hasText: 'Andre Sotelo' });
    await expect(row).toContainText(te.score!.toFixed(1));
  });
});

/**
 * Pull the screen down, far enough to fire.
 *
 * A real pointer drag rather than the accessible fallback, because the gesture
 * is the only *prominent* way to refresh this screen now and a test that only
 * pressed the hidden button would prove nothing about it. It starts from the
 * top of the page, which is the one place the gesture is allowed to begin.
 */
async function pullToRefresh(page: Page) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const box = (await page.getByTestId('team-pull').boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + 40;
  await page.mouse.move(x, y);
  await page.mouse.down();
  // In steps, so the hook sees the direction before it sees the distance —
  // exactly as a thumb produces it.
  for (const step of [12, 60, 120, 190]) await page.mouse.move(x, y + step);
  await page.mouse.up();
}

/**
 * The two controls the intelligence pass adds, drawn.
 *
 * Both are about a real screen rather than about the engine underneath: the
 * mode chips have to be reachable and exclusive, and the refresh has to say
 * what it did instead of blinking. The demo deployment has no odds key, so this
 * also covers the honest-partial case — some sources skipped, and the page
 * saying so rather than claiming everything is current.
 */
test.describe('mode and refresh', () => {
  test.beforeEach(async ({ page }) => openTeam(page));

  test('offers Balanced, Floor and Ceiling, with exactly one chosen', async ({ page }) => {
    const row = page.getByTestId('mode-row');
    await expect(row).toBeVisible();
    await expect(page.getByTestId('mode-balanced')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('mode-floor')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('mode-ceiling')).toHaveAttribute('aria-pressed', 'false');
  });

  test('recomputes when the mode changes, without losing the lineup', async ({ page }) => {
    await page.getByTestId('mode-floor').click();
    await expect(page.getByTestId('mode-floor')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('mode-balanced')).toHaveAttribute('aria-pressed', 'false');
    // The recommendation is still there, drawn from the new answer.
    await expect(page.getByTestId('starters-title')).toBeVisible();
    await expect(page.locator('[data-testid="starter-row"]').first()).toBeVisible();
  });

  /**
   * The button, without letting it move the ground under the other tests.
   *
   * Pressing it for real is a *write*: it syncs the league from Sleeper,
   * re-ingests injuries and usage, and asks the odds provider for lines. The
   * three viewport projects share one dev server and one database, so a real
   * press in this suite reaches into whatever the other two projects are
   * reading — which is exactly what happened when this test was first written,
   * and it took an unrelated draft-room assertion down with it.
   *
   * So the response is stubbed here and the server side is left to
   * `tests/startsit.refresh.test.ts`, which exercises the real orchestrator
   * against a real database — dedupe, budget refusal, partial failure and all.
   * What is left for a browser to prove is the part only a browser can: that
   * the button reports per-source outcomes rather than a bare "done", and that
   * a partial refresh leaves the page it just refreshed still readable.
   */
  const stubRefresh = async (page: Page, sources: { source: string; outcome: string; detail: string }[]) => {
    await page.route('**/api/startsit/refresh', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          deduped: false,
          sources: sources.map((s) => ({ ...s, freshAt: null })),
          headline: sources.some((s) => s.outcome === 'updated') ? 'Updated' : 'Already current',
          complete: sources.every((s) => s.outcome !== 'unavailable'),
        }),
      });
    });
  };

  test('reports what each source did, naming the one it has no feed for', async ({ page }) => {
    await stubRefresh(page, [
      { source: 'sleeper', outcome: 'updated', detail: '1 roster re-read' },
      { source: 'injury', outcome: 'current', detail: 'checked 2 min ago' },
      { source: 'usage', outcome: 'current', detail: 'through week 4' },
      { source: 'vegas', outcome: 'updated', detail: '2 games re-priced' },
      { source: 'weather', outcome: 'skipped', detail: 'no forecast source connected' },
    ]);

    await pullToRefresh(page);

    const status = page.getByTestId('refresh-status');
    await expect(status).toBeVisible({ timeout: 20_000 });
    await expect(status).toContainText('Updated');
    // Weather is named rather than quietly missing from the list.
    await expect(status).toContainText('weather');
    await expect(status).toContainText('no forecast source connected');
  });

  test('leaves the lineup readable when a source could not be refreshed', async ({ page }) => {
    await stubRefresh(page, [
      { source: 'sleeper', outcome: 'updated', detail: '1 roster re-read' },
      { source: 'injury', outcome: 'unavailable', detail: 'injury source did not answer' },
      { source: 'usage', outcome: 'current', detail: 'through week 4' },
      { source: 'vegas', outcome: 'blocked', detail: 'monthly entity ceiling reached' },
      { source: 'weather', outcome: 'skipped', detail: 'no forecast source connected' },
    ]);

    await pullToRefresh(page);
    const status = page.getByTestId('refresh-status');
    await expect(status).toBeVisible({ timeout: 20_000 });
    // The failures are named, not swallowed...
    await expect(status).toContainText('injury source did not answer');
    await expect(status).toContainText('monthly entity ceiling reached');
    // ...and the last-good recommendation is still on screen.
    await expect(page.getByTestId('starters-title')).toBeVisible();
    await expect(page.locator('[data-testid="starter-row"][data-starter="true"]').first()).toBeVisible();
  });

  /**
   * One pull, one request.
   *
   * The guard is a ref rather than the state that paints the spinner, because
   * state lands a render later and a second pull happens in between. Two pulls
   * in quick succession are counted at the network, which is the only place the
   * answer is not a matter of opinion.
   */
  test('does not fire a second refresh while one is running', async ({ page }) => {
    let calls = 0;
    await page.route('**/api/startsit/refresh', async (route) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          deduped: false,
          sources: [{ source: 'sleeper', outcome: 'current', detail: 'checked just now', freshAt: null }],
          headline: 'Already current',
          complete: true,
        }),
      });
    });

    await pullToRefresh(page);
    await pullToRefresh(page);
    await expect(page.getByTestId('refresh-status')).toBeVisible({ timeout: 20_000 });
    expect(calls, 'the second pull should have been swallowed by the one in flight').toBe(1);
  });

  /**
   * The controls this screen used to have, and no longer does.
   *
   * Asserted as an absence because that is the whole change: a reader looking
   * for a refresh button must find the gesture instead, and a bar control that
   * crept back would be the third way of asking the same question.
   */
  test('offers no refresh button anywhere on the screen', async ({ page }) => {
    const labels = (await page.locator('button:visible').allInnerTexts()).join(' | ').toLowerCase();
    expect(labels).not.toContain('refresh');
    // The keyboard fallback exists and is deliberately not part of the UI.
    const fallback = page.getByTestId('pull-refresh-fallback');
    await expect(fallback).toHaveCount(1);
    await expect(fallback).not.toBeInViewport();
  });

  /**
   * Four controls, one row.
   *
   * Measured rather than eyeballed: the three mode chips and Compare share a
   * single line at every width this suite runs at, and every one of them is
   * still a full tap target.
   */
  test('fits the mode chips and Compare on one row, at a thumb size', async ({ page }) => {
    const controls = page.getByTestId('team-controls');
    const rowBox = (await controls.boundingBox())!;
    for (const id of ['mode-balanced', 'mode-floor', 'mode-ceiling', 'compare-open']) {
      const box = (await page.getByTestId(id).boundingBox())!;
      expect(box.height, `${id} must stay a tap target`).toBeGreaterThanOrEqual(43);
      expect(box.y, `${id} must be on the control row`).toBeGreaterThanOrEqual(rowBox.y - 1);
      expect(box.y + box.height, `${id} must not wrap below it`).toBeLessThanOrEqual(rowBox.y + rowBox.height + 1);
    }
  });
});
