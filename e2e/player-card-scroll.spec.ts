/**
 * The expanded player card: the newsletter it leads with, and the scrolling.
 *
 * Two defects, reported together because a reader met them together — they open
 * a card, the top of it is missing the one sentence that explains the number
 * beside his name, and the rest of it will not move under their thumb.
 *
 *  - **The takeaway came and went with the calendar.** Whether a card showed
 *    `Newsletter takeaway` was decided by comparing a *decayed* score against a
 *    fixed floor, so the same unchanged evidence qualified in August and failed
 *    in September. Two players with the same kind of tally row showed different
 *    cards because their issues had been imported on different days. The
 *    arithmetic is pinned in `tests/takeaway.test.ts`, which can hold the clock
 *    still; what is checked here is the card.
 *
 *  - **The body could stop scrolling**, and did so on every card, because it
 *    was answering a question it could not answer in time. `touch-action: none`
 *    went on a sheet body with nothing to scroll, so a short sheet could be
 *    dragged shut from its content. A player's card opens on skeletons and
 *    fills in from two requests, so *while the reader is waiting for it* the
 *    body honestly has nothing to scroll, declares `none`, and the engine —
 *    which reads that once, when the finger lands, and never again — refuses
 *    the reader's first flick its scroll. They lift, flick again, and it works:
 *    *locks up, then unlocks, and feels delayed.* An earlier and permanent
 *    version of the same fault was a `ResizeObserver` that went quiet once the
 *    sheet reached its `88dvh` cap, and was fixed by measuring more accurately
 *    rather than by asking whether the measurement could be published in time.
 *    It cannot. There is no measurement now: the body declares `pan-y` for its
 *    whole life. The last two tests below hold that.
 *
 * Both are engine-independent and both run at 430, 390, 375 and 360, because
 * the Playwright projects are the widths.
 *
 * **What a headless browser mostly cannot answer**, and the reason the WebKit
 * projects are still the gate rather than a formality: whether iOS Safari
 * actually yields the gesture. `page.mouse` is not a finger — it obeys no
 * `touch-action` whatever — which is exactly how a body that declared `none` at
 * the wrong moment passed twelve WebKit shards twice. The proxies here are a
 * real `wheel` through the scroller, the declarations the browser reads, a
 * dispatched `touchmove` checked for `defaultPrevented`, and — new, and the
 * only one of the four that exercises the engine's own decision — real touch
 * points injected through the DevTools protocol, which run on Chromium only.
 * The physical-device pass in the handoff is still not optional.
 */

import { expect, test, type Page } from '@playwright/test';

/** Enough prose to overflow any of the four widths, from a field the card draws. */
const LONG_OUTLOOK = Array.from(
  { length: 40 },
  (_, i) =>
    `Sentence ${i + 1}: he ran a full complement of routes and the staff have said little about the ` +
    'rotation behind him, which leaves the workload where it was at the end of last season.',
).join(' ');

/**
 * Make the next card genuinely long, out of a field the card really renders.
 *
 * Not by capping the body, which is what the older sheet specs do and which is
 * the right tool when the property under test is "the body scrolls". Here the
 * property is "a card with more in it than fits scrolls", so the card is given
 * more to say instead. `delayMs` holds the response back so the sheet opens
 * short and grows afterwards — the sequence the latch needed.
 */
async function withLongOutlook(page: Page, { delayMs = 0 }: { delayMs?: number } = {}): Promise<void> {
  await page.route('**/api/players/*/detail', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    await route.fulfill({
      response,
      body: JSON.stringify({
        ...body,
        outlook: {
          season: '2026',
          title: '2026 Season Outlook',
          text: LONG_OUTLOOK,
          summarised: false,
          fullText: LONG_OUTLOOK,
          source: 'Rotowire',
          fetchedAt: '2026-08-20T00:00:00.000Z',
        },
        outlookNote: null,
      }),
    });
  });
}

async function openPlayer(page: Page, playerId: string): Promise<void> {
  const row = page.locator(`[data-testid="player-search-row"][data-player-id="${playerId}"]`);
  await row.scrollIntoViewIfNeeded();
  await row.click();
  await expect(page.getByTestId('player-sheet')).toBeVisible();
  await expect(page.getByTestId('player-page-metrics')).toBeVisible();
}

