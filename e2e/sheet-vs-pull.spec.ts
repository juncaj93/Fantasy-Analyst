/**
 * Who owns a downward drag while a sheet is open.
 *
 * The defect this suite exists for was reported from a real iPhone and is
 * specific: on Trades and on Team, opening a player's sheet and swiping it down
 * did not dismiss it — the page underneath behaved as though *it* were being
 * pulled. On Players the same sheet, dragged the same way, worked.
 *
 * The cause was not a threshold and was not the sheet. React's portals move a
 * layer's *elements* to the end of the document but leave its *events*
 * propagating up the component tree, and every screen with pull-to-refresh
 * renders its sheets inside the wrapper that gesture is attached to. So a
 * finger on an open sheet was arriving at `usePullToRefresh` as if it had
 * landed on the list behind it, and two gestures were reading one drag. Players
 * was the control only by accident: it is the one screen with no
 * pull-to-refresh for a sheet's events to reach.
 *
 * What is checked here, and what is deliberately not:
 *
 *  - **Checked.** That no pull surface anywhere takes any part of a gesture
 *    that begins on an open sheet — no state, no movement, no request — on
 *    Trades, on Team and on Players alike; that the sheet dismisses; and that
 *    the screen pulls again the moment the sheet is gone, by both routes out of
 *    it. The arbitration itself is engine-independent and is what broke.
 *
 *  - **Not checked, and cannot be.** Whether iOS Safari hands the gesture to
 *    the sheet. The sheet swipes below are dispatched touch events with
 *    touch-typed pointer events beside them (see `touchDrag`), which reach
 *    both the sheet and the pull surface the way a finger's would, but do not
 *    exercise the browser's own arbitration. **Automated WebKit does not prove
 *    real-finger arbitration**, and the phone check is not optional.
 */

import { expect, test, type Page } from '@playwright/test';
import { inSeason, stubRefreshJob, swipeSheetAway } from './helpers.ts';

/**
 * What every pull surface on the page did while something else was happening.
 *
 * Recorded as it happens rather than read at the end, because a pull that loses
 * is still a pull that started: the surface arms, translates, and springs back
 * when the finger goes, leaving nothing behind to assert on. The two readings
 * are the two ways it shows: the state the indicator paints, and how far the
 * content was actually moved.
 *
 * ## Why this watches mutations and does not only sample frames
 *
 * It used to be a bare `requestAnimationFrame` loop, and on 16 September 2026
 * that cost a release: `webkit-iphone-430 (3/3)` failed `and pulls again after
 * the sheet is closed by its Done control` four times running on main, with
 * `the surface never took the gesture` — while the identical tree had passed
 * the same shard on the pull request minutes earlier.
 *
 * Nothing was wrong with the app. A loaded runner starves frames, the whole
 * gesture lands between two of them, and a sampler that only looks on a frame
 * sees `idle`, `idle`, `idle`. {@link expectPulled} already carries the note
 * from the *last* time this bit — "a sampler cannot depend on catching it, and
 * a test that does is asserting the frame rate" — and that reasoning applies to
 * the sampler itself, not only to which state it looked for.
 *
 * A `MutationObserver` is not sampled. Every write to `data-pull-state`, and
 * every write to the content's inline transform, is delivered whatever the
 * frame rate is doing. The frame loop is kept beside it because the two see
 * different things — a transform driven by a stylesheet animation never writes
 * the attribute the observer watches — and the readings are unioned, so this is
 * strictly more sensitive than what it replaces and cannot pass anything the
 * old one would have failed.
 */
