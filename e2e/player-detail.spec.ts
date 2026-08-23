/**
 * The expanded player, on both screens, as one object.
 *
 * Players and Trades open the same card, and before this pass they did not read
 * like it. The identity line ran name-first in the sheet and pill-first on every
 * row underneath it; the availability tag appeared on one screen and not the
 * other; the metrics were spread over a band, a `2025` block, a preseason line
 * and a four-cell window grid that repeated the band; a cached Vegas table sat
 * where the preseason expectation belongs; and the news read as the classifier's
 * own console — `mag 13 · uncategorised · auto_applied` — rather than as what
 * happened to the player.
 *
 * Every assertion here is written to fail if one of those comes back. That is
 * the point of the file: a presentation pass with no test is a presentation pass
 * that lasts until the next one.
 *
 * It runs at 430, 390, 375 and 360 because the Playwright projects are the
 * widths — see `playwright.config.ts`. Nothing in here is width-specific, which
 * is deliberate: a card that only holds together on a Pro Max is not a card.
 *
 * What it does not touch: which players Players lists and in which order, and
 * which section of Trades a suggestion lands in with what confidence. Both are
 * asserted below to be exactly the order the API sent, because the whole
 * promise of a presentation pass is that it changed no recommendation.
 */

import { expect, test, type Page } from '@playwright/test';

/** A snapshot the demo seed does not carry, injected the way a deployment would. */
const PROJECTION = {
  points: 291.6,
  label: 'StartWho, Aug 22',
  scoringLabel: 'Half PPR',
  capturedAt: '2026-08-22T12:00:00.000Z',
};

/**
 * Give every player a preseason projection.
 *
 * The demo world has no StartWho paste in it and inventing one in the seed
 * would be testing a fixture — the import itself is proven in the unit and
 * route suites. What this file needs is the *card's* behaviour with and without
 * the field, so the field is added to the response instead: absent is the demo
 * default, present is this route.
 */
async function withProjection(page: Page): Promise<void> {
  await page.route('**/api/players/*/detail', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, body: JSON.stringify({ ...body, preseasonProjection: PROJECTION }) });
  });
}

/** Answer as a deployment that has never ingested last season's statistics. */
async function withoutLastSeason(page: Page): Promise<void> {
  await page.route('**/api/players/*/detail', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, body: JSON.stringify({ ...body, lastSeason: null }) });
  });
}

async function openTab(page: Page, tab: 'players' | 'trades'): Promise<void> {
  await page.goto('/');
  await page.getByTestId(`tab-${tab}`).click();
  await page.waitForTimeout(500);
}

/** Open one player from Players and wait for both requests to have landed. */
async function openPlayer(page: Page, playerId: string): Promise<void> {
  await openTab(page, 'players');
  const row = page.locator(`[data-testid="player-search-row"][data-player-id="${playerId}"]`);
  await row.scrollIntoViewIfNeeded();
  await row.click();
  await expect(page.getByTestId('player-sheet')).toBeVisible();
  await expect(page.getByTestId('player-page-metrics')).toBeVisible();
}

async function openFirstTrade(page: Page): Promise<void> {
  await openTab(page, 'trades');
  await page.getByTestId('trade-row').first().click();
  await expect(page.getByTestId('player-sheet')).toBeVisible();
  await expect(page.getByTestId('trade-case')).toBeVisible();
}

async function pageOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/**
 * The left edge of everything on the sheet's identity line, in document order.
 *
 * Read as geometry rather than as DOM order on purpose. A card can put the pill
 * first in the markup and float it to the end, and the reader would still be
 * looking at the reversed grammar this file exists to forbid.
 */
async function identityOrder(page: Page): Promise<{ mark: string; x: number }[]> {
  return page.locator('.sheet-player-title').evaluate((title) => {
    const pick = (sel: string, mark: string) => {
      const el = title.querySelector(sel) as HTMLElement | null;
      return el ? { mark, x: el.getBoundingClientRect().left } : null;
    };
    return [
      pick('.pos-pill', 'position'),
      pick('.team-logo, .team-code', 'club'),
      pick('.sheet-player-name', 'name'),
      pick('[data-testid="injury-tag"]', 'status'),
    ].filter((p): p is { mark: string; x: number } => p != null);
  });
}

