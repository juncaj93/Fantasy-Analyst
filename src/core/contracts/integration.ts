/**
 * Where this workstream's answers meet the screens that were waiting for them.
 *
 * Three contracts landed on `main` while this branch was being written, and all
 * three left named holes for exactly these numbers:
 *
 *   - `startsit/weekCard.ts` carries `advanced` and `whatWouldChange`, and says
 *     in its own header that they "arrive with the intelligence pass … read
 *     straight off the evaluation if they are there, and silent if they are
 *     not, so merging that work lights this card up without touching this file";
 *   - `waivers/board.ts` reports `multi-week value` as pending, and
 *     `docs/STATUS.md` records that it "has no supplier yet";
 *   - `roster/bench.ts` takes `fourWeekValue` and `streamingReplacement` as
 *     inputs it does not compute.
 *
 * So this file is the only place the two vocabularies touch, and it is a
 * translation rather than a computation. Every function here takes an
 * assessment that already exists and projects it onto a type **imported from
 * the module that owns it** — never onto a copy of that type declared here,
 * which is how two shapes that were the same in August disagree by October.
 *
 * Nothing in this file computes football, rounds a number a second time, or
 * decides anything. If a value is not already in an assessment, it does not
 * come out of here.
 */

import type { HeldPlayer } from '../roster/bench.ts';
import type { LineupRecommendation } from '../startsit/lineup.ts';
import type { ScoringProfile } from '../sleeper/scoring.ts';
import type { StartSitInput } from '../startsit/engine.ts';
import type { StartSitMode } from '../startsit/mode.ts';
import type { StreamingAssessment } from '../startsit/streaming.ts';
import type { WaiverLeagueIntel } from '../waivers/board.ts';
import type { WeeklyEvaluationLike } from '../startsit/weekCard.ts';
import type { XfpAssessment } from '../xfp/model.ts';
import { BOUNDARY, findBoundaries, type BoundaryReport } from '../startsit/boundary.ts';
import { assessRole } from '../startsit/decisions.ts';
import { assessUsage } from '../startsit/usageTrend.ts';
import { assessXfp } from '../xfp/model.ts';
import { toRoleMetrics } from '../usage/role.ts';
import { VALUE_LABEL, valueOverWeeks, type MultiWeekValue } from '../value/multiWeek.ts';

/** The card's own type, so a rename over there fails the build over here. */
export type AdvancedLine = NonNullable<WeeklyEvaluationLike['advanced']>[number];

/**
 * Expected points, as the weekly card's one advanced line.
 *
 * One line, not two. The card's whole design is that a line has to change what
 * the reader does, and "9.4 expected" followed by "+4.0 over expected" is one
 * fact printed twice — so the reading goes in the detail, where it belongs:
 * a number with `TD regression risk` under it is a sentence, and two numbers
 * are a stat dump.
 *
 * Returns an empty array when there is nothing to say, which the card renders
 * as nothing and reports once under `pending`.
 */
export function advancedLines(xfp: XfpAssessment | null | undefined): AdvancedLine[] {
  if (!xfp || xfp.xfpPerGame == null || xfp.interpretation === 'insufficient_data') return [];
  return [
    {
      key: 'xfp',
      label: 'Expected points',
      value: `${xfp.xfpPerGame.toFixed(1)} pts/gm`,
      detail: advancedDetail(xfp),
    },
  ];
}

function advancedDetail(xfp: XfpAssessment): string {
  const gap = xfp.fpoePerGame;
  if (gap == null) return 'from opportunity, before anybody caught anything';
  const size = `${Math.abs(gap).toFixed(1)} pts/gm ${gap >= 0 ? 'above' : 'below'} it`;
  switch (xfp.interpretation) {
    case 'td_regression_risk':
    case 'production_outrunning_opportunity':
    case 'role_healthy_despite_box_score':
    case 'usage_stronger_than_results':
      return `${xfp.label} · scoring ${size}`;
    default:
      return 'production tracks the opportunity';
  }
}

/**
 * The conditions that would change the recommendation, as the card wants them:
 * sentences, already written.
 *
 * The boundary report's `note` — "not a close call", "no single readable change
 * reaches the gap" — is deliberately dropped. The card prints `changes` as a
 * list of things that would flip the answer, and "nothing would" is not one of
 * them; an empty list already says it, and says it shorter.
 */
