/**
 * Deterministic start/sit comparison.
 *
 * Components stay separate and inspectable, exactly like the draft engine.
 * Missing Vegas data lowers confidence and is surfaced — it is never imputed,
 * and it never silently becomes a zero that looks like a real projection.
 *
 * Safety: this module recommends. It never edits a lineup.
 */

import type { PlayerSignal } from '../evidence/types.ts';
import type { CanonicalPlayer } from '../identity/types.ts';
import type { ScoringProfile } from '../sleeper/scoring.ts';
import type { PlayerProp } from '../vegas/types.ts';
import {
  assessLateSwap,
  assessRole,
  compareMarkets,
  lockState,
  rolePoints,
  type LateSwapAssessment,
  type LockState,
  type MovementSummary,
  type RoleAssessment,
  type RoleMetric,
} from './decisions.ts';
import { buildExpectation, type VegasExpectation } from './expectation.ts';
import { availabilityPenalty, AVAILABLE } from '../injury/startsit.ts';
import { NO_INJURY_INFORMATION, normalizeDesignation, resolveInjury, type InjuryState } from '../injury/model.ts';
import type { UsageWeek } from '../usage/role.ts';
import { availabilityConfidence, type AvailabilityView } from './availabilityConfidence.ts';
import { assessMatchup, NO_MATCHUP, type DefenseTendencyIndex, type MatchupAssessment } from './defense.ts';
import { assessGameScript, NO_GAME_SCRIPT, type GameContext, type GameScriptAssessment } from './gameScript.ts';
import { assessMarketComparability, COMPARABLE, type MarketComparability } from './comparability.ts';
import { compareWithMarket, type MarketAgreement } from './market.ts';
import { modeWeightFor, type StartSitMode } from './mode.ts';
import { classifyRole, UNCLASSIFIED, type RoleProfile } from './roleProfile.ts';
import { assessTdDependency, NO_TD_DATA, type TdDependencyAssessment } from './tdDependency.ts';
import { assessUsage, NO_USAGE, type UsageAssessment } from './usageTrend.ts';
import { assessWeather, type GameWeather, type WeatherAssessment } from './weather.ts';

export interface StartSitInput {
  player: CanonicalPlayer;
  props: PlayerProp[];
  signal: PlayerSignal | null;
  /** Sleeper injury status ('Questionable', 'Out', 'IR', ...). */
  injuryStatus?: string | null;
  /**
   * The normalized state, when the caller has one.
   *
   * Preferred over `injuryStatus`, and the reason this parameter exists: a
   * designation on its own cannot tell a player who practised fully all week
   * from one who has not practised at all, and those are not the same lineup
   * decision. Callers without the injury layer may still pass the bare status,
   * and it is normalized here into the same shape so there is exactly one
   * interpretation of the word in the codebase.
   */
  injury?: InjuryState | null;
  /** How stale the props are, in minutes. Null when there are none. */
  propAgeMinutes?: number | null;
  /** True when the props came from a stale cache. */
  propsStale?: boolean;
  /** ISO kickoff for this player's game, when the schedule is known. */
  kickoff?: string | null;
  /** The same player's lines at an earlier snapshot, for movement. */
  previousProps?: PlayerProp[];
  /** Per-game opportunity, when a usage source is connected. */
  usage?: RoleMetric[];
  /**
   * The stored weeks the metrics above were built from.
   *
   * Passed separately rather than derived from `usage`, because the questions
   * are different: `RoleMetric[]` is two deliberately-disagreeing series for
   * change detection, and these are the raw rows the opportunity level, the
   * role classification and the touchdown-dependency read all need. Absent
   * means no usage source, and every one of those answers "unknown".
   */
  usageWeeks?: UsageWeek[];
  /** The spread and total for his game, when the market has priced it. */
  game?: GameContext | null;
  /** The forecast for his game, when one is available. */
  weather?: GameWeather | null;
  /** Opponent tendencies by role, built once for the whole board. */
  defenseTendencies?: DefenseTendencyIndex;
  /** The defence he faces this week, when the schedule is known. */
  opponent?: string | null;
  /** Floor, Balanced or Ceiling. Defaults to Balanced. */
  mode?: StartSitMode;
  /** Reference time; defaults to now. Injected so tests are deterministic. */
  now?: string | Date;
}

