/**
 * Round 22: a refresh that is fast, and that keeps working if Alex leaves.
 *
 * The server half (the job runs in the Worker's background slot, a second tap
 * joins, freshness windows) is `tests/refreshJob.test.ts`. This is the phone's
 * half: the screen updates by itself when the job is done, nothing is asked
 * while the app is in the background, coming back catches up, and a failed
 * source is listed quietly in Data health. The job is stubbed (see
 * `stubRefreshJob`): a real press writes, and the viewport projects share one
 * dev server. Runs at 360, 375, 390 and 430.
 */

import { expect, test, type Page } from '@playwright/test';
import { inSeason, openSetupGroup, stubRefreshJob } from './helpers.ts';

async function openTeam(page: Page) {
  await inSeason(page);
  await page.goto('/');
  await page.getByTestId('tab-team').click();
  await expect(page.getByTestId('starters-title')).toBeVisible();
}

/** The regular season: Waivers and Matchup tabs are drawn (as `waiver-plan` and `matchup` specs open them). */
async function seasonTabs(page: Page) {
  await page.route('**/api/overview', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: {
        ...body,
        season: { phase: 'regular', draftVisible: false, reason: 'the regular season is under way', assumed: false },
        lifecycle: { ...(body.lifecycle ?? {}), matchupVisible: true },
      },
    });
  });
}

/** Count the screen's own reads of a path, from now on. */
function countReads(page: Page, fragment: string): () => number {
  let n = 0;
  page.on('request', (r) => {
    if (r.method() === 'GET' && r.url().includes(fragment)) n += 1;
  });
  return () => n;
}

