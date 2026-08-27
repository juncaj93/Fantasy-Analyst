/**
 * Two rows in Settings, and the ways they can go wrong on a phone.
 *
 * The Support Snapshot's whole user-facing surface is a context and an action,
 * which makes the risk surface small and specific. Either row can be
 * unreachable or overflow at the narrow widths this app is built for; the
 * action can be tappable when there is nothing to capture, producing a file that
 * looks like a bug report and contains nothing; it can succeed and say nothing,
 * leaving the reader to guess whether anything reached the clipboard; or it can
 * put something in the clipboard that should never have left the phone.
 *
 * And the context can be **wrong**, which is the failure this lane added. A row
 * that silently captured the Draft board for somebody complaining about their
 * waiver plan would be worse than one that asked, because the file would look
 * complete and answer a question nobody had. So the context is stated on screen,
 * inferred from the screen the reader came from, and correctable.
 *
 * What the *file* contains is not this file's subject — `tests/support.*.test.ts`
 * owns that, and can compare three hundred players where a browser test can only
 * look at one. What this owns is the tap, and what the tap is about.
 */

import { expect, test, type Page } from '@playwright/test';
import { E2E_PASSPHRASE } from './constants.ts';

/** Where the rows live: Setup → This app. */
const ROW = 'setup-support-snapshot';
const CONTEXT = 'setup-support-context';

async function openSetup(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('tab-setup').click();
  await page.getByTestId(ROW).waitFor();
}

/**
 * Land on a decision screen, then walk to Settings.
 *
 * The journey the row exists to serve: somebody disagrees with what a screen
 * said and goes looking for the way to report it. The context has to follow
 * them.
 */
async function openSetupFrom(page: Page, tab: string): Promise<void> {
  await page.goto('/');
  await page.getByTestId(`tab-${tab}`).click();
  await page.getByTestId(`tab-setup`).click();
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
    await expect(row).toContainText('Copy support snapshot');
    await expect(page.getByTestId(CONTEXT)).toBeVisible();

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
    await expect(page.getByTestId(ROW)).toContainText(/\d+ KB/);

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

  /**
   * The clipboard is allowed to say no, and often does.
   *
   * `navigator.clipboard` is unavailable outside a secure context, refused by
   * some browsers for a payload this size, and refused by iOS whenever it
   * decides the write was not close enough to a user gesture. A row that tried
   * once and gave up would leave somebody holding nothing with no way to tell
   * that from an empty snapshot — so the file is offered instead, and the row
   * says which of the two happened rather than claiming "Copied" either way.
   */
  test('saves the file when the clipboard refuses, and says that it did', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async () => {
            throw new Error('NotAllowedError');
          },
        },
      });
    });

    await openSetup(page);
    const download = page.waitForEvent('download', { timeout: 20_000 });
    await page.getByTestId(ROW).click();

    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^junculator-draft-board-\d{8}-\d{6}\.json$/);

    await expect(page.getByTestId(ROW)).toHaveAttribute('data-state', 'downloaded');
    await expect(page.getByTestId(ROW)).toContainText('saved as a file instead');
    await expect(page.getByTestId(ROW)).toContainText(/\d+ KB/);
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

/**
 * The context, which is the only thing the reader has to get right — and does
 * not have to do anything to get right.
 *
 * Every case here is the same question asked from a different starting point:
 * *does the row capture the decision this person is complaining about?* A row
 * that guessed would be worse than one that asked, so it says which it chose.
 */