export interface StartSitComponent {
  key: string;
  label: string;
  display: string;
  /**
   * Points-denominated where possible, so components stay interpretable.
   *
   * This is the value **after** the mode multiplier, because it is the number
   * that actually moved the score and a breakdown that shows anything else is
   * not a breakdown. `baseValue` and `modeWeight` keep the arithmetic visible.
   */
  value: number;
  /** The value before the Floor/Ceiling multiplier. */
  baseValue: number;
  /** What the mode did to it. 1 in Balanced, and 1 for anything mode-neutral. */
  modeWeight: number;
  unknown: boolean;
}

export interface StartSitEvaluation {
  playerId: string;
  name: string;
  position: string;
  team: string;
  expectation: VegasExpectation;
  components: StartSitComponent[];
  /** Final comparable score, in fantasy points. */
  score: number | null;
  confidence: 'high' | 'medium' | 'low';
  confidenceReasons: string[];
  statusFlag: string | null;
  /** Everything known about his availability, for the card and the reasons. */
  injury: InjuryState;
  /** True when he must not be recommended as a starter: Out, IR, PUP, suspended. */
  ruledOut: boolean;
  /** Whether this player's game has already kicked off. */
  lock: LockState;
  /** The defence he faces, when the schedule is known. */
  opponent: string | null;
  /** How the market has moved since the previous snapshot. */
  movement: MovementSummary;
  /** Whether the player's opportunity is actually changing. */
  role: RoleAssessment;
  /** Which question the score was answering. */
  mode: StartSitMode;
  /** How much opportunity he is getting, recency-weighted. */
  usage: UsageAssessment;
  /** What kind of player the usage says he is. */
  roleProfile: RoleProfile;
  /** How much of his production needed a touchdown. */
  tdDependency: TdDependencyAssessment;
  /** The game he is walking into. */
  gameScript: GameScriptAssessment;
  /** The forecast, and what it does to his role. */
  weather: WeatherAssessment;
  /** What this defence gives up to his role. */
  matchup: MatchupAssessment;
  /** Availability as a state a person can act on. */
  availability: AvailabilityView;
  /**
   * The two to four things that actually decided this, biggest first.
   *
   * Derived from the components rather than written beside them, so a driver
   * can never describe a signal the score did not use.
   */
  drivers: string[];
  /** Where the evidence points different ways, said rather than averaged. */
  conflicts: string[];
}

export interface StartSitComparison {
  evaluations: StartSitEvaluation[];
  /** Null when no player has enough data to justify a recommendation. */
  recommendedPlayerId: string | null;
  margin: number | null;
  confidence: 'high' | 'medium' | 'low';
  reasons: string[];
  warnings: string[];
  /** Whether the preferred player being the later player is a problem. */
  lateSwap: LateSwapAssessment;
  /** Which question was asked. */
  mode: StartSitMode;
  /** Whether the betting market would make the same choice. */
  market: MarketAgreement;
  /**
   * Whether the top two were priced on the same markets at all.
   *
   * A gap between two totals built from different market sets is a fact about
   * the provider's coverage before it is a fact about the players.
   */
  comparability: MarketComparability;
}

/** Status penalties in fantasy points. Editable policy, not a projection. */
export const STATUS_PENALTY: Record<string, number> = {
  OUT: -99,
  IR: -99,
  SUS: -99,
  PUP: -99,
  DOUBTFUL: -6,
  QUESTIONABLE: -1.5,
};

/** Points added per net unit of recent news signal. Deliberately small. */
export const NEWS_POINTS_PER_UNIT = 0.35;
export const NEWS_RECENT_CAP = 2.1;
export const NEWS_RAW_CAP = 1.2;

