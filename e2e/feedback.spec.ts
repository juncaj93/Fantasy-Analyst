/**
 * Writing feedback down, from the one place that offers to take it.
 *
 * The unit tests own what an entry *contains* and what the copied block *says*
 * — they can walk fifty entries and a malformed payload where a browser test
 * can only look at one. What this owns is everything that is only true in a
 * browser: that the action is on Settings and nowhere else, that the composer
 * takes a line and will not take an empty one, that the count moves the moment
 * a note is saved, that one entry can be deleted without the others, and that
 * copying asks before it clears.
 *
 * **The first test is the one to keep.** The previous design put a floating
 * control on every screen; this one deliberately does not, and "there is
 * nothing persistent anywhere in the app" is a property that decays silently
 * unless something looks for it on every screen at every width.
 */

import { expect, test, type Page } from '@playwright/test';

/** Every destination the toolbar can show, including the one off-season. */
const SCREENS = ['draft', 'team', 'trades', 'players', 'setup'] as const;

/**
 * Start from a queue nobody else has written to.
 *
 * Cleared once per test rather than on every navigation, which is the
 * difference between a clean start and a test that cannot reload the page: an
 * init script runs again on each load, so an unconditional `removeItem` would
 * wipe the very thing a reload is meant to prove survived. `sessionStorage`
 * outlives a reload and dies with the browser context, which is exactly the
 * scope wanted.
 */
async function fresh(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      if (window.sessionStorage.getItem('e2e.feedback.cleared') === '1') return;
      window.localStorage.removeItem('fa.feedback.queue');
      window.sessionStorage.setItem('e2e.feedback.cleared', '1');
    } catch {
      /* private mode; the queue is empty there anyway */
    }
  });
  await page.goto('/');
  await page.getByTestId('tab-setup').waitFor();
}

async function openSettings(page: Page): Promise<void> {
  await page.getByTestId('tab-setup').click();
  await page.getByTestId('setup-add-feedback').waitFor();
}

/** Write one note, from the row on Settings. */
async function addNote(page: Page, text: string): Promise<void> {
  await page.getByTestId('setup-add-feedback').click();
  await page.getByTestId('feedback-note').fill(text);
  await page.getByTestId('feedback-save').click();
  await expect(page.getByTestId('feedback-composer')).toHaveCount(0);
}

