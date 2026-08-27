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
 * ---------------------------------------------------------------------------
 * **Six tests, six page loads, and that is a budget rather than a style.**
 *
 * `e2e/` runs inside a twenty-minute step ceiling per width, and main already
 * spends up to eighteen and a half of them; the 430 width has been cancelled
 * mid-suite twice with nothing failing. Every `page.goto('/')` re-boots the
 * single-page app, so a file of one-assertion tests is most of a minute of a
 * budget with none to give. This file therefore opens a card once and reads
 * everything true of *that* card, and the assertion messages carry the claim
 * that a test name would otherwise have carried.
 *
 * If you add to it, add an assertion to an existing test rather than a test.
 * ---------------------------------------------------------------------------
 *
 * What it does not touch: which players Players lists and in which order, and
 * which section of Trades a suggestion lands in with what confidence. Both are
 * asserted below to be exactly the order the API sent, because the whole promise
 * of a presentation pass is that it changed no recommendation.
 */

import { expect, test, type Page } from '@playwright/test';
import { exploreMarket } from './helpers.ts';

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
  // The board is behind `Explore the market` — see `exploreMarket`.
  await exploreMarket(page);
  await page.getByTestId('trade-row').first().click();
  await expect(page.getByTestId('player-sheet')).toBeVisible();
  await expect(page.getByTestId('player-page-metrics')).toBeVisible();
}

async function pageOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/**
 * The face, then the name, then what qualifies him under it — read as geometry.
 *
 * This asserted one line for as long as the header was one line: position,
 * club, name, status, painted left to right whatever the markup said. It is
 * now two lines beside a 64px portrait, and the reason is measured rather than
 * aesthetic — a face on the single line truncated nineteen of twenty-two seed
 * names at 360px, `Julian Reyes` down to `Julian…`. See the note in
 * `PlayerSheet`.
 *
 * What is being defended did not change, so this still reads paint order
 * rather than DOM order — a card can put the pill first in the markup and
 * float it anywhere:
 *
 *  1. **the portrait leads the whole block.** Everything that says *who* is on
 *     the leading side, and a face is the most immediate `who` there is.
 *  2. **the name is the heading**, on its own line above the marks, which is
 *     what makes it the largest thing in the header rather than one of four
 *     things sharing a line with it.
 *  3. **the marks under it keep the row's order** — pill, club, status — so a
 *     reader who has just been scanning a list is not asked to re-learn the
 *     sequence at the moment they commit to one player.
 *
 * The one-line rule this replaced still holds everywhere it was written for:
 * `e2e/row-alignment.spec.ts` holds Draft, Players, Trades and Waivers to
 * pill → club → name across a single line, which is what makes forty names
 * start on one column. A header has one name in it.
 */
async function expectRowGrammar(page: Page, expected: string[]): Promise<void> {
  const marks = await page.locator('.sheet-player-title').evaluate((title) => {
    const pick = (sel: string, mark: string) => {
      const el = title.querySelector(sel) as HTMLElement | null;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { mark, x: r.left, top: r.top, bottom: r.bottom };
    };
    return {
      face: pick('[data-testid="sheet-player-face"]', 'face'),
      name: pick('.sheet-player-name', 'name'),
      quals: [
        pick('.pos-pill', 'position'),
        pick('.team-logo, .team-code', 'club'),
        pick('[data-testid="injury-tag"]', 'status'),
      ].filter((p): p is { mark: string; x: number; top: number; bottom: number } => p != null),
    };
  });

  expect(marks.face, 'the expanded card is not drawing a portrait at all').not.toBeNull();
  expect(marks.name, 'the expanded card is not drawing a name').not.toBeNull();

  // 1. The portrait leads everything.
  expect(marks.face!.x, 'the portrait is not the leading mark in the header').toBeLessThan(marks.name!.x);
  for (const q of marks.quals) {
    expect(marks.face!.x, `${q.mark} is drawn left of the portrait`).toBeLessThan(q.x);
  }

  // 2. The name is a line above the marks that qualify it, not beside them.
  for (const q of marks.quals) {
    expect(q.top, `${q.mark} is back on the name's own line`).toBeGreaterThanOrEqual(marks.name!.bottom - 1);
  }

  // 3. And those marks keep the row's order, left to right, on their own line.
  const qualOrder = expected.filter((m) => m !== 'name');
  expect(
    marks.quals.map((m) => m.mark),
    'the expanded card reordered the marks that qualify the name',
  ).toEqual(qualOrder);
  for (let i = 1; i < marks.quals.length; i++) {
    expect(marks.quals[i]!.x, `${marks.quals[i]!.mark} is drawn left of ${marks.quals[i - 1]!.mark}`).toBeGreaterThan(
      marks.quals[i - 1]!.x,
    );
  }
}

