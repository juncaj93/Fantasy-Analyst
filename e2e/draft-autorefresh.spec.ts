/**
 * The Draft board keeping up with Sleeper on its own.
 *
 * The bug this suite exists for was silent and total: the automatic loop was
 * armed by the manual refresh handler and by nothing else, so a board nobody
 * tapped never moved. Every assertion below is therefore about something the
 * user does *not* do — no tap, and the picks arrive anyway.
 *
 * Sleeper is driven from the test rather than from the network. The sync route
 * is what the controller reacts to, so owning it means owning the draft: a poll
 * can be made to find nothing, find a new pick, or fail, in whatever order the
 * scenario needs. The board request is passed through to the real server and
 * edited on the way back, which keeps the rendering honest — these are the app's
 * own cards, its own ranks, its own tier lines, with one player removed the way
 * a real pick removes one.
 *
 * Visibility is simulated rather than emulated. Playwright cannot background a
 * WebKit page, and `document.visibilityState` is read-only, so the page is given
 * a controllable one before any script runs. The same honest half-simulation
 * navigation.spec.ts uses for `navigator.standalone`.
 */

import { expect, test, type Page } from '@playwright/test';
import { pullToRefresh } from './helpers.ts';

/** The five-second cadence, plus room for a slow CI machine to get there. */
const POLL_WINDOW = 7_000;

interface DraftDouble {
  /** Every sync the app has made. */
  syncs(): number;
  /** Every board rebuild the app has asked for. */
  boards(): number;
  /** Advance the draft: the next poll finds a new pick. */
  advance(): void;
  /** Fail the next syncs until `heal()`. */
  breakSleeper(): void;
  heal(): void;
  /** Report the user on the clock from the next board onwards. */
  putOnClock(): void;
}

/**
 * A Sleeper whose draft this test controls, installed before the app loads.
 *
 * `pick` is the fingerprint: leaving it alone is a poll that finds nothing —
 * the overwhelmingly common case, and the one that must cost nothing — and
 * bumping it is a pick landing.
 */
async function installDraftDouble(page: Page): Promise<DraftDouble> {
  let pick = 53;
  let syncs = 0;
  let boards = 0;
  let broken = false;
  let onClock = false;

  await page.route('**/api/drafts/*/sync', async (route) => {
    syncs++;
    if (broken) {
      await route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Sleeper did not respond' }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'drafting',
        picks: pick,
        lastPickNo: pick,
        fingerprint: `demo-draft:drafting:${pick}:deadbeef`,
        pollIntervalSeconds: 5,
      }),
    });
  });

  await page.route('**/api/drafts/*/board*', async (route) => {
    boards++;
    try {
      const response = await route.fetch();
      const body = (await response.json()) as {
        recommendations: { playerId: string; name: string }[];
        currentPick: number;
        onTheClock: boolean;
        picksUntilMyTurn: number | null;
      };
      /*
       * One player gone per pick, exactly like a real draft.
       *
       * Drafted players are dropped from the *top* of the ranked list, which is
       * the case that matters: it is the row the reader is looking at, and its
       * removal is what moves everything below it.
       */
      const drafted = Math.max(0, pick - 53);
      body.recommendations = body.recommendations.slice(drafted);
      body.currentPick += drafted;
      body.onTheClock = onClock;
      body.picksUntilMyTurn = onClock ? 0 : 3;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    } catch {
      /*
       * The reader left Draft while this request was still out.
       *
       * That is the behaviour under test, not a fault: unmounting the screen
       * cancels its in-flight board request, and a cancelled request has no
       * response left for this handler to rewrite. It is counted — the count is
       * what several assertions read — and then dropped, because there is
       * nobody on the other end to answer.
       */
      await route.abort().catch(() => {});
    }
  });

  return {
    syncs: () => syncs,
    boards: () => boards,
    advance: () => {
      pick++;
    },
    breakSleeper: () => {
      broken = true;
    },
    heal: () => {
      broken = false;
    },
    putOnClock: () => {
      onClock = true;
    },
  };
}

/** A page whose visibility the test owns. */
async function withControllableVisibility(page: Page) {
  await page.addInitScript(() => {
    let hidden = false;
    Object.defineProperty(document, 'visibilityState', {
      get: () => (hidden ? 'hidden' : 'visible'),
      configurable: true,
    });
    Object.defineProperty(document, 'hidden', { get: () => hidden, configurable: true });
    (window as unknown as { __setHidden: (v: boolean) => void }).__setHidden = (v: boolean) => {
      hidden = v;
      document.dispatchEvent(new Event('visibilitychange'));
    };
  });
}

const setHidden = (page: Page, hidden: boolean) =>
  page.evaluate((v) => (window as unknown as { __setHidden: (h: boolean) => void }).__setHidden(v), hidden);

/** What the refresh loop says about itself. See draftRefresh.ts. */
const probe = (page: Page) =>
  page.evaluate(() => (window as unknown as { __draftRefresh?: () => Record<string, unknown> }).__draftRefresh?.());

