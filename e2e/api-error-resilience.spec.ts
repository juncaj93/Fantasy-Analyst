/**
 * What a phone sees when the API answers with a page.
 *
 * The defect this file is the regression test for was reproduced on a physical
 * iPhone: `JSON Parse error: Unrecognized token '<'`, which is JavaScriptCore
 * saying it was handed markup and asked to parse it as JSON. Every screen in
 * this app renders `err.message`, so that sentence was the whole of what the
 * reader got.
 *
 * The injection here is production-shaped rather than server-side: what is
 * fulfilled is what a Cloudflare error page and a single-page-application
 * fallback actually look like on the wire, which is the only thing the client
 * boundary can tell apart. Doing it at the route means the real API stays up
 * for every other spec sharing this server.
 */

import { expect, test, type Page } from '@playwright/test';
import { openSetupGroup, pullToRefresh } from './helpers.ts';

/** A thrown Worker, as Cloudflare answers it. */
const CLOUDFLARE_HTML = `<!DOCTYPE html><html><head><title>fantasy-analyst.workers.dev | 502: Bad gateway</title></head><body><h1>Error 1101</h1><p>Worker threw exception</p></body></html>`;

/**
 * Anything that would mean a parser, a page or a body reached the glass.
 *
 * Both engines' wording is listed because the symptom was reported in
 * JavaScriptCore's and the fallback projects run V8's.
 */
const NEVER_ON_SCREEN = [
  'Unrecognized token',
  'Unexpected token',
  'is not valid JSON',
  'JSON Parse error',
  'SyntaxError',
  'DOCTYPE',
  'Error 1101',
  'Bad gateway',
  '<html',
];

async function assertNothingRawOnScreen(page: Page): Promise<void> {
  const text = await page.locator('body').innerText();
  for (const forbidden of NEVER_ON_SCREEN) {
    expect(text, `"${forbidden}" reached the rendered UI`).not.toContain(forbidden);
  }
}

/**
 * Answer every API request with a page for as long as `failing` says so.
 *
 * Returned rather than toggled from outside so a test reads as "the Worker is
 * down … the Worker is up", which is the thing being rehearsed.
 */
async function injectHtmlFailure(page: Page, body: string, status: number) {
  const state = { failing: true, served: 0 };
  await page.route('**/api/**', async (route) => {
    if (!state.failing) return route.continue();
    state.served++;
    await route.fulfill({
      status,
      contentType: 'text/html; charset=utf-8',
      body,
    });
  });
  return state;
}

test.describe('an API that answers with a page', () => {
  test('never shows the reader a parser error, and offers a way back', async ({ page }) => {
    const parseErrors: string[] = [];
    page.on('pageerror', (err) => parseErrors.push(String(err)));

    await injectHtmlFailure(page, CLOUDFLARE_HTML, 502);
    await page.goto('/');

    const banner = page.getByTestId('app-error');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Couldn’t load this yet');
    await assertNothingRawOnScreen(page);
    expect(parseErrors.join('\n')).not.toMatch(/Unrecognized token|Unexpected token|not valid JSON/);
  });

  test('says the same thing for a 200 fallback page as for a 502', async ({ page }) => {
    /*
     * The status says the request succeeded, the content-type says it is a
     * page, and the API never ran. A client that only checked `res.ok` would
     * hand this straight to the parser.
     */
    await injectHtmlFailure(
      page,
      '<!doctype html><html lang="en"><head><title>The Junculator</title></head><body><div id="root"></div></body></html>',
      200,
    );
    await page.goto('/');

    await expect(page.getByTestId('app-error')).toContainText('Couldn’t load this yet');
    await assertNothingRawOnScreen(page);
  });

  test('recovers when the worker warms up, without a reload', async ({ page }) => {
    const state = await injectHtmlFailure(page, CLOUDFLARE_HTML, 502);
    await page.goto('/');
    await expect(page.getByTestId('app-error')).toBeVisible();
    expect(state.served).toBeGreaterThan(0);

    // The Worker is up. Nothing else changes: no reload, no navigation.
    state.failing = false;
    await page.getByTestId('app-error-retry').click();

    await expect(page.getByTestId('app-error')).toBeHidden();
    await expect(page.getByTestId('tab-setup')).toBeVisible();
    await assertNothingRawOnScreen(page);
  });

  /**
   * Settings keeps its chrome while it is reading, and its failure is escapable.
   *
   * Setup used to return the spinner — or, when the read failed, a bare line of
   * error text — in place of the entire screen, which is how production smoke
   * came to report "setup has no navigation bar" at 360px on a cold Worker and
   * then pass on the retry. Both halves are asserted here because the second is
   * the worse one: the status is read once, on mount, so before the retry
   * existed a single failed read left Settings dead for the rest of the session.
   */
  test('Setup keeps its navigation bar while its status is in flight, and offers a way back', async ({ page }) => {
    let answer: 'hold' | 'fail' | 'live' = 'hold';
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/setup/status', async (route) => {
      if (answer === 'hold') await held;
      if (answer === 'live') return route.continue();
      await route.fulfill({ status: 502, contentType: 'text/html; charset=utf-8', body: CLOUDFLARE_HTML });
    });

    await page.goto('/');
    await page.getByTestId('tab-setup').click();

    // In flight: the screen is there, with its bar, saying what it is doing.
    await expect(page.locator('.nav-bar').first()).toBeVisible();
    await expect(page.getByTestId('tab-setup')).toHaveAttribute('aria-current', 'page');

    answer = 'fail';
    release();

    // Failed: still a screen, and the way back is on it.
    await expect(page.getByTestId('setup-error')).toBeVisible();
    await expect(page.locator('.nav-bar').first()).toBeVisible();
    await assertNothingRawOnScreen(page);

    answer = 'live';
    await page.getByTestId('setup-error-retry').click();
    await openSetupGroup(page, 'data');
    await expect(page.getByTestId('setup-step-vegas')).toBeVisible();
    await expect(page.getByTestId('setup-error')).toHaveCount(0);
  });

  test('keeps the last good board on screen when a refresh comes back as a page', async ({ page }) => {
    /*
     * Good data first, then a page where the revalidation's answer should be.
     * What is on the glass was true when it was fetched and stays: the failure
     * must neither blank the screen nor overwrite the cache with the page.
     */
    await page.goto('/');
    await page.getByTestId('tab-draft').click();
    await expect(page.getByTestId('recommendation-row').first()).toBeVisible();
    const before = await page.getByTestId('recommendation-row').count();
    expect(before).toBeGreaterThan(0);

    await page.route('**/api/**', async (route) =>
      route.fulfill({ status: 502, contentType: 'text/html; charset=utf-8', body: CLOUDFLARE_HTML }),
    );
    await pullToRefresh(page, 'draft-pull');
    await page.waitForTimeout(1200);

    await assertNothingRawOnScreen(page);
    // The rows that were true a moment ago are still the rows.
    expect(await page.getByTestId('recommendation-row').count()).toBe(before);
  });
});
