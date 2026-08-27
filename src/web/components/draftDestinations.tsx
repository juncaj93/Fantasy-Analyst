/**
 * The three places the Draft header's ▦ leads.
 *
 * The control used to do one thing: open the board. It now opens a choice of
 * three — **Draft board**, **Draft order**, **Mock draft** — and the brief
 * leaves the presentation to this session's judgement with one hard constraint
 * carried over from the browser suite: *the Draft header's nav must stay under
 * 60px at every tested width, and the control cannot grow a second row.*
 *
 * A sheet is the presentation that satisfies that by construction. It is not
 * drawn until it is opened, so the header keeps exactly the height it had; it
 * is the same grouped-list grammar the reader meets in Setup and in every
 * settings screen they have ever used; and it costs no new CSS, because
 * `Sheet` and `ListRow` already exist and already handle the four things a
 * covering layer owes the app. Tabs across the header would have cost the row
 * the constraint forbids, and a popover menu would have been a new component
 * with its own dismissal, focus and scroll-lock behaviour to get wrong.
 *
 * The header's button keeps its test id, its glyph, its position and its size.
 * Only what it opens has changed.
 */

import { useMemo } from 'react';
import type { DraftBoard } from '../api.ts';
import { ListRow, Sheet } from './native.tsx';
import { buildDraftBoardGrid } from '../../core/draft/boardGrid.ts';
import { demoSession } from '../demo/session.ts';

/** Where the ▦ can take you. `none` is the closed state. */
export type DraftDestination = 'none' | 'menu' | 'board' | 'order' | 'mock';

/**
 * The menu itself.
 *
 * `Mock draft` is offered only while the rehearsal is still possible. Once the
 * real draft has made a pick the row is present and disabled with the reason
 * written on it, rather than removed: a control that vanishes teaches the
 * reader that they imagined it, and the sentence is the whole explanation of
 * the lifecycle rule at the one moment they need it.
 */
export function DraftDestinationsSheet({
  board,
  onGo,
  onClose,
}: {
  board: DraftBoard;
  onGo: (destination: DraftDestination) => void;
  onClose: () => void;
}) {
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
  return (
    <Sheet title="Draft" onClose={onClose} testId="draft-destinations">
      <div className="list-group">
        <ListRow
          label="Draft board"
          detail="Every pick, by round and by manager"
          chevron
          testId="go-draft-board"
          onClick={() => onGo('board')}
        />
        <ListRow
          label="Draft order"
          detail="Who picks where, and when you are up again"
          chevron
          testId="go-draft-order"
          onClick={() => onGo('order')}
        />
        {unavailable ? (
          <ListRow
            label="Mock draft"
            detail={unavailable}
            testId="go-mock-draft-unavailable"
            dataState="unavailable"
          />
        ) : (
          <ListRow
            label="Mock draft"
            detail="Practise against your league, as many times as you like"
            chevron
            testId="go-mock-draft"
            onClick={() => onGo('mock')}
          />
        )}
      </div>
    </Sheet>
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

      <div className="list-group" data-testid="draft-order-seats">
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
