/**
 * The collapsed draft card, as a contract.
 *
 * The tier-cliff warning used to open a row of its own above the metrics, and
 * because cliffs arrive in runs — a thinning position tags several consecutive
 * players — the board gained a stutter exactly where a reader is comparing rows
 * hardest. It now sits at the right-hand end of the metrics line it was already
 * about.
 *
 * The claim being defended is a single number: **a card is the same height
 * whether or not it carries the warning.** That is asserted the only way it can
 * honestly be asserted — by measuring one card with the chip and then without
 * it, so no other difference between two players can flatter the result.
 *
 * The second claim is that nothing else moved. The warning is a note in the
 * margin of a line the reader is already reading, so it may not push the
 * numbers around, may not land on top of them, and may not swallow a tap meant
 * for the card.
 */

import { expect, test, type Page } from '@playwright/test';

/**
 * A snapshot the demo seed does not carry, injected the way a deployment would.
 *
 * The demo world has no StartWho paste in it and inventing one in the seed
 * would be testing a fixture — the import is proven in the unit and route
 * suites. What the card's own claims need is the field present, with exactly
 * the provenance the card must not print: a source, a capture date and a
 * scoring profile.
 */
const PROJECTION = {
  points: 246.6,
  label: 'StartWho · Aug 22',
  scoringLabel: 'Half PPR, 6pt pass TD',
  capturedAt: '2026-08-22',
};

async function withProjection(page: Page) {
  await page.route('**/api/players/*/detail', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, body: JSON.stringify({ ...body, preseasonProjection: PROJECTION }) });
  });
}

async function openDraft(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('board-list')).toBeVisible();
}

/** The first row carrying a tier-cliff warning, and its parts. */
function cliffRow(page: Page) {
  return page
    .getByTestId('recommendation-row')
    .filter({ has: page.getByTestId('tier-cliff-tag') })
    .first();
}

test.describe('where the warning sits', () => {
  test('shares the metrics line rather than opening a row of its own', async ({ page }) => {
    await openDraft(page);
    const row = cliffRow(page);
    await expect(row).toBeVisible();

    const geometry = await row.evaluate((el) => {
      const chip = el.querySelector('[data-testid="tier-cliff-tag"]')!.getBoundingClientRect();
      const metrics = el.querySelector('.player-row-metrics')!.getBoundingClientRect();
      const body = el.querySelector('.player-row-bottom')!.getBoundingClientRect();
      return {
        // Same line: their centres agree.
        lineOffset: Math.abs(chip.top + chip.height / 2 - (metrics.top + metrics.height / 2)),
        // To the right of the numbers, never over them.
        clearOfMetrics: Math.round(chip.left - metrics.right),
        // Against the card's trailing edge.
        fromRightEdge: Math.round(body.right - chip.right),
        // And it is not in the tag row the AVOID badge uses.
        inTagRow: el.querySelector('.tag-row [data-testid="tier-cliff-tag"]') !== null,
      };
    });

    expect(geometry.lineOffset, 'the warning is on its own line, not the metrics line').toBeLessThanOrEqual(2);
    expect(geometry.clearOfMetrics, 'the warning is sitting on top of the numbers').toBeGreaterThanOrEqual(0);
    expect(geometry.fromRightEdge, 'the warning is not against the card’s trailing edge').toBeLessThanOrEqual(6);
    expect(geometry.inTagRow, 'the warning went back into a row of its own').toBe(false);
  });

  /**
   * The number this change exists for.
   *
   * Measured on one card twice rather than on two different cards: two players
   * differ in more than the warning — an injury line, a market line — and a
   * comparison between them could pass for the wrong reason.
   */
  test('costs the card no height at all', async ({ page }) => {
    await openDraft(page);
    const row = cliffRow(page);
    await expect(row).toBeVisible();

    const heights = await row.evaluate((el) => {
      const height = () => Math.round(el.getBoundingClientRect().height);
      const withWarning = height();
      const chip = el.querySelector('[data-testid="tier-cliff-tag"]')!;
      const parent = chip.parentElement!;
      chip.remove();
      const without = height();
      parent.append(chip);
      return { withWarning, without, restored: height() };
    });

    expect(heights.withWarning, 'the warning makes the card taller').toBe(heights.without);
    expect(heights.restored).toBe(heights.withWarning);
  });

  /**
   * …and the board is a uniform stack because of it.
   *
   * Every card whose only extra content is the warning is exactly as tall as a
   * card with no extras at all. Cards that also carry an injury line or a
   * market line are legitimately taller — that is content, not chrome — so they
   * are compared with their own extra lines removed.
   */
  test('leaves the board one rhythm', async ({ page }) => {
    await openDraft(page);
    const measured = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-testid="recommendation-row"]')];
      const strip = (el: Element) => {
        const clone = el.cloneNode(true) as HTMLElement;
        clone.querySelector('[data-testid="injury-line"]')?.remove();
        clone.querySelector('[data-testid="market-line"]')?.remove();
        clone.querySelector('[data-testid="decision-tags"]')?.remove();
        clone.style.position = 'absolute';
        clone.style.visibility = 'hidden';
        clone.style.width = `${el.getBoundingClientRect().width}px`;
        el.parentElement!.append(clone);
        const height = Math.round(clone.getBoundingClientRect().height);
        clone.remove();
        return height;
      };
      const warned: number[] = [];
      const plain: number[] = [];
      for (const row of rows) {
        (row.querySelector('[data-testid="tier-cliff-tag"]') ? warned : plain).push(strip(row));
      }
      return { warned: [...new Set(warned)], plain: [...new Set(plain)] };
    });

    expect(measured.warned.length, 'the board should have some warned cards').toBeGreaterThan(0);
    expect(measured.plain, 'unwarned cards are not one height').toHaveLength(1);
    expect(measured.warned, 'warned cards are not one height').toHaveLength(1);
    expect(measured.warned[0], 'a warned card is a different height from an ordinary one').toBe(measured.plain[0]);
  });
});

