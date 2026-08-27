/**
 * The state every in-season decision is made out of, captured once.
 *
 * Draft is one engine reading one interface, so its capture is a recording
 * proxy and its inputs are whatever the board asked for. The five in-season
 * surfaces are not shaped like that. Four of them — the lineup, the wire, the
 * defence planner and the trade search — are built on the *same* normalised
 * value, `StartSitInput[]`, assembled by `server/services/startSitInputs.ts` and
 * by Demo Mode's `startSitInputsFrom`, and every one of them then runs the
 * start/sit engine over it.
 *
 * So the seam for the in-season lanes is that value, and this module is the one
 * place it is written to a file and read back. Five adapters share it, which is
 * what stops a Waivers snapshot and a Team snapshot disagreeing about what an
 * injury state is.
 *
 * ## The two `Map`s, and why they are hoisted rather than trusted
 *
 * `StartSitInput.defenseTendencies` is a `DefenseTendencyIndex`, which is a
 * `Map`. `JSON.stringify` turns a `Map` into `{}` — silently, with no error —
 * so a snapshot that carried the inputs verbatim would replay every player
 * against an *empty* opponent table. Every matchup component would report "no
 * tendency", every score would move, and the file would look like a faithful
 * recording of a different decision. That is precisely the defect the Draft lane
 * found in `ManagerTendencies.byPosition`, one level up and attached to every
 * player rather than to a handful of managers.
 *
 * It is also *shared*: one table is built per request and handed to all forty
 * inputs. Writing it out per player would be forty copies of two hundred and
 * fifty entries. So the tables are hoisted into their own list and each input
 * names the index of the one it was given — by object identity, not by
 * assuming there is only ever one. A caller that hands two different tables to
 * two halves of a roster produces two tables in the file and replays exactly.
 *
 * `null` and an empty table are kept apart, because they are different inputs:
 * a source that never set the field cannot have a tendency, and one that set an
 * empty table looked and found nothing.
 *
 * ## Redaction
 *
 * Nothing in a `StartSitInput` names a person. It is players, betting lines,
 * injury reports, usage rows and a newsletter *tally* — the same numeric
 * aggregate the Draft lane already carries under `inputs.signals`, with the
 * excerpts left behind in the evidence ledger where they belong. The identities
 * in an in-season capture are all on the rosters, and they are aliased here with
 * the same allocator the Draft lane uses, so `manager-3` is one person across
 * every snapshot of the same league.
 */

import type { StartSitInput } from '../startsit/engine.ts';
import type { DefenseTendency, DefenseTendencyIndex } from '../startsit/defense.ts';
import type { LeagueRecord, RosterRecord } from '../sleeper/types.ts';
import { buildRosterShape, buildScoringProfile } from '../sleeper/scoring.ts';
import type { RosterShape, ScoringProfile } from '../sleeper/scoring.ts';
import type { SnapshotAliases } from './redaction.ts';
import { checkDerivation, derivationFingerprint, type DerivationCheck } from './derivation.ts';

// --------------------------------------------------------- start/sit inputs

/**
 * One assembled `StartSitInput`, minus the two fields that cannot travel as
 * they are.
 *
 * `defenseTendencies` is hoisted — see the module note. `now` is an injected
 * reference time that arrives as a `Date` from Demo Mode and is absent from the
 * live assembly; it is written as an ISO string, which the engine accepts
 * unchanged, so absent stays absent and a fixed clock stays fixed.
 */
export type SnapshotStartSitInput = Omit<StartSitInput, 'defenseTendencies' | 'now'> & {
  /** Index into `SnapshotStartSitBundle.defenseTables`, or null when unset. */
  defenseTable: number | null;
  /** ISO-8601, when the caller injected a reference time. */
  now?: string;
};

/** One opponent table, as entries, because a `Map` does not survive JSON. */
export interface SnapshotDefenseTable {
  entries: [string, DefenseTendency][];
}

export interface SnapshotStartSitBundle {
  inputs: SnapshotStartSitInput[];
  /**
   * The opponent tables, de-duplicated by identity.
   *
   * Normally exactly one, because both assemblies build it once per request and
   * hand the same object to every player. Recorded as a list anyway so the
   * capture describes what it was given rather than what it expects.
   */
  defenseTables: SnapshotDefenseTable[];
}

