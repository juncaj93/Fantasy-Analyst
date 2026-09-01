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
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, body: JSON.stringify({ ...body, live: false, drafted: [] }) });
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
  await page.getByTestId('setup-review').click();
  await page.getByTestId('setup-detail-review').waitFor();
}

/**
 * Wait long enough for a dismissal or a navigation that was going to happen to
 * have happened.
 *
 * **For the assertions that say a gesture did *nothing*, and they are worthless
 * without it.** Neither of this app's two gestures acts when the finger lifts:
 * a dismissed sheet and a completed back-swipe both animate off the screen
 * first and call their handler on `transitionend`, with a 400ms fallback behind
 * it for the case where the transition never fires. So for something like half a
 * second after a gesture that *did* fire, the thing it is taking away is still
 * in the document — and `expect(surface).toBeVisible()` asserted at that moment
 * is true whether the gesture fired or not.
 *
 * That is not hypothetical. Three tests across two suites — the ones holding the
 * line that a *scrolled* card keeps its drag, which is the half of that rule
 * that protects a reader from having the thing they are reading thrown away —
 * were passing against a build with the rule deliberately removed. They were
 * measuring the settle animation.
 *
 * The positive assertions never needed this: `toHaveCount(0)` and `toBeVisible`
 * on the screen behind both retry until the animation has resolved. It is only
 * "nothing happened" that has to wait to be sure.
 */
export async function pastTheSettle(page: Page): Promise<void> {
  await page.waitForTimeout(700);
}

/**
 * Push an open sheet away, the way a thumb does — with a scroll.
 *
 * **A mouse drag cannot do this any more, and that is the point.** A sheet's
 * layer is a scroller whose two ends are the card in place and the card gone, so
 * dismissing one *is* scrolling it; `page.mouse.down()` and a series of moves is
 * not a scroll and never was, so the drags these specs used to use now express
 * nothing. A wheel is a real scroll, which means it exercises the same mechanism
 * a finger does, in every engine — where the old pointer gesture was visible
 * only to a synthetic mouse, and passed twelve green WebKit shards while doing
 * nothing at all under a thumb.
 *
 * `over` is where to put the pointer first: the middle of the card by default,
 * which is the case worth checking most often, because it is the one the old
 * gesture could not do.
 */
export async function swipeSheetAway(
  page: Page,
  { over = '.sheet', ticks }: { over?: string; ticks?: number } = {},
): Promise<void> {
  if (ticks !== undefined) {
    // A push of a stated size, for the specs whose subject is the size.
    await wheelOverSheet(page, over, -ticks);
    return;
  }
  /*
   * Otherwise: one continuous push, delivered as a run of wheels close together.
   *
   * Not a single large one, and the reason is a measurement rather than caution.
   * How far a synthetic wheel actually scrolls depends on what else the page is
   * doing: with the per-frame `requestAnimationFrame` watcher the
   * pull-to-refresh specs install before they swipe, the *same* wheel that moves
   * this layer 675px moves it 50 — WebKit's wheel scrolling is starved by the
   * style recalculation it forces. Fifty pixels is a nudge, and a nudge
   * correctly springs back, so the spec was reporting the settle working as a
   * dismissal failing.
   *
   * Repeating them further apart does not help either: the settle returns each
   * abandoned nudge to the card's position, so nothing accumulates. They have to
   * arrive closer together than the settle waits — which is also what a finger
   * does, a drag being many small movements rather than one large one — and then
   * the settle sees where the whole push got to.
   */
  const at = await aimAt(page, over);
  if (!at) return;
  await page.mouse.move(at.x, at.y);
  for (let i = 0; i < 10; i++) {
    if ((await page.locator('.sheet-scroller').count()) === 0) return;
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(700);
}

/**
 * Put the pointer somewhere on the open sheet and turn the wheel.
 *
 * The aim is clamped into the scrollport, and that is not defensive tidiness: a
 * card taller than the screen has its top *above* the viewport once the reader
 * has scrolled into it, so a point measured from the card's own box lands off
 * screen and the wheel is delivered to nothing at all. Which looks exactly like
 * the app ignoring the gesture.
 */
async function wheelOverSheet(page: Page, over: string, by: number): Promise<void> {
  const at = await aimAt(page, over);
  if (!at) return;
  await page.mouse.move(at.x, at.y);
  await page.mouse.wheel(0, by);
  await page.waitForTimeout(700);
}

/** The point on `over` to deliver a scroll to, clamped into the scrollport. */
async function aimAt(page: Page, over: string): Promise<{ x: number; y: number } | null> {
  const target = await page.locator(over).first().boundingBox();
  const port = await page.locator('.sheet-scroller').boundingBox();
  if (!target || !port) return null;
  const wanted = target.y + Math.min(target.height / 2, 120);
  return {
    x: target.x + target.width / 2,
    y: Math.min(Math.max(wanted, port.y + 8), port.y + port.height - 8),
  };
}

/**
 * Scroll the content of an open sheet, without going near either end of it.
 *
 * The same wheel, over the same place, as the one that pushes the card away —
 * and which of the two happens is decided by the browser rather than by this
 * helper. A card whose content has somewhere to go scrolls its content; a card
 * whose content is already at its top has nowhere to put the scroll, so it
 * chains outward to the layer and the card moves instead. Telling those two
 * apart is the whole of what the sheet specs are for, so the aim deliberately
 * does not differ between them.
 */
export async function scrollSheetContent(page: Page, by: number): Promise<void> {
  await wheelOverSheet(page, '.sheet', by);
}

/**
 * Put a hand on the open card and keep it there, so that what the test does to
 * the layer next counts as the reader doing it.
 *
 * **For the specs whose subject is a *stated* push.** A wheel is the honest
 * gesture and `swipeSheetAway` is how most of this suite pushes a card, but how
 * far one wheel scrolls is the browser's business and varies with what else the
 * page is doing — no use to a spec that means "exactly seven tenths of the way
 * out, and read the scrim there". Those set `scrollTop` directly, and the layer
 * no longer treats a scroll as a dismissal unless a hand made it: a scroll with
 * no pointer behind it is put back at the card's position, which is the whole
 * point of that rule and would otherwise make these specs measure it instead of
 * their own subject.
 *
 * So the pointer is real — Playwright's mouse, not a dispatched event — and the
 * drag is real; only the push's *distance* is delivered by the test. Aimed at
 * the grip, which is decorative and has nothing under it to press, and moved far
 * enough to be a drag rather than a tap.
 */
export async function handOnCard(page: Page): Promise<void> {
  const grip = (await page.locator('.sheet-grip').first().boundingBox())!;
  const x = Math.round(grip.x + grip.width / 2);
  const y = Math.round(grip.y + grip.height / 2);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 24);
}