test.describe('the numbers keep the line', () => {
  /**
   * The four metrics are what the row is about, and the warning may not cost
   * them so much as a wrap. Checked with the widest numbers this app can
   * produce as well as with the ones the seed happens to have: a three-digit
   * ADP delta and a three-digit DOG delta are ordinary on a deep board and
   * would be the thing that broke this in production rather than here.
   */
  test('Score, ADP, DOG and Next stay on one line, even at their widest', async ({ page }) => {
    await openDraft(page);
    const row = cliffRow(page);
    await expect(row).toBeVisible();

    const lines = await row.evaluate((el) => {
      const count = () =>
        new Set([...el.querySelectorAll('.metric')].map((m) => Math.round(m.getBoundingClientRect().top))).size;
      const seeded = count();
      const values = [...el.querySelectorAll('.player-row-metrics strong')] as HTMLElement[];
      const saved = values.map((v) => v.textContent);
      values[0]!.textContent = '100';
      values[1]!.textContent = '+128';
      values[2]!.textContent = '-118';
      const widest = count();
      values.forEach((v, i) => (v.textContent = saved[i]!));
      return { seeded, widest };
    });

    expect(lines.seeded, 'the metrics wrapped').toBe(1);
    expect(lines.widest, 'the metrics wrap once the numbers get long').toBe(1);
  });

  test('and every metric is still readable', async ({ page }) => {
    await openDraft(page);
    const metrics = await cliffRow(page).locator('.player-row-metrics').innerText();
    expect(metrics).toMatch(/Score\s+\d{1,3}/);
    expect(metrics).toContain('ADP');
    expect(metrics).toMatch(/\bNext\b/);
    // `Val` moved to the expanded card when ADP and DOG became deltas — the row
    // answers "how far ahead of this market am I" directly now.
    expect(metrics).not.toMatch(/\bVal\b/);
    // Nothing was traded away to fit the warning.
    await expect(cliffRow(page).getByTestId('survival')).toBeVisible();
  });

  /**
   * A Score the row next to it also shows is drawn as shared.
   *
   * The board prints Score as a whole number, and near the top it prints the
   * same one several times: on the seeded board ranks 2 and 3 are both 85 and
   * ranks 7 to 10 are all 74. That is the shape of the thing rather than a
   * rounding accident — those composites are hundredths of a point apart — and
   * it is why a player can slide several places while his Score never moves.
   *
   * So the rows that share a number say so. What is checked is the rule, not
   * one board's numbers: every row whose neighbour shows its Score is marked,
   * every row whose neighbours do not is not, and the marked ones say in words
   * how many they are level with. A treatment that marked everything, or
   * nothing, or that marked equal Scores which are not adjacent, fails this.
   */
  test('says which Scores are shared with the row next door', async ({ page }) => {
    await openDraft(page);
    const rows = page.getByTestId('recommendation-row');
    await expect(rows.first()).toBeVisible();

    const board = await rows.evaluateAll((els) =>
      els.map((el) => {
        const value = el.querySelector('.score-value');
        return {
          text: (value?.textContent ?? '').trim(),
          level: value?.getAttribute('data-level') === 'true',
          label: value?.getAttribute('aria-label') ?? null,
        };
      }),
    );
    expect(board.length, 'the seeded board has rows on it').toBeGreaterThan(3);

    // The mark is exactly "a neighbour shows this number".
    for (const [i, row] of board.entries()) {
      const shared = board[i - 1]?.text === row.text || board[i + 1]?.text === row.text;
      // An unpriced player prints a dash and is never level with anybody.
      const priced = /^\d+$/.test(row.text);
      expect(row.level, `row ${i + 1} (Score ${row.text}) is marked ${row.level}`).toBe(shared && priced);
    }

    // At least one run exists on this board, and it says what it means.
    const marked = board.filter((row) => row.level);
    expect(marked.length, 'the seeded board has a run of equal Scores').toBeGreaterThan(0);
    expect(marked[0]!.label).toMatch(/level with \d+ other/);

    // And it is not the whole board, which would say nothing.
    expect(marked.length).toBeLessThan(board.length);
  });

  /**
   * The Score's colour is on the number, and only on the number.
   *
   * `Score` is the same word on every row, so colouring it would paint the
   * board rather than the reading. The numeral is what differs and what a
   * reader glances at, so it is the thing allowed to say strong, fair or weak —
   * and the arithmetic behind which is which lives in `tests/scoreBand.test.ts`,
   * where a distribution can be stated exactly. What is checked here is the
   * wiring: the band reaches the numeral, the word beside it does not take it,
   * and the sibling metrics keep the colours they earn from their own signs.
   */
  test('colours the Score number without colouring the word beside it', async ({ page }) => {
    await openDraft(page);
    const rows = page.getByTestId('recommendation-row');
    await expect(rows.first()).toBeVisible();

    const board = await rows.evaluateAll((els) =>
      els.map((el) => {
        const metric = el.querySelector('[data-testid="score-metric"]');
        const value = el.querySelector('.score-value');
        return {
          text: (value?.textContent ?? '').trim(),
          band: value?.getAttribute('data-band') ?? null,
          label: value?.getAttribute('aria-label') ?? null,
          valueColour: value ? getComputedStyle(value).color : null,
          // The label's own colour, read off the element that holds the word.
          wordColour: metric ? getComputedStyle(metric).color : null,
          bodyColour: getComputedStyle(document.body).color,
        };
      }),
    );
    expect(board.length).toBeGreaterThan(3);

    /** Which colours each band was actually painted in, across the board. */
    const painted = new Map<string, Set<string>>();
    for (const row of board) {
      const priced = /^\d+$/.test(row.text);
      expect(row.band, `Score "${row.text}" carries no band`).toBeTruthy();
      expect(['strong', 'fair', 'weak', 'unknown']).toContain(row.band!);
      // An unpriced player prints a dash, and a dash is not a verdict.
      expect(row.band === 'unknown', `"${row.text}" is banded ${row.band}`).toBe(!priced);
      if (!priced) continue;

      painted.set(row.band!, (painted.get(row.band!) ?? new Set()).add(row.valueColour!));
      // …and it says the band in words, for anyone not looking at the colour.
      expect(row.label, `Score ${row.text} does not say its band`).toMatch(/strong|fair|weak/);
      // The word beside it keeps the secondary colour it has on every row.
      expect(row.wordColour, `the word "Score" took the number's colour`).not.toBe(row.valueColour);
    }

    /*
     * The colour is a function of the band, and the bands are different colours.
     *
     * This is the assertion that has to do the work, and the obvious weaker
     * version does not: "the number is a different colour from the word beside
     * it" was already true before any of this existed, because a value and its
     * label were always two greys. What must hold is that the *band* is what
     * decides — every row in a band painted alike, and no two bands painted the
     * same. Delete the three rules from the stylesheet and this fails; nothing
     * else here does.
     */
    expect(painted.size, `the board only reached ${[...painted.keys()].join('/')}`).toBeGreaterThan(1);
    const perBand = new Map<string, string>();
    for (const [band, colours] of painted) {
      expect(colours.size, `${band} was painted ${[...colours].join(' and ')}`).toBe(1);
      perBand.set(band, [...colours][0]!);
    }
    expect(new Set(perBand.values()).size, `two bands share a colour: ${[...perBand].join(', ')}`).toBe(perBand.size);
  });

  test('the board does not scroll sideways because of it', async ({ page }) => {
    await openDraft(page);
    await expect(cliffRow(page)).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

/**
 * It has to be readable on the card it lands on, whichever card that is — and
 * quieter than the four numbers beside it.
 *
 * The history is worth keeping, because it is why this reads the way it does.
 * The chip was once amber on an amber receiver tint and vanished; the fix was a
 * filled slate slab, measured against the card and required to clear it by a
 * wide margin. That was the right proxy for a slab and it is the wrong
 * requirement now: it *mandates* a slab, and the slab was the complaint — the
 * chip stood 5.5:1 to 7.4:1 off the card, louder than the Score.
 *
 * What made the original bug a bug was that the chip's **letters** disappeared,
 * not that its surface did. So that is what is measured: the text against the
 * pill and against the card, on all six positions the palette paints —
 * including the two a seeded board never shows, forced on by swapping the
 * card's position class. The surface is then held *below* a ceiling rather than
 * above a floor, and the border is what keeps the pill a shape.
 *
 * A chip that goes back to being a tint with no border fails the edge check at
 * every position; one that goes back to being a slab fails the quiet check at
 * every position. Both are the honest shape of their respective bug.
 */
test.describe('visibility on every card', () => {
  test('the warning reads on all six position tints, in both themes, without shouting', async ({ page }) => {
    await openDraft(page);
    await expect(cliffRow(page)).toBeVisible();

    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      await page.waitForTimeout(200);

      const readings = await page.evaluate(() => {
        /*
         * Resolved by painting rather than by parsing.
         *
         * A position card's background is a `color-mix()`, and the engines do
         * not agree about how to serialise one — Chromium hands back
         * `oklab(0.96 0.003 0.027)`, which a naive "grab the first three
         * numbers" reader turns into a near-black and a contrast figure that is
         * confidently wrong. Filling a canvas and reading the pixel back asks
         * the engine what colour it actually painted, which is the question.
         */
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d')!;
        const paint = (colour: string): number[] => {
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = '#000';
          context.fillStyle = colour;
          context.fillRect(0, 0, 1, 1);
          const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
          return [r!, g!, b!];
        };
        const luminance = (rgb: number[]) => {
          const f = (c: number) => {
            const v = c / 255;
            return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
          };
          return 0.2126 * f(rgb[0]!) + 0.7152 * f(rgb[1]!) + 0.0722 * f(rgb[2]!);
        };
        const ratio = (a: string, b: string) => {
          const [x, y] = [luminance(paint(a)), luminance(paint(b))];
          return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
        };

        /*
         * Measured on probes rather than on the board's own rows, because two
         * of the six positions are not startable in this league and so are
         * never drawn — and those are exactly the ones a bug would hide in.
         */
        const chip = document.createElement('span');
        chip.className = 'row-pill player-row-cliff';
        chip.textContent = 'Tier \u00b7 2 left';
        document.body.append(chip);
        const chipStyle = getComputedStyle(chip);
        const background = chipStyle.backgroundColor;
        const border = chipStyle.borderTopColor;
        const text = chipStyle.color;
        chip.remove();

        return ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].map((position) => {
          const card = document.createElement('div');
          card.className = `player-row card-pos card-pos-${position}`;
          document.body.append(card);
          const cardBackground = getComputedStyle(card).backgroundColor;
          card.remove();
          return {
            position,
            chipVsCard: ratio(background, cardBackground),
            borderVsCard: ratio(border, cardBackground),
            textVsChip: ratio(text, background),
            textVsCard: ratio(text, cardBackground),
          };
        });
      });

      expect(readings).toHaveLength(6);
      for (const r of readings) {
        const where = `${r.position} in ${theme}`;
        // The letters are the carrier, so the letters clear WCAG AA — on the
        // pill, and on the card underneath it, which the old white-on-slab
        // lettering never did.
        expect(r.textVsChip, `the warning cannot be read on its pill in ${where} (${r.textVsChip.toFixed(2)}:1)`)
          .toBeGreaterThan(4.5);
        expect(r.textVsCard, `the warning is lost against the card on ${where} (${r.textVsCard.toFixed(2)}:1)`)
          .toBeGreaterThan(4.5);
        // Quiet, which is the requirement that replaced "stands well off".
        expect(r.chipVsCard, `the warning shouts on ${where} (${r.chipVsCard.toFixed(2)}:1)`).toBeLessThan(2);
        // ...and still a pill rather than floating text.
        expect(r.borderVsCard, `the warning has no edge on ${where} (${r.borderVsCard.toFixed(2)}:1)`)
          .toBeGreaterThan(2);
      }
    }
    await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  });

  /**
   * …and it is not painted in anybody's colour.
   *
   * The position palette is the thing it sits on, so it may not be drawn from
   * it — a chip that happened to match one position's line or tint would be
   * exactly the bug this replaced, arriving from the other direction. The chip
   * is neutral now (a count is not a warning), so this checks both the surface
   * and the hairline: either one landing on a position's own colour would make
   * the chip read as belonging to that position.
   */
  test('is drawn from outside the position palette', async ({ page }) => {
    await openDraft(page);
    const drawnFrom = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const chip = getComputedStyle(document.querySelector('.player-row-cliff')!);
      const palette = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].flatMap((p) => [
        root.getPropertyValue(`--pos-${p}-line`).trim(),
        root.getPropertyValue(`--pos-${p}-tint`).trim(),
      ]);
      return { background: chip.backgroundColor, border: chip.borderTopColor, palette };
    });
    expect(drawnFrom.palette.filter((c) => c.startsWith('#')).length, 'the palette tokens have gone').toBeGreaterThan(6);
    // Compared as rendered colours, since the tokens are hex and this is rgb().
    const asRgb = (hex: string) => {
      const n = Number.parseInt(hex.replace('#', '').slice(0, 6), 16);
      return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
    };
    for (const colour of drawnFrom.palette) {
      if (!colour.startsWith('#')) continue;
      expect(drawnFrom.background, `the warning is painted in a position's own colour`).not.toBe(asRgb(colour));
      expect(drawnFrom.border, `the warning is outlined in a position's own colour`).not.toBe(asRgb(colour));
    }
  });
});

