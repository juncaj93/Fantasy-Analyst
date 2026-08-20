/**
 * The shell, as a contract.
 *
 * The visual pass turned "what a screen looks like" into a small number of
 * shared decisions — a compact navigation bar, a tab bar of a fixed height, a
 * spacing rhythm, and a list that starts high on the page. Those are the parts
 * that quietly regress, one component at a time, until the app is a dashboard
 * again, so they are asserted as numbers here rather than described in a
 * document.
 *
 * Nothing in this file knows anything about fantasy football: it measures the
 * shell. What the screens *say* is covered by app.spec.ts and setup.spec.ts,
 * and neither changed.
 */

import { expect, test, type Page } from '@playwright/test';

const TABS = ['draft', 'team', 'trades', 'players', 'review', 'setup'] as const;

async function open(page: Page, tab: (typeof TABS)[number]) {
  await page.getByTestId(`tab-${tab}`).click();
  await page.waitForTimeout(350);
}

/**
 * Every background on a page, as comparable 0–255 triples.
 *
 * `getComputedStyle` does not answer in one syntax: a plain token comes back as
 * `rgb(255, 255, 255)`, but the resolved value of a `color-mix()` comes back as
 * `color(srgb 0.98 0.98 1)`. Comparing those as strings makes two identical
 * colours look different, and comparing their digits makes a white row look 254
 * away from white. So each colour is painted onto a 1×1 canvas and read back,
 * which is the one reading that is the same for every syntax.
 */
const NORMALISE = `(colour) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = '#000';
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, 1, 1);
  return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
}`;

/** The rows' own painted backgrounds, in source order. */
function backgrounds(page: Page, selector: string) {
  return page.locator(selector).evaluateAll(
    (els, normaliseSource) => {
      const normalise = eval(normaliseSource) as (c: string) => number[];
      return els.map((el) => normalise(getComputedStyle(el).backgroundColor));
    },
    NORMALISE,
  );
}

/** What `var(--surface)` currently resolves to, painted the same way. */
function surfaceColour(page: Page) {
  return page.evaluate((normaliseSource) => {
    const normalise = eval(normaliseSource) as (c: string) => number[];
    /*
     * Measured against the token rather than against the group element, which
     * reports `rgba(0, 0, 0, 0)` often enough — a container that paints nothing
     * of its own — to make the comparison meaningless.
     */
    const probe = document.createElement('div');
    probe.style.background = 'var(--surface)';
    document.body.append(probe);
    const painted = normalise(getComputedStyle(probe).backgroundColor);
    probe.remove();
    return painted;
  }, NORMALISE);
}

test.describe('the navigation bar', () => {
  test('every screen has one, and none of them is a banner', async ({ page }) => {
    await page.goto('/');
    for (const tab of TABS) {
      await open(page, tab);
      const bar = page.locator('.nav-bar').first();
      await expect(bar, `${tab} has no navigation bar`).toBeVisible();
      const box = (await bar.boundingBox())!;
      // A title, its qualifier and the screen's actions. Anything taller is a
      // hero header, which is the thing this replaced.
      expect(box.height, `${tab}'s bar is a banner at ${box.height}px`).toBeLessThanOrEqual(64);
      expect(box.y, `${tab}'s bar does not start at the top`).toBeLessThanOrEqual(2);
    }
  });

  test('stays on screen while the board is scrolled', async ({ page }) => {
    await page.goto('/');
    await open(page, 'draft');
    await expect(page.getByTestId('board-list')).toBeVisible();

    const before = await page.getByTestId('draft-status').innerText();
    await page.evaluate(() => window.scrollTo(0, 600));
    await page.waitForTimeout(250);

    const bar = page.getByTestId('draft-nav');
    const box = (await bar.boundingBox())!;
    expect(box.y, 'the live draft state must not scroll away').toBeLessThanOrEqual(2);
    // …and it is still saying the same thing, not a stale copy left behind.
    expect(await page.getByTestId('draft-status').innerText()).toBe(before);
  });

  test('carries the live draft state that used to cost a row of cards', async ({ page }) => {
    await page.goto('/');
    await open(page, 'draft');
    const bar = page.getByTestId('draft-nav');
    await expect(bar).toContainText('Demo Dynasty');
    await expect(bar.getByTestId('draft-status')).toContainText('#3');
    await expect(bar.getByTestId('draft-status')).toContainText('R1');
    await expect(bar.getByTestId('draft-refresh')).toBeVisible();
  });
});