/**
 * What the card's content is, as the browser sees it.
 *
 * Read off `.sheet-body`, which is the scroller a reader moves when they read
 * further down a card. There are two on this layer and the distinction is the
 * whole subject of this file: `.sheet-scroller` holds the card's *position* and
 * has exactly two of them, the card in place and the card gone, while
 * everything that happens inside a long card happens here. A card that will not
 * scroll is this box refusing, and a card that is thrown away by a scroll is
 * that one taking it.
 *
 * `overscroll` is read here rather than assumed: `contain` on this box is an
 * instruction not to chain outward, and it is exactly what made an earlier
 * sheet impossible to push away from its own content.
 */
async function bodyState(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector('.sheet-body') as HTMLElement;
    const layer = document.querySelector('.sheet-scroller') as HTMLElement;
    return {
      scrollTop: Math.round(el.scrollTop),
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      /** Whether the card has more in it than the card can show. */
      overflows: el.scrollHeight - el.clientHeight > 0,
      touchAction: getComputedStyle(el).touchAction,
      overscroll: getComputedStyle(el).overscrollBehaviorY,
      layerTop: Math.round(layer.scrollTop),
      layerOverscroll: getComputedStyle(layer).overscrollBehaviorY,
    };
  });
}

/**
 * Wait until the sheet has stopped moving — two readings in the same place.
 *
 * A sheet rises into position on open, and a wheel delivered while it is still
 * travelling lands on wherever the body was a frame ago, which is not
 * necessarily the body. The two engines animate on different clocks, so this is
 * not something a fixed pause gets right for both: it failed only on WebKit at
 * 430, on the *reopen*, where the animation is the whole of what is different.
 */
async function settled(page: Page, tries = 20): Promise<void> {
  const body = page.locator('.sheet-scroller');
  let previous = '';
  for (let i = 0; i < tries; i++) {
    const box = await body.boundingBox();
    const here = box ? `${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.height)}` : '';
    if (here && here === previous) return;
    previous = here;
    await page.waitForTimeout(50);
  }
}

/**
 * Turn the wheel over the middle of the card, the way a scroll actually lands.
 *
 * Settles first, so the wheel is delivered to a body that is where it is going
 * to be. Nothing here retries the *assertion* a caller makes about the result —
 * only the aim.
 */
/**
 * Where an opened card rests, which is the furthest this layer scrolls.
 *
 * Not a measurement of the card, and deliberately not one: the zone above the
 * card is exactly one screen and the card's own box is exactly one screen less
 * the gap, so the bottom of the layer *is* the card's position. `Sheet` puts it
 * there on open by the same arithmetic, and a reading taken any other way would
 * be a second opinion about a number that has only one source.
 */
async function detentOf(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.querySelector('.sheet-scroller') as HTMLElement;
    return Math.round(el.scrollHeight - el.clientHeight);
  });
}

async function wheelOverBody(page: Page, dy: number): Promise<void> {
  await settled(page);
  // Aimed at the middle of the layer, which is inside the card whenever a card
  // is open — the same point a reader's thumb lands on, and deliberately not a
  // point measured from `.sheet-body`, whose box can extend past the screen.
  const box = (await page.locator('.sheet-scroller').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, dy);
  await page.waitForTimeout(160);
}

