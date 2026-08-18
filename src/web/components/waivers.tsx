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

import type { WaiverBoardRow } from '../../core/waivers/board.ts';
import { Badge, PositionBadge } from './common.tsx';
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
      <div className="player-row-top">
        <span className="player-name">{row.name}</span>
        {/*
          The same fixed-width field the draft board uses, so the club marks
          line up down this list too — see `--row-meta`.
        */}
        <span className="player-row-meta">
          {row.statusFlag ? <Badge tone="warn">{row.statusFlag.split(' ')[0]}</Badge> : null}
        </span>
        <PositionBadge position={row.position} team={row.team} />
      </div>

      <div className="player-row-metrics">
        <span className={`tag tag-${row.strength.level === 'strong' ? 'take' : row.strength.level === 'solid' ? 'calm' : 'risky'}`}>
          {row.strength.label}
        </span>
        <span className="metric" data-testid="waiver-fit">
          {row.fit.label}
        </span>
        <span className="metric" data-testid="waiver-short-term">
          Week <strong>{row.shortTerm.label}</strong>
        </span>
        {/*
          The three fields the league-intelligence pass owns. Each one is either
          its real value or a dash that explains itself; none of them is ever a
          plausible-looking guess.
        */}
        <span className="metric" data-testid="waiver-cost">
          Cost{' '}
          {row.faab ? (
            <strong>{formatFaab(row.faab)}</strong>
          ) : (
            <UnknownField what="Expected cost" />
          )}
        </span>
        {row.multiWeek ? (
          <span className="metric" data-testid="waiver-multi-week">
            {row.multiWeek.label}
          </span>
        ) : null}
        {row.competition ? (
          <span className="metric" data-testid="waiver-competition">
            {row.competition.label}
          </span>
        ) : null}
      </div>

      <div className="player-row-metrics">
        <span className="metric faint" data-testid="waiver-why">
          {row.why}
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
}: {
  row: WaiverBoardRow;
  onClose: () => void;
  onCompare?: () => void;
}) {
  return (
    <Sheet title={row.name} onClose={onClose} testId="waiver-detail">
      <div className="weekly" data-testid="waiver-detail-body" data-player-id={row.playerId}>
        <div className="weekly-head">
          <PositionBadge position={row.position} team={row.team} />
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
            </dd>
          </div>
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
            {row.bid.disagreement?.line ? (
              <div className="faint" data-testid="faab-disagreement">
                {row.bid.disagreement.line}
              </div>
            ) : null}
          </div>
        ) : null}

        {row.bid?.withheld ? (
          <div className="faint" data-testid="faab-withheld">
            {row.bid.withheld}
          </div>
        ) : null}

        {row.reasons.length > 0 ? (
          <ul className="reason-list" data-testid="waiver-reasons">
            {row.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
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
