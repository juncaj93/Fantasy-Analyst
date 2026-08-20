/**
 * The `MKT` line, on a real card at a real width.
 *
 * The unit tests own the arithmetic; this owns the two things only a browser
 * can answer. **It stays one row** — a quarterback's line carries four
 * quantities now, and a line that wrapped would make every priced card taller
 * than every unpriced one and cost the board its rhythm. And **it is only a
 * line**: switching the sort, which reorders the same rows, must not change a
 * single character of it.
 */

import { expect, test, type Page } from '@playwright/test';

async function openDraft(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('board-list')).toBeVisible();
  await expect(page.getByTestId('recommendation-row').first()).toBeVisible();
}

/** Every card's market text, keyed by player, in whatever order it is drawn. */
async function marketText(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const out: Record<string, string> = {};
    for (const row of document.querySelectorAll('[data-testid="recommendation-row"]')) {
      const line = row.querySelector('[data-testid="market-line"]');
      if (line) out[row.getAttribute('data-player-id')!] = (line.textContent ?? '').replace(/\s+/g, ' ').trim();
    }
    return out;
  });
}

test.describe('the market line', () => {
  test('is labelled MKT, and says nothing about betting', async ({ page }) => {
    await openDraft(page);
    const lines = page.getByTestId('market-line');
    expect(await lines.count(), 'the demo slate prices some players').toBeGreaterThan(0);

    const label = await lines.first().locator('.market-label').innerText();
    expect(label.trim()).toBe('MKT');

    const text = (await lines.first().innerText()).toLowerCase();
    // Still expectation, not an invitation: no prices, no books, no verbs.
    expect(text).not.toMatch(/[+-]\d{3}/);
    for (const word of ['odds', 'over/under', 'bet', 'wager', 'book']) expect(text).not.toContain(word);
  });

  /**
   * One row, whatever it carries.
   *
   * Measured as a property of the element rather than by counting characters:
   * a line that fits today and wraps when a quarterback gets his fourth number
   * would pass a character count and fail a reader.
   */
  test('never becomes two rows, however many numbers it carries', async ({ page }) => {
    await openDraft(page);
    const measured = await page.evaluate(() => {
      const lines = [...document.querySelectorAll('[data-testid="market-line"]')] as HTMLElement[];
      return lines.map((el) => {
        const style = getComputedStyle(el);
        return {
          text: (el.textContent ?? '').trim(),
          height: Math.round(el.getBoundingClientRect().height),
          whiteSpace: style.whiteSpace,
          overflow: style.overflowX,
          truncated: el.scrollWidth > el.clientWidth,
        };
      });
    });

    expect(measured.length).toBeGreaterThan(0);
    for (const line of measured) {
      expect(line.whiteSpace, 'the line must not be allowed to wrap').toBe('nowrap');
      expect(line.overflow, 'overflow has to be clipped rather than reflowed').toBe('hidden');
      expect(line.truncated, `"${line.text}" is being ellipsised`).toBe(false);
    }
    // Dense and ordinary alike, one height — the type step may change the text
    // and may not change the row.
    expect([...new Set(measured.map((l) => l.height))], 'market lines are not one height').toHaveLength(1);
  });

  /**
   * The case the dev slate does not contain, measured anyway.
   *
   * A quarterback priced on all four markets, with his market-implied points in
   * front of them, is the widest line this card can produce: five quantities
   * needing 345px where a 360px phone offers 315. That is the whole reason the
   * density ladder exists, and the component an ellipsis would eat is the
   * rushing touchdown — the one the previous pass was written to add.
   *
   * Synthesised because the mock provider quotes quarterbacks three markets, and
   * a width guarantee that only holds for the data that happens to be seeded is
   * not a guarantee.
   */
  test('fits a quarterback’s five quantities at the narrowest supported width', async ({ page }) => {
    await openDraft(page);
    const measured = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="market-line"]') as HTMLElement;
      const parts = ['339 pts', '4,050 pass yd', '29.5 pass TD', '385 rush yd', '3.5 rush TD'];
      const render = (dense: boolean) => {
        const clone = el.cloneNode(true) as HTMLElement;
        clone.setAttribute('data-dense', dense ? 'max' : 'no');
        clone.innerHTML =
          '<span class="market-label">MKT</span>' +
          parts.map((p) => `<span class="market-part">${p}</span>`).join('');
        clone.style.position = 'absolute';
        clone.style.visibility = 'hidden';
        clone.style.width = `${el.getBoundingClientRect().width}px`;
        el.parentElement!.append(clone);
        const out = {
          scrollWidth: clone.scrollWidth,
          clientWidth: clone.clientWidth,
          height: Math.round(clone.getBoundingClientRect().height),
        };
        clone.remove();
        return out;
      };
      return { dense: render(true), ordinary: render(false), row: Math.round(el.getBoundingClientRect().height) };
    });

    expect(measured.dense.scrollWidth, 'a four-part line is being ellipsised').toBeLessThanOrEqual(
      measured.dense.clientWidth,
    );
    expect(measured.dense.height, 'the dense line is not the height of an ordinary one').toBe(measured.row);

    /*
     * And where the room runs out, the step is load-bearing rather than
     * decoration. Guarded by the measured width because a 430px phone has room
     * for all four at ordinary size — the step is what rescues the narrow ones,
     * and asserting it fires everywhere would be asserting a bug.
     *
     * `>=` rather than `>`, and that difference is the only thing in this test
     * that is not a claim about the product. Everything above asks whether the
     * line the card actually draws fits; this asks whether the *un-stepped* line
     * would overflow — which is a claim about the font the runner resolves
     * `sans-serif` to, since nothing in this repo picks one on Linux.
     *
     * It went from true to exactly-equal when these tests moved into the
     * Playwright container: the ordinary line measured 315 against a clientWidth
     * of 315, fitting by nothing at all, which `>` scores the same as having
     * room to spare. It does not. The guard exists to catch the density ladder
     * quietly becoming decoration, and it keeps every bit of that force at `>=`
     * — a line with real room left measures comfortably under its width, not
     * precisely on it, and still fails here.
     */
    if (measured.dense.clientWidth <= 345) {
      expect(
        measured.ordinary.scrollWidth,
        'the dense step is no longer doing anything at this width',
      ).toBeGreaterThanOrEqual(measured.ordinary.clientWidth);
    }
  });

  /**
   * A priced card is exactly one market line taller than an unpriced one.
   *
   * The stronger claim than "nothing wrapped": with the line removed, every
   * card is the same height, so the market line is the whole of the difference
   * and adding a fourth number to it changed nothing structural.
   */
  test('costs a card exactly one line, and every card the same one', async ({ page }) => {
    await openDraft(page);
    const heights = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-testid="recommendation-row"]')];
      const withLine: number[] = [];
      const withoutLine: number[] = [];
      for (const row of rows) {
        // Compared with their own tier warning and injury line removed, which
        // are content of their own and legitimately change a height.
        const clone = row.cloneNode(true) as HTMLElement;
        clone.querySelector('[data-testid="injury-line"]')?.remove();
        clone.querySelector('[data-testid="decision-tags"]')?.remove();
        if (clone.querySelector('[data-testid="tier-cliff-tag"]')) continue;
        clone.style.position = 'absolute';
        clone.style.visibility = 'hidden';
        clone.style.width = `${row.getBoundingClientRect().width}px`;
        row.parentElement!.append(clone);
        const height = Math.round(clone.getBoundingClientRect().height);
        (clone.querySelector('[data-testid="market-line"]') ? withLine : withoutLine).push(height);
        clone.remove();
      }
      return { withLine: [...new Set(withLine)], withoutLine: [...new Set(withoutLine)] };
    });

    expect(heights.withLine.length, 'priced cards are not all one height').toBe(1);
    expect(heights.withoutLine.length, 'unpriced cards are not all one height').toBe(1);
  });

  test('is unchanged by sorting, which only reorders', async ({ page }) => {
    await openDraft(page);
    const byScore = await marketText(page);
    expect(Object.keys(byScore).length).toBeGreaterThan(0);

    for (const mode of ['adp', 'dog'] as const) {
      const button = page.getByTestId(`sort-${mode}`);
      if ((await button.count()) === 0 || !(await button.isEnabled())) continue;
      await button.click();
      await expect(button).toHaveAttribute('aria-checked', 'true');
      expect(await marketText(page), `${mode} changed a market line`).toEqual(byScore);
    }
  });
});

