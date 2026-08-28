/**
 * The three places the Draft header's menu control leads.
 *
 * The control used to do one thing: open the board. It now opens a choice of
 * three — **Draft board**, **Draft order**, **Mock draft** — and the brief
 * leaves the presentation to this session's judgement with one hard constraint
 * carried over from the browser suite: *the Draft header's nav must stay under
 * 60px at every tested width, and the control cannot grow a second row.*
 *
 * Nothing drawn until it is opened satisfies that by construction, and both a
 * sheet and an anchored menu qualify. This started as a sheet — it cost no new
 * CSS and reused the grouped-list grammar — and the first real rehearsal said
 * what a screenshot could not: half the screen covered to offer three words is
 * the wrong *shape* for the content, whatever it costs. So it is a popover now,
 * hung under the button that opened it, and the constraint is untouched: an
 * element that does not exist until a tap cannot add height to a header.
 *
 * The one thing a popover owes that a sheet already had is the behaviour of a
 * covering layer — a page that holds still, Escape, focus in and focus back.
 * That is `useOverlay`, which is where all four have lived since before this
 * lane, so the menu inherits them rather than reimplementing them.
 *
 * The header's button keeps its test id, its position and its size; its glyph
 * changed, because a board grid on a control that opens a menu draws its
 * destination and then goes somewhere else. See `MenuChevronIcon`.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { DraftBoard } from '../api.ts';
import { ListRow, Sheet } from './native.tsx';
import { useOverlay } from '../overlay.ts';
import { buildDraftBoardGrid } from '../../core/draft/boardGrid.ts';
import { demoSession } from '../demo/session.ts';

/** Where the header's menu can take you. `none` is the closed state. */
export type DraftDestination = 'none' | 'menu' | 'board' | 'order' | 'mock';

/**
 * One item of the menu.
 *
 * A `<button>` rather than a `ListRow`, because a row in a grouped list and an
 * item in a popover are different objects: the first is a destination in a
 * settings screen and carries a chevron saying so, the second is a command and
 * carries nothing. `role="menuitem"` is what tells a screen reader which of the
 * two it has landed on.
 */
function MenuItem({
  label,
  note,
  disabled,
  onClick,
  testId,
}: {
  label: string;
  note?: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      className="menu-item"
      role="menuitem"
      data-testid={testId}
      disabled={disabled === true}
      {...(disabled === true ? { 'aria-disabled': true } : {})}
      onClick={onClick}
    >
      <span className="menu-item-label">{label}</span>
      {note ? <span className="menu-item-note">{note}</span> : null}
    </button>
  );
}

/**
 * The menu itself, hung under the control that opened it.
 *
 * Three commands and, at most, one sentence — which is the whole argument for
 * the shape. A sheet has to be tall enough to be a sheet; a popover is as tall
 * as what is in it, and what is in it is three words.
 *
 * `Mock draft` is offered only while the rehearsal is still possible. Once the
 * real draft has made a pick the item is present and disabled with the reason
 * written on it, rather than removed: a control that vanishes teaches the
 * reader that they imagined it, and the sentence is the whole explanation of
 * the lifecycle rule at the one moment they need it. It is the only item that
 * carries a second line, and only when it is refusing — an enabled item saying
 * what it does is a description of a word the reader has already read.
 */
export function DraftDestinationsMenu({
  board,
  anchor,
  onGo,
  onClose,
}: {
  board: DraftBoard;
  /** The button this hangs from. Measured, never touched. */
  anchor: RefObject<HTMLElement | null>;
  onGo: (destination: DraftDestination) => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement | null>(null);
  /*
   * Declared before anything measures, and the order matters.
   *
   * `useOverlay` pins the page in its own effect; effects run in the order
   * their hooks were called, so measuring *after* this call is measuring the
   * layout the menu will actually be drawn in rather than the one that existed
   * a frame earlier.
   */
  const { lift } = useOverlay({ container: panel, onDismiss: onClose });
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);

  useEffect(() => {
    const place = () => {
      const node = anchor.current;
      if (!node) return;
      const box = node.getBoundingClientRect();
      /*
       * Under the button and aligned to its right edge, in viewport
       * coordinates, because that is the frame `position: fixed` reads and the
       * one a pinned page cannot shift underneath it.
       */
      setAt({ top: Math.round(box.bottom + 6), right: Math.round(window.innerWidth - box.right) });
    };
    place();
    /*
       A rotation moves the anchor and would leave the menu behind it. Closing
       would also be correct; re-placing is kinder, and costs one listener.
     */
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor]);

  /*
   * Two reasons a rehearsal is not on offer, and both are said rather than
   * hidden.
   *
   * A control that vanishes teaches the reader that they imagined it. A control
   * that is present and refuses, with the reason on it, teaches them the rule —
   * and these are the two rules worth learning: a mock ends when the real draft
   * starts, and Demo Mode is somebody else's league.
   */
  const unavailable = board.picksMade > 0
    ? 'Not while the draft is live — a rehearsal ends the moment the real draft starts'
    : demoSession()
      ? 'Not in Demo Mode — a mock draft practises against your own league'
      : null;

  return createPortal(
    <>
      {/*
        Transparent, and still the thing that closes the menu.

        A popover has no visible scrim — dimming the page for a three-item menu
        would be the sheet's weight arriving by another route — but a tap
        outside still has to dismiss it, and on iOS a `blur` handler is not that
        tap. So the backdrop is here, invisible, doing the one job it has.
      */}
      <div
        className="menu-backdrop"
        data-testid="draft-destinations-backdrop"
        style={{ ['--overlay-lift' as string]: String(lift) }}
        onClick={onClose}
      />
      <div
        className="menu-pop"
        role="menu"
        aria-label="Draft destinations"
        data-testid="draft-destinations"
        tabIndex={-1}
        ref={panel}
        style={{
          ['--overlay-lift' as string]: String(lift),
          top: at ? `${at.top}px` : undefined,
          right: at ? `${at.right}px` : undefined,
          /* Until it has been measured it is not drawn anywhere a reader can
             see it land in the wrong place first. */
          visibility: at ? undefined : 'hidden',
        }}
      >
        <MenuItem label="Draft board" testId="go-draft-board" onClick={() => onGo('board')} />
        <MenuItem label="Draft order" testId="go-draft-order" onClick={() => onGo('order')} />
        {unavailable ? (
          <MenuItem label="Mock draft" note={unavailable} disabled testId="go-mock-draft-unavailable" />
        ) : (
          <MenuItem label="Mock draft" testId="go-mock-draft" onClick={() => onGo('mock')} />
        )}
      </div>
    </>,
    document.body,
  );
}