test.describe('the expanded player wears the same identity as the row it came from', () => {
  /**
   * Position, club, name, status — the order every compact row already uses.
   *
   * The sheet used to draw the name first and cluster the rest after it, and
   * the comment on `.sheet-player-title` claimed it was "the same three marks,
   * in the same order, as every list row in the app" while the markup said
   * otherwise. Asserted by x-position so that neither a DOM reshuffle nor a
   * `flex-direction: row-reverse` can satisfy it dishonestly.
   */
  test('reads position, club, name, status from left to right on Players', async ({ page }) => {
    await openPlayer(page, '1004');
    const marks = await identityOrder(page);
    expect(marks.map((m) => m.mark)).toEqual(['position', 'club', 'name', 'status']);
    for (let i = 1; i < marks.length; i++) {
      expect(marks[i]!.x, `${marks[i]!.mark} is left of ${marks[i - 1]!.mark}`).toBeGreaterThan(marks[i - 1]!.x);
    }
  });

  test('reads the same way on Trades', async ({ page }) => {
    await openFirstTrade(page);
    const marks = await identityOrder(page);
    // The first suggestion may be healthy, so the status mark is optional here.
    expect(marks.map((m) => m.mark).slice(0, 3)).toEqual(['position', 'club', 'name']);
    for (let i = 1; i < marks.length; i++) {
      expect(marks[i]!.x).toBeGreaterThan(marks[i - 1]!.x);
    }
  });

  /**
   * The tag is beside the name on both screens, from whichever source has it.
   *
   * Players hands over Sleeper's own `status` with the row. Trades hands over a
   * trade suggestion, which has never carried a designation — so the same
   * player showed `OUT` on one screen and nothing on the other. The detail
   * payload both screens already fetch is the fallback, which is why this can
   * be asserted on Trades at all.
   */
  test('shows the availability tag on Trades, which never had one to pass', async ({ page }) => {
    /*
     * The designation is forced onto the detail response rather than found on
     * the board. Which players the demo world suggests is the trade engine's
     * business and is deliberately not this file's to depend on; what is being
     * proven is that a screen holding no `status` at all still draws the pill,
     * which is exactly the drift the shared card was written to close.
     */
    await page.route('**/api/players/*/detail', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        response,
        body: JSON.stringify({
          ...body,
          injury: {
            designation: 'out',
            label: 'Out',
            line: 'OUT · hamstring',
            bodyPart: 'hamstring',
            practice: null,
            provenance: 'sleeper status · current',
            freshness: 'fresh',
            confidence: 'high',
            conflict: null,
          },
        }),
      });
    });
    await openFirstTrade(page);
    const tag = page.locator('.sheet-player-title [data-testid="injury-tag"]');
    await expect(tag).toHaveAttribute('data-status', 'OUT');
    // The meaning, not just the letters, for anyone listening rather than looking.
    await expect(tag).toHaveAttribute('aria-label', 'Out');
    // And the block underneath says only what the pill could not carry.
    const injury = page.getByTestId('injury-current');
    await expect(injury).toContainText('hamstring');
    await expect(injury, 'the designation is on the card twice').not.toContainText('OUT');
  });

  /** A healthy player carries nothing. A badge on every row means nothing. */
  test('carries no tag for a player with nothing wrong with him', async ({ page }) => {
    await openPlayer(page, '1001');
    await expect(page.locator('.sheet-player-title [data-testid="injury-tag"]')).toHaveCount(0);
  });

  /**
   * A long name yields before anything to the right of it does.
   *
   * The failure this guards is the one that only appears on a 360px phone with
   * a hyphenated name and a status: the name pushes the tag off the sheet, or
   * the header grows a second line and the card loses a row to its own title.
   */
  test('truncates a long name rather than pushing the status off the sheet', async ({ page }) => {
    await page.route('**/api/players?*', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const players = body.players.map((p: { id: string; name: string; status: string | null }) =>
        p.id === '1001'
          ? { ...p, name: 'Bartholomew Vandersteen-Okonkwo III', status: 'Questionable' }
          : p,
      );
      await route.fulfill({ response, body: JSON.stringify({ ...body, players }) });
    });
    await openPlayer(page, '1001');

    const title = page.locator('.sheet-player-title');
    const box = (await title.boundingBox())!;
    const sheet = (await page.locator('.sheet').boundingBox())!;
    const tag = (await page.locator('.sheet-player-title [data-testid="injury-tag"]').boundingBox())!;

    // The tag is on screen, inside the sheet, and to the right of the name.
    expect(tag.x + tag.width, 'the status pill is clipped by the sheet').toBeLessThanOrEqual(sheet.x + sheet.width + 1);
    // One line: a header two lines tall is a card that lost a row to its title.
    expect(box.height, `the header wrapped to ${box.height}px`).toBeLessThanOrEqual(40);
    // And the name really did shorten rather than overflow.
    const clipped = await page
      .locator('.sheet-player-name')
      .evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(clipped, 'the name was not truncated, so something else must have moved').toBe(true);
    expect(await pageOverflow(page)).toBeLessThanOrEqual(1);
  });
});

