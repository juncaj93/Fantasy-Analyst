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
 * It has to be visible on the card it lands on, whichever card that is.
 *
 * This is the second time this app has painted a status chip in a hue and put
 * it on cards washed in six different hues. The first was `Q`, amber on the
 * amber receiver tint; this was the same mistake, and measurement made it worse
 * than it looked — the pale warning tint sat within 1.1:1 of *every* position
 * card, so only the chip's text was doing any work at all, and on a receiver
 * that went too.
 *
 * So the reading taken here is the chip's own surface against the card's, on
 * all six positions the palette paints — including the two a seeded board never
 * shows, forced on by swapping the card's position class. A chip that goes back
 * to being a tint fails this at every position rather than at one, which is the
 * honest shape of the bug.
 */
test.describe('visibility on every card', () => {
  test('the warning stands off all six position tints, in both themes', async ({ page }) => {
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
        chip.className = 'player-row-cliff';
        chip.textContent = 'Tier cliff · 2 left';
        document.body.append(chip);
        const chipStyle = getComputedStyle(chip);
        const background = chipStyle.backgroundColor;
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
            textVsChip: ratio(text, background),
          };
        });
      });

      expect(readings).toHaveLength(6);
      for (const { position, chipVsCard, textVsChip } of readings) {
        expect(
          chipVsCard,
          `the warning is lost on ${position} in ${theme} (${chipVsCard.toFixed(2)}:1)`,
        ).toBeGreaterThan(4);
        expect(textVsChip, `the warning cannot be read in ${theme} (${textVsChip.toFixed(2)}:1)`).toBeGreaterThan(4.5);
      }
    }
    await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  });

  /**
   * …and it is not painted in anybody's colour.
   *
   * The position palette is the thing it has to stand off, so it may not be
   * drawn from it — a chip that happened to match one position's line colour
   * would be exactly the bug this replaced, arriving from the other direction.
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
      return { background: chip.backgroundColor, palette, neutral: root.getPropertyValue('--status-neutral').trim() };
    });
    expect(drawnFrom.neutral, 'the slate token has gone').not.toBe('');
    // Compared as rendered colours, since the tokens are hex and this is rgb().
    const asRgb = (hex: string) => {
      const n = Number.parseInt(hex.replace('#', '').slice(0, 6), 16);
      return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
    };
    for (const colour of drawnFrom.palette) {
      if (!colour.startsWith('#')) continue;
      expect(drawnFrom.background, `the warning is painted in a position's own colour`).not.toBe(asRgb(colour));
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
    await expect(chip).toHaveAttribute('aria-label', /^Tier cliff, (last 1|2 left)$/);
    await expect(chip).toHaveAttribute('data-remaining', /^[12]$/);

    const printed = (await chip.innerText()).trim();
    const remaining = await chip.getAttribute('data-remaining');
    // Whichever spelling this width gets, the count and the word survive.
    const full = remaining === '1' ? 'Tier cliff · last 1' : 'Tier cliff · 2 left';
    expect(printed).toMatch(new RegExp(`^(${full}|Cliff · ${remaining})$`));
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
    await row.getByTestId('detail-more').click();
    await page.waitForTimeout(400);

    await expect(row.getByTestId('market-detail')).toBeVisible();
    await expect(row.getByTestId('injury-current')).toBeVisible();
    expect((await row.boundingBox())!.height, 'asking for everything showed nothing more').toBeGreaterThan(short);

    // And it closes again, back to the preview.
    await row.getByTestId('detail-more').click();
    await page.waitForTimeout(400);
    await expect(row.getByTestId('market-detail')).toHaveCount(0);
  });
});
