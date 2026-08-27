/**
 * The Setup experience on an iPhone.
 *
 * These tests are the guard against Setup drifting back into developer
 * vocabulary: they check the five status rows, the newsletter address and
 * subscribe instruction, ADP import feedback, and that nothing on screen asks
 * the user to understand HTTP.
 */

import { expect, test, type Page } from '@playwright/test';
import { openReview } from './helpers.ts';

async function openSetup(page: Page) {
  await page.goto('/');
  await page.getByTestId('tab-setup').click();
  await expect(page.getByTestId('setup-step-sleeper')).toBeVisible();
}

test.describe('setup overview', () => {
  test.beforeEach(async ({ page }) => openSetup(page));

  test('shows all five areas with a status each', async ({ page }) => {
    for (const id of ['sleeper', 'league', 'adp', 'newsletter', 'vegas']) {
      await expect(page.getByTestId(`setup-step-${id}`)).toBeVisible();
    }
  });

  test('marks the seeded league and rankings as done', async ({ page }) => {
    await expect(page.getByTestId('setup-step-sleeper')).toHaveAttribute('data-state', 'ok');
    await expect(page.getByTestId('setup-step-league')).toHaveAttribute('data-state', 'ok');
    await expect(page.getByTestId('setup-step-adp')).toHaveAttribute('data-state', 'ok');
    await expect(page.getByTestId('setup-step-league')).toContainText('Demo Dynasty');
  });

  test('uses plain language, not developer terminology', async ({ page }) => {
    const text = (await page.locator('main').innerText()).toLowerCase();
    for (const jargon of ['post ', 'json', 'endpoint', 'd1 ', 'binding', 'environment variable', 'http request']) {
      expect(text, `Setup should not say "${jargon.trim()}"`).not.toContain(jargon);
    }
  });

  test('does not scroll sideways', async ({ page }) => {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

/**
 * The week's one job, on the screen that announces it.
 *
 * The flow this replaces was Setup → Newsletter → the issue → Copy, which is
 * four taps of navigation for the only thing anybody does with a newsletter. So
 * while an issue is waiting the two controls are drawn directly under the row
 * that says it is waiting, and they name the issue they act on.
 *
 * The three things that can go wrong with a temporary control are all here: it
 * has to appear when there is work, it has to say which work, and it must not
 * become furniture — which is checked by it not being anywhere else, the
 * taskbar included (§4, §16).
 */
test.describe('the newsletter waiting to be scored', () => {
  test.beforeEach(async ({ page }) => openSetup(page));

  test('offers both controls directly under the Newsletter row', async ({ page }) => {
    const row = page.getByTestId('setup-step-newsletter');
    await expect(row).toHaveAttribute('data-state', 'warn');
    await expect(row).toContainText('waiting to be scored');

    const actions = page.getByTestId('setup-pending-tally');
    await expect(actions).toBeVisible();
    await expect(actions.getByTestId('copy-for-chatgpt')).toBeVisible();
    await expect(actions.getByTestId('open-paste-tally')).toBeVisible();
    // It names the issue, so nobody has to go and find which one is meant.
    await expect(actions.getByTestId('setup-pending-tally-subject')).toContainText('Camp Report: Week 2');

    // Immediately after the row it belongs to, and inside the same group.
    const order = await page.evaluate(() => {
      const rowEl = document.querySelector('[data-testid="setup-step-newsletter"]')!;
      const next = rowEl.nextElementSibling;
      return {
        isActions: next?.getAttribute('data-testid') === 'setup-pending-tally',
        sameGroup: next?.parentElement === rowEl.parentElement,
      };
    });
    expect(order).toEqual({ isActions: true, sameGroup: true });
  });

  test('is reachable without opening the Newsletter panel at all', async ({ page }) => {
    // The panel is a pushed screen; if it were open this would be showing.
    await expect(page.getByTestId('panel-newsletter')).toHaveCount(0);
    await expect(page.getByTestId('setup-pending-tally').getByTestId('copy-for-chatgpt')).toBeVisible();
  });

  test('is easy to tap and does not push the page sideways', async ({ page }) => {
    for (const id of ['copy-for-chatgpt', 'open-paste-tally']) {
      const box = await page.getByTestId('setup-pending-tally').getByTestId(id).boundingBox();
      expect(box!.height, `${id} is a tap target`).toBeGreaterThanOrEqual(44);
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('stays out of the taskbar', async ({ page }) => {
    const bar = await page.locator('.tabbar').innerText();
    expect(bar.toLowerCase()).not.toContain('chatgpt');
    expect(bar.toLowerCase()).not.toContain('tally');
    expect(bar.toLowerCase()).not.toContain('newsletter');
  });

  /**
   * The approval gate, opened from Setup rather than from four taps in.
   *
   * Deliberately stops at the preview: applying would score the one unfinished
   * issue on a dev server four browser projects share, and take this whole
   * describe away from whichever of them ran second. That the preview writes
   * nothing is precisely what makes stopping here safe — and it is asserted, by
   * the controls still being on screen afterwards.
   */
  test('previews what would change without writing anything', async ({ page }) => {
    await page.getByTestId('setup-pending-tally').getByTestId('open-paste-tally').click();
    const sheet = page.getByTestId('paste-tally-sheet');
    await expect(sheet).toBeVisible();

    await sheet
      .getByTestId('paste-tally-input')
      .fill(
        [
          'NEWSLETTER_TALLY_V1',
          'Owen Fitzgerald | +2 | Ran with the starters all week.',
          'END_NEWSLETTER_TALLY',
        ].join('\n'),
      );
    await sheet.getByTestId('paste-tally-check').click();

    const preview = sheet.getByTestId('paste-tally-preview');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('Owen Fitzgerald');
    await expect(preview).toContainText('Ready to apply');
    // The primary action says what it does, and there is a way back out.
    await expect(sheet.getByTestId('paste-tally-apply')).toContainText('Process tally');
    await sheet.getByTestId('paste-tally-cancel').click();

    await expect(sheet).toHaveCount(0);
    // Nothing was written, so the work is still waiting.
    await expect(page.getByTestId('setup-pending-tally')).toBeVisible();
  });
});

/**
 * Setup does not scroll sideways *with the newsletter panel populated either*.
 *
 * The test above checks the overview, where every panel is closed, and it
 * passed throughout the months this defect was live. What it could not see: the
 * newsletter activity table prints the address the last issue arrived from, an
 * address is a run of text with no spaces in it, and a table under the auto
 * layout algorithm is never narrower than the longest such run. `width: 100%`
 * does not cap that — it is a preference, not a maximum. So a long sender grew
 * the table to 383.6px inside a 342px column and the document to 408px inside a
 * 390px viewport.
 *
 * Eighteen pixels of horizontal scroll is not, in itself, what a user notices.
 * What they notice is that `Parse / Preview` in the paste-tally sheet cannot be
 * tapped, because the shifted page puts the textarea over it — which is what
 * the two tests further down this file had been failing on, and what had been
 * repeatedly dismissed, including by me, as an order-dependent quirk of the
 * suite rather than the product defect it was.
 *
 * So this asserts both halves: no overflow, and the button still takes its own
 * tap. The state is built here rather than inherited from whichever tests ran
 * first, because a regression that depends on execution order is how the
 * original went unnoticed.
 */
test.describe('setup with a populated newsletter', () => {
  test('does not scroll sideways, and the paste-tally button still takes its tap', async ({
    page,
  }, testInfo) => {
    /*
     * A sender whose *domain* is long and has no hyphen in it.
     *
     * Both halves matter. The address is masked before it reaches the client —
     * `w***@…` — and masking replaces only the local part, so the domain is
     * what sets the width either way. And a hyphen is a line-break
     * opportunity: the first version of this fixture used
     * `long-newsletter-domain.example`, which wrapped itself and passed
     * against the unfixed layout, proving nothing. The address that exposed
     * the defect in the wild had no hyphens.
     *
     * Unique per project because all four share one dev server and this is
     * real ingested mail.
     */
    const slug = testInfo.project.name.replace(/[^a-z0-9]/gi, '');
    await page.goto('/');
    const res = await page.request.post('/api/newsletter/ingest', {
      data: {
        messageId: `overflow-regression-${slug}`,
        from: `weekly@${slug}newsletterdeliverydomain.example`,
        subject: 'Week 1 Notes',
        date: new Date().toISOString(),
        html: '<p>Bijan Robinson was named the starter.</p>',
      },
    });
    expect(res.ok()).toBeTruthy();

    await openSetup(page);
    await page.getByTestId('setup-step-newsletter').click();
    const activity = page.getByTestId('newsletter-activity');
    await expect(activity).toBeVisible();
    // The address really is on screen: an assertion about wrapping is worthless
    // if the thing that has to wrap was never rendered.
    await expect(activity).toContainText('newsletterdeliverydomain.example');

    /*
     * The measurement names what overflowed, not just that something did.
     *
     * "Setup scrolls sideways by 18px" sends the next reader hunting through a
     * page of panels; "TABLE.compact[newsletter-activity] reaches 407.6 in a
     * 390 viewport" is the bug. Worth the few lines: the defect this test
     * exists for went unexplained for months.
     */
    const measured = await page.evaluate(() => {
      const doc = document.documentElement;
      const table = document.querySelector('[data-testid="newsletter-activity"]')!.getBoundingClientRect();
      const offenders: string[] = [];
      for (const el of document.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > doc.clientWidth + 0.5) {
          const id = el.getAttribute('data-testid');
          offenders.push(
            `${el.tagName}${id ? `[${id}]` : `.${String(el.className).split(' ')[0]}`} ` +
              `x=${r.left.toFixed(0)} w=${r.width.toFixed(1)} right=${r.right.toFixed(1)}`,
          );
        }
      }
      return {
        overflow: doc.scrollWidth - doc.clientWidth,
        viewport: doc.clientWidth,
        tableRight: table.right,
        offenders: offenders.slice(0, 6),
      };
    });
    expect(
      measured.overflow,
      `Setup scrolls sideways by ${measured.overflow}px in a ${measured.viewport}px viewport. ` +
        `Overflowing: ${measured.offenders.join(' | ') || 'nothing measurable'}`,
    ).toBeLessThanOrEqual(1);
    // And the table is inside the viewport rather than merely not scrolling it.
    expect(measured.tableRight).toBeLessThanOrEqual(measured.viewport + 1);

    /*
     * The interaction the overflow actually broke.
     *
     * A short timeout on purpose: Playwright retries an intercepted click for
     * the full test timeout, so the default would turn a layout regression into
     * a thirty-second stall before failing. Four seconds is far longer than a
     * sheet takes to settle and short enough to read as what it is.
     */
    const message = page.locator('[data-testid="newsletter-message"][data-status="processed"]').first();
    const toggle = message.getByTestId('newsletter-message-toggle');
    await toggle.scrollIntoViewIfNeeded();
    await toggle.click();
    await message.getByTestId('chat-tally-panel').getByTestId('open-paste-tally').click();

    const sheet = page.getByTestId('paste-tally-sheet');
    await expect(sheet).toBeVisible();
    await sheet
      .getByTestId('paste-tally-input')
      .fill(['NEWSLETTER_TALLY_V1', 'not a tally at all', 'END_NEWSLETTER_TALLY'].join('\n'));
    await sheet.getByTestId('paste-tally-check').click({ timeout: 4000 });
    // It answered, which is only possible if the tap reached the button.
    await expect(sheet.getByTestId('paste-tally-preview')).toBeVisible();
  });
});

/**
 * Appearance.
 *
 * The preference lives on the device, so these run against a fresh context's
 * empty storage: System until somebody chooses otherwise, and the choice
 * applied before the first paint on the next visit.
 */
test.describe('appearance', () => {
  test('offers System, Light and Dark, and starts on System', async ({ page }) => {
    await openSetup(page);
    await expect(page.getByTestId('appearance')).toBeVisible();
    for (const mode of ['system', 'light', 'dark']) {
      await expect(page.getByTestId(`appearance-${mode}`)).toBeVisible();
    }
    await expect(page.getByTestId('appearance-system')).toHaveAttribute('aria-pressed', 'true');
    // System means the stylesheet follows the phone; nothing is pinned.
    expect(await page.locator('html').getAttribute('data-theme')).toBeNull();
  });

  test('applies a choice at once, keeps it across a reload, and can go back to System', async ({ page }) => {
    await openSetup(page);

    await page.getByTestId('appearance-dark').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

    // Applied before the first paint on the next visit, not after React boots.
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.getByTestId('tab-setup').click();
    await page.getByTestId('appearance-light').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(light, 'the two themes must actually differ').not.toBe(dark);

    // Text stays readable in both: the page and its type are never the same colour.
    const text = await page.evaluate(() => getComputedStyle(document.body).color);
    expect(text).not.toBe(light);

    await page.getByTestId('appearance-system').click();
    expect(await page.locator('html').getAttribute('data-theme')).toBeNull();
  });

  test('a theme choice changes nothing but the theme', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('tab-draft').click();
    const rows = await page.getByTestId('recommendation-row').count();
    const first = await page.getByTestId('recommendation-row').first().innerText();

    await page.getByTestId('tab-setup').click();
    await page.getByTestId('appearance-dark').click();
    await page.getByTestId('tab-draft').click();

    await expect(page.getByTestId('recommendation-row')).toHaveCount(rows);
    expect(await page.getByTestId('recommendation-row').first().innerText()).toBe(first);

    await page.getByTestId('tab-setup').click();
    await page.getByTestId('appearance-system').click();
  });

  test('does not scroll sideways in either theme', async ({ page }) => {
    await openSetup(page);
    for (const mode of ['dark', 'light', 'system']) {
      await page.getByTestId(`appearance-${mode}`).click();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${mode} overflows horizontally`).toBeLessThanOrEqual(1);
    }
  });
});

test.describe('newsletter setup', () => {
  test.beforeEach(async ({ page }) => {
    await openSetup(page);
    await page.getByTestId('setup-step-newsletter').click();
    await expect(page.getByTestId('panel-newsletter')).toBeVisible();
  });

  test('shows the dedicated address and how to use it', async ({ page }) => {
    await expect(page.getByTestId('newsletter-address')).toHaveText('fantasy-news@demo.example');
    await expect(page.getByTestId('panel-newsletter')).toContainText('Subscribe your FF Newsletter to this address');
    await expect(page.getByTestId('panel-newsletter')).toContainText('never need to forward');
  });

  test('lets the user set which sender to accept', async ({ page }) => {
    await page.getByLabel('Or only accept one sender (address or domain)').fill('news@theirsite.com');
    await page.getByRole('button', { name: 'Save sender' }).click();
    await expect(page.locator('.notice')).toContainText('Mail from that sender will now be read');
  });

  test('offers to accept a sender whose mail arrived and was ignored', async ({ page }, testInfo) => {
    // Nobody should have to look up their newsletter's from-address. Subscribe,
    // let the first issue be ignored, then accept the address it actually came
    // from — which is exactly what happens here.
    //
    // The sender is unique per project because all projects share one dev
    // server: accepting a sender is a real state change, so a fixed address
    // would only be un-accepted on the first project to run.
    const slug = testInfo.project.name.replace(/[^a-z0-9]/gi, '');
    const unexpected = `weekly@${slug}.newsletter.example`;

    const res = await page.request.post('/api/newsletter/ingest', {
      data: {
        messageId: `unexpected-sender-${slug}`,
        from: unexpected,
        subject: 'Week 1 Notes',
        date: new Date().toISOString(),
        html: '<p>Bijan Robinson was named the starter.</p>',
      },
    });
    expect(res.ok()).toBeTruthy();

    await openSetup(page);
    await page.getByTestId('setup-step-newsletter').click();

    const offer = page.getByTestId('offer-sender');
    await expect(offer).toBeVisible();
    await expect(offer).toContainText(unexpected);

    await offer.getByTestId('accept-sender').click();
    await expect(page.locator('.notice')).toContainText(`Mail from ${unexpected} will be read`);

    // Once accepted it is no longer an open question.
    await expect(page.getByTestId('offer-sender')).toHaveCount(0);
  });

  /**
   * Presence only. Clicking it would switch the sender rule for the whole
   * shared dev server, and the tests after this one depend on that state — the
   * behaviour itself is covered in newsletter.pipeline.test.ts against the real
   * bounce envelope Substack delivered from.
   */
  test('offers to accept every sender at this address', async ({ page }) => {
    await expect(page.getByTestId('accept-any-sender')).toBeVisible();
    await expect(page.getByTestId('panel-newsletter')).toContainText('Nothing else uses this address');
  });

  test('rejects an obviously wrong sender in plain words', async ({ page }) => {
    await page.getByLabel('Or only accept one sender (address or domain)').fill('not an address');
    await page.getByRole('button', { name: 'Save sender' }).click();
    // Scoped to this panel: Setup can carry other notices (Help my scores), and
    // a bare `.notice` would match several.
    await expect(page.getByTestId('panel-newsletter').locator('.notice')).toContainText('does not look like');
  });

  test('reports activity for the seeded newsletter', async ({ page }) => {
    const activity = page.getByTestId('newsletter-activity');
    await expect(activity).toContainText('Last email received');
    await expect(activity).toContainText('Waiting for your review');
    // The demo world always has an issue that has not been scored yet.
    await expect(activity).toContainText('Waiting to be scored');
  });

  /**
   * How much text came out of the email, and nothing about what it means.
   *
   * This used to check for "Read but no rule matched" — the classifier's report
   * card on the football in an issue. Arrival makes no such judgment now, so
   * what is left is the question arrival can honestly answer: did the email
   * decode into readable text, and how much of it is there to hand over.
   */
  test('shows how much readable text came out of each email', async ({ page }) => {
    const message = page.locator('[data-testid="newsletter-message"][data-message-id="demo-message-1"]');
    await expect(message).toBeVisible();
    // The list grows as earlier tests add mail, so the row can sit below the
    // fold; scroll it in before clicking rather than relying on auto-scroll.
    const toggle = message.getByTestId('newsletter-message-toggle');
    await toggle.scrollIntoViewIfNeeded();
    await toggle.click();
    await expect(message).toContainText('Readable sentences');
    await expect(message).toContainText('Sentences naming a player you have');
    await expect(message).not.toContainText('Read but no rule matched');
    await expect(message).not.toContainText('Turned into a signal');
  });

  /** The seeded world always has one scored issue and one still waiting. */
  test('says which issues have been scored and which are waiting', async ({ page }) => {
    await expect(
      page.locator('[data-testid="newsletter-message"][data-message-id="demo-message-1"]'),
    ).toHaveAttribute('data-tally-state', 'applied');
    await expect(
      page.locator('[data-testid="newsletter-message"][data-message-id="demo-message-2"]'),
    ).toContainText('waiting to be scored');
  });

  /**
   * The weekly import, end to end in the browser.
   *
   * The judgment in the block is not the app's to check, so what this asserts is
   * everything around it: that nothing is written on paste, that a matched row
   * and an unresolvable one are told apart before anything happens, and that
   * applying twice is not a way to count a week twice.
   */
  test('imports a ChatGPT tally, previewing before it writes and refusing to double count', async ({
    page,
  }, testInfo) => {
    /*
     * This test brings its own newsletter, and that is not fastidiousness.
     *
     * Four browser projects share one dev server and its database survives
     * between runs, so a test that scores a *seeded* issue is a test that
     * rewrites the world the specs after it read. The seeded ledger is what
     * Trades and the draft board have opinions about, and the seeded unscored
     * issue is the whole subject of the describe above this one — consuming
     * either would break whichever project ran second, in a spec that never
     * mentions newsletters.
     *
     * A row's identity also includes its reason, so the reason varies per
     * project and per run: a fixed one would come back "already imported" the
     * second time this ever ran, and the first half of this test would be
     * asserting nothing.
     */
    const issueId = `e2e-tally-${testInfo.project.name}-${Date.now()}`;
    const reason = `Full command of the backfield (${issueId})`;
    const received = await page.request.post('/api/newsletter/ingest', {
      data: {
        messageId: issueId,
        from: 'editor@demo.newsletter',
        subject: `Weekly notes ${issueId}`,
        date: new Date().toISOString(),
        html: `<p>${issueId}: Marcus Vance took every first-team rep this week.</p>`,
        force: true,
      },
    });
    expect(received.status()).toBe(200);
    await page.reload();
    await expect(page.getByTestId('panel-newsletter')).toBeVisible();

    const message = page.locator(`[data-testid="newsletter-message"][data-message-id="${issueId}"]`);
    const toggle = message.getByTestId('newsletter-message-toggle');
    await toggle.scrollIntoViewIfNeeded();
    await toggle.click();

    const panel = message.getByTestId('chat-tally-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('copy-for-chatgpt')).toBeVisible();

    await panel.getByTestId('open-paste-tally').click();
    const sheet = page.getByTestId('paste-tally-sheet');
    await expect(sheet).toBeVisible();

    // A real reply: one name the dictionary knows, one it cannot pin down.
    await sheet.getByTestId('paste-tally-input').fill(
      [
        'NEWSLETTER_TALLY_V1',
        `Marcus Vance | +2 | ${reason}`,
        'Somebody Nobody | +1 | Not in the player list at all',
        'END_NEWSLETTER_TALLY',
      ].join('\n'),
    );
    await sheet.getByTestId('paste-tally-check').click();

    const preview = sheet.getByTestId('paste-tally-preview');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('Marcus Vance');
    await expect(preview).toContainText('Ready to apply');
    // The one that cannot be resolved is named rather than silently dropped.
    await expect(preview).toContainText('Needs review');
    await expect(preview).toContainText('not in the player list');

    /*
     * Revise the paste before applying it, and apply only the row that resolved.
     *
     * The preview above is where the unresolvable row has to be named, and it
     * is named. Writing it is a different matter: an applied unmatched tally is
     * global state — the draft board carries a three-line warning about it,
     * which pushes the list down and costs two players above the fold, and two
     * density tests measure exactly that. Four projects share one dev server
     * here, so whichever of them applied one would fail the other three.
     *
     * That is not hypothetical and it is not old news: this test used to time
     * out at `Parse / Preview` — see the horizontal-overflow defect fixed
     * alongside this — so it never reached the apply and never wrote the row.
     * Fixing the layout is what let it finish, and what made this matter.
     *
     * Re-previewing after an edit is also the honest flow: the apply button
     * writes the block that was previewed, so changing the text has to mean
     * previewing it again.
     */
    await sheet
      .getByTestId('paste-tally-input')
      .fill(['NEWSLETTER_TALLY_V1', `Marcus Vance | +2 | ${reason}`, 'END_NEWSLETTER_TALLY'].join('\n'));
    await sheet.getByTestId('paste-tally-check').click();
    await expect(preview).toContainText('Ready to apply');
    await expect(preview).not.toContainText('Needs review');

    await sheet.getByTestId('paste-tally-apply').click();
    await expect(panel).toContainText('applied');

    // Second time round, the same block is already in the ledger.
    await panel.getByTestId('open-paste-tally').click();
    const again = page.getByTestId('paste-tally-sheet');
    await again.getByTestId('paste-tally-input').fill(
      [
        'NEWSLETTER_TALLY_V1',
        `Marcus Vance | +2 | ${reason}`,
        'END_NEWSLETTER_TALLY',
      ].join('\n'),
    );
    await again.getByTestId('paste-tally-check').click();
    await expect(again.getByTestId('paste-tally-preview')).toContainText('Nothing would change');
    await expect(again.getByTestId('paste-tally-apply')).toBeDisabled();

  });

  test('says plainly when a paste is not a tally', async ({ page }) => {
    const message = page.locator('[data-testid="newsletter-message"][data-status="processed"]').first();
    const toggle = message.getByTestId('newsletter-message-toggle');
    await toggle.scrollIntoViewIfNeeded();
    await toggle.click();

    await message.getByTestId('chat-tally-panel').getByTestId('open-paste-tally').click();
    const sheet = page.getByTestId('paste-tally-sheet');
    await sheet.getByTestId('paste-tally-input').fill('here are my thoughts about the week');
    await sheet.getByTestId('paste-tally-check').click();
    await expect(sheet.getByTestId('paste-tally-preview')).toContainText('NEWSLETTER_TALLY_V1');
  });
});

test.describe('rankings import', () => {
  test('says plainly that Sleeper publishes no ADP', async ({ page }) => {
    await openSetup(page);
    await page.getByTestId('setup-step-adp').click();
    await expect(page.getByTestId('adp-source')).toContainText('does not publish average draft position');
  });

  test('imports a pasted file and reports what happened', async ({ page }, testInfo) => {
    await openSetup(page);
    await page.getByTestId('setup-step-adp').click();
    await expect(page.getByTestId('panel-adp')).toBeVisible();
    await page.getByText('Import rankings', { exact: true }).click();

    // Snapshots dedupe on content, and the server is shared across projects.
    const unique = `Ghost ${testInfo.project.name}`;
    await page
      .getByLabel('…or paste the file contents')
      .fill(`name,position,team,adp\nMarcus Vance,RB,KC,2.4\n${unique},WR,SEA,140\n`);
    await page.getByRole('button', { name: /Import rankings|Replace rankings/ }).click();

    const result = page.getByTestId('adp-result');
    await expect(result).toBeVisible();
    await expect(result).toContainText('Matched to a player');
    await expect(result).toContainText('Not recognised');
    await expect(page.getByTestId('panel-adp')).toContainText('are kept, not thrown away');
  });

  test('offers a file picker as well as pasting', async ({ page }) => {
    await openSetup(page);
    await page.getByTestId('setup-step-adp').click();
    await page.getByText('Import rankings', { exact: true }).click();
    await expect(page.getByTestId('adp-file')).toBeVisible();
  });
});

test.describe('vegas', () => {
  test('says plainly that live lines are not connected', async ({ page }) => {
    await openSetup(page);
    await page.getByTestId('setup-step-vegas').click();
    const panel = page.getByTestId('panel-vegas');
    await expect(panel).toContainText('Not connected yet');
    await expect(panel).toContainText('Nothing to do here yet');
  });

  /**
   * Season-long markets are a different question from Sunday's lines, and get
   * their own answer: how much is stored, how old it is, and — when there is
   * nothing — the reason, rather than an empty section.
   */
  test('reports what season-long market data exists, and how fresh it is', async ({ page }) => {
    await openSetup(page);
    await page.getByTestId('setup-step-vegas').click();
    const panel = page.getByTestId('panel-vegas');
    await expect(panel).toContainText('Season outlook');
    const health = page.getByTestId('season-market-health');
    await expect(health).toBeVisible();
    // The demo seeds a mock season snapshot, so it reports coverage and age.
    await expect(health).toContainText(/market line|Nothing stored/);
    await expect(panel).toContainText('the card says nothing rather than guessing');
  });

  /**
   * The month's allowance, in plain words.
   *
   * Not a control — there is nothing here to act on. It exists so a quota
   * problem is visible while it is still a number rather than an outage, which
   * is the whole reason the budget is tracked at all.
   */
  test('shows what is left of the month’s provider allowance', async ({ page }) => {
    await openSetup(page);
    await page.getByTestId('setup-step-vegas').click();
    const panel = page.getByTestId('panel-vegas');
    await expect(panel).toContainText('This month\u2019s allowance');

    const budget = page.getByTestId('vegas-budget');
    await expect(budget).toBeVisible();
    // "n of 2500 used in YYYY-MM", and a state said in words rather than a code.
    await expect(budget).toContainText(/\d+ of \d+/);
    await expect(budget).toContainText(/plenty left|over half used|running low|into the reserve/);
    await expect(panel).toContainText('only about the games your own players are in');
  });

  test('reports the budget without asking the provider for anything', async ({ page }) => {
    // The diagnostics route reads the ledger. If it ever started fetching, this
    // is the test that would have to be deleted to keep it passing.
    const response = await page.request.get('/api/vegas/budget');
    expect(response.ok()).toBeTruthy();
    const body = (await response.json()) as {
      budget: { limit: number; state: string; used: number };
      nextPlan: { estimatedEntities: number };
    };
    expect(body.budget.limit).toBeGreaterThan(0);
    expect(['healthy', 'caution', 'conservation', 'hard_stop']).toContain(body.budget.state);
    expect(body.nextPlan.estimatedEntities).toBeGreaterThanOrEqual(0);
  });
});

test.describe('review actions added for setup', () => {
  test('can reassign an item to the right player', async ({ page }, testInfo) => {
    // Give this project its own reviewable item.
    await page.request.post('/api/newsletter/ingest', {
      data: {
        messageId: `e2e-wrong-player-${testInfo.project.name}`,
        from: 'editor@demo.newsletter',
        subject: 'Camp Report',
        date: new Date().toISOString(),
        html:
          `<p>Issue ${testInfo.project.name} / wrong-player.</p>` +
          '<p>Julian Reyes returned to practice but is expected to split work in a committee.</p>',
        force: true,
      },
    });

    await page.goto('/');
    await openReview(page);
    // Earlier specs may have queued their own items, so assert on the change
    // this test causes rather than on the whole queue.
    const reyesCards = page.getByTestId('review-card').filter({ hasText: 'Julian Reyes' });
    // A bare count() does not retry, so it can run before the queue has
    // rendered. Wait for the card to exist, then count.
    await expect(reyesCards.first()).toBeVisible();
    const before = await reyesCards.count();

    const card = reyesCards.first();
    await expect(card.getByTestId('review-reason')).toBeVisible();
    await card.getByRole('button', { name: 'Wrong player' }).click();
    await expect(card.getByTestId('player-picker')).toBeVisible();
    await card.getByLabel('Which player is this really about?').fill('Kowalski');
    await card.getByRole('button', { name: /Nate Kowalski/ }).click();

    await expect(reyesCards).toHaveCount(before - 1);
  });

  test('keeps already-applied items inspectable', async ({ page }) => {
    await page.goto('/');
    await openReview(page);
    await page.getByRole('button', { name: /Already applied/ }).click();
    await expect(page.getByTestId('applied-card').first()).toBeVisible();
    await expect(page.getByTestId('applied-card').first()).toContainText('Why:');
  });
});
