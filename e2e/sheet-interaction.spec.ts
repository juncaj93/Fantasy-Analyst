/**
 * Everything a sheet must get right besides the swipe itself: closing from
 * outside it, focus, the page behind, and the draft board on the same layer
 * primitive.
 *
 * The swipe — finger-following, thresholds, flicks, the scroll-top rule — is in
 * `sheet-swipe.spec.ts`, beside the one hook every sheet uses for it
 * (`useSheetDrag`, `src/web/sheetDrag.ts`).
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import { openReview, openSetupGroup, pastTheSettle, swipeSheetAway, tapAboveCard, touchDrag } from './helpers.ts';

/** Wait until an element has stopped moving — two frames in the same place. */
async function settled(locator: Locator, tries = 20) {
  let previous = '';
  for (let i = 0; i < tries; i++) {
    const box = await locator.boundingBox();
    const here = box ? `${Math.round(box.x)},${Math.round(box.y)}` : '';
    if (here && here === previous) return;
    previous = here;
    await locator.page().waitForTimeout(50);
  }
}

/**
 * The scoring key: a sheet with controls in it, opened from a known button.
 *
 * Opened from the keyboard rather than by a tap, because what "the control that
 * opened it" means has to be unambiguous for the focus tests below — and it is
 * not: Safari does not focus a button when it is clicked, so a tap leaves the
 * invoker as whatever had focus before, which is the honest thing to return to
 * but not a thing a test can name. Pressing Enter on a focused control is the
 * case the restoration exists for, and it is the same case in every engine.
 */
async function openScoringKey(page: Page) {
  await page.goto('/');
  await openReview(page);
  await page.getByTestId('scoring-key-open').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('scoring-key')).toBeVisible();
  await settled(page.getByTestId('sheet-grip'));
}

/** A player's card: the tall, scrolling sheet the original complaint was about. */
async function openPlayerCard(page: Page) {
  await page.goto('/');
  await page.getByTestId('tab-players').click();
  const rows = page.getByTestId('player-search-row');
  await expect(rows.first()).toBeVisible();
  await rows.first().click();
  await expect(page.getByTestId('player-sheet')).toBeVisible();
  await expect(page.getByTestId('player-page-metrics')).toBeVisible();
  await settled(page.getByTestId('sheet-grip'));
}