test.describe('what the line is made of', () => {
  /**
   * A number this app summed says so, in the card that opens.
   *
   * `scrim yd` is a rushing line added to a receiving one. No book quotes it,
   * and the expanded card is where that is admitted — with both lines, so the
   * reader can add them up themselves.
   */
  test('shows every component, and admits which ones were added together', async ({ page }) => {
    await openDraft(page);

    const rows = page.getByTestId('recommendation-row').filter({ has: page.getByTestId('market-line') });
    const row = rows.first();
    await row.click();
    /*
     * The provenance sits behind the compact card's one control.
     *
     * What the expanded row rests at is the *working* — `market-raw`, the two
     * raw markets and the pick they were measured against, which is one line.
     * Which books priced which component, and what this app added together, is
     * a different question and a much longer answer, so it waits until it is
     * asked for. `draft-market-delta.spec.ts` owns the resting line.
     */
    await row.getByTestId('detail-more').click();

    const detail = page.getByTestId('market-detail');
    await expect(detail).toBeVisible();
    // Settled, not merely present: the first component having text is what says
    // the disclosure has finished opening.
    await expect(detail.getByTestId('market-component').first()).not.toBeEmpty();

    const components = detail.getByTestId('market-component');
    expect(await components.count(), 'a market line must break down into components').toBeGreaterThan(0);

    for (const component of await components.all()) {
      /*
       * `textContent`, not `innerText`.
       *
       * WebKit returns an empty string from `innerText` for content inside the
       * disclosure while it is still animating open — and `toBeVisible` passes
       * throughout, because the box is on screen the whole time. The text is
       * there; only the rendered-text accessor is temporarily blind to it.
       */
      const text = (await component.textContent()) ?? '';
      if ((await component.getAttribute('data-derived')) === 'yes') {
        // A sum names both halves and does not pretend to be one quote.
        expect(text).toContain('+');
        expect(text).toContain('added here rather than quoted as one market');
      } else {
        expect(text).not.toContain('added here');
      }
    }

    // Who priced it and when, which the collapsed line has no room for.
    await expect(detail.getByTestId('market-source')).toBeVisible();
  });

  test('names an absent half rather than counting it as nothing', async ({ page }) => {
    await openDraft(page);
    const summary = await page.evaluate(async () => {
      const { leagues } = await (await fetch('/api/leagues')).json();
      const league = leagues.find((l: { draftId: string | null }) => l.draftId);
      if (!league) return null;
      const board = await (await fetch(`/api/drafts/${league.draftId}/board?limit=60`)).json();
      return (board.recommendations ?? [])
        .map((r: { position: string; marketProps: unknown }) => r.marketProps)
        .filter(Boolean);
    });
    test.skip(!summary || summary.length === 0, 'no priced players on this board');

    type Component = { label: string; value: number; missing: string[]; derived: boolean };
    const components = (summary as { components: Component[] }[]).flatMap((s) => s.components);
    expect(components.length).toBeGreaterThan(0);

    for (const component of components) {
      // The two claims that make a partial honest: it is never zero, and it is
      // never wearing the aggregate's name.
      expect(component.value, `${component.label} was reported as zero`).toBeGreaterThan(0);
      if (component.missing.length > 0) {
        expect(component.label, 'a partial sum is wearing the aggregate name').not.toBe('scrim yd');
        expect(component.derived, 'a partial cannot be a sum of two markets').toBe(false);
      }
    }
  });
});

