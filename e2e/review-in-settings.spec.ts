/**
 * Review lives in Settings, and asks for attention only when it has some.
 *
 * Review is real infrastructure — it is where an ambiguous newsletter item gets
 * a verdict and where a name the matcher could not place gets a player — and it
 * is also maintenance: work done occasionally, by the one person who owns the
 * league, at no particular moment. It spent a slot on the toolbar next to the
 * five destinations somebody opens this app to *decide* something with, and a
 * queue of housekeeping does not belong beside a start/sit call on a Sunday
 * morning.
 *
 * So it moved one level in, to a row in Settings, and the whole risk of that
 * move is captured by this file. There are exactly three ways it goes wrong:
 * the work becomes invisible, so a backlog quietly grows; the screen becomes
 * unreachable, or reachable but broken; or the toolbar is left in an
 * inconsistent state — a hole where the sixth destination was, a phantom
 * selection, a mark that lies about a count. Each of those is a test here.
 *
 * What Review *does* is not this file's subject and did not change: the queues,
 * the actions and the corrections are covered by `app.spec.ts` and
 * `setup.spec.ts`, which now reach the screen through Settings and are
 * otherwise untouched.
 */

import { expect, test, type Page } from '@playwright/test';
import { openReview } from './helpers.ts';

/** What the bar carries before a draft is finished, in order. */
const PRIMARY = ['Draft', 'Team', 'Trades', 'Players', 'Setup'] as const;

/** The words in the bar, read from the label's own text node. */
async function labels(page: Page): Promise<string[]> {
  await page.locator('.tabbar').waitFor({ state: 'attached' });
  return page.evaluate(() =>
    [...document.querySelectorAll('.tabbar button')].map((b) =>
      [...b.childNodes]
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent?.trim() ?? '')
        .join(''),
    ),
  );
}

/**
 * Answer the overview with a chosen amount of unresolved review work.
 *
 * The two queues are counted separately by the server and added together by the
 * app, so both are moved: a fixture that set one of them would not prove the
 * row is reading the sum. Everything else about the overview is the
 * deployment's own — this is the smallest possible lie to tell the app.
 */
async function withPending(page: Page, evidence: number, identity: number) {
  await page.route('**/api/overview', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      json: {
        ...body,
        pendingEvidence: evidence,
        pendingIdentity: identity,
        /*
         * The third queue, pinned to nothing.
         *
         * An unscored newsletter also marks Settings, and the seeded world
         * always has one — so a fixture that moved only the two review counts
         * would be asserting the dot against a number it did not control, and
         * "nothing waiting draws no mark" could never be true. This file is
         * about the review queues; the newsletter's own mark is asserted in
         * setup.spec.ts, where the work it leads to lives.
         */
        pendingNewsletters: 0,
      },
    });
  });
}