/** Take the hand off again. Tolerant, because the card may already have gone. */
export async function handOffCard(page: Page): Promise<void> {
  await page.mouse.up().catch(() => {});
}

/** How far the open sheet's layer is scrolled, and how far it could be. */
export async function sheetScroll(page: Page): Promise<{ top: number; max: number }> {
  return page.evaluate(() => {
    const el = document.querySelector('.sheet-scroller') as HTMLElement;
    return { top: Math.round(el.scrollTop), max: Math.round(el.scrollHeight - el.clientHeight) };
  });
}

/**
 * How far the open card's own content is scrolled, and how far it could be.
 *
 * Distinct from `sheetScroll`, and the distinction is the fix for the defect
 * that took the sheet apart twice. The layer moves between two positions only —
 * the card in place and the card gone — and everything a reader does *inside* a
 * long card moves this instead. A spec that means "the reader read further down
 * the card" must read this one; a spec that means "the card was pushed away"
 * must read the layer.
 */
export async function sheetBodyScroll(page: Page): Promise<{ top: number; max: number }> {
  return page.evaluate(() => {
    const el = document.querySelector('.sheet-body') as HTMLElement;
    return { top: Math.round(el.scrollTop), max: Math.round(el.scrollHeight - el.clientHeight) };
  });
}

/**
 * Tap the see-through gap above an open card, which is how a sheet is closed
 * from outside it.
 *
 * Aimed at a *viewport* point inside the gap rather than at a position on
 * `.sheet-dismiss`, and the difference is not cosmetic. That element is a whole
 * screen tall and all but its last inch is scrolled up out of view, so asking
 * for a point near its top makes Playwright scroll the layer to reveal it —
 * and scrolling this layer to its top is precisely what dismisses the sheet.
 * The card then vanishes mid-click and the click fails on a detached element,
 * which is a test dismissing a sheet by accident and then reporting that it
 * could not be dismissed. Four specs did exactly that.
 *
 * The gap is what the reader can see of the backdrop, so a point near the top
 * of the screen is both inside it and the honest description of the gesture.
 */
export async function tapAboveCard(page: Page): Promise<void> {
  const port = (await page.locator('.sheet-scroller').boundingBox())!;
  await page.mouse.click(port.x + port.width / 2, port.y + 20);
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