export function evaluatePlayer(input: StartSitInput, profile: ScoringProfile): StartSitEvaluation {
  const expectation = buildExpectation(input.player.position, input.props, profile);
  const mode = input.mode ?? 'balanced';
  const components: StartSitComponent[] = [];
  const confidenceReasons: string[] = [];

  /**
   * Add a component, with the mode multiplier applied once and recorded.
   *
   * Every component goes through here. That is what makes "the mode reweights
   * one argument rather than running a second engine" a property of the code
   * rather than a claim in a comment: there is exactly one place a Floor or
   * Ceiling weight can be applied, and it cannot change a component's sign.
   */
  const push = (component: Omit<StartSitComponent, 'baseValue' | 'modeWeight' | 'value'> & { value: number }) => {
    const weight = component.unknown ? 1 : modeWeightFor(component.key, mode, component.value);
    components.push({
      ...component,
      baseValue: round2(component.value),
      modeWeight: weight,
      value: round2(component.value * weight),
    });
    return components[components.length - 1]!;
  };

  push({
    key: 'vegas',
    label: 'Vegas market expectation',
    display: expectation.points == null ? 'unavailable' : `${expectation.points.toFixed(1)} pts`,
    value: expectation.points ?? 0,
    unknown: expectation.points == null,
  });

  const recentNet = input.signal?.last30.net ?? 0;
  const recentItems = input.signal?.last30.items ?? 0;
  const recentValue = clamp(recentNet * NEWS_POINTS_PER_UNIT, -NEWS_RECENT_CAP, NEWS_RECENT_CAP);
  push({
    key: 'news_recent',
    label: 'Recent news (30d)',
    display: recentItems === 0 ? 'no recent evidence' : `${recentNet > 0 ? '+' : ''}${recentNet} net over ${recentItems} item(s)`,
    value: round2(recentValue),
    unknown: recentItems === 0,
  });

  const rawNet = input.signal?.raw.net ?? 0;
  const rawItems = input.signal?.raw.items ?? 0;
  const rawValue = clamp(rawNet * (NEWS_POINTS_PER_UNIT / 2), -NEWS_RAW_CAP, NEWS_RAW_CAP);
  push({
    key: 'news_raw',
    label: 'Lifetime news',
    display: rawItems === 0 ? 'no evidence' : `${rawNet > 0 ? '+' : ''}${rawNet} net over ${rawItems} item(s)`,
    value: round2(rawValue),
    unknown: rawItems === 0,
  });

  /*
   * Availability, read from the normalized injury state.
   *
   * Out, IR, PUP and suspended are facts and cost a gate. Questionable is a
   * question, and the week's practice report is the best free answer to it —
   * so the same word costs a full participant about a third of what it costs
   * somebody who has not practised. Bounded either way, and pulled back toward
   * the plain designation when the report is stale or the sources disagree.
   */
  const injury = resolveInjuryState(input);
  const availability = availabilityPenalty(injury);
  const availabilityView = availabilityConfidence(injury);
  const statusPenalty = availability.points;
  push({
    key: 'status',
    label: 'Availability',
    // The designation, the practice week and the state a person reads, in one
    // line — all three from the same resolved object, so they cannot disagree.
    display:
      availabilityView.state === 'unknown' || availabilityView.state === 'high_confidence_active'
        ? availability.display
        : `${availability.display} · ${availabilityView.label.toLowerCase()}`,
    value: statusPenalty,
    unknown: injury.designation === 'unknown',
  });
  if (availability.note) confidenceReasons.push(availability.note);
  if (injury.conflict && injury.conflictNote) confidenceReasons.push(`injury sources disagree — ${injury.conflictNote}`);

  // Uncertainty penalty: thin or stale market data reduces the score slightly,
  // so a well-covered player wins ties against a poorly-covered one.
  let uncertainty = 0;
  if (expectation.points == null) {
    uncertainty -= 0;
    confidenceReasons.push('no Vegas data');
  } else {
    if (expectation.coverage < 1) {
      uncertainty -= (1 - expectation.coverage) * 1.5;
      confidenceReasons.push(`partial market coverage (${Math.round(expectation.coverage * 100)}%)`);
    }
    if ((expectation.minBookCount ?? 0) === 1) {
      uncertainty -= 0.5;
      confidenceReasons.push('single book behind at least one market');
    }
    if (input.propsStale) {
      uncertainty -= 0.75;
      confidenceReasons.push('prop data is stale');
    }
  }
  push({
    key: 'uncertainty',
    label: 'Uncertainty penalty',
    display: uncertainty === 0 ? 'none' : `${uncertainty.toFixed(2)} pts`,
    value: round2(uncertainty),
    unknown: false,
  });

  /*
   * --- opportunity, and the change in it ------------------------------------
   *
   * Two components off one source, kept apart because they answer different
   * questions: `usage_level` is how much of the offence he is getting, and
   * `role_trend` is whether that is moving. Their sum is capped below, in the
   * one place interactions are allowed to live, because a player whose targets
   * doubled scores on both and should not be paid twice for the same month.
   *
   * Neither reads a fantasy point. That is the rule the whole section exists
   * for — see the header of `usageTrend.ts`.
   */
  const weeks = input.usageWeeks ?? [];
  const usage = weeks.length > 0 ? assessUsage(input.player.position, weeks) : NO_USAGE;
  push({
    key: 'usage_level',
    label: 'Opportunity',
    display: usage.display,
    value: usage.points,
    unknown: usage.unknown,
  });

  // A modest nudge, and only in a close call: a rising role is a reason to
  // prefer one of two similar players, never a reason to start a worse one.
  // With no usage source connected this is `insufficient_data` and contributes
  // nothing, which is the honest answer rather than a zero dressed as a signal.
  const role = assessRole(input.usage ?? []);
  const roleValue = rolePoints(role.trend);
  push({
    key: 'role_trend',
    label: 'Role trend',
    display: role.trend === 'insufficient_data' ? 'insufficient data' : role.label,
    value: roleValue,
    unknown: role.trend === 'insufficient_data',
  });

  /*
   * --- what kind of player he is, and what that meets ------------------------
   *
   * The role profile is not scored. It is the key everything below looks itself
   * up under: the matchup, the weather sensitivity and the game-script
   * direction all mean different things for a downfield receiver than for an
   * underneath one, and this is where that distinction is made once.
   */
  const roleProfile = weeks.length > 0 ? classifyRole(input.player.position, weeks) : UNCLASSIFIED;

  const td = weeks.length > 0 ? assessTdDependency(input.player.position, weeks) : NO_TD_DATA;
  push({
    key: 'td_dependency',
    label: 'Touchdown dependency',
    display: td.display,
    value: td.points,
    unknown: td.profile === 'insufficient_data',
  });

  const gameScript = input.game ? assessGameScript(input.player.position, roleProfile.bucket, input.game) : NO_GAME_SCRIPT;
  push({
    key: 'game_script',
    label: 'Game script',
    display: gameScript.display,
    value: gameScript.points,
    unknown: gameScript.unknown,
  });

  const weather = assessWeather(input.player.position, roleProfile.bucket, input.weather);
  push({
    key: 'weather',
    label: 'Weather',
    display: weather.display,
    value: weather.points,
    unknown: weather.unknown,
  });

  const matchup = input.defenseTendencies
    ? assessMatchup(
        { position: input.player.position, bucket: roleProfile.bucket, defense: input.opponent ?? null },
        input.defenseTendencies,
      )
    : NO_MATCHUP;
  push({
    key: 'matchup_role',
    label: 'Opponent by role',
    display: matchup.display,
    value: matchup.points,
    unknown: matchup.unknown,
  });

  /*
   * Explosiveness: the part of a role that only matters when chasing points.
   *
   * Small in Balanced, smaller in Floor, and worth half again in Ceiling — a
   * downfield receiver's week has a wider distribution than a checkdown back's,
   * and which end of that distribution you want is precisely what the mode
   * control is asking.
   */
  const explosiveness = explosivenessOf(roleProfile);
  push({
    key: 'explosiveness',
    label: 'Explosive role',
    display: explosiveness.display,
    value: explosiveness.points,
    unknown: roleProfile.bucket === 'unclassified',
  });

  const movement = compareMarkets(
    (input.previousProps ?? []).map((p) => ({ market: p.market, line: p.line })),
    input.props.map((p) => ({ market: p.market, line: p.line })),
  );

  if (input.signal?.pendingCount) {
    confidenceReasons.push(`${input.signal.pendingCount} unreviewed news item(s)`);
  }
  if (input.signal?.mixedCount) {
    confidenceReasons.push(`${input.signal.mixedCount} mixed news item(s)`);
  }

  /*
   * The one place components are allowed to interact.
   *
   * Everything above is computed independently, which is what makes each piece
   * testable — and independence is exactly wrong for two pairs of them:
   *
   *   - **opportunity and role trend** are the level and the slope of the same
   *     series. A receiver whose targets doubled last month has a high level
   *     *because* the role rose, and paying full price for both is paying twice
   *     for one month of football.
   *   - **game script and the market's own number** both price the game
   *     environment. The prop line already contains the total; the script
   *     component is only allowed to add the part that is specific to his role.
   *
   * Handled by capping each pair rather than by rebalancing the weights,
   * because a cap leaves the individual components readable in the breakdown.
   */
  capPair(components, ['usage_level', 'role_trend'], USAGE_PAIR_CAP);
  if (expectation.points != null) capPair(components, ['game_script'], GAME_SCRIPT_WITH_MARKET_CAP);

  const known = components.filter((c) => !c.unknown);
  const score = expectation.points == null && recentItems === 0 && rawItems === 0 && statusPenalty === 0 && usage.unknown
    ? null
    : round2(known.reduce((a, c) => a + c.value, 0));

  let confidence: 'high' | 'medium' | 'low' = 'high';
  if (expectation.points == null) confidence = 'low';
  else if (expectation.coverage < 0.7 || input.propsStale) confidence = 'medium';
  if ((input.signal?.pendingCount ?? 0) > 0 && confidence === 'high') confidence = 'medium';
  /*
   * Confidence is about how much is *known*, not about how good the player is.
   *
   * A role the data cannot classify means the matchup read is generic and the
   * weather read is a position average; that is a weaker answer and saying so
   * is the whole job of this field.
   */
  if (roleProfile.bucket === 'unclassified' && !usage.unknown) {
    confidenceReasons.push('role could not be classified from the usage available');
    if (confidence === 'high') confidence = 'medium';
  }
  if (usage.unknown) confidenceReasons.push('no per-game usage for this player');
  if (matchup.unknown && input.defenseTendencies) confidenceReasons.push('no opponent tendency for his role yet');

  const drivers = topDrivers(components, {
    usage,
    role,
    td,
    gameScript,
    weather,
    matchup,
    availability: availabilityView,
  });
  const conflicts = findConflicts(components);

  return {
    playerId: input.player.id,
    name: input.player.fullName,
    position: input.player.position,
    team: input.player.team,
    expectation,
    components,
    score,
    confidence,
    confidenceReasons,
    statusFlag: availability === AVAILABLE ? null : availability.display,
    injury,
    ruledOut: availability.gate,
    lock: lockState(input.kickoff, input.now ?? new Date()),
    opponent: input.opponent ?? null,
    movement,
    role,
    mode,
    usage,
    roleProfile,
    tdDependency: td,
    gameScript,
    weather,
    matchup,
    availability: availabilityView,
    drivers,
    conflicts,
  };
}