test.describe('the toolbar no longer carries Review', () => {
  test('has no Review destination, and the rest are unchanged', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('tab-draft')).toBeVisible();

    await expect(page.getByTestId('tab-review')).toHaveCount(0);
    expect(await labels(page)).toEqual([...PRIMARY]);
  });

  /**
   * Nothing moved in to take the slot.
   *
   * The failure this catches is not a wrong label — that is caught above — it
   * is the bar keeping the *space*: a sixth column with nothing in it, or a
   * pill stretched to the width it used to be. The bar is sized by its
   * contents, so a packed bar with no gap between neighbours is the whole
   * claim, and it is measured rather than asserted from a constant.
   */
  test('repacks around the gap rather than holding it open', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('tab-draft')).toBeVisible();

    const geometry = await page.evaluate(() => {
      const bar = document.querySelector('.tabbar')!;
      const style = getComputedStyle(bar);
      const chrome =
        Number.parseFloat(style.paddingLeft) +
        Number.parseFloat(style.paddingRight) +
        Number.parseFloat(style.borderLeftWidth) +
        Number.parseFloat(style.borderRightWidth);
      const box = bar.getBoundingClientRect();
      const buttons = [...bar.querySelectorAll('button')].map((b) => b.getBoundingClientRect());
      return {
        count: buttons.length,
        slack: Math.round(box.width - (buttons.reduce((sum, b) => sum + b.width, 0) + chrome)),
        biggestGap: Math.round(Math.max(...buttons.slice(1).map((b, i) => b.left - buttons[i]!.right))),
        centreOffset: Math.round(Math.abs(box.left + box.width / 2 - window.innerWidth / 2)),
        minWidth: Math.round(Math.min(...buttons.map((b) => b.width))),
        minHeight: Math.round(Math.min(...buttons.map((b) => b.height))),
      };
    });

    expect(geometry.count).toBe(PRIMARY.length);
    expect(geometry.slack, 'the pill is stretched rather than packed').toBeLessThanOrEqual(2);
    expect(geometry.biggestGap, 'an empty Review slot was left behind').toBeLessThanOrEqual(2);
    expect(geometry.centreOffset, 'the bar is no longer centred').toBeLessThanOrEqual(1);
    // The targets did not grow into the space either: still a fingertip each,
    // and the styling of the bar is the styling it had.
    expect(geometry.minWidth).toBeGreaterThanOrEqual(44);
    expect(geometry.minHeight).toBeGreaterThanOrEqual(44);
  });

  /**
   * The selection treatment is the one the toolbar pass settled on.
   *
   * Losing a destination is exactly the kind of change that comes with a
   * "while we are in here" restyle. The current destination is the accent
   * colour, a heavier word and a heavier stroke — no wash behind it, no pill
   * around it, no bloom — and `aria-current` carries it for anything listening.
   */
  test('draws the current destination the way it always did', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('tab-team').click();
    await expect(page.getByTestId('tab-team')).toHaveAttribute('aria-current', 'page');

    const drawn = await page.getByTestId('tab-team').evaluate((tab) => {
      const style = getComputedStyle(tab);
      return {
        weight: Number.parseInt(style.fontWeight, 10),
        background: style.backgroundColor,
        stroke: getComputedStyle(tab.querySelector('svg')!).strokeWidth,
        colour: style.color,
        siblingColour: getComputedStyle(
          document.querySelector('[data-testid="tab-players"]')!,
        ).color,
      };
    });
    expect(drawn.weight, 'the selected word is not heavier').toBeGreaterThanOrEqual(600);
    expect(drawn.background, 'a wash came back behind the selected destination').toMatch(
      /rgba\(0, 0, 0, 0\)|transparent/,
    );
    expect(Number.parseFloat(drawn.stroke), 'the selected glyph is not drawn harder').toBeGreaterThan(2);
    expect(drawn.colour, 'the selection is not its own colour').not.toBe(drawn.siblingColour);
  });
});