async function watchPulls(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store: { states: string[]; maxShift: number; running: boolean } = {
      states: [],
      maxShift: 0,
      running: true,
    };
    (window as unknown as { __pulls: typeof store }).__pulls = store;

    /** One reading of one surface, from whichever source noticed it. */
    const record = (surface: HTMLElement): void => {
      const state = surface.dataset['pullState'];
      if (state && !store.states.includes(state)) store.states.push(state);
      const content = surface.querySelector<HTMLElement>('.pull-content');
      const transform = content ? getComputedStyle(content).transform : 'none';
      if (transform !== 'none') {
        // m42 is the vertical translation, whatever else the matrix carries.
        const shift = new DOMMatrixReadOnly(transform).m42;
        if (shift > store.maxShift) store.maxShift = shift;
      }
    };

    const readAll = () => {
      for (const surface of document.querySelectorAll<HTMLElement>('.pull-surface')) record(surface);
    };

    /*
     * Every attribute write, delivered rather than sampled.
     *
     * Watched on the document with `subtree`, so a surface mounted *after* this
     * is armed — a screen the test navigates to — is covered without a second
     * call. `attributeFilter` keeps it to the two attributes that carry a pull:
     * the state the surface paints and the inline transform the content is
     * moved by.
     */
    const observer = new MutationObserver((records) => {
      if (!store.running) return observer.disconnect();
      for (const record_ of records) {
        const target = record_.target as HTMLElement;
        const surface = target.closest<HTMLElement>('.pull-surface');
        if (surface) record(surface);
      }
    });
    observer.observe(document.documentElement, {
      subtree: true,
      attributes: true,
      attributeFilter: ['data-pull-state', 'style'],
    });

    const tick = () => {
      if (!store.running) return observer.disconnect();
      readAll();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function pullsSeen(page: Page): Promise<{ states: string[]; maxShift: number }> {
  return page.evaluate(() => {
    const store = (window as unknown as { __pulls: { states: string[]; maxShift: number; running: boolean } }).__pulls;
    store.running = false;
    return { states: store.states, maxShift: store.maxShift };
  });
}

/** Nothing under the sheet moved, armed, or asked the server for anything. */
function expectNothingPulled(seen: { states: string[]; maxShift: number }, requests: string[]): void {
  expect(seen.states.filter((s) => s !== 'idle'), 'a pull surface armed under an open sheet').toEqual([]);
  expect(seen.maxShift, 'the page under the sheet was stretched by the dismissal').toBe(0);
  expect(requests, 'the page under the sheet reloaded itself').toEqual([]);
}

/**
 * The mirror of it: the surface took this gesture and followed the finger.
 *
 * Deliberately *not* asserted as `armed`, which is what this first checked and
 * what WebKit then failed on. `armed` is the state between passing the trigger
 * and letting go, and it need never be painted at all: releasing sets the
 * distance and starts the refresh in one batch, so the surface can go from
 * `pulling` straight to `refreshing` between two frames. A sampler cannot
 * depend on catching it, and a test that does is asserting the frame rate.
 *
 * What is stable is that the surface left `idle` and actually moved. Whether
 * the refresh then *fired* is a question for the network, and every caller
 * asks it that way.
 */
function expectPulled(seen: { states: string[]; maxShift: number }): void {
  expect(seen.states.filter((s) => s !== 'idle'), 'the surface never took the gesture').not.toEqual([]);
  expect(seen.maxShift, 'the surface never followed the finger').toBeGreaterThan(0);
}

/**
 * Drag, in steps, the way a thumb does.
 *
 * The same shape `sheet-interaction.spec.ts` uses, for the same reason: a
 * single jump gives the hooks a distance without ever giving them a direction,
 * and direction is what both of these gestures decide on first.
 */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 14) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
  }
  await page.mouse.up();
}

/**
 * Pull a screen down from the one place the gesture is allowed to begin.
 *
 * The `scrollTo` is not decoration and is the same line `team-startsit.spec`
 * opens its own pull helper with. These are long screens, and a pull that
 * starts below the top is a scroll by rule 1 — so a test that pulled without
 * first putting the page back at its top fails whenever anything has moved it,
 * and fails intermittently, which is worse than failing.
 */
async function pullScreen(page: Page, testId: string): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, 0));
  const box = (await page.getByTestId(testId).boundingBox())!;
  const x = box.x + box.width / 2;
  await drag(page, { x, y: box.y + 40 }, { x, y: box.y + 240 });
}


/** Record every request the screen makes to its own endpoint, until read. */
function watchRequests(page: Page, endpoint: string): string[] {
  const seen: string[] = [];
  page.on('request', (r) => {
    // Not the Round 22 refresh status read, which shares `/api/refresh`'s prefix.
    if (r.url().includes(endpoint) && !r.url().includes('/api/refresh/status')) seen.push(r.url());
  });
  return seen;
}

/** Wait until an element has stopped moving — two frames in the same place. */
async function settled(page: Page, testId: string, tries = 20) {
  let previous = '';
  for (let i = 0; i < tries; i++) {
    const box = await page.getByTestId(testId).boundingBox();
    const here = box ? `${Math.round(box.x)},${Math.round(box.y)}` : '';
    if (here && here === previous) return;
    previous = here;
    await page.waitForTimeout(50);
  }
}

/**
 * Team, standing in the season rather than mid-draft.
 *
 * The demo league is permanently mid-draft, and the screen says so by drawing
 * the drafted roster and no lineup at all — so there is no starter to tap and
 * no weekly card to pull down. `inSeason` is the same shim `team-startsit.spec`
 * uses, and it has to be in place before the first navigation.
 */
