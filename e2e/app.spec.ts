/**
 * iPhone-portrait smoke tests over the seeded demo dataset.
 *
 * Covers the flows in docs/06_UI_AND_QA.md: log in, review the draft board,
 * open a recommendation's reasoning, import ADP, inspect player intelligence,
 * resolve the review queue, compare start/sit, and the degraded state when
 * Vegas data is missing.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Wait for a disclosure to finish opening before reading its text.
 *
 * The expanded player animates its height, and while that reveal is still
 * clipping the content WebKit reports it as rendering no text at all — an
 * element can be visible, and `innerText` still be empty, for the ~200ms the
 * card takes to open. Reading through that window turns a negative assertion
 * ("this word is gone") into one that passes because there were no words yet,
 * which is worse than a failing test. Nothing here relaxes an assertion; it
 * only waits for the thing being asserted about to exist.
 */
async function revealed(locator: Locator): Promise<void> {
  await expect.poll(async () => (await locator.innerText()).trim().length).toBeGreaterThan(0);
}

/** The session is established once by `auth.setup.ts` and reused here. */
async function login(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('tab-draft')).toBeVisible();
}

async function openTab(page: Page, tab: 'draft' | 'team' | 'players' | 'review') {
  await page.getByTestId(`tab-${tab}`).click();
}

