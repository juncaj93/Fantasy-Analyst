/**
 * One snapshot in, one verdict out, whatever surface it is about.
 *
 * The whole of what a caller needs to know about the six lanes: read the file,
 * hand it here, branch on the outcome word. The CLI does exactly that and knows
 * nothing else about what a draft board or a claim plan is, which is what keeps
 * `npm run support:fixture` one command rather than six.
 *
 * The dispatch is exhaustive by type rather than by a default branch. Adding a
 * seventh `DecisionKind` fails to compile here until it has an adapter, which is
 * the same guarantee the Draft lane got from `DraftBoardSources`: the compiler
 * points at the file that has not been taught about it.
 */

import { readSnapshot, type ReplayReport } from './contract.ts';
import { replayDraftSnapshot } from './replay.ts';
import { replayLineupSnapshot } from './lineupSnapshot.ts';
import { replayMatchupSnapshot } from './matchupSnapshot.ts';
import { replayWaiverSnapshot } from './waiverSnapshot.ts';
import { replayDstSnapshot } from './dstSnapshot.ts';
import { replayTradeSnapshot } from './tradeSnapshot.ts';
import type { SupportSnapshot } from './schema.ts';

export { readSnapshot };

/**
 * Replay a snapshot of any implemented kind.
 *
 * Never throws for a difference — a replay that disagrees is a *result*, and the
 * whole point is to hand back which of the six named outcomes it was.
 * `SnapshotRejected` is still thrown by `readSnapshot`, because a file that
 * cannot be read has no decision to compare.
 */
export async function replaySnapshot(snapshot: SupportSnapshot): Promise<ReplayReport> {
  const decision = snapshot.decision;
  switch (decision.kind) {
    case 'draft-board':
      return replayDraftSnapshot(snapshot);
    case 'lineup':
      return replayLineupSnapshot({ ...snapshot, decision });
    case 'matchup':
      return replayMatchupSnapshot({ ...snapshot, decision });
    case 'waiver-plan':
      return replayWaiverSnapshot({ ...snapshot, decision });
    case 'dst-plan':
      return replayDstSnapshot({ ...snapshot, decision });
    case 'trade-offer':
      return replayTradeSnapshot({ ...snapshot, decision });
    default:
      /*
       * Unreachable, and deliberately shaped so the compiler proves it.
       *
       * `readSnapshot` has already refused any kind this build does not
       * implement, so reaching here means a kind was added to the union and not
       * to this switch — which fails to compile on the assignment below rather
       * than at runtime in front of somebody with a broken week.
       */
      return exhausted(decision);
  }
}

function exhausted(decision: never): never {
  throw new Error(`no replay adapter for ${JSON.stringify((decision as { kind?: string }).kind ?? null)}`);
}
