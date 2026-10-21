/**
 * The waiver tiers: Do this, Worth considering, Watch list, and the drop-ready
 * bench.
 *
 * Every move is the shared `WaiverCard` (`components/waiverCard.tsx`), the
 * same card Team's "Waiver moves" draws, and opens `TierDetailSheet`, which
 * holds everything the card does not print. A card is a button that opens its
 * detail and nothing else. Nothing here adds, drops or bids: every line is a
 * recommendation to act on in Sleeper.
 */

import type { TierRow, WaiverTiersView } from '../../core/waivers/tierPlan.ts';
import type { WeekSource } from '../../core/waivers/aheadWeeks.ts';
import { PlayerSheetTitle } from './common.tsx';
import { Sheet } from './native.tsx';
import { WaiverCard } from './waiverCard.tsx';
import { alsoText, pickupText, tierCard } from '../waiverCard.ts';
import { SLEEPER_NUM_CLASS, SLEEPER_SPOKEN } from '../sleeperFallback.ts';

/**
 * Where a week's number came from, short enough for a phone row. A Sleeper
 * week has no word: its number wears the shared fallback marker instead
 * (16 October 2026).
 */
const WEEK_SOURCE_SHORT: Record<Exclude<WeekSource, 'sleeper'>, string> = {
  this_week: 'this week',
  current: 'this week’s number',
};

/** `+22.3 pts`, or `IR stash` for a stash, whose value is past the window (`Return unknown` when nobody knows when). */
export function tierBadge(row: Pick<TierRow, 'gain' | 'reasonCode'> & { stashLabel?: string | null }): string {
  if (row.reasonCode === 'ir_stash') return row.stashLabel === 'return unknown' ? 'Return unknown' : 'IR stash';
  return `+${Math.max(0, row.gain).toFixed(1)} pts`;
}

/**
 * One move as a card: face, name, gain, two chips and a short reason. Waivers'
 * tiers and Team's "Waiver moves" both draw this, from the same row. The
 * pickup line, the alternatives and the drop list it used to print are on the
 * sheet (21 October 2026).
 */
export function TierRowButton({ row, onOpen }: { row: TierRow; onOpen: () => void }) {
  return (
    <WaiverCard
      model={tierCard(row)}
      onOpen={onOpen}
      testId="waiver-tier-row"
      gainTestId="tier-gain"
      reasonTestId="tier-reason"
      data={{ 'data-tier': row.tier }}
    />
  );
}

