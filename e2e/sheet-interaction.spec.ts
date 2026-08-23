/**
 * Dismissing a sheet, and everything that must survive it.
 *
 * The complaint this suite exists for is specific: popup cards were hard to
 * swipe away. The cause was not a threshold. A sheet tall enough to scroll
 * declares `touch-action: pan-y` on its body so the browser can scroll it, and
 * that declaration meant the browser had already classified a downward drag as
 * a scroll before the app saw a single event — so on every sheet a reader
 * actually opens, the only place the gesture worked was the grip: about forty
 * pixels of a phone.
 *
 * What is checked here, and what is deliberately not:
 *
 *  - **Checked.** The pointer state machine — which drags dismiss, which spring
 *    back, which are handed to the scroller, and what is left behind after each
 *    — plus the focus lifecycle, the page lock and the reading order. All of it
 *    is engine-independent and all of it was broken in some way.
 *
 *  - **Not checked, and cannot be.** Whether iOS Safari actually yields the
 *    gesture. Every drag below is synthesised from pointer events, which are
 *    not touches: `touch-action` and a non-passive `touchmove` govern *touch*
 *    input only, and no synthetic sequence exercises them. That is why the
 *    declarations are asserted directly in `navigation.spec.ts`, and why the
 *    physical-device list in the handoff is not optional.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';

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
 * Drag, in steps, the way a thumb does.
 *
 * `hold` is a pause before letting go, and it is how a test says "this was a
 * deliberate placement, not a flick". The sheet judges a flick over a window of
 * recent movement, so a hold longer than that window leaves nothing in it and
 * the release is decided on distance alone — which is exactly what a reader who
 * pulls a sheet part-way and stops to think is asking for.
 */
async function drag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  { steps = 12, hold = 0 }: { steps?: number; hold?: number } = {},
) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
  }
  if (hold > 0) await page.waitForTimeout(hold);
  await page.mouse.up();
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
  await page.getByTestId('tab-review').click();
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

