/**
 * The floating toolbar, as a contract.
 *
 * The bottom bar stopped being a full-width band welded to the edge of the
 * screen and became a compact pill floating clear of it. That is a presentation
 * change and nothing else — the same six destinations, the same taps, the same
 * screens — so most of what is asserted here is that nothing moved: every
 * destination is still reachable, still named the same thing, still lights up
 * for the screen that is actually showing.
 *
 * The rest is the set of ways a floating bar goes wrong, which is a specific
 * and short list: it covers the last row of a long page, it wraps its labels on
 * a narrow phone, it shrinks its targets below a fingertip, it hovers over the
 * keyboard, it floats on top of a modal, and its selection drifts out of step
 * with the screen. Each of those is a test.
 *
 * Where the app's own geometry is concerned this file asks the page for the
 * numbers rather than hardcoding them, so it keeps working when the design
 * changes its mind about a radius or a gap — and keeps failing when the design
 * loses one of these properties.
 */

import { expect, test, type Page } from '@playwright/test';

const DESTINATIONS = ['draft', 'team', 'trades', 'players', 'review', 'setup'] as const;

/** The screen each destination is supposed to be showing, once it is tapped. */
const SCREEN_OF: Record<(typeof DESTINATIONS)[number], string> = {
  draft: 'draft-nav',
  team: 'league-card',
  trades: 'trades-nav',
  players: 'players-nav',
  review: 'review-nav',
  setup: 'setup-step-sleeper',
};

async function open(page: Page, tab: (typeof DESTINATIONS)[number]) {
  await page.getByTestId(`tab-${tab}`).click();
  await page.waitForTimeout(350);
}

/**
 * The pill's box, and the numbers the design derives it from.
 *
 * Waited for rather than assumed: the app shows a loading state before it knows
 * whether changes are allowed, and there is no toolbar in the document until
 * that answer arrives.
 */
async function toolbar(page: Page) {
  await page.locator('.tabbar').waitFor({ state: 'attached' });
  return page.evaluate(() => {
    const bar = document.querySelector('.tabbar')!;
    const box = bar.getBoundingClientRect();
    return {
      top: Math.round(box.top),
      bottom: Math.round(box.bottom),
      left: Math.round(box.left),
      width: Math.round(box.width),
      height: Math.round(box.height),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      radius: Number.parseFloat(getComputedStyle(bar).borderTopLeftRadius),
      keyboard: bar.getAttribute('data-keyboard'),
    };
  });
}

test.describe('the destinations', () => {
  test('all six are there, named what they were, and reach their screen', async ({ page }) => {
    await page.goto('/');
    for (const tab of DESTINATIONS) {
      await open(page, tab);
      await expect(page.getByTestId(SCREEN_OF[tab]).first(), `${tab} did not open its screen`).toBeVisible();
    }
  });

  /**
   * Read from the label's own text node, not from the button's rendered text.
   *
   * A destination is a glyph, a word, and sometimes a badge or a lock mark, and
   * the two engines do not agree about what `innerText` makes of that: Chromium
   * puts the absolutely-positioned badge on a line of its own and WebKit runs it
   * straight on, so Review reads as `Review` in one and `Review7` in the other.
   * The word is a text node either way, and that is what this is about.
   */
  test('the labels are still words, not glyphs alone', async ({ page }) => {
    await page.goto('/');
    await page.locator('.tabbar').waitFor({ state: 'attached' });
    const labels = await page.evaluate(() =>
      [...document.querySelectorAll('.tabbar button')].map((b) =>
        [...b.childNodes]
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent?.trim() ?? '')
          .join(''),
      ),
    );
    expect(labels).toEqual(['Draft', 'Team', 'Trades', 'Players', 'Review', 'Setup']);
  });

  /**
   * One bar, not two.
   *
   * The classic way this change goes wrong is that the old navigation survives
   * underneath the new one — usually invisible on a desktop and stacked on a
   * phone. There is exactly one element carrying the destinations.
   */
  test('there is only one navigation on screen', async ({ page }) => {
    await page.goto('/');
    for (const tab of DESTINATIONS) {
      await open(page, tab);
      await expect(page.locator('.tabbar')).toHaveCount(1);
      await expect(page.getByTestId('tab-draft')).toHaveCount(1);
      await expect(page.locator('nav[aria-label="Main navigation"]')).toHaveCount(1);
    }
  });
});

