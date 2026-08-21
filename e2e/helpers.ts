/**
 * Shared e2e helpers.
 *
 * Kept separate from `constants.ts`, which the Playwright config imports and
 * which therefore may not pull in `@playwright/test`.
 */

import type { Page } from '@playwright/test';

/**
 * Answer the roster as the app sees it once a draft is over.
 *
 * The demo league is permanently mid-draft, which is the right fixture for most
 * of what this suite checks — but the Team pass deliberately withholds a set of
 * controls *during* a draft. Balanced, Floor and Ceiling are three definitions
 * of the best lineup and Compare asks which of two players to start; neither
 * question exists while half the roster is unpicked, so neither control is
 * drawn until the draft ends. See the note on `team-controls` in `TeamScreen`.
 *
 * Any spec that needs those controls has to say which season it is standing in,
 * and this is how it says so. `live` is the one field that decides which of the
 * two Team screens is showing, so it is the only thing overridden; every number
 * underneath is the deployment's own.
 *
 * Call it *before* navigating to Team — a route installed after the request has
 * gone out changes nothing.
 */
export async function inSeason(page: Page): Promise<void> {
  await page.route('**/api/leagues/*/roster', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, body: JSON.stringify({ ...body, live: false, drafted: [] }) });
  });
}

/**
 * Pull a screen down far enough to refresh it.
 *
 * The gesture replaced the refresh buttons, so the specs that used to tap one
 * do this instead. Moved by steps rather than in one jump because the control
 * damps the movement and arms only past a threshold — a single `mouse.move` to
 * the end point is one event, and one event is not a pull.
 */
export async function pullToRefresh(page: Page, testId: string): Promise<void> {
  const box = (await page.getByTestId(testId).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + 40;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (const step of [12, 60, 120, 190]) await page.mouse.move(x, y + step);
  await page.mouse.up();
}
