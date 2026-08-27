/**
 * One support snapshot, for whichever decision the reader was looking at.
 *
 * The whole of what the deployment contributes to the in-season lanes: pick the
 * gatherer for the named context, hand what it read to that surface's capture
 * adapter, and return the file. Every capture rule — what is recorded, what is
 * aliased, what is refused — belongs to `core/support/` and none of it is
 * repeated here.
 *
 * ## Read-only, and it is checkable rather than promised
 *
 * Every read on these paths is a read the corresponding screen already makes,
 * through `services/decisionInputs.ts`, which is the same module the screens
 * use. Nothing here submits a lineup, refreshes Start/Sit, creates a claim,
 * spends FAAB, proposes a trade, alters a favourite, mutates manager
 * intelligence, writes support data to D1 or triggers a provider refresh.
 * `tests/support.isolation.test.ts` asserts it by watching every statement
 * prepared during a capture, rather than by describing it here.
 *
 * The one call that leaves the process is Sleeper's matchup scoreboard, and it
 * is the identical request the Matchup screen makes on every open — no write,
 * no ingestion, nothing stored. See `core/support/matchupSnapshot.ts`.
 */

import { LeagueRepo } from '../repos/league.ts';
import { PropsRepo } from '../repos/props.ts';
import { SETTING_KEYS, SettingsRepo } from '../repos/settings.ts';
import { MatchupService } from './matchupService.ts';
import { SmartTradeService } from './smartTradeService.ts';
import { gatherLineupInputs, gatherWaiverInputs, NoDecision } from './decisionInputs.ts';
import { captureLineupSnapshot } from '../../core/support/lineupSnapshot.ts';
import { captureMatchupSnapshot } from '../../core/support/matchupSnapshot.ts';
import { captureWaiverSnapshot } from '../../core/support/waiverSnapshot.ts';
import { captureDstSnapshot } from '../../core/support/dstSnapshot.ts';
import { captureTradeSnapshot } from '../../core/support/tradeSnapshot.ts';
import { SnapshotUnavailable } from '../../core/support/emit.ts';
import { normalizeMode } from '../../core/startsit/mode.ts';
import { waiverLineup } from '../../core/waivers/assemble.ts';
import { DEFENCE_POSITION } from '../../core/startsit/engine.ts';
/*
 * Re-exported so `app.ts` keeps the one import it has.
 *
 * The words themselves live in `core/support/contexts.ts`, because Demo Mode
 * serves the same endpoint and must accept exactly the same set.
 */
export { IN_SEASON_KINDS, isInSeasonKind, type InSeasonKind } from '../../core/support/contexts.ts';
import type { InSeasonKind } from '../../core/support/contexts.ts';
import type { DecisionPayload, SupportSnapshot } from '../../core/support/schema.ts';
import type { SleeperClient } from '../../core/sleeper/client.ts';
import type { Database } from '../db.ts';

export interface SupportCaptureOptions {
  db: Database;
  sleeper: SleeperClient;
  leagueId: string;
  context: InSeasonKind;
  /** The deployed revision, from the same plumbing `/api/health` reports. */
  gitSha: string;
  /** Floor / Balanced / Ceiling, when the reader was asking a Team question. */
  mode?: string | null;
  /** A named week, when the reader was looking at one. */
  week?: number | null;
  /** Injected so a test can pin the clock. */
  now?: () => Date;
}

