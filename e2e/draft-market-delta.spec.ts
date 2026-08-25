/**
 * The market deltas on the compact draft row.
 *
 * The row stopped printing where each market has a player and started printing
 * what taking him *here* costs against it: `ADP +6` is six picks ahead of
 * Sleeper's market, `DOG -19` is nineteen picks past Underdog's. Three things
 * have to hold for that to be worth doing, and each of them is a test below:
 *
 *  1. the arithmetic is right and the sign means what it says — asserted here
 *     against the board's own JSON, so a passing test cannot be reading its own
 *     assumptions back;
 *  2. the raw markets are still reachable, because a delta a reader cannot
 *     check is a number they have to take on faith;
 *  3. **the sort still sorts on the raw values.** The displayed metric changed
 *     and the ordering must not have, which is the one way a presentation
 *     change here could quietly become a football change.
 */

import { expect, test, type Page } from '@playwright/test';

async function openDraft(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('board-list')).toBeVisible();
}

/** The board as the server sends it — the authority these assertions use. */
async function boardJson(page: Page) {
  const res = await page.request.get('/api/drafts/demo-draft/board?limit=40');
  return res.json() as Promise<{
    currentPick: number;
    recommendations: {
      playerId: string;
      name: string;
      adp: number | null;
      dogAdp: number | null;
      score: number | null;
      preseasonPoints?: number | null;
    }[];
  }>;
}

