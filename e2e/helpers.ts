/**
 * Shared e2e helpers.
 *
 * Kept separate from `constants.ts`, which the Playwright config imports and
 * which therefore may not pull in `@playwright/test`.
 */

import type { Page } from '@playwright/test';

/**
 * Answer the roster as the app sees it once a draft is over.
 *
 * The demo league is permanently mid-draft, which is the right fixture for most
 * of what this suite checks — but the Team pass deliberately withholds a set of
 * controls *during* a draft. Balanced, Floor and Ceiling are three definitions
 * of the best lineup and Compare asks which of two players to start; neither
 * question exists while half the roster is unpicked, so neither control is
 * drawn until the draft ends. See the note on `team-controls` in `TeamScreen`.
 *
 * Any spec that needs those controls has to say which season it is standing in,
 * and this is how it says so. `live` is the one field that decides which of the
 * two Team screens is showing, so it is the only thing overridden; every number
 * underneath is the deployment's own.
 *
 * Call it *before* navigating to Team — a route installed after the request has
 * gone out changes nothing.
 */
export async function inSeason(page: Page): Promise<void> {
  await page.route('**/api/leagues/*/roster', async (route) => {
    try {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ response, body: JSON.stringify({ ...body, live: false, drafted: [] }) });
    } catch (error) {
      /*
       * A reply nobody is waiting for any more is not a failure.
       *
       * The refresh on Team re-reads the roster, and the specs that press it end
       * the moment the screen is readable, which can be while that re-read is
       * still in flight. The page then closes under this handler, Playwright
       * disposes the response it was holding, and `response.json()` throws
       * "Response has been disposed" into a test that had already passed its
       * assertions. It failed `refreshes from the button` at 360 on 2 October,
       * on both attempts, and nowhere else.
       *
       * Only that one cause is let through. Anything else, such as a body that
       * is not JSON, still throws, because that one is about the app.
       */
      if (!/disposed|has been closed|Target (page|closed)|Test ended/i.test(String(error))) throw error;
    }
  });
}

/**
 * Open the Trades market inventory.
 *
 * The buy/sell/hold board is folded away behind `Explore the market` and its
 * rows are not rendered while it is shut, so any spec that reads a `trade-row`
 * has to ask for them first. One helper rather than a line in each spec,
 * because the affordance is a product decision and a suite that spelled it out
 * thirty times would be thirty places to edit when it changes.
 *
 * Idempotent: a fold that is already open is left alone, so a spec may call it
 * without knowing what the one before it did.
 */
export async function exploreMarket(page: Page): Promise<void> {
  const toggle = page.getByTestId('market-fold-toggle');
  await toggle.waitFor();
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await page.getByTestId('market-fold-body').waitFor();
}

/**
 * The three groups Settings is divided into, as their folds are named.
 *
 * `data` is sources, imports, Review, Help my scores and Data health;
 * `behavior` is the draft board weighting, Install and Demo Mode; `support` is
 * the snapshot and the context it is captured for. See `SettingsGroup` in
 * `SetupScreen` for why each row is where it is.
 */
export type SettingsGroup = 'data' | 'behavior' | 'support';

/**
 * Open Settings, and the group holding the row a spec is about.
 *
 * **Every group is shut on load and its rows are not rendered while it is** —
 * `Fold` does not draw its children when closed — so any spec that reads a
 * Settings row has to ask for its group first. One helper rather than three
 * lines in each of seventeen files, for the reason `exploreMarket` is one: the
 * arrangement is a product decision, and a suite that spelled it out everywhere
 * would be everywhere to edit when it changes again.
 *
 * Idempotent in both directions — a group that is already open is left alone,
 * and opening a second group does not shut the first — so a spec may call it
 * without knowing what the one before it did, and may call it twice for two
 * rows in different groups.
 */
export async function openSetupGroup(page: Page, group: SettingsGroup): Promise<void> {
  if ((await page.getByTestId(`setup-group-${group}`).count()) === 0) {
    await page.getByTestId('tab-setup').click();
  }
  const toggle = page.getByTestId(`setup-group-${group}-toggle`);
  await toggle.waitFor();
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await page.getByTestId(`setup-group-${group}-body`).waitFor();
}

/**
 * Open Review, which lives in Settings.
 *
 * It is not a destination on the toolbar and deliberately is not: it is
 * maintenance, reached from the Settings row that says how much of it is
 * waiting. One helper rather than two lines in every spec that needs the queue,
 * because where Review lives is a product decision and a suite that spelled it
 * out a dozen times would be a dozen places to edit when it moves again.
 */
export async function openReview(page: Page): Promise<void> {
  await page.getByTestId('tab-setup').click();
  await openSetupGroup(page, 'data');
  await page.getByTestId('setup-review').click();
  await page.getByTestId('setup-detail-review').waitFor();
}

