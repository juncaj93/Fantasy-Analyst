/**
 * Pushing a sheet away, and everything that must survive it.
 *
 * Three complaints across as many releases, pulling in opposite directions, and
 * the line between them is what this suite pins.
 *
 * Cards were hard to swipe away, so the app claimed a downward drag on content
 * at its top with a non-passive `touchmove`. That made the same cards hard to
 * *scroll*, which is the worse of the two — a card you cannot dismiss can still
 * be read — so the claim moved to `touch-action`, published ahead of the finger.
 * That failed for a different reason: a card does not know how tall it is while
 * its requests are in flight, so it refused the reader the scroll they had
 * already started. Both were withdrawn, and dismissal shrank to the chrome.
 *
 * The measurement that ended the argument: `.sheet-body` was a scroll container
 * declaring `pan-y`, so a vertical touch on it belonged to the engine after a
 * single `pointermove`. No threshold could have helped. The app was not being
 * outvoted; it was not being asked.
 *
 * **So the sheet stopped asking.** Its layer is a scroller whose two ends are
 * the card in place and the card gone, its dismissal is a scroll, and the card's
 * content is a scroller nested inside it. What that buys, and what this suite
 * checks:
 *
 *  - a card is pushed away from *anywhere* on it, including the middle of what
 *    you are reading — the thing three attempts could not deliver;
 *  - content that has been scrolled keeps the gesture, for free, because a
 *    scroll only passes outward once the inner box has nowhere to put it —
 *    which is scroll chaining, and not a rule anybody wrote;
 *  - the tracking, the momentum, the spring back from a push too small and the
 *    ability to catch it halfway all belong to the engine.
 *
 * The one thing the layer must never do is let a snap area outgrow it. WebKit
 * stops scrolling a snapping scroller entirely once that happens, which is how
 * an earlier version of this design made long cards unreadable in Safari at
 * every width. `.sheet-snap` is bounded for that reason and `navigation.spec.ts`
 * holds it there.
 *
 * **The drags in this file are wheels now, and that is a real improvement.** A
 * wheel is a scroll, so these tests exercise the same mechanism a thumb does, in
 * every engine — where the pointer gesture they replaced was visible only to a
 * synthetic mouse, and passed twelve green WebKit shards while doing nothing at
 * all under a finger. A mouse *drag* now expresses nothing a scroller can hear,
 * which is why the few that remain below are the ones about something else: a
 * sideways swipe, and a drag inside a text field.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import { openReview, pastTheSettle, scrollSheetContent, sheetBodyScroll, sheetScroll, swipeSheetAway, tapAboveCard } from './helpers.ts';

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

test.describe('pushing a sheet away', () => {
  /**
   * The headline, and the thing three earlier attempts could not deliver: **a
   * card is pushed away from the middle of what you are reading.**
   *
   * Driven by a wheel rather than a drag, and that is not a convenience. The
   * dismissal is a scroll now, so a wheel exercises the very mechanism a thumb
   * does — in every engine, including the one this behaviour has only ever
   * failed on. The drags these tests used to use expressed nothing a scroller
   * can hear, which is the same lesson as before with the sign flipped: a
   * synthetic mouse is not a finger, and where they differ it is the mouse that
   * is wrong.
   */
  test('is pushed away by a scroll that starts in the middle of the card', async ({ page }) => {
    await openPlayerCard(page);
    const opened = await sheetScroll(page);
    expect(opened.top, 'the card did not come up to its detent').toBeGreaterThan(0);

    await swipeSheetAway(page);
    await expect(page.getByTestId('player-sheet')).toHaveCount(0);
  });

  /**
   * And the other half of the same rule, which is the half that protects the
   * reader: **content that has been scrolled keeps the gesture.**
   *
   * Nobody wrote this rule either. The card's content is a scroller inside the
   * layer, so a pull on content that has somewhere to go scrolls the content,
   * and the scroll only passes outward — to the layer, and so to the
   * dismissal — once the content has nowhere left to put it. The browser
   * decides that, at the moment it becomes true, and it is the same decision it
   * makes for every nested scroller on the web.
   *
   * Getting both halves out of one mechanism is the argument for the rebuild:
   * they cannot drift apart, because neither is a rule this repository states.
   */
  test('scrolls back to the top of the card and stops, rather than dismissing', async ({ page }) => {
    await openPlayerCard(page);
    const detent = (await sheetScroll(page)).top;

    // Read further into the card. Only a card with more in it than fits can
    // show this, so it is made to have more rather than hoped to.
    await page.evaluate(() => {
      const body = document.querySelector('.sheet-body') as HTMLElement;
      const filler = document.createElement('div');
      filler.style.height = '1400px';
      body.append(filler);
    });
    await scrollSheetContent(page, 600);
    expect((await sheetBodyScroll(page)).top, 'the card would not scroll to set the case up').toBeGreaterThan(0);

    /*
     * Now pull back down, hard, from the middle of the card.
     *
     * Deliberately more than enough to reach the top and carry on, because the
     * claim is that it *cannot* carry on: measured, a pull of any size that
     * starts with the content off its top spends itself returning the content
     * to the top and stops there. Reaching the layer takes a fresh gesture. So
     * the reader who is halfway through a card and pulls down to re-read the
     * start of it never loses the card, however hard they pull — and that is
     * the whole of the protection, drawn by the browser rather than by a
     * threshold in this repository.
     */
    await swipeSheetAway(page, { ticks: 700 });
    await pastTheSettle(page);
    await expect(
      page.getByTestId('player-sheet'),
      'a card the reader was part-way through was thrown away by one pull',
    ).toBeVisible();
    expect(
      (await sheetBodyScroll(page)).top,
      'the content did not come to rest at its own top',
    ).toBe(0);
    expect(
      (await sheetScroll(page)).top,
      'the card moved while its content was being pulled back',
    ).toBe(detent);
  });

  /**
   * The screen behind comes back *as* the card goes, not after it.
   *
   * The complaint this holds: dismissing a card left almost a second of grey
   * with nothing on it. Two causes, and this covers both ends of them. The scrim
   * held full strength for the whole of a dismissal and vanished only when the
   * sheet unmounted, so once the card had slid past there was nothing to look at
   * but a grey screen; and the layer waited for every last scroll to stop before
   * it would even decide, so the grey outlasted the gesture.
   *
   * Asserted as a relationship rather than a duration, because a duration here
   * would be measuring the harness: the scrim's strength tracks how far the card
   * has been pushed, so a card halfway out has a screen half back.
   */
  test('lets the screen behind back as the card is pushed away', async ({ page }) => {
    await openPlayerCard(page);
    const scrim = async () =>
      Number(await page.evaluate(() => getComputedStyle(document.querySelector('.sheet-backdrop')!).opacity));
    expect(await scrim(), 'the card is up and the screen behind is not covered').toBeGreaterThan(0.9);

    /*
     * Pushed part of the way out and read in the same breath.
     *
     * Deliberately short of the point of no return, so what is measured is the
     * push rather than the dismissal — which also means the settle is about to
     * pull the card back, and the reading has to happen before it does. Taken
     * inside the page, two frames after the push, rather than over a round trip
     * whose latency is not bounded by anything this test controls.
     */
    const part = await page.evaluate(async () => {
      const el = document.querySelector('.sheet-scroller') as HTMLElement;
      const back = document.querySelector('.sheet-backdrop') as HTMLElement;
      el.scrollTop = (el.scrollHeight - el.clientHeight) * 0.7;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return Number(getComputedStyle(back).opacity);
    });
    expect(part, 'the screen behind stayed covered while the card was pushed out').toBeLessThan(0.85);
    expect(part, 'the screen behind was uncovered faster than the card moved').toBeGreaterThan(0.5);

    // Let go: it comes back, and so does the scrim.
    await pastTheSettle(page);
    await expect(page.getByTestId('player-sheet')).toBeVisible();
    expect(await scrim(), 'the card came back and the screen behind stayed uncovered').toBeGreaterThan(0.9);
  });

  /**
   * And a push that has won finishes as an exit, rather than as a disappearance.
   *
   * The other half of the same complaint, and the half a stopwatch cannot hold.
   * The card used to leave by *scrolling*, so how long it took belonged to the
   * reader's flick — a gentle push past the point of no return has almost no
   * momentum behind it and drifted the rest of a screen's height at walking
   * pace, with the outcome already decided. Taking it over means the card
   * covers whatever distance is left on a clock of its own.
   *
   * What is asserted is that the card **moves** after the push has won: sampled
   * while it leaves, its top edge is further down the screen than where the push
   * left it, and lower again after that. A dismissal that simply unmounted the
   * card — which is what this looked like before, and what a shortened timeout
   * would also produce — never places the card anywhere in between, so it
   * cannot satisfy this.
   */
  test('finishes a won push as an exit the reader can see', async ({ page }) => {
    await openPlayerCard(page);
    const card = page.getByTestId('player-sheet');
    /*
     * `null` the moment the card is gone, and quickly.
     *
     * `boundingBox()` waits for its element, so calling it on a card that has
     * just left blocks for the whole action timeout and then fails the test on a
     * timeout rather than on its subject. Counting first, and capping the wait,
     * keeps this a sampler.
     */
    const topOf = async () => {
      if ((await card.count()) === 0) return null;
      const box = await card.boundingBox({ timeout: 250 }).catch(() => null);
      return box ? Math.round(box.y) : null;
    };

    const started = Date.now();
    await page.evaluate(() => {
      const el = document.querySelector('.sheet-scroller') as HTMLElement;
      // Past the point of no return and still leaving, with travel left to make.
      el.scrollTop = (el.scrollHeight - el.clientHeight) * 0.35;
    });

    const seen: number[] = [];
    for (let i = 0; i < 14; i++) {
      const y = await topOf();
      if (y === null) break;
      seen.push(y);
      await page.waitForTimeout(25);
    }

    await expect(card, 'the card never left').toHaveCount(0);
    await expect(page.getByTestId('sheet-backdrop'), 'the screen behind stayed covered').toHaveCount(0);
    expect(
      seen.length,
      'the card was never observed on its way out — it disappeared rather than left',
    ).toBeGreaterThan(1);
    expect(
      Math.max(...seen),
      'the card did not travel downwards on its way out',
    ).toBeGreaterThan(seen[0]!);
    expect(
      Date.now() - started,
      'the card took too long to finish leaving after the push had already won',
    ).toBeLessThan(900);
  });

  test('is pushed away from the grip, as it always was', async ({ page }) => {
    await openScoringKey(page);
    await swipeSheetAway(page, { over: '.sheet-grip' });
    await expect(page.getByTestId('scoring-key')).toHaveCount(0);
  });

  /**
   * A short push comes back, and the engine decides that rather than a constant.
   *
   * There used to be two numbers here — 28% of the sheet's height, or half a
   * pixel per millisecond — and a hand-written spring back when neither was
   * met. Scroll-snap answers the same question with the reader's actual
   * momentum, so what is checked is the outcome: a small push leaves the card
   * exactly where it was.
   */
  test('comes back from a small push, and rests where it started', async ({ page }) => {
    await openScoringKey(page);
    const detent = (await sheetScroll(page)).top;

    await swipeSheetAway(page, { ticks: 40 });
    await pastTheSettle(page);
    await expect(page.getByTestId('scoring-key')).toBeVisible();
    expect((await sheetScroll(page)).top, 'the card was left resting between its two positions').toBe(detent);
  });

  /**
   * A sideways swipe is not a dismissal, and now cannot be one.
   *
   * The sheet used to ask "has this moved eight pixels, and not upwards", which
   * is true of almost every horizontal gesture on a phone, and a swipe across a
   * card threw it away. The layer only scrolls on one axis, so a sideways
   * movement has nowhere to go — the rule is the geometry rather than a ratio.
   */
  test('ignores a sideways swipe that drifts downwards', async ({ page }) => {
    await openPlayerCard(page);
    const box = (await page.getByTestId('player-sheet').boundingBox())!;
    await drag(page, { x: box.x + 24, y: box.y + 140 }, { x: box.x + box.width - 24, y: box.y + 160 });
    await pastTheSettle(page);
    await expect(page.getByTestId('player-sheet')).toBeVisible();
  });

  /** A tap on what you can see through above the card closes it. */
  test('closes on a tap above it, where the backdrop shows through', async ({ page }) => {
    await openScoringKey(page);
    await tapAboveCard(page);
    await expect(page.getByTestId('scoring-key')).toHaveCount(0);
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
    await expect(page.getByTestId('sheet-scroller')).toHaveCount(0);

    // The list underneath takes the very next tap, with nothing in between.
    const rows = page.getByTestId('player-search-row');
    await rows.first().click();
    await expect(page.getByTestId('player-sheet')).toBeVisible();
  });

  /**
   * A drag inside a text field still belongs to the text field.
   *
   * Setup's two paste boxes are the case: dragging in one moves the caret and
   * selects, and must not move the card. Nothing arbitrates this any more and
   * nothing needs to — a field inside a scroller keeps its own gestures the way
   * a field anywhere else does.
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
    await pastTheSettle(page);
    await expect(page.getByTestId('projection-paste-sheet')).toBeVisible();

    // And it is still a sheet: a scroll on it still takes it away.
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
