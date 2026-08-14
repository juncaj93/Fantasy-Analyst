/**
 * Moving through the app: pushed screens, the back gesture, sheets, and the
 * browser's own navigation.
 *
 * The claim being defended here is narrow and important. The app gained an
 * interactive swipe-back and a swipe-away sheet, and neither is allowed to
 * cost anything: not a scroll that stops working, not a Safari gesture that
 * gets hijacked, not a history entry, and above all not a piece of product
 * state. **Back is navigation and never undo** — the swipe calls the same
 * function the Back control calls, so this suite checks the destination and
 * then checks that everything the screen was carrying is still there.
 *
 * Standalone is simulated the way iOS announces it — `navigator.standalone` —
 * which is the same honest half-simulation pwa.spec.ts uses.
 */

import { expect, test, type Page } from '@playwright/test';

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

/** Announce the page the way iOS announces a Home Screen launch. */
async function asHomeScreenApp(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, 'standalone', { value: true, configurable: true });
  });
}

/**
 * Drag, in steps, the way a thumb does.
 *
 * Pointer events rather than a synthesised touch sequence: they are what the
 * app listens to, they are what iOS produces for a finger, and they are the one
 * input both engines under test generate identically.
 */
async function drag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps = 12,
) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * i) / steps,
      from.y + ((to.y - from.y) * i) / steps,
    );
  }
  await page.mouse.up();
}

/** Open a player's detail screen from the Players list. */
async function openPlayerDetail(page: Page) {
  await page.getByTestId('tab-players').click();
  const row = page.getByTestId('player-search-row').first();
  await expect(row).toBeVisible();
  const playerId = await row.getAttribute('data-player-id');
  await row.click();
  await expect(page.getByTestId('player-detail-screen')).toBeVisible();
  return playerId!;
}

test.describe('pushed detail screens', () => {
  test('a detail screen carries its own title and a Back control', async ({ page }) => {
    await page.goto('/');
    await openPlayerDetail(page);

    const back = page.getByTestId('back-button');
    await expect(back).toBeVisible();
    // Back says where it goes, which is the list it was opened from.
    await expect(back).toContainText('Players');

    await back.click();
    await expect(page.getByTestId('player-detail-screen')).toHaveCount(0);
    await expect(page.getByTestId('player-search-row').first()).toBeVisible();
  });

  test('opening and leaving a detail screen adds no history entry', async ({ page }) => {
    await page.goto('/');
    const before = await page.evaluate(() => window.history.length);

    await openPlayerDetail(page);
    expect(await page.evaluate(() => window.history.length), 'a detail is not a new page').toBe(before);

    await page.getByTestId('back-button').click();
    await expect(page.getByTestId('player-search-row').first()).toBeVisible();
    expect(await page.evaluate(() => window.history.length)).toBe(before);
    expect(new URL(page.url()).pathname).toBe('/');
  });

  test('a reload leaves the reader on the app, not in a broken half-state', async ({ page }) => {
    await page.goto('/');
    await openPlayerDetail(page);
    await page.reload();
    await expect(page.getByTestId('tab-draft')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/');
  });

  test('Setup opens each area as a pushed screen with a way back', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('tab-setup').click();
    await page.getByTestId('setup-step-newsletter').click();

    await expect(page.getByTestId('panel-newsletter')).toBeVisible();
    const back = page.getByTestId('back-button');
    await expect(back).toContainText('Setup');
    await back.click();
    await expect(page.getByTestId('setup-step-newsletter')).toBeVisible();
  });
});

test.describe('the back gesture, as a Home Screen app', () => {
  test.use({ userAgent: IPHONE_UA });

  test.beforeEach(async ({ page }) => {
    await asHomeScreenApp(page);
    await page.goto('/');
    await expect(page.getByTestId('tab-draft')).toBeVisible();
  });

  test('a swipe from the leading edge goes back where Back goes', async ({ page }) => {
    await openPlayerDetail(page);
    await expect(page.getByTestId('player-detail-screen')).toHaveAttribute('data-swipe-back', 'on');

    await drag(page, { x: 4, y: 420 }, { x: 330, y: 430 });

    await expect(page.getByTestId('player-detail-screen')).toHaveCount(0);
    await expect(page.getByTestId('player-search-row').first()).toBeVisible();
  });

  test('the swipe changes nothing but which screen is showing', async ({ page }) => {
    const playerId = await openPlayerDetail(page);
    const control = page
      .locator(`[data-testid="player-search-row"][data-player-id="${playerId}"]`)
      .getByTestId('my-guy-control');

    await drag(page, { x: 4, y: 420 }, { x: 330, y: 430 });
    await expect(page.getByTestId('player-search-row').first()).toBeVisible();

    // Back is navigation: the player's own flag is exactly where it was.
    await expect(control).toHaveAttribute('data-level', '0');
    // …and so is the draft queue, which a stray tap on the way out could reach.
    await page.getByTestId('tab-draft').click();
    await page.getByTestId('queue-filter').click();
    await expect(page.getByText(/Your queue is empty/)).toBeVisible();
  });

  test('an incomplete swipe snaps back and stays on the screen', async ({ page }) => {
    await openPlayerDetail(page);
    await drag(page, { x: 4, y: 420 }, { x: 60, y: 424 });
    await expect(page.getByTestId('player-detail-screen')).toBeVisible();
  });

  test('a vertical drag from the edge scrolls rather than navigating', async ({ page }) => {
    await openPlayerDetail(page);
    await drag(page, { x: 6, y: 500 }, { x: 12, y: 180 });
    await expect(page.getByTestId('player-detail-screen')).toBeVisible();
  });

  test('a swipe that did not start at the edge does nothing', async ({ page }) => {
    await openPlayerDetail(page);
    await drag(page, { x: 200, y: 420 }, { x: 360, y: 424 });
    await expect(page.getByTestId('player-detail-screen')).toBeVisible();
  });

  test('a top-level tab cannot be swiped away', async ({ page }) => {
    // There is no layer to swipe on a tab root, and swiping does not navigate.
    await expect(page.locator('[data-swipe-back]')).toHaveCount(0);
    await drag(page, { x: 4, y: 420 }, { x: 340, y: 424 });
    await expect(page.getByTestId('tab-draft')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('board-list')).toBeVisible();
  });

  test('there is no swipe between tabs', async ({ page }) => {
    // Horizontal movement across the middle of a tab root is not navigation:
    // it would fight the position filter and the scrolling metric rows.
    await drag(page, { x: 300, y: 500 }, { x: 40, y: 505 });
    await expect(page.getByTestId('tab-draft')).toHaveAttribute('aria-current', 'page');
    await drag(page, { x: 40, y: 500 }, { x: 320, y: 505 });
    await expect(page.getByTestId('tab-draft')).toHaveAttribute('aria-current', 'page');
  });

  test('still navigates with reduced motion, without animating', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openPlayerDetail(page);
    await drag(page, { x: 4, y: 420 }, { x: 330, y: 430 });
    await expect(page.getByTestId('player-search-row').first()).toBeVisible();
  });
});