test.describe('closing a sheet from outside it', () => {
  /** A tap on what you can see through above the card closes it. */
  test('closes on a tap above it, where the backdrop shows through', async ({ page }) => {
    await openScoringKey(page);
    await tapAboveCard(page);
    await expect(page.getByTestId('scoring-key')).toHaveCount(0);
  });

  /** Anywhere in the dimmed gap, not only near the top of the screen. */
  test('closes on a tap anywhere in the gap above the card', async ({ page }) => {
    for (const fraction of [0.25, 0.5, 0.75]) {
      await openPlayerCard(page);
      const card = (await page.locator('.sheet').boundingBox())!;
      const width = page.viewportSize()!.width;
      expect(card.y, 'the card must leave something above it to tap').toBeGreaterThan(80);

      await page.mouse.click(width / 2, card.y * fraction);
      await expect(
        page.getByTestId('player-sheet'),
        `a tap ${Math.round(fraction * 100)}% down the backdrop must close the card`,
      ).toHaveCount(0);
    }
  });

  /** …and a tap on the card itself never closes it. */
  test('stays open when the tap lands on the card', async ({ page }) => {
    await openPlayerCard(page);
    const card = (await page.locator('.sheet').boundingBox())!;

    await page.mouse.click(card.x + card.width / 2, card.y + 30);
    await expect(page.getByTestId('player-sheet')).toBeVisible();

    // Including on the body, well inside it.
    await page.mouse.click(card.x + card.width / 2, card.y + Math.min(card.height - 20, 120));
    await expect(page.getByTestId('player-sheet')).toBeVisible();
  });

  test('leaves the controls inside it tappable', async ({ page }) => {
    await openScoringKey(page);
    await page.getByTestId('sheet-close').click();
    await expect(page.getByTestId('scoring-key')).toHaveCount(0);
  });

  test('intercepts nothing once it has been dismissed', async ({ page }) => {
    await openPlayerCard(page);
    await swipeSheetAway(page);
    await expect(page.getByTestId('player-sheet')).toHaveCount(0);
    await expect(page.getByTestId('sheet-backdrop')).toHaveCount(0);

    // The list underneath takes the very next tap, with nothing in between.
    const rows = page.getByTestId('player-search-row');
    await rows.first().click();
    await expect(page.getByTestId('player-sheet')).toBeVisible();
  });

  /**
   * A drag inside a text field still belongs to the text field.
   *
   * Setup's paste boxes are the case: dragging in one moves the caret and
   * selects, and must not move the card.
   */
  test('leaves a drag inside a text field to the text field', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('tab-setup').click();
    await openSetupGroup(page, 'data');
    await expect(page.getByTestId('setup-step-sleeper')).toBeVisible();
    const panel = page.getByTestId('panel-preseason-projection');
    await panel.scrollIntoViewIfNeeded();
    await panel.locator('summary').click();
    await panel.getByTestId('open-projection-paste').click();
    await expect(page.getByTestId('projection-paste-sheet')).toBeVisible();
    await settled(page.getByTestId('sheet-grip'));

    const box = (await page.getByTestId('projection-paste-input').boundingBox())!;
    const result = await touchDrag(page, { x: box.x + box.width / 2, y: box.y + 8 }, { dy: 300, ms: 200 });
    expect(result.claimed).toBe(false);
    await pastTheSettle(page);
    await expect(page.getByTestId('projection-paste-sheet')).toBeVisible();

    // And it is still a sheet: a swipe from the grip still takes it away.
    await swipeSheetAway(page, { over: '.sheet-grip' });
    await expect(page.getByTestId('projection-paste-sheet')).toHaveCount(0);
  });

  test('still goes away with reduced motion asked for', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openScoringKey(page);
    await swipeSheetAway(page);
    await expect(page.getByTestId('scoring-key')).toHaveCount(0);
  });
});

test.describe('focus, while a sheet is open', () => {
  test('enters the dialog itself rather than its first control', async ({ page }) => {
    await openScoringKey(page);
    // The dialog, so a screen reader announces the dialog and its label. A
    // focused button would be announced as that button, and the reader would
    // arrive without being told what had opened.
    const active = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);
    expect(active).toBe('scoring-key');
  });

  test('takes the page behind out of the reading order, and gives it back', async ({ page }) => {
    await openScoringKey(page);
    expect(
      await page.evaluate(() => {
        const root = document.getElementById('root');
        return { inert: root?.hasAttribute('inert'), hidden: root?.getAttribute('aria-hidden') };
      }),
      'a modal sheet left the app behind it reachable',
    ).toEqual({ inert: true, hidden: 'true' });

    await page.getByTestId('sheet-close').click();
    await expect(page.getByTestId('scoring-key')).toHaveCount(0);
    expect(
      await page.evaluate(() => {
        const root = document.getElementById('root');
        return { inert: root?.hasAttribute('inert'), hidden: root?.getAttribute('aria-hidden') };
      }),
      'the app was left hidden after the sheet closed',
    ).toEqual({ inert: false, hidden: null });
  });

  test('keeps Tab inside it, forwards and backwards', async ({ page }) => {
    await openPlayerCard(page);

    const inside = async () =>
      page.evaluate(() => document.activeElement?.closest('[data-testid="player-sheet"]') !== null);

    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      expect(await inside(), `Tab ${i + 1} escaped the sheet`).toBe(true);
    }
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Shift+Tab');
      expect(await inside(), `Shift+Tab ${i + 1} escaped the sheet`).toBe(true);
    }
  });

  test('comes back to the control that opened it when Escape closes it', async ({ page }) => {
    await openScoringKey(page);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('scoring-key')).toHaveCount(0);
    await expect(page.getByTestId('scoring-key-open')).toBeFocused();
  });

  /*
   * The backdrop is colour now and nothing else — the scroller covers it, and
   * the transparent zone above the card is what a tap outside actually lands
   * on. Same gesture for the reader, same outcome, different element.
   */
  test('comes back to it when a tap above the card closes it too', async ({ page }) => {
    await openScoringKey(page);
    await tapAboveCard(page);
    await expect(page.getByTestId('scoring-key')).toHaveCount(0);
    await expect(page.getByTestId('scoring-key-open')).toBeFocused();
  });
});