test.describe('the top metric band says everything the card used to spread over four blocks', () => {
  /**
   * Preseason PTS, in the band, dated, and never in the present tense.
   *
   * `PTS` on its own is a label a reader in week nine will read as a live
   * projection, and the brief this pass came from names that exact failure. The
   * abbreviation is what fits a metric cell; everything else about it — the
   * capture date under the figure, the tooltip, the accessible name — opens
   * with the word preseason.
   */
  test('prints the preseason projection with its date and its full meaning', async ({ page }) => {
    await withProjection(page);
    await openPlayer(page, '1001');

    const pts = page.getByTestId('metric-preseason-pts');
    await expect(pts).toBeVisible();
    await expect(pts.locator('.stat-label')).toHaveText('PTS');
    await expect(pts.locator('.stat-value')).toHaveText('292');
    await expect(pts.locator('.stat-note')).toContainText('Aug');

    const spoken = (await pts.locator('.sr-only').innerText()).toLowerCase();
    expect(spoken).toContain('preseason');
    expect(spoken).toContain('projected season fantasy points');
    const hint = (await pts.getAttribute('title'))!.toLowerCase();
    expect(hint).toContain('preseason market projection');
    // The three readings it must never offer.
    for (const wrong of ['current projection', 'weekly projection', 'vegas says']) {
      expect(hint).not.toContain(wrong);
      expect(spoken).not.toContain(wrong);
    }
  });

  /** No snapshot covers him: no cell, not a dash and never a zero. */
  test('shows no PTS cell at all when no snapshot covers him', async ({ page }) => {
    await openPlayer(page, '1001');
    await expect(page.getByTestId('metric-preseason-pts')).toHaveCount(0);
    await expect(page.getByTestId('player-page-metrics')).not.toContainText('PTS');
  });

  test('promotes last season into the band', async ({ page }) => {
    await openPlayer(page, '1004');
    await expect(page.getByTestId('metric-last-season-gp').locator('.stat-value')).toHaveText('12');
    await expect(page.getByTestId('metric-last-season-rank').locator('.stat-value')).toHaveText('TE2');
    // The label names the season, so `GP` is never a number from nowhere.
    await expect(page.getByTestId('metric-last-season-gp').locator('.stat-label')).toContainText(/20\d\d/);
  });

  /**
   * A player who did not appear gets a dash, and never the 1,240th place in a
   * directory that Sleeper would happily report as a finish.
   */
  test('dashes last season for a player who did not play it', async ({ page }) => {
    await openPlayer(page, '1012');
    await expect(page.getByTestId('metric-last-season-gp').locator('.stat-value')).toHaveText('—');
    await expect(page.getByTestId('metric-last-season-rank').locator('.stat-value')).toHaveText('—');
  });

  /** Nothing ingested at all is a different answer: no cells rather than dashes. */
  test('draws no last-season cells when the statistics were never ingested', async ({ page }) => {
    await withoutLastSeason(page);
    await openPlayer(page, '1004');
    await expect(page.getByTestId('metric-last-season-gp')).toHaveCount(0);
    await expect(page.getByTestId('metric-last-season-rank')).toHaveCount(0);
    // …and the band is still a band, with the readings that do exist on it.
    await expect(page.getByTestId('player-page-metrics')).toContainText('21d');
  });

  /**
   * The same six readings in the same order on both screens.
   *
   * Players adds the two it alone knows — where Sleeper has him and where this
   * app does — in front of them. Everything after that must match, or a reader
   * who learned the card on one screen has to learn it again on the other.
   */
  test('orders its cells identically on Players and on Trades', async ({ page }) => {
    await withProjection(page);
    await openPlayer(page, '1002');
    const fromPlayers = await page.getByTestId('player-page-metrics').locator('.stat-label').allInnerTexts();
    await page.keyboard.press('Escape');

    await page.getByTestId('tab-trades').click();
    await page.waitForTimeout(600);
    const okafor = page.locator('[data-testid="trade-row"]', { hasText: 'Devin Okafor' });
    await okafor.first().click();
    await expect(page.getByTestId('player-sheet')).toBeVisible();
    await expect(page.getByTestId('metric-preseason-pts')).toBeVisible();
    const fromTrades = await page.getByTestId('player-page-metrics').locator('.stat-label').allInnerTexts();

    // Compared in lower case: the label is uppercased by the stylesheet, and
    // this is an assertion about which readings appear in which order rather
    // than about typography.
    const seen = (labels: string[]) => labels.map((l) => l.trim().toLowerCase());
    expect(seen(fromTrades).slice(0, 4)).toEqual(['7d', '21d', 'life', 'pts']);
    expect(seen(fromPlayers).slice(0, 2)).toEqual(['rank', 'adp']);
    expect(seen(fromPlayers).slice(2)).toEqual(seen(fromTrades));
  });

  /**
   * Every label and every figure fits its cell, at every width.
   *
   * A truncated number is worse than no number — it is a value the reader will
   * misread rather than skip — and the band is the one place this pass added
   * cells. `2025 rank` is the longest label on it and 360px is the narrowest
   * phone, so this is the assertion that decides whether the two are
   * compatible.
   */
  test('never truncates a label, a figure or a capture date', async ({ page }) => {
    await withProjection(page);
    await openPlayer(page, '1004');
    const clipped = await page.locator('[data-testid="player-page-metrics"] .stat').evaluateAll((cells) =>
      cells.flatMap((cell) =>
        ['.stat-label', '.stat-value', '.stat-note']
          .map((sel) => cell.querySelector(sel) as HTMLElement | null)
          .filter((el): el is HTMLElement => el != null)
          .filter((el) => el.scrollWidth > el.clientWidth + 1)
          .map((el) => el.textContent ?? ''),
      ),
    );
    expect(clipped, `these are cut off: ${clipped.join(' | ')}`).toEqual([]);
    expect(await pageOverflow(page)).toBeLessThanOrEqual(1);
  });
});

