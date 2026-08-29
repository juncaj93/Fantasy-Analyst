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

import { expect, test, type Locator, type Page } from '@playwright/test';
import { openReview, pastTheSettle } from './helpers.ts';

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

/** Announce the page the way iOS announces a Home Screen launch. */
async function asHomeScreenApp(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, 'standalone', { value: true, configurable: true });
  });
}

/**
 * Wait until an element has stopped moving.
 *
 * Two consecutive frames in the same place is the definition of "the animation
 * has finished" that does not require knowing how long the animation is.
 */
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

/**
 * Open one of Setup's areas, which is the app's pushed layer.
 *
 * Vegas is the one to use: it is entirely read-only, so a test that swipes away
 * from it cannot be accused of having changed something on the way out.
 */
async function openSetupArea(page: Page, area = 'vegas') {
  await page.getByTestId('tab-setup').click();
  await expect(page.getByTestId(`setup-step-${area}`)).toBeVisible();
  await page.getByTestId(`setup-step-${area}`).click();
  await expect(page.getByTestId(`setup-detail-${area}`)).toBeVisible();
}

test.describe('pushed detail screens', () => {
  test('a detail screen carries its own title and a Back control', async ({ page }) => {
    await page.goto('/');
    await openSetupArea(page);

    const back = page.getByTestId('back-button');
    await expect(back).toBeVisible();
    // Back says where it goes, which is the list it was opened from.
    await expect(back).toContainText('Setup');

    await back.click();
    await expect(page.getByTestId('setup-detail-vegas')).toHaveCount(0);
    await expect(page.getByTestId('setup-step-vegas')).toBeVisible();
  });

  test('opening and leaving a detail screen adds no history entry', async ({ page }) => {
    await page.goto('/');
    const before = await page.evaluate(() => window.history.length);

    await openSetupArea(page);
    expect(await page.evaluate(() => window.history.length), 'a detail is not a new page').toBe(before);

    await page.getByTestId('back-button').click();
    await expect(page.getByTestId('setup-step-vegas')).toBeVisible();
    expect(await page.evaluate(() => window.history.length)).toBe(before);
    expect(new URL(page.url()).pathname).toBe('/');
  });

  test('a reload leaves the reader on the app, not in a broken half-state', async ({ page }) => {
    await page.goto('/');
    await openSetupArea(page);
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

  /**
   * A player is his own page, and Back is a real Back.
   *
   * The file used to unfold inside the row it was opened from, which put a
   * screen and a half of prose — the outlook, the injury, four tally windows,
   * the categories, the market and the whole ledger — inside a list whose job
   * is being scanned. It is a pushed destination now, and the thing that makes
   * that an improvement rather than a round trip is asserted here: what the
   * reader typed, which position they had narrowed it to, and where they were
   * in the list are all exactly as they left them.
   */
  test('a player opens as his own page, and Back restores the list exactly', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('tab-players').click();
    const rows = page.getByTestId('player-search-row');
    await expect(rows.first()).toBeVisible();
    const before = await rows.count();

    // Narrow the list first, so Back has something to fail to restore. The
    // count is read only once it has stopped moving: the query is debounced and
    // the old list stays on screen until the new one lands, so a count taken on
    // the first non-zero reading is the count of the list being replaced.
    await page.getByLabel('Search players').fill('a');
    await expect
      .poll(async () => {
        const first = await rows.count();
        await page.waitForTimeout(250);
        return first > 0 && first === (await rows.count()) ? first : 0;
      })
      .toBeGreaterThan(0);
    const narrowed = await rows.count();

    // …and scroll down it, so the offset is not zero either.
    await page.evaluate(() => window.scrollTo({ top: 240, behavior: 'auto' }));
    await expect.poll(async () => page.evaluate(() => Math.round(window.scrollY))).toBeGreaterThan(100);
    const offset = await page.evaluate(() => Math.round(window.scrollY));

    /*
     * A row that is on screen at this offset, deliberately.
     *
     * Playwright scrolls a target into view before clicking it, so clicking the
     * *first* row from 240px down the list would scroll the page back to the
     * top before the tap ever reached the app — and the assertion below would
     * then be measuring Playwright rather than the app. The ninth row is inside
     * the viewport at this offset on all four supported widths.
     */
    const target = rows.nth(8);
    const name = await target.locator('.player-name').innerText();
    await target.click();
    /*
     * Through the sheet, which is where a tap lands now.
     *
     * The subject of this test is the *pushed* screen — that Back restores the
     * query, the length of the list and the offset — so it takes the one step
     * that still pushes. The sheet's own promise is a different one and is
     * asserted in `density.spec.ts`: that it costs no restoration at all,
     * because the list underneath it was never unmounted.
     */
    await page.getByTestId('player-full-profile').click();

    const pushed = page.getByTestId('player-page');
    await expect(pushed).toBeVisible();
    await expect(pushed.locator('.nav-title')).toHaveText(name);
    await expect(page.getByTestId('back-button')).toContainText('Players');
    // A pushed screen starts at the top of itself, whatever the list was doing.
    expect(await page.evaluate(() => Math.round(window.scrollY))).toBeLessThan(40);

    await page.getByTestId('back-button').click();
    await expect(page.getByTestId('players-list')).toBeVisible();
    await expect(page.getByLabel('Search players')).toHaveValue('a');
    await expect(rows, 'the list came back as it was').toHaveCount(narrowed);

    /*
     * Measured with the sheet out of the way, because Back lands on the sheet.
     *
     * Leaving the page returns the reader to the card they opened it from, so
     * the list is still under a modal surface here — and a modal surface holds
     * the page still by pinning it, at which point `window.scrollY` reports
     * zero however far down the list the reader really is. Reading it through
     * the sheet was measuring the lock rather than the restoration.
     *
     * Closing first asks the question the reader would ask: when everything has
     * gone away, am I where I left off?
     */
    await page.getByTestId('sheet-close').click();
    await expect(page.getByTestId('player-sheet')).toHaveCount(0);
    expect(
      Math.abs((await page.evaluate(() => Math.round(window.scrollY))) - offset),
      'Back put the reader back where they were',
    ).toBeLessThan(24);

    expect(before).toBeGreaterThan(0);
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
    await openSetupArea(page);
    await expect(page.getByTestId('setup-detail-vegas')).toHaveAttribute('data-swipe-back', 'on');

    await drag(page, { x: 4, y: 420 }, { x: 330, y: 430 });

    await expect(page.getByTestId('setup-detail-vegas')).toHaveCount(0);
    await expect(page.getByTestId('setup-step-vegas')).toBeVisible();
  });

  test('the swipe changes nothing but which screen is showing', async ({ page }) => {
    await openSetupArea(page);
    await drag(page, { x: 4, y: 420 }, { x: 330, y: 430 });
    await expect(page.getByTestId('setup-step-vegas')).toBeVisible();

    // Back is navigation, never undo: nothing the gesture passed over changed.
    expect(await page.locator('html').getAttribute('data-theme'), 'the appearance is untouched').toBeNull();
    await page.getByTestId('tab-draft').click();
    await page.getByTestId('queue-filter').click();
    await expect(page.getByText(/Your queue is empty/)).toBeVisible();
  });

  test('an incomplete swipe snaps back and stays on the screen', async ({ page }) => {
    await openSetupArea(page);
    await drag(page, { x: 4, y: 420 }, { x: 60, y: 424 });
    await expect(page.getByTestId('setup-detail-vegas')).toBeVisible();
  });

  test('a vertical drag from the edge scrolls rather than navigating', async ({ page }) => {
    await openSetupArea(page);
    await drag(page, { x: 6, y: 500 }, { x: 12, y: 180 });
    await expect(page.getByTestId('setup-detail-vegas')).toBeVisible();
  });

  test('a swipe that did not start at the edge does nothing', async ({ page }) => {
    await openSetupArea(page);
    await drag(page, { x: 200, y: 420 }, { x: 360, y: 424 });
    await expect(page.getByTestId('setup-detail-vegas')).toBeVisible();
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
    await openSetupArea(page);
    await drag(page, { x: 4, y: 420 }, { x: 330, y: 430 });
    await expect(page.getByTestId('setup-step-vegas')).toBeVisible();
  });

  /**
   * A swipe the reader thought better of costs them nothing afterwards.
   *
   * The gesture suppresses the click at the end of a drag, so that letting go
   * over a control does not also press it — on a detail screen that could mean
   * flipping a flag on the way out. The suppression was armed when the drag
   * engaged and disarmed only by the click it swallowed, and **that is a
   * difference between a mouse and a thumb**: a mouse drag ends in a click, so
   * the flag was always cleared; a touch drag that springs back produces no
   * click at all, so it stayed raised and ate the reader's *next* tap — a real
   * one, seconds later, on a screen they had decided to stay on. One dead tap
   * after every abandoned swipe.
   *
   * Which is why this test is the only one in the file that does not use
   * `drag`. Driven by the mouse it passes against the defect, because the mouse
   * hands back the very click the defect depends on being absent; the touch
   * points below are what tell the two apart. The same lesson
   * `player-card-scroll.spec.ts` learned about `touch-action`, arriving from a
   * different direction: a synthetic mouse is not a finger, and where the two
   * differ it is always the mouse that is wrong.
   *
   * Back is the control to check it with because its outcome is unambiguous,
   * and because a reader who has just decided not to swipe out is rather likely
   * to reach for it.
   */
  test('an abandoned swipe does not swallow the next tap', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'real touch injection is a Chromium DevTools protocol capability');
    await openSetupArea(page);

    /*
     * Far enough to engage the gesture, nowhere near far enough to complete it
     * — and then a pause before letting go, which is what makes it an abandoned
     * swipe rather than a short flick. A flick is judged over the last 120ms of
     * movement, so a longer hold leaves nothing in that window and the release
     * is decided on distance alone: fifty-six points, against the hundred and
     * twenty-five this width asks for. Exactly the reader who starts to swipe
     * out, changes their mind, and stops.
     */
    const cdp = await page.context().newCDPSession(page);
    const at = (x: number) => [{ x, y: 420, id: 1, radiusX: 14, radiusY: 14, force: 1 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(4) });
    for (const x of [12, 24, 38, 52, 60]) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(x) });
      await page.waitForTimeout(16);
    }
    await page.waitForTimeout(250);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(page.getByTestId('setup-detail-vegas')).toBeVisible();
    await settled(page.getByTestId('setup-detail-vegas'));

    await page.getByTestId('back-button').click();
    await expect(
      page.getByTestId('setup-step-vegas'),
      'the tap after an abandoned swipe was eaten by the click suppression that swipe left armed',
    ).toBeVisible();
  });
});