/**
 * How much a pair of components may contribute between them.
 *
 * Applied to the mode-weighted values and scaled proportionally, so the cap
 * cannot change which of the two was doing the talking — it only decides how
 * loudly the pair is allowed to talk. Mutates, because it runs on components
 * that have just been built and nothing else has seen them.
 */
function capPair(components: StartSitComponent[], keys: string[], cap: number): void {
  const group = components.filter((c) => keys.includes(c.key) && !c.unknown);
  const total = group.reduce((a, c) => a + c.value, 0);
  if (Math.abs(total) <= cap || total === 0) return;
  const scale = cap / Math.abs(total);
  for (const component of group) component.value = round2(component.value * scale);
}

/** Opportunity and its trend, together, may be worth this much. */
export const USAGE_PAIR_CAP = 2.5;
/**
 * What game script may add once the market's own number is already in the
 * score. The prop line contains the game total; only the role-specific part of
 * the script is new information.
 */
export const GAME_SCRIPT_WITH_MARKET_CAP = 0.7;

/** A downfield or dual-threat role, as points. Small, and mode-sensitive. */
function explosivenessOf(profile: RoleProfile): { points: number; display: string } {
  switch (profile.bucket) {
    case 'deep_receiver':
      return { points: 0.5, display: `${profile.detail ?? 'downfield role'}` };
    case 'rushing_quarterback':
      return { points: 0.45, display: profile.detail ?? 'runs as well as throws' };
    case 'receiving_back':
      return { points: 0.3, display: profile.detail ?? 'catches passes out of the backfield' };
    case 'intermediate_receiver':
      return { points: 0.15, display: profile.detail ?? 'intermediate role' };
    case 'underneath_receiver':
      return { points: -0.15, display: profile.detail ?? 'underneath role' };
    case 'rushing_back':
      return { points: -0.1, display: profile.detail ?? 'ground role' };
    default:
      return { points: 0, display: 'role not classified' };
  }
}