test.describe('the compact row shows market consequence', () => {
  /**
   * The delta on every row equals the board's own subtraction.
   *
   * Read from the API rather than recomputed from the screen, so this checks
   * the app against its own data instead of against itself.
   */
  test('prints market ADP minus the current pick, rounded, on every row', async ({ page }) => {
    await openDraft(page);
    const board = await boardJson(page);
    expect(board.currentPick, 'the demo draft has a pick on the clock').toBeGreaterThan(0);

    const onScreen = await page.getByTestId('recommendation-row').evaluateAll((rows) =>
      rows.map((r) => ({
        id: r.getAttribute('data-player-id'),
        adp: (r.querySelector('[data-testid="adp-metric"]') as HTMLElement | null)?.innerText ?? null,
        dog: (r.querySelector('[data-testid="dog-metric"]') as HTMLElement | null)?.innerText ?? null,
      })),
    );
    expect(onScreen.length).toBeGreaterThan(4);

    const byId = new Map(board.recommendations.map((r) => [r.playerId, r]));
    let checkedAdp = 0;
    let checkedDog = 0;
    for (const row of onScreen) {
      const rec = byId.get(row.id!);
      if (!rec) continue;

      if (rec.adp != null && row.adp) {
        const expected = Math.round(rec.adp - board.currentPick) || 0;
        const printed = row.adp.replace(/^ADP\s+/, '');
        expect(printed, `${rec.name}: ADP ${rec.adp} at pick ${board.currentPick}`).toBe(
          expected > 0 ? `+${expected}` : `${expected}`,
        );
        checkedAdp++;
      }
      if (rec.dogAdp != null && row.dog) {
        const expected = Math.round(rec.dogAdp - board.currentPick) || 0;
        const printed = row.dog.replace(/^DOG\s+/, '');
        expect(printed, `${rec.name}: DOG ${rec.dogAdp} at pick ${board.currentPick}`).toBe(
          expected > 0 ? `+${expected}` : `${expected}`,
        );
        checkedDog++;
      }
    }
    expect(checkedAdp, 'no ADP delta was actually checked').toBeGreaterThan(3);
    expect(checkedDog, 'no DOG delta was actually checked').toBeGreaterThan(0);
  });

  /**
   * The sign convention, asserted as the semantic state rather than as a
   * colour: what a reach looks like is the design's business, but that a
   * positive delta *is* a reach is the meaning and may not drift.
   */
  test('calls a positive delta a reach and a negative one value', async ({ page }) => {
    await openDraft(page);
    const cells = await page
      .locator('[data-testid="adp-metric"], [data-testid="dog-metric"]')
      .evaluateAll((nodes) =>
        nodes.map((n) => ({
          tone: n.getAttribute('data-tone'),
          text: (n as HTMLElement).innerText.replace(/^(ADP|DOG)\s+/, ''),
        })),
      );
    expect(cells.length).toBeGreaterThan(4);

    for (const { tone, text } of cells) {
      if (text === 'unknown') {
        expect(tone, 'an unpriced market claimed a direction').toBe('unknown');
        continue;
      }
      const value = Number(text);
      expect(Number.isInteger(value), `"${text}" is not a whole number of picks`).toBe(true);
      if (value > 0) expect(tone, `${text} should be a reach`).toBe('reach');
      else if (value < 0) expect(tone, `${text} should be value`).toBe('value');
      else expect(tone, `${text} should be even`).toBe('even');
      // The sign is always printed, so colour is never the only carrier.
      if (value > 0) expect(text.startsWith('+'), `${text} lost its sign`).toBe(true);
    }

    // The board really does contain both directions, so a uniform board could
    // not pass this by accident.
    const tones = new Set(cells.map((c) => c.tone));
    expect(tones.size, `every delta was ${[...tones]}`).toBeGreaterThan(1);
  });

  /**
   * The colour, which is a threshold on the printed number rather than on its
   * sign.
   *
   * `+10` or lower is fair, `+11` to `+15` steep, above `+15` costly. Read off
   * the rendered rows so the band the stylesheet paints and the digits the
   * reader sees cannot come apart — a column that computed its colour from the
   * raw ADP while printing the delta would pass every unit test and be wrong on
   * every row.
   */
  test('bands the delta by how much the reach costs, not by its sign', async ({ page }) => {
    await openDraft(page);
    const cells = await page
      .locator('[data-testid="adp-metric"] strong.delta, [data-testid="dog-metric"] strong.delta')
      .evaluateAll((nodes) =>
        nodes.map((n) => ({
          band: n.getAttribute('data-band'),
          picks: Number((n.textContent ?? '').trim()),
          colour: getComputedStyle(n).color,
        })),
      );
    expect(cells.length, 'no delta was actually rendered').toBeGreaterThan(4);

    for (const { band, picks } of cells) {
      expect(Number.isInteger(picks), `"${picks}" is not a whole number of picks`).toBe(true);
      if (picks <= 10) expect(band, `${picks} should be fair`).toBe('fair');
      else if (picks <= 15) expect(band, `${picks} should be steep`).toBe('steep');
      else expect(band, `${picks} should be costly`).toBe('costly');
    }

    // One colour per band, and the bands that are on screen really do differ:
    // a stylesheet that painted all three the same would satisfy the loop above.
    const byBand = new Map<string, Set<string>>();
    for (const { band, colour } of cells) {
      if (!band) continue;
      byBand.set(band, (byBand.get(band) ?? new Set()).add(colour));
    }
    for (const [band, colours] of byBand) {
      expect(colours.size, `${band} was painted ${colours.size} different colours`).toBe(1);
    }
    const distinct = new Set([...byBand.values()].map((set) => [...set][0]));
    expect(distinct.size, 'every band was painted the same colour').toBe(byBand.size);
  });

  test('never fakes a delta for a market that has not priced him', async ({ page }) => {
    await openDraft(page);
    const unknowns = await page
      .locator('[data-testid="adp-metric"][data-tone="unknown"]')
      .evaluateAll((nodes) => nodes.map((n) => (n as HTMLElement).innerText));
    // Whatever the seed happens to contain, an unknown may never read as `0`.
    for (const text of unknowns) {
      expect(text, 'a missing market was printed as a number').not.toMatch(/[+-]?\d/);
    }
  });

  test('no longer carries Val, and does not wrap or overflow', async ({ page }) => {
    await openDraft(page);
    const row = page.getByTestId('recommendation-row').first();
    const metrics = await row.locator('.player-row-metrics').innerText();
    expect(metrics).not.toMatch(/\bVal\b/);
    expect(metrics).toMatch(/Score/);
    expect(metrics).toMatch(/ADP/);
    expect(metrics).toMatch(/Next/);

    // One line, at this width, on every row the board is drawing.
    const wrapped = await page.getByTestId('recommendation-row').evaluateAll((rows) =>
      rows
        .map((r) => ({
          id: r.getAttribute('data-player-id'),
          lines: new Set(
            [...r.querySelectorAll('.player-row-metrics .metric')].map((m) =>
              Math.round(m.getBoundingClientRect().top),
            ),
          ).size,
        }))
        .filter((r) => r.lines > 1),
    );
    expect(wrapped, `these rows wrapped: ${wrapped.map((w) => w.id).join(', ')}`).toEqual([]);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `the board overflows by ${overflow}px`).toBeLessThanOrEqual(1);
  });

  /**
   * A delta a reader cannot check is a number taken on faith, so the expanded
   * card still carries both raw markets and the pick they were measured
   * against — answer on the row, working underneath it.
   */
  test('keeps the raw markets and the pick on the expanded card', async ({ page }) => {
    await openDraft(page);
    const board = await boardJson(page);
    const priced = board.recommendations.find((r) => r.adp != null)!;
    expect(priced, 'the demo board has a priced player').toBeTruthy();

    const row = page.locator(`[data-testid="recommendation-row"][data-player-id="${priced.playerId}"]`);
    await row.scrollIntoViewIfNeeded();
    await row.click();

    const raw = row.getByTestId('market-raw');
    await expect(raw).toBeVisible();
    await expect(raw).toContainText(`${priced.adp}`);
    await expect(raw).toContainText(`${board.currentPick}`);
    // …and the value column the compact row stopped printing is here.
    await expect(raw).toContainText('Val');
  });
});