test.describe('density', () => {
  /**
   * How much of the first screen is the thing the user came for.
   *
   * Stated as a number because "denser" is otherwise an opinion that drifts.
   * The measurement is rows fully above the floating toolbar on the smallest
   * supported phone — the toolbar's own top edge, asked for rather than
   * guessed, so the count cannot quietly improve by the bar getting shorter.
   */
  async function rowsOnFirstScreen(page: Page, testId: string) {
    const floor = await page.evaluate(() => document.querySelector('.tabbar')!.getBoundingClientRect().top);
    const rows = page.getByTestId(testId);
    const count = await rows.count();
    let visible = 0;
    for (let i = 0; i < count; i++) {
      const box = await rows.nth(i).boundingBox();
      if (box && box.y + box.height <= floor) visible++;
    }
    return visible;
  }

  /**
   * Eight, measured, on all three phones.
   *
   * The search field used to hold a row of its own above the position filters,
   * and the first card started 177px down the page; folded into a glyph beside
   * them it starts at 129px. That is worth an eighth whole row on the smallest
   * supported phone — 360×800 fitted seven before — and 31px more of the list
   * on the other two, where the eighth row already fitted.
   *
   * This number is the whole justification for the change, so it is asserted
   * rather than described: if a later pass spends the space on padding again,
   * this fails.
   *
   * ## Why this is no longer a count of rows
   *
   * It was, and counting rows made it hostage to something it was never
   * written to measure. A card is 58px ordinarily, 75px carrying a tally and
   * 92px carrying a tier warning — deliberately, because a warning needs the
   * line — so how many rows clear the toolbar depends on *which players happen
   * to be at the top of the demo board*. When the positional-structure cap
   * landed it reordered the board by a few hundredths and moved one 92px
   * warned card from tenth to seventh, and the count went 8 → 7 with no space
   * spent anywhere: the list still starts at 129px and every card is still
   * exactly as tall as it was.
   *
   * So both halves of the claim are asserted directly instead. The chrome
   * above the list is the thing the fold-the-search change actually bought,
   * and the depth of the first screen is measured in ordinary cards, which is
   * what "spends the space on padding" would move. A padding regression fails
   * this exactly as it did before; a reordered board no longer does.
   */
  test('the draft board shows at least eight players before a scroll', async ({ page }) => {
    // No tap: Draft is where the app lands, and tapping the destination you are
    // already on clears the screen — which would measure a reset control rather
    // than the one a reader actually arrives at.
    await page.goto('/');
    await expect(page.getByTestId('board-list')).toBeVisible();
    await page.waitForTimeout(350);

    const measured = await page.evaluate(() => {
      const list = document.querySelector('[data-testid="board-list"]')!.getBoundingClientRect();
      const floor = document.querySelector('.tabbar')!.getBoundingClientRect().top;
      // The shortest card on screen is an ordinary one: no tally, no warning.
      const heights = [...document.querySelectorAll('[data-testid="recommendation-row"]')].map(
        (row) => row.getBoundingClientRect().height,
      );
      return { listTop: list.top, floor, ordinaryCard: Math.min(...heights) };
    });

    // 129px, and a pixel or two of rounding. Not 177.
    expect(measured.listTop, 'the chrome above the list has grown').toBeLessThanOrEqual(132);
    expect(
      Math.floor((measured.floor - measured.listTop) / measured.ordinaryCard),
      'the first screen is no longer eight ordinary cards deep',
    ).toBeGreaterThanOrEqual(8);
  });

  test('the players list shows at least seven', async ({ page }) => {
    await page.goto('/');
    await open(page, 'players');
    await expect(page.getByTestId('player-search-row').first()).toBeVisible();
    expect(await rowsOnFirstScreen(page, 'player-search-row')).toBeGreaterThanOrEqual(7);
  });

  test('Setup shows every step without scrolling', async ({ page }) => {
    await page.goto('/');
    await open(page, 'setup');
    const floor = await page.evaluate(() => document.querySelector('.tabbar')!.getBoundingClientRect().top);
    const last = (await page.getByTestId('setup-step-vegas').boundingBox())!;
    expect(last.y + last.height).toBeLessThanOrEqual(floor);
  });
});

