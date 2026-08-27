/**
 * Capturing and replaying a Smart Trades decision.
 *
 * The seam is `assembleSmartTrades`, which takes every roster, one shared pool
 * of evaluated players, and what the ledger knows about each manager. All three
 * are values, so capturing them is capturing the whole of what an offer could
 * have been built from.
 *
 * ## Both `Map`s are hoisted, and both are keyed by an alias
 *
 * `tendencies` and `seasonsByUser` are keyed by Sleeper user id — the thing that
 * follows a *person* between seasons, where a roster id follows a *seat*. That
 * makes them the one place in this payload where an identity is also a key, and
 * a snapshot that aliased the rosters and left these keys real would have been a
 * redaction that removed nothing: the same ids, in the same file, one level down.
 *
 * So they are re-keyed to the aliases the rosters got. The engine only ever
 * compares these against `roster.ownerId`, so `manager-3` resolves exactly as
 * the real id did — and the whole chain from a seat to a manager's trade history
 * behaves identically without any of it being real.
 *
 * ## What is not captured, on purpose
 *
 * An acceptance probability. There is not one: the engine reports objective
 * value on both sides, roster fit, and what the manager's own history says about
 * how he trades — and nothing in it converts that into a chance that an offer is
 * taken. A snapshot field called `acceptance` would be a number an agent would
 * reason about and no code produced, which is a worse failure than not having it.
 * `managerFit`'s own reasons and its sample size travel instead, inside `output`.
 */

import { assembleSmartTrades, type TradeAssemblyRequest, type TradeHistoryContext } from '../trades/assemble.ts';
import { TRADE_ENGINE_VERSION } from '../trades/version.ts';
import type { ManagerTradeTendencies } from '../managers/tradeTendencies.ts';
import type { LeagueRecord, RosterRecord } from '../sleeper/types.ts';
import type { NflState } from '../sleeper/phase.ts';
import { SnapshotAliases, REDACTION_RULES } from './redaction.ts';
import { sealSnapshot } from './emit.ts';
import { scrubAliases } from './scrub.ts';
import {
  aliasManagerProfile,
  captureLeague,
  captureLeagueRules,
  captureRosters,
  captureStartSitInputs,
  rehydrateLeagueRules,
  rehydrateStartSitInputs,
} from './inseason.ts';
import { countPositions, summariseFreshness } from './freshness.ts';
import { classifyOutcome, compareStructural, describeDifference, exact, type ReplayReport } from './contract.ts';
import { SUPPORT_SNAPSHOT_SCHEMA, type SupportSnapshot } from './schema.ts';
import type { TradeOfferPayload } from './payloads.ts';

export interface TradeCaptureInput {
  gitSha: string;
  league: LeagueRecord;
  rosters: RosterRecord[];
  /** Everything `assembleSmartTrades` is about to be handed. */
  request: Omit<TradeAssemblyRequest, 'leagueSettings' | 'shape' | 'rosters'> & {
    shape: TradeAssemblyRequest['shape'];
  };
  nflState: NflState | null;
  props: { fetchedAt: string | null; provider: string | null; events: number };
  week: number;
  now: Date;
}