/**
 * One modal, announced as the player whose card it is.
 *
 * The four marks above are why this needs asserting rather than assuming. A
 * sheet takes its accessible name from its visible title, and this title is
 * that cluster — not a string — so the card claimed `role="dialog"` and
 * `aria-modal` with no name at all: a reader listening to the app was put
 * inside a modal without being told whose. Read through the role and the name
 * rather than through the attribute, because what is being checked is what
 * assistive technology computes, not which attribute happens to supply it.
 *
 * The expected name is taken from the visible name on the card, so the
 * assertion cannot drift from the fixture, and it fails just as loudly if the
 * name ever grows the pill, the club or the status back into it: a dialog's
 * name is what has opened, not a summary of what is in it.
 */
async function expectNamedDialog(page: Page): Promise<void> {
  const name = (await page.locator('.sheet-player-name').innerText()).trim();
  expect(name, 'the card should be showing a player name to be named after').not.toBe('');

  const dialogs = page.getByRole('dialog');
  await expect(dialogs, 'a player card should be exactly one modal dialog').toHaveCount(1);
  await expect(page.getByRole('dialog', { name }), `the modal is not announced as "${name}"`).toBeVisible();

  // And still the dialog the reader was put *into*, rather than a named one beside it.
  await expect(page.getByTestId('player-sheet')).toHaveAttribute('aria-modal', 'true');
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const el = document.activeElement;
          return el === null ? false : el.closest('[data-testid="player-sheet"]') !== null;
        }),
      { message: 'focus never entered the named sheet' },
    )
    .toBe(true);
}

/** The band's labels, lower-cased: this is about readings, not about typography. */
async function bandLabels(page: Page): Promise<string[]> {
  const labels = await page.getByTestId('player-page-metrics').locator('.stat-label').allInnerTexts();
  return labels.map((l) => l.trim().toLowerCase());
}

/**
 * The blocks that left the card, and the vocabulary that was never football.
 *
 * `News by window` repeated the tally windows now in the band; `2025` was a
 * heading over two numbers now in the band; `Draft market` printed a rank, an
 * ADP and their difference; `Categories` restated the tally by category. `mag`,
 * the review status, the rule id and the confidence score are all real and all
 * about the classifier — they belong under Evidence, which this file opens
 * separately to check they are still there.
 */
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

/**
 * Nowhere down the card can it scroll sideways.
 *
 * Walked rather than measured once at the top: the band, the trade case, the
 * outlook and the news each get their own chance to overflow, and only one of
 * them is on screen when the sheet opens.
 */