/**
 * Which destination is lit, and where that fact comes from.
 *
 * The toolbar holds no selection of its own: it is handed the app's current
 * destination and draws it. That is not directly observable, so what is checked
 * is the property it buys — the highlight and the screen can never disagree,
 * including on a screen the toolbar did not open.
 */
test.describe('the active destination', () => {
  test('is exactly one, and it is the screen that is showing', async ({ page }) => {
    await page.goto('/');
    for (const tab of DESTINATIONS) {
      await open(page, tab);
      const current = await page.locator('.tabbar button[aria-current="page"]').all();
      expect(current, `${tab}: exactly one destination may be current`).toHaveLength(1);
      await expect(page.getByTestId(`tab-${tab}`)).toHaveAttribute('aria-current', 'page');
      await expect(page.getByTestId(SCREEN_OF[tab]).first()).toBeVisible();
    }
  });

  /**
   * A nested screen belongs to the destination that opened it.
   *
   * Setup pushes a detail screen over itself. A toolbar keeping its own idea of
   * where it is would either light nothing here or light whatever was tapped
   * last, which is the failure this catches.
   */
  test('stays on the parent while a nested screen is open', async ({ page }) => {
    await page.goto('/');
    await open(page, 'setup');
    await page.getByTestId('setup-step-vegas').click();
    await expect(page.getByTestId('setup-detail-vegas')).toBeVisible();

    await expect(page.getByTestId('tab-setup')).toHaveAttribute('aria-current', 'page');
    expect(await page.locator('.tabbar button[aria-current="page"]').count()).toBe(1);

    await page.getByTestId('back-button').click();
    await expect(page.getByTestId('setup-step-vegas')).toBeVisible();
    await expect(page.getByTestId('tab-setup')).toHaveAttribute('aria-current', 'page');
  });

  /**
   * The destination the app chose, not the one you tapped.
   *
   * This is the test that actually pins "the toolbar holds no selection of its
   * own". Everywhere else in the app a tap and the current screen change
   * together, so a toolbar keeping a private copy would look identical — the
   * copy only drifts when something *other than a tap* moves the app, and there
   * is exactly one such path: a first-time reader with no league selected is
   * landed on Setup. The overview is answered with "no league" to reach it.
   *
   * A toolbar that remembered where it was would light Draft here, over a Setup
   * screen.
   */
  test('follows the app when the app navigates on its own', async ({ page }) => {
    await page.route('**/api/overview', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ json: { ...body, selectedLeague: null } });
    });

    await page.goto('/');
    await expect(page.getByTestId('setup-step-sleeper')).toBeVisible();
    await expect(page.getByTestId('tab-setup')).toHaveAttribute('aria-current', 'page');
    expect(await page.locator('.tabbar button[aria-current="page"]').count()).toBe(1);
    await expect(page.getByTestId('tab-draft')).not.toHaveAttribute('aria-current', 'page');
    await page.unroute('**/api/overview');
  });

  test('survives tapping the destination you are already on', async ({ page }) => {
    await page.goto('/');
    await open(page, 'players');
    await page.getByTestId('tab-players').click();
    await expect(page.getByTestId('tab-players')).toHaveAttribute('aria-current', 'page');
    expect(await page.locator('.tabbar button[aria-current="page"]').count()).toBe(1);
  });

  /**
   * The bar must not move when the selection does.
   *
   * A selected state that widens its own destination — a filled pill, a grown
   * label — reflows the other five, and a bottom bar that jiggles on every tap
   * is the loudest thing on a phone screen.
   */
  test('changes nothing about the toolbar’s geometry', async ({ page }) => {
    await page.goto('/');
    const shapes = [];
    const buttons = [];
    for (const tab of DESTINATIONS) {
      await open(page, tab);
      shapes.push(await toolbar(page));
      buttons.push(
        await page.evaluate(() =>
          [...document.querySelectorAll('.tabbar button')].map((b) => Math.round(b.getBoundingClientRect().width)),
        ),
      );
    }
    for (const shape of shapes) expect(shape).toEqual(shapes[0]);
    for (const widths of buttons) expect(widths).toEqual(buttons[0]);
  });
});

