/**
 * Home Screen web app: installability, and the shell in standalone mode.
 *
 * The thing these tests are really defending is a claim, so it is worth stating
 * it plainly. In a normal Safari tab the app's bottom bar reaches the last
 * pixel of the visual viewport, and the grey area the user sees below it is
 * Safari's own URL field and button bar. A webpage cannot take those. The only
 * way to get that space back is to launch from the Home Screen, which is what
 * the manifest here makes possible — so the manifest being served, parseable
 * and standalone is a user-facing feature, not paperwork.
 *
 * What cannot be automated: an actual iOS Home Screen launch. Playwright has no
 * way to install a web app. So standalone mode is simulated the way iOS
 * announces itself — `navigator.standalone` — and everything downstream of that
 * signal is checked for real.
 */

import { expect, test, type Page } from '@playwright/test';

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

/** The home indicator's inset, which the browser under test reports as zero. */
const INSET = 34;

test.describe('installability', () => {
  test('serves a standalone manifest at the path the page links', async ({ page, request }) => {
    await page.goto('/');
    const href = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(href).toBe('/manifest.webmanifest');

    const res = await request.get(href!);
    expect(res.status()).toBe(200);
    // A wrong content type is the classic silent failure: the file is there,
    // the page links it, and the browser declines to treat it as a manifest.
    expect(res.headers()['content-type']).toMatch(/manifest\+json|application\/json/);

    const manifest = JSON.parse(await res.text());
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
  });

  test('every icon it names actually resolves', async ({ page, request }) => {
    await page.goto('/');
    const manifest = await (await request.get('/manifest.webmanifest')).json();
    for (const icon of manifest.icons as { src: string }[]) {
      const res = await request.get(icon.src);
      expect(res.status(), `${icon.src} is missing`).toBe(200);
      expect(res.headers()['content-type']).toContain('image/png');
    }
  });

  test('serves the iOS Home Screen icon', async ({ page, request }) => {
    await page.goto('/');
    const href = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href');
    const res = await request.get(href!);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('image/png');
  });

  test('start_url loads the app rather than redirecting somewhere', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('tab-draft')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/');
  });
});

test.describe('the install prompt', () => {
  test('stays out of the way where these instructions would be wrong', async ({ page }) => {
    // The suite's own browsers are desktop-shaped, which is the case that must
    // not see an iPhone Share-sheet instruction.
    await page.goto('/');
    await expect(page.getByTestId('tab-draft')).toBeVisible();
    await expect(page.getByTestId('install-prompt')).toHaveCount(0);
  });

  test.describe('on an iPhone', () => {
    test.use({ userAgent: IPHONE_UA, storageState: { cookies: [], origins: [] } });

    test('offers the Home Screen once, and explains it when asked', async ({ page }) => {
      await page.goto('/');
      const prompt = page.getByTestId('install-prompt');
      await expect(prompt).toBeVisible();
      await expect(prompt).toContainText('Home Screen');

      await expect(page.getByTestId('install-steps')).toHaveCount(0);
      await page.getByTestId('install-how').click();
      const steps = page.getByTestId('install-steps');
      await expect(steps).toBeVisible();
      await expect(steps).toContainText('Share');
      await expect(steps).toContainText('Add to Home Screen');
    });

    test('costs one row, not a banner', async ({ page }) => {
      await page.goto('/');
      const box = await page.getByTestId('install-prompt').boundingBox();
      // Two lines of small text plus its padding. Anything taller is a banner,
      // and the point of this app is the rows underneath it.
      expect(box!.height).toBeLessThanOrEqual(80);
    });

    test('stays dismissed across a reload', async ({ page }) => {
      await page.goto('/');
      await page.getByTestId('install-dismiss').click();
      await expect(page.getByTestId('install-prompt')).toHaveCount(0);
      await page.reload();
      await expect(page.getByTestId('tab-draft')).toBeVisible();
      await expect(page.getByTestId('install-prompt')).toHaveCount(0);
    });

    test('is gone entirely once the app is installed', async ({ page }) => {
      await asHomeScreenApp(page);
      await page.goto('/');
      await expect(page.getByTestId('tab-draft')).toBeVisible();
      await expect(page.getByTestId('install-prompt')).toHaveCount(0);
    });
  });
});

/**
 * Announce the page the way iOS announces a Home Screen launch.
 *
 * `navigator.standalone` is the signal Apple has always set, and the one this
 * app reads for compatibility; the `display-mode` media query cannot be forced
 * from outside the browser, so this is the honest half of the simulation.
 */
