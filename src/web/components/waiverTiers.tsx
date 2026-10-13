/**
 * The waiver tiers: Do this, Worth considering, Watch list, and the drop-ready
 * bench.
 *
 * Built from the same parts the board always used: the `player-row
 * waiver-row` button with `PlayerIdentity`, the status `tag`, the
 * `waiver-summary` and `waiver-notes` lines, the shared `Sheet`, and the plan
 * card above it all. A row is a button that opens its detail and nothing else.
 * Nothing here adds, drops or bids: every line is a recommendation to act on in
 * Sleeper.
 */

import type { TierRow, WaiverTiersView } from '../../core/waivers/tierPlan.ts';
import type { WeekSource } from '../../core/waivers/aheadWeeks.ts';
import { PlayerIdentity, PlayerSheetTitle } from './common.tsx';
import { Sheet } from './native.tsx';
import { clearDay } from './waivers.tsx';

/** Where a week's number came from, short enough for a phone row. */
const WEEK_SOURCE_SHORT: Record<WeekSource, string> = {
  this_week: 'this week',
  vegas: 'Vegas',
  sleeper: 'Sleeper',
  current: 'this week’s number',
};

const TIER_TAG: Record<TierRow['tier'], string> = {
  do_this: 'tag-take',
  consider: 'tag-calm',
  watch: '',
};

/** `+22.3 pts`, or `IR stash` for a stash, whose value is past the window. */
export function tierBadge(row: Pick<TierRow, 'gain' | 'reasonCode'>): string {
  if (row.reasonCode === 'ir_stash') return 'IR stash';
  return `+${Math.max(0, row.gain).toFixed(1)} pts`;
}

/**
 * The pickup line: `Free agent · in for X`, or `On waivers until Fri · $3 to win
 * · in for X`. The row is a button, so it carries no transaction word (`add`,
 * `drop`, `bid`, `claim`); the detail sheet says it plainly.
 */
function PickupLine({ row }: { row: TierRow }) {
  const bid = row.bid;
  return (
    <div className="waiver-summary" data-testid="tier-summary" data-pickup={bid.kind}>
      {bid.kind === 'free' ? (
        <span className="tag tag-mini waiver-pickup" data-testid="tier-free">
          Free agent
        </span>
      ) : bid.kind === 'claim' ? (
        <>
          {bid.until ? (
            <>
              <span className="tag tag-mini waiver-pickup">On waivers until {clearDay(bid.until)}</span>{' '}
            </>
          ) : null}
          <span data-testid="tier-bid" style={{ whiteSpace: 'nowrap' }}>
            <strong>${bid.recommended}</strong> to win
          </span>
        </>
      ) : null}
      <span data-testid="tier-drop" style={{ overflowWrap: 'anywhere' }}>
        {bid.kind === 'none' ? '' : ' · '}
        {row.drop ? `in for ${row.drop.name}` : 'uses an open spot'}
      </span>
    </div>
  );
}

export function TierRowButton({ row, onOpen }: { row: TierRow; onOpen: () => void }) {
  const extra = row.alternatives.length > 0 ? `Or ${row.alternatives.join(', ')}` : row.competesWith.length > 0 ? `Same spot as ${row.competesWith.join(', ')}` : null;
  return (
    <button
      className="player-row waiver-row"
      data-testid="waiver-tier-row"
      data-tier={row.tier}
      data-player-id={row.playerId}
      data-position={row.position.toUpperCase()}
      aria-label={`${row.name}, ${row.reason}`}
      onClick={onOpen}
    >
      <div className="player-row-top">
        <PlayerIdentity position={row.position} team={row.team} />
        <span className="player-name">{row.name}</span>
        <span className="player-row-meta" />
        <span className={`tag waiver-strength ${TIER_TAG[row.tier]}`} data-testid="tier-gain">
          {tierBadge(row)}
        </span>
      </div>
      <PickupLine row={row} />
      <div className="waiver-notes" data-testid="tier-reason">
        {row.reason}
      </div>
      {extra ? (
        <div className="waiver-notes faint" data-testid="tier-extra">
          {extra}
        </div>
      ) : null}
    </button>
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
          <div className="faint waivers-others-note" data-testid="tier-watch-note">
            Better on paper; no move needed now.
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

function weekLine(row: TierRow, weights: number[]): string {
  return row.byWeek
    .map((w, i) => `Wk ${w.week} ${w.change >= 0 ? '+' : '−'}${Math.abs(w.change).toFixed(1)}${weights[i] != null && weights[i] !== 1 ? ` (×${weights[i]})` : ''}`)
    .join(' · ');
}

/** One move in full: why, the lineup arithmetic, the drop, and the bid. */
export function TierDetailSheet({ row, tiers, onClose }: { row: TierRow; tiers: WaiverTiersView; onClose: () => void }) {
  const bid = row.bid;
  return (
    <Sheet
      title={<PlayerSheetTitle playerId={row.playerId} name={row.name} position={row.position} team={row.team} />}
      accessibleLabel={row.name}
      onClose={onClose}
      testId="tier-detail"
    >
      <div className="weekly" data-testid="tier-detail-body" data-player-id={row.playerId}>
        <div className="weekly-head">
          <span className="metric">{row.tier === 'do_this' ? 'Do this' : row.tier === 'consider' ? 'Worth considering' : 'Watch list'}</span>
          <span className="metric">
            <strong>{tierBadge(row)}</strong>
          </span>
        </div>
        <dl className="weekly-lines">
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
                    Wk {n.week} {n.points.toFixed(1)} <span className="faint">{WEEK_SOURCE_SHORT[n.source]}</span>
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
              {row.drop ? `Drop ${row.drop.name}` : 'An open roster spot; no drop needed'}
              {row.competesWith.length > 0 ? <span className="faint"> · {row.competesWith.join(', ')} want{row.competesWith.length === 1 ? 's' : ''} the same spot</span> : null}
            </dd>
          </div>
          {row.alternatives.length > 0 ? (
            <div className="weekly-line">
              <dt>Also fits</dt>
              <dd>{row.alternatives.join(', ')}</dd>
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
                <div className="faint" data-testid="tier-detail-rivals">
                  Likely rivals: {bid.likely.map((r) => `${r.name} ${Math.round(r.chance * 100)}%`).join(', ')}
                </div>
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
    </Sheet>
  );
}