test.describe('shape and reach', () => {
  test('is a compact floating pill, not a full-width band', async ({ page }) => {
    await page.goto('/');
    const bar = await toolbar(page);
    // Narrower than the screen, with real margin either side — 20px is the
    // least that reads as floating rather than as a band with a gutter.
    expect(bar.width, `the bar is ${bar.width}px on a ${bar.viewportWidth}px screen`).toBeLessThanOrEqual(
      bar.viewportWidth - 40,
    );

    /*
     * And it is that width because of what is in it, not because something set
     * one. A bar stretched to the screen and then inset by a margin looks
     * similar and is not the same thing: its destinations drift apart as the
     * phone gets wider, and it stops being sized by its own contents.
     */
    const packed = await page.evaluate(() => {
      const bar = document.querySelector('.tabbar')!;
      const style = getComputedStyle(bar);
      const chrome =
        Number.parseFloat(style.paddingLeft) +
        Number.parseFloat(style.paddingRight) +
        Number.parseFloat(style.borderLeftWidth) +
        Number.parseFloat(style.borderRightWidth);
      const buttons = [...bar.querySelectorAll('button')].reduce((sum, b) => sum + b.getBoundingClientRect().width, 0);
      return Math.round(bar.getBoundingClientRect().width - (buttons + chrome));
    });
    expect(packed, 'the pill has slack in it, so it is stretched rather than packed').toBeLessThanOrEqual(2);
    // Clear of the bottom edge, and only just.
    expect(bar.bottom).toBeLessThan(bar.viewportHeight);
    expect(bar.viewportHeight - bar.bottom).toBeLessThanOrEqual(20);
    // Icon plus label, and nothing spent on chrome around them.
    expect(bar.height).toBeGreaterThanOrEqual(54);
    expect(bar.height).toBeLessThanOrEqual(64);
    expect(bar.radius, 'a floating control is rounded').toBeGreaterThanOrEqual(16);
  });

  test('every destination is a full target and none of them wraps', async ({ page }) => {
    await page.goto('/');
    for (const tab of DESTINATIONS) {
      const box = (await page.getByTestId(`tab-${tab}`).boundingBox())!;
      expect(box.height, `${tab} is ${box.height}px tall`).toBeGreaterThanOrEqual(44);
      expect(box.width, `${tab} is ${box.width}px wide`).toBeGreaterThanOrEqual(44);
    }
    // A wrapped label doubles the line count, which is the observable symptom.
    const lines = await page.evaluate(() =>
      [...document.querySelectorAll('.tabbar button')].map((b) => {
        const label = [...b.childNodes].find((n) => n.nodeType === Node.TEXT_NODE);
        const range = document.createRange();
        range.selectNodeContents(label!);
        return range.getClientRects().length;
      }),
    );
    for (const count of lines) expect(count, 'a label wrapped onto a second line').toBe(1);
  });

  test('leaves nothing of the page hidden behind it', async ({ page }) => {
    await page.goto('/');
    for (const tab of ['draft', 'players', 'trades', 'setup'] as const) {
      await open(page, tab);
      // Scroll until the page stops moving: the reservation changes the
      // document height, so one scroll to a height measured before it lands
      // stops short of the real bottom.
      for (let i = 0; i < 6; i++) {
        const moved = await page.evaluate(() => {
          const before = window.scrollY;
          window.scrollTo(0, document.documentElement.scrollHeight);
          return window.scrollY !== before;
        });
        if (!moved) break;
        await page.waitForTimeout(150);
      }
      const clear = await page.evaluate(() => {
        const bar = document.querySelector('.tabbar')!.getBoundingClientRect();
        const main = document.querySelector('.app-main')!;
        const last = main.lastElementChild?.getBoundingClientRect() ?? null;
        return { barTop: Math.round(bar.top), lastBottom: last ? Math.round(last.bottom) : null };
      });
      if (clear.lastBottom !== null) {
        expect(clear.lastBottom, `${tab}: the last thing on the page sits under the toolbar`).toBeLessThanOrEqual(
          clear.barTop,
        );
      }
    }
  });
});