/** Pick one player in the open comparison sheet. */
async function choose(page: Page, playerId: string) {
  const row = page.locator(`[data-testid="compare-candidate"][data-player-id="${playerId}"]`);
  await row.click();
  await expect(row).toHaveAttribute('data-chosen', 'true');
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
   *
   * **What changed with the floating toolbar, and what did not.** The bar no
   * longer reaches the bottom edge — it is a pill that floats clear of it, so a
   * gap below it is now correct rather than a bug. What is unchanged is that
   * the gap is a number the design chooses (`--toolbar-gap`) and the page holds
   * back exactly the bar plus that gap and no more. The claim is therefore
   * "the space below the bar is the gap, to the pixel" rather than "there is
   * none", which is the same claim with a different constant and just as hard
   * to satisfy by accident.
   */
  test.describe('the floating toolbar', () => {
    const INSET = 34;

    async function geometry(page: Page, inset: number) {
      await page.goto('/');
      await expect(page.getByTestId('tab-draft')).toBeVisible();
      await page.addStyleTag({ content: `:root { --safe-bottom: ${inset}px; }` });
      await page.waitForTimeout(300);
      return page.evaluate(() => {
        const bar = document.querySelector('.tabbar')!;
        const nav = bar.getBoundingClientRect();
        const main = document.querySelector('.app-main')!;
        const rows = [...document.querySelectorAll('[data-testid="recommendation-row"]')];
        const last = rows[rows.length - 1]?.getBoundingClientRect() ?? null;
        /* `--toolbar-gap` is a max() over an env(), so it has to be resolved by
           the browser rather than read as a string. */
        const probe = document.createElement('div');
        probe.style.cssText = 'position:fixed;visibility:hidden;padding-bottom:var(--toolbar-gap)';
        document.body.append(probe);
        const gap = Math.round(Number.parseFloat(getComputedStyle(probe).paddingBottom));
        probe.remove();
        return {
          viewport: window.innerHeight,
          width: window.innerWidth,
          navTop: Math.round(nav.top),
          navBottom: Math.round(nav.bottom),
          navHeight: Math.round(nav.height),
          navWidth: Math.round(nav.width),
          gapBelowNav: Math.round(window.innerHeight - nav.bottom),
          intendedGap: gap,
          reserved: getComputedStyle(main).paddingBottom,
          measuredBar: getComputedStyle(document.documentElement).getPropertyValue('--toolbar-height').trim(),
          documentHeight: document.documentElement.scrollHeight,
          lastRowBottom: last ? Math.round(last.bottom) : null,
        };
      });
    }

    test('floats by exactly the gap it says it does, and no more', async ({ page }) => {
      for (const inset of [0, INSET]) {
        const g = await geometry(page, inset);
        expect(g.gapBelowNav, `inset ${inset}: the page owns only the gap it declared`).toBe(g.intendedGap);
        // And the gap is a hairline on a flat screen, never a strip of page.
        if (inset === 0) expect(g.gapBelowNav).toBeLessThanOrEqual(8);
      }
    });

    test('spends the indicator inset once, as clearance under the bar', async ({ page }) => {
      const flat = await geometry(page, 0);
      const inset = await geometry(page, INSET);
      // The pill's own height is a property of the pill, not of the device: it
      // is the same bar on both screens.
      expect(inset.navHeight, 'the inset must not be padding inside the bar').toBe(flat.navHeight);
      // 54–64px for an icon and a label, which is what a bottom bar costs.
      expect(flat.navHeight).toBeGreaterThanOrEqual(54);
      expect(flat.navHeight).toBeLessThanOrEqual(64);
      // With an indicator, the bar rises by the clearance and not by the whole
      // inset — spending all 34px is what used to read as a blank strip.
      const rose = inset.gapBelowNav - flat.gapBelowNav;
      expect(rose).toBeGreaterThan(0);
      expect(inset.gapBelowNav, 'the indicator reaches 13px up the screen').toBeGreaterThanOrEqual(13);
      expect(inset.gapBelowNav, 'the full 34px inset is what read as a blank strip').toBeLessThan(INSET);
    });

    test('is narrower than the screen, and centred on it', async ({ page }) => {
      const g = await geometry(page, 0);
      expect(g.navWidth, 'a full-width bar is the webpage footer this replaced').toBeLessThan(g.width - 16);
      const left = await page.evaluate(() => Math.round(document.querySelector('.tabbar')!.getBoundingClientRect().left));
      expect(Math.abs(left - (g.width - g.navWidth) / 2), 'the pill is off centre').toBeLessThanOrEqual(1);
    });

    test('reserves exactly the bar and its gap, once', async ({ page }) => {
      const g = await geometry(page, INSET);
      const reserved = Number.parseFloat(g.reserved);
      const bar = Number.parseFloat(g.measuredBar);
      // The measurement is the pill only. The gap is added in exactly one place.
      expect(bar).toBe(g.navHeight);
      expect(reserved).toBeGreaterThanOrEqual(bar + g.intendedGap);
      expect(reserved - (bar + g.intendedGap), 'the reservation is bar + gap + one step of air').toBeLessThanOrEqual(10);
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
      const shapes: { height: number; gap: number }[] = [];
      for (const theme of ['light', 'dark'] as const) {
        await page.goto('/');
        await expect(page.getByTestId('tab-draft')).toBeVisible();
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
        await page.addStyleTag({ content: `:root { --safe-bottom: ${INSET}px; }` });
        await page.waitForTimeout(300);
        const g = await page.evaluate(() => {
          const bar = document.querySelector('.tabbar')!;
          const nav = bar.getBoundingClientRect();
          return {
            height: Math.round(nav.height),
            gap: Math.round(window.innerHeight - nav.bottom),
            // A floating pill has a list scrolling under it, so its surface is
            // load-bearing: transparent here means unreadable labels.
            background: getComputedStyle(bar).backgroundColor,
          };
        });
        expect(g.background).not.toBe('rgba(0, 0, 0, 0)');
        shapes.push({ height: g.height, gap: g.gap });
      }
      expect(shapes[0]).toEqual(shapes[1]);
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
   * The four numbers, and the tally that stopped being one of them.
   *
   * The metrics line used to read `ADP · Value · Next pick · ▲ +6 pos`, which
   * spent a third of itself on the tally and had no room left for the thing the
   * board is actually deciding. The tally is now one token beside the name and
   * the line carries `Score · ADP · Val · Next`.
   */
  test('reads Score · ADP · Val · Next, with the tally beside the name', async ({ page }) => {
    const first = page.getByTestId('recommendation-row').first();
    const metrics = await first.locator('.player-row-metrics').innerText();

    expect(metrics).toMatch(/Score\s+\d{1,3}/);
    expect(metrics).toContain('ADP');
    expect(metrics).toMatch(/\bVal\b/);
    expect(metrics).toMatch(/\bNext\b/);
    // The long labels are what cost the fourth column its space.
    expect(metrics).not.toMatch(/\bValue\b/);
    expect(metrics).not.toMatch(/Next pick/);

    // Score is a whole number in range, and not a percentage.
    const score = Number(metrics.match(/Score\s+(\d{1,3})/)![1]);
    expect(Number.isInteger(score)).toBe(true);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
    expect(metrics).not.toMatch(/Score\s+\d+%/);

    // The tally: a signed number, in the identity row, with no arrow and no word.
    const tally = page.getByTestId('compact-tally').first();
    await expect(tally).toBeVisible();
    const text = (await tally.innerText()).trim();
    expect(text).toMatch(/^[+-]\d+$/);
    for (const gone of ['▲', '▼', 'pos', 'neg']) {
      expect(text, `"${gone}" should be gone from the tally`).not.toContain(gone);
    }
    // Beside the name, not under it. It sits in the fixed-width field that
    // keeps the club marks aligned — see `--row-meta` — and that field is part
    // of the identity row, which is the claim being made here.
    const field = tally.locator('xpath=..');
    expect(await field.getAttribute('class')).toContain('player-row-meta');
    expect(await field.locator('xpath=..').getAttribute('class')).toContain('player-row-top');

    // And nowhere in the metrics line.
    const board = await (await page.request.get('/api/drafts/demo-draft/board?limit=40')).json();
    expect(board.recommendations.some((r: { newsLifetimeNet: number }) => r.newsLifetimeNet !== 0)).toBe(true);
    for (const row of await page.getByTestId('recommendation-row').all()) {
      const line = await row.locator('.player-row-metrics').innerText();
      expect(line).not.toMatch(/▲|▼|\bpos\b|\bneg\b/);
    }
  });

  /**
   * The left-hand number never stopped meaning board rank.
   *
   * Adding a second number to the row is exactly how that could go wrong, so
   * this checks both: the ranks still count 1, 2, 3 down the list, and the
   * Scores are in the order the ranks claim.
   */
  test('keeps the leftmost number as board rank, with Score agreeing', async ({ page }) => {
    const ranks = await page.locator('[data-testid="recommendation-row"] .rank').allInnerTexts();
    expect(ranks.slice(0, 5)).toEqual(['1', '2', '3', '4', '5']);

    /*
     * Scored rows descend. Unscored ones are last and have nothing to compare.
     *
     * A player no market has priced carries no Score — his composite is real
     * but it is not on the same scale, because market value is absent rather
     * than low. He sits below every priced player, which is the ordering being
     * checked here, and shows `unknown` rather than a number.
     */
    const cells = await page
      .locator('[data-testid="recommendation-row"] .score-value')
      .allInnerTexts();
    expect(cells.length).toBeGreaterThan(3);
    const scored = cells.filter((text) => /^\d+$/.test(text.trim()));
    expect(scored.length).toBeGreaterThan(3);
    // Every unscored row comes after every scored one.
    expect(cells.findIndex((t) => !/^\d+$/.test(t.trim()))).not.toBe(0);
    for (let i = 1; i < scored.length; i++) {
      expect(Number(scored[i]), `row ${i + 1} scores above row ${i}`).toBeLessThanOrEqual(
        Number(scored[i - 1]),
      );
    }
  });

  /**
   * Density, at the width where it is hardest.
   *
   * Two numbers were added to a row that was already full. The failure this
   * guards against is not overflow — the shell test covers that — but the
   * quieter one: the line wrapping into two, or the name being squeezed to
   * nothing to make room for them.
   */
  test('fits the identity row and the metrics line on one line each', async ({ page }) => {
    const first = page.getByTestId('recommendation-row').first();
    const name = await first.locator('.player-name').boundingBox();
    const metrics = await first.locator('.player-row-metrics').boundingBox();
    const top = await first.locator('.player-row-top').boundingBox();

    // The name is still the dominant thing in its row.
    expect(name!.width).toBeGreaterThan(top!.width * 0.35);
    // One line each: two would roughly double these.
    expect(top!.height).toBeLessThan(34);
    expect(metrics!.height).toBeLessThan(26);
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

    await revealed(first.locator('.explain'));
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
    /*
     * Priced players first, then by composite — the board's two sort keys, and
     * the reason this is not a plain descending sort on `total`.
     *
     * An unpriced player's total sits near zero because market value is absent
     * rather than low, and zero beats the negative total every priced player
     * carries until the draft reaches his ADP. Ordering on `total` alone
     * therefore floats exactly the players the board knows least about, which
     * is what once put seven `ADP —` rows at the top of a live board.
     */
    const key = (r: { total: number; score: number | null }): [number, number] => [
      r.score == null ? 1 : 0,
      -r.total,
    ];
    const rows = board.recommendations as { total: number; score: number | null }[];
    const expected = [...rows].sort((a, b) => key(a)[0] - key(b)[0] || key(a)[1] - key(b)[1]);
    expect(rows.map((r) => r.total)).toEqual(expected.map((r) => r.total));
    // And the scored players really do descend among themselves.
    const scored = rows.filter((r) => r.score != null).map((r) => r.total);
    expect([...scored].sort((a, b) => b - a)).toEqual(scored);
    // The tagged players are not all at the bottom — they sit on their merits.
    const positions = board.recommendations
      .map((r: { status: string | null }, i: number) => (r.status ? i : -1))
      .filter((i: number) => i >= 0);
    expect(Math.min(...positions)).toBeLessThan(board.recommendations.length / 2);
  });

  /**
   * The outlook is written by somebody, says so, and is short by default.
   *
   * It was once cut to the first two or three sentences, which dropped the
   * depth-chart and workload half — these paragraphs open with last season and
   * work forwards. It then showed the whole twelve hundred characters. Now a
   * *selection* is shown: the provider's own sentences, in the provider's own
   * order, and the card says it has been shortened and offers the rest.
   */
  test('shortens a long outlook to the provider’s own sentences, and offers the rest', async ({ page }) => {
    const row = page.locator('[data-testid="recommendation-row"]', { hasText: 'Owen Fitzgerald' }).first();
    await row.scrollIntoViewIfNeeded();
    await row.click();
    const outlook = row.getByTestId('outlook');
    await expect(outlook).toBeVisible();
    await expect(outlook).toHaveAttribute('data-summarised', 'yes');
    await expect(outlook).toContainText('via Sleeper');

    const stored = (await (await page.request.get('/api/players/1007/detail')).json()).outlook;
    await revealed(outlook);
    const short = (await outlook.innerText()).split(' — ')[0]!.trim();

    // Materially shorter than the source…
    expect(short.length).toBeLessThan(stored.fullText.length * 0.5);
    // …and made only of sentences the provider actually wrote.
    expect(short).toBe(stored.text);
    for (const sentence of short.split(/(?<=[.!?])\s+/)) {
      expect(stored.fullText, `invented sentence: ${sentence}`).toContain(sentence.trim());
    }

    // A cut quotation that admits it, and gives the rest back.
    await row.getByTestId('outlook-toggle').click();
    const whole = (await outlook.innerText()).split(' — ')[0]!.trim();
    expect(whole).toBe(stored.fullText);
    expect(whole.length).toBeGreaterThan(short.length);
    // Expanding the text did not collapse the player.
    await expect(outlook).toBeVisible();
    await row.locator('.row-button').click();
  });

  /**
   * And it declines rather than produce a bad summary. The three-sentence
   * outlooks in the demo data are already short, so there is nothing to choose
   * between and the whole thing is shown, with no control offering "the rest".
   */
  test('leaves a short outlook whole, and admits when there is none', async ({ page }) => {
    const withOutlook = page.locator('[data-testid="recommendation-row"]', { hasText: 'Kai Brennan' }).first();
    await withOutlook.click();
    const outlook = withOutlook.getByTestId('outlook');
    await expect(outlook).toBeVisible();
    await expect(withOutlook.getByText(/season outlook/i)).toBeVisible();
    await expect(outlook).toContainText('via Sleeper');
    await expect(outlook).toHaveAttribute('data-summarised', 'no');
    await expect(withOutlook.getByTestId('outlook-toggle')).toHaveCount(0);

    await revealed(outlook);
    const shown = (await outlook.innerText()).split(' — ')[0]!.trim();
    const stored = await (await page.request.get('/api/players/1005/detail')).json();
    expect(shown).toBe(stored.outlook.fullText);
    expect(shown.length).toBeGreaterThan(300);
    await withOutlook.locator('.row-button').click();

    const without = page.locator('[data-testid="recommendation-row"]', { hasText: 'Bo Ashworth' }).first();
    await without.scrollIntoViewIfNeeded();
    await without.click();
    await expect(without.getByTestId('outlook-none')).toContainText(/no .* outlook published/i);
    await without.locator('.row-button').click();
  });

  /**
   * One player's availability, said the same way everywhere.
   *
   * The badge on the row is the designation. The line under it is what the
   * designation cannot fit — the body part, and how the week's practice went —
   * and it appears only where the injury report added something, which is why
   * most rows still carry nothing at all.
   */
  test('carries the body part and the practice week, and only where they exist', async ({ page }) => {
    const board = await (await page.request.get('/api/drafts/demo-draft/board?limit=40')).json();
    const withLine = board.recommendations.filter((r: { injuryLine: string | null }) => r.injuryLine);
    expect(withLine.length, 'the demo report covers some players').toBeGreaterThan(0);
    expect(withLine.length, 'and nowhere near all of them').toBeLessThan(board.recommendations.length / 2);

    // Sotelo is Questionable in both sources and practised fully by week 12 —
    // the case where the report makes the designation *less* worrying.
    const sotelo = page.locator('[data-testid="recommendation-row"]', { hasText: 'Andre Sotelo' }).first();
    await sotelo.scrollIntoViewIfNeeded();
    await expect(sotelo.getByTestId('injury-line')).toContainText(/hamstring/i);
    await expect(sotelo.getByTestId('injury-line')).toContainText(/limited → full|practised fully/i);
    // The badge is still the badge; the line is not a second copy of it.
    await expect(sotelo.locator('.injury-tag')).toBeVisible();

    // A healthy player gets neither.
    const healthy = page.locator('[data-testid="recommendation-row"]', { hasText: 'Kai Brennan' }).first();
    await expect(healthy.getByTestId('injury-line')).toHaveCount(0);
  });

  /**
   * Sources that disagree are shown disagreeing.
   *
   * Reyes is Out in Sleeper and Doubtful on the report. Averaging those into
   * something in between would be inventing a third opinion nobody holds — so
   * the app takes the league host's word for the designation and prints the
   * disagreement rather than hiding it.
   */
  test('surfaces a disagreement between sources instead of averaging it', async ({ page }) => {
    const detail = await (await page.request.get('/api/players/1006/detail')).json();
    expect(detail.injury).not.toBeNull();
    expect(detail.injury.designation, 'the league host owns the designation').toBe('out');
    expect(detail.injury.conflict).toContain('sleeper');
    expect(detail.injury.conflict).toContain('nflverse');
    expect(detail.injury.confidence, 'and a disagreement costs confidence').toBe('low');

    const row = page.locator('[data-testid="recommendation-row"]', { hasText: 'Julian Reyes' }).first();
    await row.scrollIntoViewIfNeeded();
    await row.click();
    await expect(row.getByTestId('injury-conflict')).toContainText(/disagree/i);
    await expect(row.getByTestId('injury-current')).toContainText(/knee/i);
    // And it says where it came from, so the freshness can be judged.
    await expect(row.getByTestId('injury-current')).toContainText(/sleeper status/i);
    await row.locator('.row-button').click();
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
    await revealed(hurt.getByTestId('injury-context'));
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
    await revealed(first.locator('.explain'));
    expect((await first.locator('.explain').innerText()).toLowerCase()).not.toContain('rostered');

    await page.getByTestId('tab-setup').click();
    const panel = page.getByTestId('panel-player-detail');
    await panel.locator('summary').click();
    await expect(panel.getByTestId('roster-percent-health')).toContainText(/publishes no roster percentage/i);
    // …and the two feeds that do exist report what landed.
    await expect(panel.getByTestId('stats-health')).toContainText(/player/);
    await expect(panel.getByTestId('outlook-health')).toContainText(/stored/);

    /*
     * Where availability comes from, in the same panel.
     *
     * A pipeline that mapped a third of its rows looks identical to one that
     * worked, until a card is blank on a Sunday morning — so the counts and the
     * week are printed rather than a green light.
     */
    await expect(panel.getByTestId('injury-health')).toContainText(/week \d+|Sleeper designations only/i);
    const status = await (await page.request.get('/api/setup/status')).json();
    expect(status.injury.statusSource).toBe('sleeper');
    expect(status.injury.reportSource).toBe('nflverse');
    expect(status.injury.lastRun.outcome).toBe('ok');
    expect(status.injury.players).toBeGreaterThan(0);

    /*
     * The three timestamps, which are the whole reason the five-minute cadence
     * is honest. "Checked" moves every tick; the report itself changes rarely.
     * A panel that showed only the first would claim the data was two minutes
     * old when its newest report was from Wednesday.
     */
    await expect(panel.getByTestId('injury-freshness')).toContainText(/Checked/i);
    await expect(panel.getByTestId('injury-freshness')).toContainText(/the report itself last changed/i);
    expect(Date.parse(status.injury.sourceModifiedAt)).toBeLessThan(Date.parse(status.injury.checkedAt));

    // And what actually moved, which only exists because transitions are stored.
    await expect(panel.getByTestId('injury-events')).toContainText(/limited → full/i);
    expect(status.injury.writesToday).toBeLessThan(status.injury.writeCeiling);
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
   * Two marks is the ceiling, and only because they say unrelated things: the
   * research is against him, and his group is nearly gone. The row's budget
   * exists because it used to hold four.
   *
   * Counted across the whole row rather than inside one container: the two live
   * in different places now — AVOID still costs a row of its own, the tier cliff
   * sits at the end of the metrics line — and a ceiling that only looked in one
   * of them would stop being a ceiling.
   */
  test('shows at most two decision marks on a row', async ({ page }) => {
    const rows = page.getByTestId('recommendation-row');
    const count = await rows.count();
    for (let i = 0; i < Math.min(count, 10); i++) {
      const marks = rows.nth(i).locator('.tag-row .tag, [data-testid="tier-cliff-tag"]');
      expect(await marks.count(), 'a row should never become a badge wall').toBeLessThanOrEqual(2);
    }
  });

  /**
   * Tier structure, drawn two different ways for two different lists.
   *
   * The seeded board is built to have both: six quarterbacks in a cluster of
   * four then a hole of seventeen blended-market picks, and five tight ends
   * whose best group is down to two. See `DEMO_PLAYERS`.
   */
  test.describe('tiers', () => {
    test('draws a line where a filtered position genuinely breaks', async ({ page }) => {
      await page.getByRole('button', { name: 'QB', exact: true }).click();
      await expect(page.getByTestId('recommendation-row').first()).toBeVisible();

      const dividers = page.getByTestId('tier-divider');
      await expect(dividers, 'the QB board breaks exactly once').toHaveCount(1);
      await expect(dividers.first()).toContainText(/tier drop/i);
      /*
       * It says how big the hole is, which is the whole reason it is there.
       *
       * Seventeen picks, and it used to read twenty-three. The ladder is built
       * from the DOG/Sleeper blend rather than from Sleeper alone, so the hole
       * is measured in the same space the tiers were drawn in: the last of the
       * top four sits at 0.6*35.8 + 0.4*30.2 = 33.6, the first of the next pair
       * at 0.6*49.2 + 0.4*52.9 = 50.7, and the gap between them is 17.1. The old
       * number measured the Sleeper gap while the ladder measured the blended
       * one, which is exactly the mismatch the tier work exists to remove.
       */
      await expect(dividers.first()).toContainText(/~17 picks/);

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
      await expect(tags.first()).toBeVisible();

      /*
       * Read from the accessible name rather than the printed text. The chip
       * has a short spelling on the narrow phones — four labelled numbers and
       * nineteen characters do not share 315px — and what it *means* is the
       * part that may not change with the viewport.
       */
      for (const tag of await tags.all()) {
        await expect(tag).toHaveAttribute('aria-label', /^Tier cliff, (last 1|2 left)$/);
        await expect(tag).toHaveAttribute('data-remaining', /^[12]$/);
      }

      /*
       * The two invariants, asserted over the drawn board rather than by
       * naming the positions the demo happens to warn about.
       *
       * At most one tier per position may warn, and a warned tier is down to
       * one or two, so a position may contribute at most two chips — and the
       * count of chips per position must equal the number the chips themselves
       * claim is left. That is the whole rule, checked from the pixels.
       */
      const tagged = await page
        .getByTestId('recommendation-row')
        .filter({ has: page.getByTestId('tier-cliff-tag') })
        .evaluateAll((nodes) =>
          nodes.map((n) => ({
            position: n.getAttribute('data-position'),
            remaining: n.querySelector('[data-testid="tier-cliff-tag"]')!.getAttribute('data-remaining'),
          })),
        );
      expect(tagged.length).toBeGreaterThan(0);
      const byPosition = new Map<string, string[]>();
      for (const row of tagged) {
        byPosition.set(row.position!, [...(byPosition.get(row.position!) ?? []), row.remaining!]);
      }
      for (const [position, remainings] of byPosition) {
        expect(new Set(remainings), `${position} chips disagree about the count`).toEqual(new Set([remainings[0]]));
        expect(remainings.length, `${position} drew more chips than its tier has players`).toBe(
          Number(remainings[0]),
        );
      }

      // The rest of the board is not carrying the same warning, which is the
      // failure this label has already shipped once.
      const rows = await page.getByTestId('recommendation-row').count();
      expect(rows).toBeGreaterThan(6);
      expect(tagged.length).toBeLessThan(rows / 2);
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
      /*
       * The group below carries no warning — not because it sits below the one
       * in play, which no longer disqualifies anything, but because it is the
       * last tier at the position. It ends where the board ends, and running
       * out of board is not a fact about the position.
       */
      expect(tes[2]!.tierCliff.tierIndex).toBe(1);
      expect(tes[2]!.tierCliff.tierEndsAtCliff).toBe(false);
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

  /**
   * The claim is "never overlapping", and that is now asserted directly.
   *
   * It used to be checked by counting requests and expecting exactly one, which
   * worked while the only thing that could make a request was a tap. The board
   * keeps itself current now, so a five-second poll can land inside this test
   * through no fault of the control being tested — and a count of one would
   * start failing for a reason that has nothing to do with it. Concurrency is
   * what the test was always about, so concurrency is what it measures: the
   * taps still may not produce a second simultaneous sync, and now nothing else
   * may either.
   */
  test('refresh force-syncs the draft and rebuilds the board', async ({ page }) => {
    let syncs = 0;
    let concurrent = 0;
    let mostAtOnce = 0;
    let boards = 0;
    await page.route('**/api/drafts/*/sync', async (route) => {
      syncs++;
      concurrent++;
      mostAtOnce = Math.max(mostAtOnce, concurrent);
      // Long enough that a second tap lands while the first is in flight.
      await new Promise((resolve) => setTimeout(resolve, 600));
      concurrent--;
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

    const syncsBefore = syncs;
    const refresh = page.getByTestId('draft-refresh');
    await refresh.click();
    // Repeated taps while it is working must not queue a second sync.
    await refresh.dispatchEvent('click');
    await refresh.dispatchEvent('click');
    await expect(refresh).toBeEnabled();

    expect(mostAtOnce, 'never two Sleeper syncs in flight at once').toBe(1);
    expect(syncs - syncsBefore, 'three taps do not become three requests').toBeLessThanOrEqual(2);
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

  /**
   * Finding one player on a board of hundreds.
   *
   * The search filters what is drawn and touches nothing else: the order, the
   * scores and who is available are the board's, and a row keeps the rank it
   * has on the whole board rather than being renumbered to 1 by the filter.
   */
  test.describe('search', () => {
    /*
     * The field is folded into a glyph until it is asked for — see
     * SearchFilterRow. Unfolding it is a presentation change and nothing else,
     * which is what the rest of this block is about: every claim here predates
     * the fold and none of them changed.
     */
    async function openSearch(page: Page) {
      await page.getByTestId('draft-search-open').click();
      await expect(page.getByTestId('draft-search')).toBeVisible();
    }

    test('filters the board to what was typed, keeping real board ranks', async ({ page }) => {
      await openSearch(page);
      const search = page.getByTestId('draft-search');
      await expect(search).toBeVisible();

      const before = await page.getByTestId('recommendation-row').count();
      await search.fill('sotelo');

      const rows = page.getByTestId('recommendation-row');
      await expect(rows).toHaveCount(1);
      await expect(rows.first().locator('.player-name')).toHaveText('Andre Sotelo');
      // The rank is his place on the board, not his place in the result.
      expect(Number(await rows.first().locator('.rank').innerText())).toBeGreaterThan(1);

      // Clearing puts the board back exactly as it was.
      await page.getByTestId('search-clear').click();
      await expect(page.getByTestId('recommendation-row')).toHaveCount(before);
    });

    test('matches on either name, in any order, ignoring punctuation', async ({ page }) => {
      await openSearch(page);
      const search = page.getByTestId('draft-search');
      await search.fill('brennan kai');
      await expect(page.getByTestId('recommendation-row')).toHaveCount(1);
      await expect(page.getByTestId('recommendation-row').first().locator('.player-name')).toHaveText('Kai Brennan');
      await search.fill('');
    });

    test('reaches past the forty rows the board opens with', async ({ page }) => {
      // Somebody outside the default slice: the search asks for a deeper one
      // rather than pretending he is not there.
      const board = await (await page.request.get('/api/drafts/demo-draft/board?limit=250')).json();
      const deep = board.recommendations[board.recommendations.length - 1] as { name: string };
      expect(board.recommendations.length).toBeGreaterThan(0);

      await openSearch(page);
      await page.getByTestId('draft-search').fill(deep.name);
      await expect(page.getByTestId('recommendation-row').first().locator('.player-name')).toHaveText(deep.name);
      await page.getByTestId('draft-search').fill('');
    });

    test('says so plainly when nobody matches, and changes no state', async ({ page }) => {
      await openSearch(page);
      await page.getByTestId('draft-search').fill('zzzznobody');
      await expect(page.getByTestId('recommendation-row')).toHaveCount(0);
      await expect(page.getByText(/Nobody available matching/)).toBeVisible();
      await page.getByTestId('draft-search').fill('');
      await expect(page.getByTestId('recommendation-row').first()).toBeVisible();
    });

    test('draws no tier line across a filtered result', async ({ page }) => {
      await page.getByRole('button', { name: 'QB', exact: true }).click();
      await expect(page.getByTestId('tier-divider')).toHaveCount(1);
      await openSearch(page);
      await page.getByTestId('draft-search').fill('a');
      // A line between two rows that are not adjacent on the board would be
      // claiming a boundary that is not there.
      await expect(page.getByTestId('tier-divider')).toHaveCount(0);
      // Cancelling puts the row back exactly as it was, filter and all.
      await page.getByTestId('draft-search-close').click();
      await expect(page.getByRole('button', { name: 'QB', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('tier-divider')).toHaveCount(1);
      await page.getByRole('button', { name: 'ALL', exact: true }).click();
    });
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

  /**
   * The header is the league's name, and nothing else.
   *
   * It used to carry the season, the team count and the scoring format under
   * the name, with a row of badges under that repeating the flex count and the
   * passing-TD rule. None of it changes what to do this week and all of it cost
   * rows of a phone screen before the first player appeared. The settings still
   * drive every number below — see the scoring-profile assertion at the end.
   */
  test('shows the league title alone in the header', async ({ page }) => {
    const card = page.getByTestId('league-card').first();
    await expect(card).toContainText('Demo Dynasty');
    // And no control at all: choosing a league lives in Setup, and reloading
    // this one is a pull down the screen rather than a button in the corner
    // furthest from a thumb.
    await expect(card.getByRole('button')).toHaveCount(0);

    const header = (await card.innerText()).toLowerCase();
    for (const gone of ['half ppr', 'ppr', 'teams', '2026', 'flex slot', 'pt passing']) {
      expect(header, `the header still prints "${gone}"`).not.toContain(gone);
    }

    // ...and the settings it stopped printing are still the ones being used.
    const lineup = await (await page.request.get('/api/leagues/demo-league/lineup')).json();
    expect(lineup.league.scoringLabel).toBe('Half PPR');
    expect((lineup.slots as { slot: string }[]).map((s) => s.slot)).toContain('FLEX');
  });

  test('lists recommended starters by slot, then the bench', async ({ page }) => {
    await expect(page.getByTestId('starters-title')).toBeVisible();
    // Seven slots: QB, RB, RB, WR, WR, TE, FLEX — the league's own shape.
    expect(await page.getByTestId('starter-row').count()).toBe(7);

    // The bench is behind its own chevron now, so that the starters fit on one
    // phone screen. It still says how many are back there before it is opened,
    // and it still holds them.
    const toggle = page.getByTestId('bench-toggle');
    await expect(toggle).toBeVisible();
    expect(await page.getByTestId('bench-row').count()).toBe(0);
    await toggle.click();
    expect(await page.getByTestId('bench-row').count()).toBeGreaterThan(0);
  });

  test('compares two players and explains the recommendation', async ({ page }) => {
    await page.getByTestId('compare-open').click();
    await choose(page, '1001');
    await choose(page, '1004');
    await page.getByTestId('compare-run').click();

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

  /**
   * A player who is out does not go in a starting slot.
   *
   * The availability penalty already made him last by a mile, which is enough
   * when there is anybody else and is not enough in the case that matters — a
   * thin bench, where the arithmetic still puts him somewhere. Nate Kowalski is
   * on IR and is one of two tight ends on this roster, which is exactly that
   * case.
   */
  test('keeps a player who is out of the recommended lineup, and says so', async ({ page }) => {
    const lineup = await (await page.request.get('/api/leagues/demo-league/lineup')).json();
    const started = (lineup.slots as { playerId: string | null }[]).map((s) => s.playerId);
    expect(started, 'Kowalski is on IR').not.toContain('1009');

    const warnings = (lineup.warnings as string[]).join(' | ').toLowerCase();
    expect(warnings, 'and the reason is stated rather than left to be inferred').toContain('not a playable starter');
    expect(warnings).toContain('kowalski');
  });

  /**
   * A comparison names the injury rather than leaving "Questionable" to speak
   * for itself.
   *
   * Sotelo is Questionable in both sources with a hamstring, and practised
   * fully by the latest week — which is the whole difference between two
   * players who carry the same word, and the reason the practice report is
   * worth ingesting at all.
   */
  test('names the injury and the practice week in a start/sit comparison', async ({ page }) => {
    await page.getByTestId('compare-open').click();
    await choose(page, '1001');
    await choose(page, '1004');
    await page.getByTestId('compare-run').click();

    const line = page.getByTestId('startsit-injury');
    await expect(line).toContainText(/hamstring/i);
    await expect(line).toContainText(/full|limited/i);

    /*
     * And the penalty it produced is contextual rather than the flat 1.5 the
     * word used to cost: a full participant keeps most of his score.
     */
    const comparison = await (
      await page.request.post('/api/startsit/compare', { data: { playerIds: ['1001', '1004'] } })
    ).json();
    const sotelo = (comparison.evaluations as { playerId: string; ruledOut: boolean; components: { key: string; value: number }[] }[]).find(
      (e) => e.playerId === '1004',
    )!;
    const availability = sotelo.components.find((c) => c.key === 'status')!;
    expect(availability.value).toBeLessThan(0);
    expect(availability.value, 'a full participant keeps most of his score').toBeGreaterThan(-1.5);
    expect(sotelo.ruledOut, 'Questionable is a question, not a gate').toBe(false);
  });

  test('shows a degraded, honest state when Vegas data is missing', async ({ page }) => {
    // Cal Whitfield (1011) is rostered but has no props in the mock game.
    await page.getByTestId('compare-open').click();
    await choose(page, '1001');
    await choose(page, '1011');
    await page.getByTestId('compare-run').click();

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

  /**
   * The same player, the same way, on both screens.
   *
   * A card here opens in place exactly as a draft card does, and carries what
   * the draft card carries — the outlook, last season, the injury — as well as
   * everything only this screen has: the four windows, the categories, the
   * market lines and every piece of evidence.
   */
  test('opens a player in place, with the whole file inside it', async ({ page }) => {
    const row = page.locator('[data-testid="player-search-row"][data-player-id="1004"]');
    await row.scrollIntoViewIfNeeded();
    await row.click();

    const file = row.getByTestId('player-file');
    await expect(file).toBeVisible();
    // What the draft card shows…
    await expect(row.getByTestId('outlook')).toBeVisible();
    await expect(row.getByTestId('last-season')).toBeVisible();
    // …and what only this screen has.
    await expect(row.getByRole('cell', { name: 'Season' })).toBeVisible();
    await expect(row.getByTestId('evidence-heading')).toBeVisible();
    await expect(row.getByText(/Vegas props/)).toBeVisible();

    // It is a disclosure, not a screen: no Back, and the list is still here.
    await expect(page.getByTestId('back-button')).toHaveCount(0);
    expect(await page.getByTestId('player-search-row').count()).toBeGreaterThan(1);

    await row.locator('.row-button').click();
    await expect(row.getByTestId('player-file')).toHaveCount(0);
  });

  /**
   * Availability, said the same way it is said on the board.
   *
   * `Active` was a badge reading "Active" and Questionable was one reading
   * "Questionable" — the same fact, three times the width, in a different
   * vocabulary from the screen next door. Healthy players now carry nothing and
   * a questionable one carries `Q`.
   */
  test('tags availability with the board’s own letters, or nothing at all', async ({ page }) => {
    // `evaluateAll` does not wait, and the list arrives after a debounce.
    await expect(page.getByTestId('player-search-row').first()).toBeVisible();
    const tagged = await page
      .getByTestId('player-search-row')
      .evaluateAll((rows) =>
        rows.map((r) => ({
          name: r.querySelector('.player-name')?.textContent ?? '',
          tag: r.querySelector('[data-testid="injury-tag"]')?.getAttribute('data-status') ?? null,
          text: r.textContent ?? '',
        })),
      );
    const byName = new Map(tagged.map((t) => [t.name, t]));

    expect(byName.get('Andre Sotelo')?.tag).toBe('Q');
    expect(byName.get('Julian Reyes')?.tag).toBe('OUT');
    expect(byName.get('Marcus Vance')?.tag, 'a healthy player carries nothing').toBeNull();

    // And the long-form words are gone from the rows entirely.
    for (const row of tagged) {
      expect(row.text, `"${row.name}" still says Questionable in words`).not.toContain('Questionable');
      expect(row.text).not.toContain('Active');
    }
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