/** The bench players nobody would start: listed so the spot is known before it is needed. */
export function DropReadyCard({ tiers }: { tiers: WaiverTiersView }) {
  if (tiers.dropReady.length === 0) return null;
  return (
    <div className="card claim-plan" data-testid="drop-ready">
      <ul className="claim-plan-list" style={{ listStyle: 'none', paddingInlineStart: 0, marginTop: 0 }}>
        {tiers.dropReady.map((d) => (
          <li key={d.playerId} className="claim-plan-claim" data-testid="drop-ready-row" data-player-id={d.playerId}>
            <span className="claim-plan-headline">
              {d.name} <span className="faint">{d.position}</span>
            </span>
            <span className="claim-plan-detail">{d.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Everything below the plan card on Waivers: the tiers, then the drop-ready bench. */
export function TierSections({
  tiers,
  onOpen,
  afterConsider,
}: {
  tiers: WaiverTiersView;
  onOpen: (row: TierRow) => void;
  /** Rows the defence planner named, drawn with the considered moves. */
  afterConsider?: React.ReactNode;
}) {
  const hasConsider = tiers.consider.length > 0 || afterConsider != null;
  return (
    <>
      {hasConsider ? (
        <>
          <div className="section-title" data-testid="tier-consider-title">
            Worth considering
          </div>
          <section data-testid="tier-consider">
            {tiers.consider.map((row) => (
              <TierRowButton key={row.playerId} row={row} onOpen={() => onOpen(row)} />
            ))}
            {afterConsider}
          </section>
        </>
      ) : null}
      {tiers.watch.length > 0 ? (
        <>
          <div className="section-title" data-testid="tier-watch-title">
            Watch list
          </div>
          <section data-testid="tier-watch">
            {tiers.watch.map((row) => (
              <TierRowButton key={row.playerId} row={row} onOpen={() => onOpen(row)} />
            ))}
          </section>
        </>
      ) : null}
      {tiers.dropReady.length > 0 ? (
        <>
          <div className="section-title" data-testid="drop-ready-title">
            Drop-ready
          </div>
          <DropReadyCard tiers={tiers} />
        </>
      ) : null}
    </>
  );
}

/**
 * Who the plan is not cutting and why, in one line: an elite back's handcuff,
 * or a player in your Sleeper lineup whose drop score is lower than the
 * drop's. Empty when nobody like that was passed over.
 */
function keptLine(row: TierRow, tiers: WaiverTiersView): string | null {
  const scores = tiers.dropScores ?? [];
  if (scores.length === 0 || !row.drop || row.bestDrops?.length) return null;
  const cut = row.drop.score ?? null;
  const kept = scores.filter(
    (d) =>
      d.playerId !== row.drop!.playerId &&
      ((d.protectedAs === 'handcuff') || (d.protectedAs === 'in your lineup' && cut != null && d.score < cut)),
  );
  if (kept.length === 0) return null;
  return kept.map((d) => `${d.name} (${d.protectedAs})`).join(', ');
}

function weekLine(row: TierRow, weights: number[]): string {
  return row.byWeek
    .map((w, i) => `Wk ${w.week} ${w.change >= 0 ? '+' : '−'}${Math.abs(w.change).toFixed(1)}${weights[i] != null && weights[i] !== 1 ? ` (×${weights[i]})` : ''}`)
    .join(' · ');
}

/** One move in full: why, the lineup arithmetic, the drop, and the bid. */
export function TierDetailSheet({ row, tiers, onClose }: { row: TierRow; tiers: WaiverTiersView; onClose: () => void }) {
  return (
    <Sheet
      title={<PlayerSheetTitle playerId={row.playerId} name={row.name} position={row.position} team={row.team} />}
      accessibleLabel={row.name}
      onClose={onClose}
      testId="tier-detail"
    >
      <TierDetailBody row={row} tiers={tiers} />
    </Sheet>
  );
}

/**
 * The sheet's body, apart from the sheet so a test can read every word of it.
 * Everything the card stopped printing is here: the pickup line, the full
 * reason, the alternatives and the drop list.
 */
export function TierDetailBody({ row, tiers }: { row: TierRow; tiers: WaiverTiersView }) {
  const bid = row.bid;
  const also = alsoText(row);
  return (
      <div className="weekly" data-testid="tier-detail-body" data-player-id={row.playerId}>
        <div className="weekly-head">
          <span className="metric">{row.tier === 'do_this' ? 'Do this' : row.tier === 'consider' ? 'Worth considering' : 'Watch list'}</span>
          <span className="metric">
            <strong>{tierBadge(row)}</strong>
          </span>
        </div>
        <dl className="weekly-lines">
          <div className="weekly-line" data-testid="tier-detail-pickup">
            <dt>Pickup</dt>
            <dd>{pickupText(row)}</dd>
          </div>
          <div className="weekly-line">
            <dt>Why</dt>
            <dd>{row.reason}</dd>
          </div>
          <div className="weekly-line" data-testid="tier-detail-weeks">
            <dt>Lineup</dt>
            <dd>
              {weekLine(row, tiers.window.weights)}
              <span className="faint"> · depth {row.insurance >= 0 ? '+' : '−'}{Math.abs(row.insurance).toFixed(1)}</span>
            </dd>
          </div>
          {row.weekNumbers?.length ? (
            <div className="weekly-line" data-testid="tier-detail-numbers">
              <dt>His numbers</dt>
              <dd>
                {row.weekNumbers.map((n, k) => (
                  <span key={n.week}>
                    {k > 0 ? ' · ' : ''}
                    Wk {n.week}{' '}
                    {n.source === 'sleeper' ? (
                      <span className={SLEEPER_NUM_CLASS}>
                        {n.points.toFixed(1)}
                        <span className="sr-only">, {SLEEPER_SPOKEN}</span>
                      </span>
                    ) : (
                      <>
                        {n.points.toFixed(1)} <span className="faint">{WEEK_SOURCE_SHORT[n.source]}</span>
                      </>
                    )}
                  </span>
                ))}
              </dd>
            </div>
          ) : null}
          {row.prefs.length > 0 ? (
            <div className="weekly-line" data-testid="tier-detail-prefs">
              <dt>Your rules</dt>
              <dd>{row.prefs.map((p) => `${p.label} (${p.points > 0 ? '+' : '−'}${Math.abs(p.points).toFixed(1)})`).join(' · ')}</dd>
            </div>
          ) : null}
          <div className="weekly-line" data-testid="tier-detail-drop">
            <dt>Your spot</dt>
            <dd>
              {row.needsSpot
                ? row.needsSpot.length > 0
                  ? row.tier === 'do_this'
                    ? 'Pick your drop:'
                    : 'You need a spot first.'
                  : 'Needs a roster spot: every honest spot is taken by the moves above.'
                : row.drop?.viaReserve
                  ? `Move ${row.drop.name} to IR, then claim ${row.name}. You make both moves in Sleeper.`
                  : row.drop
                    ? `Drop ${row.drop.name}`
                    : 'An open roster spot; no drop needed'}
              {(row.bestDrops ?? row.needsSpot ?? []).length > 0 ? (
                <>
                  {row.needsSpot || row.tier === 'do_this' ? null : <span className="faint"> Lowest-cost options:</span>}
                  {/* Best drops, cheapest first, each with its full reason (Alex, 14 October). */}
                  <ol className="best-drops-why" data-testid="tier-detail-needs-spot">
                    {(row.bestDrops ?? row.needsSpot ?? []).slice(0, 3).map((c) => (
                      <li key={c.playerId} data-testid="tier-detail-best-drop">
                        {c.name}
                        {c.position || c.stat ? <span className="faint"> {[c.position, c.stat].filter(Boolean).join(' \u00b7 ')}</span> : null}
                        <span className="best-drops-reason faint">{c.reason}</span>
                      </li>
                    ))}
                  </ol>
                </>
              ) : null}
              {row.drop?.reason && !row.bestDrops ? (
                <span className="faint" data-testid="tier-detail-drop-why">
                  {' '}
                  · {row.drop.reason}
                </span>
              ) : null}
              {row.competesWith.length > 0 ? <span className="faint"> · {row.competesWith.join(', ')} want{row.competesWith.length === 1 ? 's' : ''} the same spot</span> : null}
            </dd>
          </div>
          {keptLine(row, tiers) ? (
            <div className="weekly-line" data-testid="tier-detail-kept">
              <dt>Not cutting</dt>
              <dd>{keptLine(row, tiers)}</dd>
            </div>
          ) : null}
          {also ? (
            <div className="weekly-line" data-testid="tier-detail-also">
              <dt>Also fits</dt>
              <dd>{also}</dd>
            </div>
          ) : null}
          <div className="weekly-line">
            <dt>Last week</dt>
            <dd>{row.lastWeekPoints == null ? <span className="faint">not on record yet</span> : `${row.lastWeekPoints.toFixed(1)} pts (week ${tiers.lastWeek.week})`}</dd>
          </div>
        </dl>

        <div className="bid" data-testid="tier-detail-bid">
          {bid.kind === 'claim' ? (
            <>
              <div>
                <strong>
                  Bid ${bid.recommended}
                  {bid.low != null && bid.high != null && bid.low !== bid.high ? ` · likely $${bid.low}–${bid.high}` : ''}
                </strong>
              </div>
              <div className="faint">{bid.reason}</div>
              {bid.likely.length > 0 ? (
                <ul className="faint tier-rivals" data-testid="tier-detail-rivals">
                  {bid.likely.map((r) => (
                    <li key={r.name} data-testid="tier-detail-rival">
                      <span style={{ whiteSpace: 'nowrap' }}>
                        {r.name} {Math.round(r.chance * 100)}%
                      </span>
                      {r.why ? <span style={{ overflowWrap: 'anywhere' }}> · {r.why}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {bid.thin ? <div className="faint">{bid.thin}</div> : null}
            </>
          ) : bid.kind === 'free' ? (
            <>
              <div>
                <strong>Free agent: first come, no bid</strong>
              </div>
              {tiers.freeAgentRule ? <div className="faint">{tiers.freeAgentRule}</div> : null}
            </>
          ) : (
            <div className="faint">{bid.reason}</div>
          )}
        </div>

        <div className="faint">Advisory only. Add, drop or bid in Sleeper; this app never makes a transaction.</div>
      </div>
  );
}
