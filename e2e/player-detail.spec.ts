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
 * **The tests are grouped by the card they open, not by the claim they make.**
 * That is a cost decision rather than a stylistic one. Every `page.goto('/')`
 * re-boots the single-page app, and the browser suite runs the whole of `e2e/`
 * inside a twenty-minute step budget that the 430 width was already spending
 * nineteen of; a file of twenty-seven one-assertion tests, each re-booting to
 * check one thing about one card, is most of a minute of that budget spent on
 * navigation. So a test opens a player once and reads everything that is true
 * of *that* player, and the assertion messages carry the claim that a test name
 * would otherwise have carried.
 *
 * What it does not touch: which players Players lists and in which order, and
 * which section of Trades a suggestion lands in with what confidence. Both are
 * asserted below to be exactly the order the API sent, because the whole promise
 * of a presentation pass is that it changed no recommendation.
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
 * Rewrite the detail response before the card reads it.
 *
 * The demo world has no StartWho paste in it and inventing one in the seed
 * would be testing a fixture — the import itself is proven in the unit and
 * route suites. What this file needs is the *card's* behaviour with and without
 * a field, so the field is put on the response instead: absent is the demo
 * default, present is this route.
 */
async function patchDetail(page: Page, patch: Record<string, unknown>): Promise<void> {
  await page.route('**/api/players/*/detail', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, body: JSON.stringify({ ...body, ...patch }) });
  });
}

async function openTab(page: Page, tab: 'players' | 'trades'): Promise<void> {
  await page.getByTestId(`tab-${tab}`).click();
  await page.waitForTimeout(400);
}

/** Open one player from Players and wait for both requests to have landed. */
async function openPlayer(page: Page, playerId: string): Promise<void> {
  const row = page.locator(`[data-testid="player-search-row"][data-player-id="${playerId}"]`);
  await row.scrollIntoViewIfNeeded();
  await row.click();
  await expect(page.getByTestId('player-sheet')).toBeVisible();
  await expect(page.getByTestId('player-page-metrics')).toBeVisible();
}

