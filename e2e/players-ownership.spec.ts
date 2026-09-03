/**
 * Who holds them, on the Players tab, in a real browser.
 *
 * The rule and the wire are pinned at the unit level — `roster.ownership` and
 * `playersOwnership` — so what is left for a browser is the part only a browser
 * can show: that the control is there, that choosing an answer changes the rows
 * underneath it, that the two questions the brief asks for cannot be asked at
 * once, and that the search, the position chips and the end-of-list count all
 * still mean what they meant.
 *
 * The seeded league is two rosters: `You` holds five players, `Rival` holds
 * exactly one — Devin Okafor, `1002`. One player is not a small fixture here,
 * it is the point: a team filter that returned two rows would be
 * indistinguishable from one that returned the wrong one.
 */

import { expect, test, type Page } from '@playwright/test';

/** Marcus Vance, the first pick, and on my roster rather than the wire. */
const MINE = '1001';
/** Devin Okafor, the rival's whole team. */
const RIVAL = '1002';

/** Open the ownership picker and choose one of its answers. */
async function chooseOwner(page: Page, label: string): Promise<void> {
  await page.getByTestId('players-owner-open').click();
  await expect(page.getByTestId('players-owner-sheet')).toBeVisible();
  await page.getByTestId('players-owner-option').filter({ hasText: new RegExp(`^${label}`) }).click();
  await expect(page.getByTestId('players-owner-sheet')).toBeHidden();
}

/** Every player id currently on screen, as one snapshot the caller must poll. */
async function idsOn(page: Page): Promise<string[]> {
  return page
    .getByTestId('player-search-row')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-player-id') ?? ''));
}

/** The same snapshot, retried until the list has settled after the debounce. */
function idsEventually(page: Page) {
  return expect.poll(() => idsOn(page), { timeout: 5_000 });
}

test.describe('the Players ownership picker', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('tab-players').click();
    await expect(page.getByTestId('players-list')).toBeVisible();
  });

  /**
   * One control, and both of the brief's filters are inside it.
   *
   * The shape is the claim. "Available" and a named team are alternatives in
   * one exclusive list rather than two controls that have to be told not to
   * contradict each other, and it reads from the widest answer to the
   * narrowest.
   */
  test('offers everybody, the wire, and then each team', async ({ page }) => {
    await page.getByTestId('players-owner-open').click();
    const labels = await page
      .getByTestId('players-owner-option')
      .evaluateAll((els) => els.map((e) => e.querySelector('.list-row-label')?.textContent?.trim() ?? ''));
    expect(labels).toEqual(['Anyone', 'Available', 'You', 'Rival']);
  });

  /** Shut, it says the answer in force — a chip row's one real advantage. */
  test('says what it is doing without being opened', async ({ page }) => {
    await expect(page.getByTestId('players-owner-open')).toHaveText('Owner');
    await chooseOwner(page, 'Rival');
    await expect(page.getByTestId('players-owner-open')).toHaveText('Rival');
  });

  test('narrows the list to one manager’s team', async ({ page }) => {
    await chooseOwner(page, 'Rival');
    await idsEventually(page).toEqual([RIVAL]);
  });

  test('leaves a rostered player out of the available list', async ({ page }) => {
    expect(await idsOn(page), 'the unfiltered list has him to hide').toContain(MINE);

    await chooseOwner(page, 'Available');
    await idsEventually(page).not.toContain(MINE);
    // A narrowing, not an emptying: there are still players to add.
    expect((await idsOn(page)).length).toBeGreaterThan(0);
  });

  /**
   * The combination that can only ever return nothing, and it cannot be
   * expressed.
   *
   * This is the whole reason ownership is one control rather than two: asking
   * for the rival's team is not "also available", it *replaces* available, so
   * there is no disabled state to explain and no empty list to account for.
   */
  test('cannot be asked for an available player on somebody’s team', async ({ page }) => {
    await chooseOwner(page, 'Available');
    await expect(page.getByTestId('players-owner-open')).toHaveText('Available');

    await chooseOwner(page, 'Rival');
    await expect(page.getByTestId('players-owner-open')).toHaveText('Rival');
    await idsEventually(page).toEqual([RIVAL]);

    // And the picker marks exactly one answer as the one in force.
    await page.getByTestId('players-owner-open').click();
    const chosen = page.locator('[data-testid="players-owner-option"][data-state="chosen"]');
    await expect(chosen).toHaveCount(1);
    await expect(chosen).toContainText('Rival');
  });

  test('goes back to everybody when Anyone is chosen again', async ({ page }) => {
    await chooseOwner(page, 'Rival');
    await idsEventually(page).toEqual([RIVAL]);
    await chooseOwner(page, 'Anyone');
    await idsEventually(page).toContain(MINE);
    await expect(page.getByTestId('players-owner-open')).toHaveText('Owner');
  });

  /**
   * The end-of-list line counts the filtered list, which is the visible half of
   * the claim that the narrowing happens before the page is cut. A client-side
   * filter would have left this saying how many players exist.
   */
  test('counts the end of the list off the filter', async ({ page }) => {
    await chooseOwner(page, 'Rival');
    await expect(page.getByTestId('players-end')).toHaveText(/^1 player — /);
  });
});

test.describe('the ownership picker and the controls already there', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('tab-players').click();
    await expect(page.getByTestId('players-list')).toBeVisible();
  });

  /** The combination the two controls exist to allow: one manager, one position. */
  test('narrows with the position chips rather than replacing them', async ({ page }) => {
    await chooseOwner(page, 'Rival');
    await idsEventually(page).toEqual([RIVAL]);

    // Devin Okafor is a receiver, so the flex view keeps him.
    await page.getByTestId('flx-filter').click();
    await idsEventually(page).toEqual([RIVAL]);

    // And the quarterbacks are somebody else's.
    await page.locator('[data-testid="players-controls"] .chip', { hasText: /^QB$/ }).click();
    await idsEventually(page).toEqual([]);
    await expect(page.locator('.empty')).toHaveText('Rival has no QB players.');
  });

  test('narrows with the search rather than replacing it', async ({ page }) => {
    await chooseOwner(page, 'Rival');
    await page.getByTestId('player-search').fill('okafor');
    await idsEventually(page).toEqual([RIVAL]);

    // Marcus Vance is on my roster, so the rival's team does not have him.
    await page.getByTestId('player-search').fill('vance');
    await idsEventually(page).toEqual([]);
    await expect(page.locator('.empty')).toHaveText('Rival has nobody matching “vance”.');
  });

  /**
   * The order is still the list's order.
   *
   * Stated as what it actually claims — that filtering *removes* players and
   * never *reorders* them — by comparing the filtered list against the
   * unfiltered one rather than against a printed rank. The rank was the first
   * attempt and was the wrong instrument twice over: it is an em dash for
   * anybody the imported ranking does not cover, and which players those are
   * depends on what the rest of this suite has already done to the shared
   * database.
   */
  test('removes players from the list without reordering the rest', async ({ page }) => {
    const everybody = await idsOn(page);
    expect(everybody.length).toBeGreaterThan(2);

    await chooseOwner(page, 'Available');
    await idsEventually(page).not.toContain(MINE);
    const available = await idsOn(page);

    const shown = new Set(available);
    const held = new Set(everybody);
    expect(available.filter((id) => held.has(id))).toEqual(everybody.filter((id) => shown.has(id)));
    // And it really did remove somebody, or the assertion above is vacuous.
    expect(available.length).toBeLessThan(everybody.length);
  });
});
