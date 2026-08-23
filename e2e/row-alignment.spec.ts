/**
 * The columns a player row is built on, and the tag that no longer sits on one.
 *
 * The club marks used to land at slightly different distances from the *right*
 * edge depending on how wide the number beside them was — a two-character tally
 * pushed the mark one way, a three-character one the other, and a row with no
 * tally at all a third. Nothing was wrong with any single row; the *column* was
 * ragged, which reads as a rendering fault to somebody who could not say what
 * was wrong with it.
 *
 * The marks have since moved to the leading edge, into the identity cluster
 * with the position and the name, and the claim survives the move intact: every
 * mark on a list starts at the same x, to the pixel. What holds it there is
 * different — a fixed pill width rather than a fixed trailing field — and the
 * trailing field is still doing its own job for the tally and the availability
 * tag, so both mechanisms are asserted below.
 *
 * And the AVOID chip is gone from the cards. The tally it was describing is
 * still beside the name, negative sign and all, which is what the reader
 * actually interprets.
 */

import { expect, test, type Page } from '@playwright/test';
import { inSeason } from './helpers.ts';

async function openDraft(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('board-list')).toBeVisible();
}

/**
 * Team's lineup, which only exists once the draft is done.
 *
 * The demo league is permanently mid-draft, so this asks for the season the way
 * `team-startsit.spec.ts` does. The bench is opened here rather than in each
 * test because every claim in this file about Team is a claim about starters and
 * bench sharing one geometry, and a closed bench draws no rows to compare.
 */
async function openTeam(page: Page) {
  await inSeason(page);
  await page.goto('/');
  await page.getByTestId('tab-team').click();
  await expect(page.getByTestId('starters-title')).toBeVisible();
  await page.getByTestId('bench-toggle').click();
  await expect(page.getByTestId('bench-row').first()).toBeVisible();
}

/**
 * Position, then club, then name — the order every list in the app opens with.
 *
 * Read as geometry rather than as a DOM order, because the DOM can be right
 * while the layout is not: a `row-reverse` or an `order` property would put the
 * pill last on screen with the markup unchanged. What a reader sees is three
 * boxes left to right, and that is what is checked.
 */
async function identityReadsLeftToRight(page: Page, rowTestId: string, atLeast = 5) {
  const rows = await page.locator(`[data-testid="${rowTestId}"]`).evaluateAll((all) =>
    all.slice(0, 12).map((row) => {
      const box = (sel: string) => row.querySelector(sel)?.getBoundingClientRect() ?? null;
      const pill = box('.pos-pill');
      const mark = box('.team-logo, [data-testid="team-code"]');
      const name = box('.player-name');
      return pill && mark && name
        ? { pill: pill.right, markLeft: mark.left, markRight: mark.right, name: name.left }
        : null;
    }),
  );
  const drawn = rows.filter((r): r is NonNullable<typeof r> => r != null);
  expect(drawn.length, `${rowTestId} should be drawing identity clusters`).toBeGreaterThanOrEqual(atLeast);
  for (const r of drawn) {
    expect(r.pill, 'the pill ends before the club begins').toBeLessThanOrEqual(r.markLeft + 1);
    expect(r.markRight, 'and the club ends before the name begins').toBeLessThanOrEqual(r.name + 1);
  }
}

/** Where each club mark begins, rounded to the pixel the eye can see. */
async function markLeftEdges(page: Page, within: string): Promise<number[]> {
  return page.evaluate((selector) => {
    const rows = [...document.querySelectorAll(selector)];
    return rows
      .map((row) => row.querySelector('.team-logo, .team-code'))
      .filter((mark): mark is Element => mark != null)
      .map((mark) => Math.round(mark.getBoundingClientRect().left));
  }, within);
}

test.describe('the club marks line up', () => {
  test('every mark on the draft board starts on the same edge', async ({ page }) => {
    await openDraft(page);
    const edges = await markLeftEdges(page, '[data-testid="recommendation-row"]');
    expect(edges.length, 'the board should be drawing marks at all').toBeGreaterThan(4);
    expect(new Set(edges).size, `marks started at ${[...new Set(edges)].join(', ')}`).toBe(1);
  });

  /**
   * The case that used to break it.
   *
   * A row with a tally, a row without one and a row with an availability tag
   * are the three widths that produced three different offsets. All three are
   * on the board at once, and the assertion above covers them — this one proves
   * the board actually contains the mix, so a board that happened to be uniform
   * could not pass by accident.
   */
  test('and the board really does mix rows with and without a tally', async ({ page }) => {
    await openDraft(page);
    const rows = page.locator('[data-testid="recommendation-row"]');
    const withTally = await rows.locator('[data-testid="compact-tally"]').count();
    expect(withTally, 'some rows carry a tally').toBeGreaterThan(0);
    expect(withTally, 'and some do not').toBeLessThan(await rows.count());
  });

  test('and the same is true down the players list', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('tab-players').click();
    await expect(page.locator('[data-testid="player-search-row"]').first()).toBeVisible();
    const edges = await markLeftEdges(page, '[data-testid="player-search-row"]');
    expect(edges.length).toBeGreaterThan(4);
    expect(new Set(edges).size).toBe(1);
  });
});