/**
 * Wait long enough for a dismissal or a spring-back that was going to happen
 * to have happened.
 *
 * For the assertions that say a gesture did *nothing*: a dismissed sheet
 * animates off for `CLOSE_MS` before it unmounts, so `toBeVisible()` asserted
 * straight after a release is true whether the gesture fired or not. So this
 * waits past the exit, then until no card is still moving.
 */
export async function pastTheSettle(page: Page): Promise<void> {
  await page.waitForTimeout(400);
  await page
    .waitForFunction(() => !document.querySelector('.sheet.sheet-moving'), undefined, { timeout: 5_000 })
    .catch(() => {
      // eslint-disable-next-line no-console
      console.warn('[pastTheSettle] a sheet was still moving');
    });
}

/** What a synthetic touch drag did. */
export interface TouchDragResult {
  /** Whether the page claimed any of the moves (`preventDefault`), which is a sheet taking the drag. */
  claimed: boolean;
  /** The backdrop's opacity just before the finger lifted, or null with no sheet open. */
  scrimBeforeLift: number | null;
  /** The card's drawn offset just before the finger lifted, in px. */
  offsetBeforeLift: number | null;
}

/**
 * Drag a finger from a point, as a run of real-time touch events.
 *
 * **Why dispatched rather than driven.** Playwright can tap with a touchscreen
 * but cannot drag with one in WebKit, and a mouse is not a finger: the sheet
 * listens to touch events, because that is what iOS Safari lets an app claim.
 * So the events are built in the page — a `TouchEvent` where the engine can
 * construct one, an `Event` carrying the same fields where it cannot — and sent
 * to whatever is under the point, with real time between them so the release
 * speed is the one asked for. Each is preceded by the touch-typed pointer event
 * a phone sends with it, so the gestures that listen for pointers hear it too.
 *
 * `ms` is how long the movement takes; `hold` is how long the finger then rests
 * before lifting, which is what makes a slow release slow.
 */
export async function touchDrag(
  page: Page,
  at: { x: number; y: number },
  { dy, dx = 0, ms = 300, steps = 12, hold = 0 }: { dy: number; dx?: number; ms?: number; steps?: number; hold?: number },
): Promise<TouchDragResult> {
  return page.evaluate(
    async ({ x, y, dx, dy, ms, steps, hold }) => {
      const target = document.elementFromPoint(x, y) ?? document.body;
      const send = (type: string, cx: number, cy: number): boolean => {
        const lifted = type === 'touchend' || type === 'touchcancel';
        let event: Event;
        try {
          const touch = new Touch({ identifier: 1, target, clientX: cx, clientY: cy, pageX: cx, pageY: cy });
          const on = lifted ? [] : [touch];
          event = new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            touches: on,
            targetTouches: on,
            changedTouches: [touch],
          });
          // WebKit wants a `TouchList` and may build an empty one from an array.
          if ((event as TouchEvent).changedTouches.length !== 1) throw new Error('no touches');
        } catch {
          const touch = { identifier: 1, target, clientX: cx, clientY: cy, pageX: cx, pageY: cy };
          const on = lifted ? [] : [touch];
          event = new Event(type, { bubbles: true, cancelable: true, composed: true });
          Object.defineProperty(event, 'touches', { value: on });
          Object.defineProperty(event, 'targetTouches', { value: on });
          Object.defineProperty(event, 'changedTouches', { value: [touch] });
        }
        // A finger sends pointer events too, and the pull surface and the back
        // swipe listen for those: sent first, touch-typed, as a phone does.
        const pointer = { touchstart: 'pointerdown', touchmove: 'pointermove', touchend: 'pointerup', touchcancel: 'pointercancel' }[type]!;
        target.dispatchEvent(
          new PointerEvent(pointer, {
            bubbles: true,
            cancelable: true,
            composed: true,
            pointerId: 7,
            pointerType: 'touch',
            isPrimary: true,
            clientX: cx,
            clientY: cy,
            buttons: lifted ? 0 : 1,
          }),
        );
        target.dispatchEvent(event);
        return event.defaultPrevented;
      };
      const pause = (n: number) => new Promise((resolve) => setTimeout(resolve, n));
      send('touchstart', x, y);
      let claimed = false;
      for (let i = 1; i <= steps; i += 1) {
        await pause(ms / steps);
        claimed = send('touchmove', x + (dx * i) / steps, y + (dy * i) / steps) || claimed;
      }
      if (hold > 0) await pause(hold);
      const scrim = document.querySelector('.sheet-backdrop') as HTMLElement | null;
      const card = document.querySelector('.sheet') as HTMLElement | null;
      const offset = card ? new DOMMatrix(getComputedStyle(card).transform).m42 : null;
      const result = {
        claimed,
        scrimBeforeLift: scrim ? Number(getComputedStyle(scrim).opacity) : null,
        offsetBeforeLift: offset,
      };
      send('touchend', x + dx, y + dy);
      return result;
    },
    { x: at.x, y: at.y, dx, dy, ms, steps, hold },
  );
}