/**
 * The gesture, against the one thing on a pushed screen that also moves
 * sideways.
 *
 * A pushed screen is full-bleed and gives the page gutter back as padding, so a
 * segmented control inside one begins twelve points from the glass — inside the
 * twenty-eight point strip that starts a back swipe. Both the player's page and
 * Review carry one. A reader who has scrolled that control along and swipes
 * right to bring it back was making the back gesture's movement, in the back
 * gesture's strip, and got both: the chips slid under the finger and the screen
 * slid off it.
 *
 * The rule is the sheet's, turned on its side — a scroller that has somewhere to
 * scroll back to keeps the gesture, and one already at its start has nothing to
 * lose and hands it over. So the pair below is the contract, and the second half
 * is what stops the fix being a blanket refusal that quietly kills the gesture
 * on the two screens that have a filter on them.
 */
test.describe('the back gesture, against a sideways scroller', () => {
  test.use({ userAgent: IPHONE_UA });

  /** The player's own page: a pushed screen with a segmented control on it. */
  async function openPlayerPage(page: Page) {
    await page.getByTestId('tab-players').click();
    const rows = page.getByTestId('player-search-row');
    await expect(rows.first()).toBeVisible();
    await rows.first().click();
    await page.getByTestId('player-full-profile').click();
    await expect(page.getByTestId('player-page')).toBeVisible();
    await settled(page.getByTestId('player-page').locator('.filter-row').first());
  }

  test.beforeEach(async ({ page }) => {
    await asHomeScreenApp(page);
    await page.goto('/');
    await expect(page.getByTestId('tab-draft')).toBeVisible();
    await openPlayerPage(page);
  });

  /** Where the control actually is, which is the whole reason for this suite. */
  test('the filter really does start inside the activation strip', async ({ page }) => {
    const box = (await page.getByTestId('player-page').locator('.filter-row').first().boundingBox())!;
    expect(
      box.x,
      'the control moved out of the edge strip, and this suite is now proving nothing',
    ).toBeLessThan(28);
  });

  test('a scrolled-along filter keeps the swipe that brings it back', async ({ page }) => {
    const filter = page.getByTestId('player-page').locator('.filter-row').first();
    /*
     * Made to overflow, rather than hoped to.
     *
     * How many segments this control carries depends on how many positions the
     * league runs, and the demo league is thin enough that at 390 the row fits
     * — so a test that scrolled it and assumed it moved would pass or fail on
     * the fixture rather than on the behaviour. Narrowing the track makes it a
     * scroller, which is the only property under test, and is the same
     * construction `sheet-interaction.spec.ts` uses to make a body scroll.
     */
    const scrolled = await filter.evaluate((el) => {
      el.style.maxWidth = '96px';
      el.scrollLeft = 40;
      return el.scrollLeft;
    });
    expect(scrolled, 'the filter was not made to scroll, so nothing here is being tested').toBeGreaterThan(0);

    const box = (await filter.boundingBox())!;
    await drag(page, { x: box.x + 2, y: box.y + box.height / 2 }, { x: box.x + 300, y: box.y + box.height / 2 });

    /*
     * The wait is the test, and without it this passes against the defect.
     *
     * A completed swipe does not navigate when the finger lifts: it animates the
     * layer off the screen and calls Back on `transitionend`, with a 400ms
     * fallback behind it in case the transition never fires. So for something
     * like half a second after a swipe that *did* navigate, the screen is still
     * in the document — and an assertion made at that moment that it is still
     * visible is true either way, which is worth stating plainly because it is
     * exactly what this test did on its first pass.
     */
    await page.waitForTimeout(700);
    await expect(
      page.getByTestId('player-page'),
      'swiping the filter back along navigated the screen away as well',
    ).toBeVisible();
  });

  test('and hands it over once the filter is back at its start', async ({ page }) => {
    const filter = page.getByTestId('player-page').locator('.filter-row').first();
    await filter.evaluate((el) => {
      el.scrollLeft = 0;
    });

    const box = (await filter.boundingBox())!;
    await drag(page, { x: box.x + 2, y: box.y + box.height / 2 }, { x: box.x + 320, y: box.y + box.height / 2 });

    await expect(
      page.getByTestId('player-page'),
      'a filter with nothing to scroll back to kept a gesture it had no use for',
    ).toHaveCount(0);
    await expect(page.getByTestId('player-sheet')).toBeVisible();
  });
});