/**
 * Receptions, and the number they roll up into.
 *
 * Two claims the brief makes and this file has to keep honest. A receiver's
 * receptions are worth as much as ten of his yards in a PPR league, so they
 * belong on the card whenever the market has them — and must never be
 * fabricated as `0 rec` when it does not. And `MKT PTS` is the same total the
 * ranking already scores, converted at *this* league's scoring, which means the
 * compact number and the expanded breakdown have to be the same number.
 */
test.describe('receptions and market-implied points', () => {
  /** Every priced recommendation on the live board, with its summary. */
  async function priced(page: Page) {
    return page.evaluate(async () => {
      const { leagues } = await (await fetch('/api/leagues')).json();
      const league = leagues.find((l: { draftId: string | null }) => l.draftId);
      if (!league) return null;
      const board = await (await fetch(`/api/drafts/${league.draftId}/board?limit=120`)).json();
      return {
        scoringLabel: board.league?.scoringLabel ?? null,
        rows: (board.recommendations ?? [])
          .filter((r: { marketProps: unknown }) => r.marketProps)
          .map((r: Record<string, unknown>) => ({
            position: r['position'],
            name: r['name'],
            marketProps: r['marketProps'],
            marketBaseline: r['marketBaseline'],
          })),
      };
    });
  }

  test('keeps receptions on a runner, a receiver and a tight end', async ({ page }) => {
    await openDraft(page);
    const data = await priced(page);
    test.skip(!data || data.rows.length === 0, 'no priced players on this board');

    type Row = { position: string; marketProps: { components: { label: string; value: number }[] } };
    const rows = data!.rows as Row[];

    for (const position of ['RB', 'WR', 'TE']) {
      const withReceptions = rows.filter(
        (r) => r.position === position && r.marketProps.components.some((c) => c.label === 'rec'),
      );
      // The mock provider prices receptions for all three, so an empty result
      // here is the regression this test exists for rather than thin data.
      expect(withReceptions.length, `no ${position} kept its receptions`).toBeGreaterThan(0);
      for (const row of withReceptions) {
        const rec = row.marketProps.components.find((c) => c.label === 'rec')!;
        expect(rec.value, 'a reception count of zero is an invented one').toBeGreaterThan(0);
      }
    }
  });

  test('never writes 0 rec for a player the market did not price', async ({ page }) => {
    await openDraft(page);
    const lines = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="market-line"]')].map((el) => el.textContent ?? ''),
    );
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toMatch(/\b0 rec\b/);
  });

  /**
   * The compact number and the expanded one are the same number.
   *
   * Not "close to": the card shows `marketBaseline.points`, and the breakdown
   * is that baseline's own contributions. A discrepancy would mean a second
   * conversion had grown somewhere, which is the thing the brief forbids.
   */
  test('reconciles MKT PTS to its own components, at this league’s scoring', async ({ page }) => {
    await openDraft(page);
    const data = await priced(page);
    test.skip(!data || data.rows.length === 0, 'no priced players on this board');

    type Row = {
      position: string;
      marketProps: { components: { label: string; value: number; parts: { points?: number }[] }[] };
      marketBaseline: { points: number | null; coverage: number; contributions: { points: number }[] } | null;
    };
    const rows = (data!.rows as Row[]).filter((r) => r.marketBaseline?.points != null);
    expect(rows.length, 'no player carried a market-implied total').toBeGreaterThan(0);

    for (const row of rows) {
      const pts = row.marketProps.components.find((c) => c.label === 'pts');
      expect(pts, 'a priced player has no MKT PTS component').toBeTruthy();
      expect(pts!.value).toBe(row.marketBaseline!.points);

      const summed = row.marketBaseline!.contributions.reduce((t, c) => t + c.points, 0);
      expect(Math.round(summed * 100) / 100).toBe(pts!.value);
    }

    // And the league whose scoring did the converting is named on the board.
    expect(data!.scoringLabel, 'the board does not say which scoring produced the points').toBeTruthy();
  });

  test('shows MKT PTS, its coverage and the scoring behind it when a card opens', async ({ page }) => {
    await openDraft(page);
    const rows = page.getByTestId('recommendation-row').filter({ has: page.getByTestId('market-line') });
    const row = rows.first();
    await row.click();
    // Behind the card's one control, with the rest of the provenance.
    await row.getByTestId('detail-more').click();

    /*
     * Retrying assertions rather than one read of the text.
     *
     * `toBeVisible` is satisfied the moment the disclosure has any height, and
     * WebKit reports no rendered text for a bit after that — so a single
     * `innerText` at that instant reads empty and the assertion fails on a
     * timing detail rather than on anything about the card.
     */
    const points = page.getByTestId('market-points');
    await expect(points).toContainText('MKT PTS');
    // Coverage and the league's own scoring, which is what stops the number
    // from being a projection wearing a market's clothes.
    await expect(points).toContainText(/\d+% of what a (QB|RB|WR|TE|DEF) scores on had a market/);
    await expect(points).toContainText("this league's scoring");
  });

  /**
   * Showing it changes nothing.
   *
   * `MKT PTS` is `marketBaseline.points`, which the `market_expectation`
   * component already scores. If displaying it had quietly become a second
   * input, the board would reorder — so the board is read twice and compared.
   */
  test('does not move the Draft Score or the board’s order', async ({ page }) => {
    await openDraft(page);
    const twice = await page.evaluate(async () => {
      const { leagues } = await (await fetch('/api/leagues')).json();
      const league = leagues.find((l: { draftId: string | null }) => l.draftId);
      if (!league) return null;
      const read = async () => {
        const board = await (await fetch(`/api/drafts/${league.draftId}/board?limit=80`)).json();
        return (board.recommendations ?? []).map((r: Record<string, unknown>) => ({
          id: r['playerId'],
          score: r['score'],
          total: r['total'],
          market: (r['components'] as { key: string; contribution: number }[]).find(
            (c) => c.key === 'market_expectation',
          )?.contribution,
        }));
      };
      return { first: await read(), second: await read() };
    });
    test.skip(!twice, 'no draft board on this deployment');

    expect(twice!.second).toEqual(twice!.first);
    // The market component is still scored, which is the point: the number on
    // the card is that component's own input rather than an extra one.
    expect(twice!.first.some((r: { market?: number }) => r.market != null)).toBe(true);
  });
});