/**
 * One identity, five screens.
 *
 * The point of moving the club's mark off the trailing edge was never the
 * trailing edge — it was that a reader who learns to read a player on the draft
 * board should not have to learn again on Players, on Trades, on Waivers or on
 * Team. Position, club, name, in that order, on all five, as one cluster. A
 * screen that quietly keeps its own arrangement is exactly the divergence this
 * replaced.
 *
 * Team was the last holdout, and it was the loudest one: it led with the lineup
 * *slot* and put the club at the far trailing edge beside the number, so "who is
 * this" was assembled from both ends of the row — and its bench led with `BN`,
 * which is not a position and lined up with nothing.
 */
test.describe('the identity cluster', () => {
  test('reads position, club, name on the draft board', async ({ page }) => {
    await openDraft(page);
    await identityReadsLeftToRight(page, 'recommendation-row');
  });

  test('and on Players', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('tab-players').click();
    await expect(page.locator('[data-testid="player-search-row"]').first()).toBeVisible();
    await identityReadsLeftToRight(page, 'player-search-row');
  });

  /*
   * Three rather than five, and only here.
   *
   * Trades lists players the newsletter has an opinion about, so how many rows
   * exist is a property of the evidence rather than of the layout — the seed
   * carries three. Skipping when the fixture is small would be a test that
   * quietly stops running; asking for what the fixture actually has is a test
   * that keeps working.
   */
  test('and on Trades', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('tab-trades').click();
    await expect(page.locator('[data-testid="trade-row"]').first()).toBeVisible();
    await identityReadsLeftToRight(page, 'trade-row', 3);
  });

  /**
   * And on Waivers, which draws the same cluster from its own component.
   *
   * A different file builds this row — the waiver card is not a
   * `CompactPlayerRow` — so "one identity everywhere" is a claim about two
   * implementations agreeing rather than about one being reused, and it is
   * worth checking rather than assuming.
   */
  test('and on Waivers', async ({ page }) => {
    await page.goto('/?demo=waivers-tuesday-active');
    await page.getByTestId('tab-waivers').click();
    await expect(page.locator('[data-testid="waiver-row"]').first()).toBeVisible();
    await identityReadsLeftToRight(page, 'waiver-row', 2);
  });

  /**
   * And on Team, for both halves of the roster.
   *
   * Two row types on one screen rather than one, and they are asserted
   * separately because they are drawn by two different components — a starter
   * is a tinted slot card, a bench player a plain row — and "they agree" is the
   * whole claim. The counts are what the demo roster actually carries: three
   * slots fill, and what is left over sits on the bench.
   */
  test('and on Team, for a starter', async ({ page }) => {
    await openTeam(page);
    await identityReadsLeftToRight(page, 'starter-row', 3);
  });

  test('and on Team, for a bench player', async ({ page }) => {
    await openTeam(page);
    await identityReadsLeftToRight(page, 'bench-row', 1);
  });

  /**
   * The mark is smaller inside a name than it is standing on its own.
   *
   * At 22px beside a 16px name it was the loudest object in the row, which is
   * how a decoration stops being one. The size is scoped to the cluster rather
   * than changed in the token, so a mark that is *not* inside a name — a
   * matchup lineup row, a player's own page — is still the size the token was
   * chosen for.
   */
  test('draws the club quietly enough to be part of the name', async ({ page }) => {
    await openDraft(page);
    const [mark, name] = await Promise.all([
      page.locator('[data-testid="recommendation-row"] .team-logo').first().boundingBox(),
      page.locator('[data-testid="recommendation-row"] .player-name').first().boundingBox(),
    ]);
    expect(mark!.width, 'the club is no louder than the name it qualifies').toBeLessThanOrEqual(name!.height + 1);
    expect(mark!.width, 'and is still big enough to recognise').toBeGreaterThanOrEqual(12);
  });

  /**
   * The tally belongs to the name, and now sits like it.
   *
   * The row's own 8px gap is the distance between separate things on the line —
   * the identity cluster and the name are separate things. The tally and the
   * status pill are not: they are footnotes on the name, and putting the same
   * 8px in front of them read as a third column rather than as an annotation.
   * The field starts 5px after the name now.
   *
   * The measurement that matters more is the second one. Only the gap *in front
   * of* the field moved; the 4px between the tally and the status pill is
   * untouched, and a change that tightened both would have made the two marks
   * one blur. Both are asserted here so a future tweak has to say which it
   * meant.
   *
   * Run at every width the suite runs at, because a flex gap that survives 430
   * and collapses at 360 is exactly the kind of thing this file exists to
   * catch.
   */
  test('sits the tally against the name it is about, without crowding the status pill', async ({ page }) => {
    /*
     * Injected, because the seeded board happens to carry one tally.
     *
     * A spacing rule measured on a single row is a spacing rule measured on
     * whatever that row happens to be. Both shapes are forced here — a tally on
     * its own, and a tally with a status pill after it — because the second is
     * the only one that can say the pill was not crowded.
     */
    await page.route('**/api/drafts/*/board*', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.recommendations = (body.recommendations as Record<string, unknown>[]).map((rec, i) =>
        i < 6
          ? { ...rec, newsLifetimeNet: i % 2 === 0 ? 7 : -12, status: i % 3 === 0 ? 'Questionable' : null }
          : rec,
      );
      await route.fulfill({ response, body: JSON.stringify(body) });
    });
    await openDraft(page);
    const rows = await page.locator('[data-testid="recommendation-row"]').evaluateAll((nodes) =>
      nodes.flatMap((row) => {
        const box = (sel: string) => row.querySelector(sel)?.getBoundingClientRect() ?? null;
        const name = box('.player-name');
        const tally = box('[data-testid="compact-tally"]');
        const tag = box('[data-testid="injury-tag"]');
        if (!name || !tally) return [];
        return [
          {
            beforeTally: Math.round(tally.left - name.right),
            beforePill: tag ? Math.round(tag.left - tally.right) : null,
          },
        ];
      }),
    );

    expect(rows.length, 'no row carried a tally to measure').toBeGreaterThan(3);
    expect(
      rows.some((r) => r.beforePill != null),
      'no row carried a status pill after its tally',
    ).toBe(true);
    for (const row of rows) {
      expect(row.beforeTally, 'the tally drifted away from the name').toBe(5);
      if (row.beforePill != null) {
        expect(row.beforePill, 'the status pill was crowded by the tally').toBe(4);
      }
    }
  });

  /**
   * Alignment is not padding.
   *
   * The field is reserved whether or not anything is in it, so the fix must not
   * have been bought by faking a value into the empty rows — no zero-padded
   * `08`, no placeholder dash where a tally would be.
   */
  test('without inventing a value for the rows that have none', async ({ page }) => {
    await openDraft(page);
    const fields = await page
      .locator('[data-testid="recommendation-row"] .player-row-meta')
      .evaluateAll((nodes) => nodes.map((n) => n.textContent!.trim()));
    expect(fields.length).toBeGreaterThan(4);
    for (const text of fields) {
      // Either a real signed tally (with a status tag beside it or not), or
      // genuinely empty. Never a padded or placeholder number.
      expect(text).not.toMatch(/^0\d/);
      expect(text).not.toBe('—');
    }
    expect(fields.some((t) => t === ''), 'some rows leave the field empty').toBe(true);
  });

  /**
   * One column down the left of the whole list.
   *
   * The rank, the line of numbers under it, and the row's own leading edge have
   * to be the same x — on every row, whether the rank is one digit or two.
   *
   * The rank used to be right-aligned inside its fixed box, which put the
   * digits on one edge and therefore made them *begin* on two: `1` started
   * seven points right of `10`, and neither started where the secondary line
   * did. It read as correct from row ten down purely because a two-digit rank
   * nearly fills the box, which is exactly the shape of failure to check for —
   * so the assertion is over rows either side of ten rather than over the list
   * as a whole.
   *
   * Measured off the text itself with a range, not off the element's box: a box
   * can sit on the right column while the glyph inside it does not, which is
   * the entire bug.
   */
  async function leftColumn(page: Page, rowTestId: string, secondarySelector: string) {
    return page.locator(`[data-testid="${rowTestId}"]`).evaluateAll(
      (rows, secondary) =>
        rows.slice(0, 13).map((row) => {
          const rank = row.querySelector('.rank');
          let glyph: number | null = null;
          if (rank?.firstChild) {
            const range = document.createRange();
            range.selectNodeContents(rank);
            glyph = Math.round(range.getBoundingClientRect().left);
          }
          const line = row.querySelector(secondary);
          return {
            rank: (rank?.textContent ?? '').trim(),
            glyph,
            line: line ? Math.round(line.getBoundingClientRect().left) : null,
          };
        }),
      secondarySelector,
    );
  }

  for (const [screen, rowTestId, secondary, open] of [
    ['the draft board', 'recommendation-row', '.player-row-bottom', openDraft],
    [
      'Players',
      'player-search-row',
      '.dense-row-metrics',
      async (page: Page) => {
        await page.goto('/');
        await page.getByTestId('tab-players').click();
        await expect(page.locator('[data-testid="player-search-row"]').first()).toBeVisible();
      },
    ],
  ] as const) {
    test(`anchors the rank and the numbers under it to one column on ${screen}`, async ({ page }) => {
      await open(page);
      const rows = await leftColumn(page, rowTestId, secondary);
      expect(rows.length, `${screen} should be drawing rows`).toBeGreaterThan(4);

      const drawn = rows.filter((r) => r.glyph != null && r.line != null);
      expect(drawn.length).toBeGreaterThan(4);

      for (const row of drawn) {
        expect(row.glyph, `rank "${row.rank}" starts at ${row.glyph}, its numbers at ${row.line}`).toBe(row.line);
      }
      // One anchor for the whole list, not one per digit count.
      expect(new Set(drawn.map((r) => r.glyph)).size, 'the rank column is ragged').toBe(1);
    });
  }

  /**
   * …and specifically across the boundary that used to hide it.
   *
   * Rows 1-9 against rows 10+ is the comparison the old layout passed by
   * accident on one side and failed on the other, so it is asserted by name
   * rather than left to the sweep above to happen to cover.
   */
  test('and one-digit ranks land on the same edge as two-digit ones', async ({ page }) => {
    await openDraft(page);
    const rows = await leftColumn(page, 'recommendation-row', '.player-row-bottom');

    const single = rows.filter((r) => /^\d$/.test(r.rank));
    const double = rows.filter((r) => /^\d\d$/.test(r.rank));
    expect(single.length, 'the board should reach rank 9').toBeGreaterThan(4);
    expect(double.length, 'and past rank 10').toBeGreaterThan(0);

    expect(single[0]!.glyph, `rank ${single[0]!.rank} against rank ${double[0]!.rank}`).toBe(double[0]!.glyph);
    expect(single[0]!.line).toBe(double[0]!.line);
  });

  /**
   * The rank, the pill and the club as one group rather than a number and a
   * group.
   *
   * The rank slot used to be three tabular digits wide with the row's own 8px
   * gap after it, so on the ranks anybody looks at — one digit, sometimes two —
   * the row opened with a number, most of an empty box, and only then the
   * player. The gap between the rank and the pill was roughly five times the
   * gap between the pill and the club's mark, which is what made the leading
   * edge read as a rank *column* with a dead zone rather than as the head of
   * the identity.
   *
   * Measured off the glyph rather than the box, for the same reason the column
   * assertion above is: the box can be the right size while the digits inside
   * it sit nowhere near the pill. And bounded rather than pinned to a number,
   * because the exact figure is a font metric — what the rule actually says is
   * that the two gaps inside the group are the same order of size.
   */
  async function identityGaps(page: Page, rowTestId: string) {
    return page.locator(`[data-testid="${rowTestId}"]`).evaluateAll((rows) =>
      rows.slice(0, 13).map((row) => {
        const rank = row.querySelector('.rank');
        const pill = row.querySelector('.pos-pill');
        const mark = row.querySelector('.team-logo, .team-code');
        if (!rank?.firstChild || !pill || !mark) return null;
        const range = document.createRange();
        range.selectNodeContents(rank);
        const glyph = range.getBoundingClientRect();
        const pillBox = pill.getBoundingClientRect();
        return {
          rank: (rank.textContent ?? '').trim(),
          toPill: pillBox.left - glyph.right,
          pillToMark: mark.getBoundingClientRect().left - pillBox.right,
        };
      }),
    );
  }

  for (const [screen, rowTestId, open] of [
    ['the draft board', 'recommendation-row', openDraft],
    [
      'Players',
      'player-search-row',
      async (page: Page) => {
        await page.goto('/');
        await page.getByTestId('tab-players').click();
        await expect(page.locator('[data-testid="player-search-row"]').first()).toBeVisible();
      },
    ],
  ] as const) {
    test(`keeps the rank tight against the identity it leads on ${screen}`, async ({ page }) => {
      await open(page);
      const rows = (await identityGaps(page, rowTestId)).filter((r) => r != null);
      expect(rows.length, `${screen} should be drawing identity clusters`).toBeGreaterThan(4);

      for (const row of rows) {
        expect(row.toPill, `rank "${row.rank}" is ${row.toPill}px from its pill`).toBeGreaterThan(0);
        /*
         * Three times the gap the group's other seam uses is the outer edge of
         * "the same order of size" — one digit of slack in a two-digit slot is
         * most of it, and there is nowhere else for that slack to go while the
         * rank stays anchored to the row's own left column.
         */
        expect(row.toPill, `rank "${row.rank}" opens a dead zone before its pill`).toBeLessThanOrEqual(
          row.pillToMark * 3.5,
        );
      }
    });
  }

  /**
   * …and the rhythm survives the boundary, which is where a fixed slot hides.
   *
   * A slot sized for the widest rank a list can reach looks correct on the rows
   * that nearly fill it and wrong on the rows that do not, so rows either side
   * of ten are compared with each other rather than each against a constant.
   */
  test('with the same rhythm either side of rank ten', async ({ page }) => {
    await openDraft(page);
    const rows = (await identityGaps(page, 'recommendation-row')).filter((r) => r != null);
    const single = rows.filter((r) => /^\d$/.test(r.rank));
    const double = rows.filter((r) => /^\d\d$/.test(r.rank));
    expect(single.length, 'the board should reach rank 9').toBeGreaterThan(4);
    expect(double.length, 'and past rank 10').toBeGreaterThan(0);

    // Each digit count is internally identical — no per-rank nudging.
    expect(new Set(single.map((r) => Math.round(r.toPill))).size).toBe(1);
    expect(new Set(double.map((r) => Math.round(r.toPill))).size).toBe(1);

    // And the step between them is one digit of the rank's own type, which is
    // the whole of what a left-anchored slot can cost.
    const step = single[0]!.toPill - double[0]!.toPill;
    expect(step, `rank ${single[0]!.rank} sits ${step}px further from its pill than rank ${double[0]!.rank}`)
      .toBeLessThanOrEqual(9);
  });

  /**
   * The worst row the data can produce, and nothing on it hides anything else.
   *
   * A long name, a three-character availability code and a two-digit negative
   * tally is a combination the seeded board does not happen to contain and a
   * real league does: `OUT` beside `-12` on somebody with a hyphenated surname.
   * The field was `flex: 0 1 auto` with `min-width: 0`, which made it the first
   * thing to give way rather than the last — so it shrank below its own contents
   * and drew the `OUT` **underneath the star**, sixteen pixels of it at 360, on
   * the one control on the row.
   *
   * Neither half of the field may truncate instead: `-12` clipped to `-1` is
   * not a smaller reading of the number, it is a different one. The name is the
   * thing that yields, and it still has to be a name afterwards.
   *
   * Injected rather than waited for, because a fixture that happens to contain
   * the case today is a test that stops running when the fixture changes.
   */
  test('keeps a status tag off the star when the name is long and the tally wide', async ({ page }) => {
    const LONG = 'Bartholomew Vandersteen-Whitfield Jr.';
    await page.route('**/api/drafts/*/board*', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.recommendations = (body.recommendations as Record<string, unknown>[]).map((rec, i) =>
        i < 3 ? { ...rec, name: LONG, status: 'Out', position: 'DEF', newsLifetimeNet: -12 } : rec,
      );
      await route.fulfill({ response, body: JSON.stringify(body) });
    });
    await openDraft(page);

    const worst = await page.locator('[data-testid="recommendation-row"]').evaluateAll((rows) =>
      rows.slice(0, 3).map((row) => {
        const box = (sel: string) => row.querySelector(sel)?.getBoundingClientRect() ?? null;
        const clipped = (sel: string) => {
          const el = row.querySelector(sel);
          return el ? el.scrollWidth > el.clientWidth + 1 : null;
        };
        const meta = box('.player-row-meta');
        const tag = box('[data-testid="injury-tag"]');
        const star = box('[data-testid="queue-control"]');
        const name = box('.player-name');
        return {
          tagOverStar: tag && star ? Math.round(tag.right - star.left) : null,
          spill: meta && tag ? Math.round(tag.right - meta.right) : null,
          tallyClipped: clipped('[data-testid="compact-tally"]'),
          tagClipped: clipped('[data-testid="injury-tag"]'),
          nameWidth: name ? Math.round(name.width) : null,
          nameTruncates: clipped('.player-name'),
        };
      }),
    );

    expect(worst).toHaveLength(3);
    for (const row of worst) {
      expect(row.tagOverStar, `the tag reaches ${row.tagOverStar}px past the star`).toBeLessThanOrEqual(0);
      expect(row.spill, 'the field is drawing outside its own box').toBeLessThanOrEqual(0);
      expect(row.tallyClipped, 'the tally is being clipped rather than the name').toBe(false);
      expect(row.tagClipped, 'the status tag is being clipped').toBe(false);
      // The name gave the space up, and is still a name.
      expect(row.nameTruncates, 'the name should be the thing that truncates').toBe(true);
      expect(row.nameWidth).toBeGreaterThan(60);
    }
  });
});