/**
 * The one way this presentation change could have become a football change.
 *
 * The row shows `ADP +6` while the ADP sort still orders on the raw 170. If the
 * sort had quietly started ordering on the displayed delta the board would look
 * almost right and be wrong, so the ordering is checked against the raw values
 * the API sends.
 */
test.describe('the sorts still sort on the raw markets', () => {
  test('ADP orders by raw Sleeper ADP, not by the printed delta', async ({ page }) => {
    await openDraft(page);
    await page.getByTestId('sort-adp').click();
    await expect(page.getByTestId('sort-adp')).toHaveAttribute('aria-checked', 'true');

    const board = await boardJson(page);
    const byId = new Map(board.recommendations.map((r) => [r.playerId, r]));
    const order = await page
      .getByTestId('recommendation-row')
      .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-player-id')));

    const adps = order.map((id) => byId.get(id!)?.adp).filter((v): v is number => v != null);
    expect(adps.length).toBeGreaterThan(4);
    for (let i = 1; i < adps.length; i++) {
      expect(adps[i], `raw ADP went ${adps[i - 1]} → ${adps[i]} at row ${i}`).toBeGreaterThanOrEqual(adps[i - 1]!);
    }
  });

  test('Score still orders by score', async ({ page }) => {
    await openDraft(page);
    await page.getByTestId('sort-score').click();
    await expect(page.getByTestId('sort-score')).toHaveAttribute('aria-checked', 'true');

    const board = await boardJson(page);
    const byId = new Map(board.recommendations.map((r) => [r.playerId, r]));
    const order = await page
      .getByTestId('recommendation-row')
      .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-player-id')));

    const scores = order.map((id) => byId.get(id!)?.score).filter((v): v is number => v != null);
    expect(scores.length).toBeGreaterThan(4);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i], `score went ${scores[i - 1]} → ${scores[i]} at row ${i}`).toBeLessThanOrEqual(scores[i - 1]!);
    }
  });
});


