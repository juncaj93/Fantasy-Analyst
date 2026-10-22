/**
 * A waiver decision as one row, and everything else on tap.
 *
 * The same component draws the Team screen's short list and the Waivers page's
 * full board, which is the point: they are the same decision seen at two
 * distances, and two components would be two answers to "how strongly is he
 * recommended" waiting to disagree.
 *
 * The row is deliberately three lines at most on a 375px screen — who he is,
 * what he is worth and where he fits, and one short phrase saying why. The
 * verbose version this replaced spent five lines and a button per candidate,
 * printed the current player's score twice, and listed the runners-up as a
 * comma-separated sentence.
 *
 * Nothing here adds, drops, claims or bids. There is no control on this row
 * that does anything but open the detail.
 */

import type { FaabAdvice } from '../api.ts';
import type { WaiverBoardRow } from '../../core/waivers/board.ts';
import type { WaiverClaimGroup, WaiverClaimLine, WaiverClaimPlan } from '../../core/waivers/claimPlan.ts';
import type { NoMoveSummary } from '../../core/waivers/noMove.ts';
import { WaiverCard } from './waiverCard.tsx';
import { boardCard, clearDay, surname } from '../waiverCard.ts';


/**
 * The plan: what to enter, in the order to enter it.
 *
 * The first thing on the screen, and deliberately not a row — the board below it
 * ranks *players* and this ranks *claims*, which is a different object with a
 * different unit. Everything a reader has to do is on its face: who to add, what
 * to bid, who to drop, and the numbering, which is the instruction rather than
 * decoration since Sleeper runs claims in the order they were entered.
 *
 * ## Why the repeated lines are not a bug
 *
 * A plan routinely names one target twice and one drop twice, and read as a list
 * that is nonsense. The qualifier at the end of the line is the whole of what
 * turns it back into sense — `Only if 1 loses` — and it is here rather than
 * behind **See Why** because a reader who does not see it will delete the line.
 *
 * ## Not a control
 *
 * The card is a `div` and every claim is an `li`, and there is no button on it
 * at all: this app makes no transaction, and a claim line that looked tappable
 * would be offering to make one. The claims are typed into Sleeper by hand,
 * which is also why the order matters.
 *
 * ## Short on purpose
 *
 * On 1 October 2026 the owner's verdict on this card was "way too much text".
 * It closed with a `Keeping X: reason` line for every bench player the plan did
 * not cut, and a `See why` button onto a sheet of the full argument. Both are
 * gone. A bench player who was not cut needs no defence. The one exception is
 * a backup to your own starter, who looks like the obvious cut the plan
 * skipped; he gets a clause on the drop line (see `ClaimGroup`).
 */