async function openFirstTrade(page: Page): Promise<void> {
  await page.getByTestId('trade-row').first().click();
  await expect(page.getByTestId('player-sheet')).toBeVisible();
  await expect(page.getByTestId('player-page-metrics')).toBeVisible();
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

/** Position, club, name, status — painted left to right, whatever the markup says. */
async function expectRowGrammar(page: Page, expected: string[]): Promise<void> {
  const marks = await identityOrder(page);
  expect(marks.map((m) => m.mark), 'the expanded card reversed the compact row’s identity order').toEqual(expected);
  for (let i = 1; i < marks.length; i++) {
    expect(marks[i]!.x, `${marks[i]!.mark} is drawn left of ${marks[i - 1]!.mark}`).toBeGreaterThan(marks[i - 1]!.x);
  }
}

/** The band's labels, lower-cased: this is about readings, not about typography. */
async function bandLabels(page: Page): Promise<string[]> {
  const labels = await page.getByTestId('player-page-metrics').locator('.stat-label').allInnerTexts();
  return labels.map((l) => l.trim().toLowerCase());
}

/** The blocks that left the card, and the vocabulary that was never football. */
async function expectNotAConsole(page: Page): Promise<void> {
  const text = await page.getByTestId('player-page-snapshot').innerText();
  for (const gone of ['News by window', 'Vegas props', 'Categories', 'Draft market']) {
    expect(text, `"${gone}" is back on the expanded card`).not.toContain(gone);
  }
  expect(text, 'the magnitude is back on the card').not.toMatch(/\bmag \d/);
  expect(text, 'the category-debug label is back on the card').not.toContain('uncategorised');
  expect(text).not.toContain('auto_applied');
  expect(text).not.toMatch(/\brule: /);
  expect(text).not.toMatch(/confidence: /);
  await expect(page.getByTestId('player-page-snapshot').getByTestId('player-page-windows')).toHaveCount(0);
}

test.describe('the expanded player, opened from Players', () => {
  /**
   * One card, read end to end: the identity grammar, the whole band, the
   * preseason semantics, the outlook, and the geometry underneath all of it.
   *
   * Andre Sotelo is the player who exercises the most of it at once — a
   * designation, a partial season with a finish, and a published outlook — and
   * the projection is routed in, so this is the card with every cell present.
   */
  test('reads position, club, name, status — then eight readings in one order', async ({ page }) => {
    await patchDetail(page, { preseasonProjection: PROJECTION });
    await page.goto('/');
    await openTab(page, 'players');
    await openPlayer(page, '1004');

    await expectRowGrammar(page, ['position', 'club', 'name', 'status']);

    /*
     * The market pair Players alone can supply, then the readings both screens
     * share. `Moved` is deliberately not among them: it is `ADP` minus `Rank`,
     * printed either side of where it used to sit, and a subtraction the reader
     * can watch being done is not a third reading.
     */
    const labels = await bandLabels(page);
    expect(labels.slice(0, 6)).toEqual(['rank', 'adp', '7d', '21d', 'life', 'pts']);
    expect(labels.slice(6)).toEqual([labels[6]!, labels[7]!]);
    expect(labels[6], 'games played should name its season').toMatch(/^\d{4} gp$/);
    expect(labels[7], 'the finish should name its season').toMatch(/^\d{4} rank$/);
    expect(labels).not.toContain('moved');

    // Last season, promoted out of the `2025` block it used to have to itself.
    await expect(page.getByTestId('metric-last-season-gp').locator('.stat-value')).toHaveText('12');
    await expect(page.getByTestId('metric-last-season-rank').locator('.stat-value')).toHaveText('TE2');

    /*
     * `PTS`, and everywhere it is not three letters it says what it is.
     *
     * The label is an abbreviation because a metric cell on a 360px phone is an
     * abbreviation or it is nothing. Everything else about the cell exists so
     * the abbreviation cannot be read as a live number — and in week nine it is
     * history, where the most expensive kind of wrong is plausible.
     */
    const pts = page.getByTestId('metric-preseason-pts');
    await expect(pts.locator('.stat-label')).toHaveText('PTS');
    await expect(pts.locator('.stat-value')).toHaveText('292');
    await expect(pts.locator('.stat-note')).toContainText('Aug');
    const spoken = (await pts.locator('.sr-only').innerText()).toLowerCase();
    const hint = (await pts.getAttribute('title'))!.toLowerCase();
    expect(spoken).toContain('preseason');
    expect(spoken).toContain('projected season fantasy points');
    expect(hint).toContain('preseason market projection');
    for (const wrong of ['current projection', 'weekly projection', 'vegas says']) {
      expect(hint, `the card says "${wrong}"`).not.toContain(wrong);
      expect(spoken, `the card says "${wrong}"`).not.toContain(wrong);
    }

    // The outlook stays, whole and attributed. It is the one long thing on the
    // card that duplicates nothing, and the pass that removed four blocks is
    // exactly the pass that would take it by accident.
    await expect(page.getByTestId('outlook')).toContainText('via Sleeper');
    await expect(page.getByTestId('player-page-snapshot')).toContainText(/20\d\d Season Outlook/);

    await expectNotAConsole(page);

    /*
     * Nothing in the band is cut off, and reading order follows visual order.
     *
     * A truncated number is worse than no number — it is a value the reader
     * will misread rather than skip — and a grid is the one layout where the
     * spoken order and the painted order can come apart silently, through
     * `order`, `dense` packing or a placed cell.
     */
    const cells = await page.locator('[data-testid="player-page-metrics"] .stat').evaluateAll((els) =>
      els.map((el) => {
        const box = el.getBoundingClientRect();
        const clipped = ['.stat-label', '.stat-value', '.stat-note']
          .map((sel) => el.querySelector(sel) as HTMLElement | null)
          .filter((c): c is HTMLElement => c != null)
          .filter((c) => c.scrollWidth > c.clientWidth + 1)
          .map((c) => c.textContent ?? '');
        return { top: Math.round(box.top), left: Math.round(box.left), clipped };
      }),
    );
    expect(cells.length).toBe(8);
    expect(cells.flatMap((c) => c.clipped), 'these are cut off in the band').toEqual([]);
    for (let i = 1; i < cells.length; i++) {
      const back = cells[i - 1]!;
      const here = cells[i]!;
      const forwards = here.top > back.top || (here.top === back.top && here.left > back.left);
      expect(forwards, `cell ${i} is painted before the one in front of it`).toBe(true);
    }
    expect(await pageOverflow(page)).toBeLessThanOrEqual(1);
  });

  /**
   * Honest absence, three ways, on the two players who have it.
   *
   * Marcus Vance is healthy and no snapshot covers him; Bo Ashworth's season was
   * looked up and he did not appear in it, and nobody has written about him.
   * None of that may become a zero, and none of it may become a heading over an
   * apology.
   */
  test('leaves out what it does not know rather than printing a nothing', async ({ page }) => {
    await page.goto('/');
    await openTab(page, 'players');

    await openPlayer(page, '1001');
    await expect(page.getByTestId('metric-preseason-pts'), 'a dash under PTS is a promise the number exists').toHaveCount(0);
    expect(await bandLabels(page)).not.toContain('pts');
    await expect(page.locator('.sheet-player-title [data-testid="injury-tag"]')).toHaveCount(0);
    await page.keyboard.press('Escape');

    /*
     * Sleeper will happily report a player who never took a snap as the 1,240th
     * of his position. That is his place in a directory, not a finish.
     */
    await openPlayer(page, '1012');
    await expect(page.getByTestId('metric-last-season-gp').locator('.stat-value')).toHaveText('—');
    await expect(page.getByTestId('metric-last-season-rank').locator('.stat-value')).toHaveText('—');
    const snapshot = page.getByTestId('player-page-snapshot');
    await expect(snapshot.getByTestId('evidence-heading'), 'a heading spent saying no heading was needed').toHaveCount(0);
    await expect(snapshot.getByTestId('evidence-item')).toHaveCount(0);
  });

  /**
   * Nothing ingested at all is a different answer from a season he missed: no
   * cells, rather than two dashes promising numbers that were never stored.
   */
  test('draws no last-season cells when the statistics were never ingested', async ({ page }) => {
    await patchDetail(page, { lastSeason: null });
    await page.goto('/');
    await openTab(page, 'players');
    await openPlayer(page, '1004');
    await expect(page.getByTestId('metric-last-season-gp')).toHaveCount(0);
    await expect(page.getByTestId('metric-last-season-rank')).toHaveCount(0);
    // …and the band is still a band, with the readings that do exist on it.
    expect(await bandLabels(page)).toEqual(['rank', 'adp', '7d', '21d', 'life']);
  });

  /**
   * A long name yields before anything to the right of it does.
   *
   * The failure this guards is the one that only appears with a hyphenated name
   * and a status: the name pushes the tag off the sheet, or the header grows a
   * second line and the card loses a row to its own title. It found a real one —
   * `.sheet-title` had `flex: 1` and no `min-width: 0`, so nothing in the chain
   * below it was allowed to shrink.
   */
  test('truncates a long name rather than pushing the status off the sheet', async ({ page }) => {
    await page.route('**/api/players?*', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const players = body.players.map((p: { id: string; name: string; status: string | null }) =>
        p.id === '1001' ? { ...p, name: 'Bartholomew Vandersteen-Okonkwo III', status: 'Questionable' } : p,
      );
      await route.fulfill({ response, body: JSON.stringify({ ...body, players }) });
    });
    await page.goto('/');
    await openTab(page, 'players');
    await openPlayer(page, '1001');

    const title = (await page.locator('.sheet-player-title').boundingBox())!;
    const sheet = (await page.locator('.sheet').boundingBox())!;
    const tag = (await page.locator('.sheet-player-title [data-testid="injury-tag"]').boundingBox())!;

    expect(tag.x + tag.width, 'the status pill is clipped by the sheet').toBeLessThanOrEqual(sheet.x + sheet.width + 1);
    expect(title.height, `the header wrapped to ${title.height}px`).toBeLessThanOrEqual(40);
    const shortened = await page.locator('.sheet-player-name').evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(shortened, 'the name was not truncated, so something else must have moved').toBe(true);
    expect(await pageOverflow(page)).toBeLessThanOrEqual(1);
  });

  /**
   * The news is football, and it is the ledger's own words.
   *
   * A polished card is the easiest place in an app to start inventing a
   * cleaner-sounding fact than the evidence supports, so the sentence on screen
   * is read back against what the API actually stores. The source name is
   * checked the other way: the demo world has one newsletter, and a name
   * repeated down every line qualifies nothing.
   */
  test('says what happened to him, in words the ledger stores', async ({ page }) => {
    await page.goto('/');
    await openTab(page, 'players');
    await openPlayer(page, '1002');
    await expectNotAConsole(page);

    const item = page.getByTestId('player-page-snapshot').getByTestId('evidence-item').first();
    await expect(item).toBeVisible();
    const shown = await item.locator('.player-news-text').evaluate((el) => {
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

    const sources: string[] = [
      ...new Set(file.evidence.map((e: { sourceName: string }) => e.sourceName as string)),
    ] as string[];
    const line = await item.innerText();
    if (sources.length === 1) expect(line, 'a source that never varies is a repeated word').not.toContain(sources[0]!);
    else expect(line).toContain(sources[0]!);
  });

  /**
   * Nothing was deleted, only moved — the other half of the removals above.
   *
   * Without this the four blocks that left the card would be losses rather than
   * relocations: the four-window breakdown with its item counts, the draft
   * market with its movement badge, the categories and the prop table are all
   * still rendered on the player's own page, and so is the whole evidence
   * console, which is where the app's provenance promise actually lives.
   */
  test('keeps every removed block, and the console, on the full profile', async ({ page }) => {
    await page.goto('/');
    await openTab(page, 'players');
    await openPlayer(page, '1002');
    await page.getByTestId('player-full-profile').click();
    await expect(page.getByTestId('player-page')).toBeVisible();

    await expect(page.getByTestId('player-page-windows')).toBeVisible();
    const sections = page.getByTestId('player-page-sections');
    await sections.getByRole('button', { name: 'Market' }).click();
    await expect(page.getByText('Draft market')).toBeVisible();
    await expect(page.getByText(/Vegas props/)).toBeVisible();

    await sections.getByRole('button', { name: 'Evidence' }).click();
    const ledger = page.getByTestId('player-page-evidence');
    await expect(ledger.getByTestId('evidence-item').first()).toBeVisible();
    await expect(ledger).toContainText(/mag \d/);
    await expect(ledger).toContainText(/confidence: /);
  });
});

test.describe('the same expanded player, opened from Trades', () => {
  /**
   * The same grammar, the same readings in the same order, the same card.
   *
   * Players adds the two columns it alone knows in front of the shared six;
   * everything after that has to match, or a reader who learned the card on one
   * screen has to learn it again on the other. Both surfaces are opened in one
   * test because comparing them is the assertion.
   */
  test('reads the same way, in the same order, minus the two Players alone has', async ({ page }) => {
    await patchDetail(page, { preseasonProjection: PROJECTION });
    await page.goto('/');
    await openTab(page, 'players');
    await openPlayer(page, '1002');
    const fromPlayers = await bandLabels(page);
    await page.keyboard.press('Escape');

    await openTab(page, 'trades');
    await page.locator('[data-testid="trade-row"]', { hasText: 'Devin Okafor' }).first().click();
    await expect(page.getByTestId('player-sheet')).toBeVisible();
    await expect(page.getByTestId('metric-preseason-pts')).toBeVisible();

    await expectRowGrammar(page, ['position', 'club', 'name']);
    const fromTrades = await bandLabels(page);
    expect(fromTrades.slice(0, 4)).toEqual(['7d', '21d', 'life', 'pts']);
    expect(fromPlayers.slice(0, 2)).toEqual(['rank', 'adp']);
    expect(fromPlayers.slice(2), 'the two surfaces have drifted apart again').toEqual(fromTrades);

    await expectNotAConsole(page);
    // The trade case is Trades' own, and it stays.
    await expect(page.getByTestId('trade-case')).toContainText('Why');
    expect(await pageOverflow(page)).toBeLessThanOrEqual(1);
  });

  /**
   * The tag appears on Trades, which never had one to pass.
   *
   * Players hands over Sleeper's own `status` with the row. A trade suggestion
   * carries a trade-shaped injury category and no designation, so the same
   * player showed `OUT` on one screen and nothing on the other. The detail
   * payload both screens already fetch is the fallback.
   *
   * The designation is forced onto that response rather than found on the
   * board: which players the demo world suggests is the trade engine's business
   * and is deliberately not this file's to depend on.
   */
  test('carries the availability pill, and says only what the pill cannot', async ({ page }) => {
    await patchDetail(page, {
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
    });
    await page.goto('/');
    await openTab(page, 'trades');
    await openFirstTrade(page);

    const tag = page.locator('.sheet-player-title [data-testid="injury-tag"]');
    await expect(tag).toHaveAttribute('data-status', 'OUT');
    // The meaning, not just the letters, for anyone listening rather than looking.
    await expect(tag).toHaveAttribute('aria-label', 'Out');
    await expectRowGrammar(page, ['position', 'club', 'name', 'status']);

    const injury = page.getByTestId('injury-current');
    await expect(injury).toContainText('hamstring');
    await expect(injury, 'the designation is on the card twice').not.toContainText('OUT');
  });
});

test.describe('the pass changed no recommendation', () => {
  /**
   * Both lists are their API's answer, in their API's order.
   *
   * Presentation work is exactly the kind that can quietly re-sort a list — a
   * `map` that became a `sort`, a memo keyed on the wrong thing — and neither
   * ranking is this workstream's to touch. For Trades that includes which
   * section a suggestion landed in, because Trade Target versus Emerging is a
   * classification rather than an ordering.
   */
  test('renders Players and the trade board exactly as their APIs returned them', async ({ page }) => {
    await page.goto('/');
    await openTab(page, 'players');
    await expect(page.getByTestId('player-search-row').first()).toBeVisible();
    const listed = await page
      .getByTestId('player-search-row')
      .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-player-id')));
    const ranked = await page.evaluate(async () => {
      const res = await (await fetch('/api/players?q=&limit=100&offset=0')).json();
      return res.players.map((p: { id: string }) => p.id);
    });
    expect(listed).toEqual(ranked.slice(0, listed.length));

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

  /**
   * And neither card can scroll sideways, anywhere down it, at any width.
   *
   * Scrolled rather than measured once at the top: the band, the trade case,
   * the outlook and the news each have their own chance to overflow, and only
   * one of them is on screen when the sheet opens.
   */
  test('never scrolls sideways anywhere down either card', async ({ page }) => {
    await patchDetail(page, { preseasonProjection: PROJECTION });
    await page.goto('/');

    for (const surface of ['players', 'trades'] as const) {
      await openTab(page, surface);
      if (surface === 'players') await openPlayer(page, '1004');
      else await openFirstTrade(page);

      const body = page.locator('.sheet-body');
      const height = await body.evaluate((el) => el.scrollHeight);
      for (let top = 0; top <= height; top += 240) {
        await body.evaluate((el, y) => el.scrollTo({ top: y }), top);
        const overflow = await pageOverflow(page);
        expect(overflow, `the ${surface} card overflows by ${overflow}px at ${top}px down`).toBeLessThanOrEqual(1);
      }
      await page.keyboard.press('Escape');
    }
  });
});