async function asHomeScreenApp(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, 'standalone', { value: true, configurable: true });
  });
}

test.describe('the shell when launched from the Home Screen', () => {
  test.use({ userAgent: IPHONE_UA });

  test.beforeEach(async ({ page }) => {
    await asHomeScreenApp(page);
    await page.goto('/');
    await expect(page.getByTestId('tab-draft')).toBeVisible();
    await page.addStyleTag({ content: `:root { --safe-bottom: ${INSET}px; }` });
    await page.waitForTimeout(300);
  });

  /*
   * The mode the user actually wants: no Safari chrome, so every pixel below
   * the bar would be the app's fault. There must be none.
   */
  test('has nothing of its own below the bar', async ({ page }) => {
    const g = await page.evaluate(() => {
      const nav = document.querySelector('.tabbar')!.getBoundingClientRect();
      return { gap: Math.round(window.innerHeight - nav.bottom), navBottom: Math.round(nav.bottom), viewport: window.innerHeight };
    });
    expect(g.gap).toBe(0);
    expect(g.navBottom).toBe(g.viewport);
  });

  /*
   * And still clears the home indicator. In standalone mode iOS draws the
   * indicator over the app, so removing this inset would put the tab labels
   * under it — the opposite mistake to the one this work is about, and just as
   * bad to tap.
   */
  test('still keeps the buttons off the home indicator', async ({ page }) => {
    const clearance = await page.evaluate(() => {
      const bar = document.querySelector('.tabbar')!;
      const button = bar.querySelector('button')!.getBoundingClientRect();
      return Math.round(bar.getBoundingClientRect().bottom - button.bottom);
    });
    // The indicator is a 5px pill sitting 8px off the bottom edge.
    expect(clearance).toBeGreaterThanOrEqual(13);
    expect(clearance, 'spending the whole 34px inset is what read as a blank strip').toBeLessThan(INSET);
  });

  test('reserves the bar exactly once, as in a tab', async ({ page }) => {
    const g = await page.evaluate(() => {
      const nav = document.querySelector('.tabbar')!.getBoundingClientRect();
      const main = getComputedStyle(document.querySelector('.app-main')!);
      return { navHeight: Math.round(nav.height), reserved: Number.parseFloat(main.paddingBottom) };
    });
    expect(g.reserved).toBeGreaterThanOrEqual(g.navHeight);
    expect(g.reserved - g.navHeight).toBeLessThanOrEqual(10);
  });

  test('claims the viewport height exactly once', async ({ page }) => {
    const viewport = await page.evaluate(() => window.innerHeight);
    const claims = await page.evaluate(() =>
      ['#root', '.app', '.app-main'].map((sel) => ({
        sel,
        minHeight: Number.parseFloat(getComputedStyle(document.querySelector(sel)!).minHeight),
      })),
    );
    expect(claims.filter((c) => Math.abs(c.minHeight - viewport) < 2).map((c) => c.sel)).toEqual(['#root']);
  });

  /* Standalone is a layout difference, not a different app. */
  test('is the same app: every tab still navigates in place', async ({ page }) => {
    for (const tab of ['team', 'trades', 'players', 'review', 'setup', 'draft'] as const) {
      await page.getByTestId(`tab-${tab}`).click();
      await expect(page.getByTestId(`tab-${tab}`)).toHaveAttribute('aria-current', 'page');
      // Navigating away from the app would leave the standalone window.
      expect(new URL(page.url()).pathname).toBe('/');
    }
  });

  test('keeps the session it was launched with', async ({ page }) => {
    // The e2e session is a cookie; a standalone launch must still be able to
    // make changes rather than silently dropping to view-only.
    await page.getByTestId('tab-setup').click();
    await expect(page.getByTestId('setup-step-sleeper')).toBeVisible();
    await expect(page.getByTestId('unlock-card')).toHaveCount(0);
  });
});

test.describe('layout diagnostics', () => {
  test('reports who owns the bottom of the screen', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('tab-setup').click();
    await page.getByTestId('panel-install').locator('summary').first().click();
    await page.getByTestId('layout-diagnostics').locator('summary').first().click();

    const table = page.getByTestId('layout-diagnostics-table');
    await expect(table).toBeVisible();
    // The number this whole pass exists to establish.
    await expect(table).toContainText('nothing (correct)');
    await expect(table).toContainText('browser tab');
  });
});