test.describe('touch and reach', () => {
  test('every tab is a full target', async ({ page }) => {
    await page.goto('/');
    for (const tab of TABS) {
      const box = (await page.getByTestId(`tab-${tab}`).boundingBox())!;
      expect(box.height, `${tab} is only ${box.height}px tall`).toBeGreaterThanOrEqual(44);
    }
  });

  test('a settings row is a full target', async ({ page }) => {
    await page.goto('/');
    await open(page, 'setup');
    for (const id of ['sleeper', 'league', 'adp', 'newsletter', 'vegas']) {
      const box = (await page.getByTestId(`setup-step-${id}`).boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
  });

  test('nothing scrolls sideways, on any screen, in either theme', async ({ page }) => {
    await page.goto('/');
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      for (const tab of TABS) {
        await open(page, tab);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, `${tab} overflows sideways in ${theme}`).toBeLessThanOrEqual(1);
      }
    }
    await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  });
});

test.describe('the two themes are one design', () => {
  test('every screen keeps its text off its own background', async ({ page }) => {
    await page.goto('/');
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      await open(page, 'draft');
      const sample = await page.evaluate(() => {
        const row = document.querySelector('[data-testid="recommendation-row"]')!;
        const name = row.querySelector('.player-name')!;
        const nav = document.querySelector('.nav-bar')!;
        return {
          rowBackground: getComputedStyle(row).backgroundColor,
          nameColour: getComputedStyle(name).color,
          navBackground: getComputedStyle(nav).backgroundColor,
        };
      });
      expect(sample.nameColour).not.toBe(sample.rowBackground);
      // The bars are material, not a hole in the page: a transparent one lets
      // rows show through the blur as unreadable smear.
      expect(sample.navBackground).not.toBe('rgba(0, 0, 0, 0)');
    }
    await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  });

  /**
   * The tint moved from the row's edge to its surface, and only on Draft.
   *
   * It used to be a coloured rail down the leading edge of every list in the
   * app, which this asserted by reading `borderLeftColor`. Draft is now the one
   * board that carries a wash — faint, so the row is white first — and the rail
   * is gone, because two cues for one fact is one too many. So the reading
   * moves to the background, which is where the tint now is.
   */
  test('the position tint survives in both, and stays a tint', async ({ page }) => {
    await page.goto('/');
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      await open(page, 'draft');
      const painted = await backgrounds(page, '[data-testid="recommendation-row"]');
      expect(painted.length, 'the board drew no rows').toBeGreaterThan(4);
      const distinct = new Set(painted.map((c) => c.join(',')));
      expect(distinct.size, `positions are indistinguishable in ${theme}`).toBeGreaterThan(1);

      // …and it stays a *tint*: the row is still much closer to the list's own
      // surface than to the position's colour, which is what "white first"
      // means and what stops a board of forty being a rainbow.
      const surface = await surfaceColour(page);
      for (const own of painted) {
        const drift = Math.max(...own.map((v, i) => Math.abs(v - surface[i]!)));
        expect(
          drift,
          `a row drifts ${drift} from the list's own surface in ${theme}, which is a fill`,
        ).toBeLessThan(26);
      }

      // The letters are still there, so the colour is never the only carrier.
      const badges = await page.locator('[data-testid="recommendation-row"] .pos-pill').allInnerTexts();
      for (const badge of badges) expect(badge.trim()).toMatch(/^(QB|RB|WR|TE|K|DEF)$/);
    }
    await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  });

  /**
   * …and Draft is the only screen that has one.
   *
   * The whole point of giving the board a wash is that it reads as *the board*.
   * That only works if the lists around it are genuinely neutral, so this
   * checks the two densest ones are exactly their own surface.
   */
  test('and no other screen tints a row', async ({ page }) => {
    await page.goto('/');
    for (const tab of ['players', 'trades'] as const) {
      await open(page, tab);
      const testId = tab === 'players' ? 'player-search-row' : 'trade-row';
      await expect(page.getByTestId(testId).first()).toBeVisible();
      const painted = await backgrounds(page, `[data-testid="${testId}"]`);
      const distinct = new Set(painted.map((c) => c.join(',')));
      expect(distinct.size, `${tab} tints its rows by position`).toBe(1);
    }
  });
});

/**
 * Tapping the tab you are already on.
 *
 * The one control on screen with nothing left to do, so it gets the job iOS
 * gives it: back to the top, and clear what you had narrowed the screen down
 * to. It must clear the search and *only* the search — everything else on these
 * screens is stored state that a stray tap has no business touching.
 */
