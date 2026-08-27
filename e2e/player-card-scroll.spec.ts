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
 *  - **The body could stop scrolling, permanently.** `touch-action: none` is
 *    put on a sheet body with nothing to scroll so it can be dragged shut from
 *    its content — and `none` means no touch scroll, no touch scroll means no
 *    `scroll` event, so a body that was measured before its content arrived had
 *    no way left to notice that it had grown. A sheet is capped at `88dvh` and
 *    an expanded player fills in from two requests after it opens, so the box
 *    stopped changing size while the content was still coming: exactly the
 *    conditions for that latch to close. The second test below reproduces it.
 *
 * Both are engine-independent and both run at 430, 390, 375 and 360, because
 * the Playwright projects are the widths.
 *
 * **What a headless browser cannot answer**, and the reason the WebKit projects
 * are still the gate rather than a formality: whether iOS Safari actually
 * yields the gesture. `page.mouse` is not a finger and no synthetic sequence
 * exercises WebKit's own "may this touch scroll" decision, which is the thing
 * that broke. The nearest available proxies are here — a real `wheel` through
 * the scroller, the declarations the browser reads, and a dispatched
 * `touchmove` checked for `defaultPrevented` — and the physical-device pass in
 * the handoff is not optional.
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

/** What the body is, as the browser sees it. */
async function bodyState(page: Page) {
  return page.evaluate(() => {
    const body = document.querySelector('.sheet-body') as HTMLElement;
    return {
      scrollTop: Math.round(body.scrollTop),
      scrollHeight: body.scrollHeight,
      clientHeight: body.clientHeight,
      overflows: body.scrollHeight > body.clientHeight + 1,
      scrollable: body.dataset['scrollable'],
      touchAction: getComputedStyle(body).touchAction,
      overscroll: getComputedStyle(body).overscrollBehaviorY,
    };
  });
}

/** Turn the wheel over the middle of the card, the way a scroll actually lands. */
async function wheelOverBody(page: Page, dy: number): Promise<void> {
  const box = (await page.locator('.sheet-body').boundingBox())!;
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
     * A player far enough down the list that the page behind has an offset
     * worth losing. Read off the pin rather than measured beforehand: opening a
     * row scrolls it into view first, so a reading taken before the tap is a
     * reading of somewhere the reader never was.
     */
    await openPlayer(page, '1012');
    await expect(page.getByTestId('outlook')).toBeVisible();
    const behind = await page.evaluate(() => Math.abs(parseInt(document.body.style.top || '0', 10)));
    expect(behind, 'the list was at its top, so putting the reader back proves nothing').toBeGreaterThan(0);

    // 1. It opens with something to scroll, and says so to the browser.
    await expect
      .poll(async () => (await bodyState(page)).scrollable, { message: 'a card taller than the screen reported nothing to scroll' })
      .toBe('true');
    const opened = await bodyState(page);
    expect(opened.overflows, 'the fixture is not tall enough to be a scrolling card').toBe(true);
    expect(opened.touchAction, 'the browser was not given permission to scroll the card').toBe('pan-y');
    expect(opened.scrollTop, 'the card did not open at its top').toBe(0);
    // A scroll that runs out of card never becomes a scroll of the page.
    expect(opened.overscroll).toBe('contain');

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
     */
    const prevented = await page.evaluate(() => {
      const body = document.querySelector('.sheet-body') as HTMLElement;
      const rect = body.getBoundingClientRect();
      const point = { x: rect.left + rect.width / 2, y: rect.top + 20 };
      let touch: Touch | null = null;
      try {
        touch = new Touch({ identifier: 1, target: body, clientX: point.x, clientY: point.y });
      } catch {
        const legacy = document as unknown as {
          createTouch?: (w: Window, t: EventTarget, id: number, x: number, y: number, sx: number, sy: number) => Touch;
        };
        if (legacy.createTouch) touch = legacy.createTouch(window, body, 1, point.x, point.y, point.x, point.y);
      }
      if (!touch) return null;
      const event = new TouchEvent('touchmove', {
        cancelable: true,
        bubbles: true,
        touches: [touch],
        targetTouches: [touch],
        changedTouches: [touch],
      });
      body.dispatchEvent(event);
      return event.defaultPrevented;
    });
    if (prevented !== null) {
      expect(prevented, 'something in the sheet cancelled a touchmove, which costs WebKit the whole scroll').toBe(false);
    }

    // 3. It really scrolls, through the browser's own scroller, and keeps going.
    await wheelOverBody(page, 400);
    const first = await bodyState(page);
    expect(first.scrollTop, 'the card did not move under a scroll').toBeGreaterThan(0);

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

    // 5. And so is the top again.
    for (let i = 0; i < 12; i++) {
      if ((await bodyState(page)).scrollTop <= 0) break;
      await wheelOverBody(page, -900);
    }
    expect((await bodyState(page)).scrollTop, 'the top of the card could not be reached again').toBe(0);

    // 6. None of that moved the list underneath, which is pinned where it was.
    expect(await page.evaluate(() => document.body.style.position)).toBe('fixed');
    await page.getByTestId('sheet-close').click();
    await expect(page.getByTestId('player-sheet')).toHaveCount(0);
    expect(
      Math.abs((await page.evaluate(() => Math.round(window.scrollY))) - behind),
      'the reader was dropped somewhere else in the list',
    ).toBeLessThan(4);

    // 7. Opened again, it is a scrolling card again rather than a stuck one.
    await openPlayer(page, '1012');
    await expect(page.getByTestId('outlook')).toBeVisible();
    await expect.poll(async () => (await bodyState(page)).scrollable, { message: 'the reopened card would not scroll' }).toBe('true');
    await wheelOverBody(page, 400);
    expect((await bodyState(page)).scrollTop, 'the reopened card did not move under a scroll').toBeGreaterThan(0);
  });

  /**
   * The latch, reproduced.
   *
   * A card opens before either of its two requests has answered, and a sheet is
   * capped at `88dvh` — so the body's own box can stop changing size while its
   * content is still growing. When the only thing being watched was that box,
   * the answer to "is there anything to scroll" froze at *no*, `touch-action:
   * none` stayed on, and the card could no longer be scrolled *or* report that
   * it had grown. That is the "sometimes it just does not move" half of the
   * complaint, and it is permanent for as long as the card is open.
   *
   * Held back by a route rather than by a timer in the page, so what is being
   * exercised is the real sequence: open short, fill in late.
   */
  test('notices content that arrives after it has opened', async ({ page }) => {
    await withLongOutlook(page, { delayMs: 1200 });
    await page.goto('/');
    await page.getByTestId('tab-players').click();
    await openPlayer(page, '1001');

    // While the outlook is still in flight the card is short, and a short card
    // claiming its own gestures is correct — there is no scroll to take.
    const early = await bodyState(page);
    expect(early.overflows, 'the card was already tall before its outlook landed').toBe(false);

    await expect(page.getByTestId('outlook')).toBeVisible();
    await expect
      .poll(async () => {
        const state = await bodyState(page);
        return { scrollable: state.scrollable, touchAction: state.touchAction };
      }, { message: 'the card grew past the screen and went on reporting that it had nothing to scroll' })
      .toEqual({ scrollable: 'true', touchAction: 'pan-y' });

    await wheelOverBody(page, 400);
    expect((await bodyState(page)).scrollTop, 'the card that grew late could not be scrolled').toBeGreaterThan(0);
  });
});