/**
 * The keyboard.
 *
 * iOS shrinks the *visual* viewport for the keyboard and leaves the layout one
 * alone, so a bar correctly pinned to the bottom of the page ends up floating
 * over the field being typed into. Playwright cannot raise a soft keyboard, so
 * the signal the app actually reads is stood in for: a visual viewport that
 * reports itself several hundred pixels shorter than the page. Everything
 * downstream of that signal is real.
 */
test.describe('the keyboard', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      /*
       * Stands in for `window.visualViewport`, which cannot be resized from
       * outside the browser. It reports the page's own height until a test says
       * otherwise, so a page with no keyboard reads exactly as it really does.
       */
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
  });

  test('the toolbar leaves while it is up, and comes back when it goes', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.tabbar')).toHaveAttribute('data-keyboard', 'closed');
    await expect(page.getByTestId('tab-draft')).toBeVisible();

    await page.evaluate(() => (window as unknown as { __keyboard: (px: number) => void }).__keyboard(336));
    await expect(page.locator('.tabbar')).toHaveAttribute('data-keyboard', 'open');
    // Gone from the screen and gone from the tab order, not merely faded.
    await expect(page.getByTestId('tab-draft')).toBeHidden();

    await page.evaluate(() => (window as unknown as { __keyboard: (px: number) => void }).__keyboard(0));
    await expect(page.locator('.tabbar')).toHaveAttribute('data-keyboard', 'closed');
    await expect(page.getByTestId('tab-draft')).toBeVisible();
  });

  /*
   * Safari's own chrome collapsing as the page scrolls moves the two viewports
   * relative to each other by a few tens of pixels. A bar that hid for that
   * would flicker on every scroll, which is worse than one that never moves.
   */
  test('ignores the browser’s own chrome coming and going', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('tab-draft')).toBeVisible();
    await page.evaluate(() => (window as unknown as { __keyboard: (px: number) => void }).__keyboard(60));
    await page.waitForTimeout(200);
    await expect(page.locator('.tabbar')).toHaveAttribute('data-keyboard', 'closed');
    await expect(page.getByTestId('tab-draft')).toBeVisible();
  });

  test('the Draft search still opens and still filters with it up', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('board-list')).toBeVisible();
    await page.getByTestId('draft-search-open').click();
    await page.evaluate(() => (window as unknown as { __keyboard: (px: number) => void }).__keyboard(336));

    const field = page.getByTestId('draft-search');
    await expect(field).toBeVisible();
    await field.fill('sotelo');
    await expect(page.getByTestId('recommendation-row')).toHaveCount(1);
    // …and the toolbar is not sitting on top of the field.
    await expect(page.locator('.tabbar')).toHaveAttribute('data-keyboard', 'open');
  });
});

/**
 * A sheet is in front, and nothing behind it is tappable.
 *
 * A floating bar with a shadow is exactly the kind of element that ends up on
 * top of a modal, because it looks like it should be. It must not be, and its
 * destinations must not be reachable through the backdrop.
 */
