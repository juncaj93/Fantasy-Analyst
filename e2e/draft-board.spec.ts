/**
 * The live draft board overlay.
 *
 * The board is a presentation layer over draft state the Draft screen already
 * has, so almost everything worth asserting here is about what it does *not*
 * do: it must not add a row to the header, must not fetch anything, must not
 * disturb the Draft page it opens over, and must not let its own sideways
 * scrolling escape into the page.
 *
 * The draft state is injected at the board endpoint rather than seeded, for the
 * same reason draft-autorefresh.spec.ts does it: the demo fixture is two picks
 * deep, and a board is only interesting once a room has been drafting for a
 * while. Everything else — the grid, the snake, the columns, the modes, the
 * scrolling — is the app's own code rendering the app's own response.
 */

import { expect, test, type Page } from '@playwright/test';

const TEAMS = 12;
const ROUNDS = 12;

const MANAGERS = [
  'You',
  'Rival',
  'The Commish',
  'Gridiron Giants',
  'Team 5',
  'Beer Money',
  'Sunday Scaries',
  'Waiver Wire Warriors',
  'Team 9',
  'Dak to the Future',
  'Team 11',
  'Zero RB',
].map((name, i) => ({ slot: i + 1, name, isMine: i === 0 }));

const POSITIONS = ['QB', 'RB', 'WR', 'TE'];
const NAMES = [
  'Jalen Hurts',
  'Christian McCaffrey',
  'Amon-Ra St. Brown',
  'Marvin Harrison Jr.',
  'Sam LaPorta',
  'Bijan Robinson',
];

/** The picks a snake draft has made after `made` selections, in owner order. */
function picksThrough(made: number) {
  return Array.from({ length: made }, (_, i) => {
    const pickNo = i + 1;
    const round = Math.ceil(pickNo / TEAMS);
    const inRound = ((pickNo - 1) % TEAMS) + 1;
    return {
      pickNo,
      playerId: `sim-${pickNo}`,
      name: NAMES[pickNo % NAMES.length]!,
      position: POSITIONS[pickNo % POSITIONS.length]!,
      team: 'PHI',
      // The snake: even rounds run the other way. Seat, not column order.
      ownerSlot: round % 2 === 0 ? TEAMS - inRound + 1 : inRound,
    };
  });
}

interface BoardDouble {
  /** Board rebuilds the app has asked the server for. */
  boards(): number;
  /** Sleeper syncs the app has made. */
  syncs(): number;
  /** Advance the draft by one pick; the next board rebuild sees it. */
  advance(): void;
}

/**
 * A draft the test owns, installed before the app loads.
 *
 * The sync response is frozen unless `advance()` is called, so the refresh
 * controller finds nothing and rebuilds nothing — which is what makes "the
 * overlay caused a rebuild" a signal rather than noise.
 */
async function installBoardDouble(
  page: Page,
  options: { made?: number; status?: string; rounds?: number } = {},
): Promise<BoardDouble> {
  let made = options.made ?? 40;
  const status = options.status ?? 'drafting';
  const rounds = options.rounds ?? ROUNDS;
  let boards = 0;
  let syncs = 0;

  await page.route('**/api/drafts/*/sync', async (route) => {
    syncs++;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status,
        fingerprint: `demo-draft:${status}:${made}:board`,
        pollIntervalSeconds: status === 'complete' ? 0 : 5,
      }),
    });
  });

  await page.route('**/api/drafts/*/board*', async (route) => {
    boards++;
    try {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      body['teams'] = TEAMS;
      body['rounds'] = rounds;
      body['type'] = 'snake';
      body['status'] = status;
      body['mySlot'] = 1;
      body['managers'] = MANAGERS;
      body['boardPicks'] = picksThrough(made);
      body['currentPick'] = made + 1;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    } catch {
      // The screen unmounted with this request in flight; nobody is listening.
      await route.abort().catch(() => {});
    }
  });

  return {
    boards: () => boards,
    syncs: () => syncs,
    advance: () => {
      made++;
    },
  };
}

async function openDraft(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('board-list')).toBeVisible();
}

/**
 * Two taps now, not one.
 *
 * The ▦ leads to three destinations rather than straight to the board — see
 * `web/components/draftDestinations.tsx` — so every test that wants the board
 * goes through the menu. The helper is what keeps that one change rather than
 * fourteen.
 */