export function captureStartSitInputs(inputs: readonly StartSitInput[]): SnapshotStartSitBundle {
  const tables: DefenseTendencyIndex[] = [];
  const indexOf = (table: DefenseTendencyIndex | undefined): number | null => {
    if (table == null) return null;
    const existing = tables.indexOf(table);
    if (existing >= 0) return existing;
    tables.push(table);
    return tables.length - 1;
  };

  return {
    inputs: inputs.map((input) => {
      const { defenseTendencies, now, ...rest } = input;
      return {
        ...rest,
        defenseTable: indexOf(defenseTendencies),
        ...(now === undefined ? {} : { now: new Date(now).toISOString() }),
      };
    }),
    defenseTables: tables.map((table) => ({ entries: [...table.entries()] })),
  };
}

export function rehydrateStartSitInputs(bundle: SnapshotStartSitBundle): StartSitInput[] {
  const tables = (bundle.defenseTables ?? []).map((table) => new Map(table.entries) as DefenseTendencyIndex);
  return (bundle.inputs ?? []).map((input) => {
    const { defenseTable, ...rest } = input;
    const table = defenseTable == null ? undefined : tables[defenseTable];
    return {
      ...(rest as Omit<StartSitInput, 'defenseTendencies'>),
      ...(table === undefined ? {} : { defenseTendencies: table }),
    } as StartSitInput;
  });
}

// ------------------------------------------------------------ league shapes

/**
 * The league, with everything that names a person replaced.
 *
 * Same three rules the Draft lane established and for the same reasons, which
 * are written out at length in `redaction.ts`: the Sleeper league id is one
 * public URL away from every manager's username, so it is aliased; the name is
 * the commissioner's own words and frequently somebody's name in them, and
 * nothing in any engine reads it; and the scoring, the roster positions and the
 * settings blob are the inputs themselves and travel whole.
 */
export interface SnapshotLeague {
  id: string;
  sleeperLeagueId: string;
  name: string;
  season: string;
  totalRosters: number;
  scoringSettings: Record<string, number>;
  rosterPositions: string[];
  leagueSettings: Record<string, unknown>;
  draftId: string | null;
  status: string | null;
  localTeams: string[];
  lastSyncedAt: string;
}

export interface SnapshotRoster {
  leagueId: string;
  rosterId: number;
  /** Aliased — `manager-3`, never a Sleeper user id. */
  ownerId: string | null;
  /** Aliased — `Manager 3`, never a Sleeper username. */
  ownerName: string | null;
  playerIds: string[];
  starterIds: string[];
  reserveIds: string[];
  isMine: boolean;
  settings: Record<string, unknown> | null;
}

export function captureLeague(league: LeagueRecord, aliases: SnapshotAliases): SnapshotLeague {
  const leagueAlias = aliases.scope('league', league.id) ?? 'league-1';
  const draftAlias = league.draftId == null ? null : aliases.scope('draft', league.draftId);
  /*
   * The name, registered so the output scrub catches it too.
   *
   * It is replaced outright below, and several responses echo it back — so a
   * capture that aliased the id and copied the header would have published the
   * commissioner's own words, which are frequently somebody's name.
   */
  aliases.label(league.name, leagueAlias);
  return {
    id: leagueAlias,
    sleeperLeagueId: leagueAlias,
    name: leagueAlias,
    season: league.season,
    totalRosters: league.totalRosters,
    scoringSettings: league.scoringSettings,
    rosterPositions: league.rosterPositions,
    leagueSettings: league.leagueSettings,
    draftId: draftAlias,
    status: league.status ?? null,
    localTeams: league.localTeams ?? [],
    lastSyncedAt: league.lastSyncedAt,
  };
}