test.describe('modal layering', () => {
  test('the toolbar is behind the sheet and takes no taps through it', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('tab-review').click();
    await page.getByTestId('scoring-key-open').click();
    await expect(page.getByTestId('scoring-key')).toBeVisible();

    const order = await page.evaluate(() => ({
      bar: Number.parseInt(getComputedStyle(document.querySelector('.tabbar')!).zIndex, 10),
      backdrop: Number.parseInt(getComputedStyle(document.querySelector('.sheet-backdrop')!).zIndex, 10),
      sheet: Number.parseInt(getComputedStyle(document.querySelector('.sheet')!).zIndex, 10),
    }));
    expect(order.bar).toBeLessThan(order.backdrop);
    expect(order.backdrop).toBeLessThan(order.sheet);

    /*
     * And the arithmetic is not the claim — what is on top at the pixel is.
     * A destination is picked and the document asked what is actually there.
     */
    const covered = await page.evaluate(() => {
      const box = document.querySelector('[data-testid="tab-draft"]')!.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return hit?.closest('.tabbar') === null;
    });
    expect(covered, 'a tap where a destination is would reach the toolbar').toBe(true);

    // The sheet is still the thing on screen, and Review is still current.
    await expect(page.getByTestId('scoring-key')).toBeVisible();
    await expect(page.getByTestId('tab-review')).toHaveAttribute('aria-current', 'page');
    await page.getByTestId('sheet-close').click();
  });

  test('no navigation is duplicated inside the sheet', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('tab-review').click();
    await page.getByTestId('scoring-key-open').click();
    await expect(page.getByTestId('scoring-key')).toBeVisible();
    await expect(page.getByTestId('scoring-key').locator('.tabbar')).toHaveCount(0);
    await page.getByTestId('sheet-close').click();
  });
});

/**
 * Draft is seasonal, and it is the only destination that is.
 *
 * The regular season is stood in for at the one place the app reads it — the
 * overview's `season` block — which is exactly how the real transition arrives:
 * Sleeper's `/state/nfl` flips, the server resolves it, and the client is told.
 * Everything downstream of that answer is real.
 *
 * Both directions are asserted, because the expensive failure is not "the tab
 * stayed too long" — it is a user losing their board in the middle of August.
 */
