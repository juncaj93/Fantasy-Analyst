/**
 * How a scenario's world is written down, and how it becomes real data.
 *
 * The rule that shapes this file: **a fixture states inputs, never outputs.**
 * §9 asks for interesting fixtures, and §8 is explicit that the numbers a
 * waiver card shows must come from the real engine rather than from hardcoded
 * display text. So nothing here is a score, a recommendation, a bid, a
 * survival percentage or a sentence. What is written down is what a provider
 * would have said — a market line, a designation, a target count, a pick — and
 * every conclusion is computed from it by the same code production runs.
 *
 * The specs are deliberately compact. Writing four market rows by hand for
 * sixty players would make the fixtures unreadable and unmaintainable, so a
 * player states one number — what the market thinks he is worth this week — and
 * the expander below turns it into position-appropriate lines. Those lines are
 * then converted to points by `buildExpectation`, using the league's own
 * scoring, exactly as a real quote would be.
 */

import { normalizeName } from '../../identity/normalize.ts';
import type { CanonicalPlayer } from '../../identity/types.ts';
import { emptySignal } from '../../evidence/aggregate.ts';
import type { PlayerSignal } from '../../evidence/types.ts';
import type { PlayerProp } from '../../vegas/types.ts';
import type { UsageWeek } from '../../usage/role.ts';
import {
  normalizeDesignation,
  normalizePractice,
  resolveInjury,
  type InjuryObservation,
  type InjuryState,
} from '../../injury/model.ts';
import type { Clock } from '../clock.ts';
import { hoursBefore } from '../clock.ts';

export type DemoPosition = 'QB' | 'RB' | 'WR' | 'TE' | 'DEF';

/** One player in a scenario's world. */
export interface DemoPlayerSpec {
  id: string;
  name: string;
  position: DemoPosition;
  team: string;
  /** Sleeper's roster status. Not the injury report — that is `injury`. */
  status?: string | null;
  active?: boolean;
  /** Sleeper's search prominence. Never a draft position; only a tie-break. */
  searchRank?: number;
  /** Where the frozen Sleeper draft-order snapshot puts him, when it covers him. */
  adp?: number;
  /**
   * Where Underdog puts him, when Underdog has priced him.
   *
   * Deliberately independent of `adp`. Absent means Underdog has no number for
   * this player, which is a real and common state — the board renormalises the
   * blend around it and says it did, and a fixture that filled it in from the
   * Sleeper value would be quietly asserting the two markets always agree.
   */
  dogAdp?: number;
  /** The newsletter ledger's verdict, as windows rather than as prose. */
  news?: DemoNewsSpec;
  /** What the season-long market expects of him, for the draft board. */
  seasonMarkets?: { market: DemoSeasonMarket; line: number }[];
  /** This week, when the scenario is in one. */
  week?: DemoWeekSpec;
  /** The user's own rating and bookmark. */
  myGuy?: 0 | 1 | 2 | 3;
  queued?: boolean;
}

export type DemoSeasonMarket =
  | 'season_pass_yards'
  | 'season_pass_tds'
  | 'season_rush_yards'
  | 'season_rush_tds'
  | 'season_receptions'
  | 'season_receiving_yards'
  | 'season_receiving_tds';

export interface DemoNewsSpec {
  /** Lifetime net. Positive is good news, negative is bad. */
  net: number;
  items: number;
  /** Last thirty days. Defaults to the lifetime net, which is the common case. */
  net30?: number;
  net7?: number;
  /** Items the classifier would not call either way — the conflict signal. */
  mixed?: number;
  pending?: number;
  /** How long ago the newest item landed, in hours. */
  lastItemHoursAgo?: number;
}

export interface DemoWeekSpec {
  /**
   * What the market thinks he scores this week, in this league's points.
   *
   * A *target*, not an answer: the expander converts it into the market lines a
   * sportsbook would publish, and the engine converts those back through the
   * league's own scoring. The two differ by the rounding a real line has, which
   * is the point — the number on screen is the engine's, not this one.
   *
   * Null means no market at all: a bye, or a game nobody prices.
   */
  points: number | null;
  /** The same figure at the previous snapshot, so line movement is real. */
  previousPoints?: number | null;
  /** Hours from the scenario clock to kickoff. Negative means already started. */
  kickoffInHours?: number | null;
  opponent?: string | null;
  /** His team's spread. Negative is favoured. */
  spread?: number | null;
  total?: number | null;
  /**
   * Whether his team is at home.
   *
   * Read by exactly one model — the defence projection, which is the only place
   * in this app where home field is worth a term. Absent removes the term
   * rather than putting anybody on the road by default, which is the same rule
   * the live assembly follows when no fixture list has been ingested.
   */
  home?: boolean | null;
  /** Per-game opportunity, newest week last. */
  usage?: DemoUsageSpec;
  injury?: DemoInjurySpec;
}