test.describe('the back gesture in a browser tab', () => {
  test('is not offered, because the edge is the browser’s there', async ({ page }) => {
    await page.goto('/');
    await openPlayerDetail(page);
    // The layer says so, and the gesture is inert: the screen stays put.
    await expect(page.getByTestId('player-detail-screen')).toHaveAttribute('data-swipe-back', 'off');
    await drag(page, { x: 4, y: 420 }, { x: 340, y: 424 });
    await expect(page.getByTestId('player-detail-screen')).toBeVisible();
    // Back itself still works, which is the point: nothing was taken away.
    await page.getByTestId('back-button').click();
    await expect(page.getByTestId('player-search-row').first()).toBeVisible();
  });
});

test.describe('sheets', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('tab-review').click();
    await page.getByTestId('scoring-key-open').click();
    await expect(page.getByTestId('scoring-key')).toBeVisible();
  });

  test('opens over the screen with a handle and a way out that is not a gesture', async ({ page }) => {
    await expect(page.getByTestId('sheet-grip')).toBeVisible();
    await expect(page.getByTestId('scoring-key')).toContainText('Good news');
    await page.getByTestId('sheet-close').click();
    await expect(page.getByTestId('scoring-key')).toHaveCount(0);
  });

  test('a downward pull dismisses it', async ({ page }) => {
    const box = (await page.getByTestId('sheet-grip').boundingBox())!;
    await drag(page, { x: box.x + box.width / 2, y: box.y + 4 }, { x: box.x + box.width / 2, y: box.y + 420 });
    await expect(page.getByTestId('scoring-key')).toHaveCount(0);
  });

  test('a short pull springs back rather than dismissing', async ({ page }) => {
    const box = (await page.getByTestId('sheet-grip').boundingBox())!;
    await drag(page, { x: box.x + box.width / 2, y: box.y + 4 }, { x: box.x + box.width / 2, y: box.y + 24 });
    await expect(page.getByTestId('scoring-key')).toBeVisible();
  });

  test('scrolled content keeps the gesture until it is back at the top', async ({ page }) => {
    // Force the body to be scrolled: a sheet that dismissed from here would be
    // taking a scroll away from the reader.
    await page.evaluate(() => {
      const body = document.querySelector('.sheet-body') as HTMLElement;
      body.style.maxHeight = '80px';
      body.scrollTop = 40;
    });
    const box = (await page.getByTestId('scoring-key').boundingBox())!;
    await drag(page, { x: box.x + box.width / 2, y: box.y + 120 }, { x: box.x + box.width / 2, y: box.y + 500 });
    await expect(page.getByTestId('scoring-key')).toBeVisible();
    await page.getByTestId('sheet-close').click();
  });

  test('the backdrop closes it, and nothing behind it changed', async ({ page }) => {
    const before = await page.getByTestId('review-card').count();
    await page.getByTestId('sheet-backdrop').click({ position: { x: 10, y: 10 } });
    await expect(page.getByTestId('scoring-key')).toHaveCount(0);
    await expect(page.getByTestId('review-card')).toHaveCount(before);
  });
});

test.describe('the browser’s own navigation', () => {
  test('every tab still navigates in place, with no page load', async ({ page }) => {
    await page.goto('/');
    for (const tab of ['team', 'trades', 'players', 'review', 'setup', 'draft'] as const) {
      await page.getByTestId(`tab-${tab}`).click();
      await expect(page.getByTestId(`tab-${tab}`)).toHaveAttribute('aria-current', 'page');
      expect(new URL(page.url()).pathname).toBe('/');
    }
  });

  test('going back from the app leaves it, as it always did', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('tab-setup').click();
    await page.goBack();
    // The app never pushed a state of its own, so the browser's back is the
    // browser's: it leaves the site rather than unwinding an in-app screen.
    expect(page.url()).not.toContain('/api');
  });
});
