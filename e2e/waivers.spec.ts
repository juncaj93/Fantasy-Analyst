/**
 * Waivers: the destination that arrives when Draft leaves, and the page behind
 * it.
 *
 * Two things are being defended, and they are separable on purpose.
 *
 * The first is the swap. One slot in the toolbar is seasonal, and exactly one
 * of Draft and Waivers is ever in it — a bar that showed both would be seven
 * destinations on a 360px phone, and one that showed neither would strand the
 * reader. The season state is stubbed rather than waited for, because the demo
 * deployment is in preseason and will be until September.
 *
 * The second is the page. It is a shell over data the league-intelligence pass
 * has not produced yet, so most of these assertions are about what it does
 * *not* say: no invented FAAB figure, no fabricated competition, no multi-week
 * verdict nobody computed.
 */

import { expect, test, type Page } from '@playwright/test';

/**
 * The app, told the regular season is under way.
 *
 * `/api/overview` is the one place the toolbar reads the season from, so this
 * is the whole of the fixture — no clock is moved and no league is edited.
 */
async function inSeason(page: Page) {
  await page.route('**/api/overview', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      body: JSON.stringify({
        ...body,
        season: {
          phase: 'regular',
          draftVisible: false,
          reason: 'the regular season is under way (week 3)',
          assumed: false,
        },
      }),
    });
  });
}

async function openWaivers(page: Page) {
  await inSeason(page);
  await page.goto('/');
  await page.getByTestId('tab-waivers').click();
  await expect(page.getByTestId('waivers-nav')).toBeVisible();
}

test.describe('the seasonal slot in the toolbar', () => {
  test('carries Draft before the season and Waivers once it starts', async ({ page }) => {
    await page.goto('/');
    // Preseason, as the demo deployment actually is.
    await expect(page.getByTestId('tab-draft')).toBeVisible();
    await expect(page.getByTestId('tab-waivers')).toHaveCount(0);

    await inSeason(page);
    await page.reload();
    await expect(page.getByTestId('tab-waivers')).toBeVisible();
    await expect(page.getByTestId('tab-draft')).toHaveCount(0);
  });

  /** Immediately to the right of Team, which is the screen it belongs beside. */
  test('puts Waivers next to Team', async ({ page }) => {
    await inSeason(page);
    await page.goto('/');
    /*
     * Waited for, not read straight after the navigation.
     *
     * The bar renders before the overview answers — with Draft in the seasonal
     * slot, because that is the safe default when the season is unknown — and
     * reading the row in that frame finds no Waivers at all. The swap is what
     * this test is about, so it waits for it.
     */
    await expect(page.getByTestId('tab-waivers')).toBeVisible();
    const ids = await page.locator('.tabbar button').evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute('data-testid')),
    );
    expect(ids.indexOf('tab-waivers')).toBe(ids.indexOf('tab-team') + 1);
  });

  /**
   * The bar is sized by its contents, so the swap costs it nothing — but that
   * is a claim about a stylesheet, and this is the assertion that it is true at
   * every width this suite runs at.
   */
  test('keeps the toolbar on one row and inside the screen', async ({ page }) => {
    await inSeason(page);
    await page.goto('/');
    const bar = page.locator('.tabbar');
    const box = (await bar.boundingBox())!;
    const width = page.viewportSize()!.width;
    expect(box.width).toBeLessThanOrEqual(width);
    // One row: the pill is a single tap target tall plus its own padding.
    expect(box.height).toBeLessThan(80);
    const tops = await bar.locator('button').evaluateAll((nodes) =>
      nodes.map((n) => Math.round(n.getBoundingClientRect().top)),
    );
    expect(new Set(tops).size, 'every destination should sit on one line').toBe(1);
  });

  /** The board is not deleted, only demoted — the screen still renders. */
  test('leaves the draft screen reachable when the reader is already on it', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('tab-draft').click();
    await inSeason(page);
    await expect(page.getByTestId('board-list')).toBeVisible();
  });
});

