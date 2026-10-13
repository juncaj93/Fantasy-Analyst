/**
 * The Team screen round of 30 September 2026, as a reader would check it.
 *
 *  - `Changes to consider` opens the Compare sheet on its own two players, and
 *    the sheet agrees with it (item 1's fix is unit-tested in
 *    `startsit.suggestionAgreesWithCompare.test.ts`; this is the tap).
 *  - The Compare picker opens on the reader's own roster.
 *  - A player who is out shows no forecast; a doubtful one shows the
 *    discounted figure over the struck one. A questionable one keeps his
 *    number (13 October 2026) and carries a warning instead.
 */
import { expect, test, type Page } from '@playwright/test';
import { inSeason } from './helpers.ts';

async function openTeam(page: Page) {
  await inSeason(page);
  await page.goto('/');
  await page.getByTestId('tab-team').click();
  await expect(page.getByTestId('starters-title')).toBeVisible();
}

test.describe('the Team round of 30 September', () => {
  test.beforeEach(async ({ page }) => openTeam(page));

  test('the suggestion opens Compare on its own two players', async ({ page }) => {
    /*
     * The demo week suggests nothing, so one change is written into the demo
     * lineup's own answer: two of the demo roster's players, in FLEX. What is
     * under test is the tap and where it lands; that the sheet then agrees
     * with the sentence is held in `startsit.suggestionAgreesWithCompare.test.ts`.
     */
    await page.route('**/api/leagues/*/lineup', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const swap = { slot: 'FLEX', inPlayerId: '1004', inName: 'Andre Sotelo', outPlayerId: '1001', outName: 'Marcus Vance', gain: 1.25, reason: 'test' };
      await route.fulfill({ response, body: JSON.stringify({ ...body, swaps: [swap], fills: [] }) });
    });
    await page.reload();
    await page.getByTestId('tab-team').click();

    const change = page.getByTestId('lineup-swap');
    await expect(change).toHaveAttribute('data-seed', '1001,1004');
    // Sotelo is Questionable: it costs nothing, so Best move says it in one line.
    await expect(change.getByTestId('best-move-availability')).toHaveText('Sotelo is questionable and may not play');
    await change.click();

    await expect(page.getByTestId('compare-sheet')).toBeVisible();
    await expect(page.getByTestId('compare-sheet')).toContainText('FLEX slot');
    const columns = page.getByTestId('compare-column');
    await expect(columns).toHaveCount(2);
    const ids = await columns.evaluateAll((els) => els.map((e) => e.getAttribute('data-player-id')));
    expect(new Set(ids)).toEqual(new Set(['1001', '1004']));
  });

  test('My roster lists only the reader’s own players, and All players says whose', async ({ page }) => {
    await page.getByTestId('compare-open').click();
    await expect(page.getByTestId('compare-tab-mine')).toHaveAttribute('aria-pressed', 'true');
    const rows = page.getByTestId('compare-candidate');
    await expect(rows.first()).toBeVisible();
    await expect(page.getByTestId('compare-owner')).toHaveCount(0);
    await page.getByTestId('compare-tab-all').click();
    await expect(page.getByTestId('compare-tab-all')).toHaveAttribute('aria-pressed', 'true');
    await expect(rows.first()).toBeVisible();
  });

  /*
   * The picker gives its room to the list: no instructions, just the tabs,
   * search and the position filter under the pinned strip.
   */
  test('the picker carries no instructions above its list', async ({ page }) => {
    await page.getByTestId('compare-open').click();
    const sheet = page.getByTestId('compare-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet).not.toContainText('Any lineup spot');
    await expect(sheet).not.toContainText('fair game');
    await expect(page.getByTestId('compare-hint')).toHaveCount(0);
    await expect(page.getByTestId('compare-tabs')).toBeVisible();
  });

  /*
   * Best move (October 2026): the Matchup row's grammar on Team. Label in gray,
   * names in the text colour, numbers in gray, the priced count kept, and the
   * close-call line when the week's posture settled it.
   */
  test('Best move reads like the Matchup row, and says why on a close call', async ({ page }) => {
    await page.route('**/api/leagues/*/lineup', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const swap = {
        slot: 'FLEX', inPlayerId: '1004', inName: 'Andre Sotelo', outPlayerId: '1001', outName: 'Marcus Vance', gain: -0.3, reason: 'x',
        tiebreak: { pill: 'explosive', posture: 'underdog', sentence: "Close call. You're the underdog, so the higher ceiling gets the nod." },
      };
      await route.fulfill({ response, body: JSON.stringify({ ...body, swaps: [swap], fills: [] }) });
    });
    await page.reload();
    await page.getByTestId('tab-team').click();
    const card = page.getByTestId('lineup-card');
    await expect(card).toContainText('Best move');
    await expect(card).not.toContainText('Changes to consider');
    await expect(page.getByTestId('lineup-sourcing')).toHaveText(/^\d+\/\d+ priced$/);
    await expect(page.getByTestId('best-move-points')).toContainText('projected');
    await expect(page.getByTestId('best-move-tiebreak')).toHaveText("Close call. You're the underdog, so the higher ceiling gets the nod.");
    const colours = await card.evaluate((el) => ({
      label: getComputedStyle(el.querySelector('.matchup-best-move-label')!).color,
      names: getComputedStyle(el.querySelector('.matchup-best-move-names')!).color,
      numbers: getComputedStyle(el.querySelector('.matchup-best-move-metrics')!).color,
    }));
    expect(colours.label).not.toBe(colours.names);
    expect(colours.numbers).not.toBe(colours.names);
    const box = (await card.boundingBox())!;
    expect(box.height / page.viewportSize()!.height).toBeLessThan(0.2);
  });

  /* Alex, 13 October 2026: Best move printed "15.3 vs -97.0 projected" for Will Shipley. */
  test('Best move names an Out player as Out, never by the internal gate value', async ({ page }) => {
    await page.route('**/api/leagues/*/lineup', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const swap = { slot: 'TE', inPlayerId: '1004', inName: 'Andre Sotelo', outPlayerId: '1009', outName: 'Nate Kowalski', gain: 108, reason: 'x' };
      await route.fulfill({ response, body: JSON.stringify({ ...body, swaps: [swap], fills: [] }) });
    });
    await page.reload();
    await page.getByTestId('tab-team').click();
    const change = page.getByTestId('lineup-swap');
    await expect(change).toContainText('Start Andre Sotelo over Nate Kowalski, who is Out');
    await expect(change).not.toContainText(/-9\d|−9\d/);
    await expect(page.getByTestId('best-move-points')).not.toContainText(' vs ');
    // And the picker lists him as Out, at the bottom, never as a negative number.
    await page.getByTestId('compare-open').click();
    const row = page.locator('[data-testid="compare-candidate"][data-player-id="1009"]');
    await expect(row.getByTestId('compare-points')).toContainText('Out');
    await expect(page.getByTestId('compare-picker')).not.toContainText(/-9\d\.\d/);
  });

  test('never prints a plain forecast for a player who may not play', async ({ page }) => {
    await page.getByTestId('bench-toggle').click();
    const rows = page.locator('[data-testid="bench-row"], [data-testid="starter-row"][data-starter="true"]');
    for (const row of await rows.all()) {
      const tag = row.getByTestId('injury-tag');
      if ((await tag.count()) === 0) continue;
      const code = await tag.getAttribute('data-status');
      const figure = row.locator('[data-testid="bench-proj"], [data-testid="starter-proj"]');
      if ((await figure.count()) === 0) continue;
      if (code === 'OUT' || code === 'IR') {
        await expect(figure).toHaveText('—');
      } else if (code === 'D') {
        const text = (await figure.textContent())?.trim();
        if (text === '—') continue;
        await expect(figure).toHaveClass(/proj-risk/);
      } else if (code === 'Q') {
        // Questionable costs nothing since 13 October 2026: his plain number, beside the Q tag.
        await expect(figure).not.toHaveClass(/proj-risk/);
      }
    }
  });
});