export function captureTradeSnapshot(input: TradeCaptureInput): SupportSnapshot<TradeOfferPayload> {
  const aliases = new SnapshotAliases();
  const league = captureLeague(input.league, aliases);
  const rosters = captureRosters(input.rosters, aliases, league.id);
  const capturedAt = input.now.toISOString();

  /*
   * The behavioural half, re-keyed onto the aliases the rosters just got.
   *
   * `aliases.id` is idempotent and allocates in first-seen order, so a manager
   * who already has an alias from `captureRosters` keeps it, and a manager the
   * ledger knows about but who is no longer on a roster gets his own. Both are
   * correct: the second is a real state — a profile for somebody who left — and
   * dropping him would replay a league with less history than it had.
   */
  const history = {
    measured: input.request.history.measured,
    tendencies: [...input.request.history.tendencies.entries()].map(
      ([userId, tendencies]) =>
        [aliases.id(userId) ?? userId, aliasManagerProfile(tendencies, aliases)] as [string, ManagerTradeTendencies],
    ),
    seasonsByUser: [...input.request.history.seasonsByUser.entries()].map(
      ([userId, seasons]) => [aliases.id(userId) ?? userId, seasons] as [string, { observed: number; complete: boolean }],
    ),
    seasonsComplete: input.request.history.seasonsComplete,
    profiles: input.request.history.profiles,
    complete: input.request.history.complete,
    leagueRate: input.request.history.leagueRate,
  };

  /*
   * The search runs over the aliased rosters, not over the real ones.
   *
   * `managerFit` puts a counterparty's display name on every offer and composes
   * it into the reasons and caveats — `You are sending Ike Sandoval` sits beside
   * `Manager 3 has been quiet since week 4` — so an assembly given real names
   * would have to be scrubbed afterwards. Scrubbing a *display name* out of
   * prose cannot be made safe: this app's own seeded league has a manager called
   * `You`, and no boundary rule separates the name from the pronoun. Aliasing
   * first means the engine writes `Manager 3` in the first place, and the
   * finished output needs no surgery at all.
   *
   * Nothing about the search changes. Owner ids are compared for equality and
   * never hashed, so `manager-3` resolves exactly as the real id did — and the
   * history above is keyed to match.
   */
  const decision = assembleSmartTrades({
    leagueSettings: input.league.leagueSettings,
    shape: input.request.shape,
    profile: input.request.profile,
    rosters: rosters.map((roster) => ({
      rosterId: roster.rosterId,
      ownerId: roster.ownerId,
      ownerName: roster.ownerName,
      playerIds: roster.playerIds,
      isMine: roster.isMine,
    })),
    inputs: input.request.inputs,
    history: {
      ...input.request.history,
      tendencies: new Map(history.tendencies),
      seasonsByUser: new Map(history.seasonsByUser),
    },
    limit: input.request.limit,
  });

  /*
   * And the identifiers, which cannot be aliased ahead of the assembly.
   *
   * Identifiers only — never a display name. See `scrub.ts`.
   */
  const output = scrubAliases(decision, aliases) as typeof decision;

  return sealSnapshot<TradeOfferPayload>({
    schema: SUPPORT_SNAPSHOT_SCHEMA,
    capturedAt,
    release: { gitSha: input.gitSha, surface: 'trade-offer', engineVersion: TRADE_ENGINE_VERSION },
    redaction: {
      replaced: {
        'manager id': aliases.counts.ids,
        'manager name': aliases.counts.names,
        'league or draft id': aliases.counts.scopes,
        'league name': aliases.counts.labels,
      },
      rules: [...REDACTION_RULES],
    },
    decision: {
      kind: 'trade-offer',
      request: { leagueId: league.id, limit: input.request.limit ?? null },
      context: {
        league,
        season: input.league.season,
        week: input.week,
        scoringLabel: input.request.profile.label,
        rosterShape: input.request.shape,
        myRosterId: input.rosters.find((roster) => roster.isMine)?.rosterId ?? null,
        rosterCounts: countPositions(input.request.inputs),
        tradeable: output.capability.tradeable,
        partners: output.search.partners,
      },
      freshness: {
        ...summariseFreshness({
          inputs: [input.request.inputs],
          props: input.props,
          nflState: input.nflState,
          unknownPlayers: 0,
        }),
        history: {
          measured: output.history.measured,
          profiles: output.history.profiles,
          seasonsComplete: output.history.seasonsComplete,
          complete: output.history.complete,
        },
      },
      inputs: {
        now: capturedAt,
        leagueSettings: input.league.leagueSettings,
        rules: captureLeagueRules(input.league),
        rosters,
        pool: captureStartSitInputs(input.request.inputs),
        limit: input.request.limit ?? null,
        history,
      },
      output,
      warnings: output.warnings,
    },
  });
}