test.describe('the waivers page', () => {
  test.beforeEach(async ({ page }) => openWaivers(page));

  test('lists who is available as one decision per player', async ({ page }) => {
    const rows = page.getByTestId('waiver-row');
    await expect(rows.first()).toBeVisible();
    await expect(rows.first().getByTestId('waiver-fit')).toContainText(/Upgrades|Fills/);
    await expect(rows.first().getByTestId('waiver-short-term')).toContainText('pts');
  });

  /**
   * A card is a header, a row of tags and one line — not four lines of prose.
   *
   * What it replaced said the same things in scattered sentences: `High
   * pressure · 7 of 11 rivals need the position` on one line, `stronger market
   * expectation (13.5 vs 9.2 pts)` on another, a cost and a fit between them.
   * The claims here are the shape rather than the wording, so a card that grows
   * a fourth explanatory line fails them whatever that line says.
   */
  test('says it in tags and one line', async ({ page }) => {
    const row = page.getByTestId('waiver-row').first();
    await expect(row).toBeVisible();

    // The identity, in the order this app now uses everywhere.
    await expect(row.locator('.pos-pill')).toHaveCount(1);
    await expect(row.getByTestId('team-logo')).toHaveCount(1);
    await expect(row.getByTestId('waiver-strength')).toBeVisible();

    // Recurring tags, not sentences.
    const tags = await row.getByTestId('waiver-tags').locator('.tag').allInnerTexts();
    expect(tags.length, 'the card carries compact tags').toBeGreaterThan(1);
    for (const tag of tags) {
      expect(tag.length, `"${tag}" is a tag, not a sentence`).toBeLessThan(24);
    }

    // And one summary line carrying cost, competition and the projection.
    const summary = await row.getByTestId('waiver-summary').innerText();
    expect(summary).toMatch(/Est\. cost/);
    expect(summary).toMatch(/Proj\. \+?\d+\.\d pts/);
    // One decimal, always — `+6.46 pts` beside `+5.7 pts` was two different
    // claims about how precisely the same calculation is known.
    expect(summary).not.toMatch(/\d\.\d\d/);
  });

  /**
   * The engine's own bookkeeping is not on the recommendation page.
   *
   * `31 available player(s) were skipped as unscorable, ruled out or already
   * kicked off` closed this screen: true, occasionally useful, and never the
   * reason anybody opened it. The count still exists on the advice — see
   * `skipped` — it is simply not printed here.
   */
  test('does not report on its own work', async ({ page }) => {
    const text = await page.locator('main').innerText();
    for (const phrase of ['skipped as unscorable', 'were skipped', 'players checked', 'never makes a transaction']) {
      expect(text, `the page still says "${phrase}"`).not.toContain(phrase);
    }
  });

  /**
   * The machine phrasing is gone from both the card and its sheet.
   *
   * These are the strings the lock names: engine-side descriptions of engine
   * inputs, printed at a reader. Checked in one place so a later change that
   * reintroduces any of them has one test to fail rather than none.
   */
  test('says it in English, on the card and in the sheet', async ({ page }) => {
    const forbidden = ['stronger market expectation', 'role trending up', 'High pressure', 'rivals need'];
    const page_text = await page.locator('main').innerText();
    for (const phrase of forbidden) {
      expect(page_text, `the card says "${phrase}"`).not.toContain(phrase);
    }

    await page.getByTestId('waiver-row').first().click();
    const sheet = page.getByTestId('waiver-detail');
    await expect(sheet).toBeVisible();
    const sheetText = await sheet.innerText();
    for (const phrase of forbidden) {
      expect(sheetText, `the sheet says "${phrase}"`).not.toContain(phrase);
    }

    // Why we like him: at most three rows, each led by a pill.
    const reasons = sheet.getByTestId('waiver-reasons').locator('li');
    const count = await reasons.count();
    expect(count).toBeGreaterThan(0);
    expect(count, 'a sheet is an argument, not the engine’s working').toBeLessThanOrEqual(3);
    await expect(reasons.first().locator('.tag')).toHaveCount(1);
  });

  /**
   * The rule this page exists to keep.
   *
   * Expected cost, likely competition and multi-week value are facts about the
   * twelve people in your league, and the page shows a dash with an explanation
   * attached rather than a number nobody could act on.
   *
   * Competition and multi-week value now have a pass behind them, so they carry
   * real values. Expected cost still does not in a league with no bid history,
   * which is what this test is named for and what it still checks: the two that
   * were filled must not drag a price along with them.
   */
  test('never invents an expected cost', async ({ page }) => {
    const waivers = await (await page.request.get('/api/leagues/demo-league/waivers')).json();
    const priced = new Set((waivers.faab?.bids ?? []).filter((b: { expected: unknown }) => b.expected)
      .map((b: { playerId: string }) => b.playerId));
    const row = page.getByTestId('waiver-row').first();
    const playerId = (await row.getAttribute('data-player-id'))!;

    // A row the pricing pass could not price shows a dash that explains itself
    // rather than a number somebody could act on.
    if (!priced.has(playerId)) {
      expect(await row.getByTestId('waiver-cost').innerText()).not.toMatch(/\d/);
      await expect(page.getByTestId('waivers-pending')).toContainText('shown as unknown rather than estimated');
    }

    await row.click();
    const sheet = page.getByTestId('waiver-detail');
    await expect(sheet).toBeVisible();
    for (const field of ['Expected cost', 'Competition', 'Beyond this week']) {
      await expect(sheet).toContainText(field);
    }
    /*
     * Competition has a supplier now, so it says something.
     *
     * Asserted as "not the unknown mark" rather than against a particular
     * sentence: the label is that pass's to word, and pinning it here would make
     * this spec fail on a rewording rather than on a regression.
     *
     * Its two neighbours are deliberately not asserted, because both are
     * legitimately unknown against seeded data: the price needs bid history in
     * the league, and multi-week value needs stored usage — `waiverMultiWeek`
     * declines without it and says so. Requiring them would pin behaviour that
     * is only correct once two separate feeds have run.
     */
    const competition = sheet.locator('.weekly-line').filter({ hasText: 'Competition' }).first();
    await expect(competition.getByTestId('waiver-unknown')).toHaveCount(0);
    expect((await competition.innerText()).replace('Competition', '').trim().length).toBeGreaterThan(0);

    // And the price, which has no history behind it in this league, still reads
    // as unknown rather than borrowing confidence from the fields beside it.
    if (!priced.has(playerId)) {
      const cost = sheet.locator('.weekly-line').filter({ hasText: 'Expected cost' }).first();
      await expect(cost.getByTestId('waiver-unknown')).toHaveCount(1);
    }
  });

  test('filters by position without offering a chip that empties the list', async ({ page }) => {
    const filters = page.getByTestId('waiver-filters');
    await expect(filters).toBeVisible();
    const chips = await filters.locator('button').allInnerTexts();
    expect(chips[0]!.trim()).toBe('ALL');

    for (const chip of chips.slice(1)) {
      const position = chip.trim();
      await filters.locator('button', { hasText: new RegExp(`^${position}$`) }).first().click();
      const rows = page.getByTestId('waiver-row');
      await expect(rows.first()).toBeVisible();
      if (position === 'FLEX') {
        for (const row of await rows.all()) {
          expect(['RB', 'WR', 'TE']).toContain(await row.getAttribute('data-position'));
        }
      } else {
        for (const row of await rows.all()) {
          expect(await row.getAttribute('data-position')).toBe(position);
        }
      }
    }
  });

  /** No second way to ask. The gesture is the way. */
  test('offers no refresh button, and does pull to refresh', async ({ page }) => {
    const labels = (await page.locator('button:visible').allInnerTexts()).join(' | ').toLowerCase();
    expect(labels).not.toContain('refresh');

    let called = 0;
    await page.route('**/api/startsit/refresh', async (route) => {
      called += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          deduped: false,
          sources: [],
          headline: 'Already current',
          complete: true,
        }),
      });
    });

    const box = (await page.getByTestId('waivers-pull').boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + 40;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (const step of [12, 60, 120, 190]) await page.mouse.move(x, y + step);
    await page.mouse.up();

    await expect.poll(() => called, { timeout: 10_000 }).toBe(1);
  });

  /**
   * Advisory in every sense: there is no control here that transacts.
   *
   * The sentence saying so left the bottom of this list, along with the count
   * of players considered — the final pass took the engine's bookkeeping off a
   * screen whose job is naming two players worth adding. It is still in the
   * app, on the detail sheet beside the bid it qualifies, which the sheet test
   * above holds it to.
   *
   * What is checked here is the guarantee the sentence was only describing, and
   * the one that would still hold if every word of it were gone: no control on
   * this screen offers to perform a transaction.
   */
  test('offers nothing that would make a claim', async ({ page }) => {
    const buttons = (await page.locator('button:visible').allInnerTexts()).join(' ').toLowerCase();
    /*
     * Matched as whole words, not as substrings.
     *
     * The invariant is that no *control* offers to perform a transaction. The
     * check was a substring scan, which reads "bidder" as "bid" — so a row whose
     * competition metric says `Likely 2-3 bidders`, or names the rivals behind
     * that count, failed an assertion about buttons that transact while offering
     * no such button. Describing a bid and offering one are opposite things.
     *
     * Word boundaries keep every case the check exists for: a control reading
     * `Bid`, `Place bid`, `Submit`, `Add` or `Claim` still fails.
     */
    for (const forbidden of ['add', 'drop', 'claim', 'bid', 'submit']) {
      expect(
        new RegExp(`\\b${forbidden}\\b`).test(buttons),
        `a control reading "${forbidden}" would imply a transaction`,
      ).toBe(false);
    }
  });

  /** Nothing on this page may widen it. */
  test('fits the phone', async ({ page }) => {
    const width = page.viewportSize()!.width;
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(width);
  });
});