/**
 * A usage series, written as the two numbers that matter for his position.
 *
 * `toRoleMetrics` reads carries and targets for a back, targets and target
 * share for a receiver, attempts and carries for a quarterback — so a spec
 * gives those directly rather than a whole stat line nobody reads.
 */
export interface DemoUsageSpec {
  /** Week numbers, oldest first, paired positionally with the series below. */
  weeks: number[];
  primary: number[];
  secondary?: number[];
  /** Touchdowns per week, for the touchdown-dependency read. */
  touchdowns?: number[];
  yards?: number[];
}

export interface DemoInjurySpec {
  /** As the source wrote it: `Questionable`, `Out`, `Doubtful`, `IR`. */
  designation: string;
  bodyPart?: string | null;
  /** Practice participation across the week, oldest first. */
  practice?: (string | null)[];
  /** How old the published report is, in hours. */
  reportHoursAgo?: number;
  /** Sleeper's own designation, when it disagrees with the report. */
  sleeperSays?: string | null;
}

// ---------------------------------------------------------------- expansion

export function toCanonicalPlayer(spec: DemoPlayerSpec): CanonicalPlayer {
  const [first = '', ...rest] = spec.name.split(' ');
  return {
    id: spec.id,
    sleeperPlayerId: spec.id,
    fullName: spec.name,
    firstName: first,
    lastName: rest.join(' '),
    team: spec.team,
    position: spec.position,
    status: spec.status ?? null,
    active: spec.active ?? true,
    normalizedName: normalizeName(spec.name),
    aliases: [],
    externalIds: {},
    searchRank: spec.searchRank ?? null,
  };
}

export function toSignal(spec: DemoPlayerSpec, clock: Clock): PlayerSignal | null {
  const news = spec.news;
  if (!news) return null;
  const signal = emptySignal(spec.id);
  const window = (net: number, items: number) => ({
    positive: Math.max(0, net),
    negative: Math.max(0, -net),
    net,
    items,
  });
  signal.raw = window(news.net, news.items);
  signal.seasonToDate = window(news.net, news.items);
  signal.last30 = window(news.net30 ?? news.net, Math.min(news.items, Math.max(1, Math.round(news.items * 0.6))));
  signal.last7 = window(news.net7 ?? 0, news.net7 ? Math.max(1, Math.round(news.items * 0.25)) : 0);
  signal.mixedCount = news.mixed ?? 0;
  signal.pendingCount = news.pending ?? 0;
  signal.lastEvidenceAt = hoursBefore(clock, news.lastItemHoursAgo ?? 30);
  signal.updatedAt = clock.iso();
  return signal;
}

/**
 * How a week's points are spread across the markets a book actually publishes.
 *
 * The proportions are ordinary for the position — a receiver's points are
 * mostly yardage, a back's are mostly carries plus a real chance of a score —
 * and they exist so that one authored number produces a plausible *set* of
 * lines rather than a single synthetic one. The engine still has to find every
 * market it expects, so a player with a full spread reads `coverage: 1` and one
 * with a gap says which market is missing, exactly as a live quote would.
 */
const MARKET_SHAPE: Record<DemoPosition, { market: PlayerProp['market']; share: number; perUnit: number; step: number }[]> = {
  QB: [
    { market: 'pass_yards', share: 0.62, perUnit: 0.04, step: 5 },
    { market: 'pass_tds', share: 0.28, perUnit: 4, step: 0.5 },
    { market: 'rush_yards', share: 0.1, perUnit: 0.1, step: 5 },
  ],
  RB: [
    { market: 'rush_yards', share: 0.45, perUnit: 0.1, step: 5 },
    { market: 'receiving_yards', share: 0.15, perUnit: 0.1, step: 5 },
    { market: 'receptions', share: 0.13, perUnit: 0.5, step: 0.5 },
    { market: 'anytime_td', share: 0.27, perUnit: 6, step: 0.01 },
  ],
  WR: [
    { market: 'receiving_yards', share: 0.62, perUnit: 0.1, step: 5 },
    { market: 'receptions', share: 0.16, perUnit: 0.5, step: 0.5 },
    { market: 'anytime_td', share: 0.22, perUnit: 6, step: 0.01 },
  ],
  TE: [
    { market: 'receiving_yards', share: 0.6, perUnit: 0.1, step: 5 },
    { market: 'receptions', share: 0.2, perUnit: 0.5, step: 0.5 },
    { market: 'anytime_td', share: 0.2, perUnit: 6, step: 0.01 },
  ],
  DEF: [],
};