test.describe('the newsletter takeaway on an expanded card', () => {
  /**
   * Scenario A: a player the newsletter has an opinion about.
   *
   * Four claims in one page load, in the order a reader meets them: the
   * takeaway is there, it is football rather than bookkeeping, it is the
   * ledger's own words, and the list underneath does not say it again.
   */
  test('leads with the football, in the ledger’s words, and says it once', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('tab-players').click();
    await openPlayer(page, '1001');

    const takeaway = page.getByTestId('newsletter-takeaway');
    await expect(takeaway, 'a player with applied newsletter evidence carried no takeaway').toBeVisible();

    /*
     * The sentence, without the provenance travelling with it.
     *
     * `— Demo FF Newsletter` used to run after the sentence and no longer does:
     * this app has one newsletter, so it was the same four words under every
     * player, spending the end of the one line the section exists for. It is
     * kept where it costs nothing — the element's title and its accessible
     * text — and both are removed here, because what is being compared against
     * the API is what the newsletter said.
     */
    const sentence = await takeaway.evaluate((el) => {
      const clone = el.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('.faint, .sr-only').forEach((n) => n.remove());
      return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
    });
    // The label reads INSIGHT, and the source is not printed beside the words.
    await expect(page.getByTestId('player-page-snapshot')).toContainText('Insight');
    const painted = await takeaway.evaluate((el) => {
      const clone = el.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('.sr-only').forEach((n) => n.remove());
      return (clone.textContent ?? '').trim();
    });
    expect(painted, 'the source name is printed beside the sentence again').not.toContain('Newsletter');

    const file = await page.evaluate(async () => (await fetch('/api/players/1001')).json());
    const stored: string[] = file.evidence
      .flatMap((e: { userOverride?: { note?: string }; contextSummary: string | null; excerpt: string }) => [
        e.userOverride?.note,
        e.contextSummary,
        e.excerpt,
      ])
      .filter((s: string | null | undefined) => !!s)
      .map((s: string) => s.replace(/\s+/g, ' ').trim());
    expect(stored, `"${sentence}" is in none of the stored words for this player`).toContain(sentence);

    /*
     * And it is about the player rather than about the app.
     *
     * The vocabulary of ingestion — a carried-over tally, a count of the items
     * it was assembled from, a review state — is accurate and belongs on
     * Review and in the evidence timeline. On a card somebody opened to find
     * out about a wide receiver it is the app talking about itself.
     */
    for (const bookkeeping of [/carried over/i, /running tally/i, /newsletter tally/i, /from \d+ items?/i, /auto[_ ]applied/i]) {
      expect(sentence, `the takeaway led with ingestion bookkeeping: ${bookkeeping}`).not.toMatch(bookkeeping);
    }

    // Said once. Whatever the takeaway lifted is gone from the list below it.
    const news = await page.getByTestId('player-page-snapshot').getByTestId('evidence-item').allInnerTexts();
    for (const line of news) {
      expect(line, 'Latest news repeated the sentence the takeaway had already lifted').not.toContain(sentence);
    }

    /*
     * Nothing was destroyed to achieve that. The item is still in the ledger,
     * still counted, and still on the evidence timeline one tap in — where it
     * is marked as the one that was lifted rather than hidden, because that
     * surface exists to show the whole ledger.
     */
    await page.getByTestId('player-full-profile').click();
    await expect(page.getByTestId('player-page')).toBeVisible();
    await page.getByTestId('player-page-sections').getByRole('button', { name: 'Evidence' }).click();
    const ledger = page.getByTestId('player-page-evidence');
    await expect(ledger.getByTestId('evidence-item').first()).toBeVisible();
    await expect(ledger.getByTestId('evidence-quoted').first(), 'the timeline lost the mark on the quoted item').toBeVisible();
  });

  /**
   * Scenario B: a player nobody has written about.
   *
   * The failure this guards is the opposite one, and it is the easier mistake
   * to make once a section is required: a heading over nothing, or worse, a
   * sentence composed to fill it.
   */
  test('draws no takeaway, and no empty heading, for a player with no evidence', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('tab-players').click();
    await openPlayer(page, '1003');

    const file = await page.evaluate(async () => (await fetch('/api/players/1003')).json());
    expect(file.evidence, 'the fixture changed: 1003 is meant to have an empty ledger').toHaveLength(0);

    const snapshot = page.getByTestId('player-page-snapshot');
    await expect(page.getByTestId('newsletter-takeaway')).toHaveCount(0);
    await expect(snapshot.getByTestId('evidence-heading'), 'a heading spent saying a heading was not needed').toHaveCount(0);
    await expect(snapshot.getByTestId('evidence-item')).toHaveCount(0);

    // And the card is still a card: the band it opens with is intact, and the
    // sheet has not been left the width of the phone plus a scrollbar.
    await expect(page.getByTestId('player-page-metrics')).toBeVisible();
    const overflow = await page.evaluate(
      () => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    );
    expect(overflow, 'the card overflowed the viewport sideways').toBeLessThanOrEqual(1);
  });
});