async function expectNoSidewaysScroll(page: Page, what: string): Promise<void> {
  const body = page.locator('.sheet-body');
  const height = await body.evaluate((el) => el.scrollHeight);
  for (let top = 0; top <= height; top += 240) {
    await body.evaluate((el, y) => el.scrollTo({ top: y }), top);
    const overflow = await pageOverflow(page);
    expect(overflow, `the ${what} card overflows by ${overflow}px at ${top}px down`).toBeLessThanOrEqual(1);
  }
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
  test('reads face, name, then position, club, status — then eight readings in one order', async ({ page }) => {
    await patchDetail(page, { preseasonProjection: PROJECTION });
    await page.goto('/');
    await openTab(page, 'players');
    await openPlayer(page, '1004');

    await expectRowGrammar(page, ['position', 'club', 'name', 'status']);
    await expectNamedDialog(page);

    /*
     * The market pair Players alone can supply, then the readings both screens
     * share. `Moved` is deliberately not among them: it is `ADP` minus `Rank`,
     * printed either side of where it used to sit, and a subtraction the reader
     * can watch being done is not a third reading.
     */
    const labels = await bandLabels(page);
    expect(labels.slice(0, 6)).toEqual(['rank', 'adp', '7d', '30d', 'life', 'pts']);
    expect(labels[6], 'games played should name its season').toMatch(/^\d{4} gp$/);
    expect(labels[7], 'the finish should name its season').toMatch(/^\d{4} rank$/);
    expect(labels).toHaveLength(8);
    expect(labels).not.toContain('moved');

    // Last season, promoted out of the `2025` block it used to have to itself.
    await expect(page.getByTestId('metric-last-season-gp').locator('.stat-value')).toHaveText('12');
    await expect(page.getByTestId('metric-last-season-rank').locator('.stat-value')).toHaveText('TE2');

    /*
     * `PTS`, and everywhere it is not three letters it says what it is.
     *
     * The label is an abbreviation because a metric cell on a 360px phone is an
     * abbreviation or it is nothing. Everything else about the cell exists so
     * the abbreviation cannot be read as a live number — in week nine it is
     * history, and the most expensive kind of wrong is plausible.
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
    expect(cells).toHaveLength(8);
    expect(cells.flatMap((c) => c.clipped), 'these are cut off in the band').toEqual([]);
    for (let i = 1; i < cells.length; i++) {
      const back = cells[i - 1]!;
      const here = cells[i]!;
      const forwards = here.top > back.top || (here.top === back.top && here.left > back.left);
      expect(forwards, `cell ${i} is painted before the one in front of it`).toBe(true);
    }

    await expectNoSidewaysScroll(page, 'players');
  });

  /**
   * Honest absence, three ways, on the two players who have it.
   *
   * Marcus Vance is healthy and no snapshot covers him; Bo Ashworth's season
   * was looked up and he did not appear in it, and nobody has written about
   * him. None of that may become a zero, and none of it may become a heading
   * over an apology.
   */
  test('leaves out what it does not know rather than printing a nothing', async ({ page }) => {
    await page.goto('/');
    await openTab(page, 'players');

    await openPlayer(page, '1001');
    await expect(
      page.getByTestId('metric-preseason-pts'),
      'a dash under PTS is a promise the number exists somewhere',
    ).toHaveCount(0);
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
    await expect(
      snapshot.getByTestId('evidence-heading'),
      'a heading spent saying that a heading was not needed',
    ).toHaveCount(0);
    await expect(snapshot.getByTestId('evidence-item')).toHaveCount(0);
  });

  /**
   * A long name yields before anything to the right of it does — and a
   * deployment that never ingested last season draws no cells for it.
   *
   * Two failures that want the same page load, because both are answered by
   * rewriting a response before the app boots. The first found a real defect:
   * `.sheet-title` had `flex: 1` and no `min-width: 0`, so nothing in the chain
   * below it was allowed to shrink and the status pill went off the sheet.
   *
   * "Never ingested" is a different answer from "he missed the season": no
   * cells, rather than two dashes promising numbers that were never stored.
   */
  test('truncates a long name, and draws no cells for a season nobody stored', async ({ page }) => {
    await patchDetail(page, { lastSeason: null });
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
    /*
      The header is as tall as the portrait and never taller.

      This read `<= 40` while the header was one line of type. It is two lines
      beside a 64px face now, and the number moved with the layout rather than
      the guard: what is being caught is a header that *grows with the name* —
      a name that wraps to three lines, or a qualifier line that pushes onto a
      second one — and the face fixes the height at 64 unless something does
      exactly that. A name this long must still shorten rather than reflow, and
      the assertion under this one is what says so.
    */
    expect(title.height, `the header grew to ${title.height}px`).toBeLessThanOrEqual(64.5);
    const shortened = await page.locator('.sheet-player-name').evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(shortened, 'the name was not truncated, so something else must have moved').toBe(true);
    expect(await pageOverflow(page)).toBeLessThanOrEqual(1);

    await expect(page.getByTestId('metric-last-season-gp')).toHaveCount(0);
    await expect(page.getByTestId('metric-last-season-rank')).toHaveCount(0);
    // …and the band is still a band, with the readings that do exist on it.
    expect(await bandLabels(page)).toEqual(['rank', 'adp', '7d', '30d', 'life']);
  });

  /**
   * The news is football and it is the ledger's own words — and everything the
   * card stopped showing is still one tap further in.
   *
   * Two halves of one claim, so they share a page load. A polished card is the
   * easiest place in an app to start inventing a cleaner-sounding fact than the
   * evidence supports, so the sentence on screen is read back against what the
   * API actually stores. And the four blocks that left the card would be losses
   * rather than relocations without the second half: the window breakdown, the
   * draft market, the categories, the prop table and the whole evidence console
   * are all still rendered on the player's own page.
   */
  test('says what happened to him in the ledger’s words, and keeps the rest one tap in', async ({ page }) => {
    await page.goto('/');
    await openTab(page, 'players');
    await openPlayer(page, '1002');
    await expectNotAConsole(page);

    /*
     * The sentence the card leads with, wherever it is drawn.
     *
     * A player whose ledger supports one gets a `Newsletter takeaway`, chosen
     * out of the ledger rather than written, and `Latest news` then carries
     * what the takeaway did not — which for a player with a single applied item
     * is nothing at all. Both blocks quote and neither composes, so the check
     * is the same either way: whatever is on screen has to be a run of words
     * the API actually stores.
     */
    const snapshot = page.getByTestId('player-page-snapshot');
    const takeaway = snapshot.getByTestId('newsletter-takeaway');
    const item = snapshot.getByTestId('evidence-item').first();
    /*
     * The takeaway is one element whose sentence is followed by its
     * attribution; a news item is a sentence and a date on two lines. Each is
     * narrowed to the part that is meant to be the newsletter's own words
     * before anything is compared, rather than stripped by class from the whole
     * block — a date left in the string would fail this against the API and
     * send the next reader looking for a bug in the card.
     */
    const leading = (await takeaway.count()) > 0 ? takeaway : item.locator('.player-news-text');
    await expect(leading).toBeVisible();
    const shown = await leading.evaluate((el) => {
      // The polarity mark, the attribution and the word beside it for assistive
      // technology are the card's own furniture; what is checked is the
      // sentence they surround.
      const clone = el.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('.player-news-mark, .sr-only, .faint').forEach((n) => n.remove());
      return (clone.textContent ?? '').replace(/\s+/g, ' ').replace(/^“|”$/g, '').trim();
    });
    expect(shown, 'the card rendered no sentence at all').not.toBe('');

    const file = await page.evaluate(async () => (await fetch('/api/players/1002')).json());
    const stored = file.evidence
      .flatMap((e: { userOverride?: { note?: string }; contextSummary: string | null; excerpt: string }) => [
        e.userOverride?.note,
        e.contextSummary,
        e.excerpt,
      ])
      .filter((s: string | null | undefined) => !!s)
      .map((s: string) => s.replace(/\s+/g, ' ').trim());
    expect(stored, `"${shown}" is in none of the stored words for this player`).toContain(shown);

    /*
     * The newsletter is not read out twice.
     *
     * The takeaway is chosen from this same ledger, so before this a card with
     * one applied item printed it at the top and again four lines down under
     * `Latest news`, word for word with a date under it. What the takeaway
     * quotes is dropped from that list; the item itself is untouched, still
     * counted, and still in the Evidence timeline one tap in — asserted at the
     * end of this test.
     */
    if ((await takeaway.count()) > 0) {
      const quotedText = shown;
      const news = await snapshot.getByTestId('evidence-item').allInnerTexts();
      for (const line of news) {
        expect(line, 'Latest news repeated the sentence the takeaway had already lifted').not.toContain(quotedText);
      }
    }

    /*
     * The source is printed when it varies and omitted when it cannot. The demo
     * world has one newsletter, and a name repeated down every line qualifies
     * nothing while costing each line the room to say something.
     */
    const sources: string[] = [
      ...new Set(file.evidence.map((e: { sourceName: string }) => e.sourceName as string)),
    ] as string[];
    if ((await item.count()) > 0) {
      const line = await item.innerText();
      if (sources.length === 1) expect(line, 'a source that never varies is a repeated word').not.toContain(sources[0]!);
      else expect(line).toContain(sources[0]!);
    }

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
   * test because comparing them *is* the assertion.
   */
  test('reads the same way, in the same order, minus the two Players alone has', async ({ page }) => {
    await patchDetail(page, { preseasonProjection: PROJECTION });
    await page.goto('/');
    await openTab(page, 'players');
    await openPlayer(page, '1002');
    const fromPlayers = await bandLabels(page);
    await page.keyboard.press('Escape');

    await openTab(page, 'trades');
    await exploreMarket(page);
    await page.locator('[data-testid="trade-row"]', { hasText: 'Devin Okafor' }).first().click();
    await expect(page.getByTestId('player-sheet')).toBeVisible();
    await expect(page.getByTestId('metric-preseason-pts')).toBeVisible();

    await expectRowGrammar(page, ['position', 'club', 'name']);
    const fromTrades = await bandLabels(page);
    expect(fromTrades.slice(0, 4)).toEqual(['7d', '30d', 'life', 'pts']);
    expect(fromPlayers.slice(0, 2)).toEqual(['rank', 'adp']);
    expect(fromPlayers.slice(2), 'the two surfaces have drifted apart again').toEqual(fromTrades);

    await expectNotAConsole(page);
    // The trade case is Trades' own advisory content, and it stays.
    await expect(page.getByTestId('trade-case')).toContainText('Why');
    await expectNoSidewaysScroll(page, 'trades');
  });

  /**
   * One name per number, across the two screens that share it.
   *
   * Players' row said `21d` and Trades' said `30d` for the same field — and one
   * of the two was simply false: `RECENCY_WINDOWS.last30` has been thirty days
   * since the window was widened, and the label never followed. `Life` had the
   * same problem in the other direction, spelled out as `Lifetime` in the
   * window grid a few hundred pixels under a band that called it `Life`.
   *
   * Asserted as vocabulary rather than as arithmetic, because the arithmetic
   * did not change: `tests/evidence.test.ts` owns what the window counts, and
   * this owns what it is called.
   */
  test('calls the same window the same thing on Players and on Trades', async ({ page }) => {
    await page.goto('/');
    await openTab(page, 'players');
    const row = page.getByTestId('player-search-row').first();
    await expect(row).toBeVisible();
    await expect(row).toContainText('30d');
    await expect(row, 'the stale twenty-one-day label is back').not.toContainText('21d');

    await openTab(page, 'trades');
    await exploreMarket(page);
    const trade = page.getByTestId('trade-row').first();
    await expect(trade).toBeVisible();
    await expect(trade).toContainText('30d');
    await expect(trade).toContainText('Life');

    // And the page behind either of them names its windows the same way.
    await trade.click();
    await expect(page.getByTestId('player-sheet')).toBeVisible();
    await page.getByTestId('player-full-profile').click();
    const windows = page.getByTestId('player-page-windows');
    await expect(windows).toBeVisible();
    // Lower-cased on the way out: the stylesheet upper-cases these, and the
    // claim is the vocabulary rather than the type treatment.
    const labels = await windows.locator('.window-label').allInnerTexts();
    expect(labels.map((l) => l.trim().toLowerCase())).toEqual(['7d', '30d', 'season', 'life']);
  });

  /**
   * The pill appears on Trades, which never had one to pass — and both lists
   * are still exactly their API's answer.
   *
   * Players hands over Sleeper's own `status` with the row. A trade suggestion
   * carries a trade-shaped injury category and no designation, so the same
   * player showed `OUT` on one screen and nothing on the other; the detail
   * payload both screens already fetch is the fallback. The designation is
   * forced onto that response rather than found on the board, because which
   * players the demo world suggests is the trade engine's business and is
   * deliberately not this file's to depend on.
   *
   * The ordering assertions ride along on the same page load. Presentation work
   * is exactly the kind that can quietly re-sort a list — a `map` that became a
   * `sort`, a memo keyed on the wrong thing — and neither ranking is this
   * workstream's to touch. For Trades that includes which section a suggestion
   * landed in, because Trade Target versus Emerging is a classification rather
   * than an ordering.
   */
  test('carries the availability pill, over a board still in the API’s own order', async ({ page }) => {
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

    await openTab(page, 'players');
    await expect(page.getByTestId('player-search-row').first()).toBeVisible();
    const listed = await page
      .getByTestId('player-search-row')
      .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-player-id')));
    const ranked = await page.evaluate(async () => {
      const res = await (await fetch('/api/players?q=&limit=100&offset=0')).json();
      return res.players.map((p: { id: string }) => p.id);
    });
    expect(listed, 'Players is no longer the order its API returned').toEqual(ranked.slice(0, listed.length));

    await openTab(page, 'trades');
    await exploreMarket(page);
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
    expect(onScreen, 'a suggestion moved section or place').toEqual(fromApi);

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