/**
 * The warning says the same thing at every width.
 *
 * Nineteen characters and four labelled numbers do not both fit on the narrow
 * phones, and the numbers are the ones that may not give — so the chip has a
 * short spelling there. What must never change with the viewport is what it
 * *means*, so the accessible name carries the whole sentence everywhere.
 */
test.describe('what it says', () => {
  test('carries the full sentence whatever it can afford to print', async ({ page }) => {
    await openDraft(page);
    const chip = cliffRow(page).getByTestId('tier-cliff-tag');
    await expect(chip).toHaveAttribute(
      'aria-label',
      /^(The last \w+ in the best group left on the board|Two \w+s left in the best group on the board)$/,
    );
    await expect(chip).toHaveAttribute('data-remaining', /^[12]$/);

    const printed = (await chip.innerText()).trim();
    const remaining = await chip.getAttribute('data-remaining');
    // Whichever spelling this width gets, the count survives — and "cliff" is
    // gone from both, because the count was always the message.
    const full = remaining === '1' ? 'Tier \u00b7 last 1' : 'Tier \u00b7 2 left';
    expect(printed).toMatch(new RegExp(`^(${full}|Tier \u00b7 ${remaining})$`));
    expect(printed).not.toMatch(/cliff/i);
  });
});

/**
 * It is a note, not a control.
 *
 * The chip sits inside the button that opens the card, so a thumb that lands on
 * it must still open the card — a warning that swallowed taps would be worse
 * than one that cost a row.
 */
