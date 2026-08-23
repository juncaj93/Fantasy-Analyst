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
import { CompactTally, InjuryTag, PlayerIdentity, positionAccentClass } from './common.tsx';

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
  action,
  trailing,
  trailingBelow,
  metrics,
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
  /**
   * The row's own independent control — the heart on Players.
   *
   * A *sibling* of the way-in button rather than a child of it, and the
   * distinction is the whole reason this prop is not simply rendered inline.
   * Nested, it was a `<button>` inside a `<button>`: invalid, undefined
   * behaviour between browsers, one tab stop where there are two actions, and a
   * 28px target where a thumb needs 44. It is drawn over the row from the slot
   * it always occupied — see `.row-action` — so the line reads exactly as it
   * did while the two actions are separate to everything that has to tell them
   * apart.
   */
  action?: ReactNode;
  /**
   * The far end of the identity line, and the far end of the numbers under it.
   *
   * Two slots rather than one, because what wants to go there is a *stack*: on
   * Trades, who holds the player over how sure the suggestion is. Written as a
   * third line it cost the row a line and read as a sentence; written as a
   * third column it read as a dense table. Hung off the ends of the two lines
   * the row already has, it costs nothing and lands where a reader looks for
   * the answer to "and whose is he".
   *
   * Both truncate rather than push: a long team name gives way before the
   * player's own name does.
   */
  trailing?: ReactNode;
  trailingBelow?: ReactNode;
  metrics?: RowMetric[];
  onOpen: () => void;
  testId: string;
}) {
  return (
    /*
      A container with two buttons in it, and it used to be one button with a
      button inside it.

      That shape was invalid HTML — a `<button>` may not contain a `<button>` —
      and what browsers do with the pair is undefined rather than agreed. What
      it cost in practice was everything the nesting implies: one tab stop where
      the row offers two actions, a screen reader announcing a control it could
      not reach separately, and an independent control whose target was whatever
      the glyph happened to measure, which in production was 28×28.

      The row's identity — the test id, the player, the position accent — stays
      on the container, because that is the object; the two actions inside it
      are the two things a reader can do to it.
    */
    <div
      className={positionAccentClass(position, 'dense-row')}
      data-testid={testId}
      data-player-id={playerId}
      data-position={(position ?? '').toUpperCase()}
    >
      <button
        type="button"
        className="dense-row-open"
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

          It is truer of this button than it was of the row: the control that
          used to be nested in here has moved out, so everything left inside is
          the player and nothing inside it is a second action whose name would
          be swallowed.
        */
        onClick={onOpen}
      >
        {/*
          The locked order, and it is the same on every screen in the app.

          Rank, then **who he is** — the position pill, the club's mark and the
          name, as one cluster — then whatever qualifies him, and only then the
          way in.

          The club used to sit at the far right, which put the three facts that
          identify a player at three different places on the row: position on the
          leading edge, name in the middle, club on the trailing edge beside a
          control that has nothing to do with him. Everything that says *who* is
          now on one side in the order a reader asks for it, and the trailing edge
          is the row's own controls and nothing else. See `PlayerIdentity`.

          Anything that qualifies the player still sits to the right of his name —
          his tally, his availability — because those are readings about him
          rather than parts of his name.
        */}
        <span className="dense-row-top">
          {rank !== undefined ? (
            <span className="rank" aria-hidden="true">
              {rank}
            </span>
          ) : null}
          <PlayerIdentity position={position} {...(team === undefined ? {} : { team })} />
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
          {trailing ? <span className="dense-row-aside">{trailing}</span> : null}
          {/*
            The control's own slot, and the control itself is not in it.

            The row's first line is as tall as the tallest thing on it and that
            thing is the control, so lifting the control out without leaving its
            box behind would cost every row on both screens eight pixels of
            height — a density change bought by a semantics fix rather than
            argued for. The box stays, empty and hidden; the control is drawn
            over it below. See `.row-action-slot`.
          */}
          {action ? <span className="row-action-slot" aria-hidden="true" /> : null}
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
          <span
            className="dense-row-metrics"
            data-columns={metrics.length}
            data-aside={trailingBelow ? 'yes' : 'no'}
          >
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
            {trailingBelow ? <span className="dense-metrics-aside">{trailingBelow}</span> : null}
          </span>
        ) : null}
      </button>

      {/*
        The row's own action, beside the way in rather than inside it.

        Last in the DOM and therefore last in the tab order, which is the order
        it reads in: the row, then the one thing you can do to it without
        opening it. Where it lands on screen is `.row-action`'s business — over
        the slot above, in a target the size of a thumb.
      */}
      {action ? <span className="row-action">{action}</span> : null}
    </div>
  );
}