export async function captureSupportSnapshot(
  options: SupportCaptureOptions,
): Promise<SupportSnapshot<DecisionPayload>> {
  const now = options.now?.() ?? new Date();
  const { db, sleeper, leagueId, gitSha } = options;

  switch (options.context) {
    case 'lineup': {
      const gathered = await gatherLineupInputs(db, sleeper, leagueId, normalizeMode(options.mode ?? null));
      return captureLineupSnapshot({
        gitSha,
        league: gathered.league,
        rosters: gathered.rosters,
        mine: gathered.mine,
        shape: gathered.shape,
        profile: gathered.profile,
        inputs: gathered.inputs,
        mode: gathered.mode,
        published: gathered.published,
        nflState: gathered.nflState,
        props: gathered.props,
        now,
      });
    }

    case 'matchup': {
      const league = await new LeagueRepo(db).getLeague(leagueId);
      if (!league) throw new NoDecision('league not found', 404);
      const service = new MatchupService(db, { sleeper, now: () => now });
      return captureMatchupSnapshot(service.supportSources(), {
        gitSha,
        leagueId: league.id,
        week: options.week ?? null,
        /*
         * The market's own age, read straight rather than through the lineup
         * gatherer: a matchup capture has no roster of its own to assemble, and
         * paying for one to fill a freshness field would be a diagnostic doing
         * work the decision did not.
         */
        props: await freshness(db),
      });
    }

    case 'waiver-plan': {
      const gathered = await gatherWaiverInputs(db, sleeper, leagueId);
      return captureWaiverSnapshot({
        gitSha,
        league: gathered.league,
        mine: gathered.mine,
        rosters: gathered.rosters,
        players: gathered.players,
        request: gathered.request,
        pool: gathered.pool,
        nflState: gathered.nflState,
        props: gathered.props,
        weeksRead: gathered.weeksRead,
        now,
      });
    }

    case 'dst-plan': {
      /*
       * The defence, from the waiver gathering it is part of.
       *
       * DST is not a screen of its own — it is one line on Team and one above
       * the Waivers board — and the plan is built inside the waiver assembly
       * from the roster and the wire. So the capture reads what the waiver
       * gathering reads, and hands the planner's own slice of it to the DST
       * adapter. Capturing it from a second gathering would be a defence plan
       * built against a differently-scanned wire.
       */
      const gathered = await gatherWaiverInputs(db, sleeper, leagueId);
      const { request } = gathered;
      if (request.dstSources == null) {
        throw new SnapshotUnavailable(
          `This league starts no ${DEFENCE_POSITION}, so there is no defence decision to capture.`,
        );
      }
      /*
       * The lineup the bench cost is measured against, from the waiver
       * assembly's own function rather than from a second call that looks like
       * it. Same inputs, same starters, same clock, and the same code.
       */
      const lineup = waiverLineup({ ...request, now });
      return captureDstSnapshot({
        gitSha,
        league: gathered.league,
        mine: gathered.mine,
        sources: request.dstSources,
        request: {
          season: request.season,
          week: request.week,
          shape: request.shape,
          profile: request.profile,
          bestBall: request.bestBall,
          draftComplete: request.draftComplete,
          rosterInputs: request.rosterInputs,
          candidateInputs: request.candidateInputs,
          lineup,
          reserveIds: request.reserveIds,
          playoff: request.playoff,
        },
        nflState: gathered.nflState,
        props: gathered.props,
        now,
      });
    }

    case 'trade-offer': {
      const gathered = await new SmartTradeService(db).gather({ leagueId });
      if (gathered.league == null) throw new NoDecision('league not found', 404);
      const nflState = await new SettingsRepo(db).get<{ week?: number } | null>(SETTING_KEYS.nflState, null);
      return captureTradeSnapshot({
        gitSha,
        league: gathered.league,
        rosters: gathered.rosterRecords ?? [],
        request: {
          profile: gathered.request.profile,
          shape: gathered.request.shape,
          inputs: gathered.request.inputs,
          history: gathered.request.history,
          limit: gathered.request.limit,
          warnings: gathered.request.warnings ?? [],
        },
        nflState: nflState as never,
        props: await freshness(db),
        week: nflState?.week ?? 0,
        now,
      });
    }
  }
}

function freshness(db: Database): Promise<{ fetchedAt: string | null; provider: string | null; events: number }> {
  return new PropsRepo(db).freshness();
}
