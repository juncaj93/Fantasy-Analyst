/**
 * The portrait on the focused surfaces the shared player card is not.
 *
 * `e2e/player-face.spec.ts` proves the primitive: the box, the crop, the
 * fallback, the per-URL memory, the defence exclusion, the empty `alt`. All of
 * that is one component and it does not become a different component when a
 * different screen renders it, so none of it is re-proved here.
 *
 * What this file proves is the thing the source cannot: that the reader
 * actually **arrives** at a face by the routes the rollout claims, and that the
 * lists they walk through to get there are still asking for nothing. Three
 * routes, on three screens the shared card is not reachable from:
 *
 *   - **Team** → a starter, and a waiver candidate;
 *   - **Matchup** → a player in the lineup;
 *   - **Waivers** → a candidate on the board.
 *
 * The pairing is deliberate on every one of them: the same page load asserts
 * that the dense list requested zero portraits *and* that the sheet it opens
 * requested exactly one. A rule that only forbids is satisfied by deleting the
 * feature, and a rule that only requires is satisfied by putting a face on
 * every row.
 *
 * ## The stand-in image, again
 *
 * CI has no route to `sleepercdn.com`, so every request to the host is
 * intercepted. Here the bytes do not matter — nothing in this file measures a
 * crop — so the stand-in is a 1x1 PNG and the assertions are about *which* URLs
 * were asked for and how many. The success path's geometry is measured in
 * `player-face.spec.ts` against a properly shaped portrait.
 */

import { deflateSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';

const PORTRAIT_HOST = '**://sleepercdn.com/**';

/* ------------------------------------------------------------------ image */

function crc32(buf: Buffer): number {
  let c: number;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]!) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([len, typed, crc]);
}

/** One opaque pixel. Enough to decode; nothing here measures a crop. */
function pixel(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from([0, 90, 120, 160]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PIXEL = pixel();

/** Answer the CDN with an image, and record every URL asked for, in order. */
async function servePortraits(page: Page): Promise<string[]> {
  const seen: string[] = [];
  await page.route(PORTRAIT_HOST, async (route) => {
    seen.push(route.request().url());
    await route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
  });
  return seen;
}

/** Answer the way the CDN answers for a player nobody has photographed. */
async function refusePortraits(page: Page): Promise<string[]> {
  const seen: string[] = [];
  await page.route(PORTRAIT_HOST, async (route) => {
    seen.push(route.request().url());
    await route.fulfill({ status: 403, contentType: 'text/plain', body: 'Forbidden' });
  });
  return seen;
}

/* ------------------------------------------------------------------ world */

/** The roster as the app sees it once a draft is over. See `e2e/helpers.ts`. */
async function draftOver(page: Page): Promise<void> {
  await page.route('**/api/leagues/*/roster', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, body: JSON.stringify({ ...body, live: false, drafted: [] }) });
  });
}

/** The regular season, which is what puts Waivers in the seasonal slot. */
async function seasonUnderway(page: Page): Promise<void> {
  await page.route('**/api/overview', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      body: JSON.stringify({
        ...body,
        season: { phase: 'regular', draftVisible: false, reason: 'week 3', assumed: false },
      }),
    });
  });
}

/** The seasonal gate that keeps Matchup out of the bar, opened. */
async function matchupVisible(page: Page): Promise<void> {
  await page.route('**/api/overview', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ json: { ...body, lifecycle: { ...(body.lifecycle ?? {}), matchupVisible: true } } });
  });
}

/* ------------------------------------------------------------- assertions */

/**
 * Everything true of a focused header, wherever it was opened from.
 *
 * One function rather than three copies, for the same reason the header itself
 * is one component: the claim is that these surfaces are not three treatments,
 * so a test that checked them three ways would be conceding the point.
 */