test.describe('it does not get in the way', () => {
  test('a tap on the warning opens the card, like a tap anywhere else', async ({ page }) => {
    await openDraft(page);
    const row = cliffRow(page);
    await expect(row).toBeVisible();
    await expect(row.getByTestId('player-detail')).toHaveCount(0);

    await row.getByTestId('tier-cliff-tag').click();
    await expect(row.getByTestId('player-detail'), 'the warning swallowed the tap').toBeVisible();

    await row.locator('.row-button').click();
    await expect(row.getByTestId('player-detail')).toHaveCount(0);
  });

  test('the star beside the name still queues rather than opening the card', async ({ page }) => {
    await openDraft(page);
    const row = cliffRow(page);
    const star = row.getByTestId('queue-control');
    await expect(star).toBeVisible();
    await expect(star).toHaveAttribute('data-queued', '0');

    await star.click();
    await expect(star).toHaveAttribute('data-queued', '1');
    // Queueing is a bookmark, not a way in: the card stays shut.
    await expect(row.getByTestId('player-detail')).toHaveCount(0);

    await star.click();
    await expect(star).toHaveAttribute('data-queued', '0');
  });
});

/**
 * …and the expanded card, as a budget.
 *
 * Draft is the one screen where opening a player costs you the thing you opened
 * him from. The expanded row once ran to eight or nine times a collapsed one —
 * a full outlook, the market's whole provenance, injury history and profile
 * notes, all inline — which pushed the next four players off a phone. It now
 * rests at four short blocks and one control.
 *
 * "Much shorter" is exactly the kind of claim that decays a line at a time, so
 * it is asserted as a ratio against the board's own collapsed rows rather than
 * as a pixel count that would need editing every time a font changes. The
 * budget is roughly two to two and a half rows; the ceiling here is three,
 * which leaves room for a long tier-cliff line without leaving room for the
 * article coming back.
 *
 * Nothing was deleted to hit it. The second test is the other half of the
 * claim: everything the card stopped resting on is one tap away.
 */