test.describe('the expanded card stopped being the place everything had to fit', () => {
  /**
   * Four blocks gone, and every one of them was saying something twice.
   *
   * `News by window` repeated the tally windows now in the band. `2025` was a
   * heading over two numbers now in the band. `Draft market` printed the rank,
   * the ADP and their difference, two of which are in the band and the third of
   * which is their subtraction. `Categories` restated the tally by category.
   * And `Vegas props` is a cached book line, which is not what a reader opens a
   * player for and is not what the preseason expectation is any more.
   */
  for (const surface of ['players', 'trades'] as const) {
    test(`removes the duplicated blocks from the ${surface} card`, async ({ page }) => {
      if (surface === 'players') await openPlayer(page, '1002');
      else await openFirstTrade(page);

      const snapshot = page.getByTestId('player-page-snapshot');
      const text = await snapshot.innerText();
      for (const gone of ['News by window', 'Vegas props', 'Categories', 'Draft market']) {
        expect(text, `"${gone}" is back on the expanded card`).not.toContain(gone);
      }
      await expect(snapshot.getByTestId('player-page-windows')).toHaveCount(0);
      // …and no lower injury heading restating a pill that is already drawn.
      expect(text).not.toContain('Injury context\nOut');
    });
  }

  /**
   * Nothing was deleted, only moved. The whole of it is one tap in.
   *
   * This is the other half of the claim above, and without it the removals
   * would be losses: the four-window breakdown with its item counts, the draft
   * market with its movement badge, the categories and the prop table are all
   * still rendered, under Market and Overview on the player's own page.
   */
  test('keeps every removed block on the full profile', async ({ page }) => {
    await openPlayer(page, '1002');
    await page.getByTestId('player-full-profile').click();
    await expect(page.getByTestId('player-page')).toBeVisible();

    await expect(page.getByTestId('player-page-windows')).toBeVisible();
    const sections = page.getByTestId('player-page-sections');
    await sections.getByRole('button', { name: 'Market' }).click();
    await expect(page.getByText('Draft market')).toBeVisible();
    await expect(page.getByText(/Vegas props/)).toBeVisible();
  });

  /**
   * The outlook stays, whole, attributed and under the provider's own title.
   *
   * It is the one long thing on the card that is not a duplicate of anything,
   * and the pass that removed four blocks is exactly the pass that would take
   * it by accident.
   */
  test('keeps the season outlook and its attribution', async ({ page }) => {
    await openPlayer(page, '1004');
    const outlook = page.getByTestId('outlook');
    await expect(outlook).toBeVisible();
    await expect(outlook).toContainText('via Sleeper');
    await expect(page.getByTestId('player-page-snapshot')).toContainText(/20\d\d Season Outlook/);
  });
});

