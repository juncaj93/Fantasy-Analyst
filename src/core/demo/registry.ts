/**
 * Every scenario Demo Mode knows about, declared once.
 *
 * Metadata only. It is small enough to ship in the main bundle — the Settings
 * list has to name every scenario before one is chosen — and it carries no
 * fixture data at all, so adding a rich scenario costs the initial download
 * nothing.
 *
 * The order here is the order the picker shows, and it is the order a season
 * happens in: draft, the morning after, the weeks, the wire, the trade window,
 * the end, and then the ways it all degrades.
 */

import { FIXTURE_VERSION, type DemoScenario, type DemoSourceFreshness } from './types.ts';

const SEASON = '2026';

/** Everything working. The baseline every degraded scenario is a deviation from. */
const ALL_FRESH: DemoSourceFreshness = {
  sleeper: 'fresh',
  adp: 'fresh',
  /*
   * Underdog's board, which is now a real second market.
   *
   * `fresh` means an Underdog file inside its 36-hour window, so the DOG column
   * is lit and carries 60% of the market baseline (75% in best ball). The
   * degraded scenarios below move this and nothing else, because every one of
   * §13's DOG states is a fact about the file rather than about a player.
   */
  dogAdp: 'fresh',
  injuries: 'fresh',
  usage: 'fresh',
  vegas: 'fresh',
  newsletter: 'fresh',
};

const fresh = (over: Partial<DemoSourceFreshness> = {}): DemoSourceFreshness => ({ ...ALL_FRESH, ...over });

/** A twelve-team half-PPR redraft league, which is what most people play. */
const HOME_LEAGUE = {
  name: 'Thursday Night Regrets',
  teams: 12,
  scoringLabel: 'Half PPR',
  bestBall: false,
  superflex: false,
  faabBudget: 100,
};

/**
 * The same room, drafting best ball.
 *
 * The only thing that differs is a flag in Sleeper's own settings, which is the
 * point: the 75/25 blend is not configured anywhere in Demo Mode, it is what
 * `detectBestBall` concludes and `blendWeights` then applies.
 */
const BEST_BALL_LEAGUE = { ...HOME_LEAGUE, name: 'Thursday Night Regrets (best ball)', bestBall: true };

const LEAGUE_ID = 'demo-league-2026';

const base = {
  season: SEASON,
  format: HOME_LEAGUE,
  leagueId: LEAGUE_ID,
  fixtureVersion: FIXTURE_VERSION,
} as const;

