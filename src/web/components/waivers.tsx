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

import { useState } from 'react';
import type { WaiverBoardRow } from '../../core/waivers/board.ts';
import type { WaiverClaimLine, WaiverClaimPlan } from '../../core/waivers/claimPlan.ts';
import { Badge, PlayerIdentity, PlayerSheetTitle } from './common.tsx';
import { Sheet } from './native.tsx';

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
 * The card is a `div` and every claim is an `li`. The only button on it is
 * `See why`, and there is exactly one: this app makes no transaction, and a
 * claim line that looked tappable would be offering to make one. The claims are
 * typed into Sleeper by hand, which is also why the order matters.
 */
export function WaiverPlanCard({ plan }: { plan: WaiverClaimPlan | null | undefined }) {
  const [open, setOpen] = useState(false);
  if (!plan?.surface) return null;

  /*
   * The sheet is offered only when it has something the card does not.
   *
   * An empty plan whose whole story is its own headline — a quiet week — would
   * open onto a sheet repeating that headline, which is a control that exists to
   * disappoint. A plan with claims always has more; a `no safe drop` plan has
   * the protected list, which is precisely the argument somebody wants with it.
   */
  const hasWhy =
    plan.claims.length > 0 ||
    plan.protectedPlayers.length > 0 ||
    plan.outcomes.length > 0 ||
    plan.relationships.length > 0 ||
    plan.budget != null;

  return (
    <>
      <div className="card claim-plan" data-testid="waiver-plan" data-state={plan.state}>
        <div className="detail-label" data-testid="waiver-plan-headline">
          {plan.headline}
        </div>

        {plan.claims.length > 0 ? (
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

        {hasWhy ? (
          <div className="btn-row" style={{ marginTop: 'var(--sp-2)' }}>
            <button className="btn btn-compact" data-testid="waiver-plan-why" onClick={() => setOpen(true)}>
              See why
            </button>
          </div>
        ) : null}
      </div>
      {open ? <WaiverPlanSheet plan={plan} onClose={() => setOpen(false)} /> : null}
    </>
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
      {claim.qualifier ? (
        <span className="tag tag-mini claim-plan-qualifier" data-testid="waiver-plan-qualifier">
          {claim.qualifier}
        </span>
      ) : null}
    </li>
  );
}

/**
 * The whole argument, in one sheet with no tabs in it.
 *
 * Per claim: why him, why that cut, what the roster gains, what the lineup
 * gains, what the pricing pass said, who else wants him, and how the claim
 * stands to the ones above it. Then the three things that are about the plan
 * rather than about any one claim — how the week can go, whether two adds are
 * worth two cuts, and who the plan refuses to touch.
 *
 * No reason codes reach this file. Every sentence below was written in
 * `core/waivers/claimPlan.ts`, next to the arithmetic that justifies it.
 */
export function WaiverPlanSheet({ plan, onClose }: { plan: WaiverClaimPlan; onClose: () => void }) {
  return (
    <Sheet title={plan.headline} onClose={onClose} testId="waiver-plan-detail">
      <div className="weekly" data-testid="waiver-plan-detail-body" data-state={plan.state}>
        {plan.claims.map((claim) => (
          <div key={claim.claimId} className="claim-why" data-testid="waiver-plan-why-claim" data-rank={claim.rank}>
            <div className="claim-why-head">
              {/*
                Read out, not hidden.

                The number is half the instruction on this sheet — every
                relation sentence under it says `Claim 2` — so a reader using a
                screen reader needs to hear which claim they are inside.
              */}
              <span className="claim-plan-rank">{claim.rank}</span>
              <span className="claim-plan-headline">{claim.headline}</span>
            </div>
            {claim.qualifier ? (
              <div className="faint claim-why-qualifier">{claim.qualifier}</div>
            ) : null}
            <ul className="reason-list">
              {claim.why.map((line, index) => (
                <li key={index}>{line}</li>
              ))}
            </ul>
          </div>
        ))}

        <PlanSection label="How the week can go" lines={plan.outcomes} testId="waiver-plan-outcomes" />
        <PlanSection label="Two adds, or one" lines={plan.relationships} testId="waiver-plan-relationships" />
        <PlanSection label="Not on offer as a cut" lines={plan.protectedPlayers} testId="waiver-plan-protected" />
        <PlanSection label="What your budget allows" lines={plan.budget ? [plan.budget] : []} testId="waiver-plan-budget" />

        {/*
          The promise, beside the instructions it qualifies.

          The same sentence the player sheet carries, in the one other place
          somebody is about to act — and enforced by something stronger than a
          sentence: there is no control on this screen that could transact, which
          `e2e/waivers.spec.ts` asserts by reading every button on it.
        */}
        <div className="faint" style={{ marginTop: 'var(--sp-2)' }}>
          Advisory only — enter these in Sleeper yourself. This app never makes a transaction.
        </div>
      </div>
    </Sheet>
  );
}

function PlanSection({ label, lines, testId }: { label: string; lines: string[]; testId: string }) {
  if (lines.length === 0) return null;
  return (
    <>
      <div className="detail-label" style={{ marginTop: 12 }}>
        {label}
      </div>
      <ul className="reason-list" data-testid={testId}>
        {lines.map((line, index) => (
          <li key={index}>{line}</li>
        ))}
      </ul>
    </>
  );
}

export function WaiverRow({ row, onOpen }: { row: WaiverBoardRow; onOpen: () => void }) {
  return (
    <button
      className="player-row waiver-row"
      data-testid="waiver-row"
      data-player-id={row.playerId}
      data-position={(row.position ?? '').toUpperCase()}
      data-strength={row.strength.level}
      aria-label={`${row.name}, ${row.strength.label}, ${row.fit.label}`}
      onClick={onOpen}
    >
      {/*
        Who he is, then what the app makes of him — the same order every other
        row in this app now uses. The club's mark has moved out of the trailing
        edge and into the identity cluster with the position and the name (see
        `PlayerIdentity`), which leaves the verdict alone on the right where it
        is the one thing being weighed.
      */}
      <div className="player-row-top">
        <PlayerIdentity position={row.position} team={row.team} />
        <span className="player-name">{row.name}</span>
        <span className="player-row-meta">
          {row.statusFlag ? <Badge tone="warn">{row.statusFlag.split(' ')[0]}</Badge> : null}
        </span>
        {/*
          The verdict, and it still gives way before the name does.

          The labels are short enough to fit now — see `STRENGTH_LABEL` — but a
          longer one should never be what clips a player's name, so the badge
          keeps the floor that lets it shrink first.
        */}
        <span
          className={`tag waiver-strength tag-${row.strength.level === 'strong' ? 'take' : row.strength.level === 'solid' ? 'calm' : 'risky'}`}
          data-testid="waiver-strength"
          title={row.strength.label}
        >
          {row.strength.label}
        </span>
      </div>

      {/*
        Tags, then one line.

        This card used to be three lines of prose under the header — `High
        pressure · 7 of 11 rivals need the position`, `stronger market
        expectation (13.5 vs 9.2 pts)`, a cost and a fit scattered between
        them — and a reader had to assemble the claim from four places. The
        tags are the recurring shapes: what he is, how wanted he is, which way
        he is moving. The line under them is the arithmetic: what he costs, who
        else wants him, what he is worth.
      */}
      <div className="tag-row" data-testid="waiver-tags">
        <span className="tag" data-testid="waiver-fit">
          {row.fit.label}
        </span>
        {row.multiWeek ? <span className="tag">{row.multiWeek.label}</span> : null}
        {row.competition ? (
          <span className="tag" data-testid="waiver-competition">
            {row.competition.label}
          </span>
        ) : null}
      </div>

      <div className="waiver-summary" data-testid="waiver-summary">
        <span data-testid="waiver-cost">
          Est. cost{' '}
          {row.faab ? <strong>{formatFaab(row.faab)}</strong> : <UnknownField what="Expected cost" />}
        </span>
        {row.competition?.detail ? <span> · {row.competition.detail}</span> : null}
        {/*
          One unbreakable phrase. `Proj. +6.5 pts` wrapping to leave `pts`
          alone on a second line is the sort of thing that makes a compact card
          look accidental.
        */}
        <span data-testid="waiver-short-term" style={{ whiteSpace: 'nowrap' }}>
          {' '}
          · Proj. <strong>{row.shortTerm.label}</strong>
        </span>
      </div>
    </button>
  );
}

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

        The compact board behind it is untouched and stays image-free. A face
        per row is what the discovery measured and rejected: it costs the name
        column more than a portrait is worth on a list somebody is scanning.

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
              {row.shortTerm.label}
              {row.shortTerm.over ? <span className="faint"> over {row.shortTerm.over}</span> : null}
            </dd>
          </div>
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
            <dt>Expected cost</dt>
            <dd>
              {row.faab ? (
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
        {row.bid && !row.bid.withheld ? (
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
