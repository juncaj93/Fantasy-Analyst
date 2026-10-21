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
import { PlayerSheetTitle } from './common.tsx';
import { Sheet } from './native.tsx';
import { WaiverCard } from './waiverCard.tsx';
import { boardCard, clearDay, surname } from '../waiverCard.ts';

/**
 * What an unknown league fact looks like.
 *
 * A dash with a reason attached, never a number. Expected cost, competition and
 * multi-week value all come from the league-intelligence pass, and this is what
 * they look like when it has nothing to say — either because it has not run, or
 * because it deliberately withheld a price: a priority league, an unpublished
 * budget, a spent wallet. The reason itself is one tap away in the detail
 * sheet. See core/waivers/board.ts for why nothing is estimated in its place.
 */
function UnknownField({ what }: { what: string }) {
  return (
    <span className="faint" title={`${what} is not known yet — no value is being invented`} data-testid="waiver-unknown">
      —
    </span>
  );
}

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
  return (
    <div className="card claim-plan" data-testid="waivers-no-move">
      <div className="detail-label" data-testid="waivers-no-move-headline">
        {headline ?? summary.headline}
      </div>
      {summary.detail ? (
        <div className="faint claim-plan-note" data-testid="waivers-no-move-detail">
          {summary.detail}
        </div>
      ) : null}
      {summary.nearest ? (
        <div className="faint claim-plan-note" data-testid="waivers-no-move-nearest">
          {summary.nearest}
        </div>
      ) : null}
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

/**
 * The whole of what is known about one claim.
 *
 * Opened by the row, and it is where everything the row refused to print goes:
 * every reason rather than the first, the other slots he fits, and the league
 * facts as sentences rather than as fields. Still no transaction anywhere.
 */
export function WaiverDetailSheet({
  row,
  onClose,
  onCompare,
  dropHint,
}: {
  row: WaiverBoardRow;
  onClose: () => void;
  onCompare?: () => void;
  /**
   * Who this roster would cut for *him*, from the claim planner.
   *
   * The one thing this sheet has never been able to answer, and the reason the
   * planner exists: the preferred cut moves with the incoming player, so a
   * single "worst player on my roster" list is the wrong answer to a claim. It
   * is here rather than on the compact row because the row sits a few lines
   * under a plan card that already names the cut for the players it claims —
   * and this reaches the targets the plan had no room for as well.
   */
  dropHint?: string | null;
}) {
  return (
    <Sheet
      /*
        The candidate, headed the way every focused player in this app is
        headed — see `PlayerSheetTitle`.

        This is a sheet about exactly one player: the reader picked him out of
        the board, and the whole card is the case for claiming *him*. That is
        the same act as opening the shared player card, so it gets the same
        header rather than a second answer — his face, his name, and the pill
        and club that used to open the body's first line.

        Since 21 October 2026 the cards behind it carry a 44px face too (Alex:
        "add the player's headshot next to each card"). The card puts the name
        on a line of its own, so the face no longer costs the name its width.

        Availability stays in the body, where it is a sentence under
        `Availability` rather than a code. The row's own badge already shows the
        short form to a reader who has not opened anything.
      */
      title={
        <PlayerSheetTitle playerId={row.playerId} name={row.name} position={row.position} team={row.team} />
      }
      accessibleLabel={row.name}
      onClose={onClose}
      testId="waiver-detail"
    >
      <div className="weekly" data-testid="waiver-detail-body" data-player-id={row.playerId}>
        <div className="weekly-head">
          <span className="metric">{row.strength.label}</span>
          {row.score == null ? null : (
            <span className="metric">
              Proj <strong>{row.score.toFixed(1)}</strong>
            </span>
          )}
        </div>

        <dl className="weekly-lines">
          {cardReason(row) ? (
            <div className="weekly-line" data-testid="waiver-detail-why">
              <dt>Why</dt>
              <dd>{cardReason(row)}</dd>
            </div>
          ) : null}
          <div className="weekly-line">
            <dt>Fit</dt>
            <dd>
              {row.fit.label}
              {row.fit.alsoFits.length > 0 ? <span className="faint"> · also {row.fit.alsoFits.join(', ')}</span> : null}
            </dd>
          </div>
          <div className="weekly-line">
            <dt>This week</dt>
            <dd>
              {row.yardstick && row.shortTerm.over ? (
                <>
                  {row.shortTerm.label}
                  <span className="faint">
                    {' '}
                    vs {row.shortTerm.over} · {row.yardstick.label}
                  </span>
                </>
              ) : (
                <>
                  {row.shortTerm.label}
                  {row.shortTerm.over ? <span className="faint"> over {row.shortTerm.over}</span> : null}
                </>
              )}
            </dd>
          </div>
          {(row.notes ?? []).length > 0 ? (
            <div className="weekly-line" data-testid="waiver-detail-notes">
              <dt>Heads up</dt>
              <dd>{(row.notes ?? []).join(' · ')}</dd>
            </div>
          ) : null}
          <div className="weekly-line">
            <dt>Beyond this week</dt>
            <dd>
              {row.multiWeek ? (
                <>
                  {row.multiWeek.label}
                  {row.multiWeek.detail ? <span className="faint"> · {row.multiWeek.detail}</span> : null}
                </>
              ) : (
                <UnknownField what="Multi-week value" />
              )}
            </dd>
          </div>
          <div className="weekly-line">
            <dt>Rest of season</dt>
            <dd data-testid="waiver-season-line">
              {row.seasonOutlook ? (
                <>
                  {row.seasonOutlook.label}
                  {row.seasonOutlook.detail ? <span className="faint"> · {row.seasonOutlook.detail}</span> : null}
                </>
              ) : (
                <UnknownField what="Season outlook" />
              )}
            </dd>
          </div>
          <div className="weekly-line">
            <dt>Expected cost</dt>
            <dd data-testid="waiver-detail-cost">
              {row.pickup?.state === 'free' ? (
                <>
                  None
                  <span className="faint"> · free agent</span>
                </>
              ) : row.faab ? (
                <>
                  {formatFaab(row.faab)}
                  {row.faab.detail ? <span className="faint"> · {row.faab.detail}</span> : null}
                </>
              ) : (
                <UnknownField what="Expected cost" />
              )}
            </dd>
          </div>
          <div className="weekly-line">
            <dt>Competition</dt>
            <dd>
              {row.competition ? (
                <>
                  {row.competition.label}
                  {row.competition.detail ? <span className="faint"> · {row.competition.detail}</span> : null}
                </>
              ) : (
                <UnknownField what="Likely competition" />
              )}
              {/*
                Who they are, one line each.

                Only rendered when the pass could support naming them; a league
                with no bid history and no wallets shows the count above and
                stops there, which is the honest end of this feature rather than
                a degraded version of it.
              */}
              {row.bidders && row.bidders.length > 0 ? (
                <ul className="waiver-bidders" data-testid="waiver-bidders">
                  {row.bidders.map((bidder) => (
                    <li key={bidder.rosterId}>
                      {bidder.display}
                      {bidder.caveat ? <span className="faint"> · {bidder.caveat}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </dd>
          </div>
          {dropHint ? (
            <div className="weekly-line" data-testid="waiver-drop-hint">
              <dt>If you claim him</dt>
              <dd>{dropHint}</dd>
            </div>
          ) : null}
          {row.statusFlag ? (
            <div className="weekly-line">
              <dt>Availability</dt>
              <dd>{row.statusFlag}</dd>
            </div>
          ) : null}
        </dl>

        {/*
          The priced bid, in the words of the pass that priced it.

          Three separate statements rather than one number, because they answer
          three different questions and collapsing them loses the most useful
          thing this sheet can say: *he will go for more than he is worth to
          you.* Nothing here is recomputed — see `WaiverBidLike`.
        */}
        {row.pickup?.state === 'waivers' ? (
          <div className="faint" data-testid="waiver-detail-window">
            On waivers until {clearDay(row.pickup.until)}:{' '}
            {row.pickup.reason === 'dropped' ? 'just dropped, so a claim is contested.' : 'his game has started, so he clears at the weekly run.'}
          </div>
        ) : null}

        {row.bid && !row.bid.withheld && row.pickup?.state !== 'free' ? (
          <div className="bid" data-testid="faab-bid" data-player={row.bid.playerId}>
            <div>
              <strong>{row.bid.headline}</strong>
            </div>
            {row.bid.doNotExceed == null ? null : (
              <div className="faint">
                Do not exceed ${row.bid.doNotExceed}
                {row.bid.confidence === 'low' ? ' · price is an estimate' : ''}
              </div>
            )}
            {row.bid.opportunity ? (
              <div className="faint" data-testid="faab-opportunity">
                {row.bid.opportunity.line}
              </div>
            ) : null}
            {row.bid.trending ? (
              <div className="faint" data-testid="faab-trending">
                {row.bid.trending}
              </div>
            ) : null}
            {/*
              The disagreement sentence is not printed here.

              `Both the room and our own read like him, which is the expensive
              version of being right` is a good sentence and it is a paragraph
              on a sheet the lock asks to be decision-first. What it says is
              already carried by the two numbers above it — the recommended bid
              and the do-not-exceed — which is what somebody about to bid is
              reading. It is still on the row's data for anything that wants it.
            */}
          </div>
        ) : null}

        {row.bid?.withheld ? (
          <div className="faint" data-testid="faab-withheld">
            {row.bid.withheld}
          </div>
        ) : null}

        {/*
          Why we like him: three rows, each a short verdict and its evidence.

          The engine writes these as `Market rising — 13.5 vs 9.2 pts expected`,
          so the em dash is already the seam between the claim and the number
          behind it. Splitting on it gives the pill and the support without the
          screen inventing either.

          Three, not all of them. A sheet that lists every reason the engine
          found is the engine's working rather than an argument, and the ones
          after the third are the ones it thought least of.
        */}
        {row.reasons.length > 0 ? (
          <>
            <div className="detail-label" style={{ marginTop: 12 }}>
              Why we like him
            </div>
            <ul className="reason-list" data-testid="waiver-reasons">
              {row.reasons.slice(0, 3).map((reason) => {
                const [claim, ...rest] = reason.split(' — ');
                const support = rest.join(' — ');
                return (
                  <li key={reason}>
                    <span className="tag">{claim}</span>
                    {support ? <span className="faint"> {support}</span> : null}
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}

        <div className="faint">Advisory only — add, drop or bid in Sleeper. This app never makes a transaction.</div>

        {onCompare ? (
          <div className="btn-row" style={{ margin: '10px 0 0' }}>
            <button className="btn" data-testid="waiver-compare" onClick={onCompare}>
              Compare
            </button>
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}

/**
 * The wallet, as the lines the info sheet prints: what is left, what winning
 * has cost here, and the highest losing bid seen. It used to be a paragraph at
 * the foot of Waivers.
 */
export function budgetLines(faab: FaabAdvice | null): string[] {
  if (!faab) return [];
  if (!faab.rule.usesFaab) return [`${faab.rule.provenance}.`];
  const mine = faab.mine;
  return [
    mine?.remaining == null ? 'Your remaining budget is unknown.' : `$${mine.remaining} of $${faab.rule.total} left.`,
    faab.prices.sample > 0
      ? `Winning bids here have run $${faab.prices.low}–${faab.prices.high} across ${faab.prices.sample}.`
      : 'No winning bids recorded in this league yet.',
    faab.losingBids,
  ].filter(Boolean);
}

/** `FAAB $77 of $100`, for the header. Null when the league does not bid or the wallet is unknown. */
export function budgetChip(faab: FaabAdvice | null): string | null {
  if (!faab?.rule.usesFaab || faab.mine?.remaining == null || faab.rule.total == null) return null;
  return `FAAB $${faab.mine.remaining} of $${faab.rule.total}`;
}

/**
 * The league's waiver rule, one fact a line. The sentence comes from
 * `freeAgentRule` in `core/waivers/tierPlan.ts`; anything it does not recognize
 * is printed whole.
 */
export function ruleLines(rule: string | null): string[] {
  if (!rule) return [];
  const m = rule.match(/^In this league a dropped player is on waivers for (.+?), and a player whose game has started waits for the (.+?) run; anyone else is an instant add\.$/);
  if (!m) return [rule];
  return [`A dropped player is on waivers for ${m[1]}.`, `A player whose game has started waits for the ${m[2]} run.`, 'Anyone else is an instant add.'];
}

/** What the gain chip on a card is, from the window the tiers used. */
export function chipLines(window: { weeks: number[]; weights: number[] } | null): string[] {
  if (!window || window.weeks.length === 0) return [];
  const full = window.weeks.filter((_, i) => (window.weights[i] ?? 1) === 1);
  const half = window.weeks.filter((_, i) => (window.weights[i] ?? 1) !== 1);
  const list = (w: number[]) => (w.length === 1 ? `week ${w[0]}` : `weeks ${w.slice(0, -1).join(', ')} and ${w[w.length - 1]}`);
  return [
    `The +pts chip is what the move adds to your best lineup over weeks ${window.weeks[0]}–${window.weeks[window.weeks.length - 1]}.`,
    `${list(full)[0]!.toUpperCase()}${list(full).slice(1)} ${full.length === 1 ? 'counts' : 'count'} in full${half.length > 0 ? `; ${list(half)} ${half.length === 1 ? 'counts' : 'count'} half` : ''}.`,
    'It includes a small credit for bench depth and your roster rules.',
    'A "starts over" line in the sheet is one week alone, so it can differ.',
  ];
}

/**
 * Everything that used to sit around the cards, on one sheet behind the info
 * button: what the chip means, what the tiers mean, the league's rule and the
 * wallet. Lines, not paragraphs.
 */
export function WaiversInfoSheet({
  faab,
  rule,
  window,
  onClose,
}: {
  faab: FaabAdvice | null;
  rule: string | null;
  window: { weeks: number[]; weights: number[] } | null;
  onClose: () => void;
}) {
  return (
    <Sheet title="About Waivers" onClose={onClose} testId="waivers-info">
      <WaiversInfoBody faab={faab} rule={rule} window={window} />
    </Sheet>
  );
}

export function WaiversInfoBody({ faab, rule, window }: { faab: FaabAdvice | null; rule: string | null; window: { weeks: number[]; weights: number[] } | null }) {
  const sections: { key: string; title: string; lines: string[] }[] = [
    { key: 'chip', title: 'The points chip', lines: chipLines(window) },
    {
      key: 'tiers',
      title: 'The lists',
      lines: window
        ? ['Do this: fills a hole or adds a lot. Make the move.', 'Worth considering: a real gain, your call.', 'Watch list: better on paper; no move needed now.']
        : [],
    },
    { key: 'rule', title: 'Waiver rules', lines: ruleLines(rule) },
    { key: 'budget', title: 'Budget and bids', lines: budgetLines(faab) },
  ];
  return (
    <div className="weekly waivers-info" data-testid="waivers-info-body">
      {sections
        .filter((sec) => sec.lines.length > 0)
        .map((sec) => (
          <section key={sec.key} data-testid={sec.key === 'budget' ? 'faab-budget' : sec.key === 'rule' ? 'waivers-free-agent-rule' : `waivers-info-${sec.key}`}>
            <div className="detail-label">{sec.title}</div>
            <ul className="waivers-info-lines">
              {sec.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>
        ))}
      <div className="faint">Advisory only. Add, drop or bid in Sleeper; this app never makes a transaction.</div>
    </div>
  );
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
