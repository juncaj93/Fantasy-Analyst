/**
 * A Sleeper that answers, for the seeded demo deployment.
 *
 * The dev/e2e server seeds a league whose draft is `drafting`, and the Draft
 * screen now syncs that draft by itself — on open, on tab entry, on resume, and
 * on a five-second cadence while it is live. Pointed at the real Sleeper those
 * requests ask about `demo-draft`, which does not exist, so every one of them
 * 404s. That is not a broken app; it is a fixture with no counterpart upstream.
 * But it makes every e2e run depend on the network, fills the board with a
 * "sync delayed" line the tests never asked for, and — because that line takes
 * vertical space — quietly moves the geometry that several specs measure.
 *
 * So the seeded server serves the demo draft from the same fixture the database
 * was seeded from, and passes everything else through untouched. Same shape as
 * `MockVegasProvider`: a fixture at the transport boundary, never deployed, and
 * never reached by a request for anything real.
 *
 * The state it returns is deliberately *static*. Tests that need the draft to
 * advance drive the client boundary with route interception, where they can
 * choose exactly what each poll sees; a mutable mock here would be a second,
 * less legible way to say the same thing.
 */

import type { FetchLike } from '../core/sleeper/client.ts';

/** Matches the draft `seedDemoData` writes. Kept in step with seed.ts by hand. */
const DEMO_DRAFT = {
  draft_id: 'demo-draft',
  league_id: 'demo-league',
  status: 'drafting',
  type: 'snake',
  season: '2026',
  slot_to_roster_id: { '1': 1, '2': 2 },
  settings: { rounds: 12, teams: 12 },
};

const DEMO_PICKS = [
  { draft_id: 'demo-draft', pick_no: 1, round: 1, draft_slot: 1, player_id: '1001', picked_by: 'demo-user', roster_id: 1 },
  { draft_id: 'demo-draft', pick_no: 2, round: 1, draft_slot: 2, player_id: '1002', picked_by: 'rival', roster_id: 2 },
];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Wrap a transport so the demo draft resolves locally.
 *
 * Only the two paths a draft poll uses are intercepted, and only for the demo
 * id — a real draft id on a dev server still reaches the real Sleeper, which is
 * what makes this safe to leave switched on for local development.
 */
export function withDemoSleeper(underlying: FetchLike = (url, init) => fetch(url, init)): FetchLike {
  return async (url, init) => {
    const path = new URL(url).pathname;
    if (path.endsWith(`/draft/${DEMO_DRAFT.draft_id}`)) return json(DEMO_DRAFT);
    if (path.endsWith(`/draft/${DEMO_DRAFT.draft_id}/picks`)) return json(DEMO_PICKS);
    return underlying(url, init);
  };
}
