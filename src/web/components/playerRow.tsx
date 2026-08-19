/**
 * The compact player row, and the fixed columns underneath it.
 *
 * One shape, two screens. Players is a database being scanned and Trades is a
 * shortlist being weighed, and before this they were two different renderings
 * of the same object: a two-line card with a wash on one screen, a five-line
 * card with a three-cell table on the other. A reader who learns to read a
 * player on one of them should not have to learn again on the next.
 *
 * What this component is allowed to decide: where the rank goes, where the name
 * goes, which field the tally and the availability tag share, where the club
 * mark lands, and that a row that leads somewhere carries a chevron. What it is
 * not allowed to decide: any of the numbers. Every value arrives as a prop
 * already formatted by the screen that knows what it means — this file contains
 * no football, and could not compute a tally if it wanted to.
 *
 * The top line deliberately reuses the draft board's own fields (`player-name`,
 * `player-row-meta`, `PositionBadge`) rather than growing a parallel set. That
 * is what keeps every club mark in the app on one x — see
 * `e2e/row-alignment.spec.ts`, which asserts it on both screens.
 */

import type { ReactNode } from 'react';
import { ChevronIcon } from './icons.tsx';
import { CompactTally, InjuryTag, PositionBadge, positionAccentClass } from './common.tsx';

/** One labelled number in the row's second line. */
export interface RowMetric {
  /** The short word above nothing — `21d`, `ADP`, `Life`. */
  label: string;
  value: ReactNode;
  /** Two columns instead of one, for a cell that carries a badge as well. */
  wide?: boolean;
  testId?: string;
}

export function CompactPlayerRow({
  playerId,
  name,
  position,
  team,
  status,
  tally,
  rank,
  leading,
  metrics,
  note,
  open = false,
  onOpen,
  testId,
  label,
}: {
  playerId: string;
  name: string;
  position: string | null;
  team?: string | null;
  status?: string | null;
  /**
   * The lifetime research tally, beside the name. Omitted entirely rather than
   * printed as a zero — see {@link CompactTally}, which renders nothing at 0.
   */
  tally?: number;
  /** The row's place in the list, when the list has an order worth numbering. */
  rank?: ReactNode;
  /** A control that belongs to the row itself — the heart, a star, a grip. */
  leading?: ReactNode;
  metrics?: RowMetric[];
  /**
   * One short line under the numbers, composed by the caller — usually with
   * {@link RowNote}, which truncates the sentence and lets a qualifier sit at
   * the end of it.
   */
  note?: ReactNode;
  open?: boolean;
  onOpen: () => void;
  testId: string;
  /** The accessible name of the control, when the visible text is not enough. */
  label?: string;
}) {
  return (
    <button
      type="button"
      className={positionAccentClass(position, 'dense-row')}
      data-testid={testId}
      data-player-id={playerId}
      data-position={(position ?? '').toUpperCase()}
      data-open={open ? 'yes' : 'no'}
      {...(label ? { 'aria-label': label } : {})}
      onClick={onOpen}
    >
      <span className="dense-row-top">
        {rank !== undefined ? (
          <span className="rank" aria-hidden="true">
            {rank}
          </span>
        ) : null}
        {leading}
        <span className="player-name">{name}</span>
        {/*
          The tally and the availability tag share one fixed-width field, so
          the position pill and the club's mark after them land on the same
          edge on every row of every list. See `--row-meta`.
        */}
        <span className="player-row-meta">
          {tally === undefined ? null : <CompactTally net={tally} label="Lifetime research tally" />}
          <InjuryTag status={status} />
        </span>
        <PositionBadge position={position} team={team} />
        <span className="dense-chevron" aria-hidden="true">
          <ChevronIcon />
        </span>
      </span>

      {metrics && metrics.length > 0 ? (
        <span className="dense-row-metrics">
          {metrics.map((m) => (
            <span
              key={m.label}
              className={m.wide ? 'dense-metric dense-metric-wide' : 'dense-metric'}
              {...(m.testId ? { 'data-testid': m.testId } : {})}
            >
              <span className="dense-metric-label">{m.label}</span>
              <span className="dense-metric-value">{m.value}</span>
            </span>
          ))}
        </span>
      ) : null}

      {note ? <span className="dense-row-note">{note}</span> : null}
    </button>
  );
}

/**
 * The row's second line as it is written when a screen has nothing to put in a
 * column — a single free-form line rather than an empty grid.
 */
export function RowNote({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  return (
    <>
      <span>{children}</span>
      {trailing}
    </>
  );
}
