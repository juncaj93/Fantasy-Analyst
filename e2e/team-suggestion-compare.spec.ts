/**
 * The Team screen round of 30 September 2026, as a reader would check it.
 *
 *  - `Changes to consider` opens the Compare sheet on its own two players, and
 *    the sheet agrees with it (item 1's fix is unit-tested in
 *    `startsit.suggestionAgreesWithCompare.test.ts`; this is the tap).
 *  - The Compare picker narrows to the reader's own roster.
 *  - A player who is out shows no forecast; a doubtful or questionable one
 *    shows the discounted figure over the struck one.
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
    await change.click();

    await expect(page.getByTestId('compare-sheet')).toBeVisible();
    await expect(page.getByTestId('compare-sheet')).toContainText('Compare for FLEX');
    const columns = page.getByTestId('compare-column');
    await expect(columns).toHaveCount(2);
    const ids = await columns.evaluateAll((els) => els.map((e) => e.getAttribute('data-player-id')));
    expect(new Set(ids)).toEqual(new Set(['1001', '1004']));
  });

  test('My roster narrows the picker to the reader’s own players', async ({ page }) => {
    await page.getByTestId('compare-open').click();
    const chip = page.getByTestId('compare-mine-filter');
    await expect(chip).toHaveAttribute('aria-pressed', 'false');
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    const rows = page.getByTestId('compare-candidate');
    await expect(rows.first()).toBeVisible();
    /* Asked of the live list, so a page still arriving cannot pass or fail it early. */
    await expect(rows.filter({ hasNotText: 'Your roster' })).toHaveCount(0);
    await chip.click();
    await expect(page.getByTestId('compare-candidate').filter({ hasText: 'Your roster' }).first()).toBeVisible();
  });

  /*
   * The picker's header gives its room to the list (owner's phone check, 30
   * September 2026): no `Any lineup spot`, no paragraph of instructions, and
   * `My roster` beside the Compare button rather than on a row of its own.
   */
  test('the picker header is one row of controls, with no instructions above it', async ({ page }) => {
    await page.getByTestId('compare-open').click();
    const sheet = page.getByTestId('compare-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet).not.toContainText('Any lineup spot');
    await expect(sheet).not.toContainText('fair game');
    await expect(page.getByTestId('compare-hint')).toHaveCount(0);

    /*
     * Both boxes read in one frame, and polled: the sheet is still sliding up
     * for its first few hundred milliseconds, and two separate reads taken
     * mid-slide disagree by however far it moved in between.
     */
    const boxes = () =>
      page.evaluate(() => {
        const r = (id: string) => document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect();
        const run = r('compare-run');
        const chip = r('compare-mine-filter');
        return { runRight: run.right, runMid: run.y + run.height / 2, chipLeft: chip.x, chipMid: chip.y + chip.height / 2 };
      });
    // Same row: their vertical centres agree, and the chip sits to the right.
    await expect
      .poll(async () => {
        const b = await boxes();
        return Math.abs(b.runMid - b.chipMid);
      })
      .toBeLessThan(2);
    const b = await boxes();
    expect(b.chipLeft).toBeGreaterThanOrEqual(b.runRight);
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
      } else if (code === 'Q' || code === 'D') {
        const text = (await figure.textContent())?.trim();
        if (text === '—') continue;
        await expect(figure).toHaveClass(/proj-risk/);
      }
    }
  });
});