export function whatWouldChange(report: BoundaryReport | null | undefined): string[] {
  return (report?.conditions ?? []).map((condition) => condition.detail);
}

/**
 * What a waiver candidate is worth past this Sunday, in the board's own words.
 *
 * The board's four levels are a coarser instrument than the valuation behind
 * them, and that is the right way round: a row on a phone needs `Streamer` or
 * `Season-long`, and the arithmetic that got there belongs on the card behind
 * it. The mapping is stated once, here, rather than being re-derived by anybody
 * who renders it.
 *
 * `sell_high` maps to `multi_week` rather than to something worse, and the
 * warning goes in `detail`: a player whose touchdowns are about to stop is
 * still worth more than a streamer this month, and a level that said otherwise
 * would be arguing with the number beside it.
 *
 * Null when the valuation could not be made, which is what keeps the board
 * honestly reporting `multi-week value` as pending rather than showing a
 * confident `Unknown` chip.
 */
export function waiverMultiWeek(value: MultiWeekValue | null | undefined): WaiverLeagueIntel['multiWeek'] {
  if (!value || value.verdict === 'unknown' || value.nextFourPerWeek == null) return null;

  /*
   * A score carried forward is not a multi-week opinion.
   *
   * With no usage stored, every forward-looking component reports unknown and
   * `nextFourPerWeek` is just this Sunday's number repeated four times. Printing
   * `Multi-week` from that would be putting a horizon on a player nobody has a
   * horizon for — so the column stays empty and the board keeps saying,
   * correctly, that multi-week value is pending for him.
   */
  const known = value.components.filter((component) => !component.unknown);
  if (known.length === 0) return null;

  const level: NonNullable<WaiverLeagueIntel['multiWeek']>['level'] =
    value.verdict === 'rising_asset'
      ? 'season_long'
      : value.verdict === 'one_week_rental' || value.verdict === 'streamer'
        ? 'streamer'
        : 'multi_week';

  const perWeek = value.nextFourPerWeek.toFixed(1);
  const horizon = `${perWeek} pts a week over ${value.weeksAvailable} of the next ${value.horizon}`;
  const driver = value.components
    .filter((component) => !component.unknown && component.value !== 0)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))[0];

  return {
    level,
    label: VALUE_LABEL[value.verdict],
    detail: driver ? `${horizon} · ${driver.display}` : horizon,
  };
}

/**
 * The two numbers `roster/bench.ts` asks for and does not compute.
 *
 * `fourWeekValue` is the near-term half of a bench slot's case, and until this
 * pass existed the server filled it with this week's score — honest, and the
 * same number twice, which makes the blend in `valueOfSlot` a weighted average
 * of one thing. `streamingReplacement` is what the wire would give you at the
 * position instead, which the streaming read already measures as the median of
 * the top few rather than as one good matchup.
 *
 * Returned as a `Pick` of their type so a field renamed in `bench.ts` fails
 * here rather than silently going unfilled.
 */
export function benchHorizon(
  value: MultiWeekValue | null | undefined,
  streaming: StreamingAssessment | null | undefined,
): Pick<HeldPlayer, 'fourWeekValue' | 'streamingReplacement'> {
  return {
    fourWeekValue: value?.nextFourPerWeek ?? null,
    streamingReplacement: streaming?.replacementLevel ?? null,
  };
}

/** What one player's weekly card gains from this workstream. */
export interface WeeklyIntelligence {
  advanced: AdvancedLine[];
  whatWouldChange: string[];
}

/**
 * Both weekly slots, for a whole lineup, in one pass.
 *
 * ## Why the sensitivity pass is affordable here
 *
 * `findBoundaries` bisects the real engine, which is the property that makes a
 * printed threshold true and also the reason it cannot be run on every player
 * of every request. It does not have to be. A boundary only exists for a call
 * that is *close*, and closeness is already known from scores that have been
 * computed: the gap between a starter and the best bench player eligible for
 * his slot.
 *
 * So the gap is checked first, in arithmetic that costs nothing, and the
 * bisection runs only for the slots where it could produce something — usually
 * none, occasionally one. A roster of comfortable calls pays for this in
 * subtractions.
 *
 * Slot eligibility comes from the lineup's own `accepts`, so "who could take
 * this spot" is answered by the optimiser's rules rather than by a second
 * opinion about what a FLEX is.
 */
