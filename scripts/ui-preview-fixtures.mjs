/**
 * Round 36: the made-up waiver picks the UI preview and its pictures draw.
 *
 * The seeded league has no waiver move to make, so Waivers would show only
 * "No must-do move". This fills the tiers with the seeded league's own free
 * agents (Dane Petrossian, Wes Okonkwo, Ruben Castellanos, Hollis Marchetti,
 * Casey Lindqvist, Tennessee) in the shapes the engine writes, so every pick
 * kind is on screen: Do this, Worth considering, Watch list, Drop-ready,
 * Stash, Cover and Block. Preview and pictures only; the app never reads it.
 */

const WEEKS = [12, 13, 14];

function bid(kind, recommended = null, reason = '', until = null) {
  if (kind === 'free') {
    return { kind: 'free', recommended: null, low: null, high: null, reason: 'Free agent: first come, no bid', ceiling: null, overCeiling: false, likely: [], thin: null, until: null };
  }
  return { kind: 'claim', recommended, low: Math.max(0, recommended - 2), high: recommended + 2, reason, ceiling: 28, overCeiling: false, likely: [], posture: 'consider', thin: null, until };
}

function move(over) {
  return {
    tier: 'consider',
    reasonCode: 'upgrade',
    lineupGain: over.gain ?? 0,
    insurance: 0,
    byWeek: WEEKS.map((week, i) => ({ week, change: i === 0 ? over.gain ?? 0 : 0 })),
    rate: 10,
    weekNumbers: WEEKS.map((week) => ({ week, points: 10, source: 'current' })),
    prefs: [],
    drop: null,
    dropCost: 0,
    competesWith: [],
    alternatives: [],
    alternativeTo: null,
    planExcluded: null,
    lastWeekPoints: null,
    ...over,
  };
}

/** The seeded figures, moved onto the preview's weeks (12 to 14), with Brennan's bye in 12. */
function figures(original) {
  const out = {};
  for (const [id, f] of Object.entries(original ?? {})) {
    out[id] = {
      ...f,
      weeks: WEEKS.map((week, i) => {
        const w = f.weeks?.[i] ?? f.weeks?.[0] ?? { points: 0, source: 'current', out: false };
        const bye = id === '1005' && week === 12;
        return { ...w, week, bye, points: bye ? 0 : w.points };
      }),
    };
  }
  return out;
}

/** The waivers answer with the made-up picks laid over the seeded one. */
export function withPreviewWaivers(body) {
  if (!body?.found || !body.tiers) return body;
  const until = new Date(Date.now() + 2 * 86400000).toISOString();
  const doThis = move({
    playerId: '1021', name: 'Dane Petrossian', position: 'WR', team: 'ARI', tier: 'do_this', reasonCode: 'hole_bye',
    reason: 'Your WR Kai Brennan is on bye in week 12', gain: 11.4,
    drop: { playerId: '1014', name: 'Jonah Priestley', position: 'QB' },
    bid: bid('claim', 9, 'Two or more other managers are likely to bid, so $9 to win about 3 times in 4.', until),
  });
  const consider = [
    move({
      playerId: '1020', name: 'Wes Okonkwo', position: 'RB', team: 'LV', reasonCode: 'upgrade',
      reason: 'Starts over Bo Ashworth, +3.2 pts in week 13', gain: 4.6,
      drop: { playerId: '1014', name: 'Jonah Priestley', position: 'QB' }, bid: bid('free'),
    }),
    move({
      playerId: '1016', name: 'Ruben Castellanos', position: 'QB', team: 'PIT', reasonCode: 'bye_depth',
      reason: 'Backup for your QB Trey Halloran, who is on bye in week 14', gain: 2.1,
      drop: { playerId: '1014', name: 'Jonah Priestley', position: 'QB' },
      bid: bid('claim', 2, 'Nobody else is likely to bid, so the $2 floor wins it.', until),
    }),
  ];
  const watch = [move({ playerId: '1015', name: 'Casey Lindqvist', position: 'QB', team: 'DEN', tier: 'watch', reason: 'Starts over Trey Halloran, +0.6 pts in week 14', gain: 0.6, bid: bid('free') })];
  return {
    ...body,
    tiers: {
      ...body.tiers,
      doThis,
      doThese: [doThis],
      consider,
      watch,
      dropReady: [{ playerId: '1014', name: 'Jonah Priestley', position: 'QB', cost: 0.1, overReplacement: 0.2, reason: 'No start in weeks 12 to 14; barely better than a free agent' }],
      window: { weeks: WEEKS, weights: [1, 1, 0.5] },
      valued: 6,
      unvalued: 0,
      weekFigures: figures(body.tiers.weekFigures),
      upsideStash: {
        playerId: '1022', name: 'Hollis Marchetti', position: 'RB', team: '', reason: 'back around week 14',
        path: { kind: 'own_return', backWeek: 14 }, value: 12.1, bid: { kind: 'claim', low: 0, high: 1 }, room: { kind: 'reserve' },
      },
      cover: [
        { playerId: '1015', name: 'Casey Lindqvist', position: 'QB', team: 'DEN', week: 14, reason: 'covers your Week 14 bye at QB', gain: 14.2, bid: { kind: 'free' }, room: { kind: 'drop', playerId: '1014', name: 'Jonah Priestley' } },
      ],
      block: {
        playerId: '1032', name: 'Tennessee', position: 'DEF', team: 'TEN', reason: 'opponent needs a DEF', detail: 'his DEF is on bye', gain: 5.1,
        bid: { kind: 'claim', low: 1, high: 3 }, room: { kind: 'open' },
      },
    },
  };
}


/**
 * One request, answered in the preview's made-up world: the seeded league
 * (FA_SEED=1 FA_SEED_FULL=1) in season, its waivers with the picks above, the
 * Trades reads from a server run with PREVIEW=trades and the Players board and
 * cards from one run with PREVIEW=players (the same made-up names), and the
 * status read saying whether UI_REVAMP is on. Returns the response and, for
 * JSON, the body as the screen should see it.
 */
export async function answerInWorld(route, { trades, players, revamp }) {
  const url = new URL(route.request().url());
  const path = url.pathname;
  let from = null;
  if (trades && path.startsWith('/api/trades/screens/')) from = trades;
  if (players && /^\/api\/players\/(season|[^/]+\/season)$/.test(path)) from = players;
  const response = await route.fetch(from ? { url: from + path + url.search } : undefined);
  let body;
  try {
    body = await response.json();
  } catch {
    return { response, body: undefined };
  }
  if (path === '/api/overview') {
    body = {
      ...body,
      season: { phase: 'regular', draftVisible: false, reason: 'the regular season is under way (week 12)', assumed: false },
      lifecycle: { ...(body.lifecycle ?? {}), lifecycle: 'regular_season', phase: 'regular', draftVisible: false, matchupVisible: true, draftLive: false },
    };
  } else if (path.endsWith('/roster')) body = { ...body, live: false, drafted: [] };
  else if (path.endsWith('/waivers')) body = withPreviewWaivers(body);
  else if (path === '/api/auth/status') body = { ...body, features: { ...(body.features ?? {}), uiRevamp: revamp } };
  return { response, body };
}

/** The made-up world for a whole Playwright context (the pictures and the speed runs). */
export async function previewWorld(context, world) {
  await context.route('**/api/**', async (route) => {
    try {
      const { response, body } = await answerInWorld(route, world);
      await route.fulfill(body === undefined ? { response } : { response, body: JSON.stringify(body) });
    } catch {
      /* the page closed while a read was out */
    }
  });
}
