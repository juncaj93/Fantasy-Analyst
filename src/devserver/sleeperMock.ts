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

/**
 * A week-one head-to-head between the two demo rosters.
 *
 * The lineups here are wider than the rosters `seedDemoData` writes, and that
 * is deliberate rather than an inconsistency. The seeded rosters are four
 * players and one player, chosen years ago to exercise the Team screen's
 * honesty about slots nobody can fill; a matchup drawn from them would be two
 * lineups of almost nothing, which tests the empty state and nothing else.
 *
 * Sleeper is the authority for what a matchup's lineups are — the service reads
 * `starters` and `players` from this payload and never from the stored roster —
 * so a fixture that fills both sides is exactly the shape a real league sends,
 * and it lets the demo deployment show the screen somebody actually built.
 *
 * `starters` is positional against the demo league's `roster_positions` with the
 * bench removed: QB, RB, RB, WR, WR, TE, FLEX. The two lineups share nobody, as
 * two lineups in one league cannot; the opponent's second running-back slot is
 * the literal `"0"` Sleeper sends for a slot nobody is filling, which is a real
 * state and the only way the empty half of a row gets drawn at all.
 */
const DEMO_MATCHUPS = [
  {
    roster_id: 1,
    matchup_id: 1,
    points: 0,
    starters: ['1003', '1001', '1008', '1002', '1005', '1004', '1012'],
    players: ['1003', '1001', '1008', '1002', '1005', '1004', '1012', '1009', '1014'],
    players_points: {},
    starters_points: [0, 0, 0, 0, 0, 0, 0],
  },
  {
    roster_id: 2,
    matchup_id: 1,
    points: 0,
    starters: ['1010', '1006', '0', '1007', '1011', '1017', '1019'],
    players: ['1010', '1006', '1007', '1011', '1017', '1019', '1013', '1018'],
    players_points: {},
    starters_points: [0, 0, 0, 0, 0, 0, 0],
  },
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
    /*
     * Any week of the demo league returns the same head-to-head.
     *
     * The alternative — a schedule keyed by week — would be a fixture pretending
     * to be a season, and the screen under test does not care which week it is
     * looking at. A week Sleeper has not scheduled is its own state and is
     * covered by asking for a real league's future week, not by this.
     */
    if (/\/league\/demo-league\/matchups\/\d+$/.test(path)) return json(DEMO_MATCHUPS);
    return underlying(url, init);
  };
}
