/**
 * Matchup's live refresh stops while the app is in the background (Round 14).
 *
 * During a live game the screen re-reads the matchup every 30 seconds. Every
 * read costs database rows, so a phone left on Matchup in a pocket, or a tab
 * left open behind another, must not keep paying for a scoreboard nobody is
 * looking at. Coming back must bring the score current at once, not after the
 * next 30-second tick.
 *
 * The real endpoint on the seeded server answers, and only its phase is set to
 * `live`, so this is the app's own screen and its own timer. The clock is
 * Playwright's, so thirty seconds pass in no time.
 *
 * Visibility is simulated the same way `draft-autorefresh.spec.ts` does it:
 * Playwright cannot background a WebKit page and `document.visibilityState` is
 * read-only, so the page gets a controllable one before any script runs.
 */

import { expect, test, type Page } from '@playwright/test';

async function withControllableVisibility(page: Page) {
  await page.addInitScript(() => {
    let hidden = false;
    Object.defineProperty(document, 'visibilityState', {
      get: () => (hidden ? 'hidden' : 'visible'),
      configurable: true,
    });
    Object.defineProperty(document, 'hidden', { get: () => hidden, configurable: true });
    (window as unknown as { __setHidden: (v: boolean) => void }).__setHidden = (v: boolean) => {
      hidden = v;
      document.dispatchEvent(new Event('visibilitychange'));
    };
  });
}

/** Let a read that just landed finish on the page before the clock moves again. */
const settle = (page: Page) => page.waitForTimeout(250);

const setHidden = (page: Page, hidden: boolean) =>
  page.evaluate((v) => (window as unknown as { __setHidden: (h: boolean) => void }).__setHidden(v), hidden);

/**
 * Serve the real matchup with its phase set to live, and count every read once
 * its answer has been handed back. Counting on arrival let the test move the
 * clock while a read was still in flight, and the screen rightly skips a tick
 * while one is (WebKit, CI, 8 November 2026).
 */
async function liveMatchup(page: Page): Promise<{ reads: () => number }> {
  let reads = 0;
  await page.route('**/api/overview', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ json: { ...body, lifecycle: { ...(body.lifecycle ?? {}), matchupVisible: true } } });
  });
  await page.route('**/api/leagues/*/matchup*', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (body?.forecast) body.forecast.phase = 'live';
    await route.fulfill({ response, json: body });
    reads += 1;
  });
  return { reads: () => reads };
}

test.describe('Matchup live refresh and the background', () => {
  test('pauses while hidden and refreshes at once on return', async ({ page }) => {
    await page.clock.install();
    await withControllableVisibility(page);
    const matchup = await liveMatchup(page);

    await page.goto('/');
    await page.getByTestId('tab-matchup').click();
    await expect(page.getByTestId('matchup-state')).toContainText('LIVE');
    await expect.poll(matchup.reads).toBeGreaterThanOrEqual(1);
    await settle(page);
    const arrived = matchup.reads();

    // Visible and live: one more read every thirty seconds.
    await page.clock.runFor(31_000);
    await expect.poll(matchup.reads).toBe(arrived + 1);
    await settle(page);

    // In the background: five minutes pass and nothing is read.
    await setHidden(page, true);
    const hiddenAt = matchup.reads();
    await page.clock.runFor(5 * 60_000);
    await page.waitForTimeout(300);
    expect(matchup.reads(), 'no reads while the app is in the background').toBe(hiddenAt);

    // Back in front: current at once, without waiting for a tick.
    await setHidden(page, false);
    await expect.poll(matchup.reads).toBe(hiddenAt + 1);
    await settle(page);

    // And back on the thirty-second clock after that.
    await page.clock.runFor(31_000);
    await expect.poll(matchup.reads).toBe(hiddenAt + 2);
  });
});