async function openBoard(page: Page) {
  await page.getByTestId('draft-board-open').click();
  await page.getByTestId('go-draft-board').click();
  await expect(page.getByTestId('draft-board')).toBeVisible();
}

/** Where the board's own scroll container currently is. */
const boardScroll = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="board-scroll"]') as HTMLElement | null;
    return el ? { left: Math.round(el.scrollLeft), top: Math.round(el.scrollTop) } : null;
  });

test.describe('draft board overlay', () => {
  /**
   * The entry point, and the whole cost of it.
   *
   * A board button that added a row, or even a few pixels of header, would be
   * paid for on every screen of every draft by everybody — including the people
   * who never open it. So the assertion is not "the button exists": it is that
   * the bar it lives in is still one title and one subtitle tall.
   */
  test('the board icon sits beside the league name and costs the header no height', async ({ page }) => {
    await installBoardDouble(page);
    await openDraft(page);

    const button = page.getByTestId('draft-board-open');
    await expect(button).toBeVisible();
    /*
     * The glyph now leads to three destinations rather than one, so it is named
     * for what it opens. Everything else about it — its size, its place on the
     * title's own line, and the height it costs the header — is unchanged, and
     * is what the rest of this test is still about.
     */
    await expect(button).toHaveAccessibleName('Draft destinations');

    const nav = (await page.getByTestId('draft-nav').boundingBox())!;
    const box = (await button.boundingBox())!;
    const name = (await page.getByTestId('board-league-name').boundingBox())!;

    // Two lines of type and their padding, and nothing else. A third row would
    // put this well past 60.
    expect(nav.height, 'the draft header is still a two-line bar').toBeLessThan(60);
    // On the title's own line, beside the name rather than under it.
    expect(box.y).toBeGreaterThanOrEqual(nav.y);
    expect(box.y + box.height).toBeLessThanOrEqual(nav.y + nav.height);
    expect(box.x, 'after the league name').toBeGreaterThan(name.x);
    expect(Math.abs(box.y + box.height / 2 - (name.y + name.height / 2)), 'on the same line').toBeLessThan(8);

    // And no persistent text control anywhere on the screen.
    await expect(page.getByRole('button', { name: 'Draft Board', exact: true })).toHaveCount(0);
  });

  /**
   * The same board, on the server's own answer.
   *
   * Every other test here injects a draft, which keeps the grid, the snake and
   * the modes deterministic — and would keep passing if the three fields the
   * board reads stopped arriving from the server at all. This one takes what
   * the seeded deployment actually returns and asserts the two picks it really
   * has, in the columns of the managers who really made them.
   */
  test('draws the seeded draft from the server’s own response', async ({ page }) => {
    await openDraft(page);
    await openBoard(page);

    // The demo league is twelve seats; two of them are named, and the reader
    // holds the first.
    const managers = page.locator('[data-testid="board-manager"]');
    await expect(managers).toHaveCount(12);
    await expect(managers.nth(0)).toContainText('You');
    await expect(managers.nth(1)).toContainText('Rival');
    await expect(managers.nth(5)).toContainText('Team 6');
    await expect(page.locator('[data-testid="board-manager"][data-mine="yes"]')).toHaveCount(1);

    // Two picks made, so pick three is on the clock in seat three.
    await expect(page.locator('[data-testid="board-cell"][data-state="done"]')).toHaveCount(2);
    const current = page.locator('[data-testid="board-cell"][data-state="current"]');
    await expect(current).toHaveCount(1);
    await expect(current.locator('.dboard-pick')).toHaveText('1.03');
    await expect(page.locator('[data-cell="1:1"] [data-testid="board-cell"]')).toHaveAttribute('data-pick', '1');
    await expect(page.locator('[data-cell="1:2"] [data-testid="board-cell"]')).toHaveAttribute('data-pick', '2');
  });

  test('tapping it opens a full-screen board, and it opens compact', async ({ page }) => {
    await installBoardDouble(page, { made: 40 });
    await openDraft(page);
    await openBoard(page);

    const layer = page.getByTestId('draft-board');
    await expect(layer).toHaveAttribute('data-mode', 'compact');
    const box = (await layer.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.width).toBe(viewport.width);
    expect(box.height).toBe(viewport.height);

    // Compact is positions, and positions only: no name, and none of the
    // numbers the card behind it already carries.
    const done = page.locator('[data-testid="board-cell"][data-state="done"]').first();
    await expect(done.locator('.dboard-pos')).toHaveText(/^(QB|RB|WR|TE|K|DEF)$/);
    await expect(done.locator('.dboard-pick')).toHaveText(/^\d+\.\d+$/);
    await expect(layer.locator('.dboard-name'), 'no player names in compact mode').toHaveCount(0);
    // Nothing visible on the board is a metric. (The screen-reader sentence is
    // read separately below; this is what is drawn.)
    const visible = await layer.evaluate(
      (el) => [...el.querySelectorAll('.dboard-pick, .dboard-pos, .dboard-head, .dboard-round')].map((n) => n.textContent ?? '').join(' '),
    );
    for (const forbidden of ['Score', 'ADP', 'Val', 'Next', 'Hurts', 'McCaffrey', '%']) {
      expect(visible, `compact cells must not print ${forbidden}`).not.toContain(forbidden);
    }
  });

  test('the expand toggle adds a name, a position and a club — and nothing else', async ({ page }) => {
    await installBoardDouble(page, { made: 40 });
    await openDraft(page);
    await openBoard(page);

    await page.getByTestId('board-mode').click();
    await expect(page.getByTestId('draft-board')).toHaveAttribute('data-mode', 'expanded');

    const done = page.locator('[data-testid="board-cell"][data-state="done"]').first();
    const name = await done.locator('.dboard-name').innerText();
    // First initial and last name. Never the full first name.
    expect(name).toMatch(/^[A-Z]\. /);
    expect(name, 'the given name is initialled, not printed').not.toMatch(/Jalen|Christian|Marvin|Bijan|Amon-Ra/);
    await expect(done.locator('.dboard-pos-sm')).toHaveText(/^(QB|RB|WR|TE|K|DEF)$/);
    await expect(done.getByTestId('team-logo').or(done.getByTestId('team-code'))).toHaveCount(1);

    // Still no analysis of any kind.
    const visible = await page
      .getByTestId('draft-board')
      .evaluate(
        (el) => [...el.querySelectorAll('.dboard-pick, .dboard-name, .dboard-pos-sm, .dboard-head')].map((n) => n.textContent ?? '').join(' '),
      );
    for (const forbidden of ['Score', 'ADP', 'Val', 'Next', 'tier', '%']) {
      expect(visible, `expanded cells must not print ${forbidden}`).not.toContain(forbidden);
    }

    // And back again.
    await page.getByTestId('board-mode').click();
    await expect(page.getByTestId('draft-board')).toHaveAttribute('data-mode', 'compact');
  });

  /**
   * Switching modes must not throw the reader back to round one.
   *
   * The two modes have different column widths and different row heights, so
   * keeping the raw scroll offset would land somewhere else entirely. The
   * assertion is therefore about the *cell*: whatever was under the top-left
   * corner of the board stays under it.
   */
  test('toggling modes keeps the reader where they were on the board', async ({ page }) => {
    // Twenty rounds, so the board is genuinely taller than the phone and there
    // is a vertical position to lose.
    await installBoardDouble(page, { made: 100, rounds: 20 });
    await openDraft(page);
    await openBoard(page);

    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="board-scroll"]') as HTMLElement;
      el.scrollTo({ left: 120, top: 220, behavior: 'auto' });
    });
    await page.waitForTimeout(120);

    const before = (await boardScroll(page))!;
    expect(before.left, 'the board really is scrolled sideways').toBeGreaterThan(0);
    expect(before.top, 'and downwards').toBeGreaterThan(0);

    /*
     * The first cell the reader can actually see.
     *
     * Not simply the first one past the scroll offset: the manager band and the
     * round column are frozen *over* the content, so a cell tucked under them is
     * scrolled to but not visible. Measuring from the same corner the board
     * measures from is what makes this an assertion about what somebody is
     * looking at rather than about an implementation detail.
     */
    const anchorBefore = await page.evaluate(() => {
      const scroller = document.querySelector('[data-testid="board-scroll"]') as HTMLElement;
      const corner = document.querySelector('[data-testid="board-corner"]') as HTMLElement;
      const cells = [...scroller.querySelectorAll<HTMLElement>('[data-cell]')];
      const first = cells.find(
        (el) =>
          el.offsetLeft - scroller.scrollLeft >= corner.offsetWidth &&
          el.offsetTop - scroller.scrollTop >= corner.offsetHeight,
      );
      return first
        ? {
            cell: first.dataset['cell'],
            dx: Math.round(first.offsetLeft - scroller.scrollLeft),
            dy: Math.round(first.offsetTop - scroller.scrollTop),
          }
        : null;
    });
    expect(anchorBefore).not.toBeNull();

    await page.getByTestId('board-mode').click();
    await expect(page.getByTestId('draft-board')).toHaveAttribute('data-mode', 'expanded');
    await page.waitForTimeout(120);

    const after = await page.evaluate((cell) => {
      const scroller = document.querySelector('[data-testid="board-scroll"]') as HTMLElement;
      const el = scroller.querySelector<HTMLElement>(`[data-cell="${cell}"]`);
      return el
        ? { dx: Math.round(el.offsetLeft - scroller.scrollLeft), dy: Math.round(el.offsetTop - scroller.scrollTop) }
        : null;
    }, anchorBefore!.cell);

    expect(after, 'the same cell is still under the same point of the screen').not.toBeNull();
    expect(Math.abs(after!.dy - anchorBefore!.dy), 'same round, same place').toBeLessThanOrEqual(4);
    expect(Math.abs(after!.dx - anchorBefore!.dx), 'same column, same place').toBeLessThanOrEqual(4);
    // And emphatically not reset to round one.
    expect((await boardScroll(page))!.top, 'not thrown back to the top').toBeGreaterThan(0);
  });

  test('the pick on the clock is brought into view and marked', async ({ page }) => {
    await installBoardDouble(page, { made: 64 });
    await openDraft(page);
    await openBoard(page);

    const current = page.locator('[data-testid="board-cell"][data-state="current"]');
    await expect(current).toHaveCount(1);
    await expect(current).toBeInViewport();
    await expect(current).toHaveAttribute('aria-current', 'true');
    await expect(current.locator('.dboard-pick')).toHaveText('6.05');

    // The most recent completed pick is a different state, distinguishable.
    const latest = page.locator('[data-testid="board-cell"][data-latest="yes"]');
    await expect(latest).toHaveCount(1);
    await expect(latest).toHaveAttribute('data-pick', '64');

    // Opening a board deep in a draft means it scrolled to get there.
    expect((await boardScroll(page))!.left + (await boardScroll(page))!.top).toBeGreaterThan(0);
  });

  test('a finished draft is readable history with nobody on the clock', async ({ page }) => {
    await installBoardDouble(page, { made: TEAMS * ROUNDS, status: 'complete' });
    await openDraft(page);
    await openBoard(page);

    await expect(page.locator('[data-testid="board-cell"][data-state="current"]')).toHaveCount(0);
    await expect(page.getByTestId('board-subtitle')).toContainText('Final');
    await expect(page.locator('[data-testid="board-cell"][data-state="done"]')).toHaveCount(TEAMS * ROUNDS);
  });

  test('the reader’s own column is identifiable without shouting', async ({ page }) => {
    await installBoardDouble(page, { made: 8 });
    await openDraft(page);
    await openBoard(page);

    const mine = page.locator('[data-testid="board-manager"][data-mine="yes"]');
    await expect(mine, 'exactly one column is yours').toHaveCount(1);
    await expect(mine).toContainText('You');
    // Distinguished by weight and an accent line rather than by a cage around
    // every cell: no cell of the reader's own carries a border the others lack.
    const emphasised = await mine.evaluate((el) => {
      const style = getComputedStyle(el);
      return { weight: Number(style.fontWeight), border: style.borderBottomWidth };
    });
    expect(emphasised.weight).toBeGreaterThanOrEqual(700);
    expect(parseFloat(emphasised.border)).toBeGreaterThanOrEqual(2);
  });

  test('the frozen row and column keep the context while the board scrolls', async ({ page }) => {
    await installBoardDouble(page, { made: 100, rounds: 20 });
    await openDraft(page);
    await openBoard(page);

    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="board-scroll"]') as HTMLElement;
      el.scrollTo({ left: 300, top: 300, behavior: 'auto' });
    });
    await page.waitForTimeout(150);
    const scrolled = (await boardScroll(page))!;
    expect(scrolled.left, 'scrolled sideways').toBeGreaterThan(0);
    expect(scrolled.top, 'and downwards').toBeGreaterThan(0);

    const scroller = (await page.getByTestId('board-scroll').boundingBox())!;
    // Whose column: the manager band is still pinned to the top of the board
    // after scrolling down, and it is a real column rather than the corner.
    const heads = await page
      .locator('[data-testid="board-manager"]')
      .evaluateAll(
        (els, top) => els.filter((el) => Math.abs(el.getBoundingClientRect().top - top) < 2).length,
        scroller.y,
      );
    expect(heads, 'the manager names are pinned to the top of the board').toBeGreaterThan(1);
    const corner = (await page.getByTestId('board-corner').boundingBox())!;
    expect(Math.round(corner.x), 'the corner is frozen against the left edge').toBe(Math.round(scroller.x));
    expect(Math.round(corner.y), 'and against the top of the scroll area').toBe(Math.round(scroller.y));

    const visible = await page
      .locator('[data-testid="board-round"]')
      .evaluateAll(
        (els, left) => els.filter((el) => Math.abs(el.getBoundingClientRect().left - left) < 2).length,
        scroller.x,
      );
    expect(visible, 'every round label is pinned to the same left edge').toBeGreaterThan(1);
  });

  /**
   * The board must not become a second thing talking to Sleeper.
   *
   * The sync response is frozen, so nothing downstream has any reason to
   * rebuild. If opening the board, switching its mode or leaving it open for a
   * couple of poll cycles caused a single extra board request, this fails —
   * which is exactly the regression that turns a companion view into a second
   * data system.
   */
  test('opening the board creates no polling and no requests of its own', async ({ page }) => {
    const draft = await installBoardDouble(page, { made: 40 });
    await openDraft(page);
    await expect.poll(() => draft.syncs(), { timeout: 6_000 }).toBeGreaterThanOrEqual(1);

    const boardsBefore = draft.boards();
    const syncsBefore = draft.syncs();

    await openBoard(page);
    await page.getByTestId('board-mode').click();
    await page.getByTestId('board-mode').click();
    await page.waitForTimeout(6_500);

    expect(draft.boards(), 'the overlay fetches nothing').toBe(boardsBefore);
    // The existing loop carries on at its existing cadence — one poll per five
    // seconds, not two — so the board did not start a loop of its own.
    expect(draft.syncs() - syncsBefore).toBeLessThanOrEqual(3);
  });

  /** A pick landing through the existing sync fills the right cell. */
  test('a live pick fills the next cell and advances the current one', async ({ page }) => {
    const draft = await installBoardDouble(page, { made: 40 });
    await openDraft(page);
    await openBoard(page);

    await expect(page.locator('[data-testid="board-cell"][data-state="current"]')).toHaveAttribute('data-pick', '41');
    const doneBefore = await page.locator('[data-testid="board-cell"][data-state="done"]').count();

    draft.advance();

    await expect
      .poll(async () => page.locator('[data-testid="board-cell"][data-state="done"]').count(), { timeout: 12_000 })
      .toBe(doneBefore + 1);
    await expect(page.locator('[data-testid="board-cell"][data-state="current"]')).toHaveAttribute('data-pick', '42');
    // The board is still open, still in the mode the reader chose, and did not
    // jump back to the top when the pick landed.
    await expect(page.getByTestId('draft-board')).toBeVisible();
  });

  /**
   * Closing puts the reader back exactly where they were.
   *
   * The board is temporary. Everything the Draft page had set up when it opened
   * has to be there when it goes, because a companion view that costs the
   * reader their place mid-draft is worse than no companion view. The filter
   * and the search are asserted here; the scroll is its own test below, because
   * it needs a board long enough to have somewhere to scroll to.
   */
  test('closing returns to the Draft page with its filter and search intact', async ({ page }) => {
    await installBoardDouble(page, { made: 40 });
    await openDraft(page);

    await page.getByRole('button', { name: 'QB', exact: true }).click();
    await expect(page.getByTestId('recommendation-row').first()).toBeVisible();
    await page.getByTestId('draft-search-open').click();
    await page.getByTestId('draft-search').fill('a');
    await expect(page.getByTestId('recommendation-row').first()).toBeVisible();

    const before = {
      query: await page.getByTestId('draft-search').inputValue(),
      rows: await page.getByTestId('recommendation-row').allInnerTexts(),
    };

    await openBoard(page);
    await page.getByTestId('board-close').click();
    await expect(page.getByTestId('draft-board')).toHaveCount(0);

    expect(await page.getByTestId('draft-search').inputValue(), 'the search survives').toBe(before.query);
    expect(await page.getByTestId('recommendation-row').allInnerTexts(), 'the rows survive').toEqual(before.rows);
    /*
     * Still the quarterback board, and not a rebuilt one.
     *
     * Read from the rows rather than from the chip, because unfolding the
     * search is what makes the chips step aside — so the control that would
     * normally answer this is not on screen while a search is open.
     */
    const positions = await page
      .getByTestId('recommendation-row')
      .evaluateAll((els) => [...new Set(els.map((el) => el.getAttribute('data-position')))]);
    expect(positions).toEqual(['QB']);
  });

  /**
   * And the page is exactly as far down as it was.
   *
   * A full-screen layer has to stop the page behind it scrolling, and the usual
   * way of doing that loses the offset it was locking. This is the assertion
   * that catches the reader being returned to the top of a forty-row board
   * mid-draft.
   */
  test('closing puts the Draft page back at the same scroll position', async ({ page }) => {
    await installBoardDouble(page, { made: 40 });
    await openDraft(page);

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(200);
    const before = await page.evaluate(() => Math.round(window.scrollY));
    expect(before, 'the Draft page really is scrolled down').toBeGreaterThan(0);

    await openBoard(page);
    // The page behind cannot be scrolled while the board is over it.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(100);

    await page.getByTestId('board-close').click();
    await expect(page.getByTestId('draft-board')).toHaveCount(0);
    await expect.poll(async () => page.evaluate(() => Math.round(window.scrollY)), { timeout: 3_000 }).toBe(before);
  });

  /** A club mark that will not load must cost the cell nothing. */
  test('a failed team logo falls back to the abbreviation without moving the cell', async ({ page }) => {
    await installBoardDouble(page, { made: 40 });
    await page.route('**/logos/nfl/*', (route) => route.abort());
    await openDraft(page);
    await openBoard(page);
    await page.getByTestId('board-mode').click();

    const cells = page.locator('[data-testid="board-cell"][data-state="done"]');
    await expect(cells.first().getByTestId('team-code')).toBeVisible();

    // Every completed cell is still exactly the height of every other one.
    const heights = await cells.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)));
    expect(new Set(heights).size, 'no cell changed shape because an image failed').toBe(1);
  });

  /**
   * The board scrolls sideways. The page must not.
   *
   * A grid wider than the phone is the point of this feature, and it is also
   * the single easiest way to give an entire app a horizontal scrollbar. The
   * overflow belongs to one container and stays there — while the board is
   * open, and after it closes.
   */
  test('the sideways scrolling belongs to the board and never to the page', async ({ page }) => {
    await installBoardDouble(page, { made: 100 });
    await openDraft(page);
    await openBoard(page);

    const page_ = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      win: window.innerWidth,
    }));
    expect(page_.doc, 'the document is no wider than the phone').toBeLessThanOrEqual(page_.win);
    expect(page_.body).toBeLessThanOrEqual(page_.win);

    const scroller = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="board-scroll"]') as HTMLElement;
      return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
    });
    expect(scroller.scrollWidth, 'and the board itself does scroll sideways').toBeGreaterThan(scroller.clientWidth);

    await page.getByTestId('board-close').click();
    await expect(page.getByTestId('draft-board')).toHaveCount(0);
    const after = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      win: window.innerWidth,
    }));
    expect(after.doc).toBeLessThanOrEqual(after.win);
  });

  /**
   * The board reads out loud, in either mode.
   *
   * Compact shows two letters, which is the right thing to see and the wrong
   * thing to hear. Both modes therefore expose the same sentence — the pick,
   * the manager, the player, his position and his club.
   */
  test('every cell says who is in it, whichever mode the board is in', async ({ page }) => {
    await installBoardDouble(page, { made: 40 });
    await openDraft(page);
    await openBoard(page);

    const spoken = () =>
      page
        .locator('[data-testid="board-cell"][data-state="done"]')
        .first()
        .evaluate((el) => el.querySelector('.sr-only')?.textContent ?? '');

    const compact = await spoken();
    expect(compact).toMatch(/Pick \d+\.\d+/);
    expect(compact, 'the full name, not the abbreviation').toMatch(/Hurts|McCaffrey|St\. Brown|Harrison|LaPorta|Robinson/);

    await page.getByTestId('board-mode').click();
    expect(await spoken(), 'and the same sentence expanded').toBe(compact);

    // The pick on the clock carries its state semantically, not only in colour.
    await expect(page.locator('[data-testid="board-cell"][aria-current="true"]')).toHaveCount(1);
  });
});
