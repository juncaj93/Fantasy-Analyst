/**
 * The Setup experience on an iPhone.
 *
 * These tests are the guard against Setup drifting back into developer
 * vocabulary: they check the five status rows, the newsletter address and
 * subscribe instruction, ADP import feedback, and that nothing on screen asks
 * the user to understand HTTP.
 */

import { expect, test, type Page } from '@playwright/test';

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
  });

  test('shows what the parser understood in each email', async ({ page }) => {
    // Explicitly a processed message: ignored mail has no coverage to show, and
    // other tests add ignored mail to this shared server.
    const message = page.locator('[data-testid="newsletter-message"][data-status="processed"]').first();
    await expect(message).toBeVisible();
    // The list grows as earlier tests add mail, so the row can sit below the
    // fold; scroll it in before clicking rather than relying on auto-scroll.
    const toggle = message.getByTestId('newsletter-message-toggle');
    await toggle.scrollIntoViewIfNeeded();
    await toggle.click();
    await expect(message).toContainText('Sentences about your players');
    await expect(message).toContainText('Read but no rule matched');
  });

  test('previews a re-read before changing anything, and is honest about what it will not change', async ({
    page,
  }) => {
    // Only processed mail has a body kept, so only it can be re-read.
    const message = page.locator('[data-testid="newsletter-message"][data-status="processed"]').first();
    const toggle = message.getByTestId('newsletter-message-toggle');
    await toggle.scrollIntoViewIfNeeded();
    await toggle.click();

    const panel = message.getByTestId('reprocess-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Nothing changes until you say so');

    await panel.getByTestId('reprocess-preview').click();

    // The same newsletter, unchanged rules: there is genuinely nothing to add,
    // and the button must say so rather than inviting a pointless write.
    await expect(panel).toContainText('Nothing new would be added');
    await expect(panel.getByTestId('reprocess-apply')).toBeDisabled();
    await expect(panel.getByTestId('reprocess-apply')).toContainText('Nothing to add');
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
    await page.getByTestId('tab-review').click();
    // Earlier specs may have queued their own items, so assert on the change
    // this test causes rather than on the whole queue.
    const reyesCards = page.getByTestId('review-card').filter({ hasText: 'Julian Reyes' });
    // A bare count() does not retry, so it can run before the queue has
    // rendered. Wait for the card to exist, then count.
    await expect(reyesCards.first()).toBeVisible();
    const before = await reyesCards.count();

    const card = reyesCards.first();
    await expect(card.getByTestId('review-reason')).toBeVisible();
    await card.getByRole('button', { name: '⇄ Wrong player' }).click();
    await expect(card.getByTestId('player-picker')).toBeVisible();
    await card.getByLabel('Which player is this really about?').fill('Kowalski');
    await card.getByRole('button', { name: /Nate Kowalski/ }).click();

    await expect(reyesCards).toHaveCount(before - 1);
  });

  test('keeps already-applied items inspectable', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('tab-review').click();
    await page.getByRole('button', { name: /Already applied/ }).click();
    await expect(page.getByTestId('applied-card').first()).toBeVisible();
    await expect(page.getByTestId('applied-card').first()).toContainText('Why:');
  });
});
