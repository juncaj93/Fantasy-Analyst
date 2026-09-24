/**
 * Demo Mode, driven the way the audit will drive it.
 *
 * Demo Mode is a placeholder now: one in-season week from captured responses
 * (`core/demo/placeholder/`). The draft-board demo and the other twenty-odd
 * scenarios went on 24 September 2026, and the tests that walked them went with
 * them. What is left is what still has to hold: entering and leaving, the
 * indicator, the screens it claims to show, and that nothing can be written.
 *
 * §14 asks that a test be able to enter Demo Mode, choose a named scenario,
 * navigate, assert, leave, and confirm live mode is restored. That is the shape
 * of this file, and every step is done through the product's own controls or
 * through the documented `?demo=` hook — nothing here reaches into the app's
 * internals, because a hook that only a test can use is not a hook the audit
 * can rely on.
 *
 * It runs at all four portrait widths, on WebKit in CI, because the screens it
 * exercises are the production ones and the point of a demo is that they hold
 * up under states that are hard to reach on a real league.
 */

import { expect, test, type Page } from '@playwright/test';
import { openSetupGroup } from './helpers.ts';

/** The audit hook: open the app already inside a named scenario. */
async function openScenario(page: Page, id: string) {
  await page.goto(`/?demo=${id}`);
  await expect(page.getByTestId('demo-bar')).toBeVisible();
  await expect(page.getByTestId('demo-scenario')).not.toBeEmpty();
}

async function tab(page: Page, name: string) {
  await page.getByTestId(`tab-${name}`).click();
  await page.waitForTimeout(350);
}

/**
 * Make sure the picker is showing, whatever state it was in.
 *
 * Idempotent on purpose: the panel opens itself while a scenario is running —
 * so that stepping a progression does not shut the controls under the reader's
 * hand — and a blind click on the summary would close it.
 */
async function openPicker(page: Page) {
  // Demo Mode is inside the App behavior fold, which is shut on every load.
  await openSetupGroup(page, 'behavior');
  const panel = page.getByTestId('demo-panel');
  await expect(panel).toBeVisible();
  if (!(await panel.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await panel.locator('summary').click();
  }
  await expect(page.getByTestId('demo-scenario-in-season')).toBeVisible();
}

test.describe('entering and leaving', () => {
  test('Settings offers Demo Mode, and it is not a tab', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('demo-bar')).toHaveCount(0);

    // §4: no permanent bottom-nav tab. The bar carries five destinations.
    await expect(page.locator('.tabbar button')).toHaveCount(5);
    await expect(page.getByTestId('tab-demo')).toHaveCount(0);

    await tab(page, 'setup');
    await openPicker(page);
  });

  test('choosing a scenario, walking it, and leaving restores live mode', async ({ page }) => {
    await page.goto('/');
    await tab(page, 'setup');
    await openPicker(page);

    // 1. enter, by choosing a named scenario
    await page.getByTestId('demo-scenario-in-season').click();
    await expect(page.getByTestId('demo-bar')).toBeVisible();
    await expect(page.getByTestId('demo-scenario')).toContainText('Sunday');

    // 2. navigate: the toolbar has followed the lifecycle into the season, so
    //    Waivers is in the bar where Draft used to be.
    await expect(page.getByTestId('tab-waivers')).toBeVisible();
    await expect(page.getByTestId('tab-draft')).toHaveCount(0);
    await tab(page, 'waivers');

    // 3. assert: the real screen, drawing the captured week
    await expect(page.locator('.demo-bar')).toBeVisible();
    await expect(page.getByTestId('tab-team')).toBeVisible();

    // 4. leave
    await page.getByTestId('demo-exit').click();
    await expect(page.getByTestId('demo-bar')).toHaveCount(0);

    // 5. live mode is back — including the seasonal tab, which followed the
    //    live league's own lifecycle rather than the scenario's.
    await expect(page.getByTestId('tab-draft')).toBeVisible();
    await tab(page, 'draft');
    await expect(page.getByTestId('board-list')).toBeVisible();
  });

  test('a reload inside a demo stays inside it, and does not flash live data', async ({ page }) => {
    await openScenario(page, 'in-season');
    const before = await page.getByTestId('demo-scenario').innerText();
    await page.reload();
    await expect(page.getByTestId('demo-bar')).toBeVisible();
    expect(await page.getByTestId('demo-scenario').innerText()).toBe(before);
  });

  test('leaving is remembered across a reload', async ({ page }) => {
    await openScenario(page, 'in-season');
    await page.getByTestId('demo-exit').click();
    await expect(page.getByTestId('demo-bar')).toHaveCount(0);
    // Without the query parameter this time: the stored choice must be gone.
    await page.goto('/');
    await expect(page.getByTestId('demo-bar')).toHaveCount(0);
  });
});