export function weeklyIntelligence(opts: {
  lineup: LineupRecommendation;
  /** The same inputs the lineup was built from. */
  inputs: StartSitInput[];
  profile: ScoringProfile;
  mode?: StartSitMode;
  now?: string | Date;
}): Map<string, WeeklyIntelligence> {
  const inputById = new Map(opts.inputs.map((input) => [input.player.id, input]));
  const out = new Map<string, WeeklyIntelligence>();

  const record = (playerId: string, intelligence: Partial<WeeklyIntelligence>) => {
    const current = out.get(playerId) ?? { advanced: [], whatWouldChange: [] };
    out.set(playerId, { ...current, ...intelligence });
  };

  /*
   * Expected points for everybody the lineup evaluated, starters and bench
   * alike: the card is reachable from either, and a number that appears only
   * for players who happen to be starting is a number the reader learns not to
   * look for.
   */
  const everyone = [...opts.lineup.starters, ...opts.lineup.bench, ...opts.lineup.undecidable];
  for (const evaluation of everyone) {
    const input = inputById.get(evaluation.playerId);
    const weeks = input?.usageWeeks ?? [];
    if (weeks.length === 0) continue;
    record(evaluation.playerId, { advanced: advancedLines(assessXfp(evaluation.position, weeks, opts.profile)) });
  }

  const benchByPosition = new Map<string, typeof opts.lineup.bench>();
  for (const player of opts.lineup.bench) {
    const position = player.position.toUpperCase();
    benchByPosition.set(position, [...(benchByPosition.get(position) ?? []), player]);
  }

  for (const slot of opts.lineup.slots) {
    if (!slot.playerId || slot.locked) continue;
    const starter = opts.lineup.starters.find((s) => s.playerId === slot.playerId);
    const starterInput = inputById.get(slot.playerId);
    if (!starter || !starterInput || starter.score == null) continue;

    const alternative = slot.accepts
      .flatMap((position) => benchByPosition.get(position.toUpperCase()) ?? [])
      .filter((player) => player.score != null && !player.lock.locked && !player.ruledOut)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
    if (!alternative) continue;

    // The cheap test that keeps the expensive one rare.
    if ((starter.score ?? 0) - (alternative.score ?? 0) > BOUNDARY.closeCall) continue;

    const alternativeInput = inputById.get(alternative.playerId);
    if (!alternativeInput) continue;

    const report = findBoundaries([starterInput, alternativeInput], opts.profile, {
      mode: opts.mode,
      now: opts.now,
    });
    const changes = whatWouldChange(report);
    if (changes.length > 0) record(slot.playerId, { whatWouldChange: changes });
  }

  return out;
}

/**
 * The multi-week read for the players who actually made the waiver board.
 *
 * Scoped to the board rather than to the pool on purpose: the pool is bounded
 * at a few dozen players and the board is a handful, and a valuation nobody is
 * going to read is CPU spent on a request somebody is waiting for.
 *
 * The schedule outlook is not passed in, because this app does not hold a
 * future schedule — the value falls back to role trend and the expected-points
 * gap, which are real inputs, and the component that could not be computed
 * reports itself unknown rather than contributing a zero.
 */
export function waiverMultiWeekFor(opts: {
  playerIds: Iterable<string>;
  /** The same candidate inputs the waiver scan was built from. */
  inputs: StartSitInput[];
  /** Each candidate's Start/Sit score, as the scan already computed it. */
  scores: Map<string, number | null>;
  profile: ScoringProfile;
  currentWeek: number;
}): Map<string, NonNullable<WaiverLeagueIntel['multiWeek']>> {
  const inputById = new Map(opts.inputs.map((input) => [input.player.id, input]));
  const out = new Map<string, NonNullable<WaiverLeagueIntel['multiWeek']>>();

  for (const playerId of opts.playerIds) {
    const input = inputById.get(playerId);
    if (!input) continue;
    const weeks = input.usageWeeks ?? [];
    const position = input.player.position;

    const value = valueOverWeeks({
      playerId,
      name: input.player.fullName,
      position,
      currentWeek: opts.currentWeek,
      thisWeekScore: opts.scores.get(playerId) ?? null,
      usage: weeks.length > 0 ? assessUsage(position, weeks) : null,
      role: weeks.length > 0 ? assessRole(toRoleMetrics(position, weeks)) : null,
      xfp: weeks.length > 0 ? assessXfp(position, weeks, opts.profile) : null,
    });

    const intel = waiverMultiWeek(value);
    if (intel) out.set(playerId, intel);
  }

  return out;
}