test.describe('the active tab, tapped again', () => {
  test('clears the search on Players', async ({ page }) => {
    await page.goto('/');
    await open(page, 'players');
    const search = page.getByLabel('Search players');
    await search.fill('vance');
    await page.waitForTimeout(400);
    const narrowed = await page.getByTestId('player-search-row').count();

    await page.getByTestId('tab-players').click();
    await expect(search).toHaveValue('');
    await page.waitForTimeout(400);
    expect(await page.getByTestId('player-search-row').count()).toBeGreaterThan(narrowed);
    // Still on Players: it clears the screen, it does not leave it.
    await expect(page.getByTestId('tab-players')).toHaveAttribute('aria-current', 'page');
  });

  test('clears the search on Draft, and nothing else', async ({ page }) => {
    await page.goto('/');
    await open(page, 'draft');
    // Narrow by position as well, so it is clear which one gets cleared.
    await page.getByRole('button', { name: 'QB', exact: true }).click();
    await page.getByTestId('draft-search-open').click();
    await page.getByTestId('draft-search').fill('lind');
    await expect(page.getByTestId('recommendation-row')).toHaveCount(1);

    await page.getByTestId('tab-draft').click();
    // The query is gone and the field has folded back to its glyph, which is
    // what "clear the screen" means for a control that starts folded.
    await expect(page.getByTestId('draft-search')).toHaveCount(0);
    await expect(page.getByTestId('draft-search-open')).toBeVisible();
    // The position filter is a choice, not a search: it survives.
    await expect(page.getByRole('button', { name: 'QB', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'ALL', exact: true }).click();
  });

  test('does not disturb a screen with nothing to clear', async ({ page }) => {
    await page.goto('/');
    await open(page, 'setup');
    await page.getByTestId('tab-setup').click();
    await expect(page.getByTestId('setup-step-sleeper')).toBeVisible();
    await expect(page.getByTestId('tab-setup')).toHaveAttribute('aria-current', 'page');
  });
});

/**
 * The status chip has to be readable on the card it lands on.
 *
 * `Q` was amber on an amber tint, which is invisible on a receiver — the tag
 * that appears on more players than any other, disappearing on one position in
 * six. This measures the thing that was wrong: the chip against the card
 * underneath it, on every position the palette paints.
 */
test.describe('injury tags', () => {
  test('stand off every position colour, in both themes', async ({ page }) => {
    await page.goto('/');
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      await open(page, 'draft');

      const readings = await page.evaluate(() => {
        /** `rgb(r g b)` and `color(srgb 0-1 …)` both, as 0-255. */
        const channels = (value: string): number[] => {
          const nums = (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
          return value.startsWith('color(') ? nums.map((n) => n * 255) : nums;
        };
        const luminance = (rgb: number[]) => {
          const f = (c: number) => {
            const v = c / 255;
            return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
          };
          return 0.2126 * f(rgb[0]!) + 0.7152 * f(rgb[1]!) + 0.0722 * f(rgb[2]!);
        };

        // Put the caution chip on one card of every position that is on screen,
        // which is the only way to see it against all six.
        const rows = [...document.querySelectorAll('[data-testid="recommendation-row"]')];
        const perPosition = new Map<string, Element>();
        for (const row of rows) {
          const position = row.getAttribute('data-position') ?? '';
          if (perPosition.has(position)) continue;
          const probe = document.createElement('span');
          probe.className = 'injury-tag injury-caution probe';
          probe.textContent = 'Q';
          row.querySelector('.player-row-top')!.append(probe);
          perPosition.set(position, row);
        }

        return [...perPosition.entries()].map(([position, row]) => {
          const chip = row.querySelector('.probe')!;
          const a = luminance(channels(getComputedStyle(chip).backgroundColor));
          const b = luminance(channels(getComputedStyle(row).backgroundColor));
          return {
            position,
            contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
          };
        });
      });

      expect(readings.length, 'the board should show several positions').toBeGreaterThan(1);
      for (const { position, contrast } of readings) {
        expect(contrast, `Q is lost on ${position} in ${theme} (${contrast.toFixed(2)}:1)`).toBeGreaterThan(3);
      }
    }
    await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  });
});

test.describe('reduced motion', () => {
  test('expanding a player is instant, and still expands', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await open(page, 'draft');
    const row = page.getByTestId('recommendation-row').first();
    await row.click();
    await expect(row.getByTestId('player-detail')).toBeVisible();

    // Reported as seconds ("1e-05s" for the 0.01ms the stylesheet leaves), so
    // it is compared as a number rather than as a string.
    const seconds = await page.evaluate(() => {
      const disclose = document.querySelector('.disclose');
      return disclose ? Number.parseFloat(getComputedStyle(disclose).transitionDuration) : null;
    });
    expect(seconds, 'nothing should be animating under reduced motion').toBeLessThanOrEqual(0.001);
  });
});
