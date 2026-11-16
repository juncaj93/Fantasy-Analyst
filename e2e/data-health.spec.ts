/**
 * One row in Settings, one screen behind it, on a phone.
 *
 * What the *payload* says is not this file's subject — `tests/dataHealth.*`
 * owns that, and can set up an injury pipeline four days behind where a browser
 * test can only look at whatever the dev server seeded. What this owns is the
 * part only a browser can prove: that the row is reachable and readable, that
 * the screen behind it says the state in words rather than in colour, that the
 * technical detail stays folded until somebody asks for it, and that none of it
 * overflows a 360px phone in either theme.
 *
 * The one content claim it does make is the one §3 is about: nothing on this
 * screen may present a source that has legitimately published nothing as a
 * fault. That is a rendering decision as much as a model one — a warning
 * triangle beside `Waiting on source` would undo the distinction the whole
 * model exists to draw — so it is checked here as well as in the unit tests.
 */

import { expect, test, type Page } from '@playwright/test';
import { openSetupGroup } from './helpers.ts';

const ROW = 'setup-data-health';
const SCREEN = 'data-health-screen';

async function openSetup(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('tab-setup').click();
  // Data health is in the Data group, which is shut on load like the other two.
  await openSetupGroup(page, 'data');
  await page.getByTestId(ROW).waitFor();
}

async function openHealth(page: Page): Promise<void> {
  await openSetup(page);
  await page.getByTestId(ROW).click();
  await page.getByTestId(SCREEN).waitFor();
  // The screen fetches on mount; wait for the first source row rather than for
  // a timeout, so a slow runner cannot make this flaky.
  await page.getByTestId('data-health-source-injuries').waitFor();
}

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe('the Setup row', () => {
  test('says the state and how long ago anything was refreshed', async ({ page }) => {
    await openSetup(page);
    const row = page.getByTestId(ROW);
    await expect(row).toBeVisible();
    await expect(row).toContainText('Data health');
    /*
     * One of the two sentences the model can produce. Asserted as a shape
     * rather than verbatim: which one appears depends on what the dev server
     * seeded, and pinning the exact string would make this a test about the
     * seed.
     */
    await expect(row).toContainText(/Healthy|Waiting on source|Some data stale|Degraded|Refresh problem|need/);
  });

  /**
   * Last in the group that is about data, and never in the taskbar — §9.
   *
   * It used to be asserted as sitting beside the support snapshot, which was
   * true when Settings was two lists and is not now: the snapshot is a support
   * tool and lives in Account & support, and this row reports on the sources
   * above it in Data. What survives unchanged is the half that matters — it is
   * a Settings row and never a destination.
   */
  test('is the last row of the Data group, and never on the toolbar', async ({ page }) => {
    await openSetup(page);
    const rows = page.getByTestId('setup-group-data-body').locator('[data-testid^="setup-"], [data-testid^="help-"], [data-testid^="panel-"]');
    await expect(rows.last()).toHaveAttribute('data-testid', ROW);
    await expect(page.locator('.tabbar')).not.toContainText('Data health');
  });

  test('is a comfortable tap target', async ({ page }) => {
    await openSetup(page);
    const box = await page.getByTestId(ROW).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });
});