test.describe('Draft, once the regular season starts', () => {
  /** Answer the overview as if week one had kicked off. */
  async function inRegularSeason(page: Page) {
    await page.route('**/api/overview', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        json: {
          ...body,
          season: { phase: 'regular', draftVisible: false, reason: 'week 1', assumed: false },
        },
      });
    });
  }

  test('is in the bar before the season starts', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('tab-draft')).toBeVisible();
    expect(await page.locator('.tabbar button').count()).toBe(6);
  });

  /**
   * Draft leaves and Waivers arrives in the same slot.
   *
   * The count is unchanged at six, deliberately: the seasonal slot is one slot,
   * and a bar that briefly carried both would be seven destinations on a 360px
   * phone. Where Waivers sits is asserted in `waivers.spec.ts`.
   */
  test('leaves the bar once the season is under way', async ({ page }) => {
    await inRegularSeason(page);
    await page.goto('/');
    await expect(page.getByTestId('tab-team')).toBeVisible();
    await expect(page.getByTestId('tab-draft')).toHaveCount(0);
    await expect(page.getByTestId('tab-waivers')).toBeVisible();
    expect(await page.locator('.tabbar button').count()).toBe(6);
    // The other five are all still there, named what they were.
    for (const tab of ['team', 'trades', 'players', 'review', 'setup'] as const) {
      await expect(page.getByTestId(`tab-${tab}`)).toBeVisible();
    }
  });

  /**
   * The bar repacks; it does not leave a hole where Draft was.
   *
   * Measured the same way the six-destination bar is: the pill is as wide as
   * what is in it, with no slack, and it is still centred and still clear of
   * the edges. A bar that kept an empty slot would be wider than its contents.
   */
  test('rebalances with no gap and stays a centred floating pill', async ({ page }) => {
    await inRegularSeason(page);
    await page.goto('/');
    await expect(page.getByTestId('tab-team')).toBeVisible();

    const bar = await toolbar(page);
    expect(bar.width).toBeLessThanOrEqual(bar.viewportWidth - 40);
    expect(bar.bottom).toBeLessThan(bar.viewportHeight);
    expect(bar.height).toBeGreaterThanOrEqual(54);
    expect(bar.height).toBeLessThanOrEqual(64);

    const geometry = await page.evaluate(() => {
      const el = document.querySelector('.tabbar')!;
      const style = getComputedStyle(el);
      const chrome =
        Number.parseFloat(style.paddingLeft) +
        Number.parseFloat(style.paddingRight) +
        Number.parseFloat(style.borderLeftWidth) +
        Number.parseFloat(style.borderRightWidth);
      const box = el.getBoundingClientRect();
      const buttons = [...el.querySelectorAll('button')].map((b) => b.getBoundingClientRect());
      return {
        slack: Math.round(box.width - (buttons.reduce((sum, b) => sum + b.width, 0) + chrome)),
        centreOffset: Math.round(Math.abs(box.left + box.width / 2 - window.innerWidth / 2)),
        // The largest horizontal gap between neighbouring destinations.
        biggestGap: Math.round(
          Math.max(...buttons.slice(1).map((b, i) => b.left - buttons[i]!.right)),
        ),
        minWidth: Math.round(Math.min(...buttons.map((b) => b.width))),
        minHeight: Math.round(Math.min(...buttons.map((b) => b.height))),
      };
    });
    expect(geometry.slack, 'the pill is stretched rather than packed').toBeLessThanOrEqual(2);
    expect(geometry.centreOffset, 'the bar is no longer centred').toBeLessThanOrEqual(1);
    expect(geometry.biggestGap, 'an empty Draft slot was left behind').toBeLessThanOrEqual(2);
    // Still a fingertip each.
    expect(geometry.minWidth).toBeGreaterThanOrEqual(44);
    expect(geometry.minHeight).toBeGreaterThanOrEqual(44);
  });

  /** The app opens somewhere that is in the bar, and lights it. */
  test('opens on Team instead, with exactly one destination current', async ({ page }) => {
    await inRegularSeason(page);
    await page.goto('/');
    await expect(page.getByTestId('tab-team')).toHaveAttribute('aria-current', 'page');
    expect(await page.locator('.tabbar button[aria-current="page"]').count()).toBe(1);
    await expect(page.getByTestId('league-card').first()).toBeVisible();
  });

  /**
   * Hiding the destination did not delete the screen.
   *
   * The board is still rendered when the app is on it — the tab is a way in,
   * not the only thing keeping the route alive — and the browser's own
   * navigation behaves exactly as it always did, because the app still pushes
   * no history of its own.
   */
  test('keeps the Draft screen itself reachable', async ({ page }) => {
    await inRegularSeason(page);
    await page.goto('/');
    await expect(page.getByTestId('tab-team')).toBeVisible();

    // The board is still built and still served: hiding a destination is a
    // navigation change, and it deleted no route and no historical draft data.
    const board = await (await page.request.get('/api/drafts/demo-draft/board?limit=5')).json();
    expect(board.recommendations.length).toBeGreaterThan(0);

    const before = await page.evaluate(() => window.history.length);
    await page.getByTestId('tab-players').click();
    await expect(page.getByTestId('tab-players')).toHaveAttribute('aria-current', 'page');
    expect(await page.evaluate(() => window.history.length), 'a tab is not a page').toBe(before);
    expect(new URL(page.url()).pathname).toBe('/');
  });

  test('comes back when the season answer does', async ({ page }) => {
    await inRegularSeason(page);
    await page.goto('/');
    await expect(page.getByTestId('tab-draft')).toHaveCount(0);

    await page.unroute('**/api/overview');
    await page.reload();
    await expect(page.getByTestId('tab-draft')).toBeVisible();
  });
});