export function WaiverPlanCard({ plan }: { plan: WaiverClaimPlan | null | undefined }) {
  if (!plan?.surface) return null;

  return (
    <div className="card claim-plan" data-testid="waiver-plan" data-state={plan.state}>
      {/*
        No title and no "Enter in this order" on a plan with claims: the
        section above already says "Recommended move", and the numbers are the
        order. Removed 1 October 2026 at the owner's request. An empty ending
        (`No safe drop for this upgrade`) has no claims, so its headline is the
        whole message and stays.
      */}
      {plan.claims.length === 0 ? (
        <div className="detail-label" data-testid="waiver-plan-headline">
          {plan.headline}
        </div>
      ) : null}

      {/*
        One block per drop: the drop, said once, then the claims that would
        spend it in the order to enter them, numbered across the whole plan
        because the numbers are the Sleeper order. An older cached payload
        with no groups draws the flat list it always drew.
      */}
      {plan.claims.length > 0 && (plan.groups ?? []).length > 0 ? (
        (plan.groups ?? []).map((group) => (
          <ClaimGroup
            key={group.index}
            group={group}
            claims={plan.claims.filter((c) => c.group === group.index)}
          />
        ))
      ) : plan.claims.length > 0 ? (
        <ol className="claim-plan-list" data-testid="waiver-plan-claims">
          {plan.claims.map((claim) => (
            <ClaimLine key={claim.claimId} claim={claim} />
          ))}
        </ol>
      ) : null}

      {plan.note ? (
        <div className="faint claim-plan-note" data-testid="waiver-plan-note">
          {plan.note}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The answer when there is no claim to make, said as an answer.
 *
 * Before October 2026 the Waivers page drew `Recommended move` over nothing at
 * all on a week like this. The card is the plan card's own shape (`card
 * claim-plan`, the headline label, the quiet note lines), so the empty answer
 * sits exactly where a plan would and reads as one: the decision, how much of
 * the wire was compared, and who came closest. The wording is
 * `core/waivers/noMove.ts`, shared with Team.
 */
export function NoMoveCard({ summary, headline }: { summary: NoMoveSummary; headline?: string }) {
  /* One short line (22 October 2026): the answer, without the sentence explaining it. */
  return (
    <div className="card claim-plan" data-testid="waivers-no-move">
      <div className="detail-label" data-testid="waivers-no-move-headline">
        {headline ?? summary.headline}
      </div>
    </div>
  );
}

/**
 * One instruction, on as few lines as it takes.
 *
 * The number is the list's own marker rather than a printed character, so the
 * indent is a real one and a screen reader announces an ordered list instead of
 * a paragraph beginning with a digit. The qualifier wraps under the instruction
 * on a narrow phone rather than shrinking it — a name clipped to fit a
 * contingency note is the wrong half kept.
 */
function ClaimLine({ claim }: { claim: WaiverClaimLine }) {
  return (
    <li className="claim-plan-claim" data-testid="waiver-plan-claim" data-rank={claim.rank} data-relation={claim.relation}>
      <span className="claim-plan-headline">{claim.headline}</span>
      {/*
        The case for him in one line: both projections on the one yardstick,
        then Sleeper's attention and anything worth a warning. Block-level so
        it sits under the instruction rather than running on from it.
      */}
      {claim.detail ? (
        <span className="claim-plan-detail" data-testid="waiver-plan-claim-detail">
          {claim.detail}
        </span>
      ) : null}
    </li>
  );
}

/**
 * One drop and the claims that would spend it.
 *
 * `Drop Jaylen Wright`, said once above the list
 * rather than on every line: the claims under it share the cut, and Sleeper
 * runs the first one that wins and skips the rest because the cut is gone.
 * When the plan passed over a backup to one of your starters, the drop line
 * says so in one clause, because that is the cut a reader expected.
 */
function ClaimGroup({ group, claims }: { group: WaiverClaimGroup; claims: WaiverClaimLine[] }) {
  return (
    <div className="claim-plan-group" data-testid="waiver-plan-group" data-drop={group.drop?.playerId ?? 'none'}>
      <div className="claim-plan-drop" data-testid="waiver-plan-drop">
        {group.headline}
        {/*
          Only when the last seven days of news changed who is dropped:
          `Jaylen Wright trending down this week`. Short, and absent when the
          drop would have been the same without it.
        */}
        {group.formNote ? (
          <span className="faint claim-plan-form" data-testid="waiver-plan-drop-form">
            {' \u00b7 '}
            {group.formNote}
          </span>
        ) : null}
      </div>
      <ol className="claim-plan-list" start={group.firstRank} data-testid="waiver-plan-claims">
        {claims.map((claim) => (
          <ClaimLine key={claim.claimId} claim={claim} />
        ))}
      </ol>
    </div>
  );
}

/**
 * Which tint each verdict wears.
 *
 * A map rather than the nested ternary this used to be, because there are five
 * levels now and the last two are not weaker recommendations but different
 * kinds of statement. `value` takes the calm tint: it is a real recommendation,
 * just not one about a hole in the lineup. `unknown` takes no tint at all — the
 * plain badge — because a colour here would be the page having an opinion about
 * a player it has openly said it cannot rate.
 */
const STRENGTH_TAG: Record<WaiverBoardRow['strength']['level'], string> = {
  strong: 'tag-take',
  solid: 'tag-calm',
  speculative: 'tag-risky',
  value: 'tag-calm',
  unknown: '',
};

/**
 * The one reason line a card may carry, or none.
 *
 * In order: the plan leaving him out (a top-ten Sleeper drop, "check the news
 * before claiming"); on a player who costs money, how many rivals need the
 * position (`5 of 9 teams need RB`); an empty starting slot he would fill, or
 * a defence row's call; then the engine's
 * own notes, which arrive most important first: a Vegas edge over your bench,
 * your own recent cut, a lower place on the drops list. An empty slot outranks
 * the notes because it is the reason he is on the board at all.
 */
export function cardReason(
  row: Pick<WaiverBoardRow, 'planExcluded' | 'fit' | 'notes' | 'dst' | 'strength' | 'why' | 'pickup' | 'faab' | 'competition'>,
): string | null {
  if (row.planExcluded) return row.planExcluded;
  /*
   * On a player who costs money, how many rivals need the position is what
   * justifies the price, so it comes first (owner's call, 1 October 2026).
   * Not on a free agent: nobody bids for an instant pickup.
   */
  const costs = row.pickup?.state !== 'free' && row.faab != null;
  if (costs && (row.competition?.needyTeams ?? 0) > 0 && row.competition?.needs) return row.competition.needs;
  /* A defence row's fit is the planner's call (`Streams over BUF`), the whole point of the row. */
  if (row.dst != null || row.fit.need === 'unfilled') return row.fit.label;
  const note = row.notes?.[0];
  if (note) return note;
  /* A player nothing can score is on the board only because Sleeper is adding him. */
  return row.strength.level === 'unknown' ? row.why : null;
}

/**
 * A board row as a card: a defence the planner named, a player this app cannot
 * score, or a league without tiers. The same `WaiverCard` the tiers draw; the
 * projection, the cost sentence and the full status are on the sheet.
 */
export function WaiverRow({ row, onOpen }: { row: WaiverBoardRow; onOpen: () => void }) {
  return (
    <WaiverCard
      model={boardCard(row, cardReason(row), STRENGTH_TAG[row.strength.level])}
      onOpen={onOpen}
      testId="waiver-row"
      gainTestId="waiver-strength"
      reasonTestId="waiver-notes"
      reasonWarn={row.planExcluded != null}
      data={{ 'data-strength': row.strength.level }}
    />
  );
}

export { clearDay };

/** `12–18%` / `$4–7` / `unknown`. Never a single number pretending to be a bid. */
export function formatFaab(faab: NonNullable<WaiverBoardRow['faab']>): string {
  const unit = faab.unit ?? 'percent';
  const suffix = unit === 'percent' ? '%' : '';
  const prefix = unit === 'dollar' ? '$' : '';
  if (faab.low == null && faab.high == null) return 'unknown';
  if (faab.low == null) return `up to ${prefix}${faab.high}${suffix}`;
  if (faab.high == null) return `${prefix}${faab.low}${suffix}+`;
  if (faab.low === faab.high) return `${prefix}${faab.low}${suffix}`;
  return `${prefix}${faab.low}–${faab.high}${suffix}`;
}

/** `FAAB $77 of $100`, for the header. Null when the league does not bid or the wallet is unknown. */
export function budgetChip(faab: FaabAdvice | null): string | null {
  if (!faab?.rule.usesFaab || faab.mine?.remaining == null || faab.rule.total == null) return null;
  return `FAAB $${faab.mine.remaining} of $${faab.rule.total}`;
}

/**
 * The "Do this" summary, only when the claims depend on each other: one
 * numbered line each, names only, in the order to enter them. A single claim,
 * or claims that each stand alone, need no summary: the cards say it.
 */
export function DependentClaims({ plan }: { plan: WaiverClaimPlan | null | undefined }) {
  if (!plan?.surface || !claimsDepend(plan)) return null;
  return (
    <div className="card claim-plan" data-testid="waiver-plan" data-state={plan.state}>
      <ol className="claim-plan-list" data-testid="waiver-plan-claims">
        {plan.claims.map((claim) => (
          <li key={claim.claimId} className="claim-plan-claim" data-testid="waiver-plan-claim" data-rank={claim.rank} data-relation={claim.relation}>
            <span className="claim-plan-headline">{claimLine(claim)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Two or more claims where one only runs if another loses, or two spend one drop. */
export function claimsDepend(plan: Pick<WaiverClaimPlan, 'claims'>): boolean {
  if (plan.claims.length < 2) return false;
  const drops = plan.claims.map((c) => c.dropPlayerId).filter((d): d is string => d != null);
  return plan.claims.some((c) => c.qualifier != null || c.relation === 'fallback') || new Set(drops).size < drops.length;
}

/** `Add Allen, drop Wright, if 1 loses`. */
export function claimLine(claim: Pick<WaiverClaimLine, 'addName' | 'dropName' | 'qualifier'>): string {
  const parts = [`Add ${surname(claim.addName)}`];
  if (claim.dropName) parts.push(`drop ${surname(claim.dropName)}`);
  if (claim.qualifier) parts.push(claim.qualifier.replace(/^Only if/i, 'if'));
  return parts.join(', ');
}