/**
 * The two gestures, both live, on the same screen at the same time.
 *
 * Review is a pushed screen — so it carries the back gesture — and it opens the
 * scoring key as a sheet *from inside its own tree*. React portals move a
 * layer's elements to the end of the document and leave its events propagating
 * up the **component** tree, so a finger on that sheet arrives at the pushed
 * screen's handlers as though it had landed on the screen behind it. This is the
 * same mechanism that once had a sheet's dismissal fighting pull-to-refresh on
 * Trades and Team, arriving at the third gesture in the app.
 *
 * The axes do most of the work: a dismissal has to be dominantly downward and a
 * back swipe dominantly rightward, so neither can be mistaken for the other and
 * a drag cannot engage both. What the axes cannot do anything about is a
 * *sideways* drag on an open sheet that happens to start near the leading edge —
 * which is not a dismissal, correctly, but was a back navigation: the screen
 * underneath slid away while the card the reader was actually touching stayed
 * exactly where it was.
 *
 * So a covered screen does not own the gesture at all, which is the rule
 * `usePullToRefresh` already keeps for the same reason and by the same signal.
 */
test.describe('the back gesture, under an open sheet', () => {
  test.use({ userAgent: IPHONE_UA });

  test.beforeEach(async ({ page }) => {
    await asHomeScreenApp(page);
    await page.goto('/');
    await openReview(page);
    await page.getByTestId('scoring-key-open').click();
    await expect(page.getByTestId('scoring-key')).toBeVisible();
    await settled(page.getByTestId('sheet-grip'));
  });

  test('a sideways drag on the card does not navigate the screen behind it', async ({ page }) => {
    const sheet = (await page.getByTestId('scoring-key').boundingBox())!;
    await drag(page, { x: 4, y: sheet.y + 60 }, { x: 330, y: sheet.y + 66 });

    await pastTheSettle(page);
    await expect(
      page.getByTestId('setup-detail-review'),
      'a sideways drag on an open card navigated the screen underneath it away',
    ).toBeVisible();
    await expect(page.getByTestId('scoring-key'), 'and it took the card with it').toBeVisible();
  });

  /**
   * And the dismissal itself, started at the very edge of the glass — the case
   * where a reader's thumb is furthest from the grip and most likely to be
   * somewhere the back gesture is also listening.
   */
  test('dismissing the card from the leading edge dismisses only the card', async ({ page }) => {
    /*
     * Anchored on the grip rather than on an offset from the top of the sheet.
     * A sheet is a grip, a header and then its content, and where a fixed offset
     * lands among those three depends on the width — sixty points was the header
     * at 390 and the body at 430, and a drag from the body correctly dismisses
     * nothing, so the test failed on the widest phone while testing nothing on
     * the others. What is under test is a dismissal that starts at the far left
     * of the glass, so it starts on the chrome that dismisses, at x = 6.
     */
    const grip = (await page.getByTestId('sheet-grip').boundingBox())!;
    await drag(page, { x: 6, y: grip.y + 4 }, { x: 10, y: grip.y + 460 });

    await expect(page.getByTestId('scoring-key')).toHaveCount(0);
    await expect(
      page.getByTestId('setup-detail-review'),
      'dismissing the card also navigated the screen behind it',
    ).toBeVisible();
  });

  /** And the gesture comes straight back once the card has gone. */
  test('and the screen can be swiped away again once the card has gone', async ({ page }) => {
    await page.getByTestId('sheet-close').click();
    await expect(page.getByTestId('scoring-key')).toHaveCount(0);

    await drag(page, { x: 4, y: 420 }, { x: 330, y: 430 });
    await expect(
      page.getByTestId('setup-detail-review'),
      'the gesture was left switched off after the card closed',
    ).toHaveCount(0);
  });
});