/**
 * The page behind holds still, and is exactly where it was afterwards.
 *
 * `overflow: hidden` on the body — which is what this used to be, and what most
 * of the web still is — does nothing at all in iOS Safari: the document keeps
 * scrolling under a "locked" page. Pinning it is the technique both engines
 * honour, and the offset has to be given back by hand because un-pinning drops
 * the reader wherever the top of the document happens to be.
 */
test.describe('the page behind a sheet', () => {
  test('is pinned where the reader left it, and put back on close', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('tab-players').click();
    const rows = page.getByTestId('player-search-row');
    await expect(rows.first()).toBeVisible();

    await page.evaluate(() => window.scrollTo({ top: 240, behavior: 'auto' }));
    await expect.poll(async () => page.evaluate(() => Math.round(window.scrollY))).toBeGreaterThan(100);
    const before = await page.evaluate(() => Math.round(window.scrollY));

    await rows.nth(8).click();
    await expect(page.getByTestId('player-sheet')).toBeVisible();

    // Pinned, at the reader's own offset rather than at the top.
    expect(
      await page.evaluate(() => ({
        position: document.body.style.position,
        top: document.body.style.top,
      })),
    ).toEqual({ position: 'fixed', top: `-${before}px` });

    await page.getByTestId('sheet-close').click();
    await expect(page.getByTestId('player-sheet')).toHaveCount(0);
    expect(await page.evaluate(() => document.body.style.position)).toBe('');
    expect(
      Math.abs((await page.evaluate(() => Math.round(window.scrollY))) - before),
      'the reader was dropped somewhere else when the sheet closed',
    ).toBeLessThan(4);
  });
});

/**
 * The draft board is the other layer on the same primitive.
 *
 * It is not a sheet and has no dismissal gesture — it is a full-screen
 * companion with its own Close control — but it covers the app, and everything
 * that follows from covering the app is now the same code the sheet runs. It
 * used to be a second, slightly different copy: its own Escape listener, which
 * fired even when something was open over it, and its own `overflow: hidden`
 * scroll lock, which iOS Safari does not honour.
 */
test.describe('the draft board, on the same layer primitive', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('tab-draft').click();
    await page.getByTestId('draft-board-open').focus();
    await page.keyboard.press('Enter');
    /*
     * Through the destinations menu, which is a popover on this same primitive
     * — a menu rather than a sheet, and `useOverlay` all the same. Focus is
     * handed back to the header button when the menu unmounts and the board
     * then captures it, which is what keeps the Escape test below true.
     */
    await page.getByTestId('go-draft-board').click();
    await expect(page.getByTestId('draft-board')).toBeVisible();
  });

  test('takes focus, holds the page still and hides the app behind it', async ({ page }) => {
    expect(
      await page.evaluate(() => ({
        focused: document.activeElement?.getAttribute('data-testid') ?? null,
        inert: document.getElementById('root')?.hasAttribute('inert'),
        pinned: document.body.style.position,
      })),
    ).toEqual({ focused: 'draft-board', inert: true, pinned: 'fixed' });
  });

  test('closes on Escape and gives focus back to the control that opened it', async ({ page }) => {
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('draft-board')).toHaveCount(0);
    await expect(page.getByTestId('draft-board-open')).toBeFocused();
    expect(await page.evaluate(() => document.body.style.position)).toBe('');
    expect(await page.evaluate(() => document.getElementById('root')?.hasAttribute('inert'))).toBe(false);
  });
});