test.describe('pulling a sheet down', () => {
  /**
   * The bug, stated as a test.
   *
   * A drag that starts on the *content* of a sheet whose content scrolls — not
   * on its grip, not on its header — and which begins with that content at its
   * top. Before this, the gesture never reached the app at all and the sheet
   * sat there while the reader pulled at it.
   */
  test('dismisses from the content of a scrolling sheet that is at its top', async ({ page }) => {
    await openPlayerCard(page);

    /*
     * The tall case, constructed rather than hoped for.
     *
     * Whether a given card overflows depends on how much this deployment
     * happens to know about the player, and the demo league is thin — so a test
     * that opened one and assumed it would scroll would pass or fail on the
     * fixture rather than on the behaviour. Capping the body makes the body
     * scroll, which is the only property that matters here: it is what puts
     * `touch-action: pan-y` on the element under the finger, and that
     * declaration is the whole of the original bug.
     */
    await page.evaluate(() => {
      (document.querySelector('.sheet-body') as HTMLElement).style.maxHeight = '160px';
    });
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const body = document.querySelector('.sheet-body') as HTMLElement;
          return { scrollable: body.dataset['scrollable'], top: body.scrollTop };
        }),
      )
      .toEqual({ scrollable: 'true', top: 0 });

    const body = (await page.locator('.sheet-body').boundingBox())!;
    const x = body.x + body.width / 2;
    await drag(page, { x, y: body.y + 40 }, { x, y: body.y + 40 + 400 });
    await expect(page.getByTestId('player-sheet')).toHaveCount(0);
  });

  /**
   * And the same drag, one line lower down the content, is a scroll.
   *
   * The pair is the contract: content that is at its top hands the gesture
   * over, and content that is not keeps it. Getting only the first half is how
   * a sheet becomes impossible to read; getting only the second is the bug this
   * work was opened for.
   */
  test('hands the same drag to the content once the content is scrolled', async ({ page }) => {
    await openPlayerCard(page);
    await page.evaluate(() => {
      const body = document.querySelector('.sheet-body') as HTMLElement;
      body.style.maxHeight = '160px';
      body.scrollTop = 60;
    });
    await expect.poll(async () => page.evaluate(() => (document.querySelector('.sheet-body') as HTMLElement).scrollTop)).toBeGreaterThan(0);

    const body = (await page.locator('.sheet-body').boundingBox())!;
    const x = body.x + body.width / 2;
    await drag(page, { x, y: body.y + 40 }, { x, y: body.y + 40 + 400 });
    await expect(page.getByTestId('player-sheet')).toBeVisible();
  });

  test('dismisses from the grip, as it always did', async ({ page }) => {
    await openScoringKey(page);
    const box = (await page.getByTestId('sheet-grip').boundingBox())!;
    const x = box.x + box.width / 2;
    await drag(page, { x, y: box.y + 4 }, { x, y: box.y + 420 });
    await expect(page.getByTestId('scoring-key')).toHaveCount(0);
  });

  /**
   * A sideways swipe is not a dismissal, however much it drifts.
   *
   * The sheet used to ask only "has this moved eight pixels, and not upwards",
   * which is true of almost every horizontal gesture on a phone. A swipe across
   * a card threw it away.
   */
  test('ignores a sideways swipe that drifts downwards', async ({ page }) => {
    await openPlayerCard(page);
    const box = (await page.getByTestId('player-sheet').boundingBox())!;
    await drag(
      page,
      { x: box.x + 24, y: box.y + 140 },
      { x: box.x + box.width - 24, y: box.y + 160 },
    );
    await expect(page.getByTestId('player-sheet')).toBeVisible();
  });

  test('springs back from a short pull, leaving nothing behind it', async ({ page }) => {
    await openScoringKey(page);
    const box = (await page.getByTestId('sheet-grip').boundingBox())!;
    const x = box.x + box.width / 2;
    await drag(page, { x, y: box.y + 4 }, { x, y: box.y + 24 }, { hold: 200 });
    await expect(page.getByTestId('scoring-key')).toBeVisible();

    // No stuck transform, and no class left claiming a gesture is in flight.
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const sheet = document.querySelector('.sheet') as HTMLElement;
          return {
            transform: sheet.style.transform,
            dragging: sheet.dataset['dragging'],
            classes: sheet.className,
          };
        }),
      )
      .toEqual({ transform: '', dragging: 'no', classes: 'sheet' });

    // And it is still a working sheet rather than a picture of one.
    await page.getByTestId('sheet-close').click();
    await expect(page.getByTestId('scoring-key')).toHaveCount(0);
  });

  /**
   * A drag is not a tap.
   *
   * Letting go over Done at the end of a pull that sprang back used to activate
   * it, so a reader who had just decided *not* to dismiss the sheet watched it
   * close anyway — which reads as the threshold being random rather than as a
   * misfire, and is worse than a gesture that does nothing.
   */
  test('does not activate the control a cancelled drag ended on', async ({ page }) => {
    await openScoringKey(page);
    const done = (await page.getByTestId('sheet-close').boundingBox())!;
    const grip = (await page.getByTestId('sheet-grip').boundingBox())!;
    await drag(
      page,
      { x: done.x + done.width / 2, y: grip.y + 2 },
      { x: done.x + done.width / 2, y: done.y + done.height / 2 },
      { hold: 200 },
    );
    await expect(page.getByTestId('scoring-key')).toBeVisible();
  });

  test('leaves the controls inside it tappable', async ({ page }) => {
    // A tap is not a drag either: the arbitration must not cost a button.
    await openPlayerCard(page);
    await page.getByTestId('player-full-profile').click();
    await expect(page.getByTestId('player-page')).toBeVisible();
  });

  /**
   * Nothing is left over the page once the sheet has gone.
   *
   * A sheet is animated off the bottom of the screen and *then* unmounted, and
   * a layer that outlives its own animation — or a backdrop that is not taken
   * down with it — swallows the first tap the reader makes afterwards. That
   * reads as the app having frozen, which is a worse outcome than a sheet that
   * would not close in the first place.
   */
  test('intercepts nothing once it has been dismissed', async ({ page }) => {
    await openPlayerCard(page);
    const grip = (await page.getByTestId('sheet-grip').boundingBox())!;
    const x = grip.x + grip.width / 2;
    await drag(page, { x, y: grip.y + 4 }, { x, y: grip.y + 460 });
    await expect(page.getByTestId('player-sheet')).toHaveCount(0);
    await expect(page.getByTestId('sheet-backdrop')).toHaveCount(0);

    // The list underneath takes the very next tap, with nothing in between.
    await page.getByTestId('player-search-row').nth(1).click();
    await expect(page.getByTestId('player-sheet')).toBeVisible();
  });

  /**
   * A drag inside a text field belongs to the field.
   *
   * Dragging in a box you can type into moves the caret and selects; a sheet
   * that read that as a dismissal would take the reader's text away mid-edit.
   * Setup's two paste boxes are the whole of this case, and they are the two
   * places in the app where a sheet holds something a thumb drags *within*.
   */
  test('leaves a drag inside a text field to the text field', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('tab-setup').click();
    await expect(page.getByTestId('setup-step-sleeper')).toBeVisible();
    const panel = page.getByTestId('panel-preseason-projection');
    await panel.scrollIntoViewIfNeeded();
    await panel.locator('summary').click();
    await panel.getByTestId('open-projection-paste').click();
    await expect(page.getByTestId('projection-paste-sheet')).toBeVisible();
    await settled(page.getByTestId('sheet-grip'));

    const box = (await page.getByTestId('projection-paste-input').boundingBox())!;
    const x = box.x + box.width / 2;
    await drag(page, { x, y: box.y + 8 }, { x, y: box.y + 8 + 400 });
    await expect(page.getByTestId('projection-paste-sheet')).toBeVisible();

    // And the sheet is still a sheet: its own grip closes it.
    const grip = (await page.getByTestId('sheet-grip').boundingBox())!;
    const gx = grip.x + grip.width / 2;
    await drag(page, { x: gx, y: grip.y + 4 }, { x: gx, y: grip.y + 420 });
    await expect(page.getByTestId('projection-paste-sheet')).toHaveCount(0);
  });

  test('still dismisses with reduced motion asked for', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openScoringKey(page);
    const box = (await page.getByTestId('sheet-grip').boundingBox())!;
    const x = box.x + box.width / 2;
    await drag(page, { x, y: box.y + 4 }, { x, y: box.y + 420 });
    // It arrives instead of travelling; it still arrives.
    await expect(page.getByTestId('scoring-key')).toHaveCount(0);
  });
});

/**
 * The focus lifecycle — the known A-01 gap, and the shared primitive owns it.
 *
 * The sheet claimed `aria-modal="true"` and then did none of what that claims:
 * focus stayed on the row behind it, Tab walked straight out into a list the
 * reader could not see, and closing dropped focus on the document, which sends
 * the next Tab back to the top of the page.
 */
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

  test('comes back to it when the backdrop closes it too', async ({ page }) => {
    await openScoringKey(page);
    await page.getByTestId('sheet-backdrop').click({ position: { x: 10, y: 10 } });
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