async function openQueue(page: Page): Promise<void> {
  await page.getByTestId('setup-flagged').click();
  await page.getByTestId('flagged-screen').waitFor();
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

test.describe('nothing persistent, anywhere', () => {
  /*
   * The whole point of the redesign, asserted on every screen the toolbar can
   * reach — the Draft screen included, because "the Draft screen is unchanged"
   * is exactly the kind of claim that needs a test rather than a promise.
   */
  test('no feedback control is drawn on any screen', async ({ page }) => {
    await fresh(page);
    for (const tab of SCREENS) {
      const destination = page.getByTestId(`tab-${tab}`);
      if ((await destination.count()) === 0) continue;
      await destination.click();
      await page.waitForTimeout(250);

      // Nothing floating, and nothing left over from the design before this one.
      await expect(page.locator('.flag-layer')).toHaveCount(0);
      await expect(page.getByTestId('flag-button')).toHaveCount(0);
      await expect(page.getByTestId('flag-strip')).toHaveCount(0);

      // On Settings the action is a row in the list; everywhere else, nothing.
      const expected = tab === 'setup' ? 1 : 0;
      await expect(page.getByTestId('setup-add-feedback')).toHaveCount(expected);
    }
  });

  test('the shell still draws exactly one navigation and nothing beside it', async ({ page }) => {
    await fresh(page);
    await expect(page.locator('nav[aria-label="Main navigation"]')).toHaveCount(1);
    const floating = await page.evaluate(
      () =>
        [...document.querySelectorAll('body *')].filter((el) => {
          const s = getComputedStyle(el);
          return s.position === 'fixed' && el.className !== '' && !el.closest('.tabbar, .nav-bar, .demo-bar');
        }).length,
    );
    // The nav bar and the toolbar are the app's only fixed chrome, and this
    // change adds no third one.
    expect(floating, 'something new is pinned over the page').toBe(0);
  });
});

test.describe('the action, on Settings', () => {
  test('sits with the support tools and is a full target', async ({ page }) => {
    await fresh(page);
    await openSettings(page);

    const row = page.getByTestId('setup-add-feedback');
    await expect(row).toBeVisible();
    await expect(row).toContainText('Add feedback');

    const box = (await row.boundingBox())!;
    expect(box.height, `the row is only ${Math.round(box.height)}px tall`).toBeGreaterThanOrEqual(44);
    const width = page.viewportSize()!.width;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width + 0.5);

    // Beside the two rows it belongs with, not somewhere else on the screen.
    await expect(page.getByTestId('setup-support-snapshot')).toBeVisible();
    await expect(page.getByTestId('setup-data-health')).toBeVisible();
  });

  test('unfolds a one-line field, and folds away again', async ({ page }) => {
    await fresh(page);
    await openSettings(page);

    await expect(page.getByTestId('feedback-composer')).toHaveCount(0);
    await page.getByTestId('setup-add-feedback').click();
    await expect(page.getByTestId('feedback-composer')).toBeVisible();
    await expect(page.getByTestId('setup-add-feedback')).toHaveAttribute('aria-expanded', 'true');

    await page.getByTestId('feedback-cancel').click();
    await expect(page.getByTestId('feedback-composer')).toHaveCount(0);
    expect(await queueLength(page)).toBe(0);
  });

  /*
   * The note is the entry, so an entry with no words in it is not one. The
   * queue refuses it and the control refuses to offer it — this is the second
   * of those, where a person can see it.
   */
  /*
   * §5: touch targets stay at 44px even when the visible control is smaller.
   * `.btn` is 36px by default and out-specifies a bare class, so these two lost
   * their height silently the first time — measured, not asserted, ever since.
   */
  test('Save and Cancel are both full targets', async ({ page }) => {
    await fresh(page);
    await openSettings(page);
    await page.getByTestId('setup-add-feedback').click();

    for (const id of ['feedback-save', 'feedback-cancel']) {
      const box = (await page.getByTestId(id).boundingBox())!;
      expect(box.height, `${id} is only ${Math.round(box.height)}px tall`).toBeGreaterThanOrEqual(44);
      expect(box.width, `${id} is only ${Math.round(box.width)}px wide`).toBeGreaterThanOrEqual(44);
    }

    // And the field a thumb has to hit before either of them.
    const field = (await page.getByTestId('feedback-note').boundingBox())!;
    expect(field.height, `the field is only ${Math.round(field.height)}px tall`).toBeGreaterThanOrEqual(44);
  });

  test('will not save an empty note', async ({ page }) => {
    await fresh(page);
    await openSettings(page);
    await page.getByTestId('setup-add-feedback').click();

    await expect(page.getByTestId('feedback-save')).toBeDisabled();
    await page.getByTestId('feedback-note').fill('   ');
    await expect(page.getByTestId('feedback-save')).toBeDisabled();
    await page.getByTestId('feedback-note').fill('something');
    await expect(page.getByTestId('feedback-save')).toBeEnabled();
  });

  test('saves the note, says so in the reader’s own words, and moves the count', async ({ page }) => {
    await fresh(page);
    await openSettings(page);
    await expect(page.getByTestId('setup-flagged')).toContainText('Nothing saved yet');

    await addNote(page, 'the bench total reads higher than the starters');

    await expect(page.getByTestId('setup-add-feedback')).toContainText(
      'the bench total reads higher than the starters',
    );
    await expect(page.getByTestId('setup-flagged')).toContainText('1 note saved');
    expect(await queueLength(page)).toBe(1);
  });

  test('Enter saves it too, because a one-line field should take a return', async ({ page }) => {
    await fresh(page);
    await openSettings(page);
    await page.getByTestId('setup-add-feedback').click();
    await page.getByTestId('feedback-note').fill('DOG column is blank on every row');
    await page.getByTestId('feedback-note').press('Enter');

    await expect(page.getByTestId('feedback-composer')).toHaveCount(0);
    expect(await queueLength(page)).toBe(1);
  });

  test('survives the app being reloaded, which is what localStorage is for', async ({ page }) => {
    await fresh(page);
    await openSettings(page);
    await addNote(page, 'this should outlive a reload');

    await page.reload();
    await openSettings(page);
    await expect(page.getByTestId('setup-flagged')).toContainText('1 note saved');
  });
});