/**
 * What the Draft board is not allowed to lose.
 *
 * The final simplification pass moved a recommendation up on Team, folded the
 * market inventory away on Trades, gave Matchup an explicit hold and shortened
 * the waiver instruction — every one of them a subtraction from a screen. Draft
 * was deliberately exempt: the reader is on the clock, comparing players in
 * seconds, and the two numbers an audit proposed removing are the two that
 * carry the most information per pixel there.
 *
 * So this is a fence rather than a feature test. `DOG` and `PTS` are on the
 * face of the compact row — not behind the expanded card, not on tap — and
 * they stay there.
 */
test.describe('the Draft row keeps the metrics it was built around', () => {
  test('shows DOG and PTS on the collapsed row, not behind a tap', async ({ page }) => {
    await openDraft(page);
    const rows = page.getByTestId('recommendation-row');
    await expect(rows.first()).toBeVisible();

    /*
     * Every row that has a value shows it, and the ones without are absent
     * rather than blank — which is the board's own rule for an unpriced player,
     * and is why this counts rather than asserting on the first row.
     */
    const board = await boardJson(page);
    const priced = board.recommendations.filter((r) => r.dogAdp != null).length;
    if (priced > 0) {
      expect(await page.getByTestId('dog-metric').count(), 'DOG has left the compact row').toBeGreaterThan(0);
      await expect(page.getByTestId('dog-metric').first()).toBeVisible();
    }

    /*
     * PTS on the same rule, and the rule is the board's own: the column is
     * drawn when this league has a preseason snapshot behind it and is absent —
     * not blank — when it has none, which is the demo seed's case. So the
     * board's own coverage decides whether the column is required, exactly as
     * `hasPreseasonPointsCoverage` decides whether it is drawn.
     */
    const projected = board.recommendations.filter((r) => Number.isFinite(r.preseasonPoints ?? NaN)).length;
    const pts = page.getByTestId('pts-metric');
    if (projected > 0) {
      expect(await pts.count(), 'PTS has left the compact row').toBeGreaterThan(0);
      await expect(pts.first()).toBeVisible();
      expect(await rows.first().locator('[data-testid="pts-metric"]').count()).toBe(1);
    } else {
      expect(await pts.count(), 'PTS appeared with nothing to show').toBe(0);
    }

    // On the row itself, with no card expanded — collapsed is the state a
    // reader on the clock is actually in.
    await expect(page.getByTestId('player-detail')).toHaveCount(0);
  });

  /**
   * PTS, on a board that actually has a snapshot behind it.
   *
   * The demo seed imports no StartWho paste, so the column is correctly absent
   * there — which makes the test above a conditional one, and a conditional
   * test is a weak fence. So the board is answered with preseason points on it,
   * which is a real field the real endpoint sends, and the column is required
   * on the collapsed row rather than merely permitted.
   */
  test('draws PTS on the collapsed row wherever the board has a projection', async ({ page }) => {
    await page.route('**/api/drafts/*/board*', async (route) => {
      const response = await route.fetch();
      const board = await response.json();
      await route.fulfill({
        response,
        body: JSON.stringify({
          ...board,
          recommendations: (board.recommendations as { name: string }[]).map((rec, i) => ({
            ...rec,
            preseasonPoints: 240 - i,
          })),
        }),
      });
    });
    await openDraft(page);

    const rows = page.getByTestId('recommendation-row');
    await expect(rows.first()).toBeVisible();
    const first = rows.first().getByTestId('pts-metric');
    await expect(first).toBeVisible();
    await expect(first).toContainText('PTS');
    await expect(first).toContainText('240');
    // Every row carries it, and none of them needed a tap to.
    expect(await page.getByTestId('pts-metric').count()).toBe(await rows.count());
    await expect(page.getByTestId('player-detail')).toHaveCount(0);
  });

  /** And the audit's other rejected suggestion has not crept back either. */
  test('offers no Take now or Can wait verdict', async ({ page }) => {
    await openDraft(page);
    await expect(page.getByText(/take now/i)).toHaveCount(0);
    await expect(page.getByText(/can wait/i)).toHaveCount(0);
  });
});