test.describe('the context follows the reader', () => {
  test.beforeEach(async ({ page }) => {
    await captureClipboard(page);
  });

  test('names the Draft board when that is where the reader has been', async ({ page }) => {
    await openSetup(page);
    await expect(page.getByTestId(CONTEXT)).toContainText('Draft');
  });

  /*
   * Team and Trades rather than Waivers and Matchup, and the reason is the point
   * of the seasonal tab strip: this fixture's draft is still live, so Waivers
   * and Matchup are not *on* the bar. A test that navigated to them would be
   * testing a state this app deliberately does not have — and the mechanism is
   * the same for all five, which the explicit selector below covers for the
   * three the bar is not currently showing.
   */
  test('follows them to Team, and captures the lineup', async ({ page }) => {
    await openSetupFrom(page, 'team');
    await expect(page.getByTestId(CONTEXT)).toContainText('Team');

    await page.getByTestId(ROW).click();
    await expect(page.getByTestId(ROW)).toHaveAttribute('data-state', /copied|downloaded/, { timeout: 30_000 });

    const snapshot = JSON.parse((await clipboardText(page))!) as {
      release: { surface: string };
      decision: { kind: string };
    };
    expect(snapshot.decision.kind).toBe('lineup');
    expect(snapshot.release.surface).toBe('lineup');
  });

  test('follows them to Trades too', async ({ page }) => {
    await openSetupFrom(page, 'trades');
    await expect(page.getByTestId(CONTEXT)).toContainText('Trades');
  });

  /**
   * A reload on the way to Settings is an ordinary thing on a phone.
   *
   * iOS discards backgrounded tabs and restores them from scratch, so a context
   * held in a component tree would be gone exactly when somebody came back to
   * finish reporting something. It lives in `sessionStorage` for this reason.
   */
  test('survives a reload between the screen and the row', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('tab-team').click();
    await page.getByTestId('tab-setup').waitFor();
    await page.reload();
    await page.getByTestId('tab-setup').click();
    await expect(page.getByTestId(CONTEXT)).toContainText('Team');
  });

  /**
   * And it can be corrected, because inference is not certainty.
   *
   * The selector is a control rather than the default: asking everybody to
   * classify their own complaint before making it is the thing this row exists
   * not to do. But a reader who has moved on since the thing they want to report
   * needs a way to say so.
   */
  test('can be changed by hand, and the change is what gets captured', async ({ page }) => {
    await openSetup(page);
    await expect(page.getByTestId(CONTEXT)).toContainText('Draft');

    await page.getByTestId(CONTEXT).click();
    await page.getByTestId('support-context-picker').waitFor();
    await page.getByTestId('support-context-lineup').click();

    await expect(page.getByTestId(CONTEXT)).toContainText('Team');
    await page.getByTestId(ROW).click();
    await expect(page.getByTestId(ROW)).toHaveAttribute('data-state', /copied|downloaded/, { timeout: 30_000 });

    const snapshot = JSON.parse((await clipboardText(page))!) as { decision: { kind: string } };
    expect(snapshot.decision.kind).toBe('lineup');

    /*
     * And the correction is remembered, so a reader who fixes it once does not
     * have to fix it again on the way back.
     */
    await page.getByTestId('tab-players').click();
    await page.getByTestId('tab-setup').click();
    await expect(page.getByTestId(CONTEXT)).toContainText('Team');
  });

  /**
   * The selector is a control on a phone, so it has to be one.
   *
   * Six choices at 360px is the width this app is hardest on, and a picker that
   * pushed the page sideways or shrank its own targets below a thumb would be a
   * control nobody can use in the one moment they need it.
   */
  test('offers all six choices without overflowing or shrinking the target', async ({ page }) => {
    await openSetup(page);
    await page.getByTestId(CONTEXT).click();
    await page.getByTestId('support-context-picker').waitFor();

    for (const kind of ['draft-board', 'lineup', 'matchup', 'waiver-plan', 'dst-plan', 'trade-offer']) {
      const chip = page.getByTestId(`support-context-${kind}`);
      await expect(chip).toBeVisible();
      const box = (await chip.boundingBox())!;
      expect(box.height, `${kind} is only ${Math.round(box.height)}px tall`).toBeGreaterThanOrEqual(44);
    }

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'the context picker scrolls the page sideways').toBeLessThanOrEqual(0);
  });
});