test.describe('the queue', () => {
  test('lists what was written, newest first', async ({ page }) => {
    await fresh(page);
    await openSettings(page);
    await addNote(page, 'first thing');
    await addNote(page, 'second thing');
    await openQueue(page);

    const rows = page.locator('[data-testid^="flag-entry-"]');
    await expect(rows).toHaveCount(2);
    expect(await rows.first().textContent()).toContain('second thing');
    expect(await rows.last().textContent()).toContain('first thing');
    await expect(page.getByTestId('flagged-screen')).toContainText('2 notes saved');
  });

  test('says so when there is nothing in it', async ({ page }) => {
    await fresh(page);
    await openSettings(page);
    await openQueue(page);
    await expect(page.getByTestId('flagged-screen')).toContainText('Nothing saved yet');
  });

  test('deletes one entry and leaves the rest', async ({ page }) => {
    await fresh(page);
    await openSettings(page);
    await addNote(page, 'keep this one');
    await addNote(page, 'delete this one');
    await openQueue(page);

    await page.locator('[data-testid^="flag-forget-"]').first().click();
    await expect(page.getByTestId('flagged-list')).not.toContainText('delete this one');
    await expect(page.getByTestId('flagged-list')).toContainText('keep this one');
    expect(await queueLength(page)).toBe(1);
  });

  test('the delete control is a full target and is not nested in another one', async ({ page }) => {
    await fresh(page);
    await openSettings(page);
    await addNote(page, 'something to delete');
    await openQueue(page);

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

  test('the count on the row and the list behind it agree after a delete', async ({ page }) => {
    await fresh(page);
    await openSettings(page);
    await addNote(page, 'one');
    await addNote(page, 'two');
    await openQueue(page);
    await page.locator('[data-testid^="flag-forget-"]').first().click();
    await page.getByTestId('back-button').click();

    await expect(page.getByTestId('setup-flagged')).toContainText('1 note saved');
  });
});

test.describe('copy all', () => {
  test.beforeEach(async ({ page }) => {
    await captureClipboard(page);
  });

  test('copies the whole queue as text a person can read', async ({ page }) => {
    await fresh(page);
    await openSettings(page);
    await addNote(page, 'the bench total looks wrong');
    await openQueue(page);

    await page.getByTestId('flagged-copy-all').click();
    await expect(page.getByTestId('flagged-copied')).toBeVisible();

    const text = (await clipboardText(page))!;
    expect(text).toContain('Fantasy Analyst — 1 note from the owner');
    expect(text).toContain('"the bench total looks wrong"');
    expect(text).toContain('nothing was uploaded');
    // Prose, not a payload: nothing to unwrap before pasting it into a chat.
    expect(text).not.toContain('```');
    expect(text).not.toContain('{');
    // And no screen name, because none was ever recorded.
    expect(text).not.toMatch(/\b(Draft|Team|Waivers|Matchup|Trades|Players|Setup)\b/);
  });

  /*
   * The clipboard is not a receipt. A copy that emptied the queue would be
   * irreversible on the strength of an operation that silently fails on iOS
   * outside a secure context — and on the assumption that the reader wanted to
   * send it rather than to look at it.
   */
  test('asks before it clears, and keeping is the quiet answer', async ({ page }) => {
    await fresh(page);
    await openSettings(page);
    await addNote(page, 'something');
    await openQueue(page);

    await page.getByTestId('flagged-copy-all').click();
    await expect(page.getByTestId('flagged-copied')).toContainText('Clear the queue now, or keep it?');
    expect(await queueLength(page)).toBe(1);

    await page.getByTestId('flagged-keep').click();
    await expect(page.getByTestId('flagged-copied')).toHaveCount(0);
    expect(await queueLength(page)).toBe(1);
  });

  test('clears only when told to, and says so afterwards', async ({ page }) => {
    await fresh(page);
    await openSettings(page);
    await addNote(page, 'something');
    await openQueue(page);

    await page.getByTestId('flagged-copy-all').click();
    await page.getByTestId('flagged-clear').click();

    expect(await queueLength(page)).toBe(0);
    await expect(page.getByTestId('flagged-screen')).toContainText('Nothing saved yet');
  });
});