test.describe('latest news reads like football rather than like a classifier', () => {
  /**
   * The takeaway, the date, and nothing about how the tally was computed.
   *
   * The console row printed `mag 13`, the category — `uncategorised` when the
   * rules did not name one — the review status, the rule id and the confidence
   * score. Every token is true and every token is about the machinery. The
   * ledger keeps all of it under Evidence; the card shows what happened.
   */
  for (const surface of ['players', 'trades'] as const) {
    test(`drops the implementation vocabulary on the ${surface} card`, async ({ page }) => {
      if (surface === 'players') await openPlayer(page, '1002');
      else await openFirstTrade(page);

      const news = page.getByTestId('player-page-snapshot').getByTestId('evidence-item');
      await expect(news.first()).toBeVisible();
      const text = await page.getByTestId('player-page-snapshot').innerText();
      expect(text, 'the magnitude is back on the card').not.toMatch(/\bmag \d/);
      expect(text, 'the category-debug label is back on the card').not.toContain('uncategorised');
      expect(text).not.toContain('auto_applied');
      expect(text).not.toMatch(/\brule: /);
      expect(text).not.toMatch(/confidence: /);
    });
  }

  /**
   * The sentence is one the ledger already holds, chosen rather than written.
   *
   * A polished card is the easiest place in an app to start inventing a
   * cleaner-sounding fact than the evidence supports, so this checks the
   * opposite: whatever is on screen has to appear in the item's own stored
   * summary or excerpt, read back from the API.
   */
  test('shows only words the ledger actually stores', async ({ page }) => {
    await openPlayer(page, '1002');
    const shown = await page
      .getByTestId('player-page-snapshot')
      .getByTestId('evidence-item')
      .first()
      .locator('.player-news-text')
      .evaluate((el) => {
        // The polarity mark and the word beside it for assistive technology are
        // the card's own furniture; what is being checked is the sentence.
        const clone = el.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('.player-news-mark, .sr-only').forEach((n) => n.remove());
        return (clone.textContent ?? '').replace(/\s+/g, ' ').replace(/^“|”$/g, '').trim();
      });
    expect(shown, 'the news item rendered no sentence at all').not.toBe('');

    const file = await page.evaluate(async () => (await fetch('/api/players/1002')).json());
    const newest = file.evidence[0];
    const stored = [newest.userOverride?.note, newest.contextSummary, newest.excerpt]
      .filter((s: string | null | undefined) => !!s)
      .map((s: string) => s.replace(/\s+/g, ' ').trim());
    expect(stored, `"${shown}" is in none of the stored words for this item`).toContain(shown);
  });

  /**
   * The source is printed when it varies and omitted when it cannot.
   *
   * The demo world has one newsletter, so every line would carry the same name
   * — a word repeated down the card that qualifies nothing and costs each line
   * the room to say something.
   */
  test('omits a source name that is the same on every line', async ({ page }) => {
    await openPlayer(page, '1002');
    const sources = await page.evaluate(async () => {
      const file = await (await fetch('/api/players/1002')).json();
      return [...new Set(file.evidence.map((e: { sourceName: string }) => e.sourceName))];
    });
    const first = await page.getByTestId('player-page-snapshot').getByTestId('evidence-item').first().innerText();
    if (sources.length === 1) expect(first).not.toContain(sources[0] as string);
    else expect(first).toContain(sources[0] as string);
  });

  /** Nothing written about him is not a heading over an apology. */
  test('draws no news heading for a player nobody has written about', async ({ page }) => {
    await openPlayer(page, '1012');
    const snapshot = page.getByTestId('player-page-snapshot');
    await expect(snapshot).toBeVisible();
    await expect(snapshot.getByTestId('evidence-heading')).toHaveCount(0);
    await expect(snapshot.getByTestId('evidence-item')).toHaveCount(0);
  });

  /** The console itself is untouched, because it is the provenance promise. */
  test('keeps the whole console under Evidence', async ({ page }) => {
    await openPlayer(page, '1002');
    await page.getByTestId('player-full-profile').click();
    await page.getByTestId('player-page-sections').getByRole('button', { name: 'Evidence' }).click();
    const ledger = page.getByTestId('player-page-evidence');
    await expect(ledger.getByTestId('evidence-item').first()).toBeVisible();
    await expect(ledger).toContainText(/mag \d/);
    await expect(ledger).toContainText(/confidence: /);
  });
});