export function captureRosters(
  rosters: readonly RosterRecord[],
  aliases: SnapshotAliases,
  leagueAlias: string,
): SnapshotRoster[] {
  return rosters.map((roster) => ({
    leagueId: leagueAlias,
    rosterId: roster.rosterId,
    ownerId: aliases.id(roster.ownerId),
    ownerName: aliases.name(roster.ownerName, roster.ownerId),
    playerIds: roster.playerIds,
    starterIds: roster.starterIds,
    reserveIds: roster.reserveIds,
    isMine: roster.isMine,
    settings: roster.settings ?? null,
  }));
}

/** A captured roster, back in the shape the engines read. */
export function rehydrateRosters(rosters: readonly SnapshotRoster[]): RosterRecord[] {
  return rosters.map((roster) => ({ ...roster }));
}

/**
 * The league's own published rules, and the two values every engine reads them
 * through.
 *
 * The instinct here was to carry the derived `RosterShape` and `ScoringProfile`
 * whole — a value the engine actually used is evidence, and a value the replay
 * recomputed is an assumption, which is the argument that put
 * `nextPickModel.seed` in the Draft file.
 *
 * It does not survive contact with the wire. A league's points-allowed table
 * ends at `to: Infinity`, because the top band is "and above", and
 * `JSON.stringify(Infinity)` is `null`. A snapshot carrying the profile
 * therefore replayed every defence in the league a fraction of a point out —
 * silently, and by too little to notice. `lossless.ts` now refuses such a
 * capture outright.
 *
 * So the file carries what the *league published*, which is plain JSON and is
 * the true input in any case: `roster_positions` and `scoring_settings` exactly
 * as Sleeper returned them. The replay derives the same two values with the same
 * two functions the screen used. That is also what the Draft payload has always
 * done — `SnapshotLeague` carries the settings and `buildDraftBoard` derives the
 * rest — so the six lanes now agree.
 *
 * The exposure that leaves — a change to `buildScoringProfile` re-deriving an
 * old snapshot under new rules — is why `derivation` is here. It is a
 * fingerprint of the two functions' *behaviour* on this league's published
 * rules, so a replay can say "this build does not read leagues the way the build
 * that captured me did" rather than reporting the consequence as an engine
 * difference. See `derivation.ts`; it is compared by every lane's replay and it
 * is not a number anybody maintains by hand.
 */
export interface SnapshotLeagueRules {
  rosterPositions: string[];
  scoringSettings: Record<string, number>;
  /**
   * How the capturing build derived the shape and the profile from the two
   * fields above. Optional: a file captured before this existed carries no
   * claim, and an absent claim is not a disagreement.
   */
  derivation?: string;
}

export function captureLeagueRules(league: Pick<LeagueRecord, 'rosterPositions' | 'scoringSettings'>): SnapshotLeagueRules {
  const rules = { rosterPositions: league.rosterPositions, scoringSettings: league.scoringSettings };
  return { ...rules, derivation: derivationFingerprint(rules) };
}

export function rehydrateLeagueRules(rules: SnapshotLeagueRules): {
  shape: RosterShape;
  profile: ScoringProfile;
  derivation: DerivationCheck;
} {
  return {
    shape: buildRosterShape(rules.rosterPositions),
    profile: buildScoringProfile(rules.scoringSettings, rules.rosterPositions),
    /*
     * Derived beside the values it describes, so a lane cannot rehydrate the
     * rules and forget to ask the question.
     */
    derivation: checkDerivation(rules),
  };
}

/**
 * A manager profile, with the identity inside it replaced.
 *
 * Both the trade and the transaction profiles carry `userId` and `displayName`
 * of their own, beside the roster's — and the engines read *those* when they
 * compose a sentence about a manager. Re-keying the map alone left the real id
 * and the real username sitting one level down, which is a redaction that
 * removed the label and kept the thing.
 *
 * Applied before the assembly runs, so the engine writes the alias in the first
 * place. See `scrub.ts` for why the alternative — replacing it in the finished
 * prose — cannot be made safe for a display name.
 */
export function aliasManagerProfile<T extends { userId: string; displayName: string | null }>(
  profile: T,
  aliases: SnapshotAliases,
): T {
  return {
    ...profile,
    userId: aliases.id(profile.userId) ?? profile.userId,
    displayName: aliases.name(profile.displayName, profile.userId),
  };
}