export function replayTradeSnapshot(snapshot: SupportSnapshot<TradeOfferPayload>): ReplayReport {
  const { inputs, output } = snapshot.decision;

  const history: TradeHistoryContext = {
    measured: inputs.history.measured,
    tendencies: new Map(inputs.history.tendencies),
    seasonsByUser: new Map(inputs.history.seasonsByUser),
    seasonsComplete: inputs.history.seasonsComplete,
    profiles: inputs.history.profiles,
    complete: inputs.history.complete,
    leagueRate: inputs.history.leagueRate,
  };

  const { shape, profile } = rehydrateLeagueRules(inputs.rules);
  const replayed = assembleSmartTrades({
    leagueSettings: inputs.leagueSettings,
    shape,
    profile,
    rosters: inputs.rosters.map((roster) => ({
      rosterId: roster.rosterId,
      ownerId: roster.ownerId,
      ownerName: roster.ownerName,
      playerIds: roster.playerIds,
      isMine: roster.isMine,
    })),
    inputs: rehydrateStartSitInputs(inputs.pool),
    history,
    limit: inputs.limit ?? undefined,
  });

  const differences: ReplayReport['differences'] = [];
  compareStructural('output', output, replayed, differences);

  /*
   * The offers, named as offers.
   *
   * GIVE, GET and who it is for, in surfaced order. The structural walk compares
   * every value component underneath; this is the same claim in the unit the
   * reader is complaining in — *you told me to send him this for that*.
   */
  exact('offers', 'GIVE / GET / counterparty', offerLines(output), offerLines(replayed), differences);

  const engineMatches = snapshot.release.engineVersion === TRADE_ENGINE_VERSION;
  const outcome = classifyOutcome(differences, engineMatches);

  return {
    outcome,
    summary: summarise(outcome, differences, snapshot),
    kind: 'trade-offer',
    schema: { expected: SUPPORT_SNAPSHOT_SCHEMA, found: snapshot.schema, supported: true },
    engine: { captured: snapshot.release.engineVersion, current: TRADE_ENGINE_VERSION, matches: engineMatches },
    release: { capturedSha: snapshot.release.gitSha },
    compared: [
      { what: 'surfaced offers', count: output.offers.length },
      { what: 'partners searched', count: output.search.partners },
      { what: 'candidates scored', count: output.search.scored },
    ],
    differences,
    distillation: [],
  };
}

/** `GIVE a,b → GET c,d · partner`, in surfaced order. */
function offerLines(assembly: {
  offers: { give: { playerId: string }[]; get: { playerId: string }[]; partner: { key: string } }[];
}): string {
  return assembly.offers
    .map(
      (offer) =>
        `${offer.give.map((p) => p.playerId).join(',')}→${offer.get.map((p) => p.playerId).join(',')}@${offer.partner.key}`,
    )
    .join(' | ');
}

function summarise(
  outcome: ReplayReport['outcome'],
  differences: ReplayReport['differences'],
  snapshot: SupportSnapshot<TradeOfferPayload>,
): string {
  const { output, context } = snapshot.decision;
  switch (outcome) {
    case 'reproduced':
      return output.offers.length === 0
        ? `Reproduced: no offer worth sending, from the same ${context.partners} partner${context.partners === 1 ? '' : 's'} — ${output.notes[0] ?? 'nothing cleared the bar'}.`
        : `Reproduced: the same ${output.offers.length} offer${output.offers.length === 1 ? '' : 's'}, the same GIVE and GET on each, from the same ${context.partners} partners.`;
    case 'engine_version_mismatch':
      return `The trade engine has moved since capture (${snapshot.release.engineVersion} → ${TRADE_ENGINE_VERSION}) and the offers came out differently in ${differences.length} place${differences.length === 1 ? '' : 's'}. Expected; compare against a snapshot captured on this engine before treating it as a regression.`;
    case 'freshness_difference':
      return `Every offer term matched; only the age of the data behind it read differently (${differences.length} field${differences.length === 1 ? '' : 's'}). Check that the replay clock was pinned to ${snapshot.capturedAt}.`;
    default:
      return `The offers reproduced differently in ${differences.length} place${differences.length === 1 ? '' : 's'}, on the same engine version. The first is: ${describeDifference(differences[0]!)}.`;
  }
}