test.describe('the indicator', () => {
  test('says DEMO in words, names the scenario and prints its clock', async ({ page }) => {
    await openScenario(page, 'in-season');
    const bar = page.getByTestId('demo-bar');
    /*
     * §4 and §16: conveyed beyond colour. The badge is a word, the scenario is
     * named, and the as-of instant is a real `<time>` carrying the full
     * timestamp whatever the bar has room to print of it.
     *
     * It used to also assert the words `Fixture data`. They were the caption
     * that made this bar three lines tall on a phone, and they were saying what
     * the badge two centimetres to their left already says. What the rule
     * actually requires is that the state is legible without reading a colour,
     * and all three of these are text.
     */
    await expect(page.getByTestId('demo-badge')).toHaveText('DEMO');
    await expect(page.getByTestId('demo-scenario')).not.toBeEmpty();
    await expect(bar.locator('time')).toHaveAttribute('datetime', '2026-10-11T15:40:00.000Z');
    // One line, not a banner: it may not cost more than a navigation bar.
    expect((await bar.boundingBox())!.height).toBeLessThan(64);
  });

  test('follows the reader onto every screen', async ({ page }) => {
    await openScenario(page, 'in-season');
    for (const name of ['team', 'waivers', 'trades', 'players', 'setup']) {
      await tab(page, name);
      await expect(page.getByTestId('demo-bar'), `missing on ${name}`).toBeVisible();
    }
  });

  test('the exit is a full-sized tap target', async ({ page }) => {
    await openScenario(page, 'in-season');
    const box = (await page.getByTestId('demo-exit').boundingBox())!;
    expect(box.height, 'below the platform minimum').toBeGreaterThanOrEqual(43);
  });

  test('nothing hides behind it: the navigation bar still starts at the top of the page', async ({ page }) => {
    await openScenario(page, 'in-season');
    const demoBar = (await page.getByTestId('demo-bar').boundingBox())!;
    const navBar = (await page.locator('.nav-bar').first().boundingBox())!;
    // The demo bar owns the status-bar inset; the nav bar sits immediately
    // under it rather than reserving the same pixels a second time.
    expect(navBar.y).toBeGreaterThanOrEqual(demoBar.y + demoBar.height - 2);
    expect(navBar.y).toBeLessThanOrEqual(demoBar.y + demoBar.height + 4);
  });
});

test.describe('the placeholder draws the production screens', () => {
  test('Team draws the sample roster and its lineup', async ({ page }) => {
    await openScenario(page, 'in-season');
    await tab(page, 'team');
    await expect(page.getByTestId('starter-row').first()).toBeVisible();
    await page.getByTestId('bench-toggle').click();
    await expect(page.getByTestId('bench-row').first()).toBeVisible();
  });

  test('it is in season: Draft is not in the bar, Waivers and Matchup are', async ({ page }) => {
    await openScenario(page, 'in-season');
    await expect(page.getByTestId('tab-draft')).toHaveCount(0);
    await expect(page.getByTestId('tab-waivers')).toBeVisible();
    await expect(page.getByTestId('tab-matchup')).toBeVisible();
  });

  test('Waivers and Players draw rows', async ({ page }) => {
    await openScenario(page, 'in-season');
    await tab(page, 'waivers');
    await expect(page.locator('[data-testid="waiver-row"]').first()).toBeVisible();
    await tab(page, 'players');
    await expect(page.getByTestId('players-list')).toBeVisible();
  });

  test('a screen outside the demo says so rather than breaking', async ({ page }) => {
    await openScenario(page, 'in-season');
    await tab(page, 'trades');
    await expect(page.locator('.app-main')).toContainText('not in the demo');
  });
});

test.describe('a demo cannot change anything', () => {
  test('the server refuses a write from a demo browser, even a hand-made one', async ({ page }) => {
    await openScenario(page, 'in-season');

    // A request the app itself would never make: straight past the UI, straight
    // past the API client, to the server. It carries the demo cookie because
    // every same-origin request does, which is the whole point of using one.
    const result = await page.evaluate(async () => {
      const res = await fetch('/api/players/1001/my-guy', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ level: 3 }),
      });
      return { status: res.status, body: await res.text() };
    });

    expect(result.status).toBe(403);
    expect(result.body).toContain('Demo Mode is read-only');
  });

  test('and lets go the moment the demo is left', async ({ page }) => {
    await openScenario(page, 'in-season');
    await page.getByTestId('demo-exit').click();
    await expect(page.getByTestId('demo-bar')).toHaveCount(0);

    const status = await page.evaluate(async () => {
      const res = await fetch('/api/demo/status', { credentials: 'same-origin' });
      return res.json() as Promise<{ demo: boolean }>;
    });
    expect(status.demo).toBe(false);
  });

  test('the live board is untouched by everything above', async ({ page }) => {
    await page.goto('/');
    await tab(page, 'draft');
    await expect(page.getByTestId('board-list')).toBeVisible();
    // The dev server's own seeded league, not the demo's.
    await expect(page.getByTestId('board-league-name')).toContainText('Demo Dynasty');
  });
});