/**
 * Scenario C: a card with more in it than the screen has room for.
 *
 * One page load and one card, walked the way a reader walks it — open, scroll
 * to the bottom, scroll back to the top, close, open again — because each of
 * those was a way the interaction went wrong and a file of one-assertion tests
 * costs a page load each inside a shared step ceiling.
 */
test.describe('scrolling an expanded player card', () => {
  test('scrolls to the bottom and back, without moving the page behind it', async ({ page }) => {
    await withLongOutlook(page);
    await page.goto('/');
    await page.getByTestId('tab-players').click();

    /*
     * The list, scrolled, and then a player opened from where the reader
     * actually is — so the page behind has an offset worth losing.
     *
     * Both halves of that are load-bearing and each was got wrong once. A
     * reading taken *before* the tap is a reading of somewhere the reader never
     * was, because `scrollIntoViewIfNeeded` moves the page first; and a row
     * chosen by id is a row that may already be on screen at one width and not
     * at another, which made this pass at 390 and fail at 375. So: scroll
     * deliberately, then pick whichever row is under the middle of the viewport
     * at that offset, which is in view by construction at every width.
     */
    await expect(page.getByTestId('player-search-row').first()).toBeVisible();
    await page.evaluate(() => window.scrollTo({ top: 240, behavior: 'auto' }));
    await expect
      .poll(async () => page.evaluate(() => Math.round(window.scrollY)), {
        message: 'the players list did not scroll, so putting the reader back proves nothing',
      })
      .toBeGreaterThan(0);
    const behind = await page.evaluate(() => Math.round(window.scrollY));

    const midRow = page.locator('[data-testid="player-search-row"]').filter({
      has: page.locator('.player-name'),
    });
    const target = await midRow.evaluateAll((rows) => {
      const middle = window.innerHeight / 2;
      const inView = rows.filter((row) => {
        const r = row.getBoundingClientRect();
        return r.top > 8 && r.bottom < window.innerHeight - 8;
      });
      const nearest = inView.sort(
        (a, b) =>
          Math.abs(a.getBoundingClientRect().top - middle) - Math.abs(b.getBoundingClientRect().top - middle),
      )[0];
      return nearest ? (nearest as HTMLElement).dataset['playerId'] ?? null : null;
    });
    expect(target, 'no player row is fully in view at this width').not.toBeNull();

    await page.locator(`[data-testid="player-search-row"][data-player-id="${target}"]`).click();
    await expect(page.getByTestId('player-sheet')).toBeVisible();
    await expect(page.getByTestId('player-page-metrics')).toBeVisible();
    await expect(page.getByTestId('outlook')).toBeVisible();

    // Pinned exactly where the reader was, which is what the restore is checked
    // against at the end.
    expect(
      await page.evaluate(() => Math.abs(parseInt(document.body.style.top || '0', 10))),
      'the page behind was not pinned at the offset the reader was at',
    ).toBe(behind);

    // 1. It opens with something to scroll, and the browser already has leave.
    await expect
      .poll(async () => (await bodyState(page)).overflows, { message: 'the fixture is not tall enough to be a scrolling card' })
      .toBe(true);
    const opened = await bodyState(page);
    expect(opened.touchAction, 'the browser was not given permission to scroll the card').not.toBe('none');
    /*
     * The layer comes to rest at the card's detent, and the content at nought.
     *
     * Two readings for two scrollers. A card opens by *scrolling* — the rise is
     * the layer travelling from its dismissed position to the card's — so a
     * reading taken the instant the sheet appears catches that animation half
     * way, and both are polled rather than sampled.
     */
    const detentTop = await detentOf(page);
    expect(detentTop, 'the card has no detent to rest at').toBeGreaterThan(0);
    await expect
      .poll(async () => (await bodyState(page)).layerTop, { message: 'the card did not come to rest at its top' })
      .toBe(detentTop);
    expect((await bodyState(page)).scrollTop, 'the card opened part-way down its own content').toBe(0);
    /*
     * A scroll that runs out of *card* passes outward to the layer, which is the
     * dismissal — so this box must not say `contain`. A scroll that then runs
     * out of *layer* stops there and never reaches the page, which is what the
     * layer's own `contain` is for. One box out, and no further.
     */
    expect(opened.overscroll, 'the card cannot be pushed away from its own content').not.toBe('contain');
    expect(opened.layerOverscroll, 'a flick that runs out of sheet would carry on into the page behind').toBe('contain');

    /*
     * 2. Nothing takes the gesture off the browser.
     *
     * The defect was a non-passive `touchmove` listener that called
     * `preventDefault` on the first move of a gesture it could not yet
     * classify — and WebKit decides once, so an upward flick that started with
     * a pixel of downward drift was refused its scroll for the whole swipe.
     * A dispatched `touchmove` is the closest a headless browser gets to
     * asking that question directly; where the engine will not build one, the
     * declarations above and the wheel below are what is left.
     *
     * **Both halves of the construction are engine-specific, and both are
     * inside the guard.** The two engines disagree twice over: Chromium takes
     * `new Touch({...})` and a plain array of them, and WebKit takes neither —
     * it builds a touch through `document.createTouch` and demands a real
     * `TouchList` in the event's initialiser, throwing `TypeError` on an array.
     * An earlier version of this guarded only the `Touch` and let the
     * `TouchEvent` throw, which failed the WebKit shard on a detail of the test
     * rather than anything about the app. `null` means "this engine would not
     * build the event", and the assertion is skipped rather than faked.
     */
    const prevented = await page.evaluate(() => {
      const body = document.querySelector('.sheet-body') as HTMLElement;
      const rect = body.getBoundingClientRect();
      const point = { x: rect.left + rect.width / 2, y: rect.top + 20 };
      const legacy = document as unknown as {
        createTouch?: (w: Window, t: EventTarget, id: number, x: number, y: number, sx: number, sy: number) => Touch;
        createTouchList?: (...touches: Touch[]) => TouchList;
      };
      try {
        let touch: Touch;
        try {
          touch = new Touch({ identifier: 1, target: body, clientX: point.x, clientY: point.y });
        } catch {
          if (!legacy.createTouch) return null;
          touch = legacy.createTouch(window, body, 1, point.x, point.y, point.x, point.y);
        }
        // WebKit wants a TouchList here and rejects an array; Chromium takes
        // the array and has no `createTouchList` to offer.
        // `TouchEventInit` is typed as taking `Touch[]`, which is Chromium's
        // reading of it; the cast is what lets WebKit's `TouchList` through the
        // same call rather than forking the construction in two.
        const list = (legacy.createTouchList ? legacy.createTouchList(touch) : [touch]) as unknown as Touch[];
        const event = new TouchEvent('touchmove', {
          cancelable: true,
          bubbles: true,
          touches: list,
          targetTouches: list,
          changedTouches: list,
        });
        body.dispatchEvent(event);
        return event.defaultPrevented;
      } catch {
        return null;
      }
    });
    if (prevented !== null) {
      expect(prevented, 'something in the sheet cancelled a touchmove, which costs WebKit the whole scroll').toBe(false);
    }

    // 3. It really scrolls, through the browser's own scroller, and keeps going.
    const detent = await detentOf(page);
    await wheelOverBody(page, 400);
    const first = await bodyState(page);
    expect(first.scrollTop, 'the card did not move under a scroll').toBeGreaterThan(0);
    expect(first.layerTop, 'the card itself moved when only its content should have').toBe(detent);

    await wheelOverBody(page, 400);
    const second = await bodyState(page);
    expect(second.scrollTop, 'a second scroll did not advance the card').toBeGreaterThan(first.scrollTop);

    // 4. The bottom is reachable.
    for (let i = 0; i < 12; i++) {
      const state = await bodyState(page);
      if (state.scrollTop >= state.scrollHeight - state.clientHeight - 2) break;
      await wheelOverBody(page, 900);
    }
    const bottom = await bodyState(page);
    expect(
      bottom.scrollTop,
      `the bottom of the card could not be reached (${bottom.scrollTop} of ${bottom.scrollHeight - bottom.clientHeight})`,
    ).toBeGreaterThanOrEqual(bottom.scrollHeight - bottom.clientHeight - 2);

    /*
     * 5. And so is the top again, and the card is still there when it arrives.
     *
     *    One wheel is enough and it cannot overshoot into a dismissal: a scroll
     *    that starts with the content off its top spends itself returning the
     *    content to the top and stops, however large it is. Reaching the layer —
     *    and so the dismissal — takes a fresh gesture, which is the protection
     *    the reader gets for free from nesting one scroller in the other.
     */
    await wheelOverBody(page, -4000);
    await expect
      .poll(async () => (await bodyState(page)).scrollTop, {
        message: 'the top of the card could not be reached again',
      })
      .toBe(0);
    await expect(
      page.getByTestId('player-sheet'),
      'a pull back to the top of the card carried on and threw the card away',
    ).toBeVisible();
    expect((await bodyState(page)).layerTop, 'the card moved while its content was returning to its top').toBe(detent);

    // 6. None of that moved the list underneath, which is pinned where it was.
    expect(await page.evaluate(() => document.body.style.position)).toBe('fixed');
    await page.getByTestId('sheet-close').click();
    await expect(page.getByTestId('player-sheet')).toHaveCount(0);
    expect(
      Math.abs((await page.evaluate(() => Math.round(window.scrollY))) - behind),
      'the reader was dropped somewhere else in the list',
    ).toBeLessThan(4);

    // 7. Opened again, it is a scrolling card again rather than a stuck one.
    await openPlayer(page, target!);
    await expect(page.getByTestId('outlook')).toBeVisible();
    await expect
      .poll(async () => (await bodyState(page)).touchAction, { message: 'the reopened card would not scroll' })
      .not.toBe('none');
    /*
     * Polled rather than read once after a single wheel.
     *
     * The claim is that the reopened card moves under a scroll, and that claim
     * is unchanged; what is retried is the wheel, because a wheel that arrives
     * while the sheet is still rising is not a fair test of it. A card that is
     * genuinely stuck — the defect this step exists for — never moves however
     * many times it is asked.
     */
    await expect
      .poll(
        async () => {
          await wheelOverBody(page, 400);
          return (await bodyState(page)).scrollTop;
        },
        { message: 'the reopened card did not move under a scroll' },
      )
      .toBeGreaterThan(0);
  });

  /**
   * A card that has not finished arriving still hands the scroll to the browser.
   *
   * This is the whole of the second complaint, stated as a property: *at no
   * point in a card's life does its body tell the engine it may not be
   * panned.* Two attempts to make that conditional have now shipped and both
   * failed the same way.
   *
   * The body used to carry `touch-action: none` while it had nothing to scroll,
   * so a short sheet could be dragged shut from its content. The measurement was
   * honest; the moment it is published is not. A card opens on skeletons and
   * fills in from two requests, and the engine reads `touch-action` **once**,
   * when the finger lands. So a reader whose thumb is already on the card when
   * its content lands is refused the scroll for that whole gesture — the content
   * arriving halfway through it changes nothing, because the decision was taken
   * before it did — and only their next flick works. *Locks up, then unlocks.*
   * Against localhost that window is a few milliseconds; on a phone it is the
   * length of two requests, which is why nothing headless ever saw it.
   *
   * Held back by a route rather than by a timer in the page, so what is
   * exercised is the real sequence: open short, fill in late. Both requests are
   * held, because both of them are what the reader is waiting for.
   */
  test('never tells the browser it may not be panned, however late its content is', async ({ page }) => {
    await withLongOutlook(page, { delayMs: 1200 });
    await page.route('**/api/players/1001', async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await route.fulfill({ response, body });
    });
    await page.goto('/');
    await page.getByTestId('tab-players').click();
    await openPlayer(page, '1001');

    // Still waiting — and already the browser's to scroll.
    const early = await bodyState(page);
    expect(
      early.touchAction,
      'a card still waiting for its content refused the browser the pan, which costs the reader the gesture they are already making',
    ).not.toBe('none');

    /*
     * The card grows, which is the whole shape of the defect this test is for:
     * a reader's thumb is already on a card that is still two requests from
     * being the size it will end up.
     *
     * Measured as the content getting longer rather than as the card crossing
     * some height. The card *is* capped at its detent — it has to be, because a
     * snap area taller than the scrollport stops WebKit scrolling the layer at
     * all — so its own box tells you nothing about how much arrived. What grows
     * is what it holds, and what must be true is that it grew.
     */
    await expect(page.getByTestId('outlook')).toBeVisible();
    await expect
      .poll(async () => (await bodyState(page)).scrollHeight, {
        message: 'the outlook landed and the card did not grow',
      })
      .toBeGreaterThan(early.scrollHeight);
    expect((await bodyState(page)).touchAction, 'the grown card was not scrollable').not.toBe('none');

    const detent = await detentOf(page);
    await wheelOverBody(page, 400);
    const grown = await bodyState(page);
    expect(grown.scrollTop, 'the card that grew late could not be scrolled').toBeGreaterThan(0);
    expect(grown.layerTop, 'the card that grew late was moved instead of scrolled').toBe(detent);
  });

  /**
   * The same card, under something closer to a finger than this suite has ever
   * had.
   *
   * Everything above is driven by `page.mouse`, which obeys no `touch-action`
   * whatever — which is precisely how a body that declared `none` at the wrong
   * moment survived twelve green WebKit shards twice. This injects real touch
   * points through the DevTools protocol, so what is exercised is the engine's
   * own *may this touch scroll* decision rather than a declaration read back
   * out of the stylesheet.
   *
   * Two flicks, and the second is the one the first fix was written for: an
   * upward flick that begins with a pixel of downward drift, which the sheet
   * used to claim as a candidate dismissal and thereby cost the reader the
   * whole swipe. Until now nothing had ever put a *touch* through that path.
   *
   * **It runs on Chromium only**, because the protocol is Chromium's, and it is
   * not a substitute for the WebKit shards or for the phone. What it is, is the
   * first automated evidence in this repository that a finger on this card
   * moves it.
   *
   * What it deliberately does *not* claim: that a drag begun *before* the
   * card's content arrives scrolls anything. It cannot — a card that is still
   * two requests from existing has nothing under the finger to move, in any
   * engine. That window is what the test above is about, and what can be said
   * of it is that the card never tells the browser it may not be panned.
   */
  test('scrolls under a real touch, including a flick that starts with a pixel of drift', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'real touch injection is a Chromium DevTools protocol capability');

    await withLongOutlook(page);
    await page.goto('/');
    await page.getByTestId('tab-players').click();
    await openPlayer(page, '1001');
    await expect(page.getByTestId('outlook')).toBeVisible();
    await settled(page);

    const detent = await detentOf(page);
    const box = (await page.locator('.sheet-scroller').boundingBox())!;
    const x = Math.round(box.x + box.width / 2);
    const from = Math.round(box.y + box.height * 0.8);
    const at = (y: number) => [{ x, y: Math.round(y), id: 1, radiusX: 14, radiusY: 14, force: 1 }];
    const cdp = await page.context().newCDPSession(page);

    /** One flick, optionally preceded by `drift` pixels the wrong way. */
    const flick = async (drift: number) => {
      await page.evaluate((top) => {
        (document.querySelector('.sheet-scroller') as HTMLElement).scrollTop = top;
        (document.querySelector('.sheet-body') as HTMLElement).scrollTop = 0;
      }, detent);
      await page.waitForTimeout(120);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(from) });
      if (drift > 0) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(from + drift) });
        await page.waitForTimeout(16);
      }
      for (let i = 1; i <= 12; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(from + drift - i * 14) });
        await page.waitForTimeout(16);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(350);
      return (await bodyState(page)).scrollTop;
    };

    expect(await flick(0), 'a clean upward flick did not move the card').toBeGreaterThan(0);
    expect(
      await flick(2),
      'an upward flick that began with two pixels of downward drift lost its scroll — the original defect, back',
    ).toBeGreaterThan(0);

    // And it is still a sheet: the same finger on the grip closes it.
    await expect(page.getByTestId('player-sheet')).toBeVisible();
  });

  /**
   * The other direction, under the same finger — and the whole point of the
   * rebuild: **a downward flick on the card's own content pushes it away.**
   *
   * This test used to assert the exact opposite, and the reversal is the story.
   * The card was a fixed box the app translated, so the app had to take the
   * gesture from the engine; `.sheet-body` was a scroll container declaring
   * `pan-y`, so the engine kept it, and the sequence delivered under a real
   * touch was `pointerdown`, one `pointermove`, `pointercancel`. Acting on that
   * single move — which carries the finger's whole accumulated travel — moved
   * the card 351px and sprang it back without ever dismissing it, so the honest
   * guard was that the card must not move *at all*.
   *
   * There is nothing left to take. The dismissal is a scroll, so the engine
   * doing what it always wanted to do with this touch is the feature.
   *
   * Both halves of the rule are checked with the identical flick from the same
   * place, because the whole claim is that only the content's scroll position
   * decides which box hears it:
   *
   *  - with the content at its top, it has nowhere to put the scroll, so the
   *    scroll passes outward to the layer and the card goes;
   *  - scrolled down into it, the same flick is the content's — the card stays,
   *    and no size of flick can carry through into a dismissal.
   *
   * Chromium only, the protocol being Chromium's; the WebKit shards in CI are
   * what say this holds on the engine it has always failed on. A wheel exercises
   * the same scroller in both, which is why the rest of this suite can.
   */
  test('is pushed away by a downward flick on its content, and only from the top', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'real touch injection is a Chromium DevTools protocol capability');

    await withLongOutlook(page);
    await page.goto('/');
    await page.getByTestId('tab-players').click();
    await openPlayer(page, '1001');
    await expect(page.getByTestId('outlook')).toBeVisible();
    await settled(page);
    expect((await bodyState(page)).overflows, 'the card is not tall enough to be the case under test').toBe(true);

    const detent = await detentOf(page);
    const box = (await page.locator('.sheet-scroller').boundingBox())!;
    const x = Math.round(box.x + box.width / 2);
    const from = Math.round(box.y + box.height * 0.35);
    const at = (y: number) => [{ x, y: Math.round(y), id: 1, radiusX: 14, radiusY: 14, force: 1 }];
    const cdp = await page.context().newCDPSession(page);

    /** One deliberate downward flick from the middle of the card's content. */
    const push = async (steps: number) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(from) });
      for (let i = 1; i <= steps; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(from + i * 16) });
        await page.waitForTimeout(16);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(900);
    };

    /*
     * Scrolled into the card first: the same flick is the content's.
     *
     * A long push, deliberately — long enough that if the gesture *could* run
     * past the card's top and carry on into a dismissal, this is where it would.
     * It cannot: the content is a scroller of its own, and a scroll only passes
     * outward to the layer on a gesture that begins with the content already at
     * its top. So the reader part-way through a card can pull as hard as they
     * like and keep the card.
     */
    await page.evaluate((top) => {
      (document.querySelector('.sheet-scroller') as HTMLElement).scrollTop = top;
      (document.querySelector('.sheet-body') as HTMLElement).scrollTop = 600;
    }, detent);
    await page.waitForTimeout(200);
    const readAt = (await bodyState(page)).scrollTop;
    expect(readAt, 'the card would not scroll to set the case up').toBeGreaterThan(0);
    await push(14);
    await expect(
      page.getByTestId('player-sheet'),
      'a card the reader was part-way through reading was thrown away by one flick',
    ).toBeVisible();
    const afterFlick = await bodyState(page);
    expect(afterFlick.scrollTop, 'the flick did not move the content it was made on').toBeLessThan(readAt);
    expect(afterFlick.layerTop, 'the flick moved the card instead of its content').toBe(detent);

    // And from the card's own top, the same finger takes it away.
    await page.evaluate((top) => {
      (document.querySelector('.sheet-scroller') as HTMLElement).scrollTop = top;
      (document.querySelector('.sheet-body') as HTMLElement).scrollTop = 0;
    }, detent);
    await page.waitForTimeout(200);
    await push(14);
    await expect(
      page.getByTestId('player-sheet'),
      'a downward flick on content sitting at its top did not push the card away',
    ).toHaveCount(0);
  });
});