/**
 * Who sits where, and which picks are theirs.
 *
 * The board answers *what has the room done*; this answers *when am I up*,
 * which is the other question a drafter asks between picks and currently has to
 * count out on their fingers. It fetches nothing and computes nothing of its
 * own — the seats, the snake and any traded pick all come out of
 * `buildDraftBoardGrid`, the same transform the board overlay draws, so the two
 * cannot disagree about whose pick is whose.
 */
export function DraftOrderSheet({ board, onClose }: { board: DraftBoard; onClose: () => void }) {
  const seats = useMemo(() => {
    const grid = buildDraftBoardGrid({
      teams: board.teams,
      rounds: board.rounds,
      type: board.type,
      managers: board.managers ?? [],
      picks: board.boardPicks ?? [],
      currentPick: board.currentPick,
      pickOwners: board.pickOwners ?? null,
      complete: board.status === 'complete',
    });

    /*
     * Every pick a seat owns, in order, read off the grid rather than
     * recomputed.
     *
     * An entry is drawn in the column of the manager who *owns* it, so walking
     * the rows and filing each entry under its `slot` gives the answer after
     * trades for free — which is exactly the case a hand-rolled snake would get
     * wrong, and the reason `ownership.ts` exists at all.
     */
    const owned = new Map<number, { pickNo: number; label: string; traded: boolean; done: boolean }[]>();
    for (const row of grid.rows) {
      for (const cell of row.cells) {
        for (const entry of cell.entries) {
          const list = owned.get(entry.slot) ?? [];
          list.push({
            pickNo: entry.pickNo,
            label: entry.label,
            traded: entry.traded,
            done: entry.state === 'done',
          });
          owned.set(entry.slot, list);
        }
      }
    }

    return grid.managers.map((manager) => ({
      ...manager,
      picks: (owned.get(manager.slot) ?? []).sort((a, b) => a.pickNo - b.pickNo),
    }));
  }, [
    board.teams,
    board.rounds,
    board.type,
    board.managers,
    board.boardPicks,
    board.currentPick,
    board.pickOwners,
    board.status,
  ]);

  const next = seats.find((s) => s.isMine)?.picks.find((p) => !p.done) ?? null;

  return (
    <Sheet title="Draft order" onClose={onClose} testId="draft-order">
      {/*
        The one number the reader came for, before the table they would have had
        to read it out of.
      */}
      <div className="list-group">
        <ListRow
          label="Your next pick"
          value={next ? `${next.label} · #${next.pickNo}` : '—'}
          detail={
            board.mySlot == null
              ? 'Your seat in this draft could not be identified'
              : `Seat ${board.mySlot} of ${board.teams}`
          }
          testId="draft-order-mine"
        />
      </div>

      {/*
        Twelve rows that were twelve of the same row.

        Every seat drew identically and the reader's own was marked by the word
        "You" in the value slot — three letters at the end of a line, in a list
        where every line ends in a number. Reported from a real draft as "I
        can't find myself". Striping gives the eye something to count by and the
        owner's seat gets an actual treatment; both are in `.order-seats`,
        because they are about *this* list rather than about grouped lists.
      */}
      <div className="list-group order-seats" data-testid="draft-order-seats">
        {seats.map((seat) => (
          <ListRow
            key={seat.slot}
            label={`${seat.slot}. ${seat.name}`}
            detail={
              seat.picks.length === 0
                ? 'no picks in this draft'
                : /*
                     Six, then a count.

                     A sixteen-round draft gives every seat sixteen numbers, and
                     a wall of them is a table nobody reads. The next few are
                     what a drafter is actually looking at; the rest are on the
                     board, one tap away.
                   */
                  seat.picks
                    .slice(0, 6)
                    .map((p) => `${p.label}${p.traded ? '⇄' : ''}`)
                    .join(' · ') + (seat.picks.length > 6 ? ` · +${seat.picks.length - 6}` : '')
            }
            value={seat.isMine ? 'You' : undefined}
            dataState={seat.isMine ? 'mine' : undefined}
            testId={`draft-order-seat-${seat.slot}`}
          />
        ))}
      </div>
    </Sheet>
  );
}
