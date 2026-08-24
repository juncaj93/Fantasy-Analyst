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
 *    the sheet. Every drag below is synthesised from pointer events, which are
 *    not touches: a dispatched `touchmove` produces no pointer event in any
 *    engine, so no synthetic sequence exercises `touch-action` or the browser's
 *    own arbitration. The last test in this file uses a pointer sequence typed
 *    as `touch` — which is a different code path through the app, and still not
 *    a finger. **Automated WebKit does not prove real-finger arbitration**, and
 *    the physical-iPhone retest in the handoff is not optional.
 */

import { expect, test, type Page } from '@playwright/test';
import { inSeason } from './helpers.ts';

/**
 * What every pull surface on the page did while something else was happening.
 *
 * Sampled every frame rather than read at the end, because a pull that loses is
 * still a pull that started: the surface arms, translates, and springs back
 * when the finger goes, leaving nothing behind to assert on. The two readings
 * are the two ways it shows: the state the indicator paints, and how far the
 * content was actually moved.
 */
async function watchPulls(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store: { states: string[]; maxShift: number; running: boolean } = {
      states: [],
      maxShift: 0,
      running: true,
    };
    (window as unknown as { __pulls: typeof store }).__pulls = store;

    const tick = () => {
      if (!store.running) return;
      for (const surface of document.querySelectorAll<HTMLElement>('.pull-surface')) {
        const state = surface.dataset['pullState'];
        if (state && !store.states.includes(state)) store.states.push(state);
        const content = surface.querySelector<HTMLElement>('.pull-content');
        const transform = content ? getComputedStyle(content).transform : 'none';
        if (transform !== 'none') {
          // m42 is the vertical translation, whatever else the matrix carries.
          const shift = new DOMMatrixReadOnly(transform).m42;
          if (shift > store.maxShift) store.maxShift = shift;
        }
      }
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

/** Where a drag on a sheet's *content* — not its grip, not its header — starts. */
async function contentGrip(page: Page, sheet: string): Promise<{ x: number; y: number }> {
  const body = (await page.locator(`[data-testid="${sheet}"] .sheet-body`).boundingBox())!;
  return { x: body.x + body.width / 2, y: body.y + 24 };
}

/** Record every request the screen makes to its own endpoint, until read. */
function watchRequests(page: Page, endpoint: string): string[] {
  const seen: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes(endpoint)) seen.push(r.url());
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

async function openTrades(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('tab-trades').click();
  await expect(page.getByTestId('trades-pull')).toBeVisible();
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
  /**
   * The reported defect, on the screen it was reported from.
   *
   * Both halves of this fail without the fix, and the first one is the surprise:
   * the sheet does not dismiss even in a headless engine. The pull surface
   * engages on the same drag and calls `setPointerCapture` on itself, which
   * takes the pointer stream away from the sheet mid-gesture — so the reader's
   * dismissal is not merely competed with, it is confiscated. That is the
   * physical-iPhone symptom exactly: a sheet that will not be swiped away.
   */
  test('Trades: pulling a player sheet down dismisses it and leaves the board alone', async ({ page }) => {
    await openTrades(page);
    await page.getByTestId('trade-row').first().click();
    await expect(page.getByTestId('player-sheet')).toBeVisible();
    await settled(page, 'sheet-grip');

    const requests = watchRequests(page, '/api/trades');
    await watchPulls(page);
    const from = await contentGrip(page, 'player-sheet');
    await drag(page, from, { x: from.x, y: from.y + 420 });

    await expect(page.getByTestId('player-sheet')).toHaveCount(0);
    expectNothingPulled(await pullsSeen(page), requests);
  });

  test('Team: pulling a player sheet down dismisses it and leaves the roster alone', async ({ page }) => {
    await openTeam(page);
    await page.locator('[data-testid="starter-row"][data-starter="true"]').first().click();
    await expect(page.getByTestId('weekly-sheet')).toBeVisible();
    await settled(page, 'sheet-grip');

    const requests = watchRequests(page, '/api/startsit/refresh');
    await watchPulls(page);
    const from = await contentGrip(page, 'weekly-sheet');
    await drag(page, from, { x: from.x, y: from.y + 420 });

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
    const from = await contentGrip(page, 'player-sheet');
    await drag(page, from, { x: from.x, y: from.y + 420 });

    await expect(page.getByTestId('player-sheet')).toHaveCount(0);
    expectNothingPulled(await pullsSeen(page), requests);
  });

  /**
   * A sheet scrolled away from its top still hands the drag to its content.
   *
   * The half of the contract the fix must not have bought: suspending the page
   * behind says nothing about who wins *inside* the sheet, and a card that
   * cannot be read is a worse defect than one that cannot be flicked away.
   */
  test('content that is not at its top keeps the drag, and still nothing pulls', async ({ page }) => {
    await openTrades(page);
    await page.getByTestId('trade-row').first().click();
    await expect(page.getByTestId('player-sheet')).toBeVisible();
    await settled(page, 'sheet-grip');

    await page.evaluate(() => {
      const body = document.querySelector('.sheet-body') as HTMLElement;
      body.style.maxHeight = '160px';
      body.scrollTop = 60;
    });
    await expect
      .poll(async () => page.evaluate(() => (document.querySelector('.sheet-body') as HTMLElement).scrollTop))
      .toBeGreaterThan(0);

    const requests = watchRequests(page, '/api/trades');
    await watchPulls(page);
    const from = await contentGrip(page, 'player-sheet');
    await drag(page, from, { x: from.x, y: from.y + 420 });

    await expect(page.getByTestId('player-sheet')).toBeVisible();
    expectNothingPulled(await pullsSeen(page), requests);
  });

  /** A sideways swipe is not a dismissal and is not a pull either. */
  test('a sideways swipe across an open sheet moves neither', async ({ page }) => {
    await openTrades(page);
    await page.getByTestId('trade-row').first().click();
    await expect(page.getByTestId('player-sheet')).toBeVisible();
    await settled(page, 'sheet-grip');

    const box = (await page.getByTestId('player-sheet').boundingBox())!;
    const requests = watchRequests(page, '/api/trades');
    await watchPulls(page);
    await drag(page, { x: box.x + 24, y: box.y + 140 }, { x: box.x + box.width - 24, y: box.y + 160 });

    await expect(page.getByTestId('player-sheet')).toBeVisible();
    expectNothingPulled(await pullsSeen(page), requests);
  });
});

test.describe('and gives it straight back', () => {
  /**
   * The gesture this whole screen relies on, with nothing open.
   *
   * The control for everything above it: a pull-to-refresh that never works
   * cannot compete with anything, so without this every "nothing pulled"
   * assertion in the suite would pass for the wrong reason.
   */
  test('Trades still pulls to refresh when no sheet is open', async ({ page }) => {
    await openTrades(page);
    const requests = watchRequests(page, '/api/trades');
    await watchPulls(page);

    const box = (await page.getByTestId('trades-pull').boundingBox())!;
    const x = box.x + box.width / 2;
    await drag(page, { x, y: box.y + 40 }, { x, y: box.y + 240 });

    const seen = await pullsSeen(page);
    expect(seen.states, 'the pull never armed on a screen with nothing over it').toContain('armed');
    expect(seen.maxShift, 'the surface never followed the finger').toBeGreaterThan(0);
    await expect.poll(async () => requests.length).toBeGreaterThan(0);
  });

  test('and pulls again the moment the sheet is dismissed by gesture', async ({ page }) => {
    await openTrades(page);
    await page.getByTestId('trade-row').first().click();
    await expect(page.getByTestId('player-sheet')).toBeVisible();
    await settled(page, 'sheet-grip');
    const from = await contentGrip(page, 'player-sheet');
    await drag(page, from, { x: from.x, y: from.y + 420 });
    await expect(page.getByTestId('player-sheet')).toHaveCount(0);

    const requests = watchRequests(page, '/api/trades');
    await watchPulls(page);
    const box = (await page.getByTestId('trades-pull').boundingBox())!;
    const x = box.x + box.width / 2;
    await drag(page, { x, y: box.y + 40 }, { x, y: box.y + 240 });

    const seen = await pullsSeen(page);
    expect(seen.states, 'the gesture never came back after a sheet was swiped away').toContain('armed');
    await expect.poll(async () => requests.length).toBeGreaterThan(0);
  });

  /**
   * And by the other way out, which is a different unmount path.
   *
   * A suspension that is released by the gesture but not by the button would be
   * a screen the reader can permanently disable by tapping Done — the
   * stuck-disabled state this arbitration must not be able to reach.
   */
  test('and pulls again after the sheet is closed by its Done control', async ({ page }) => {
    await openTrades(page);
    await page.getByTestId('trade-row').first().click();
    await expect(page.getByTestId('player-sheet')).toBeVisible();
    await page.getByTestId('sheet-close').click();
    await expect(page.getByTestId('player-sheet')).toHaveCount(0);

    const requests = watchRequests(page, '/api/trades');
    await watchPulls(page);
    const box = (await page.getByTestId('trades-pull').boundingBox())!;
    const x = box.x + box.width / 2;
    await drag(page, { x, y: box.y + 40 }, { x, y: box.y + 240 });

    const seen = await pullsSeen(page);
    expect(seen.states, 'closing a sheet with Done left the screen unpullable').toContain('armed');
    await expect.poll(async () => requests.length).toBeGreaterThan(0);
  });

  test('Team still pulls to refresh when no sheet is open', async ({ page }) => {
    await openTeam(page);
    await watchPulls(page);
    const box = (await page.getByTestId('team-pull').boundingBox())!;
    const x = box.x + box.width / 2;
    await drag(page, { x, y: box.y + 40 }, { x, y: box.y + 240 });
    const seen = await pullsSeen(page);
    expect(seen.states).toContain('armed');
    expect(seen.maxShift).toBeGreaterThan(0);
  });
});

/**
 * The same arbitration, driven by pointers that say they are touches.
 *
 * Distinct from every drag above, which Playwright's mouse produces as
 * `pointerType: 'mouse'` — a type both hooks branch on, and the type a physical
 * iPhone never sends. These are dispatched directly so the pointer type can be
 * set, which is the only part of a touch that can be synthesised at all: a
 * dispatched `TouchEvent` generates no pointer event in any engine, so a real
 * touch sequence cannot reach these handlers from a test.
 *
 * So this proves the app's own arbitration under touch-typed input, and
 * nothing about the browser's. The physical-iPhone retest remains the only
 * evidence for that.
 */
test.describe('under touch-typed pointers', () => {
  test('a sheet dismissal never reaches the page behind it', async ({ page }) => {
    await openTrades(page);
    await page.getByTestId('trade-row').first().click();
    await expect(page.getByTestId('player-sheet')).toBeVisible();
    await settled(page, 'sheet-grip');

    const requests = watchRequests(page, '/api/trades');
    await watchPulls(page);
    const from = await contentGrip(page, 'player-sheet');

    await page.evaluate(({ x, y }) => {
      const target = document.elementFromPoint(x, y);
      if (!target) throw new Error('nothing under the point the drag starts at');
      const fire = (type: string, clientY: number, buttons: number) =>
        target.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            pointerId: 1,
            pointerType: 'touch',
            isPrimary: true,
            button: type === 'pointermove' ? -1 : 0,
            buttons,
            clientX: x,
            clientY,
          }),
        );
      fire('pointerdown', y, 1);
      for (let step = 20; step <= 420; step += 20) fire('pointermove', y + step, 1);
      fire('pointerup', y + 420, 0);
    }, from);

    await expect(page.getByTestId('player-sheet')).toHaveCount(0);
    expectNothingPulled(await pullsSeen(page), requests);
  });
});
