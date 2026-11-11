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

async function openNewTrades(page: Page, week: 'normal' | 'quiet' = 'normal') {
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
        ? await s.offers(url.searchParams.get('sell') || url.searchParams.get('get') ? { sell: url.searchParams.get('sell'), get: url.searchParams.get('get') } : null)
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
    await page.getByTestId('sheet-close').click();
    await page.getByTestId('t2-check-get-add').click();
    await page.getByTestId('t2-check-option').filter({ hasText: 'Andre Sotelo' }).click();
    await page.getByTestId('sheet-close').click();
    await expect(page.getByTestId('t2-check-word')).toHaveText('Fair');
    await expect(page.getByTestId('t2-check-result').getByTestId('t2-compare')).toContainText('This week');
    await expect(page.getByTestId('t2-check-edge')).toContainText('%');
    await expect(page.getByTestId('t2-check-better-you')).toContainText('TE');
    await expectTapTargets(page, '[data-testid="t2-check-team"], [data-testid="t2-check-give-player"], [data-testid="t2-check-get-add"]');
    expect(await horizontalOverflow(page)).toBe(0);
  });
});

test('with the switch off, today’s Trades screen is drawn', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-trades').click();
  await expect(page.getByTestId('trades-nav')).toBeVisible();
  await expect(page.getByTestId('t2-nav')).toHaveCount(0);
});