async function openDraft(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('board-list')).toBeVisible();
}

test.describe('draft auto-refresh', () => {
  /**
   * The whole bug, in one assertion.
   *
   * Nothing is tapped. The board is expected to be current on arrival, to check
   * again by itself, and to pick up a pick that lands while the reader is just
   * sitting there reading.
   */
  test('picks appear without anybody tapping refresh', async ({ page }) => {
    const sleeper = await installDraftDouble(page);
    await openDraft(page);

    // Arriving on Draft syncs immediately rather than waiting out a cadence.
    await expect.poll(() => sleeper.syncs(), { timeout: 5_000 }).toBeGreaterThanOrEqual(1);
    const firstPlayer = await page.getByTestId('recommendation-row').first().innerText();

    // A quiet poll: it checks, finds nothing, and leaves the screen alone.
    const boardsAfterArrival = sleeper.boards();
    await expect.poll(() => sleeper.syncs(), { timeout: POLL_WINDOW }).toBeGreaterThanOrEqual(2);
    expect(sleeper.boards(), 'an unchanged poll rebuilds nothing').toBe(boardsAfterArrival);
    expect(await page.getByTestId('recommendation-row').first().innerText()).toBe(firstPlayer);

    // Now somebody drafts. No tap; the board is expected to notice.
    sleeper.advance();
    await expect
      .poll(async () => page.getByTestId('recommendation-row').first().innerText(), { timeout: POLL_WINDOW })
      .not.toBe(firstPlayer);
    expect(sleeper.boards(), 'and only then does it rebuild').toBeGreaterThan(boardsAfterArrival);
  });

  /**
   * A poll that finds nothing must be invisible.
   *
   * Twelve times a minute, for the length of a draft. If any of it flashed, or
   * reset a filter, or scrolled, the feature would be worse than the bug.
   */
  test('an unchanged poll disturbs nothing the reader set up', async ({ page }) => {
    const sleeper = await installDraftDouble(page);
    await openDraft(page);

    // The filter first: unfolding the search is what makes the chips step
    // aside, so this is also the order a reader has to use.
    await page.getByRole('button', { name: 'QB', exact: true }).click();
    await expect(page.getByTestId('recommendation-row').first()).toBeVisible();
    await page.getByTestId('draft-search-open').click();
    await page.getByTestId('draft-search').fill('a');
    await expect(page.getByTestId('recommendation-row').first()).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 200));
    await page.waitForTimeout(150);

    const before = {
      query: await page.getByTestId('draft-search').inputValue(),
      rows: await page.getByTestId('recommendation-row').allInnerTexts(),
      scroll: await page.evaluate(() => Math.round(window.scrollY)),
      syncs: sleeper.syncs(),
    };

    await expect.poll(() => sleeper.syncs(), { timeout: POLL_WINDOW }).toBeGreaterThan(before.syncs);

    expect(await page.getByTestId('draft-search').inputValue(), 'the search survives').toBe(before.query);
    expect(await page.getByTestId('recommendation-row').allInnerTexts(), 'the filter survives').toEqual(before.rows);
    expect(await page.evaluate(() => Math.round(window.scrollY)), 'the scroll survives').toBe(before.scroll);
    // No skeleton, and no error banner, at any point in a routine poll.
    await expect(page.getByTestId('draft-skeleton')).toHaveCount(0);
    await expect(page.getByTestId('draft-sync-stale')).toHaveCount(0);
  });

  /** A pick that lands must not throw away the reader's place either. */
  test('a changed poll keeps the filter, the search and the scroll', async ({ page }) => {
    const sleeper = await installDraftDouble(page);
    await openDraft(page);
    await page.getByRole('button', { name: 'ALL', exact: true }).click();
    await page.evaluate(() => window.scrollTo(0, 250));
    await page.waitForTimeout(150);

    const scrollBefore = await page.evaluate(() => Math.round(window.scrollY));
    const boards = sleeper.boards();
    sleeper.advance();
    await expect.poll(() => sleeper.boards(), { timeout: POLL_WINDOW }).toBeGreaterThan(boards);

    await expect(page.getByRole('button', { name: 'ALL', exact: true })).toHaveAttribute('aria-pressed', 'true');
    // Not pinned to the pixel — a row above the viewport really did disappear —
    // but emphatically not thrown back to the top of the board.
    expect(await page.evaluate(() => Math.round(window.scrollY)), 'no jump to the top').toBeGreaterThan(
      scrollBefore / 2,
    );
  });

  test('tightens the cadence on the user’s turn', async ({ page }) => {
    const sleeper = await installDraftDouble(page);
    await openDraft(page);
    await expect.poll(async () => (await probe(page))?.['cadenceMs'], { timeout: POLL_WINDOW }).toBe(5000);

    sleeper.putOnClock();
    sleeper.advance();
    await expect.poll(async () => (await probe(page))?.['onClock'], { timeout: POLL_WINDOW }).toBe(true);
    await expect
      .poll(async () => (await probe(page))?.['cadenceMs'], { timeout: POLL_WINDOW })
      .toBe(2500);
  });

  test('stops polling in the background and catches up on resume', async ({ page }) => {
    await withControllableVisibility(page);
    const sleeper = await installDraftDouble(page);
    await openDraft(page);
    await expect.poll(() => sleeper.syncs(), { timeout: 5_000 }).toBeGreaterThanOrEqual(1);

    await setHidden(page, true);
    const parked = sleeper.syncs();
    // Two full cadences' worth of nothing.
    await page.waitForTimeout(POLL_WINDOW + 4_000);
    expect(sleeper.syncs(), 'a backgrounded app asks Sleeper nothing').toBe(parked);

    // The draft moved on while the app was away.
    const firstPlayer = await page.getByTestId('recommendation-row').first().innerText();
    sleeper.advance();
    sleeper.advance();

    await setHidden(page, false);
    // Immediately — not after the next five-second tick.
    await expect
      .poll(async () => page.getByTestId('recommendation-row').first().innerText(), { timeout: 3_000 })
      .not.toBe(firstPlayer);
  });

  test('stops polling once the reader leaves Draft, and syncs again on return', async ({ page }) => {
    const sleeper = await installDraftDouble(page);
    await openDraft(page);
    await expect.poll(() => sleeper.syncs(), { timeout: 5_000 }).toBeGreaterThanOrEqual(1);

    await page.getByTestId('tab-team').click();
    await expect(page.getByTestId('tab-team')).toHaveAttribute('aria-current', 'page');
    const parked = sleeper.syncs();
    await page.waitForTimeout(POLL_WINDOW + 3_000);
    expect(sleeper.syncs(), 'Draft does not poll from the Team screen').toBe(parked);
    // And it left nothing running behind it.
    expect(await probe(page), 'the probe goes with the screen').toBeFalsy();

    await page.getByTestId('tab-draft').click();
    await expect.poll(() => sleeper.syncs(), { timeout: 3_000 }).toBeGreaterThan(parked);
  });

  test('keeps the last good board when Sleeper stops answering, then catches up', async ({ page }) => {
    const sleeper = await installDraftDouble(page);
    await openDraft(page);
    const rows = await page.getByTestId('recommendation-row').count();
    expect(rows).toBeGreaterThan(0);

    sleeper.breakSleeper();
    // Two failures: the first is a tunnel, the second is a fault worth saying.
    await expect(page.getByTestId('draft-sync-stale')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('draft-sync-stale')).toContainText('Draft sync delayed');
    expect(await page.getByTestId('recommendation-row').count(), 'the board is not replaced by an error').toBe(rows);
    await expect(page.locator('.notice-error')).toHaveCount(0);

    sleeper.advance();
    sleeper.heal();
    await expect(page.getByTestId('draft-sync-stale')).toHaveCount(0, { timeout: 40_000 });
    await expect.poll(async () => (await probe(page))?.['cadenceMs'], { timeout: 10_000 }).toBe(5000);
    expect(await page.getByTestId('recommendation-row').count(), 'and it caught up').toBeLessThan(rows);
  });

  test('a manual tap never races the automatic poll', async ({ page }) => {
    const sleeper = await installDraftDouble(page);
    await openDraft(page);
    await expect.poll(() => sleeper.syncs(), { timeout: 5_000 }).toBeGreaterThanOrEqual(1);

    const before = sleeper.syncs();
    // Pulls now, not taps: the glyph is gone and the gesture reloads the board.
    // The single-flight guard it inherits is what this test is about.
    await pullToRefresh(page, 'draft-pull');
    await pullToRefresh(page, 'draft-pull');
    await pullToRefresh(page, 'draft-pull');

    // Three pulls, and the cadence running underneath: at most one request each
    // and never two at once.
    await expect.poll(async () => (await probe(page))?.['inFlight'], { timeout: 10_000 }).toBe(false);
    expect(sleeper.syncs() - before).toBeLessThanOrEqual(3);
    await expect(page.getByTestId('recommendation-row').first()).toBeVisible();
  });

  test('retires when the draft finishes', async ({ page }) => {
    let syncs = 0;
    await page.route('**/api/drafts/*/sync', async (route) => {
      syncs++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'complete',
          picks: 180,
          lastPickNo: 180,
          fingerprint: 'demo-draft:complete:180:cafe',
          pollIntervalSeconds: 0,
        }),
      });
    });
    await openDraft(page);
    await expect.poll(() => syncs, { timeout: 5_000 }).toBe(1);
    await expect.poll(async () => (await probe(page))?.['stopped'], { timeout: 5_000 }).toBe(true);

    await page.waitForTimeout(POLL_WINDOW + 3_000);
    expect(syncs, 'a finished draft is polled once and then left alone').toBe(1);
    // The manual way in is still there — a finished draft stops polling, it
    // does not stop being refreshable.
    await expect(page.getByTestId('draft-pull')).toBeVisible();
  });
});