export const DEMO_SCENARIOS: DemoScenario[] = [
  // ----------------------------------------------------------------- draft
  {
    ...base,
    id: 'draft-early',
    label: 'Draft · round 1',
    description:
      'Eight picks in, on the clock at 1.09. Every tier is intact, so the board is about value rather than scarcity — and two of the top eight are already gone above their ADP.',
    group: 'draft',
    lifecycle: 'draft_live',
    week: null,
    asOf: '2026-08-30T23:12:00.000Z',
    freshness: fresh(),
    surfaces: ['draft', 'team', 'trades', 'players', 'setup'],
    next: 'draft-mid',
    bundle: 'draft',
  },
  {
    ...base,
    id: 'draft-mid',
    label: 'Draft · round 6',
    description:
      'Pick 6.04, mid-run. A receiver run is visible on the board, the tight end tier is one deep, and the best player available disagrees with the biggest hole on the roster.',
    group: 'draft',
    lifecycle: 'draft_live',
    week: null,
    asOf: '2026-08-31T00:04:00.000Z',
    freshness: fresh(),
    surfaces: ['draft', 'team', 'trades', 'players', 'setup'],
    previous: 'draft-early',
    next: 'draft-late',
    bundle: 'draft',
  },
  {
    ...base,
    id: 'draft-late',
    label: 'Draft · round 13',
    description:
      'Deep into the ranking, where most of the pool has no ADP at all. Unpriced players are ranked on what is actually known about them and say so.',
    group: 'draft',
    lifecycle: 'draft_live',
    week: null,
    asOf: '2026-08-31T00:51:00.000Z',
    freshness: fresh(),
    surfaces: ['draft', 'team', 'trades', 'players', 'setup'],
    previous: 'draft-mid',
    next: 'draft-complete',
    bundle: 'draft',
  },
  {
    ...base,
    id: 'draft-complete',
    label: 'Draft · finished',
    description:
      'Every pick made. The board is now history and reads as history; the toolbar has not moved yet, because the season has not started.',
    group: 'draft',
    lifecycle: 'post_draft',
    week: null,
    asOf: '2026-08-31T01:40:00.000Z',
    freshness: fresh(),
    surfaces: ['draft', 'team', 'trades', 'players', 'setup'],
    previous: 'draft-late',
    next: 'post-draft-roster',
    bundle: 'draft',
  },

  // ------------------------------------------------------------- post-draft
  {
    ...base,
    id: 'post-draft-roster',
    label: 'The morning after',
    description:
      'The roster exists, the season does not. Team is the home screen, the draft provenance is still on every card, and the wire is already worth a look.',
    group: 'post-draft',
    lifecycle: 'post_draft',
    week: null,
    asOf: '2026-09-01T14:00:00.000Z',
    freshness: fresh({ usage: 'unavailable', vegas: 'stale' }),
    surfaces: ['draft', 'team', 'trades', 'players', 'setup'],
    previous: 'draft-complete',
    next: 'sunday-pregame',
    bundle: 'season',
  },

  // ---------------------------------------------------------- weekly lineup
  {
    ...base,
    id: 'sunday-pregame',
    label: 'Sunday, 11:40am',
    description:
      'An hour and a bit before the one o’clock kickoffs in week 6, with the London game already gone. One flex decision is genuinely close, Floor and Ceiling disagree about it, and the matchup card is forecasting a week nothing has happened in yet.',
    group: 'weekly',
    lifecycle: 'regular_season',
    week: 6,
    asOf: '2026-10-11T15:40:00.000Z',
    freshness: fresh(),
    surfaces: ['team', 'matchup', 'waivers', 'trades', 'players', 'setup'],
    previous: 'post-draft-roster',
    next: 'late-injury-pivot',
    bundle: 'season',
  },
  {
    ...base,
    id: 'late-injury-pivot',
    label: 'Sunday, 12:52pm',
    description:
      'A starter is downgraded eight minutes before the one o’clock kickoffs. The London game is over, his replacement is on the wire and does not play until the afternoon, and the lineup is still legal to change — barely.',
    group: 'weekly',
    lifecycle: 'regular_season',
    week: 6,
    asOf: '2026-10-11T16:52:00.000Z',
    freshness: fresh({ vegas: 'stale' }),
    surfaces: ['team', 'waivers', 'trades', 'players', 'setup'],
    previous: 'sunday-pregame',
    next: 'waivers-tuesday-active',
    bundle: 'season',
  },

  // ----------------------------------------------------------- waivers/FAAB
  {
    ...base,
    id: 'waivers-tuesday-active',
    label: 'Waivers · Tuesday night',
    description:
      'A finite wallet, several funded rivals and one obvious add. What the room will pay, what he is worth to this roster and the line past which winning is worse than losing are three different numbers — and one estimate is withheld outright.',
    group: 'waivers',
    lifecycle: 'regular_season',
    week: 7,
    asOf: '2026-10-14T02:30:00.000Z',
    freshness: fresh(),
    surfaces: ['team', 'waivers', 'trades', 'players', 'setup'],
    previous: 'late-injury-pivot',
    next: 'waivers-processed',
    bundle: 'season',
  },
  {
    ...base,
    id: 'waivers-thin-data',
    label: 'Waivers · nothing to price it with',
    description:
      'The same wire in a league that has never published a bid. The upgrades still stand; every price is unknown and says so, because a bid we invented would be worse than an empty field.',
    group: 'waivers',
    lifecycle: 'regular_season',
    week: 7,
    asOf: '2026-10-14T02:30:00.000Z',
    freshness: fresh({ newsletter: 'stale' }),
    surfaces: ['team', 'waivers', 'players', 'setup'],
    bundle: 'season',
  },
  {
    ...base,
    id: 'waivers-processed',
    label: 'Waivers · Wednesday morning',
    description:
      'The run has processed. The claim landed, the budget moved, and the wire has already rearranged itself around what everybody else won.',
    group: 'waivers',
    lifecycle: 'regular_season',
    week: 7,
    asOf: '2026-10-14T13:05:00.000Z',
    freshness: fresh(),
    surfaces: ['team', 'waivers', 'trades', 'players', 'setup'],
    previous: 'waivers-tuesday-active',
    next: 'trade-window',
    bundle: 'season',
  },

  // ------------------------------------------------------------------ trades
  {
    ...base,
    id: 'trade-window',
    label: 'Trade window',
    description:
      'Discovery rather than negotiation: whose news has moved, who holds them, and which way. One name is down nine over three weeks with a multi-week injury behind it; another is the reverse.',
    group: 'trades',
    lifecycle: 'regular_season',
    week: 8,
    asOf: '2026-10-21T18:00:00.000Z',
    freshness: fresh(),
    surfaces: ['team', 'waivers', 'trades', 'players', 'setup'],
    previous: 'waivers-processed',
    next: 'playoff-week',
    bundle: 'season',
  },

  // -------------------------------------------------------- playoffs/rollover
  {
    ...base,
    id: 'playoff-week',
    label: 'Playoff week',
    description:
      'Week 15. The wire is thin, the byes are gone, and every decision is being made for one game rather than for the rest of a season.',
    group: 'season',
    lifecycle: 'playoffs',
    week: 15,
    asOf: '2026-12-11T16:00:00.000Z',
    freshness: fresh(),
    surfaces: ['team', 'waivers', 'trades', 'players', 'setup'],
    previous: 'trade-window',
    next: 'season-complete',
    bundle: 'season',
  },
  {
    ...base,
    id: 'season-complete',
    label: 'Season complete',
    description:
      'The league is finished. There is nothing left to decide, and the app says so rather than showing a lineup for a week that will not be played.',
    group: 'season',
    lifecycle: 'season_complete',
    week: 17,
    asOf: '2027-01-05T16:00:00.000Z',
    freshness: fresh({ vegas: 'unavailable', usage: 'stale' }),
    surfaces: ['team', 'trades', 'players', 'setup'],
    previous: 'playoff-week',
    next: 'rollover-new-season',
    bundle: 'season',
  },
  {
    ...base,
    id: 'rollover-new-season',
    label: 'Rollover · new season',
    description:
      'March. Last season is over, this season has no league yet, and every source is being asked for 2027 by name rather than for the newest thing it has.',
    group: 'season',
    lifecycle: 'offseason',
    season: '2027',
    week: null,
    asOf: '2027-03-14T12:00:00.000Z',
    freshness: fresh({ adp: 'unavailable', injuries: 'unavailable', usage: 'stale', vegas: 'unavailable' }),
    surfaces: ['players', 'setup'],
    previous: 'season-complete',
    next: 'provider-waiting',
    bundle: 'season',
  },
  {
    ...base,
    id: 'provider-waiting',
    label: 'Rollover · waiting on the providers',
    description:
      'July. The league exists for the new season, and half the sources have not published for it yet. The readiness check names each one and what it is waiting for.',
    group: 'season',
    lifecycle: 'preseason',
    season: '2027',
    week: null,
    asOf: '2027-07-19T12:00:00.000Z',
    freshness: fresh({ adp: 'unavailable', injuries: 'unavailable', usage: 'unavailable', vegas: 'stale' }),
    surfaces: ['draft', 'players', 'setup'],
    previous: 'rollover-new-season',
    bundle: 'season',
  },

  // ------------------------------------------------------------ degraded
  {
    ...base,
    id: 'offline-draft',
    label: 'Degraded · offline mid-draft',
    description:
      'The phone has lost the network during a draft. The board is the last one that arrived, it says how old it is, and nothing pretends to be live.',
    group: 'degraded',
    lifecycle: 'draft_live',
    week: null,
    asOf: '2026-08-31T00:19:00.000Z',
    freshness: fresh({ sleeper: 'unavailable', vegas: 'stale', injuries: 'stale' }),
    surfaces: ['draft', 'team', 'players', 'setup'],
    bundle: 'degraded',
  },
  {
    ...base,
    id: 'sleeper-adp-unavailable',
    label: 'Degraded · no draft order',
    description:
      'No ADP snapshot has ever been imported. The board still ranks, on news and roster need alone, and warns in as many words that this is a poor substitute.',
    group: 'degraded',
    lifecycle: 'draft_live',
    week: null,
    asOf: '2026-08-31T00:04:00.000Z',
    freshness: fresh({ adp: 'unavailable' }),
    surfaces: ['draft', 'players', 'setup'],
    bundle: 'degraded',
  },
  {
    ...base,
    id: 'injury-source-stale',
    label: 'Degraded · stale injury report',
    description:
      'The published report has not moved in four days. Sleeper’s own designations still stand, the practice detail is gone, and every card that lost something says which source it lost.',
    group: 'degraded',
    lifecycle: 'regular_season',
    week: 6,
    asOf: '2026-10-11T15:40:00.000Z',
    freshness: fresh({ injuries: 'stale' }),
    surfaces: ['team', 'waivers', 'players', 'setup'],
    bundle: 'degraded',
  },
  {
    ...base,
    id: 'partial-provider-outage',
    label: 'Degraded · partial outage',
    description:
      'The market is gone and the usage file is stale, at the same time. Two of the four numbers behind every recommendation are unknown — and the recommendation is still made, from what is left, with its confidence lowered.',
    group: 'degraded',
    lifecycle: 'regular_season',
    week: 6,
    asOf: '2026-10-11T15:40:00.000Z',
    freshness: fresh({ vegas: 'unavailable', usage: 'stale', injuries: 'stale' }),
    surfaces: ['team', 'waivers', 'trades', 'players', 'setup'],
    bundle: 'degraded',
  },
  {
    ...base,
    id: 'dog-unavailable',
    label: 'Degraded · no Underdog board',
    description:
      'No Underdog file has ever been imported. The DOG column is absent rather than blank, the market baseline is Sleeper alone at full weight, and the board says which of those two things happened.',
    group: 'degraded',
    lifecycle: 'draft_live',
    week: null,
    asOf: '2026-08-31T00:04:00.000Z',
    freshness: fresh({ dogAdp: 'unavailable' }),
    surfaces: ['draft', 'players', 'setup'],
    bundle: 'degraded',
  },
  {
    ...base,
    id: 'dog-stale',
    label: 'Degraded · the Underdog file is nine days old',
    description:
      'A snapshot exists and is not trusted. Nine days past its effective time is beyond the week the board will treat as a current market, so DOG is withheld, the baseline falls back to Sleeper alone, and the reason is said out loud rather than left as an empty column.',
    group: 'degraded',
    lifecycle: 'draft_live',
    week: null,
    asOf: '2026-08-31T00:04:00.000Z',
    freshness: fresh({ dogAdp: 'stale' }),
    surfaces: ['draft', 'players', 'setup'],
    bundle: 'degraded',
  },
  {
    ...base,
    id: 'dog-aging',
    label: 'Degraded · the Underdog file is three days old',
    description:
      'Past the freshness window and inside the trust window — so DOG is still used, still carries its share of the blend, and prints its age. The state between fresh and stale, which is the one a reader is most likely to meet.',
    group: 'degraded',
    lifecycle: 'draft_live',
    week: null,
    asOf: '2026-08-31T00:04:00.000Z',
    freshness: fresh({ dogAdp: 'aging' }),
    surfaces: ['draft', 'players', 'setup'],
    bundle: 'degraded',
  },

  // ---------------------------------------------------------------- best ball
  {
    ...base,
    id: 'draft-best-ball',
    label: 'Draft · best ball',
    description:
      'The same board in a league Sleeper flags as best ball. Underdog is the best-ball market, so its share of the baseline widens from 60% to 75% — read from the league’s own settings, never from its name.',
    format: BEST_BALL_LEAGUE,
    group: 'draft',
    lifecycle: 'draft_live',
    week: null,
    asOf: '2026-08-31T00:04:00.000Z',
    freshness: fresh(),
    surfaces: ['draft', 'players', 'setup'],
    bundle: 'draft',
  },

  // ------------------------------------------------------------------ matchup
  /*
   * One Sunday, read from five points in it.
   *
   * Four share a clock and differ only in what has happened on the field, which
   * is what "close", "ahead" and "behind" actually are — three afternoons at
   * the same time of day rather than three times of day. The fifth is read on
   * the Monday, after the night game.
   *
   * They are ordered so the picker's previous/next controls walk a reader from
   * a game that is still anybody's to one that is over. Nothing about a
   * scenario states a win probability, a phase or an insight: the clock, the
   * kickoffs and the scoreboard are the inputs, and `core/matchup` reaches
   * every conclusion from them.
   */
  ...(
    [
      ['matchup-live-close', 'Matchup · one point in it', 'Three games finished, three running and two to come, with the two projected finals less than half a point apart.', '2026-10-11T21:20:00.000Z'],
      ['matchup-live-leading', 'Matchup · leading', 'Ahead with players left, and the card is about which of the opponent’s remaining names can still take it.', '2026-10-11T21:20:00.000Z'],
      ['matchup-live-trailing', 'Matchup · trailing', 'Behind, and the card does the arithmetic: how much is needed, from whom, to get back to a real chance.', '2026-10-11T21:20:00.000Z'],
      ['matchup-injury-swing', 'Matchup · an injury swings it', 'A starter is ruled out of the night game while his slot is still changeable, and the swap is priced in win probability.', '2026-10-11T21:20:00.000Z'],
      ['matchup-final', 'Matchup · final', 'The week is over. What decided it, and what would have.', '2026-10-12T06:30:00.000Z'],
    ] as const
  ).map(([id, label, description, asOf], index, all): DemoScenario => ({
    ...base,
    id,
    label,
    description,
    group: 'matchup',
    lifecycle: 'regular_season',
    week: 6,
    asOf,
    freshness: fresh(),
    surfaces: ['matchup', 'team'],
    ...(index > 0 ? { previous: all[index - 1]![0] } : {}),
    ...(index < all.length - 1 ? { next: all[index + 1]![0] } : {}),
    bundle: 'season',
  })),
];

const BY_ID = new Map(DEMO_SCENARIOS.map((s) => [s.id, s]));

export function findScenario(id: string | null | undefined): DemoScenario | null {
  if (!id) return null;
  return BY_ID.get(id) ?? null;
}

/** The scenarios a reader may actually run. */
export function selectableScenarios(): DemoScenario[] {
  return DEMO_SCENARIOS.filter((s) => s.awaiting == null);
}

/** The default a reader lands on when they turn Demo Mode on. */
export const DEFAULT_SCENARIO_ID = 'draft-mid';