/** The middle of the first element matching `selector`. */
export async function centreOf(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = (await page.locator(selector).first().boundingBox())!;
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

/**
 * Swipe an open sheet away, the way a thumb does: a quick drag down from the
 * grip, or from `over` when the spec is about where the drag starts.
 */
export async function swipeSheetAway(page: Page, { over = '.sheet-grip' }: { over?: string } = {}): Promise<TouchDragResult> {
  const result = await touchDrag(page, await centreOf(page, over), { dy: 320, ms: 180 });
  await pastTheSettle(page);
  return result;
}

/** Scroll the content of an open sheet with the wheel, which moves only `.sheet-body`. */
export async function scrollSheetContent(page: Page, by: number): Promise<void> {
  const at = await centreOf(page, '.sheet-body');
  await page.mouse.move(at.x, at.y);
  await page.mouse.wheel(0, by);
  await page.waitForTimeout(300);
}

/** How far the open card's own content is scrolled, and how far it could be. */
export async function sheetBodyScroll(page: Page): Promise<{ top: number; max: number }> {
  return page.evaluate(() => {
    const el = document.querySelector('.sheet-body') as HTMLElement;
    return { top: Math.round(el.scrollTop), max: Math.round(el.scrollHeight - el.clientHeight) };
  });
}

/** Tap the dimmed gap above an open card, which closes it. */
export async function tapAboveCard(page: Page): Promise<void> {
  const card = (await page.locator('.sheet').boundingBox())!;
  const width = page.viewportSize()!.width;
  await page.mouse.click(width / 2, Math.max(4, card.y / 2));
}

/**
 * Pull a screen down far enough to refresh it.
 *
 * The gesture replaced the refresh buttons, so the specs that used to tap one
 * do this instead. Moved by steps rather than in one jump because the control
 * damps the movement and arms only past a threshold — a single `mouse.move` to
 * the end point is one event, and one event is not a pull.
 */
export async function pullToRefresh(page: Page, testId: string): Promise<void> {
  const box = (await page.getByTestId(testId).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + 40;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (const step of [12, 60, 120, 190]) await page.mouse.move(x, y + step);
  await page.mouse.up();
}

/**
 * Empty the demo draft's ★ queue.
 *
 * The dev server keeps one database for the whole run and every project runs
 * against it, so a star left behind is a star every later spec — and every
 * later width — has to cope with, and several of them reasonably assume the
 * list starts empty. Done through the API rather than the UI because it is a
 * teardown, not a thing being tested, and it must not fail a passing test by
 * being slow.
 *
 * Call it from `test.afterEach`, never as the last line of a test body: a
 * teardown that only runs when every assertion before it passed is a teardown
 * that is missing exactly when it is needed.
 */
export async function emptyQueue(page: Page): Promise<void> {
  const res = await page.request.get('/api/drafts/demo-draft/board?limit=200&queued=1');
  if (!res.ok()) return;
  const board = (await res.json()) as { recommendations: { playerId: string }[] };
  for (const rec of board.recommendations ?? []) {
    await page.request.post('/api/drafts/demo-draft/queue', {
      data: { playerId: rec.playerId, queued: false },
    });
  }
}

/**
 * Clear every ♥ the specs can have set.
 *
 * The heart outlives the draft the ★ belongs to — it is stored per player, not
 * per draft — so it is the other half of the same hygiene problem, and it gets
 * the same answer. The sweep is bounded to the first page of the players list
 * because that is the only part of it a browser test can reach: the rows these
 * specs act on are the ones the screen draws first.
 */
export async function clearMyGuys(page: Page): Promise<void> {
  const res = await page.request.get('/api/players?limit=200');
  if (!res.ok()) return;
  const body = (await res.json()) as { players: { id: string; myGuy?: { level: number } }[] };
  for (const player of body.players ?? []) {
    if ((player.myGuy?.level ?? 0) > 0) {
      await page.request.post(`/api/players/${player.id}/my-guy`, { data: { level: 0 } });
    }
  }
}

/**
 * The Waivers response as an older payload had it: no `tiers`.
 *
 * A phone can hold a cached response from before the tiers shipped, and the
 * screen then draws the board it always drew. The board's own specs run
 * against that fallback through this, so it stays covered while the tiers are
 * the default. See `e2e/waiver-tiers.spec.ts` for the tiers.
 */
export async function withoutTiers(page: Page, over: Record<string, unknown> = {}): Promise<void> {
  await page.route('**/api/leagues/*/waivers', async (route) => {
    /*
     * A refresh can replace this request while it is in flight, and WebKit
     * then disposes the response before it is read (13 October 2026, the
     * pull-to-refresh spec at 430). That request no longer matters: the one
     * that replaced it is rewritten by this same handler.
     */
    try {
      const response = await route.fetch();
      const original = await response.json();
      const { tiers: _tiers, ...rest } = original as Record<string, unknown>;
      await route.fulfill({ response, body: JSON.stringify({ ...rest, ...over }) });
    } catch {
      await route.continue().catch(() => {});
    }
  });
}
