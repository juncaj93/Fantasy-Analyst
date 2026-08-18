/**
 * What a Demo Mode scenario *is*.
 *
 * Demo Mode is a data-source substitution layer, not a second app: it renders
 * the real production screens, through the real production engines, over
 * controlled fixture data. A scenario is therefore not a mock-up of a screen.
 * It is a declaration of the world the app is being asked to reason about — the
 * lifecycle state, the clock, the league, how fresh each source is — plus the
 * fixtures that make that world concrete.
 *
 * Everything on `DemoScenario` is metadata and stays in the main bundle,
 * because the Settings list has to be able to name every scenario before any of
 * them is chosen. The fixtures themselves are lazily imported per bundle; see
 * `fixtures/index.ts`.
 */

import type { SeasonLifecycle } from '../season/lifecycle.ts';

/**
 * The bump that invalidates a reproduction.
 *
 * §10 requires that a scenario reproduce identically for the same fixture
 * version. That is a promise about a *pair*: the scenario id and this string.
 * Change a fixture's numbers and this must move, or a screenshot taken last
 * month and one taken today would both claim to be `waivers-tuesday-active`
 * while showing different bids.
 */
export const FIXTURE_VERSION = '2026.08.2';

/**
 * The production surfaces a scenario can speak to.
 *
 * Named after the destinations in the toolbar plus the two shared sheets, so
 * "which screens is this scenario about" is answerable without knowing anything
 * about routes.
 */
export type DemoSurface =
  | 'draft'
  | 'team'
  | 'waivers'
  | 'trades'
  | 'players'
  | 'matchup'
  | 'review'
  | 'setup';

/** The families the Settings list groups scenarios under. */
export type DemoGroup =
  | 'draft'
  | 'post-draft'
  | 'waivers'
  | 'weekly'
  | 'matchup'
  | 'trades'
  | 'season'
  | 'degraded';

/**
 * How fresh each source is *inside the scenario*.
 *
 * Not decoration. A degraded scenario is exactly a scenario whose source
 * freshness is unusual, and the app already has honest language for stale and
 * absent data — this is what drives it there rather than a special "degraded"
 * flag the screens would have to learn.
 */
/**
 * `aging` is not a synonym for `stale`, and the difference is the point.
 *
 * The Underdog path distinguishes them: a file past its 36-hour window is
 * `aging` and is still used, with its age printed; past 168 hours it is `stale`
 * and is withheld entirely. A demo that collapsed the two could not show the
 * state where the board is honest about an old number and uses it anyway.
 */
export type DemoSourceState = 'fresh' | 'aging' | 'stale' | 'unavailable' | 'not_applicable';

export interface DemoSourceFreshness {
  sleeper: DemoSourceState;
  /** The frozen draft-order snapshot. */
  adp: DemoSourceState;
  /** Underdog's board — a second, independent draft market. */
  dogAdp: DemoSourceState;
  injuries: DemoSourceState;
  usage: DemoSourceState;
  vegas: DemoSourceState;
  newsletter: DemoSourceState;
}

/** The shape of the league a scenario is played in. */
export interface DemoLeagueFormat {
  name: string;
  teams: number;
  scoringLabel: string;
  /**
   * True for a best-ball league.
   *
   * It changes the market blend and nothing else: Underdog *is* the best-ball
   * market, so its share of the baseline widens from 60% to 75%. The board
   * reads it from Sleeper's own settings, so a scenario states the setting and
   * lets `detectBestBall` reach the conclusion.
   */
  bestBall: boolean;
  superflex: boolean;
  /** Whether the league bids for waivers, and for how much. Null means it does not publish one. */
  faabBudget: number | null;
}

/**
 * A scenario that the production feature does not exist for yet.
 *
 * §18 is explicit that the final merge must not pretend missing functionality
 * exists, and §8 asks for Matchup scenarios "once Matchup exists". So a
 * scenario may be *declared* — named, described, given a lifecycle and a clock —
 * and marked as awaiting its surface. The picker shows it, says plainly what it
 * is waiting for, and refuses to select it. That is the difference between a
 * roadmap and a lie.
 */
export interface DemoAwaiting {
  /** The surface that has to land first. */
  surface: DemoSurface;
  /** One sentence, in the user's language, about what is missing. */
  reason: string;
}

export interface DemoScenario {
  id: string;
  label: string;
  description: string;
  group: DemoGroup;
  lifecycle: SeasonLifecycle;
  season: string;
  /** The NFL week the scenario sits in. Null before week one. */
  week: number | null;
  /**
   * The scenario's clock, as an ISO instant.
   *
   * Everything time-dependent in the app already takes an injected `now` — the
   * start/sit engine, the injury resolver, the season resolver. Demo Mode feeds
   * them this instead of the device clock, which is why Tuesday waivers, Sunday
   * pregame and a completed week are all reachable without touching a phone's
   * settings and without monkeypatching `Date`.
   */
  asOf: string;
  format: DemoLeagueFormat;
  /** The league this scenario selects. Fixture-local, never a real Sleeper id. */
  leagueId: string;
  freshness: DemoSourceFreshness;
  fixtureVersion: string;
  /** Surfaces this scenario has something deliberate to say about. */
  surfaces: DemoSurface[];
  /** Set when the production surface does not exist yet. */
  awaiting?: DemoAwaiting;
  /** Explicit previous/next states, for the optional progression controls. */
  previous?: string;
  next?: string;
  /** Which lazily-imported fixture module carries the payload. */
  bundle: DemoBundleId;
}

/**
 * The lazily-imported fixture modules.
 *
 * Grouped by when they are needed rather than one per scenario: a reader
 * stepping Tuesday waivers → processed → Wednesday roster should not pay three
 * network round trips to do it, and the scenarios in a family share most of
 * their world anyway.
 */
export type DemoBundleId = 'draft' | 'season' | 'degraded';

/** A scenario the picker may actually select. */
export function isSelectable(scenario: DemoScenario): boolean {
  return scenario.awaiting == null;
}