async function assertFocusedFace(page: Page, sheetId: string, expectedId: string): Promise<void> {
  const face = page.getByTestId('sheet-player-face');
  await expect(face, `${sheetId} drew no portrait`).toHaveCount(1);
  await expect(face, `${sheetId} drew a portrait for the wrong player`).toHaveAttribute(
    'data-player-id',
    expectedId,
  );

  const box = await face.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { width: r.width, height: r.height, radius: getComputedStyle(el).borderRadius, tag: el.tagName };
  });
  expect(box.width, `${sheetId}'s portrait is not 64px wide`).toBeCloseTo(64, 1);
  expect(box.height, `${sheetId}'s portrait is not 64px tall`).toBeCloseTo(64, 1);
  expect(box.radius, `${sheetId}'s portrait is not circular`).toMatch(/^(50%|999px)/);

  /*
    Silent, and the name is a heading rather than an `alt`.

    The header prints the player's name two centimetres to the right on every
    one of these surfaces, which is the entire argument for the empty `alt` —
    and the argument only holds if the name is actually there.
  */
  if (box.tag === 'IMG') await expect(face).toHaveAttribute('alt', '');
  const name = page.getByTestId(sheetId).locator('.sheet-player-name');
  await expect(name, `${sheetId} lost the name beside the portrait`).toHaveCount(1);
  expect((await name.innerText()).trim().length, `${sheetId}'s name is empty`).toBeGreaterThan(0);

  /*
    And the portrait did not take a letter off it.

    This is the measurement that decided the header's two-line shape, checked at
    whichever of 430/390/375/360 the project is running. A shortened name is
    information lost in exchange for decoration, and that trade is not one this
    feature is allowed to make on any surface.
  */
  const short = await name.evaluate((el) => (el as HTMLElement).scrollWidth - (el as HTMLElement).clientWidth);
  expect(short, `${sheetId} is taking letters off "${await name.innerText()}"`).toBeLessThanOrEqual(1);

  // The header is the portrait's height and no more: a header that grows with
  // its content is a header pushing the card's own decision content down.
  const header = (await page.getByTestId(sheetId).locator('.sheet-player-title').boundingBox())!;
  expect(header.height, `${sheetId}'s header grew to ${header.height}px`).toBeLessThanOrEqual(64.5);
}

/** Nothing but a bare numeric Sleeper id ever reaches the CDN. */
function assertBareIds(asked: string[]): void {
  for (const url of asked) {
    expect(url, `${url} is not a bare player id`).toMatch(
      /^https:\/\/sleepercdn\.com\/content\/nfl\/players\/\d+\.jpg$/,
    );
  }
}

/* ------------------------------------------------------------------ tests */

test.describe('Team reaches a face, and its lists do not', () => {
  test('a starter and a waiver candidate each open one, from an image-free screen', async ({ page }) => {
    const asked = await servePortraits(page);
    await draftOver(page);
    await page.goto('/');
    await page.getByTestId('tab-team').click();
    await expect(page.getByTestId('starters-title')).toBeVisible();

    /*
      The roster is a list, so it asked for nothing.

      Team's compact rows were prototyped with a 28px face and deferred: at 390,
      375 and 360 they introduced name truncation that was not there before, and
      left a populated slot indented from the empty ones above it. This is that
      decision, read off the network rather than off the source.
    */
    await page.getByTestId('bench-toggle').click();
    await page.waitForTimeout(400);
    expect(asked, 'the Team roster requested portraits').toHaveLength(0);

    const starter = page.locator('[data-testid="starter-row"][data-starter="true"]').first();
    const starterId = (await starter.getAttribute('data-player-id'))!;
    await starter.click();
    await expect(page.getByTestId('weekly-sheet')).toBeVisible();
    await assertFocusedFace(page, 'weekly-sheet', starterId);
    expect(asked, 'the weekly card asked for more than the one player it is about').toHaveLength(1);

    /*
      The identity moved into the header, so the body does not say it twice.

      The pill and the club used to be the first line of this card's body, above
      the verdict. A portrait that added a second copy of them would have made
      the card taller to say nothing new.
    */
    const head = page.getByTestId('weekly-sheet').locator('.weekly-head');
    await expect(head.locator('.pos-pill'), 'the weekly card prints the position twice').toHaveCount(0);

    await page.getByTestId('sheet-close').click();
    await expect(page.getByTestId('weekly-sheet')).toHaveCount(0);

    /*
      And the waiver detail, which is the second focused player on this screen
      and the second sheet reaching the same shared header.
    */
    const waiver = page.getByTestId('waiver-row').first();
    await expect(waiver, 'the Team screen is drawing no waiver upgrades, so this proves nothing').toBeVisible();
    const waiverId = (await waiver.getAttribute('data-player-id'))!;
    await waiver.click();
    await expect(page.getByTestId('waiver-detail')).toBeVisible();
    await assertFocusedFace(page, 'waiver-detail', waiverId);
    expect(asked, 'the waiver detail did not ask for its own player').toHaveLength(2);

    assertBareIds(asked);
  });
});