/**
 * The two to four sentences worth showing, chosen by what actually moved.
 *
 * Every driver is paired with the component it came from, and the ordering is
 * by the size of that component's contribution — so the card cannot lead with a
 * signal that changed nothing, and it cannot describe a signal the score did
 * not use. Availability is the one exception and jumps the queue when it is
 * risky, because "he might not play" outranks any amount of projection.
 */
function topDrivers(
  components: StartSitComponent[],
  sources: {
    usage: UsageAssessment;
    role: RoleAssessment;
    td: TdDependencyAssessment;
    gameScript: GameScriptAssessment;
    weather: WeatherAssessment;
    matchup: MatchupAssessment;
    availability: AvailabilityView;
  },
): string[] {
  const byKey = new Map(components.map((c) => [c.key, c]));
  const size = (key: string) => Math.abs(byKey.get(key)?.value ?? 0);
  const candidates: { text: string; weight: number }[] = [];

  const add = (key: string, text: string | null, boost = 0) => {
    if (!text) return;
    if (byKey.get(key)?.unknown) return;
    candidates.push({ text, weight: size(key) + boost });
  };

  add('usage_level', sources.usage.driver);
  add(
    'role_trend',
    sources.role.trend === 'insufficient_data' || sources.role.trend === 'stable' ? null : sources.role.label,
  );
  add('td_dependency', sources.td.driver);
  add('game_script', sources.gameScript.driver);
  add('weather', sources.weather.driver);
  add('matchup_role', sources.matchup.driver);
  // Availability first when it is a live question, whatever the points say.
  if (sources.availability.risky && sources.availability.detail) {
    candidates.push({ text: sources.availability.detail, weight: 100 });
  }

  return candidates
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 4)
    .map((c) => c.text);
}

