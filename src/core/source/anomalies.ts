/**
 * Contradictions between sources, detected rather than resolved.
 *
 * Every other module in this codebase is careful about one source at a time.
 * Nothing was watching the seams — and the seams are where silent corruption
 * lives, because each source is internally consistent and the disagreement only
 * exists in the join. Sleeper says a receiver is healthy while nflverse has him
 * on IR; a book is still hanging a receiving line on a player who was ruled out
 * on Friday; a player is credited with sixteen games and eleven weeks of DNPs;
 * an ADP snapshot moves a first-rounder ninety picks overnight. Each of those is
 * a fact about the *data*, and each one silently becomes a fact about a player
 * the moment a model reads it.
 *
 * ## What this is not
 *
 * It is not a resolver. It never decides which source is right, never edits a
 * value, and never gates a recommendation — the authority rules for that live
 * with the models that own each signal, and a detector that also corrected
 * things would be a second, invisible one.
 *
 * It is not a user-facing alert stream either. §17 is explicit that this must
 * not spam the UI. It returns findings; the caller decides which are material
 * enough to surface, and the natural home is diagnostics and the future What
 * Changed system rather than a badge on a card.
 *
 * ## Severity
 *
 * `contradiction` — two sources make incompatible claims about the same fact.
 * Somebody is wrong and the app cannot tell who.
 *
 * `implausible` — one source makes a claim that is internally impossible, or a
 * movement so large that a data error is likelier than the event it describes.
 *
 * `coverage` — a source went quiet. Not wrong, but a model reading it is now
 * answering from much less than it was yesterday, and a coverage collapse is
 * indistinguishable from a league of newly-anonymous players unless somebody
 * counts.
 *
 * Pure and deterministic: same inputs, same findings, in the same order.
 */

import { isRuledOut, type Designation } from '../injury/model.ts';

export type AnomalySeverity = 'contradiction' | 'implausible' | 'coverage';

export type AnomalyKind =
  | 'injury_source_conflict'
  | 'prop_for_ruled_out_player'
  | 'games_played_conflict'
  | 'adp_jump'
  | 'coverage_collapse'
  | 'wrong_season'
  | 'wrong_week'
  | 'malformed_schema'
  | 'duplicate_canonical_mapping';

export interface Anomaly {
  kind: AnomalyKind;
  severity: AnomalySeverity;
  /** The canonical player this concerns, when it concerns one. */
  playerId: string | null;
  /** One sentence, complete enough to act on without opening the data. */
  detail: string;
  /** The sources that disagree, or the single source that is implausible. */
  sources: string[];
}

/** The thresholds, in one place, so a tuning argument is a one-line diff. */
export const ANOMALY_THRESHOLDS = {
  /**
   * ADP movement, in picks, past which a snapshot is likelier wrong than the
   * market is surprising.
   *
   * Real ADP does move hard — a starting job won in August is worth thirty or
   * forty picks in a week. Ninety is not a market moving, it is a different
   * player, a mis-parsed row, or a snapshot from a different format.
   */
  adpJumpPicks: 90,
  /**
   * The share of the previous snapshot's players a new one must still carry.
   *
   * A partial fetch that silently truncates is the failure this catches: the
   * file parses, every row in it is correct, and two thirds of the board has
   * quietly ceased to exist.
   */
  minCoverageRatio: 0.7,
  /** Below this many rows, a coverage ratio is noise rather than a signal. */
  minCoverageSample: 25,
  /** Nobody plays more games than the regular season has. */
  maxRegularSeasonGames: 17,
} as const;

// ------------------------------------------------------------------ injuries

export interface InjuryClaim {
  source: string;
  designation: Designation;
  /** When the source observed it. Null when the source does not say. */
  observedAt?: string | null;
}

/**
 * Two sources, two different answers to "can he play".
 *
 * Only genuine incompatibility counts. `unknown` is not a claim and never
 * conflicts with anything — that distinction is the whole reason `healthy` and
 * `unknown` are separate designations in the injury model. And "questionable
 * versus doubtful" is two people describing the same fog; what this is looking
 * for is one source saying a player is available while another says he is not
 * playing at all.
 */
export function detectInjuryConflicts(playerId: string, claims: InjuryClaim[]): Anomaly[] {
  const stated = claims.filter((c) => c.designation !== 'unknown');
  const rulingOut = stated.filter((c) => isRuledOut(c.designation));
  const available = stated.filter((c) => c.designation === 'healthy' || c.designation === 'questionable');
  if (rulingOut.length === 0 || available.length === 0) return [];

  return [
    {
      kind: 'injury_source_conflict',
      severity: 'contradiction',
      playerId,
      detail:
        `${available.map((c) => `${c.source} says ${c.designation}`).join(', ')} while ` +
        `${rulingOut.map((c) => `${c.source} says ${c.designation}`).join(', ')}`,
      sources: [...new Set(stated.map((c) => c.source))].sort(),
    },
  ];
}

