/**
 * The waiver tiers: Do this, Worth considering, then the Watch list and the
 * drop-ready bench folded into one row each.
 *
 * Every move is the shared `WaiverCard` (`components/waiverCard.tsx`), the
 * same row Team's "Waiver moves" draws, and opens `WaiverSheet`, the
 * comparison. A row is a button that opens its sheet and nothing else.
 * Nothing here adds, drops or bids.
 */

import { useState } from 'react';
import type { TierRow, WaiverTiersView } from '../../core/waivers/tierPlan.ts';
import { PlayerIdentity } from './common.tsx';
import { FoldedGroup, WaiverCard } from './waiverCard.tsx';
import { byGain, tierCard } from '../waiverCard.ts';

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
export function DropReadyRows({ tiers }: { tiers: WaiverTiersView }) {
  return (
    <div data-testid="drop-ready">
      {tiers.dropReady.map((d) => (
        <div key={d.playerId} className="player-row" data-testid="drop-ready-row" data-player-id={d.playerId}>
          <div className="player-row-top">
            <span className="player-identity">
              <PlayerIdentity position={d.position} />
              {/* No team on a drop-ready reading: an empty logo-sized slot keeps the name on the lineup's column. */}
              <span className="team-logo" aria-hidden="true" />
            </span>
            <span className="player-name">{d.name}</span>
          </div>
          <div className="verdict-line faint">{d.reason}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * Everything below "Do this" on Waivers (22 October 2026: the page fits one
 * screen): Worth considering open, three rows then "Show all"; the Watch list
 * and Drop-ready folded into one row each, like Team's Bench.
 */
export function TierSections({
  tiers,
  onOpen,
  afterConsider,
}: {
  tiers: WaiverTiersView;
  onOpen: (row: TierRow) => void;
  /** Rows the defense planner named, drawn with the considered moves. */
  afterConsider?: React.ReactNode;
}) {
  const [all, setAll] = useState(false);
  const consider = byGain(tiers.consider);
  const shown = all ? consider : consider.slice(0, CONSIDER_SHOWN);
  const hasConsider = consider.length > 0 || afterConsider != null;
  return (
    <>
      {hasConsider ? (
        <>
          <div className="section-title" data-testid="tier-consider-title">
            Worth considering
          </div>
          <section className="slot-group" data-testid="tier-consider">
            {shown.map((row) => (
              <TierRowButton key={row.playerId} row={row} onOpen={() => onOpen(row)} />
            ))}
            {consider.length > shown.length ? (
              <button type="button" className="player-row wrow-more" data-testid="tier-consider-more" onClick={() => setAll(true)}>
                Show all ({consider.length})
              </button>
            ) : null}
            {afterConsider}
          </section>
        </>
      ) : null}
      <FoldedGroup label="Watch list" count={tiers.watch.length} testId="tier-watch">
        <section data-testid="tier-watch">
          {byGain(tiers.watch).map((row) => (
            <TierRowButton key={row.playerId} row={row} onOpen={() => onOpen(row)} />
          ))}
        </section>
      </FoldedGroup>
      <FoldedGroup label="Drop-ready" count={tiers.dropReady.length} testId="drop-ready">
        <DropReadyRows tiers={tiers} />
      </FoldedGroup>
    </>
  );
}

/** Worth considering shows this many before "Show all". */
export const CONSIDER_SHOWN = 3;