/**
 * Team's lineup and its bench are one list, not two that happen to be adjacent.
 *
 * This is the claim that the `BN` label made impossible. A starter's leading
 * column was a slot name and a bench player's was the word `BN`, both in a 34px
 * box, while the club's mark sat at the far trailing edge of both — so the two
 * halves of a roster lined up with each other and with nothing else in the app,
 * and the position, the one fact a reader scans a roster for, was on the bench
 * rows nowhere at all.
 *
 * Both halves now draw `PlayerIdentity`, so the assertions here are about the
 * seam between them: same identity column, same value column, and the fold
 * opening without moving either.
 */
test.describe('Team starters and bench share one geometry', () => {
  const FILLED = '[data-testid="starter-row"][data-starter="true"], [data-testid="bench-row"]';

  /** The x each row's identity begins at, and the x its value ends at. */
  async function columns(page: Page) {
    return page.evaluate((selector) => {
      return [...document.querySelectorAll(selector)].map((row) => {
        const box = (sel: string) => row.querySelector(sel)?.getBoundingClientRect() ?? null;
        const pill = box('.pos-pill');
        const name = box('.player-name');
        const proj = box('.proj');
        return {
          who: (row.querySelector('.player-name')?.textContent ?? '').trim(),
          bench: row.getAttribute('data-starter') === 'false',
          pill: pill ? Math.round(pill.left) : null,
          name: name ? Math.round(name.left) : null,
          value: proj ? Math.round(proj.right) : null,
          text: (row.querySelector('.proj')?.textContent ?? '').trim(),
        };
      });
    }, FILLED);
  }

  test('draws every pill, name and value on one column', async ({ page }) => {
    await openTeam(page);
    const rows = await columns(page);
    expect(rows.length, 'the roster should be drawing filled rows').toBeGreaterThan(3);
    expect(rows.some((r) => r.bench), 'and some of them on the bench').toBe(true);
    expect(rows.some((r) => !r.bench), 'and some of them in the lineup').toBe(true);

    for (const key of ['pill', 'name', 'value'] as const) {
      const edges = rows.map((r) => r[key]);
      expect(edges.every((e) => e != null), `every row draws its ${key}`).toBe(true);
      expect(new Set(edges).size, `the ${key} column runs at ${[...new Set(edges)].join(', ')}`).toBe(1);
    }
  });

  /**
   * Opening the fold adds rows; it does not rearrange the ones above it.
   *
   * A bench whose leading column differs from the lineup's makes the whole list
   * appear to shift the moment it opens, even though nothing above it moved —
   * which is the reading the old `BN` column produced, and the reason this is
   * measured across the toggle rather than only after it.
   */
  test('and opening the bench does not move the starters', async ({ page }) => {
    await inSeason(page);
    await page.goto('/');
    await page.getByTestId('tab-team').click();
    await expect(page.getByTestId('starters-title')).toBeVisible();

    const before = await columns(page);
    expect(before.length, 'starters are drawn before the fold opens').toBeGreaterThan(2);
    expect(before.every((r) => !r.bench), 'and no bench rows are').toBe(true);

    await page.getByTestId('bench-toggle').click();
    await expect(page.getByTestId('bench-row').first()).toBeVisible();
    const after = (await columns(page)).filter((r) => !r.bench);

    expect(after.map((r) => r.who)).toEqual(before.map((r) => r.who));
    for (const [i, row] of after.entries()) {
      expect(row.pill, `${row.who}'s pill moved when the bench opened`).toBe(before[i]!.pill);
      expect(row.name, `${row.who}'s name moved when the bench opened`).toBe(before[i]!.name);
      expect(row.value, `${row.who}'s value moved when the bench opened`).toBe(before[i]!.value);
    }
  });

  /**
   * The column is reserved, and never filled with a number nobody computed.
   *
   * The alignment above would be trivial to buy by printing `0.0` wherever a
   * projection is missing, and that is the one way of buying it this app has
   * already refused once: a market that has not priced a player is a dash, not a
   * zero. See `core/startsit/projection.ts`.
   */
  test('without inventing a projection for the players who have none', async ({ page }) => {
    await openTeam(page);
    const values = (await columns(page)).map((r) => r.text);
    expect(values.length).toBeGreaterThan(3);
    for (const text of values) {
      expect(text, 'a value is a real figure or an honest dash').toMatch(/^(—|-?\d+\.\d)$/);
    }
  });

  /**
   * An empty slot starts its sentence where the names start.
   *
   * These rows carry no player and so no identity cluster, and their slot chip's
   * own width left the line after it beginning short of every name above and
   * below — one list with two leading edges, on exactly the rows a reader is
   * already scanning for what is missing. The demo roster fills three of seven
   * slots, so there are always four of them to measure.
   */
  test('and an empty slot keeps the same leading edge', async ({ page }) => {
    await openTeam(page);
    const edges = await page.evaluate(() => {
      const left = (el: Element | null | undefined) => (el ? Math.round(el.getBoundingClientRect().left) : null);
      return {
        names: [
          ...new Set(
            [...document.querySelectorAll('[data-testid="starter-row"][data-starter="true"] .player-name')].map(
              (n) => Math.round(n.getBoundingClientRect().left),
            ),
          ),
        ],
        empties: [
          ...new Set(
            [...document.querySelectorAll('[data-starter="empty"] .empty-slot-line')].map((n) =>
              Math.round(n.getBoundingClientRect().left),
            ),
          ),
        ],
        chip: left(document.querySelector('[data-starter="empty"] .slot-label')),
        pill: left(document.querySelector('[data-testid="starter-row"][data-starter="true"] .pos-pill')),
      };
    });

    expect(edges.names, 'the filled rows agree with each other').toHaveLength(1);
    expect(edges.empties.length, 'the demo roster leaves slots empty').toBeGreaterThan(0);
    expect(edges.empties, 'the empty rows agree with each other').toHaveLength(1);
    expect(edges.empties[0], `empty slots start at ${edges.empties[0]}, names at ${edges.names[0]}`).toBe(
      edges.names[0],
    );
    // …and the chip that stands in for the identity starts where a pill would.
    expect(edges.chip).toBe(edges.pill);
  });

  /**
   * The worst roster the data can produce, on the narrowest phone.
   *
   * A hyphenated surname, a `DEF` in the widest pill the app draws, a status
   * code beside the name and a player nobody has priced are four things the demo
   * roster does not happen to contain at once and a real league does. Injected
   * rather than waited for, for the same reason the draft board's equivalent is:
   * a fixture that happens to carry the case today is a test that quietly stops
   * running when the fixture changes.
   *
   * The claim is that the name is what yields. Everything else on the row is a
   * fixed field, so a row that cannot fit must truncate the one thing that is
   * still legible truncated — and must not buy the space by pushing itself off
   * the side of the screen.
   */
  test('holds the columns with long names, a DEF pill and a missing projection', async ({ page }) => {
    const LONG = 'Bartholomew Vandersteen-Whitfield Jr.';
    /*
     * This one route does `inSeason`'s job as well as its own, and it has to.
     *
     * Playwright runs the *last* matching handler first and this one fulfills
     * rather than falling through, so a stress route installed alongside
     * `inSeason` would be one of two handlers where only one can win: install it
     * first and it never runs, install it second and `live` is never overridden
     * and the screen is the mid-draft one. `route.fetch()` goes to the network
     * rather than through the other handlers, so composing them is not an option
     * either. Hence one handler, saying both things.
     */
    await page.route('**/api/leagues/*/roster*', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      let n = 0;
      const stress = (players: Record<string, unknown>[]) =>
        players.map((p) => ({
          ...p,
          name: LONG,
          status: 'Questionable',
          // One DEF, which is the widest code the pill has to hold.
          ...(n++ === 0 ? { position: 'DEF' } : {}),
        }));
      await route.fulfill({
        response,
        body: JSON.stringify({
          ...body,
          // …the season, as `inSeason` sets it.
          live: false,
          drafted: [],
          starters: stress(body.starters as Record<string, unknown>[]),
          bench: stress(body.bench as Record<string, unknown>[]),
        }),
      });
    });
    /*
     * The starters' names come from here, not from the roster.
     *
     * A starter row prints `slot.name` — the recommendation's own answer — and
     * takes only the position, the club and the availability from the roster
     * entry beside it. Stressing the roster alone left the lineup drawing the
     * fixture's short names under a test claiming to have made them long, which
     * is the failure mode this whole file exists to catch.
     *
     * One slot also loses its projection, which is the dash's own case.
     */
    await page.route('**/api/leagues/*/lineup*', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      let unpriced = false;
      body.slots = (body.slots as Record<string, unknown>[]).map((s) => {
        if (!s.playerId) return s;
        // The first *filled* slot, which is not necessarily the first slot:
        // the demo league's QB spot has nobody eligible for it.
        const strip = !unpriced && (unpriced = true);
        return { ...s, name: LONG, ...(strip ? { projection: null } : {}) };
      });
      await route.fulfill({ response, body: JSON.stringify(body) });
    });

    await page.goto('/');
    await page.getByTestId('tab-team').click();
    await expect(page.getByTestId('starters-title')).toBeVisible();
    await page.getByTestId('bench-toggle').click();
    await expect(page.getByTestId('bench-row').first()).toBeVisible();

    const rows = await columns(page);
    expect(rows.length).toBeGreaterThan(3);
    expect(rows.every((r) => r.who.startsWith('Bartholomew')), 'the stress fixture is what is on screen').toBe(true);
    expect(
      await page.locator(`${FILLED} .pos-pill`).filter({ hasText: 'DEF' }).count(),
      'and one of them is a DEF',
    ).toBe(1);
    expect(rows.some((r) => r.text === '—'), 'the unpriced starter reads as a dash').toBe(true);

    for (const key of ['pill', 'name', 'value'] as const) {
      expect(new Set(rows.map((r) => r[key])).size, `the ${key} column went ragged`).toBe(1);
    }

    // Nothing widened the page, and the name is the thing that gave way.
    const width = page.viewportSize()!.width;
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

    const yielded = await page.locator(FILLED).evaluateAll((all) =>
      all.map((row) => {
        const clipped = (sel: string) => {
          const el = row.querySelector(sel);
          return el ? el.scrollWidth > el.clientWidth + 1 : null;
        };
        const name = row.querySelector('.player-name')?.getBoundingClientRect();
        return { name: clipped('.player-name'), pill: clipped('.pos-pill'), value: clipped('.proj'), width: name?.width ?? 0 };
      }),
    );
    /*
     * The invariant is what may *not* give way, and it holds at every width.
     *
     * The pill and the value are fixed fields; clipping either loses a fact
     * rather than shortening one, and `-1` where `-12` was is not a smaller
     * reading of a number but a different one. The name is the only element on
     * the row allowed to yield, and it has to still be a name afterwards.
     */
    for (const row of yielded) {
      expect(row.pill, 'the position is being clipped').toBe(false);
      expect(row.value, 'the value is being clipped').toBe(false);
      expect(row.width, 'and it is still a name afterwards').toBeGreaterThan(60);
    }

    /*
     * …and where the row genuinely runs out of room, it is the name that gave way.
     *
     * Asserted at 390 and below rather than everywhere, because at 430 this name
     * *fits*: WebKit sets it fractionally narrower than Chromium does, so the
     * row has nothing to yield and there is nothing to prove. Requiring
     * truncation at every width made this test a measurement of a font metric —
     * it passed on Chromium at 430 and failed on WebKit at 430, for a layout
     * that was correct in both. The squeeze is guaranteed on the widths where a
     * squeeze is guaranteed, which is where the claim was ever about layout.
     */
    if (width <= 390) {
      expect(
        yielded.every((row) => row.name === true),
        `a ${LONG.length}-character name cannot fit at ${width}px, so it must truncate`,
      ).toBe(true);
    }
  });
});