/**
 * Where the evidence points different ways.
 *
 * Shown rather than averaged, because the disagreement is the useful part: a
 * player with strong usage into a bad matchup and a soft market is a genuinely
 * hard call, and a screen that quietly nets those to "medium" has thrown away
 * the only thing worth telling somebody.
 */
function findConflicts(components: StartSitComponent[]): string[] {
  const value = (key: string) => {
    const component = components.find((c) => c.key === key);
    return component && !component.unknown ? component.value : null;
  };
  const conflicts: string[] = [];

  const usage = value('usage_level');
  const matchup = value('matchup_role');
  const script = value('game_script');
  if (usage != null && usage >= 0.8 && ((matchup ?? 0) <= -0.4 || (script ?? 0) <= -0.4)) {
    conflicts.push('Usage strong · matchup and environment disagree');
  }
  if (usage != null && usage <= -0.8 && ((matchup ?? 0) >= 0.4 || (script ?? 0) >= 0.4)) {
    conflicts.push('Favourable spot · the opportunity is not there');
  }

  const role = value('role_trend');
  if (usage != null && role != null && Math.sign(usage) !== 0 && Math.sign(role) !== 0 && Math.sign(usage) !== Math.sign(role)) {
    conflicts.push('Volume and trend point different ways');
  }

  const weather = value('weather');
  if (weather != null && weather <= -0.5 && (value('vegas') ?? 0) > 0) {
    conflicts.push('Market expects volume · the forecast works against his role');
  }

  return conflicts;
}

/**
 * The state to score against.
 *
 * A caller with the injury layer passes one. A caller with only Sleeper's word
 * gets that word normalized through the same model, so `evaluatePlayer` has
 * exactly one notion of what "Questionable" means whichever door it came in.
 */