test.describe('Matchup reaches a face, and its mirrored rows do not', () => {
  test('a player in the lineup opens one; the two lineups ask for nothing', async ({ page }) => {
    const asked = await servePortraits(page);
    await matchupVisible(page);
    await page.goto('/');
    await page.getByTestId('tab-matchup').click();
    await expect(page.getByTestId('matchup-score')).toBeVisible();

    /*
      The screen this feature was most explicitly kept off.

      A face on a mirrored row takes the name column at 390px from about 85px to
      about 60px — on both sides of the mirror at once, on the screen a reader
      scans fastest. The bench is opened too, because a collapsed list proves
      nothing about what a list requests.
    */
    await page.getByTestId('bench-toggle').click();
    await page.waitForTimeout(400);
    expect(asked, 'the matchup lineups requested portraits').toHaveLength(0);

    const player = page.getByTestId('matchup-player').first();
    await player.click();
    await expect(page.getByTestId('weekly-sheet')).toBeVisible();
    const opened = await page.getByTestId('weekly-card').getAttribute('data-player-id');
    await assertFocusedFace(page, 'weekly-sheet', opened!);
    expect(asked, 'the focused player asked for more than his own portrait').toHaveLength(1);
    assertBareIds(asked);
  });
});

test.describe('Waivers reaches a face, and the board does not', () => {
  test('a candidate opens one, and a refused portrait costs the sheet nothing', async ({ page }) => {
    /*
      Refused rather than served, and this is the surface to do it on.

      Twelve percent of probed players had no portrait, and a waiver board is
      where the app's least-photographed players are: the rookies and the
      just-signed. The fallback is the normal case here, not the edge.
    */
    const asked = await refusePortraits(page);
    await seasonUnderway(page);
    await page.goto('/');
    await page.getByTestId('tab-waivers').click();
    await expect(page.getByTestId('waivers-nav')).toBeVisible();
    await expect(page.getByTestId('waiver-row').first()).toBeVisible();
    await page.waitForTimeout(400);
    expect(asked, 'the waivers board requested portraits').toHaveLength(0);

    const row = page.getByTestId('waiver-row').first();
    const playerId = (await row.getAttribute('data-player-id'))!;
    await row.click();
    await expect(page.getByTestId('waiver-detail')).toBeVisible();

    const face = page.getByTestId('sheet-player-face');
    await expect(face, 'a refused portrait did not fall back').toHaveAttribute('data-fallback', 'yes');
    await expect(face, 'the fallback is not the player’s initials').toHaveText(/^[A-Z]{1,2}$/);
    await assertFocusedFace(page, 'waiver-detail', playerId);

    // Nothing about the card said anything went wrong, and nothing retried.
    const sheet = await page.getByTestId('waiver-detail').innerText();
    for (const word of ['error', 'failed', 'unavailable', 'could not load', 'retry']) {
      expect(sheet.toLowerCase(), `the waiver detail complained about a missing portrait ("${word}")`).not.toContain(
        word,
      );
    }
    expect(asked.length, 'a refused portrait was requested more than once').toBeLessThanOrEqual(1);
    assertBareIds(asked);

    /*
      And it reads in both themes, which for this feature is a claim about
      tokens rather than about two designs.

      The portrait and the initials sit on `--surface-sunken` inside a
      `--border` hairline, and the letters are `--text-faint`; nothing in
      `.player-face` names a colour, so Light and Dark are two settings of one
      rule. What is worth checking on the surface the header was *added* to is
      that the two are actually different and that neither leaves the fallback's
      letters on their own ground — a hairline that vanished in Dark, or
      initials the colour of what they sit on, is how a shared token goes wrong.
    */
    const seen = new Set<string>();
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      const paint = await face.evaluate((el) => {
        const s = getComputedStyle(el);
        return { ink: s.color, ground: s.backgroundColor, edge: s.boxShadow };
      });
      expect(paint.ink, `the initials are invisible against their own ground in ${theme}`).not.toBe(paint.ground);
      expect(paint.edge, `the portrait lost its hairline in ${theme}`).not.toBe('none');
      seen.add(`${paint.ink}|${paint.ground}`);

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `the waiver detail overflows sideways in ${theme}`).toBeLessThanOrEqual(1);
    }
    expect(seen.size, 'the two themes paint the fallback identically, so one of them is not applying').toBe(2);
    await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  });
});
