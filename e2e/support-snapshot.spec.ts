/**
 * One row in Settings, and the four ways it can go wrong on a phone.
 *
 * The Support Snapshot's whole user-facing surface is a single row, which makes
 * the risk surface small and specific. It can be unreachable or overflow at the
 * narrow widths this app is built for; it can be tappable when there is nothing
 * to capture, producing a file that looks like a bug report and contains
 * nothing; it can succeed and say nothing, leaving the reader to guess whether
 * anything reached the clipboard; or it can put something in the clipboard that
 * should never have left the phone.
 *
 * Each of those is a test here. What the *file* contains is not this file's
 * subject — `tests/support.snapshot.test.ts` and `tests/support.redaction.test.ts`
 * own that, and they can compare three hundred players where a browser test can
 * only look at one. What this owns is the tap.
 */

import { expect, test, type Page } from '@playwright/test';
import { E2E_PASSPHRASE } from './constants.ts';

/** Where the row lives: Setup → This app. */
const ROW = 'setup-support-snapshot';

async function openSetup(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('tab-setup').click();
  await page.getByTestId(ROW).waitFor();
}

/**
 * Read the clipboard without needing a clipboard permission.
 *
 * WebKit does not grant `clipboard-read` to a test, and asking for it is not
 * what these tests are about anyway — what matters is *what the app tried to
 * write*. So `navigator.clipboard.writeText` is replaced with something that
 * records, which works identically in every engine and is honest about what it
 * proves: the app's side of the handshake.
 */
async function captureClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const store = { text: null as string | null };
    (window as unknown as { __clipboard: typeof store }).__clipboard = store;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          store.text = text;
        },
      },
    });
  });
}

const clipboardText = (page: Page) =>
  page.evaluate(() => (window as unknown as { __clipboard: { text: string | null } }).__clipboard.text);

test.describe('the row is reachable and legible at every width', () => {
  test('sits in This app, under Settings, and fits the screen', async ({ page }) => {
    await openSetup(page);
    const row = page.getByTestId(ROW);

    await expect(row).toBeVisible();
    await expect(row).toContainText('Copy Draft support snapshot');

    const box = (await row.boundingBox())!;
    // 44px is the floor a thumb needs, and it is never traded away.
    expect(box.height, `the row is only ${Math.round(box.height)}px tall`).toBeGreaterThanOrEqual(44);

    // Inside the viewport horizontally, at every width this suite runs.
    const width = page.viewportSize()!.width;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width + 0.5);
  });

  test('never makes the page scroll sideways', async ({ page }) => {
    await openSetup(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'Settings scrolls horizontally').toBeLessThanOrEqual(0);
  });

  test('reads the same in both themes', async ({ page }) => {
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await openSetup(page);
      await expect(page.getByTestId(ROW)).toBeVisible();
      const box = (await page.getByTestId(ROW).boundingBox())!;
      expect(box.height, `${theme}: the row is only ${Math.round(box.height)}px tall`).toBeGreaterThanOrEqual(44);
    }
  });
});

test.describe('tapping it', () => {
  test.beforeEach(async ({ page }) => {
    await captureClipboard(page);
  });

  test('copies a snapshot and says so', async ({ page }) => {
    await openSetup(page);
    await page.getByTestId(ROW).click();

    /*
     * The feedback, which is the whole point of the row having a state at all.
     *
     * Somebody who taps a button and sees nothing change concludes it is
     * broken and taps it again. `data-state` is what the row is actually in;
     * the words beside it are what the reader is told.
     */
    await expect(page.getByTestId(ROW)).toHaveAttribute('data-state', /copied|downloaded/, { timeout: 20_000 });
    await expect(page.getByTestId(ROW)).toContainText(/KB · \d+ ranked players/);

    const text = await clipboardText(page);
    expect(text, 'nothing reached the clipboard').toBeTruthy();

    const snapshot = JSON.parse(text!) as {
      schema: string;
      release: { surface: string; gitSha: string };
      decision: { kind: string; output: { order: string[] } };
    };
    expect(snapshot.schema).toBe('junculator/support-snapshot@1');
    expect(snapshot.decision.kind).toBe('draft-board');
    expect(snapshot.release.surface).toBe('draft-board');
    expect(snapshot.decision.output.order.length).toBeGreaterThan(0);
  });

  test('puts nothing sensitive on the clipboard', async ({ page }) => {
    await openSetup(page);
    await page.getByTestId(ROW).click();
    await expect(page.getByTestId(ROW)).toHaveAttribute('data-state', /copied|downloaded/, { timeout: 20_000 });

    const text = (await clipboardText(page))!;
    /*
     * A browser-side spot check, not the redaction suite.
     *
     * `tests/support.redaction.test.ts` scans the whole document against every
     * rule and refuses a capture that breaks one. This checks the two things
     * that could only ever go wrong *here* — the session cookie this page is
     * holding, and the passphrase it was unlocked with — because they exist in
     * the browser and nowhere the unit tests can see.
     */
    const cookies = await page.context().cookies();
    for (const cookie of cookies) {
      if (cookie.value.length < 8) continue;
      expect(text, `the session cookie reached the clipboard`).not.toContain(cookie.value);
    }
    expect(text, 'the unlock passphrase reached the clipboard').not.toContain(E2E_PASSPHRASE);

    /*
     * Field names, not words.
     *
     * The document says the word "passphrase" on purpose — the redaction rules
     * are written into every snapshot so that whoever is holding the file can
     * read what was taken out of it. A test searching the prose for the word
     * would fail on the sentence promising it is absent, which is the least
     * useful possible red tick. What must not be there is a *field*.
     */
    const forbidden = ['cookie', 'passphrase', 'authorization', 'apiKey', 'api_key', 'token'];
    for (const key of forbidden) {
      expect(text, `a \`${key}\` field reached the clipboard`).not.toContain(`"${key}":`);
    }
  });

  test('says so honestly when the server refuses, rather than copying an error', async ({ page }) => {
    await page.route('**/support-snapshot*', (route) =>
      route.fulfill({ status: 503, json: { error: 'the draft could not be read' } }),
    );
    await openSetup(page);
    await page.getByTestId(ROW).click();

    await expect(page.getByTestId(ROW)).toHaveAttribute('data-state', 'failed', { timeout: 20_000 });
    await expect(page.getByTestId(ROW)).toContainText('could not be read');
    expect(await clipboardText(page), 'a failed capture must not reach the clipboard').toBeNull();
  });
});

test.describe('when there is nothing to capture', () => {
  /**
   * A league with no draft has no board to explain.
   *
   * The honest response is to say so before the tap, not to hand somebody a
   * file that looks like a bug report and contains nothing — they would send
   * it, and wait.
   */
  test('says so, and does not offer the tap', async ({ page }) => {
    await page.route('**/api/leagues', async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { leagues: { draftId: string | null }[] };
      await route.fulfill({
        json: { ...body, leagues: body.leagues.map((l) => ({ ...l, draftId: null })) },
      });
    });

    await openSetup(page);
    const row = page.getByTestId(ROW);
    await expect(row).toContainText('No draft is loaded');
    // A static row rather than a button: there is nothing to press.
    expect(await row.evaluate((el) => el.tagName.toLowerCase())).toBe('div');
  });
});
