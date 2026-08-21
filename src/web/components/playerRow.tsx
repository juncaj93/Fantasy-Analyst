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
import { CompactTally, InjuryTag, PositionPill, TeamLogo, positionAccentClass } from './common.tsx';

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
  onOpen,
  testId,
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
  onOpen: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      className={positionAccentClass(position, 'dense-row')}
      data-testid={testId}
      data-player-id={playerId}
      data-position={(position ?? '').toUpperCase()}
      /*
        No `aria-label`, deliberately.

        One was written here — "Marcus Vance — open his page" — and it was an
        accessibility regression dressed as an improvement: an accessible name
        on a container replaces everything inside it, so a reader listening
        rather than looking would have been told the player's name and nothing
        else, losing the tally, the availability tag, the club, the position and
        all four numbers that the row exists to show. The row is a button, so
        the platform already says it can be pressed; what it says when pressed
        should be what it says.
      */
      onClick={onOpen}
    >
      {/*
        The locked order, and it is the same on every screen in the app.

        Rank, then the **position pill**, then the name, then whatever qualifies
        the *player* — his tally and his availability — and only then the club
        and the way in. The pill moved here from the trailing edge, which is the
        whole rule: it is fixed-width, so it puts every name in the list on one
        column, and a reader running down a list of forty is answering "which
        position" before "who" more often than the other way round.

        Anything that qualifies the player sits to the right of his name, and
        anything that belongs to the row as an object — the heart, the star —
        sits with the club on the trailing side, where it is out of the path the
        eye takes down the names.
      */}
      <span className="dense-row-top">
        {rank !== undefined ? (
          <span className="rank" aria-hidden="true">
            {rank}
          </span>
        ) : null}
        <PositionPill position={position} />
        <span className="player-name">{name}</span>
        {/*
          The tally and the availability tag share one fixed-width field, so
          the marks after them land on the same edge on every row of every
          list. See `--row-meta`.
        */}
        <span className="player-row-meta">
          {tally === undefined ? null : <CompactTally net={tally} label="Lifetime research tally" />}
          <InjuryTag status={status} />
        </span>
        {leading}
        {team === undefined ? null : <TeamLogo team={team} />}
        <span className="dense-chevron" aria-hidden="true">
          <ChevronIcon />
        </span>
      </span>

      {metrics && metrics.length > 0 ? (
        /*
          How many columns there are decides whether they are a grid or a
          cluster.

          Four equal columns is what makes a list of players scannable: the
          reader runs an eye down `ADP` and it is in the same place on every
          row. Two of them under the same rule is not a grid, it is two numbers
          at opposite ends of the card with a hand's width of nothing between —
          which is what Trades looked like once its row came down to `30d` and
          `Life`. Below three they sit together at the leading edge instead.
        */
        <span className="dense-row-metrics" data-columns={metrics.length}>
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