test.describe('the Review row in Settings', () => {
  test('is there, and leads to the queue', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('tab-setup').click();

    const row = page.getByTestId('setup-review');
    await expect(row).toBeVisible();
    await expect(row).toContainText('Review');
    // A real control with a real target, not a line of text with a handler.
    expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(row).toHaveRole('button');

    await row.click();
    await expect(page.getByTestId('setup-detail-review')).toBeVisible();
  });

  /**
   * The count is the app's own count, not a second opinion.
   *
   * The row and the mark on the destination both come from the overview, added
   * together in one place, which is what stops the bar saying three above a row
   * saying two. This reads the same endpoint the app read and asserts the row
   * agrees with it — including in whichever state this deployment happens to be
   * in, which is the point: it is the arithmetic being checked, not a fixture.
   */
  test('says how much is waiting, and agrees with the overview', async ({ page }) => {
    await page.goto('/');
    const pending = await page.evaluate(async () => {
      const res = await fetch('/api/overview');
      const body = (await res.json()) as { pendingEvidence: number; pendingIdentity: number };
      return body.pendingEvidence + body.pendingIdentity;
    });

    await page.getByTestId('tab-setup').click();
    const row = page.getByTestId('setup-review');
    if (pending === 0) {
      await expect(row).toContainText('Nothing waiting for you');
    } else {
      await expect(row).toContainText(`${pending} ${pending === 1 ? 'item needs' : 'items need'} attention`);
    }
  });

  test('counts one item as one item', async ({ page }) => {
    await withPending(page, 1, 0);
    await page.goto('/');
    await page.getByTestId('tab-setup').click();
    await expect(page.getByTestId('setup-review')).toContainText('1 item needs attention');
  });

  test('adds the two queues together', async ({ page }) => {
    await withPending(page, 2, 3);
    await page.goto('/');
    await page.getByTestId('tab-setup').click();
    await expect(page.getByTestId('setup-review')).toContainText('5 items need attention');
    await expect(page.getByTestId('setup-review')).toHaveAttribute('data-state', 'warn');
  });

  /**
   * Nothing waiting says so, and marks nothing.
   *
   * The expensive failure of an attention indicator is the one that is always
   * on: a dot that never clears teaches the reader to stop looking at it, and
   * then the one that matters is invisible too. Zero draws no mark on the
   * destination, and the destination's accessible name says nothing about
   * review either — a silent badge is still a badge.
   */
  test('draws no mark at all when there is nothing to do', async ({ page }) => {
    await withPending(page, 0, 0);
    await page.goto('/');

    await expect(page.getByTestId('review-attention')).toHaveCount(0);
    const label = await page.getByTestId('tab-setup').getAttribute('aria-label');
    expect(label ?? '').not.toMatch(/review/i);

    await page.getByTestId('tab-setup').click();
    const row = page.getByTestId('setup-review');
    await expect(row).toContainText('Nothing waiting for you');
    await expect(row).toHaveAttribute('data-state', 'ok');
    await expect(row).not.toContainText(/\d/);
  });

  /**
   * …and something waiting marks the destination, once.
   *
   * The mark is a dot rather than a numeral — the number is one tap away, in
   * words — and it is drawn `aria-hidden` with the count spelled out in the
   * destination's accessible name instead, so a screen reader is told exactly
   * once rather than reading a bare number and then a sentence about it.
   */
  test('marks Settings when there is, and announces it exactly once', async ({ page }) => {
    await withPending(page, 3, 0);
    await page.goto('/');

    const setup = page.getByTestId('tab-setup');
    const dot = setup.getByTestId('review-attention');
    await expect(dot).toBeVisible();
    await expect(dot).toHaveAttribute('aria-hidden', 'true');
    await expect(dot).toBeEmpty();
    await expect(setup).toHaveAttribute('aria-label', /^Setup — 3 items need review$/);
  });

  /**
   * The dot is the theme's accent in both themes, and reads against the pill.
   *
   * A mark this small is exactly the kind that gets a hardcoded colour, and a
   * hardcoded colour is a mark that disappears into the toolbar's own surface
   * in one of the two themes. It takes `--accent`, which is a different value in
   * each — so the check is that the mark moves when the theme does, and that it
   * is never the surface it is drawn on.
   */
  test('takes the theme’s accent, in light and in dark', async ({ page }) => {
    await withPending(page, 4, 0);
    await page.goto('/');
    await expect(page.getByTestId('review-attention')).toBeVisible();

    const read = async (theme: string) => {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      return page.evaluate(() => {
        const dot = document.querySelector('[data-testid="review-attention"]')!;
        const root = getComputedStyle(document.documentElement);
        return {
          drawn: getComputedStyle(dot).backgroundColor,
          token: root.getPropertyValue('--accent').trim(),
          surface: getComputedStyle(document.querySelector('.tabbar')!).backgroundColor,
        };
      });
    };

    const light = await read('light');
    const dark = await read('dark');
    await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));

    for (const [name, seen] of [
      ['light', light],
      ['dark', dark],
    ] as const) {
      expect(seen.drawn, `the ${name} dot is not painted`).not.toBe('rgba(0, 0, 0, 0)');
      expect(seen.drawn, `the ${name} dot vanished into the pill`).not.toBe(seen.surface);
    }
    expect(light.token, 'both themes were handed the same accent').not.toBe(dark.token);
    expect(light.drawn, 'the dot ignored the theme').not.toBe(dark.drawn);
  });

  /** View-only and work waiting are two facts, and both survive. */
  test('does not swallow the view-only mark, or get swallowed by it', async ({ page }) => {
    await withPending(page, 2, 0);
    await page.route('**/api/auth/status', async (route) => {
      await route.fulfill({ json: { unlocked: false, canUnlock: true } });
    });
    await page.goto('/');

    const setup = page.getByTestId('tab-setup');
    await expect(setup.getByTestId('review-attention')).toBeVisible();
    await expect(setup.getByTestId('view-only')).toBeVisible();
    await expect(setup).toHaveAttribute(
      'aria-label',
      'Setup — 2 items need review, view only, unlock to make changes',
    );

    // Two marks, side by side, inside the destination rather than stacked on
    // top of one another.
    const marks = await setup.evaluate((tab) => {
      const dot = tab.querySelector('[data-testid="review-attention"]')!.getBoundingClientRect();
      const lock = tab.querySelector('[data-testid="view-only"]')!.getBoundingClientRect();
      const box = tab.getBoundingClientRect();
      return {
        overlap: Math.min(dot.right, lock.right) - Math.max(dot.left, lock.left),
        inside: dot.left >= box.left && dot.right <= box.right && lock.left >= box.left && lock.right <= box.right,
      };
    });
    expect(marks.overlap, 'the two marks are drawn on top of each other').toBeLessThanOrEqual(0);
    expect(marks.inside, 'a mark escaped its destination').toBe(true);
  });
});

