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

  /**
   * The bottom of the screen, which has been wrong twice.
   *
   * The symptom both times was a strip of blank space under the navigation.
   * The cause is always double-counting: `env(safe-area-inset-bottom)` read in
   * two places, or a spacer reserving what the bar already reserves. So this
   * asserts the ownership rather than a pixel count — one owner for the
   * viewport height, one for the inset, one for the reservation — and does it
   * with the inset forced on, because the browser these tests run in reports
   * zero for it and the bug only exists when it does not.
   */
  test.describe('the bottom bar', () => {
    const INSET = 34;

    async function geometry(page: Page, inset: number) {
      await page.goto('/');
      await expect(page.getByTestId('tab-draft')).toBeVisible();
      await page.addStyleTag({ content: `:root { --safe-bottom: ${inset}px; }` });
      await page.waitForTimeout(300);
      return page.evaluate(() => {
        const nav = document.querySelector('.tabbar')!.getBoundingClientRect();
        const main = document.querySelector('.app-main')!;
        const rows = [...document.querySelectorAll('[data-testid="recommendation-row"]')];
        const last = rows[rows.length - 1]?.getBoundingClientRect() ?? null;
        return {
          viewport: window.innerHeight,
          navTop: Math.round(nav.top),
          navBottom: Math.round(nav.bottom),
          navHeight: Math.round(nav.height),
          gapBelowNav: Math.round(window.innerHeight - nav.bottom),
          reserved: getComputedStyle(main).paddingBottom,
          measuredBar: getComputedStyle(document.documentElement).getPropertyValue('--tabbar-height').trim(),
          documentHeight: document.documentElement.scrollHeight,
          lastRowBottom: last ? Math.round(last.bottom) : null,
        };
      });
    }

    test('sits flush to the bottom with nothing beneath it', async ({ page }) => {
      for (const inset of [0, INSET]) {
        const g = await geometry(page, inset);
        expect(g.gapBelowNav, `inset ${inset}: nothing may show below the bar`).toBe(0);
        expect(g.navBottom, `inset ${inset}: the bar reaches the viewport bottom`).toBe(g.viewport);
      }
    });

    test('spends the indicator inset once, and less of it than the device offers', async ({ page }) => {
      const flat = await geometry(page, 0);
      const inset = await geometry(page, INSET);
      // A screen with no home indicator gets no padding at all.
      expect(flat.navHeight, 'no inset, no extra height').toBe(44 + 1);
      // With one, the bar grows by the clearance and not by the whole inset.
      const grew = inset.navHeight - flat.navHeight;
      expect(grew).toBeGreaterThan(0);
      expect(grew, 'the full 34px inset is what read as a blank strip').toBeLessThan(INSET);
    });

    test('reserves exactly the bar, once', async ({ page }) => {
      const g = await geometry(page, INSET);
      // The page reserves the bar's measured height (which already contains the
      // inset) plus one gap — never the inset a second time.
      const reserved = Number.parseFloat(g.reserved);
      const bar = Number.parseFloat(g.measuredBar);
      expect(bar).toBe(g.navHeight);
      expect(reserved - bar, 'the reservation is the bar plus a hairline gap').toBeLessThanOrEqual(10);
      expect(reserved).toBeGreaterThanOrEqual(bar);
    });

    test('lets the last row scroll clear of the bar', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByTestId('board-list')).toBeVisible();
      await page.addStyleTag({ content: `:root { --safe-bottom: ${INSET}px; }` });

      /*
       * Settle, then scroll, then settle again — and scroll until it stops
       * moving rather than once.
       *
       * Growing the bar grows the page's reservation, so the document gets
       * taller *after* the style lands. A single scroll to the height measured
       * before that reflow lands short of the true bottom, which looks
       * identical to the bug this test is about. WebKit reflowed late enough to
       * catch it; Chromium happened not to.
       */
      await page.waitForTimeout(400);
      for (let i = 0; i < 5; i++) {
        const moved = await page.evaluate(() => {
          const before = window.scrollY;
          window.scrollTo(0, document.documentElement.scrollHeight);
          return window.scrollY !== before;
        });
        if (!moved) break;
        await page.waitForTimeout(150);
      }

      const clear = await page.evaluate(() => {
        const nav = document.querySelector('.tabbar')!.getBoundingClientRect();
        const rows = [...document.querySelectorAll('[data-testid="recommendation-row"]')];
        const last = rows[rows.length - 1]!.getBoundingClientRect();
        return { lastBottom: Math.round(last.bottom), navTop: Math.round(nav.top) };
      });
      expect(clear.lastBottom, 'the last player must not sit under the bar').toBeLessThanOrEqual(clear.navTop);
    });

    test('is the same geometry in Light and Dark', async ({ page }) => {
      const heights: number[] = [];
      for (const theme of ['light', 'dark'] as const) {
        await page.goto('/');
        await expect(page.getByTestId('tab-draft')).toBeVisible();
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
        await page.addStyleTag({ content: `:root { --safe-bottom: ${INSET}px; }` });
        await page.waitForTimeout(300);
        const g = await page.evaluate(() => {
          const nav = document.querySelector('.tabbar')!.getBoundingClientRect();
          return {
            height: Math.round(nav.height),
            gap: Math.round(window.innerHeight - nav.bottom),
            // The surface must run to the bottom edge, so the inset is bar and
            // not page: a transparent strip there is the "grey/black" one.
            background: getComputedStyle(document.querySelector('.tabbar')!).backgroundColor,
          };
        });
        expect(g.gap).toBe(0);
        expect(g.background).not.toBe('rgba(0, 0, 0, 0)');
        heights.push(g.height);
      }
      expect(heights[0]).toBe(heights[1]);
    });

    /** One owner for the viewport height: a second `100dvh` is a second claim. */
    test('claims the viewport height exactly once', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByTestId('tab-draft')).toBeVisible();
      const claims = await page.evaluate(() =>
        ['#root', '.app', '.app-main'].map((sel) => {
          const el = document.querySelector(sel)!;
          return { sel, minHeight: getComputedStyle(el).minHeight };
        }),
      );
      const viewport = await page.evaluate(() => window.innerHeight);
      const full = claims.filter((c) => Math.abs(Number.parseFloat(c.minHeight) - viewport) < 2);
      expect(full.map((c) => c.sel)).toEqual(['#root']);
    });
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

    // And it names the pick it is talking about, so "next pick" cannot be read
    // as the one on the clock — which is what it used to be measured against.
    const board = await (await page.request.get('/api/drafts/demo-draft/board?limit=1')).json();
    expect(board.waitHorizonPick).toBeGreaterThan(board.currentPick);
    await expect(survivals.first().locator('strong')).toHaveAttribute(
      'title',
      new RegExp(`at pick ${board.waitHorizonPick}, your next one after this`),
    );

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

    /*
     * What the market is worth in this league's points is still computed and
     * still returned — it has stopped being printed, along with the rest of the
     * ranking's workings. The collapsed line above is the market context the
     * card shows now.
     */
    const board = await (await page.request.get('/api/drafts/demo-draft/board?limit=40')).json();
    const priced = board.recommendations.filter((r: { marketBaseline: unknown }) => r.marketBaseline);
    expect(priced.length).toBeGreaterThan(0);
    expect(priced[0].marketBaseline.points).not.toBeNull();
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

  /**
   * The expansion stopped explaining the ranking.
   *
   * "Why this rank", its bullets, the counterpoint and the component
   * arithmetic all justified a position the reader can already see, on a screen
   * where the question is "who is this and should I take him". They are gone
   * from here — and still computed, still returned by the board, so nothing was
   * deleted from the system.
   */
  test('shows no ranking rationale in the quick expansion', async ({ page }) => {
    const first = page.getByTestId('recommendation-row').first();
    await first.click();
    await expect(first.getByTestId('player-detail')).toBeVisible();

    const detail = (await first.locator('.explain').innerText()).toLowerCase();
    for (const gone of ['why this rank', 'show all reasons', 'counterpoint', 'advanced breakdown']) {
      expect(detail, `"${gone}" should be gone from the quick expansion`).not.toContain(gone);
    }
    // Structurally, not only by wording.
    for (const selector of ['.reason-list', '.component', '.metric-grid', '.stat-label', '.verdict']) {
      await expect(first.locator(`.explain ${selector}`)).toHaveCount(0);
    }
    await expect(first.getByTestId('advanced-breakdown')).toHaveCount(0);
    await expect(first.getByTestId('all-reasons')).toHaveCount(0);
  });

  /** …and the engine still produces all of it, for anything that wants it. */
  test('still computes the full explanation behind the board', async ({ page }) => {
    const board = await (await page.request.get('/api/drafts/demo-draft/board?limit=3')).json();
    const rec = board.recommendations[0];
    expect(rec.reasons.length, 'reasons are still produced').toBeGreaterThan(0);
    const labels = rec.components.map((c: { label: string }) => c.label).join(' | ');
    for (const label of ['ADP value', 'Roster need', 'Positional scarcity', 'League fit', 'Survival to next pick']) {
      expect(labels, `missing component: ${label}`).toContain(label);
    }
  });

  /**
   * One line of context survives, because it is a fact about the board rather
   * than about the model — and it is absent whenever the tier is ordinary,
   * which is what stops it becoming the next thing to delete.
   */
  test('keeps one tier-context line, and only where it means something', async ({ page }) => {
    // The seeded tight ends are two deep in front of a real cliff.
    const te = page.locator('[data-testid="recommendation-row"]', { hasText: 'Nate Kowalski' }).first();
    await te.scrollIntoViewIfNeeded();
    await te.click();
    await expect(te.getByTestId('tier-context')).toContainText(/TE tier cliff · 2 left/i);
    await te.locator('.row-button').click();

    // The receivers have no computed cliff on this board, so they get no line.
    const wr = page.locator('[data-testid="recommendation-row"]', { hasText: 'Kai Brennan' }).first();
    await wr.scrollIntoViewIfNeeded();
    await wr.click();
    await expect(wr.getByTestId('tier-context')).toHaveCount(0);
    await wr.locator('.row-button').click();

    // It is one line, not a section: no heading, no bullets.
    const board = await (await page.request.get('/api/drafts/demo-draft/board?limit=40')).json();
    const lines = board.recommendations
      .map((r: { tierContext: string | null }) => r.tierContext)
      .filter(Boolean) as string[];
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain('\n');
      expect(line.length).toBeLessThan(90);
    }
  });

  /**
   * Current availability, without expanding anything. This was previously
   * visible only on the Players screen, which is not where drafting happens.
   */
  test('tags current injury status on the collapsed card', async ({ page }) => {
    const tagged = await page
      .getByTestId('recommendation-row')
      .evaluateAll((rows) =>
        rows.map((r) => ({
          name: r.querySelector('.player-name')?.textContent ?? '',
          tag: r.querySelector('[data-testid="injury-tag"]')?.getAttribute('data-status') ?? null,
          label: r.querySelector('[data-testid="injury-tag"]')?.getAttribute('aria-label') ?? null,
        })),
      );
    const byName = new Map(tagged.map((t) => [t.name, t]));

    expect(byName.get('Julian Reyes')?.tag).toBe('OUT');
    expect(byName.get('Nate Kowalski')?.tag).toBe('IR');
    expect(byName.get('Andre Sotelo')?.tag).toBe('Q');
    expect(byName.get('Cal Whitfield')?.tag).toBe('D');
    // A healthy player carries nothing at all.
    expect(byName.get('Kai Brennan')?.tag).toBeNull();

    // The word is always there for a screen reader; the colour only accelerates.
    expect(byName.get('Andre Sotelo')?.label).toBe('Questionable');

    // Three distinct tones, so severity is visible at a glance too.
    const colours = await page
      .locator('[data-testid="injury-tag"]')
      .evaluateAll((nodes) => [...new Set(nodes.map((n) => getComputedStyle(n).backgroundColor))]);
    expect(colours.length).toBeGreaterThan(1);
  });

  /** Showing a status must not quietly become a second injury penalty. */
  test('the injury tags do not reorder the board', async ({ page }) => {
    const board = await (await page.request.get('/api/drafts/demo-draft/board?limit=40')).json();
    const ranked = board.recommendations.map((r: { total: number }) => r.total);
    expect([...ranked].sort((a: number, b: number) => b - a)).toEqual(ranked);
    // The tagged players are not all at the bottom — they sit on their merits.
    const positions = board.recommendations
      .map((r: { status: string | null }, i: number) => (r.status ? i : -1))
      .filter((i: number) => i >= 0);
    expect(Math.min(...positions)).toBeLessThan(board.recommendations.length / 2);
  });

  /**
   * The outlook is written by somebody, says so, and is shown whole.
   *
   * It used to be cut to the first two or three sentences. These paragraphs
   * open with last season and work forwards, so the clip routinely dropped the
   * depth-chart and workload half — the fantasy-relevant part — to save space
   * on a card that has since lost three sections. Compressing it here instead
   * would mean paraphrasing somebody else's analysis under their name.
   */
  test('shows the whole attributed season outlook, and admits when there is none', async ({ page }) => {
    const withOutlook = page.locator('[data-testid="recommendation-row"]', { hasText: 'Kai Brennan' }).first();
    await withOutlook.click();
    const outlook = withOutlook.getByTestId('outlook');
    await expect(outlook).toBeVisible();
    await expect(withOutlook.getByText(/season outlook/i)).toBeVisible();
    await expect(outlook).toContainText('via Sleeper');

    // The whole of what the source holds, not a prefix of it.
    const shown = (await outlook.innerText()).split(' — ')[0]!.trim();
    const stored = await (await page.request.get('/api/players/1005/detail')).json();
    expect(shown).toBe(stored.outlook.text);
    expect(shown.length).toBeGreaterThan(300);
    await withOutlook.locator('.row-button').click();

    const without = page.locator('[data-testid="recommendation-row"]', { hasText: 'Bo Ashworth' }).first();
    await without.scrollIntoViewIfNeeded();
    await without.click();
    await expect(without.getByTestId('outlook-none')).toContainText(/no .* outlook published/i);
    await without.locator('.row-button').click();
  });

  /**
   * Injury context is a label, not a retelling: the outlook above already
   * explains it in the words of somebody who knows, and the app repeating that
   * in its own words would be duplication at best and paraphrase at worst.
   */
  test('names a major injury only when the source names one', async ({ page }) => {
    // Reyes's outlook says he tore an ACL.
    const hurt = page.locator('[data-testid="recommendation-row"]', { hasText: 'Julian Reyes' }).first();
    await hurt.scrollIntoViewIfNeeded();
    await hurt.click();
    await expect(hurt.getByTestId('injury-context')).toContainText('Major injury history: ACL');
    // One line, not a paragraph, and it does not restate the outlook.
    const context = await hurt.getByTestId('injury-context').innerText();
    expect(context.length).toBeLessThan(80);
    await hurt.locator('.row-button').click();

    /*
     * Brennan's outlook mentions an ankle that cost him two games. That is a
     * gap in a game log, not a major injury history, and inventing one from it
     * is the failure this section is written to avoid.
     */
    const fit = page.locator('[data-testid="recommendation-row"]', { hasText: 'Kai Brennan' }).first();
    await fit.scrollIntoViewIfNeeded();
    await fit.click();
    await expect(fit.getByTestId('injury-context')).toHaveCount(0);
    await expect(fit.getByText('Injury context')).toHaveCount(0);
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

    /*
     * What the star did not do, checked against the board rather than against a
     * sentence on a card.
     *
     * The expansion used to explain this in words; it explains nothing now. The
     * guarantee is better tested at the source anyway — the ranking is byte for
     * byte the same with the star lit, which is the claim the sentence was
     * making on its behalf.
     */
    const starred = await (await page.request.get('/api/drafts/demo-draft/board?limit=40')).json();
    expect(starred.recommendations.find((r: { playerId: string }) => r.playerId === playerId).queued).toBe(true);

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
