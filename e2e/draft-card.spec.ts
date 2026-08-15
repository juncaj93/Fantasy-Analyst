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
   * ADP and a three-digit Val are ordinary on a deep board and would be the
   * thing that broke this in production rather than here.
   */
  test('Score, ADP, Val and Next stay on one line, even at their widest', async ({ page }) => {
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
      values[1]!.textContent = '128.4';
      values[2]!.textContent = '-118.6';
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
    expect(metrics).toMatch(/\bVal\b/);
    expect(metrics).toMatch(/\bNext\b/);
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
    await expect(chip).toHaveAttribute('aria-label', /^Tier cliff, [12] away$/);
    await expect(chip).toHaveAttribute('data-away', /^[12]$/);

    const printed = (await chip.innerText()).trim();
    const away = await chip.getAttribute('data-away');
    // Whichever spelling this width gets, the count and the word survive.
    expect(printed).toMatch(new RegExp(`^(Tier cliff · ${away} away|Cliff · ${away})$`));
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