/** What iOS does when the app is switched away or the phone is locked, and back. */
async function setVisibility(page: Page, state: 'hidden' | 'visible') {
  await page.evaluate((s) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => s === 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

test.describe('Team refresh, as a server job', () => {
  test('the screen updates by itself when the job finishes', async ({ page }) => {
    await openTeam(page);
    const job = await stubRefreshJob(page, { runningChecks: 2 });
    const lineupReads = countReads(page, '/lineup');

    await page.getByTestId('team-refresh').click();
    // Spinning, and the reload waits for the job rather than racing it.
    await expect(page.getByTestId('team-refresh')).toBeDisabled();
    expect(lineupReads()).toBe(0);

    await expect(page.getByTestId('team-updated')).toBeVisible({ timeout: 20_000 });
    await expect.poll(lineupReads, { message: 'the lineup was re-read once the job was done' }).toBeGreaterThan(0);
    await expect(page.getByTestId('team-refresh')).toBeEnabled();
    expect(job.posts).toEqual(['startsit']);
  });

  test('leaving mid-refresh asks nothing while away, and coming back catches up', async ({ page }) => {
    await openTeam(page);
    const job = await stubRefreshJob(page, { runningChecks: 1_000 });
    const lineupReads = countReads(page, '/lineup');

    await page.getByTestId('team-refresh').click();
    await expect.poll(job.statusChecks, { timeout: 10_000 }).toBeGreaterThan(0);

    // He switches apps. The server keeps going (that is the server test's
    // half); the phone stops asking.
    await setVisibility(page, 'hidden');
    const checksWhenHidden = job.statusChecks();
    job.finishNow();
    await page.waitForTimeout(4_000);
    expect(job.statusChecks(), 'no polling while the app is in the background').toBeLessThanOrEqual(checksWhenHidden + 1);
    expect(lineupReads()).toBe(0);

    // He comes back: one look, the finished job, a reload and the time.
    await setVisibility(page, 'visible');
    await expect(page.getByTestId('team-updated')).toBeVisible({ timeout: 10_000 });
    await expect.poll(lineupReads).toBeGreaterThan(0);
    expect(job.posts, 'coming back does not start another refresh').toHaveLength(1);
  });

  test('opening Team after a refresh finished shows its time and reloads nothing extra', async ({ page }) => {
    await inSeason(page);
    await stubRefreshJob(page, { doneOnOpen: true });
    const lineupReads = countReads(page, '/lineup');
    await page.goto('/');
    await page.getByTestId('tab-team').click();
    await expect(page.getByTestId('starters-title')).toBeVisible();
    await expect(page.getByTestId('team-updated')).toHaveText(/^Updated \d{1,2}:\d{2} [AP]M$/);
    await page.waitForTimeout(1_000);
    expect(lineupReads(), 'only the screen’s own first read').toBeLessThanOrEqual(1);
  });

  test('the refresh button stays a full tap target, in light and dark', async ({ page }) => {
    await stubRefreshJob(page, { doneOnOpen: true });
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await openTeam(page);
      const button = page.getByTestId('team-refresh');
      const box = (await button.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      const updated = page.getByTestId('team-updated');
      await expect(updated).toBeVisible();
      // The time and the title never collide with the buttons, at any width.
      const nav = (await page.getByTestId('league-card').boundingBox())!;
      const u = (await updated.boundingBox())!;
      expect(u.x + u.width).toBeLessThanOrEqual(box.x + 1);
      expect(u.y).toBeGreaterThanOrEqual(nav.y);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, 'no sideways scroll').toBeLessThanOrEqual(0);
      await page.getByTestId('league-card').screenshot({ path: test.info().outputPath(`team-header-${scheme}.png`) });
    }
  });
});

test.describe('Matchup and Waivers share it', () => {
  test('a pull on Matchup runs the start/sit job and redraws the board when it lands', async ({ page }) => {
    await seasonTabs(page);
    await page.goto('/');
    await page.getByTestId('tab-matchup').click();
    await expect(page.getByTestId('matchup-nav')).toBeVisible();
    const job = await stubRefreshJob(page, { runningChecks: 1 });
    const boardReads = countReads(page, '/matchup');

    await page.evaluate(() => window.scrollTo(0, 0));
    const box = (await page.getByTestId('matchup-pull').boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + 40;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (const step of [12, 60, 120, 190]) await page.mouse.move(x, y + step);
    await page.mouse.up();

    await expect.poll(() => job.posts.length, { timeout: 10_000 }).toBe(1);
    expect(job.posts).toEqual(['startsit']);
    await expect.poll(boardReads, { timeout: 15_000 }).toBeGreaterThan(0);
  });

  test('the Waivers button runs its own job and the time follows it', async ({ page }) => {
    await seasonTabs(page);
    await inSeason(page);
    await page.goto('/');
    await page.getByTestId('tab-waivers').click();
    await expect(page.getByTestId('waivers-nav')).toBeVisible();
    const job = await stubRefreshJob(page, { runningChecks: 1, finishedAt: new Date().toISOString() });
    await page.getByTestId('waivers-refresh').click();
    await expect.poll(() => job.posts.length).toBe(1);
    expect(job.posts).toEqual(['waivers']);
    await expect(page.getByTestId('waivers-refresh')).toBeEnabled({ timeout: 15_000 });
    const expected = new Date(job.finishedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    await expect(page.getByTestId('waivers-updated')).toHaveText(`Updated ${expected}`);
  });
});

test.describe('Data health', () => {
  test('lists a source the last refresh could not reach, quietly', async ({ page }) => {
    await stubRefreshJob(page, {
      doneOnOpen: true,
      sources: [
        { source: 'roster', outcome: 'updated', detail: '1 roster(s) re-read' },
        { source: 'injury', outcome: 'unavailable', detail: 'injury report did not answer' },
        { source: 'vegas', outcome: 'current', detail: 'checked recently' },
        { source: 'schedule', outcome: 'current', detail: 'checked recently' },
      ],
    });
    await page.goto('/');
    await page.getByTestId('tab-setup').click();
    await openSetupGroup(page, 'data');
    await page.getByTestId('setup-data-health').click();
    await page.getByTestId('data-health-screen').waitFor();
    const row = page.getByTestId('data-health-refresh-injury');
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('data-state', 'unavailable');
    await expect(row).toContainText('injury report did not answer');
    await expect(page.getByTestId('data-health-refresh')).toContainText(/Last run/);
  });
});