test.describe('the expanded card is a preview, not an article', () => {
  test('rests at about two rows, on every player the board is drawing', async ({ page }) => {
    /*
     * With a market reading on every card, because that is the shape the
     * ceiling has to hold for.
     *
     * It used to be a line of its own under the season — the figure, then the
     * source, the capture date and the league's scoring profile spelled out
     * beside it — and it is one metric in the season band now. The band is
     * where a card most easily buys a row back, so the ceiling is measured with
     * the reading present rather than on the demo's empty case.
     */
    await withProjection(page);
    await openDraft(page);
    const rows = page.getByTestId('recommendation-row');
    const collapsed = (await rows.nth(1).boundingBox())!.height;
    expect(collapsed, 'a collapsed row should be a row').toBeGreaterThan(40);

    // Several players, because they differ in what they have to say: a cliff
    // line, an outlook or none, a market or none.
    for (const i of [0, 1, 2, 3, 4]) {
      const row = rows.nth(i);
      await row.scrollIntoViewIfNeeded();
      await row.click();
      await expect(row.getByTestId('player-detail')).toBeVisible();
      // Settled, rather than mid-animation: the disclosure grows into place.
      await page.waitForTimeout(500);

      const expanded = (await row.boundingBox())!.height;
      const ratio = expanded / collapsed;
      const name = await row.locator('.player-name').first().innerText();
      expect(ratio, `${name} expands to ${ratio.toFixed(1)} rows (${Math.round(expanded)}px)`).toBeLessThan(3);
      // …and it did open. A card that renders nothing would pass a ceiling.
      expect(ratio, `${name} did not actually open`).toBeGreaterThan(1.2);

      /*
       * `Market - 247 Pts · 2025 · 17 GP · WR2 half-PPR` — one band, one line.
       *
       * The wording is asserted whole rather than by fragment, because every
       * one of the rejected spellings would satisfy a looser check: `Preseason
       * 247 PTS`, `MKT PTS 247`, the figure with `StartWho · Aug 22` after it.
       * And the band is asserted to be one line high, since the point of
       * folding the market reading in was that the card stopped spending a row
       * on it — a band that wraps has given the row straight back.
       */
      const band = row.getByTestId('last-season');
      const seen = await band.evaluate((el) => {
        const clone = el.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('.sr-only').forEach((node) => node.remove());
        return {
          // Joined the way the band reads, so a failure prints the line rather
          // than one run-on string of every metric in it.
          text: [...clone.querySelectorAll('.metric')]
            .map((metric) => (metric.textContent ?? '').replace(/\s+/g, ' ').trim())
            .join(' · '),
          lines: Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)),
        };
      });
      expect(seen.text, `${name}'s band does not open with the market reading`).toMatch(/^Market - \d+ Pts(?: ·|$)/);
      expect(seen.text, `${name} lost his games played`).toMatch(/\d+ GP/);
      expect(seen.text, `${name} lost his half-PPR finish`).toMatch(/(QB|RB|WR|TE|K|DEF)\d+ half-PPR/);
      for (const forbidden of ['StartWho', 'Half PPR,', '6pt pass TD', 'Preseason', 'PTS', 'MKT']) {
        expect(seen.text, `${name}'s card prints "${forbidden}"`).not.toContain(forbidden);
      }
      expect(seen.lines, `${name}'s band wrapped to ${seen.lines} lines`).toBe(1);

      // Removed from the card, not from the app: the whole sentence is still
      // on the metric, in the accessible text and in the title.
      const provenance = row.getByTestId('preseason-projection');
      expect(await provenance.getAttribute('title')).toContain('StartWho · Aug 22');
      expect((await provenance.locator('.sr-only').innerText()).toLowerCase()).toContain('preseason');

      await row.locator('.row-button').click();
      await page.waitForTimeout(300);
    }
  });

  test('and everything it stopped showing is one tap away', async ({ page }) => {
    await openDraft(page);
    // A player the seed gives a market, an outlook and an injury history.
    const row = page.locator('[data-testid="recommendation-row"]', { hasText: 'Julian Reyes' }).first();
    await row.scrollIntoViewIfNeeded();
    await row.click();

    // At rest: the working behind the row's deltas, and nothing that explains
    // where those markets came from.
    await expect(row.getByTestId('market-raw')).toBeVisible();
    await expect(row.getByTestId('market-detail')).toHaveCount(0);
    await expect(row.getByTestId('injury-current')).toHaveCount(0);

    const short = (await row.boundingBox())!.height;
    await row.getByTestId('outlook-expand').click();
    await page.waitForTimeout(400);

    await expect(row.getByTestId('market-detail')).toBeVisible();
    await expect(row.getByTestId('injury-current')).toBeVisible();
    expect((await row.boundingBox())!.height, 'asking for everything showed nothing more').toBeGreaterThan(short);

    // And it closes again, back to the preview.
    await row.getByTestId('outlook-expand').click();
    await page.waitForTimeout(400);
    await expect(row.getByTestId('market-detail')).toHaveCount(0);
  });
});