test.describe('the Review screen itself', () => {
  test('is the same screen, with its queues and its reference sheet', async ({ page }) => {
    await page.goto('/');
    await openReview(page);

    await expect(page.getByRole('button', { name: /^Evidence/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Wrong player\?/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Already applied/ })).toBeVisible();

    await page.getByTestId('scoring-key-open').click();
    await expect(page.getByTestId('scoring-key')).toBeVisible();
    await expect(page.getByTestId('scoring-key-body')).toContainText('Good news');
    await page.getByTestId('sheet-close').click();
    await expect(page.getByTestId('scoring-key')).toHaveCount(0);
  });

  /**
   * Back is Back: one step, to the list it was opened from.
   *
   * The same control and the same single step every other settings panel has.
   * What is checked besides the destination is that Settings came back to its
   * *root* rather than to some other panel, and that the browser's own history
   * is untouched — the app pushes no state, so Back here is a control and not a
   * page load.
   */
  test('goes back to Settings, one step, with no page load', async ({ page }) => {
    await page.goto('/');
    const history = await page.evaluate(() => window.history.length);

    await openReview(page);
    await expect(page.getByTestId('back-button')).toContainText('Setup');
    await page.getByTestId('back-button').click();

    await expect(page.getByTestId('setup-detail-review')).toHaveCount(0);
    await expect(page.getByTestId('setup-review')).toBeVisible();
    await expect(page.getByTestId('setup-step-sleeper')).toBeVisible();
    expect(await page.evaluate(() => window.history.length), 'a panel is not a page').toBe(history);
    expect(new URL(page.url()).pathname).toBe('/');
  });

  /**
   * No phantom selection while the queue is open.
   *
   * The old failure mode this guards against is a screen that belongs to no
   * destination: the bar goes dark, or worse, lights the destination the reader
   * was on before. Review belongs to Settings now, so Settings stays lit — one
   * destination current, and it is the one whose screen this is.
   */
  test('keeps Settings current, and only Settings', async ({ page }) => {
    await page.goto('/');
    await openReview(page);

    await expect(page.getByTestId('tab-setup')).toHaveAttribute('aria-current', 'page');
    expect(await page.locator('.tabbar button[aria-current="page"]').count()).toBe(1);
    // And the destination it was opened from is not still lit underneath.
    await expect(page.getByTestId('tab-draft')).not.toHaveAttribute('aria-current', 'page');
  });

  /**
   * Tapping Settings while the queue is open walks back out of it.
   *
   * The settings convention, applied to Review because Review is now one of
   * those panels: a retap is the same single step Back takes. It is navigation
   * and it undoes nothing — no queue item is decided, dismissed or reordered by
   * leaving the screen.
   */
  test('a retap of Settings closes the queue and decides nothing', async ({ page }) => {
    const queued = async () =>
      page.evaluate(async () => {
        const res = await fetch('/api/review/queue');
        const body = (await res.json()) as { evidence: unknown[]; identity: unknown[] };
        return body.evidence.length + body.identity.length;
      });

    await page.goto('/');
    await openReview(page);
    const before = await queued();

    await page.getByTestId('tab-setup').click();
    await expect(page.getByTestId('setup-detail-review')).toHaveCount(0);
    await expect(page.getByTestId('setup-review')).toBeVisible();

    // Leaving a screen is not a verdict: every item that was waiting is waiting.
    expect(await queued()).toBe(before);
  });

  /**
   * The deep links Review has are its own reads, and they still answer.
   *
   * This app has one URL. Every screen is reached by tapping, no screen pushes
   * a history entry, and `/` is the path throughout — so what "the Review route"
   * means here is the four endpoints the screen is built on, plus the SPA
   * fallback that lets any saved path open the app at all. Both are checked,
   * because both are what a saved link actually depends on.
   */
  test('opens from any saved path, and its own reads still answer', async ({ page }) => {
    for (const path of ['/review', '/settings/review']) {
      const response = await page.goto(path);
      expect(response!.status(), `${path} did not serve the app`).toBe(200);
      // The app booted rather than a 404 page: the bar is there, and Review is
      // still reachable from it in one step through Settings.
      await expect(page.getByTestId('tab-setup')).toBeVisible();
      await openReview(page);
      await expect(page.getByTestId('setup-detail-review')).toBeVisible();
    }

    for (const endpoint of ['/api/review/queue', '/api/review/applied']) {
      const res = await page.request.get(endpoint);
      expect(res.status(), `${endpoint} stopped answering`).toBe(200);
    }
  });
});
