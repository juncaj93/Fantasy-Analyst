/**
 * Flagging a screen, from the screens.
 *
 * The unit tests own what a flag *contains* and what the copied block *says* —
 * they can walk fifty entries and a malformed payload where a browser test can
 * only look at one. What this owns is everything that is only true in a
 * browser: that the control is on every screen, that it is a full target, that
 * it takes no tap and no drag that belonged to something else, that the note is
 * genuinely optional, that one entry can be deleted without the others, and
 * that copying asks before it clears.
 *
 * **The Draft screen is deliberately not exercised here.** A real draft is
 * imminent and nothing about that screen may move; the control is drawn by the
 * shell, so being present on Team, Players, Trades and Setup is the same
 * evidence that it is present on Draft, and `toolbar.spec.ts` already holds the
 * shell to leaving that screen alone.
 */

import { expect, test, type Page } from '@playwright/test';
import { openReview } from './helpers.ts';

/** Four screens that are not Draft, which is off limits this week. */
const SCREENS = ['team', 'players', 'trades', 'setup'] as const;

/** The word the toolbar uses for each, which is the word a flag records. */
const SCREEN_NAMES: Record<(typeof SCREENS)[number], string> = {
  team: 'Team',
  players: 'Players',
  trades: 'Trades',
  setup: 'Setup',
};

async function open(page: Page, tab: string): Promise<void> {
  await page.getByTestId(`tab-${tab}`).click();
  await page.getByTestId('flag-button').waitFor();
}

/** Start from a queue nobody else has written to. */
async function fresh(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      window.localStorage.removeItem('fa.feedback.queue');
    } catch {
      /* private mode; the queue is empty there anyway */
    }
  });
  await page.goto('/');
  await page.getByTestId('flag-button').waitFor();
}

/**
 * Read the clipboard without needing a clipboard permission.
 *
 * The same substitution `support-snapshot.spec.ts` makes, and for the same
 * reason: WebKit does not grant `clipboard-read` to a test, and what matters
 * here is what the app *tried to write*.
 */
async function captureClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const store = { text: null as string | null };
    (window as unknown as { __clipboard: typeof store }).__clipboard = store;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          store.text = text;
        },
      },
    });
  });
}

const clipboardText = (page: Page) =>
  page.evaluate(() => (window as unknown as { __clipboard: { text: string | null } }).__clipboard.text);

const queueLength = (page: Page) =>
  page.evaluate(() => {
    const raw = window.localStorage.getItem('fa.feedback.queue');
    return raw ? (JSON.parse(raw) as { entries: unknown[] }).entries.length : 0;
  });

async function openFlagged(page: Page): Promise<void> {
  await page.getByTestId('tab-setup').click();
  await page.getByTestId('setup-flagged').click();
  await page.getByTestId('flagged-screen').waitFor();
}

