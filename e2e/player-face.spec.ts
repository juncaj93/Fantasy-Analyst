/**
 * The portrait on the expanded player card, and everything it must survive.
 *
 * The claim this file defends is not "a face appears". It is that the face is
 * **optional** — that the card is the same card without it, that a reader whose
 * portrait never arrives loses nothing and sees no gap, and that nothing about
 * the feature can cost the app a request it was not already making. A portrait
 * comes from an undocumented convention on a third party's CDN (see
 * `core/players/headshot.ts`); the only reason that was allowed is that every
 * failure is contained here, so every failure is asserted here.
 *
 * ## The stand-in image, and why there is one
 *
 * CI runners and this repository's own sandbox have no route to
 * `sleepercdn.com` — the network policy denies it — so a spec that waited for a
 * real portrait would be a spec that only ever tested the fallback, on every
 * machine, forever. Every request to the host is therefore intercepted and
 * answered locally: a generated 350x254 image with a head high in the frame,
 * which is the source's own measured dimensions and framing. The bytes are a
 * PNG rather than a JPEG because Node can encode one from `zlib` and cannot
 * encode the other; the component treats the two identically, because what it
 * does with the response is hand it to an `<img>`.
 *
 * What that buys is the part that matters: the *success* path is exercised —
 * real decode, real `object-fit` crop, real geometry — rather than assumed. The
 * one thing it cannot prove is that Sleeper's URL still resolves in production,
 * and no test in any suite can prove that about a third party. The fallback is
 * what makes that acceptable, and it is the most tested thing in this file.
 *
 * ## Seven page loads, and that is a budget
 *
 * `e2e/` runs inside a twenty-five-minute step ceiling per width. Every
 * `page.goto('/')` re-boots the single-page app, so this file opens the app as
 * few times as it can and reads everything true of the card it has.
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

/**
 * A portrait at the source's own dimensions: 350x254, head high in the frame,
 * shoulders running off the bottom edge.
 *
 * The framing is the point rather than the picture. `object-position: 50% 30%`
 * exists because a portrait shaped like this, cropped to a circle on its
 * geometric centre, fills with collar and cuts the top of the head off — so the
 * stand-in has to have that shape or the crop rule is untested.
 */