test.describe('the back gesture in a browser tab', () => {
  test('is not offered, because the edge is the browser’s there', async ({ page }) => {
    await page.goto('/');
    await openSetupArea(page);
    // The layer says so, and the gesture is inert: the screen stays put.
    await expect(page.getByTestId('setup-detail-vegas')).toHaveAttribute('data-swipe-back', 'off');
    await drag(page, { x: 4, y: 420 }, { x: 340, y: 424 });
    await expect(page.getByTestId('setup-detail-vegas')).toBeVisible();
    // Back itself still works, which is the point: nothing was taken away.
    await page.getByTestId('back-button').click();
    await expect(page.getByTestId('setup-step-vegas')).toBeVisible();
  });
});

test.describe('sheets', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await openReview(page);
    await page.getByTestId('scoring-key-open').click();
    await expect(page.getByTestId('scoring-key')).toBeVisible();
    /*
     * Wait for it to finish rising before anything measures it.
     *
     * `toBeVisible` passes the moment the sheet is in the document, which is
     * the start of its entry animation rather than the end. Every test below
     * takes the grip's position and drags from it, and a position captured
     * mid-flight is a drag that starts somewhere the grip no longer is — so
     * this dismissed reliably on a fast machine and intermittently on a busy
     * one, which is the worst possible failure profile: green locally, red in
     * CI, and nothing wrong with the app.
     *
     * Settling is asked as a question about the element rather than answered
     * with a fixed sleep, so it stays correct if the animation's duration ever
     * changes.
     */
    await settled(page.getByTestId('sheet-grip'));
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

  /**
   * The gesture is the browser's to give away, and the sheet asks correctly.
   *
   * This is the one property in this file that no drag test can check, and the
   * reason a real bug lived here through several passes: `touch-action` governs
   * *touch* input, and every drag in this suite is synthesised with a mouse. So
   * the pointer arithmetic above passed while a finger on a phone produced
   * nothing but the page behind rubber-banding — Safari had classified the drag
   * as a scroll before the first `pointermove`, exactly as the note on
   * `.drag-handle` warned it would.
   *
   * What is asserted is therefore the declaration rather than the outcome: the
   * chrome that takes the drag claims every gesture on it, the body that
   * scrolls hands every gesture to the browser, and no ancestor of the body
   * claims anything — a `none` above a scroller is propagated straight through
   * it by WebKit before Safari 17, and the sheet has no reason to find out
   * which version the reader is on.
   */
  test('lets the browser scroll the body, and keeps the drag for itself', async ({ page }) => {
    const claimed = await page.evaluate(() => {
      const read = (selector: string) => {
        const el = document.querySelector(selector) as HTMLElement;
        return getComputedStyle(el).touchAction;
      };
      const body = document.querySelector('.sheet-body') as HTMLElement;
      return {
        sheet: read('.sheet'),
        grip: read('.sheet-grip'),
        header: read('.sheet-header'),
        body: read('.sheet-body'),
        scrollable: body.dataset['scrollable'],
      };
    });

    // The chrome — grip, header — claims every gesture that lands on it.
    expect(claimed.grip, 'the browser will take a drag on the grip before the sheet sees it').toBe('none');
    expect(claimed.header, 'the browser will take a drag on the header before the sheet sees it').toBe('none');

    /*
     * And the body's permission is unconditional, for the whole life of the
     * sheet.
     *
     * It used to depend on `data-scrollable`, measured from the content — which
     * is a promise the app cannot keep, because a card opens before its two
     * requests have answered and the engine reads this once, when the finger
     * lands. A body that says `none` while its content is still arriving costs
     * the reader that entire gesture. There is nothing to measure now, so the
     * attribute must be gone as well as the branch.
     */
    expect(claimed.body, 'the body did not hand the scroll to the browser').toBe('pan-y');
    expect(claimed.scrollable, 'the body is measuring itself again').toBeUndefined();
    expect(claimed.sheet, 'an ancestor of the scroller claims the gesture').not.toBe('none');
    expect(
      ['pan-up', 'pan-down', 'pan-left', 'pan-right'],
      'a directional touch-action is silently ignored by WebKit',
    ).not.toContain(claimed.body);
  });

  /**
   * A modal surface is modal, including underneath.
   *
   * The other half of the same complaint: dragging on a sheet moved the list
   * behind it. A backdrop the reader can scroll is not a backdrop, and it made
   * a working dismissal look broken — the sheet did go away, but the page had
   * moved by the time it did.
   */
  test('holds the page behind still while it is open', async ({ page }) => {
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');
    await page.getByTestId('sheet-close').click();
    await expect(page.getByTestId('scoring-key')).toHaveCount(0);
    expect(
      await page.evaluate(() => document.body.style.overflow),
      'the page was left locked after the sheet closed',
    ).not.toBe('hidden');
  });

  test('scrolled content keeps the gesture until it is back at the top', async ({ page }) => {
    // Force the body to be scrolled: a sheet that dismissed from here would be
    // taking a scroll away from the reader.
    const scrolled = await page.evaluate(() => {
      const body = document.querySelector('.sheet-body') as HTMLElement;
      body.style.maxHeight = '80px';
      body.scrollTop = 40;
      return body.scrollTop;
    });
    expect(scrolled, 'the body was not made to scroll, so nothing here is being tested').toBeGreaterThan(0);

    /*
     * Measured off the body rather than off the sheet, which is what this used
     * to do. A sheet is a grip, a header and then its content, so an offset
     * taken from the top of the *sheet* lands wherever those two happen to add
     * up to — and this one was landing outside the scroller, which made the test
     * pass against a build with the rule it names deliberately removed.
     */
    const body = (await page.locator('.sheet-body').boundingBox())!;
    const x = body.x + body.width / 2;
    await drag(page, { x, y: body.y + 20 }, { x, y: body.y + 420 });
    // A dismissal that fired would still be on screen right now. See the helper.
    await pastTheSettle(page);
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
    for (const tab of ['team', 'trades', 'players', 'setup', 'draft'] as const) {
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