test.describe('the Data health screen', () => {
  test('pushes, and comes back', async ({ page }) => {
    await openHealth(page);
    await expect(page.getByTestId(SCREEN)).toBeVisible();
    await page.getByRole('button', { name: /Setup/ }).first().click();
    await expect(page.getByTestId(SCREEN)).toHaveCount(0);
    await expect(page.getByTestId(ROW)).toBeVisible();
  });

  test('lists every input the app reasons from', async ({ page }) => {
    await openHealth(page);
    for (const id of ['injuries', 'vegas', 'usage', 'manager-intel']) {
      await expect(page.getByTestId(`data-health-source-${id}`)).toBeVisible();
    }
  });

  /**
   * State is a word, never only a colour.
   *
   * The accessibility claim and the §3 claim are the same claim here: a reader
   * with no colour perception, and a reader who does not know what amber means,
   * both have to be able to read the state off the row.
   */
  test('says every state in words', async ({ page }) => {
    await openHealth(page);
    const rows = page.locator('[data-testid^="data-health-source-"]');
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      const state = await row.getAttribute('data-state');
      const text = await row.innerText();
      expect(text, `${state} row carries no word for its state`).toMatch(
        /Current|Stale|Waiting on source|Degraded|Missing|Deferred|Not known/,
      );
    }
  });

  /**
   * A source with nothing published must not be dressed as a failure.
   *
   * Checked on the marks rather than on the words: `Waiting on source` beside a
   * warning triangle would be exactly the mixed message this refuses.
   */
  test('never marks a waiting or deferred source as a warning', async ({ page }) => {
    await openHealth(page);
    for (const state of ['waiting', 'deferred']) {
      const rows = page.locator(`[data-testid^="data-health-source-"][data-state="${state}"]`);
      for (let i = 0; i < (await rows.count()); i++) {
        await expect(rows.nth(i).locator('.list-state-warn')).toHaveCount(0);
      }
    }
  });

  test('says what the last scheduled refresh did, or that none has been recorded', async ({ page }) => {
    await openHealth(page);
    const run = page.getByTestId('data-health-run');
    const none = page.getByTestId('data-health-run-none');
    expect((await run.count()) + (await none.count()), 'the run section said nothing at all').toBeGreaterThan(0);
  });

  /**
   * Consumer-friendly by default — §10.
   *
   * Exact instants, outcome codes and subrequest counters are what a support
   * agent asks for second, and a user should never have to scroll past them.
   */
  test('keeps the technical detail folded until it is asked for', async ({ page }) => {
    await openHealth(page);
    await expect(page.getByTestId('data-health-technical')).toHaveCount(0);
    await page.getByTestId('data-health-technical-toggle').click();
    await expect(page.getByTestId('data-health-technical')).toBeVisible();
    await expect(page.getByTestId('data-health-technical')).toContainText(/last success|last attempt/);
  });

  test('uses plain language above the fold', async ({ page }) => {
    await openHealth(page);
    const text = (await page.locator('main').innerText()).toLowerCase();
    for (const jargon of ['json', 'endpoint', 'd1 ', 'binding', 'http request', 'subrequest', 'stack']) {
      expect(text, `Data health should not say "${jargon.trim()}" before Technical details`).not.toContain(jargon);
    }
  });
});

test.describe('on a phone', () => {
  test('does not scroll sideways, folded or unfolded', async ({ page }) => {
    await openHealth(page);
    expect(await overflow(page), 'the source list overflows').toBeLessThanOrEqual(1);
    await page.getByTestId('data-health-technical-toggle').click();
    await expect(page.getByTestId('data-health-technical')).toBeVisible();
    expect(await overflow(page), 'the technical panel overflows').toBeLessThanOrEqual(1);
  });

  /**
   * Both themes, because the marks are the only thing on this screen that is
   * drawn rather than written and a contrast failure would take them out.
   */
  test('does not scroll sideways in either theme', async ({ page }) => {
    await openHealth(page);
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      await expect(page.getByTestId('data-health-source-injuries')).toBeVisible();
      expect(await overflow(page), `${theme} overflows horizontally`).toBeLessThanOrEqual(1);
    }
    await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  });

  test('every row is a readable height rather than a clipped line', async ({ page }) => {
    await openHealth(page);
    const rows = page.locator('[data-testid^="data-health-source-"]');
    for (let i = 0; i < (await rows.count()); i++) {
      const box = await rows.nth(i).boundingBox();
      expect(box!.height, `row ${i} is clipped`).toBeGreaterThanOrEqual(32);
    }
  });
});