async function openTeam(page: Page): Promise<void> {
  await inSeason(page);
  await page.goto('/');
  await page.getByTestId('tab-team').click();
  await expect(page.getByTestId('team-pull')).toBeVisible();
  await expect(page.getByTestId('starters-title')).toBeVisible();
}

test.describe('a sheet owns the gesture that dismisses it', () => {
  test('Team: pulling a player sheet down dismisses it and leaves the roster alone', async ({ page }) => {
    await openTeam(page);
    await page.locator('[data-testid="starter-row"][data-starter="true"]').first().click();
    await expect(page.getByTestId('weekly-sheet')).toBeVisible();
    await settled(page, 'sheet-grip');

    const requests = watchRequests(page, '/api/refresh');
    await watchPulls(page);
    await swipeSheetAway(page, { over: '.sheet-grip' });

    await expect(page.getByTestId('weekly-sheet')).toHaveCount(0);
    expectNothingPulled(await pullsSeen(page), requests);
  });

  /**
   * Players, the control, held to the same rule rather than to its own.
   *
   * It passed before this work and it passes after it, which is the point: the
   * repair was to the boundary every screen shares, not to the two that showed
   * the symptom. Players happens to have no pull surface at all, so the reading
   * below is vacuous here — and that is exactly what a shared rule looks like
   * on a screen with nothing to arbitrate.
   */
  test('Players: the known-good sheet behaves the same way, under the same rule', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('tab-players').click();
    const rows = page.getByTestId('player-search-row');
    await expect(rows.first()).toBeVisible();
    await rows.first().click();
    await expect(page.getByTestId('player-sheet')).toBeVisible();
    await settled(page, 'sheet-grip');

    const requests = watchRequests(page, '/api/players?');
    await watchPulls(page);
    await swipeSheetAway(page, { over: '.sheet-grip' });

    await expect(page.getByTestId('player-sheet')).toHaveCount(0);
    expectNothingPulled(await pullsSeen(page), requests);
  });

});

test.describe('and gives it straight back', () => {
  /**
   * Team's own gesture, on the screen as the demo league actually stands.
   *
   * Deliberately without `inSeason`, which every other Team test here needs and
   * this one does not: the pull surface wraps the whole screen in either
   * standing, and what is being proved is that the gesture still reaches the
   * server, not what the roster says.
   *
   * It also does not let the refresh reach the feeds, and that is not caution
   * about speed. Team's refresh is the all-source orchestrator: it syncs the
   * league, re-ingests injuries and usage and asks the odds provider for lines,
   * all of it written to the one database every project on this server shares.
   * Left real, it recorded a `not_published` injury run over the seeded `ok`
   * one — nflverse publishes no report for a season that has not started — and
   * `app.spec.ts`'s `shows no roster percentage, and says why in Setup`, which
   * asserts that seeded run, then failed at every width after this one. The
   * same trap is documented in `team-startsit.spec.ts`, where the response is
   * stubbed for the same reason; this test was the one place still firing it.
   *
   * Nothing about what is being proved changes. The request is still made by
   * the gesture and still counted at the network, which is the claim; only the
   * answer is canned. The orchestrator's own behaviour — dedupe, budget
   * refusal, partial failure — is covered against a real database in
   * `tests/startsit.refresh.test.ts`.
   *
   * `inSeason` stays off for a second reason: refreshing re-requests the
   * roster, which re-enters that helper's route handler, and the racing
   * response is disposed under it — `apiResponse.json: Response has been
   * disposed`, which fails the test from inside the interceptor and says
   * nothing about the gesture.
   */
  test('Team still pulls to refresh when no sheet is open', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('tab-team').click();
    await expect(page.getByTestId('team-pull')).toBeVisible();
    await stubRefreshJob(page);
    const requests = watchRequests(page, '/api/refresh');
    await watchPulls(page);
    await pullScreen(page, 'team-pull');

    expectPulled(await pullsSeen(page));
    // Team's refresh is a POST, which is why the sheet tests above watch it to
    // prove it did *not* happen. Here it is the proof that it did.
    await expect.poll(async () => requests.length, {
      message: 'the pull never reached the server on Team',
    }).toBeGreaterThan(0);
  });
});

/**
 * The same arbitration, driven by pointers that say they are touches.
 *
 * A dispatched `TouchEvent` generates no pointer event in any engine, so
 * `touchDrag` sends touch-typed pointer events beside its touches: the type a
 * physical iPhone sends, and the one the pull surface listens for. Started on
 * the card's content, which is where a pull and a dismissal look most alike.
 *
 * So this proves the app's own arbitration under touch-typed input, and
 * nothing about the browser's. The physical-iPhone retest remains the only
 * evidence for that.
 */
test.describe('under touch-typed pointers', () => {
});