test.describe('reduced motion', () => {
  test('the toolbar still arrives and leaves, without animating', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await expect(page.getByTestId('tab-draft')).toBeVisible();
    const seconds = await page.evaluate(() =>
      Number.parseFloat(getComputedStyle(document.querySelector('.tabbar')!).transitionDuration),
    );
    expect(seconds, 'nothing should be animating under reduced motion').toBeLessThanOrEqual(0.001);

    // …and it is still a working navigation.
    await page.getByTestId('tab-team').click();
    await expect(page.getByTestId('tab-team')).toHaveAttribute('aria-current', 'page');
  });
});

/**
 * Matchup, once the draft is finished.
 *
 * The third seasonal destination, and the one that makes the bar carry seven
 * for the only stretch of the year it ever does — between a draft finishing and
 * week one, when Draft has not left yet and Matchup has already arrived.
 *
 * Seven is the number this bar was explicitly built not to wrap at, so the two
 * things asserted here are the ones that would break: no label goes to a second
 * line, and no destination shrinks below a fingertip. Both are checked at
 * whichever width the project is running, which is the point of running the
 * suite at four of them.
 */
test.describe('Matchup, once the draft is finished', () => {
  /** Answer the overview as if the draft were complete and week one pending. */
  async function postDraft(page: Page) {
    await page.route('**/api/overview', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        json: {
          ...body,
          lifecycle: {
            ...(body.lifecycle ?? {}),
            lifecycle: 'post_draft',
            draftVisible: true,
            matchupVisible: true,
          },
        },
      });
    });
  }

  test('is absent while the draft is still running', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('tab-draft')).toBeVisible();
    await expect(page.getByTestId('tab-matchup')).toHaveCount(0);
  });

  test('arrives beside Team once the draft is complete', async ({ page }) => {
    await postDraft(page);
    await page.goto('/');
    await expect(page.getByTestId('tab-matchup')).toBeVisible();
    expect(await page.locator('.tabbar button').count()).toBe(7);

    const labels = await page.evaluate(() =>
      [...document.querySelectorAll('.tabbar button')].map((b) =>
        [...b.childNodes]
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent?.trim() ?? '')
          .join(''),
      ),
    );
    expect(labels).toEqual(['Draft', 'Team', 'Matchup', 'Trades', 'Players', 'Review', 'Setup']);
  });

  test('carries seven without wrapping a label or shrinking a target', async ({ page }) => {
    await postDraft(page);
    await page.goto('/');
    await expect(page.getByTestId('tab-matchup')).toBeVisible();

    for (const tab of ['draft', 'team', 'matchup', 'trades', 'players', 'review', 'setup'] as const) {
      const box = (await page.getByTestId(`tab-${tab}`).boundingBox())!;
      expect(box.height, `${tab} is ${box.height}px tall`).toBeGreaterThanOrEqual(44);
      expect(box.width, `${tab} is ${box.width}px wide`).toBeGreaterThanOrEqual(44);
    }

    const lines = await page.evaluate(() =>
      [...document.querySelectorAll('.tabbar button')].map((b) => {
        const label = [...b.childNodes].find((n) => n.nodeType === Node.TEXT_NODE);
        const range = document.createRange();
        range.selectNodeContents(label!);
        return range.getClientRects().length;
      }),
    );
    for (const count of lines) expect(count, 'a label wrapped onto a second line').toBe(1);

    const bar = await toolbar(page);
    expect(bar.width, 'the bar has outgrown the screen').toBeLessThanOrEqual(bar.viewportWidth - 16);
    expect(bar.left, 'the bar is no longer centred').toBeGreaterThan(0);
  });

  /**
   * …and the seventh destination costs the bar height, on purpose, once.
   *
   * At 374px and under, a seven-destination bar takes two points off the pill's
   * own padding — `--toolbar-pad` goes to 3 — so the bar is 52 rather than 56.
   * That is a deliberate trade with its reasoning written at the rule: the
   * targets are untouched and the bar keeps its gutter from both screen edges.
   *
   * It is asserted here because nothing local was watching it. The number is
   * real and intended, and the only thing that noticed when the live league
   * gained its seventh destination was the production smoke suite, which was
   * still holding the six-destination floor. A number this deliberate should
   * fail on a laptop rather than after a deploy.
   *
   * The fingertip floor is checked above and is not what gives here.
   */
  test('spends the seventh destination out of the pill rather than the targets', async ({ page }) => {
    await postDraft(page);
    await page.goto('/');
    await expect(page.getByTestId('tab-matchup')).toBeVisible();

    const bar = await toolbar(page);
    const count = await page.locator('.tabbar button').count();
    expect(count).toBe(7);

    const expected = bar.viewportWidth <= 374 ? 52 : 56;
    expect(bar.height, `a seven-destination bar is ${bar.height}px at ${bar.viewportWidth}px`).toBe(expected);

    // The padding is where it came from, and the target is not.
    for (const tab of ['draft', 'matchup', 'setup'] as const) {
      const box = (await page.getByTestId(`tab-${tab}`).boundingBox())!;
      expect(box.height, `${tab} gave up a fingertip`).toBeGreaterThanOrEqual(44);
    }
  });

  /**
   * The `VS` stays inside its ring, at both weights.
   *
   * Matchup is the one glyph in the bar drawn as a mark *inside* another mark,
   * and selecting a tab redraws all of them at `stroke-width: 2.15`. That is
   * where this can fail without anybody editing the icon: the ring thickens
   * inwards and the letters thicken outwards in the same moment, so a pair with
   * comfortable air at rest can close the gap on both sides the instant the tab
   * is tapped, and the `VS` becomes a blot in a circle.
   *
   * Read off the rendered boxes rather than off the path data, because what
   * matters is where the ink lands after the group's scale, the viewBox and the
   * bar's 22px have all been applied — none of which the numbers in the file
   * mention. Asserted at whatever width the project is running.
   */
  test('draws the VS clear of its ring whether the tab is selected or not', async ({ page }) => {
    await postDraft(page);
    await page.goto('/');
    await expect(page.getByTestId('tab-matchup')).toBeVisible();

    const clearance = async () =>
      page.getByTestId('tab-matchup').evaluate((tab) => {
        const svg = tab.querySelector('svg')!;
        const ring = svg.querySelector('circle')!;
        const letters = svg.querySelector('g')!;
        const box = ring.getBoundingClientRect();
        const geometry = letters.getBoundingClientRect();

        /*
         * Both rects are the *geometry*, without the stroke — so the ink is
         * half a stroke either side of each of them, and the letters carry a
         * different half from the ring: they are inside a scaled group, and a
         * scale divides the stroke along with everything else. Read both
         * scales off the rendered matrices rather than the file, so the check
         * measures what the browser drew and not what the source intended.
         */
        const declared = Number.parseFloat(getComputedStyle(svg).strokeWidth);
        const ringStroke = declared * svg.getScreenCTM()!.a;
        const letterStroke = declared * letters.getScreenCTM()!.a;

        const inner = box.width / 2 - ringStroke / 2;
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        const reach = Math.hypot(
          Math.max(Math.abs(geometry.x - cx), Math.abs(geometry.right - cx)) + letterStroke / 2,
          Math.max(Math.abs(geometry.y - cy), Math.abs(geometry.bottom - cy)) + letterStroke / 2,
        );
        return { stroke: +ringStroke.toFixed(2), gap: +(inner - reach).toFixed(2) };
      });

    const resting = await clearance();
    expect(resting.gap, `the resting VS clears its ring by ${resting.gap}px`).toBeGreaterThan(0.4);

    await page.getByTestId('tab-matchup').click();
    await expect(page.getByTestId('tab-matchup')).toHaveAttribute('aria-current', 'page');
    const selected = await clearance();

    // The selected glyph really is the heavier one — otherwise the check above
    // would be passing twice on the same drawing.
    expect(selected.stroke, 'selecting a tab draws it heavier').toBeGreaterThan(resting.stroke);
    expect(selected.gap, `the selected VS clears its ring by ${selected.gap}px`).toBeGreaterThan(0.2);
  });
});