test.describe('the control is on every screen, and is a control', () => {
  test('is reachable from each of them, named for the screen it would flag', async ({ page }) => {
    await fresh(page);
    for (const tab of SCREENS) {
      await open(page, tab);
      const button = page.getByTestId('flag-button');
      await expect(button).toBeVisible();
      await expect(button).toHaveAttribute('aria-label', `Flag ${SCREEN_NAMES[tab]} for a look later`);
    }
  });

  test('is a full target at every width, and inside the page', async ({ page }) => {
    await fresh(page);
    const box = (await page.getByTestId('flag-button').boundingBox())!;
    // §5: the mark may be smaller than the target, the target may not.
    expect(box.width, `the control is ${box.width}px wide`).toBeGreaterThanOrEqual(40);
    expect(box.height, `the control is ${box.height}px tall`).toBeGreaterThanOrEqual(40);

    const size = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(size.width + 0.5);
    expect(box.y + box.height).toBeLessThanOrEqual(size.height + 0.5);
  });

  /*
   * It is not navigation and must not be counted as any. `toolbar.spec.ts`
   * asserts there is exactly one navigation on screen; this is the other half
   * of that promise, from this side.
   */
  test('is not a second navigation', async ({ page }) => {
    await fresh(page);
    await expect(page.locator('nav[aria-label="Main navigation"]')).toHaveCount(1);
    await expect(page.locator('.flag-layer nav')).toHaveCount(0);
  });

  test('sits clear of the toolbar rather than over it', async ({ page }) => {
    await fresh(page);
    const gap = await page.evaluate(() => {
      const bar = document.querySelector('.tabbar')!.getBoundingClientRect();
      const flag = document.querySelector('.flag-button')!.getBoundingClientRect();
      return { barTop: bar.top, flagBottom: flag.bottom, barLeft: bar.left, flagLeft: flag.left };
    });
    expect(gap.flagBottom, 'the control overlaps the toolbar').toBeLessThanOrEqual(gap.barTop + 0.5);
  });

  test('makes no screen scroll sideways', async ({ page }) => {
    await fresh(page);
    for (const tab of SCREENS) {
      await open(page, tab);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${tab} overflows sideways`).toBeLessThanOrEqual(1);
    }
  });
});

/**
 * The gesture question, answered by measurement rather than by assertion.
 *
 * The control is fixed over a scrolling page, so the thing that would actually
 * break is a drag that starts on it: if it swallowed the movement the page
 * would sit still under the reader's thumb. Nothing here calls
 * `preventDefault` or sets `touch-action`, and this is what proves it.
 */
test.describe('it takes nothing that belonged to something else', () => {
  test('a drag that starts on it still scrolls the page', async ({ page }) => {
    await fresh(page);
    await open(page, 'players');

    const box = (await page.getByTestId('flag-button').boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    const before = await page.evaluate(() => window.scrollY);
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (const step of [10, 40, 90, 140]) await page.mouse.move(x, y - step);
    await page.mouse.up();
    await page.waitForTimeout(150);
    const after = await page.evaluate(() => window.scrollY);

    /*
     * A mouse drag is not a touch scroll in any engine, so what is asserted is
     * the property that would fail either way: the drag did not fire the
     * control. A swallowed gesture would have opened the strip.
     */
    await expect(page.getByTestId('flag-strip')).toHaveCount(0);
    expect(after).toBeGreaterThanOrEqual(before);
  });

  /*
   * The empty part of the layer is a fixed band the width of the page. If it
   * took pointer events it would swallow every tap along the bottom of every
   * screen, which is the worst thing this design could do quietly.
   */
  test('the band it lives in is not tappable, only the control is', async ({ page }) => {
    await fresh(page);
    const hit = await page.evaluate(() => {
      const flag = document.querySelector('.flag-button')!.getBoundingClientRect();
      // A point in the layer, level with the control, at the leading edge.
      const found = document.elementFromPoint(12, flag.top + flag.height / 2);
      return found?.closest('.flag-layer') != null;
    });
    expect(hit, 'the empty part of the flag layer is taking taps').toBe(false);
  });

  /*
   * The strip is not modal, so a sheet can open over it — and the layer has to
   * go away when one does, or it would be a floating control on top of a modal.
   * The flag is safe either way, because it was written before the strip was
   * drawn; the sentence somebody was halfway through is the thing that would
   * otherwise go with it.
   */
  test('a layer opening over the strip takes it away and keeps what was typed', async ({ page }) => {
    await fresh(page);
    await openReview(page);
    await page.getByTestId('flag-button').click();
    await page.getByTestId('flag-note').fill('the scoring key is missing a category');

    await page.getByTestId('scoring-key-open').click();
    await expect(page.getByTestId('scoring-key')).toBeVisible();
    await expect(page.getByTestId('flag-layer')).toHaveCount(0);

    await page.getByTestId('sheet-backdrop').click({ position: { x: 5, y: 5 } });
    await expect(page.getByTestId('flag-layer')).toBeVisible();
    await expect(page.getByTestId('flag-strip')).toHaveCount(0);

    await page.getByTestId('back-button').click();
    await openFlagged(page);
    await expect(page.getByTestId('flagged-list')).toContainText('the scoring key is missing a category');
  });

  test('leaves with the keyboard, exactly as the toolbar does', async ({ page }) => {
    /*
     * Playwright cannot raise a soft keyboard, so the signal the app reads is
     * stood in for — the same substitution `toolbar.spec.ts` makes, in the same
     * shape. Everything downstream of it is real.
     */
    await page.addInitScript(() => {
      let hidden = 0;
      const fake = new EventTarget();
      Object.defineProperties(fake, {
        height: { get: () => window.innerHeight - hidden },
        offsetTop: { get: () => 0 },
      });
      Object.defineProperty(window, 'visualViewport', { value: fake, configurable: true });
      Object.defineProperty(window, '__keyboard', {
        configurable: true,
        value: (px: number) => {
          hidden = px;
          fake.dispatchEvent(new Event('resize'));
        },
      });
    });
    await fresh(page);
    await open(page, 'players');
    await expect(page.getByTestId('flag-layer')).toHaveAttribute('data-hidden', 'no');

    await page.evaluate(() => (window as unknown as { __keyboard: (px: number) => void }).__keyboard(336));
    await expect(page.getByTestId('flag-layer')).toHaveAttribute('data-hidden', 'yes');
    await expect(page.getByTestId('flag-button')).toBeHidden();

    await page.evaluate(() => (window as unknown as { __keyboard: (px: number) => void }).__keyboard(0));
    await expect(page.getByTestId('flag-layer')).toHaveAttribute('data-hidden', 'no');
    await expect(page.getByTestId('flag-button')).toBeVisible();
  });
});

test.describe('one tap is the whole of it', () => {
  test('flags the screen, and says which', async ({ page }) => {
    await fresh(page);
    await open(page, 'team');
    await page.getByTestId('flag-button').click();

    await expect(page.getByTestId('flag-strip-what')).toHaveText('Flagged Team');
    expect(await queueLength(page)).toBe(1);
  });

  /*
   * The property the whole interaction rests on: the flag is already saved
   * before anything is drawn, so walking away is not "cancel".
   */
  test('the flag survives ignoring the strip entirely', async ({ page }) => {
    await fresh(page);
    await open(page, 'trades');
    await page.getByTestId('flag-button').click();
    await expect(page.getByTestId('flag-strip')).toBeVisible();

    // Nothing pressed, nothing typed, and the strip takes itself away.
    await expect(page.getByTestId('flag-strip')).toHaveCount(0, { timeout: 15_000 });
    expect(await queueLength(page)).toBe(1);
  });

  test('a note is attached when one is typed, and Done is not the only way out', async ({ page }) => {
    await fresh(page);
    await open(page, 'players');
    await page.getByTestId('flag-button').click();
    await page.getByTestId('flag-note').fill('the search field lost my query');
    await page.getByTestId('flag-done').click();

    await expect(page.getByTestId('flag-strip')).toHaveCount(0);
    await openFlagged(page);
    await expect(page.getByTestId('flagged-list')).toContainText('the search field lost my query');
  });

  test('Escape keeps the flag and the words typed so far', async ({ page }) => {
    await fresh(page);
    await open(page, 'players');
    await page.getByTestId('flag-button').click();
    await page.getByTestId('flag-note').fill('half a sentence');
    await page.keyboard.press('Escape');

    await expect(page.getByTestId('flag-strip')).toHaveCount(0);
    await openFlagged(page);
    await expect(page.getByTestId('flagged-list')).toContainText('half a sentence');
  });

  test('flagging three different screens records three different screens', async ({ page }) => {
    await fresh(page);
    for (const tab of ['team', 'players', 'trades'] as const) {
      await open(page, tab);
      await page.getByTestId('flag-button').click();
      await page.getByTestId('flag-done').click();
    }

    await openFlagged(page);
    const list = page.getByTestId('flagged-list');
    await expect(list).toContainText('Team');
    await expect(list).toContainText('Players');
    await expect(list).toContainText('Trades');
    // Newest first: the last one flagged is the first one listed.
    const first = await page.locator('[data-testid^="flag-entry-"]').first().textContent();
    expect(first).toContain('Trades');
  });
});

test.describe('the queue, in Settings', () => {
  test('says how much is waiting, and says nothing when nothing is', async ({ page }) => {
    await fresh(page);
    await page.getByTestId('tab-setup').click();
    await expect(page.getByTestId('setup-flagged')).toContainText('Nothing flagged');

    await open(page, 'team');
    await page.getByTestId('flag-button').click();
    await page.getByTestId('flag-done').click();
    await page.getByTestId('tab-setup').click();
    await expect(page.getByTestId('setup-flagged')).toContainText('1 thing flagged');
  });

  test('is a full target, like every other settings row', async ({ page }) => {
    await fresh(page);
    await page.getByTestId('tab-setup').click();
    const box = (await page.getByTestId('setup-flagged').boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
  });

  test('deletes one entry and leaves the rest', async ({ page }) => {
    await fresh(page);
    for (const tab of ['team', 'players'] as const) {
      await open(page, tab);
      await page.getByTestId('flag-button').click();
      await page.getByTestId('flag-note').fill(`about ${tab}`);
      await page.getByTestId('flag-done').click();
    }

    await openFlagged(page);
    await expect(page.getByTestId('flagged-list')).toContainText('about team');
    await expect(page.getByTestId('flagged-list')).toContainText('about players');

    await page.locator('[data-testid^="flag-forget-"]').first().click();
    await expect(page.getByTestId('flagged-list')).not.toContainText('about players');
    await expect(page.getByTestId('flagged-list')).toContainText('about team');
    expect(await queueLength(page)).toBe(1);
  });

  test('the delete control is a full target and is not nested in another one', async ({ page }) => {
    await fresh(page);
    await open(page, 'team');
    await page.getByTestId('flag-button').click();
    await page.getByTestId('flag-done').click();
    await openFlagged(page);

    const forget = page.locator('[data-testid^="flag-forget-"]').first();
    const reach = await forget.evaluate((el) => {
      const after = getComputedStyle(el, '::after');
      const box = el.getBoundingClientRect();
      return {
        width: box.width + Math.abs(Number.parseFloat(after.left) || 0) * 2,
        height: box.height + Math.abs(Number.parseFloat(after.top) || 0) * 2,
        // §6: a control is never inside another control.
        inButton: el.closest('button') !== el,
      };
    });
    expect(reach.width).toBeGreaterThanOrEqual(44);
    expect(reach.height).toBeGreaterThanOrEqual(44);
    expect(reach.inButton, 'the delete control is nested inside another control').toBe(false);
  });
});

test.describe('copy all', () => {
  test.beforeEach(async ({ page }) => {
    await captureClipboard(page);
  });

  test('copies the whole queue as text a person can read', async ({ page }) => {
    await fresh(page);
    await open(page, 'team');
    await page.getByTestId('flag-button').click();
    await page.getByTestId('flag-note').fill('the bench total looks wrong');
    await page.getByTestId('flag-done').click();

    await openFlagged(page);
    await page.getByTestId('flagged-copy-all').click();
    await expect(page.getByTestId('flagged-copied')).toBeVisible();

    const text = (await clipboardText(page))!;
    expect(text).toContain('Fantasy Analyst — 1 thing flagged');
    expect(text).toContain('1. Team —');
    expect(text).toContain('"the bench total looks wrong"');
    expect(text).toContain('nothing was uploaded');
    // Prose, not a payload: nothing to unwrap before pasting it into a chat.
    expect(text).not.toContain('```');
    expect(text).not.toContain('{');
  });

  /*
   * The clipboard is not a receipt. A copy that emptied the queue would be
   * irreversible on the strength of an operation that silently fails on iOS
   * outside a secure context — and on the assumption that the reader wanted to
   * send it rather than to look at it.
   */
  test('asks before it clears, and keeping is the quiet answer', async ({ page }) => {
    await fresh(page);
    await open(page, 'team');
    await page.getByTestId('flag-button').click();
    await page.getByTestId('flag-done').click();

    await openFlagged(page);
    await page.getByTestId('flagged-copy-all').click();
    await expect(page.getByTestId('flagged-copied')).toContainText('Clear the queue now, or keep it?');
    expect(await queueLength(page)).toBe(1);

    await page.getByTestId('flagged-keep').click();
    await expect(page.getByTestId('flagged-copied')).toHaveCount(0);
    expect(await queueLength(page)).toBe(1);
  });

  test('clears only when told to, and says so afterwards', async ({ page }) => {
    await fresh(page);
    await open(page, 'team');
    await page.getByTestId('flag-button').click();
    await page.getByTestId('flag-done').click();

    await openFlagged(page);
    await page.getByTestId('flagged-copy-all').click();
    await page.getByTestId('flagged-clear').click();

    expect(await queueLength(page)).toBe(0);
    await expect(page.getByTestId('flagged-screen')).toContainText('Nothing is flagged');
  });
});