function resolveInjuryState(input: StartSitInput): InjuryState {
  if (input.injury) return input.injury;
  const reading = normalizeDesignation(input.injuryStatus);
  if (reading.designation === 'unknown') return NO_INJURY_INFORMATION;
  const now = input.now == null ? new Date() : new Date(input.now);
  return resolveInjury(
    [{ source: 'sleeper', designation: reading.designation, raw: reading.raw, observedAt: null }],
    now,
  );
}

/**
 * Compare two or more candidates for the same lineup slot.
 * Returns no recommendation when the data cannot support one.
 */
export function compareStartSit(
  inputs: StartSitInput[],
  profile: ScoringProfile,
  opts: { minMargin?: number; mode?: StartSitMode } = {},
): StartSitComparison {
  const minMargin = opts.minMargin ?? 0.75;
  const mode = opts.mode ?? 'balanced';
  const evaluations = inputs.map((i) => evaluatePlayer({ ...i, mode: i.mode ?? mode }, profile));
  const warnings: string[] = [];
  const reasons: string[] = [];

  /*
   * What the market would choose, computed from the same evaluations.
   *
   * The market's number is already the largest component of every score, so the
   * comparison is made with that component subtracted out — otherwise this
   * would be asking whether the market agrees with itself. It contributes no
   * points either way; see `market.ts`.
   */
  const market = compareWithMarket(
    evaluations.map((e) => ({
      playerId: e.playerId,
      name: e.name,
      modelScoreExMarket: e.score == null ? null : round2(e.score - (componentValue(e, 'vegas') ?? 0)),
      marketPoints: e.expectation.points,
    })),
  );

  const scored = evaluations.filter((e) => e.score != null);
  if (scored.length === 0) {
    return {
      evaluations,
      recommendedPlayerId: null,
      margin: null,
      confidence: 'low',
      reasons: [],
      warnings: ['no usable data for any candidate — recommendation withheld'],
      lateSwap: {
        verdict: 'unknown',
        label: 'Late-swap risk unknown',
        detail: 'There is no usable projection for any candidate, so kickoff timing changes nothing.',
        gapHours: null,
        advantage: null,
      },
      mode,
      market,
      comparability: COMPARABLE,
    };
  }

  const sorted = [...scored].sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.name.localeCompare(b.name));
  const best = sorted[0]!;
  const runnerUp = sorted[1];
  const margin = runnerUp ? round2((best.score ?? 0) - (runnerUp.score ?? 0)) : null;

  const missingVegas = evaluations.filter((e) => e.expectation.points == null);
  if (missingVegas.length > 0) {
    warnings.push(
      `no Vegas data for ${missingVegas.map((e) => e.name).join(', ')} — compared on news and availability only`,
    );
  }

  /*
   * Are the two scores measuring the same thing?
   *
   * They are points, and points look comparable, but each one is the sum of the
   * markets that player happened to be priced on — so a player the provider
   * covered thinly scores lower for reasons that have nothing to do with him.
   * A total market blackout was already warned about; a *partial* one was not,
   * and partial is the common case. See `comparability.ts`.
   */
  const comparability = runnerUp
    ? assessMarketComparability(
        { name: best.name, position: best.position, expectation: best.expectation },
        { name: runnerUp.name, position: runnerUp.position, expectation: runnerUp.expectation },
        margin,
      )
    : COMPARABLE;

  let confidence: 'high' | 'medium' | 'low' = best.confidence;
  if (!comparability.comparable && comparability.detail) {
    warnings.push(comparability.detail);
    confidence = 'low';
  } else if (comparability.detail) {
    reasons.push(comparability.detail);
  }
  if (margin != null && margin < minMargin) {
    confidence = confidence === 'high' ? 'medium' : 'low';
    reasons.push(`close call: only ${margin} pts separates the top two`);
  }
  if (missingVegas.length > 0 && confidence === 'high') confidence = 'medium';

  if (best.expectation.points != null) {
    reasons.push(`${best.name} carries the higher market expectation (${best.expectation.points.toFixed(1)} pts)`);
  }
  const newsComp = best.components.find((c) => c.key === 'news_recent');
  if (newsComp && !newsComp.unknown && newsComp.value > 0) {
    reasons.push(`positive recent news: ${newsComp.display}`);
  }
  if (runnerUp) {
    const rivalNews = runnerUp.components.find((c) => c.key === 'news_recent');
    if (rivalNews && !rivalNews.unknown && rivalNews.value < 0) {
      reasons.push(`${runnerUp.name} has a negative recent signal (${rivalNews.display})`);
    }
    if (runnerUp.statusFlag) reasons.push(`${runnerUp.name} is listed ${runnerUp.statusFlag}`);
  }
  if (best.statusFlag) warnings.push(`${best.name} is listed ${best.statusFlag}`);

  /*
   * Late-swap safety.
   *
   * The projection compares the week as if it were one moment, and it is not:
   * if the better player kicks off at night and the alternative locks at one,
   * the choice disappears before the news does. Measured against the best
   * candidate that locks earlier, which is the one whose slot would actually be
   * spent by waiting.
   */
  const earlierAlternative =
    sorted
      .slice(1)
      .filter((e) => e.lock.kickoff && best.lock.kickoff && Date.parse(e.lock.kickoff) < Date.parse(best.lock.kickoff))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0] ?? null;

  const lateSwap = assessLateSwap(
    {
      preferred: { name: best.name, kickoff: best.lock.kickoff, status: best.statusFlag, score: best.score },
      alternative: earlierAlternative
        ? {
            name: earlierAlternative.name,
            kickoff: earlierAlternative.lock.kickoff,
            status: earlierAlternative.statusFlag,
            score: earlierAlternative.score,
          }
        : null,
    },
    inputs[0]?.now ?? new Date(),
  );

  if (lateSwap.verdict === 'consider_early_option') {
    // Named as a warning rather than silently reordering the board: the
    // projection still prefers the later player, and hiding that would be
    // making the user's risk decision for them.
    warnings.push(lateSwap.detail);
    confidence = confidence === 'high' ? 'medium' : confidence;
  } else if (lateSwap.verdict === 'worth_waiting') {
    reasons.push(lateSwap.detail);
  }

  // A player whose game has started is not a decision any more.
  const locked = evaluations.filter((e) => e.lock.locked);
  if (locked.length > 0) {
    warnings.push(
      `${locked.map((e) => e.name).join(', ')} ${locked.length === 1 ? 'has' : 'have'} already kicked off — that lineup spot is fixed.`,
    );
  }

  const rising = best.role.trend === 'rising_high' || best.role.trend === 'rising_moderate';
  if (rising && margin != null && margin < minMargin) {
    reasons.push(`${best.name}'s role is trending up: ${lowerFirst(best.role.detail)}`);
  }

  const movingUp = best.movement.headline;
  if (movingUp) reasons.push(`${best.name}: ${lowerFirst(movingUp)} (${best.movement.significant.map((m) => m.display).join('; ')})`);

  /*
   * The market, said rather than obeyed.
   *
   * A disagreement never changes the recommendation — the model has usage,
   * practice participation and role information the line cannot carry, and
   * flipping to the market on sight would throw all of it away. What a wide
   * disagreement does do is lower confidence, which is the honest response to
   * two independent sources pointing different ways.
   */
  if (market.verdict === 'disagrees') {
    reasons.push(market.detail);
    if (market.material && confidence === 'high') confidence = 'medium';
  } else if (market.verdict === 'agrees') {
    reasons.push(market.detail);
  }

  for (const conflict of best.conflicts) warnings.push(`${best.name}: ${conflict}`);

  return {
    evaluations: sorted.concat(evaluations.filter((e) => e.score == null)),
    recommendedPlayerId: best.playerId,
    margin,
    confidence,
    reasons,
    warnings,
    lateSwap,
    mode,
    market,
    comparability,
  };
}

/** One component's contributed value, or null when it was not known. */
function componentValue(evaluation: StartSitEvaluation, key: string): number | null {
  const component = evaluation.components.find((c) => c.key === key);
  return component && !component.unknown ? component.value : null;
}

function lowerFirst(sentence: string): string {
  return sentence.charAt(0).toLowerCase() + sentence.slice(1);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