/** Round to the nearest step a real line is published on. */
function toStep(value: number, step: number): number {
  return Math.round(value / step) * step;
}

export function toProps(spec: DemoPlayerSpec, points: number | null, opts: { missing?: PlayerProp['market'][] } = {}): PlayerProp[] {
  if (points == null) return [];
  const shape = MARKET_SHAPE[spec.position];
  const missing = new Set(opts.missing ?? []);
  const out: PlayerProp[] = [];
  for (const entry of shape) {
    if (missing.has(entry.market)) continue;
    const raw = (points * entry.share) / entry.perUnit;
    const value = Math.max(entry.step, toStep(raw, entry.step));
    out.push({
      playerId: spec.id,
      sourcePlayerName: spec.name,
      market: entry.market,
      // Anytime TD is a probability, not a line, and the engine reads it as one.
      line: entry.market === 'anytime_td' ? null : value,
      overPrice: -110,
      underPrice: -110,
      bookCount: 4,
      consensusMethod: 'median',
      books: ['demo-a', 'demo-b', 'demo-c', 'demo-d'],
      impliedProbability: entry.market === 'anytime_td' ? Math.min(0.92, Math.max(0.02, value)) : null,
    });
  }
  return out;
}

export function toUsageWeeks(spec: DemoPlayerSpec): UsageWeek[] {
  const usage = spec.week?.usage;
  if (!usage) return [];
  return usage.weeks.map((week, i) => {
    const primary = usage.primary[i] ?? null;
    const secondary = usage.secondary?.[i] ?? null;
    const base: UsageWeek = {
      week,
      seasonType: 'REG',
      passAttempts: null,
      carries: null,
      targets: null,
      receptions: null,
      targetShare: null,
      wopr: null,
    };
    if (spec.position === 'QB') {
      base.passAttempts = primary;
      base.carries = secondary;
      base.passYards = usage.yards?.[i] ?? null;
      base.passTds = usage.touchdowns?.[i] ?? null;
    } else if (spec.position === 'RB') {
      base.carries = primary;
      base.targets = secondary;
      base.receptions = secondary == null ? null : Math.round(secondary * 0.75);
      base.rushYards = usage.yards?.[i] ?? null;
      base.rushTds = usage.touchdowns?.[i] ?? null;
    } else {
      base.targets = primary;
      base.targetShare = secondary;
      base.receptions = primary == null ? null : Math.round(primary * 0.65);
      base.recYards = usage.yards?.[i] ?? null;
      base.recTds = usage.touchdowns?.[i] ?? null;
    }
    return base;
  });
}

/**
 * Availability, resolved by the same resolver the live app uses.
 *
 * The fixture writes down observations — what Sleeper says, what the published
 * report says, how the week's practices went — and `resolveInjury` decides what
 * that adds up to, including whether the two sources materially conflict. That
 * is why a demo can show a real conflict note: nobody wrote one.
 */
export function toInjuryState(spec: DemoPlayerSpec, clock: Clock): InjuryState | null {
  const injury = spec.week?.injury;
  if (!injury) return null;
  const observations: InjuryObservation[] = [];
  const reported = normalizeDesignation(injury.designation);

  observations.push({
    source: 'nflverse injury report',
    observedAt: hoursBefore(clock, injury.reportHoursAgo ?? 20),
    designation: reported.designation,
    raw: reported.raw,
    bodyPart: injury.bodyPart ?? null,
    practice: (injury.practice ?? []).map((day) => normalizePractice(day)),
  });

  /*
   * Sleeper's own word, second, so the two can disagree.
   *
   * Which is the point: `resolveInjury` is what decides whether a difference is
   * material, and a scenario that wants a real conflict note simply states two
   * sources that differ. Nobody writes the note.
   */
  const sleeperRaw = injury.sleeperSays !== undefined ? injury.sleeperSays : spec.status;
  if (sleeperRaw) {
    const sleeper = normalizeDesignation(sleeperRaw);
    observations.push({
      source: 'sleeper',
      observedAt: hoursBefore(clock, 1),
      designation: sleeper.designation,
      raw: sleeper.raw,
      bodyPart: null,
      practice: [],
    });
  }

  return resolveInjury(observations, clock.now());
}