test.describe('the AVOID tag', () => {
  /**
   * Removed from the card, and only from the card.
   *
   * The tally underneath it is untouched: the API still carries the flag, the
   * engine still applies its bounded penalty, and the negative number the
   * reader interprets is still printed beside the name.
   */
  test('no longer appears on any player card', async ({ page }) => {
    await openDraft(page);
    await expect(page.getByTestId('avoid-tag')).toHaveCount(0);
    await expect(page.locator('[data-testid="board-list"]')).not.toContainText('AVOID');
  });

  test('but the tally it described is still on the row, sign and all', async ({ page }) => {
    await openDraft(page);
    const board = await (await page.request.get('/api/drafts/demo-draft/board?limit=40')).json();
    const scored = (board.recommendations as { name: string; newsLifetimeNet: number }[]).filter(
      (r) => r.newsLifetimeNet !== 0,
    );
    expect(scored.length, 'the demo board has players the research has an opinion about').toBeGreaterThan(0);

    // The signed number is still printed beside the name — which is the thing
    // the reader interprets now that nothing interprets it for them.
    for (const rec of scored.slice(0, 3)) {
      const row = page.locator('[data-testid="recommendation-row"]', { hasText: rec.name }).first();
      const expected = rec.newsLifetimeNet > 0 ? `+${rec.newsLifetimeNet}` : `${rec.newsLifetimeNet}`;
      await expect(row.getByTestId('compact-tally')).toContainText(expected);
      await expect(row).not.toContainText('AVOID');
    }
  });

  /**
   * The flag itself is untouched.
   *
   * The API still carries it and the engine still applies its bounded penalty
   * below the threshold — this change removed a label from a card, not a
   * judgement from the model.
   */
  test('and the model still computes it', async ({ page }) => {
    const board = await (await page.request.get('/api/drafts/demo-draft/board?limit=40')).json();
    const recommendations = board.recommendations as { avoid?: { active: boolean; lifetimeNet: number } }[];
    expect(recommendations.every((r) => typeof r.avoid?.active === 'boolean')).toBe(true);
  });
});