function portrait(): Buffer {
  const w = 350;
  const h = 254;
  const raw = Buffer.alloc(h * (w * 3 + 1));
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const head = ((x - w / 2) / 46) ** 2 + ((y - h * 0.34) / 56) ** 2 <= 1;
      const shoulders = y > h * 0.74 && Math.abs(x - w / 2) < 120;
      const [r, g, b] = head ? [222, 184, 149] : shoulders ? [30, 60, 140] : [180, 200, 220];
      raw[o++] = r!;
      raw[o++] = g!;
      raw[o++] = b!;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PORTRAIT = portrait();

/* ----------------------------------------------------------------- routes */

/** Every portrait request this page made, in order, as full URLs. */
type Requests = string[];

/** Answer the CDN with a real image, and record what was asked for. */
async function servePortraits(page: Page): Promise<Requests> {
  const seen: Requests = [];
  await page.route(PORTRAIT_HOST, async (route) => {
    seen.push(route.request().url());
    await route.fulfill({ status: 200, contentType: 'image/png', body: PORTRAIT });
  });
  return seen;
}

/**
 * Answer the CDN the way it answers for a player who has no portrait.
 *
 * A 403 rather than a connection error, because that is what was actually
 * measured coming back for the twelve percent of probed players that did not
 * resolve — and because a status code is the case a reader is most likely to
 * hit, on a working network, for a rookie who has not been photographed yet.
 */
async function refusePortraits(page: Page): Promise<Requests> {
  const seen: Requests = [];
  await page.route(PORTRAIT_HOST, async (route) => {
    seen.push(route.request().url());
    await route.fulfill({ status: 403, contentType: 'text/plain', body: 'Forbidden' });
  });
  return seen;
}

/* ------------------------------------------------------------------- page */

async function openPlayers(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('tab-players').click();
  await expect(page.getByTestId('player-search-row').first()).toBeVisible();
}

async function openPlayer(page: Page, playerId: string): Promise<void> {
  const row = page.locator(`[data-testid="player-search-row"][data-player-id="${playerId}"]`);
  await row.scrollIntoViewIfNeeded();
  await row.click();
  await expect(page.getByTestId('player-sheet')).toBeVisible();
  await expect(page.getByTestId('player-page-metrics')).toBeVisible();
}

async function closeSheet(page: Page): Promise<void> {
  await page.getByTestId('sheet-close').click();
  await expect(page.getByTestId('player-sheet')).toHaveCount(0);
}

/** The face's box, exactly as the browser laid it out. */
async function faceBox(page: Page) {
  return page.getByTestId('sheet-player-face').evaluate((el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return {
      width: r.width,
      height: r.height,
      left: r.left,
      radius: s.borderRadius,
      objectFit: s.objectFit,
      tag: el.tagName,
      decoded: el instanceof HTMLImageElement ? el.naturalWidth : -1,
      complete: el instanceof HTMLImageElement ? el.complete : true,
    };
  });
}

/** Where the name starts. The number that must not move between states. */
async function nameLeft(page: Page): Promise<number> {
  return page.locator('.sheet-player-name').evaluate((el) => el.getBoundingClientRect().left);
}

/* ------------------------------------------------------------------ tests */

test.describe('the portrait on the expanded player card', () => {
  test('draws a real decoded face in a fixed 64px circle, and says nothing out loud', async ({ page }) => {
    const asked = await servePortraits(page);
    await openPlayers(page);
    await openPlayer(page, '1001');

    const box = await faceBox(page);
    expect(box.tag, 'the portrait is not an image').toBe('IMG');
    // Decoded, not merely present: a broken image is an `<img>` too.
    await expect.poll(async () => (await faceBox(page)).decoded).toBeGreaterThan(0);
    /*
      `toBeCloseTo` rather than `toBe`, and it is not a loosened assertion.

      These projects run at `deviceScaleFactor: 3` and the sheet carries a
      transform while it settles, so a box that is exactly 64 CSS pixels
      measures 63.99997 or 64.00003 through `getBoundingClientRect` depending on
      what it happened to be composited against. Exact equality on a laid-out
      rect tests the compositor's arithmetic, not the layout — and it fails
      intermittently, which is the worst way for a real assertion to be wrong.
      A tenth of a pixel is far tighter than anything this is defending against:
      the failure it exists to catch is a face that is 22px, or 0.
    */
    expect(box.width, 'the portrait is not 64px wide').toBeCloseTo(64, 1);
    expect(box.height, 'the portrait is not 64px tall').toBeCloseTo(64, 1);
    expect(box.radius, 'the portrait is not circular').toMatch(/^(50%|999px)/);
    expect(box.objectFit, 'the portrait is being stretched rather than cropped').toBe('cover');

    // Exactly one image was asked for, and it was keyed on the player's id.
    expect(asked, 'the card asked for more than one portrait').toHaveLength(1);
    expect(asked[0]).toBe('https://sleepercdn.com/content/nfl/players/1001.jpg');

    /*
      Silent to anything not looking at it.

      The header already prints the name two centimetres to the right. An `alt`
      here would have a screen reader announce the player twice before it
      reached a single fact about him.
    */
    await expect(page.getByTestId('sheet-player-face')).toHaveAttribute('alt', '');

    // And not a control. The row's grammar has one way in and one action; a
    // face is neither, and a button inside a header is a tab stop that leads
    // nowhere.
    const interactive = await page
      .getByTestId('sheet-player-face')
      .evaluate((el) => el.closest('button') !== null || el.hasAttribute('tabindex') || el.hasAttribute('role'));
    expect(interactive, 'the portrait became something a reader can press').toBe(false);

    /*
      The card is still announced as the player and only as the player.

      `e2e/player-detail.spec.ts` asserts this for the card in general; it is
      re-checked here because a portrait is exactly the kind of thing that
      grows an `alt` in a later pass and quietly renames the dialog.
    */
    const name = (await page.locator('.sheet-player-name').innerText()).trim();
    await expect(page.getByRole('dialog', { name })).toBeVisible();
  });

  test('a refused portrait costs the reader nothing: initials, same box, no second attempt', async ({ page }) => {
    const asked = await refusePortraits(page);
    await openPlayers(page);
    await openPlayer(page, '1001');

    const face = page.getByTestId('sheet-player-face');
    await expect(face, 'a refused portrait did not fall back').toHaveAttribute('data-fallback', 'yes');
    await expect(face, 'the fallback is not the player’s initials').toHaveText('MV');

    const box = await faceBox(page);
    expect(box.tag, 'a broken <img> was left on screen').not.toBe('IMG');
    expect(box.width, 'the fallback is not the same square as the portrait').toBeCloseTo(64, 1);
    expect(box.height).toBeCloseTo(64, 1);
    expect(box.radius, 'the fallback is not the same circle').toMatch(/^(50%|999px)/);

    // Nothing about the card said anything went wrong.
    const sheet = await page.getByTestId('player-sheet').innerText();
    for (const word of ['error', 'failed', 'unavailable', 'could not load', 'retry']) {
      expect(sheet.toLowerCase(), `the card complained about a missing portrait ("${word}")`).not.toContain(word);
    }
    await expect(page.getByTestId('player-sheet').locator('.notice, .notice-row')).toHaveCount(0);

    /*
      One attempt per URL, for the whole session rather than for the mount.

      Reopening the same player is the common case — a reader checks a rookie,
      goes back to the list, checks him again — and re-requesting an image that
      is known not to exist is the one way this feature could cost a rookie's
      card a round trip every time it opens.
    */
    await closeSheet(page);
    await openPlayer(page, '1001');
    await expect(page.getByTestId('sheet-player-face')).toHaveAttribute('data-fallback', 'yes');
    expect(asked, 'a portrait already known to be missing was requested again').toHaveLength(1);
  });

  test('the box does not move between a face and initials', async ({ page }) => {
    /*
      Zero layout shift, measured as the thing that would actually shift.

      A portrait arriving late cannot reflow the header, because the box is the
      same square in both states — so the number to compare is where the
      player's *name* starts with an image and where it starts without one. If
      those two are equal, there is nothing for a slow network to move.
    */
    await refusePortraits(page);
    await openPlayers(page);
    await openPlayer(page, '1001');
    const withoutImage = await nameLeft(page);
    const fallbackBox = await faceBox(page);
    await closeSheet(page);

    await page.unroute(PORTRAIT_HOST);
    await servePortraits(page);
    await openPlayer(page, '1002');
    await expect.poll(async () => (await faceBox(page)).decoded).toBeGreaterThan(0);
    const withImage = await nameLeft(page);
    const imageBox = await faceBox(page);

    expect(imageBox.width).toBeCloseTo(fallbackBox.width, 1);
    expect(imageBox.height).toBeCloseTo(fallbackBox.height, 1);
    expect(imageBox.left, 'the portrait and its fallback start on different columns').toBeCloseTo(
      fallbackBox.left,
      1,
    );
    expect(withImage, 'the name moves depending on whether a portrait loaded').toBeCloseTo(withoutImage, 1);
  });

  test('costs the header a fixed 64px and costs no name a single letter', async ({ page }) => {
    /*
      The measurement that decided the header's shape, kept as a test.

      A 64px face on the identity line the sheet used to have truncated
      nineteen of these twenty-two names at 360px — `Julian Reyes` down to
      `Julian…` — where none truncated before it. The line had about twenty
      pixels of slack and the face wanted sixty-eight, so no face size was free:
      even 40px cost ten names. Moving the name onto a line of its own beside
      the portrait is what bought it back.

      Every seeded player, at whichever of 430/390/375/360 this project is, and
      the number to beat is zero rather than "fewer". A portrait is identity
      polish; a shortened name is information lost, and the trade is not one
      this feature is allowed to make.

      The header height is asserted in the same walk because it is the other
      half of the same claim: two lines beside a 64px circle is exactly 64px,
      and a header that starts growing with its content is a header that has
      begun pushing the card's own facts down the screen.
    */
    await refusePortraits(page);
    await openPlayers(page);

    const ids = await page
      .locator('[data-testid="player-search-row"]')
      .evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.playerId!));
    expect(ids.length, 'the Players list is empty, so this test proves nothing').toBeGreaterThan(10);

    const truncated: string[] = [];
    for (const id of ids) {
      await openPlayer(page, id);
      const name = await page.locator('.sheet-player-name').evaluate((el) => {
        const h = el as HTMLElement;
        return { text: h.innerText, short: h.scrollWidth - h.clientWidth };
      });
      if (name.short > 1) truncated.push(`${name.text} (short by ${name.short}px)`);

      const header = (await page.locator('.sheet-player-title').boundingBox())!;
      expect(header.height, `the header grew to ${header.height}px on ${name.text}`).toBeLessThanOrEqual(64.5);

      await closeSheet(page);
    }

    expect(truncated, 'the portrait is taking letters off player names').toEqual([]);
  });

  test('one player’s missing portrait never blanks out the next player’s', async ({ page }) => {
    /*
      The failure is remembered per URL, not as a boolean.

      React reuses component instances as the sheet reopens on a different
      player, so a boolean `failed` would let the first missing portrait swallow
      every face opened after it. This is the assertion that the memoisation is
      keyed on the thing it is about.
    */
    await page.route(PORTRAIT_HOST, async (route) => {
      const missing = route.request().url().endsWith('/1001.jpg');
      if (missing) await route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not Found' });
      else await route.fulfill({ status: 200, contentType: 'image/png', body: PORTRAIT });
    });

    await openPlayers(page);

    await openPlayer(page, '1001');
    await expect(page.getByTestId('sheet-player-face')).toHaveAttribute('data-fallback', 'yes');
    await closeSheet(page);

    await openPlayer(page, '1002');
    await expect(page.getByTestId('sheet-player-face'), 'the next player inherited the last one’s failure').toHaveAttribute(
      'data-player-id',
      '1002',
    );
    await expect.poll(async () => (await faceBox(page)).decoded, {
      message: 'a player after a failed one never got his own attempt',
    }).toBeGreaterThan(0);

    // And back again: the one that failed is still remembered as failed.
    await closeSheet(page);
    await openPlayer(page, '1001');
    await expect(page.getByTestId('sheet-player-face')).toHaveAttribute('data-fallback', 'yes');
  });

  test('a team defence never asks for a face, whichever way its id is written', async ({ page }) => {
    /*
      Two id shapes, because a defence has two of them depending on where the
      data came from, and only one of them is excluded by the digits rule.

      **Live Sleeper** keys defences by the club abbreviation — `CHI` is a real
      `player_id` — which `playerHeadshotUrl` refuses for not being numeric.
      That shape does not occur in the demo world, so one row's id is rewritten
      to it here, the same technique `e2e/player-detail.spec.ts` uses to put a
      field on a card the demo world does not carry.

      **This repository's own seed** keys its three defences numerically:
      `1030` is Jacksonville. The digits rule says nothing about that one, and
      it is exactly why the helper checks the position as well. A rule that
      holds only because a provider happens to format its keys a certain way is
      a rule waiting to be broken by a fixture — and this is the fixture.

      Both must reach the same place: initials, no request, club mark intact.
    */
    const asked = await servePortraits(page);
    /*
      Baltimore's defence becomes Chicago's, on the way back from the server.

      The search itself runs server-side against the seeded name, so the query
      below is `Baltimore` — the row is only rewritten once it has been found.
      What is being changed is the shape of the *id*, which is the whole point:
      `1031` is what this repository's seed calls a defence and `CHI` is what
      Sleeper calls one, and both have to end in the same place.
    */
    await page.route('**/api/players?*', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const players = body.players.map((p: { id: string }) =>
        p.id === '1031' ? { ...p, id: 'CHI', name: 'Chicago', team: 'CHI' } : p,
      );
      await route.fulfill({ response, body: JSON.stringify({ ...body, players }) });
    });

    await openPlayers(page);

    for (const [id, query, initials] of [
      ['1030', 'Jacksonville', 'JA'],
      ['CHI', 'Baltimore', 'CH'],
    ] as const) {
      /*
        Searched for rather than scrolled to. A defence's `search_rank` puts it
        two hundred rows down the index, which is below whatever the list has
        drawn — and scrolling a paged list to find one is a slower and more
        fragile way to ask the same question.
      */
      await page.getByTestId('player-search').fill(query);
      const row = page.locator(`[data-testid="player-search-row"][data-player-id="${id}"]`);
      await expect(row, `the demo world is not listing the defence ${id}`).toHaveCount(1);
      await row.scrollIntoViewIfNeeded();
      await row.click();
      await expect(page.getByTestId('player-sheet')).toBeVisible();

      const face = page.getByTestId('sheet-player-face');
      await expect(face, `the defence ${id} was sent looking for a player portrait`).toHaveAttribute(
        'data-fallback',
        'yes',
      );
      await expect(face, `the initials for ${id} are not the club's`).toHaveText(initials);

      // The club still has its own bundled mark under the name, which is what a
      // defence has instead of a face.
      await expect(page.locator('.sheet-player-quals [data-testid="team-logo"]')).toHaveCount(1);
      await closeSheet(page);
    }

    expect(asked, 'a portrait was requested for a team defence').toEqual([]);
  });

  test('no dense list asks for a portrait, and nothing but a player id is ever in the URL', async ({ page }) => {
    /*
      The protected surfaces, read off the network rather than off the source.

      `tests/playerHeadshotSurfaces.test.ts` holds the source to it; this holds
      the running app to it, which is the version that survives somebody
      rendering a face through a wrapper the source scan does not recognise.
    */
    const asked = await servePortraits(page);

    await page.goto('/');
    await expect(page.getByTestId('board-list')).toBeVisible();
    expect(asked, 'the draft board requested portraits').toHaveLength(0);

    /*
      Waivers and Matchup are not in this sweep, and are not missing from it
      either.

      Neither is reachable on the demo deployment as it stands: the toolbar's
      seasonal slot carries Draft before the season and Waivers only once it
      starts (`e2e/waivers.spec.ts`), and Matchup is behind a lifecycle flag the
      matchup spec patches in (`e2e/matchup.spec.ts`). Reaching either costs a
      page load and a rewritten world, for two screens whose source is already
      held to this rule by `tests/playerHeadshotSurfaces.test.ts` by name — and
      Waivers draws the same `CompactPlayerRow` that the Players and Trades
      sweeps below already walk.
    */
    for (const tab of ['trades', 'players'] as const) {
      await page.getByTestId(`tab-${tab}`).click();
      await page.waitForTimeout(500);
      expect(asked, `the ${tab} list requested portraits`).toHaveLength(0);
    }

    // And once a card is open, the only thing that ever reaches the CDN is a
    // numeric player id — never a name, never a team, never a session.
    await page.getByTestId('tab-players').click();
    await expect(page.getByTestId('player-search-row').first()).toBeVisible();
    await openPlayer(page, '1001');
    await expect.poll(() => asked.length).toBe(1);
    for (const url of asked) {
      expect(url, `${url} is not a bare player id`).toMatch(
        /^https:\/\/sleepercdn\.com\/content\/nfl\/players\/\d+\.jpg$/,
      );
    }
  });
});