test.describe('the pass changed no recommendation', () => {
  /**
   * The list is the API's answer, in the API's order.
   *
   * Presentation work is exactly the kind that can quietly re-sort a list — a
   * `map` that became a `sort`, a memo keyed on the wrong thing — and the
   * ranking formula is not this workstream's to touch. Read from the same
   * response the screen read.
   */
  test('lists players in the order the API sent them', async ({ page }) => {
    await openTab(page, 'players');
    await expect(page.getByTestId('player-search-row').first()).toBeVisible();
    const onScreen = await page
      .getByTestId('player-search-row')
      .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-player-id')));
    const fromApi = await page.evaluate(async () => {
      const res = await (await fetch('/api/players?q=&limit=100&offset=0')).json();
      return res.players.map((p: { id: string }) => p.id);
    });
    expect(onScreen).toEqual(fromApi.slice(0, onScreen.length));
  });

  /**
   * Every suggestion in the section the board put it in, in the board's order,
   * with the board's own confidence.
   *
   * Trade Target versus Emerging, the confidence and the ordering are named in
   * the brief as untouchable, and this is what "untouched" looks like from the
   * outside: the screen is a rendering of `/api/trades` and adds no opinion.
   */
  test('renders the trade board exactly as the API classified and ordered it', async ({ page }) => {
    await openTab(page, 'trades');
    await expect(page.getByTestId('trade-row').first()).toBeVisible();

    const onScreen = await page.evaluate(() =>
      [...document.querySelectorAll('[role="list"][aria-label]')].map((group) => ({
        label: group.getAttribute('aria-label'),
        players: [...group.querySelectorAll('[data-testid="trade-row"]')].map((r) =>
          (r.querySelector('.player-name')?.textContent ?? '').trim(),
        ),
      })),
    );
    const fromApi = await page.evaluate(async () => {
      const board = await (await fetch('/api/trades')).json();
      return board.sections.map((s: { label: string; players: { name: string }[] }) => ({
        label: s.label,
        players: s.players.map((p) => p.name),
      }));
    });
    expect(onScreen).toEqual(fromApi);
  });
});

test.describe('the card fits the phone', () => {
  for (const surface of ['players', 'trades'] as const) {
    test(`never scrolls sideways anywhere down the ${surface} card`, async ({ page }) => {
      await withProjection(page);
      if (surface === 'players') await openPlayer(page, '1004');
      else await openFirstTrade(page);

      const body = page.locator('.sheet-body');
      const height = await body.evaluate((el) => el.scrollHeight);
      for (let top = 0; top <= height; top += 180) {
        await body.evaluate((el, y) => el.scrollTo({ top: y }), top);
        await page.waitForTimeout(60);
        const overflow = await pageOverflow(page);
        expect(overflow, `the card overflows by ${overflow}px at ${top}px down`).toBeLessThanOrEqual(1);
      }
    });
  }

  /**
   * Reading order follows visual order.
   *
   * The band is a grid, and a grid is the one layout where the two can come
   * apart silently — `order`, `grid-auto-flow: column dense` or a placed cell
   * will re-lay a row without moving a line of markup. Anybody listening to
   * this card hears the cells in document order, so document order has to be
   * what is on screen.
   */
  test('reads its metric cells in the order they are drawn', async ({ page }) => {
    await withProjection(page);
    await openPlayer(page, '1004');
    const cells = await page.locator('[data-testid="player-page-metrics"] .stat').evaluateAll((els) =>
      els.map((el) => {
        const box = el.getBoundingClientRect();
        return { top: Math.round(box.top), left: Math.round(box.left) };
      }),
    );
    expect(cells.length).toBeGreaterThan(4);
    for (let i = 1; i < cells.length; i++) {
      const previous = cells[i - 1]!;
      const current = cells[i]!;
      const forwards = current.top > previous.top || (current.top === previous.top && current.left > previous.left);
      expect(forwards, `cell ${i} is drawn before the one in front of it`).toBe(true);
    }
  });
});