// --------------------------------------------------------------------- props

export interface PropClaim {
  playerId: string | null;
  market: string;
  line: number | null;
  source: string;
}

/**
 * A line still hanging on a player who is not playing.
 *
 * Usually a stale cache rather than a live book, which is exactly why it
 * matters: the Start/Sit expectation would read it as a market view of his week
 * and there is no market view — the game has been priced without him. Reported
 * per player rather than per market so a receiver with three stale lines is one
 * finding rather than three.
 */
export function detectPropsForRuledOutPlayers(
  props: PropClaim[],
  designationOf: (playerId: string) => Designation | undefined,
): Anomaly[] {
  const byPlayer = new Map<string, PropClaim[]>();
  for (const prop of props) {
    if (prop.playerId == null) continue;
    if (prop.line == null) continue;
    const list = byPlayer.get(prop.playerId);
    if (list) list.push(prop);
    else byPlayer.set(prop.playerId, [prop]);
  }

  const out: Anomaly[] = [];
  for (const [playerId, list] of [...byPlayer.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const designation = designationOf(playerId);
    if (designation == null || !isRuledOut(designation)) continue;
    out.push({
      kind: 'prop_for_ruled_out_player',
      severity: 'contradiction',
      playerId,
      detail: `${list.length} market(s) still priced (${[...new Set(list.map((p) => p.market))].sort().join(', ')}) for a player listed ${designation}`,
      sources: [...new Set(list.map((p) => p.source))].sort(),
    });
  }
  return out;
}

// ------------------------------------------------------------- games played

export interface UsageIntegrityInput {
  playerId: string;
  /** Games the usage source credits him with this season. */
  gamesPlayed: number;
  /** Weeks the injury history has him inactive or DNP this season. */
  weeksInactive: number;
  /** Weeks the season has actually run. */
  weeksElapsed: number;
  sources: string[];
}

/**
 * Arithmetic that cannot be true of one football season.
 *
 * Games played plus weeks missed cannot exceed the weeks that have happened,
 * and nobody plays more games than the calendar holds. Either figure alone is
 * plausible; together they are evidence that the two sources are describing
 * different players, different seasons, or a mis-joined identity.
 */
export function detectGamesPlayedConflicts(input: UsageIntegrityInput): Anomaly[] {
  const out: Anomaly[] = [];
  const { playerId, gamesPlayed, weeksInactive, weeksElapsed, sources } = input;

  if (gamesPlayed > ANOMALY_THRESHOLDS.maxRegularSeasonGames) {
    out.push({
      kind: 'games_played_conflict',
      severity: 'implausible',
      playerId,
      detail: `credited with ${gamesPlayed} games, more than the ${ANOMALY_THRESHOLDS.maxRegularSeasonGames}-game regular season`,
      sources: [...sources].sort(),
    });
  }
  if (weeksElapsed > 0 && gamesPlayed + weeksInactive > weeksElapsed) {
    out.push({
      kind: 'games_played_conflict',
      severity: 'contradiction',
      playerId,
      detail: `${gamesPlayed} games played and ${weeksInactive} week(s) inactive is ${gamesPlayed + weeksInactive} of a season that has run ${weeksElapsed} week(s)`,
      sources: [...sources].sort(),
    });
  }
  return out;
}

// ----------------------------------------------------------------------- ADP

export interface AdpSnapshotEntry {
  playerId: string;
  adp: number;
}

/**
 * Players whose draft position moved further than a market can move, and a
 * snapshot that lost most of the board.
 *
 * Both read the previous snapshot against the new one. Neither rejects the
 * import — an ADP file is the user's own data and this module does not get a
 * vote — but a board that silently re-ranks on a truncated or mismatched file is
 * the kind of failure that looks like the model changing its mind.
 */
export function detectAdpAnomalies(
  previous: AdpSnapshotEntry[],
  next: AdpSnapshotEntry[],
  source = 'adp',
): Anomaly[] {
  const out: Anomaly[] = [];
  const before = new Map(previous.map((e) => [e.playerId, e.adp]));

  for (const entry of [...next].sort((a, b) => a.playerId.localeCompare(b.playerId))) {
    const was = before.get(entry.playerId);
    if (was == null) continue;
    const moved = Math.abs(entry.adp - was);
    if (moved < ANOMALY_THRESHOLDS.adpJumpPicks) continue;
    out.push({
      kind: 'adp_jump',
      severity: 'implausible',
      playerId: entry.playerId,
      detail: `ADP moved ${Math.round(moved)} picks (${was} → ${entry.adp}) between snapshots`,
      sources: [source],
    });
  }

  if (previous.length >= ANOMALY_THRESHOLDS.minCoverageSample) {
    const ratio = next.length / previous.length;
    if (ratio < ANOMALY_THRESHOLDS.minCoverageRatio) {
      out.push({
        kind: 'coverage_collapse',
        severity: 'coverage',
        playerId: null,
        detail: `snapshot carries ${next.length} players against ${previous.length} before (${Math.round(ratio * 100)}%)`,
        sources: [source],
      });
    }
  }

  return out;
}

// ------------------------------------------------------------ season / week

export interface PeriodClaim {
  source: string;
  season: number | null;
  week: number | null;
}

/**
 * A source answering about a different week of a different year.
 *
 * The quietest failure in the whole app: last season's usage file parses
 * perfectly, joins perfectly, and describes a player who has since changed
 * teams. Checked against what the app believes the calendar is rather than
 * against a hardcoded year.
 */
export function detectPeriodMismatch(expected: { season: number; week: number | null }, claims: PeriodClaim[]): Anomaly[] {
  const out: Anomaly[] = [];
  for (const claim of claims) {
    if (claim.season != null && claim.season !== expected.season) {
      out.push({
        kind: 'wrong_season',
        severity: 'contradiction',
        playerId: null,
        detail: `${claim.source} is reporting season ${claim.season} while the app is on ${expected.season}`,
        sources: [claim.source],
      });
    }
    if (expected.week != null && claim.week != null && claim.week !== expected.week) {
      out.push({
        kind: 'wrong_week',
        severity: 'contradiction',
        playerId: null,
        detail: `${claim.source} is reporting week ${claim.week} while the app is on week ${expected.week}`,
        sources: [claim.source],
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- schema

/**
 * A provider payload that no longer has the shape the parser expects.
 *
 * Deliberately a column check rather than a validator: a feed that renames a
 * column does not throw, it yields nulls, and nulls are then indistinguishable
 * from a quiet week. Missing columns are reported once for the payload rather
 * than once per row.
 */
export function detectSchemaDrift(source: string, columns: string[], required: string[]): Anomaly[] {
  const present = new Set(columns.map((c) => c.trim().toLowerCase()));
  const missing = required.filter((c) => !present.has(c.trim().toLowerCase()));
  if (missing.length === 0) return [];
  return [
    {
      kind: 'malformed_schema',
      severity: 'implausible',
      playerId: null,
      detail: `${source} is missing expected column(s): ${missing.sort().join(', ')}`,
      sources: [source],
    },
  ];
}

// -------------------------------------------------------------- identity

export interface CanonicalMapping {
  /** The provider's own key or name. */
  externalKey: string;
  playerId: string;
  source: string;
}

/**
 * One external name resolved to two different canonical players.
 *
 * The identity ladder refuses to guess, so this cannot come from a single
 * resolution — it comes from two of them, made at different times against
 * different player tables, both stored. Whichever is read first wins, which is
 * a ranking that depends on row order.
 */
export function detectDuplicateMappings(mappings: CanonicalMapping[]): Anomaly[] {
  const byKey = new Map<string, Set<string>>();
  const sourcesByKey = new Map<string, Set<string>>();
  for (const mapping of mappings) {
    const key = mapping.externalKey.trim().toLowerCase();
    if (key === '') continue;
    const ids = byKey.get(key);
    if (ids) ids.add(mapping.playerId);
    else byKey.set(key, new Set([mapping.playerId]));
    const sources = sourcesByKey.get(key);
    if (sources) sources.add(mapping.source);
    else sourcesByKey.set(key, new Set([mapping.source]));
  }

  const out: Anomaly[] = [];
  for (const [key, ids] of [...byKey.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (ids.size < 2) continue;
    out.push({
      kind: 'duplicate_canonical_mapping',
      severity: 'contradiction',
      playerId: null,
      detail: `"${key}" is mapped to ${ids.size} different players (${[...ids].sort().join(', ')})`,
      sources: [...(sourcesByKey.get(key) ?? [])].sort(),
    });
  }
  return out;
}

// ---------------------------------------------------------------- summary

export interface AnomalyReport {
  anomalies: Anomaly[];
  bySeverity: Record<AnomalySeverity, number>;
  /**
   * Whether anything here is worth telling a person about.
   *
   * Contradictions and implausible values are; a coverage note on its own is a
   * diagnostic. §17 asks that the user's screen stay quiet unless something is
   * material, and this is where that judgement is made once rather than at
   * every call site.
   */
  material: boolean;
}

/** Collect findings into a report, ordered so the same inputs always read alike. */
export function summarizeAnomalies(anomalies: Anomaly[]): AnomalyReport {
  const sorted = [...anomalies].sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      (a.playerId ?? '').localeCompare(b.playerId ?? '') ||
      a.detail.localeCompare(b.detail),
  );
  const bySeverity: Record<AnomalySeverity, number> = { contradiction: 0, implausible: 0, coverage: 0 };
  for (const anomaly of sorted) bySeverity[anomaly.severity] += 1;
  return {
    anomalies: sorted,
    bySeverity,
    material: bySeverity.contradiction > 0 || bySeverity.implausible > 0,
  };
}
