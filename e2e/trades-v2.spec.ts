/**
 * The rebuilt Trades screens (Round 19) on a phone, at every supported width.
 *
 * The switch is turned on by answering `/api/auth/status` with
 * `tradesScreens: 'new'`, and the screens' three routes are answered by the
 * preview service itself, on the made-up preview league: the same answers the
 * preview upload gives, computed here by the same code. What is checked:
 *
 *  - Offers: at most three cards, each with its label and exact edge; the
 *    quiet week says the cards are the closest and labels each "Close: ...";
 *  - a tap opens the direct comparison;
 *  - Build starts from one question and finds offers around one player;
 *  - Check gives one line: Good for you, Fair or Bad for you;
 *  - every control is at least 44px tall, nothing scrolls sideways, and there
 *    is no info button anywhere on the screen.
 */

import { expect, test, type Page } from '@playwright/test';
import { TradeScreensService } from '../src/server/services/tradeScreensService.ts';

const service = (week: 'normal' | 'quiet') => new TradeScreensService(null as never, null as never, week);

async function openNewTrades(page: Page, week: 'normal' | 'quiet' = 'normal', deadline?: { weeksLeft: number; closes: string }) {
  await page.route('**/api/auth/status', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, body: JSON.stringify({ ...body, features: { tradesScreens: 'new', preview: null } }) });
  });
  await page.route('**/api/trades/screens/**', async (route) => {
    const url = new URL(route.request().url());
    const s = service(week);
    const body =
      url.pathname.endsWith('/offers')
        ? await s.offers(url.searchParams.get('sell') || url.searchParams.get('get') ? { sell: url.searchParams.get('sell'), get: url.searchParams.get('get') } : null).then((o) =>
            /* The live answer carries the deadline week's last kickoff (Round 32); the preview league has no schedule. */
            deadline ? { ...o, deadline: { week: 11, ...deadline } } : o,
          )
        : url.pathname.endsWith('/teams')
          ? await s.teams()
          : await s.verdict({
              partner: Number(url.searchParams.get('b')),
              give: (url.searchParams.get('give') ?? '').split(',').filter(Boolean),
              get: (url.searchParams.get('get') ?? '').split(',').filter(Boolean),
            });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/');
  await page.getByTestId('tab-trades').click();
  await expect(page.getByTestId('t2-nav')).toBeVisible();
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
}

async function expectTapTargets(page: Page, selector: string) {
  const boxes = await page.locator(selector).evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
  expect(boxes.length).toBeGreaterThan(0);
  for (const h of boxes) expect(h).toBeGreaterThanOrEqual(43.5);
}

test.describe('the rebuilt Trades screens', () => {
  test('Offers: at most three, each with a label and its exact edge, and no info buttons', async ({ page }) => {
    await openNewTrades(page);
    const cards = page.getByTestId('t2-offer');
    await expect(cards.first()).toBeVisible();
    expect(await cards.count()).toBeLessThanOrEqual(3);
    await expect(cards.first().getByTestId('t2-label')).toHaveText(/^(Fair|Good for you)$/);
    await expect(cards.first().getByTestId('t2-edge')).toHaveText(/^Edge [+−]?\d+%$/);
    await expect(cards.first().getByTestId('t2-reason')).not.toBeEmpty();
    expect(await horizontalOverflow(page)).toBe(0);
    await expectTapTargets(page, '[data-testid="t2-offer"], [data-testid="t2-tabs"] button');
    await expect(page.locator('.info-line-button, [aria-label*="More about" i]')).toHaveCount(0);
    expect(await page.getByTestId('t2-pull').innerText()).not.toContain('ⓘ');
    expect(await page.getByTestId('t2-pull').innerText()).not.toContain('—');
  });

  test('a tap opens the direct comparison', async ({ page }) => {
    await openNewTrades(page);
    await page.getByTestId('t2-offer').first().click();
    await expect(page.getByTestId('t2-offer-sheet-body')).toBeVisible();
    await expect(page.getByTestId('t2-compare')).toContainText('Rest of season');
    await expect(page.getByTestId('t2-sheet-edge')).toContainText('%');
    expect(await horizontalOverflow(page)).toBe(0);
  });

  test('a quiet week shows the closest, said to be closest, each labelled close', async ({ page }) => {
    await openNewTrades(page, 'quiet');
    await expect(page.getByTestId('t2-offers-close')).toContainText('closest');
    const labels = await page.getByTestId('t2-label').allInnerTexts();
    expect(labels.length).toBeGreaterThan(0);
    for (const l of labels) expect(l).toMatch(/^Close: /);
    expect(await horizontalOverflow(page)).toBe(0);
  });

  test('Build starts from one question and finds offers around one player', async ({ page }) => {
    await openNewTrades(page);
    await page.getByTestId('t2-tab-build').click();
    await expect(page.getByText('Who do you want to sell or get?')).toBeVisible();
    await page.getByTestId('t2-build-search').fill('sotelo');
    await page.getByTestId('t2-build-result').first().click();
    await expect(page.getByTestId('t2-build-change')).toContainText('Get Andre Sotelo');
    await expect(page.getByTestId('t2-build-offers').getByTestId('t2-offer').first()).toBeVisible();
    for (const text of await page.getByTestId('t2-get').allInnerTexts()) expect(text).toContain('Andre Sotelo');
    await expectTapTargets(page, '[data-testid="t2-build-change"], [data-testid="t2-offer"]');
    expect(await horizontalOverflow(page)).toBe(0);
  });

  test('Check gives one line, both gains, the edge and who gets better where', async ({ page }) => {
    await openNewTrades(page);
    await page.getByTestId('t2-tab-check').click();
    await page.getByTestId('t2-check-team').selectOption({ label: 'Dermot' });
    await page.getByTestId('t2-check-give-add').click();
    await page.getByTestId('t2-check-option').filter({ hasText: 'Bo Ashworth' }).click();
    await page.getByTestId('t2-check-option').filter({ hasText: 'Kai Brennan' }).click();
    await page.getByTestId('t2-picker-add').click();
    await page.getByTestId('t2-check-get-add').click();
    await page.getByTestId('t2-check-option').filter({ hasText: 'Andre Sotelo' }).click();
    await page.getByTestId('t2-picker-add').click();
    await expect(page.getByTestId('t2-check-word')).toHaveText('Fair');
    await expect(page.getByTestId('t2-check-result').getByTestId('t2-compare')).toContainText('This week');
    await expect(page.getByTestId('t2-check-edge')).toContainText('%');
    await expect(page.getByTestId('t2-check-better-you')).toContainText('TE');
    await expectTapTargets(page, '[data-testid="t2-check-team"], [data-testid="t2-check-give-player"], [data-testid="t2-check-get-add"]');
    expect(await horizontalOverflow(page)).toBe(0);
  });
});

/**
 * Round 32 (audit finding 10): a received offer checks in four taps or fewer.
 * Typing is not a tap; each click below is one. Opening the app is not counted
 * (it lands on Team), the Trades tab is.
 */
test.describe('Check by typed names (Round 32)', () => {
  for (const scheme of ['light', 'dark'] as const) test(`a received 1-for-1 checks in four taps: Trades, Check, one name, the other (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    let taps = 0;
    await openNewTrades(page); // tap 1: the Trades tab
    taps += 1;
    await page.getByTestId('t2-tab-check').click(); // tap 2
    taps += 1;
    /* The keyboard is already in the name field. */
    await expect(page.getByTestId('t2-check-search')).toBeFocused();
    await page.keyboard.type('ashworth');
    await expect(page.getByTestId('t2-check-match').first()).toContainText('Bo Ashworth');
    await expect(page.getByTestId('t2-check-match').first()).toContainText('yours');
    await expectTapTargets(page, '[data-testid="t2-check-match"], [data-testid="t2-check-search"]');
    await page.getByTestId('t2-check-match').first().click(); // tap 3
    taps += 1;
    /* The field keeps the keyboard for the next name. */
    await expect(page.getByTestId('t2-check-search')).toBeFocused();
    await page.keyboard.type('sotelo');
    await expect(page.getByTestId('t2-check-match').first()).toContainText('Dermot');
    await page.getByTestId('t2-check-match').first().click(); // tap 4
    taps += 1;
    await expect(page.getByTestId('t2-check-word')).toHaveText(/^(Good for you|Fair|Bad for you)$/);
    await expect(page.getByTestId('t2-check-team')).toHaveValue(/\d+/);
    await expect(page.getByTestId('t2-check-give-player')).toHaveText(/Bo Ashworth/);
    await expect(page.getByTestId('t2-check-get-player')).toHaveText(/Andre Sotelo/);
    expect(taps).toBeLessThanOrEqual(4);
    expect(await horizontalOverflow(page)).toBe(0);
    expect(await page.getByTestId('t2-check').innerText()).not.toContain('—');
  });

  test('"Check this offer" opens Check with both sides filled and the card’s own verdict', async ({ page }) => {
    await openNewTrades(page);
    const card = page.getByTestId('t2-offer-card').first();
    const label = await card.getByTestId('t2-label').innerText();
    const give = (await card.getByTestId('t2-give').innerText()).replace(/^Give\s*/, '').split(' + ');
    const get = (await card.getByTestId('t2-get').innerText()).replace(/^Get\s*/, '').split(' + ');
    await expectTapTargets(page, '[data-testid="t2-check-this"]');
    await card.getByTestId('t2-check-this').click();
    await expect(page.getByTestId('t2-check')).toBeVisible();
    await expect(page.getByTestId('t2-check-give-player')).toHaveCount(give.length);
    await expect(page.getByTestId('t2-check-get-player')).toHaveCount(get.length);
    for (const name of give) await expect(page.getByTestId('t2-check-give').getByText(name.trim(), { exact: true })).toBeVisible();
    for (const name of get) await expect(page.getByTestId('t2-check-get').getByText(name.trim(), { exact: true })).toBeVisible();
    await expect(page.getByTestId('t2-check-word')).toHaveText(label);
    /* The card still opens its comparison on a tap. */
    await page.getByTestId('t2-tab-offers').click();
    await page.getByTestId('t2-offer').first().click();
    await expect(page.getByTestId('t2-offer-sheet-body')).toBeVisible();
    expect(await horizontalOverflow(page)).toBe(0);
  });

  test('a quiet deadline chip beside the title while trades are open, gone once they close', async ({ page }) => {
    await openNewTrades(page, 'normal', { weeksLeft: 1, closes: '2026-11-24T01:15:00.000Z' });
    await expect(page.getByTestId('t2-deadline')).toHaveText('Deadline Mon Nov 23');
    const title = (await page.getByTestId('t2-nav').locator('.nav-title').boundingBox())!;
    const chip = (await page.getByTestId('t2-deadline').boundingBox())!;
    expect(chip.y + chip.height).toBeLessThanOrEqual(title.y + title.height + 1);
    expect(await horizontalOverflow(page)).toBe(0);
  });

  test('no chip once trades are closed', async ({ page }) => {
    await openNewTrades(page, 'normal', { weeksLeft: 0, closes: '2026-11-24T01:15:00.000Z' });
    await expect(page.getByTestId('t2-offer').first()).toBeVisible();
    await expect(page.getByTestId('t2-deadline')).toHaveCount(0);
  });
});

test.describe('the player picker (Round 19 review)', () => {
  for (const scheme of ['light', 'dark'] as const) test(`checks players, adds them with one green button, and the X cancels (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openNewTrades(page);
    await page.getByTestId('t2-tab-check').click();
    await page.getByTestId('t2-check-team').selectOption({ label: 'Dermot' });
    await page.getByTestId('t2-check-give-add').click();

    const add = page.getByTestId('t2-picker-add');
    await expect(add).toBeDisabled();
    await expect(add).toHaveText('Add players');
    const grey = await add.evaluate((el) => getComputedStyle(el).backgroundColor);

    await page.getByTestId('t2-check-option').filter({ hasText: 'Bo Ashworth' }).click();
    await expect(add).toBeEnabled();
    await expect(add).toHaveText('Add 1 player');
    await page.getByTestId('t2-check-option').filter({ hasText: 'Kai Brennan' }).click();
    await expect(add).toHaveText('Add 2 players');
    const pos = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.color = 'var(--pos)';
      document.body.appendChild(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    });
    /* The site's buttons fade their colour, so read it once the fade is done. */
    await expect.poll(() => add.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(pos);
    expect(pos).not.toBe(grey);

    /* At least 44px, inside the screen, above the phone's bottom bar. */
    const box = (await add.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(43.5);
    const viewport = page.viewportSize()!;
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    const toolbar = await page.evaluate(() => {
      const bar = document.querySelector('[data-testid="toolbar"], .toolbar, nav[aria-label]');
      return bar ? bar.getBoundingClientRect().top : null;
    });
    const covered = await add.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !(hit === el || el.contains(hit));
    });
    expect(covered, `the Add button is covered (toolbar top ${toolbar})`).toBe(false);

    await add.click();
    await expect(page.getByTestId('t2-picker')).toHaveCount(0);
    await expect(page.getByTestId('t2-check-give-player')).toHaveCount(2);

    /* The X cancels: what was checked in this visit is not added. */
    await page.getByTestId('t2-check-get-add').click();
    await page.getByTestId('t2-check-option').filter({ hasText: 'Andre Sotelo' }).click();
    await expect(page.getByTestId('t2-picker-add')).toHaveText('Add 1 player');
    await page.getByTestId('sheet-close').click();
    await expect(page.getByTestId('t2-picker')).toHaveCount(0);
    await expect(page.getByTestId('t2-check-get-player')).toHaveCount(0);

    /* And a player already on a side is not offered again. */
    await page.getByTestId('t2-check-give-add').click();
    await expect(page.getByTestId('t2-check-option').filter({ hasText: 'Bo Ashworth' })).toHaveCount(0);
    expect(await horizontalOverflow(page)).toBe(0);
  });

  test('marks an offer with this week’s opponent', async ({ page }) => {
    await openNewTrades(page);
    const marked = page.getByTestId('t2-offer').filter({ has: page.getByTestId('t2-opponent') });
    await expect(marked.first()).toContainText('Dermot');
    await expect(marked.first().getByTestId('t2-opponent')).toHaveText('This week’s opponent');
    await expect(marked.first().getByTestId('t2-numbers-them')).toContainText('this week');
  });
});

test('with the switch off, today’s Trades screen is drawn', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-trades').click();
  await expect(page.getByTestId('trades-nav')).toBeVisible();
  await expect(page.getByTestId('t2-nav')).toHaveCount(0);
});
