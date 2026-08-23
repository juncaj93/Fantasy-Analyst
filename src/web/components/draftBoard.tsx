/**
 * The live draft board, full screen, over the Draft page.
 *
 * The Draft page answers "who should I take". This answers the other question a
 * drafter asks every thirty seconds and currently has to ask in another app:
 * *what is the room doing*. Where the receiver run started, how many
 * quarterbacks have gone, who is hoarding backs, and how everybody's roster is
 * being built — all of which are questions about shape, and none of which a
 * ranked list can answer however good the ranking is.
 *
 * Three rules hold this to being a companion rather than a second app:
 *
 *  1. **It fetches nothing.** Every pick it draws arrives in the board response
 *     the Draft screen's existing live refresh already rebuilds, so a new pick
 *     reaches this grid through exactly the sync that was already running. There
 *     is no second polling loop, no second ownership model, and no request of
 *     any kind made from this file.
 *  2. **It computes nothing.** No score, no ADP, no availability, no tiers.
 *     `boardGrid.ts` arranges what it is handed; this file draws the
 *     arrangement. The only arithmetic here is scroll positions.
 *  3. **It is temporary.** Opening it changes nothing about the Draft page
 *     underneath — filter, search, queue, scroll and expanded card are all
 *     still there, untouched, when it closes.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DraftBoard } from '../api.ts';
import { useOverlay } from '../overlay.ts';
import { TeamLogo } from './common.tsx';
import { CloseIcon, CompressIcon, ExpandIcon } from './icons.tsx';
import {
  buildDraftBoardGrid,
  compositionLine,
  type BoardEntry,
  type DraftBoardGrid,
} from '../../core/draft/boardGrid.ts';

/** Positions the palette has a hue for. Anything else stays neutral, as elsewhere. */
const TINTED = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];

export type BoardMode = 'compact' | 'expanded';

/**
 * The whole board, keyed to the Draft page's own state.
 *
 * `board` is the same object the Draft screen renders its ranked list from. It
 * is replaced whenever the live refresh finds a new pick, which is what makes
 * the grid update — no subscription, no polling, no second source of truth.
 */
export function DraftBoardOverlay({ board, onClose }: { board: DraftBoard; onClose: () => void }) {
  const [mode, setMode] = useState<BoardMode>('compact');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const cornerRef = useRef<HTMLDivElement | null>(null);
  /** The layer itself, which is what owns focus while the board is up. */
  const layerRef = useRef<HTMLDivElement | null>(null);

  const grid = useMemo<DraftBoardGrid>(
    () =>
      buildDraftBoardGrid({
        teams: board.teams,
        rounds: board.rounds,
        type: board.type,
        managers: board.managers ?? [],
        picks: board.boardPicks ?? [],
        currentPick: board.currentPick,
        pickOwners: board.pickOwners ?? null,
        /*
         * A finished draft has nobody on the clock.
         *
         * Taken from Sleeper's own status rather than from the pick count,
         * because a draft can be closed early and a board that outlined a cell
         * nobody will ever pick in would be inventing a turn.
         */
        complete: board.status === 'complete',
      }),
    [
      board.teams,
      board.rounds,
      board.type,
      board.managers,
      board.boardPicks,
      board.currentPick,
      board.pickOwners,
      board.status,
    ],
  );

  /** Where the board should look on open: the pick on the clock, else the last one. */
  const focus = grid.current ?? grid.latest;

  /**
   * Put a cell somewhere useful, and never while the reader is holding the board.
   *
   * Called on open and when the reader taps *Current*, and at no other time.
   * The sticky round column and manager header row overlay the scroll content,
   * so their measured size is subtracted — otherwise "scrolled into view" can
   * mean "scrolled underneath the header".
   *
   * The current column is placed about a third in from the left rather than
   * dead centre: what a drafter wants beside the pick on the clock is the picks
   * that come *after* it, which in a snake is usually where their own next
   * selection is.
   */
  const mySlot = grid.managers.find((m) => m.isMine)?.slot ?? null;

  const scrollTo = useCallback(
    (round: number, slot: number, behavior: ScrollBehavior) => {
      const scroller = scrollRef.current;
      const cell = gridRef.current?.querySelector<HTMLElement>(`[data-cell="${round}:${slot}"]`);
      if (!scroller || !cell) return;
      const gutterX = cornerRef.current?.offsetWidth ?? 0;
      const gutterY = cornerRef.current?.offsetHeight ?? 0;
      const viewport = Math.max(0, scroller.clientWidth - gutterX);

      /*
       * The current pick a third of the way in, unless the reader's own column
       * can be on screen with it — in which case both are, and the current pick
       * gives up its preferred position for it.
       *
       * "Where is the run going, and when do I pick again" is one question, and
       * answering it by scrolling sideways twice is the sort of thing that
       * makes a board something people open once. When the two columns are too
       * far apart to share a screen the current pick wins, because that is the
       * one that moves.
       */
      const mine =
        mySlot == null || mySlot === slot
          ? null
          : gridRef.current?.querySelector<HTMLElement>(`[data-cell="${round}:${mySlot}"]`);
      let left = cell.offsetLeft - gutterX - viewport / 3;
      if (mine) {
        const from = Math.min(cell.offsetLeft, mine.offsetLeft);
        const to = Math.max(cell.offsetLeft + cell.offsetWidth, mine.offsetLeft + mine.offsetWidth);
        if (to - from <= viewport) left = from - gutterX - (viewport - (to - from)) / 2;
      }

      const top = cell.offsetTop - gutterY - Math.max(0, (scroller.clientHeight - gutterY - cell.offsetHeight) / 2);
      scroller.scrollTo({ left: Math.max(0, left), top: Math.max(0, top), behavior });
    },
    [mySlot],
  );

  /*
   * Centred once, on open, and then left alone.
   *
   * The empty dependency list is the feature. A board that re-centred whenever
   * a pick landed would yank the grid out from under somebody who had
   * deliberately scrolled to round eleven to see how the receivers were going —
   * twelve times a minute, during the exact activity the board exists for.
   */
  const openedAt = useRef(focus);
  const centred = useRef(false);
  useEffect(() => {
    if (centred.current) return;
    centred.current = true;
    const at = openedAt.current;
    if (at) scrollTo(at.round, at.slot, 'auto');
  }, [scrollTo]);

  /**
   * The cell the reader is looking at, remembered across a mode change.
   *
   * Compact and expanded columns are different widths and different heights, so
   * a raw scroll offset means a different part of the board in each. The anchor
   * is therefore a *cell* and its offset within the viewport: after the switch
   * the same cell is put back under the same point of the screen, which is what
   * "the board did not move" actually means.
   */
  const anchorRef = useRef<{ round: number; slot: number; dx: number; dy: number } | null>(null);

  const toggleMode = useCallback(() => {
    const scroller = scrollRef.current;
    const gutterX = cornerRef.current?.offsetWidth ?? 0;
    const gutterY = cornerRef.current?.offsetHeight ?? 0;
    if (scroller && gridRef.current) {
      const cells = gridRef.current.querySelectorAll<HTMLElement>('[data-cell]');
      let best: { el: HTMLElement; distance: number } | null = null;
      for (const el of cells) {
        const dx = el.offsetLeft - scroller.scrollLeft - gutterX;
        const dy = el.offsetTop - scroller.scrollTop - gutterY;
        // The first cell at or past the top-left corner of the visible area.
        if (dx < -1 || dy < -1) continue;
        const distance = dx + dy;
        if (!best || distance < best.distance) best = { el, distance };
      }
      const chosen = best?.el;
      if (chosen) {
        const [round, slot] = (chosen.dataset['cell'] ?? '').split(':').map(Number);
        if (round && slot) {
          anchorRef.current = {
            round,
            slot,
            dx: chosen.offsetLeft - scroller.scrollLeft,
            dy: chosen.offsetTop - scroller.scrollTop,
          };
        }
      }
    }
    setMode((m) => (m === 'compact' ? 'expanded' : 'compact'));
  }, []);

  /* Put the anchor back where it was, before the browser paints the new mode. */
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    anchorRef.current = null;
    if (!anchor) return;
    const scroller = scrollRef.current;
    const cell = gridRef.current?.querySelector<HTMLElement>(`[data-cell="${anchor.round}:${anchor.slot}"]`);
    if (!scroller || !cell) return;
    scroller.scrollLeft = Math.max(0, cell.offsetLeft - anchor.dx);
    scroller.scrollTop = Math.max(0, cell.offsetTop - anchor.dy);
  }, [mode]);

  /*
   * Escape, the page held still behind it, the app behind taken out of the
   * reading order, and focus in and back again — all four from the same place
   * a sheet gets them.
   *
   * The board had its own copies of the first two, and both were subtly wrong
   * in the same way every hand-rolled copy is. Its Escape listener fired even
   * when a sheet was open over it, so one key closed both; its scroll lock set
   * `overflow: hidden` on the body, which iOS Safari does not honour, so a
   * flick at the end of the grid still slid the Draft page underneath. Neither
   * is a draft problem, which is why neither is solved here any more.
   */
  const { lift } = useOverlay({ container: layerRef, onDismiss: onClose });

  const columns = grid.managers.length;
  const composition = new Map(grid.composition.map((c) => [c.slot, compositionLine(c)]));

  return createPortal(
    <div
      className="dboard-layer"
      role="dialog"
      aria-modal="true"
      aria-label={`${board.league.name} draft board`}
      data-testid="draft-board"
      data-mode={mode}
      style={{ ['--overlay-lift' as string]: String(lift) }}
      /* Focusable by `useOverlay` and by nothing else — see the sheet. */
      tabIndex={-1}
      ref={layerRef}
    >
      <div className="dboard-bar">
        <button type="button" className="icon-btn" aria-label="Close draft board" data-testid="board-close" onClick={onClose}>
          <CloseIcon />
        </button>
        <div className="dboard-titles">
          <div className="dboard-title">Draft board</div>
          <div className="dboard-sub" data-testid="board-subtitle">
            {board.status === 'complete'
              ? `Final · ${board.rounds} rounds`
              : grid.current
                ? `On the clock · R${grid.current.round} #${grid.current.pickNo}`
                : `${board.rounds} rounds`}
          </div>
        </div>
        {/*
          Back to the action, on request rather than by force.

          The counterpart to never auto-recentring: the reader keeps their place
          for as long as they want it, and gets one tap to give it up. Absent
          entirely once the draft is over, when there is no current pick to
          return to and a control that did nothing would be worse than none.
        */}
        {focus ? (
          <button
            type="button"
            className="btn btn-sm dboard-jump"
            data-testid="board-jump"
            onClick={() => scrollTo(focus.round, focus.slot, 'smooth')}
          >
            {grid.current ? 'Current' : 'Last pick'}
          </button>
        ) : null}
        <button
          type="button"
          className="icon-btn"
          data-testid="board-mode"
          aria-pressed={mode === 'expanded'}
          aria-label={mode === 'compact' ? 'Show player names on the board' : 'Show positions only'}
          onClick={toggleMode}
        >
          {mode === 'compact' ? <ExpandIcon /> : <CompressIcon />}
        </button>
      </div>

      <div className="dboard-scroll" ref={scrollRef} data-testid="board-scroll">
        <div
          className="dboard-grid"
          ref={gridRef}
          style={{ ['--dboard-columns' as string]: String(columns) }}
          role="group"
          aria-label="Draft board: rounds down the page, managers across"
        >
          {/* The corner holds both sticky axes still while the rest moves under them. */}
          <div className="dboard-corner" ref={cornerRef} data-testid="board-corner" aria-hidden="true">
            R
          </div>
          {grid.managers.map((manager) => (
            <div
              key={manager.slot}
              className={manager.isMine ? 'dboard-head dboard-head-mine' : 'dboard-head'}
              data-testid="board-manager"
              data-slot={manager.slot}
              data-mine={manager.isMine ? 'yes' : 'no'}
              /*
               * The roster shape, at no cost in pixels.
               *
               * `2 RB · 3 WR · 1 TE` is genuinely useful and genuinely too big
               * for a 52px column, so in compact mode it lives here — on the
               * pointer, and spoken alongside the name — and the board stays
               * dense. Expanded mode prints it at the foot of the column.
               */
              title={`${manager.name}${composition.get(manager.slot) ? ` — ${composition.get(manager.slot)}` : ''}`}
            >
              <span className="dboard-head-name">{manager.name}</span>
              {manager.isMine ? <span className="sr-only"> (your column)</span> : null}
              {/*
                Spoken rather than shown, in compact mode where it does not fit.
                A `title` is a pointer affordance and not an accessible name, so
                the roster shape is said here instead of being assumed to carry.
              */}
              {mode === 'compact' && composition.get(manager.slot) ? (
                <span className="sr-only">, {composition.get(manager.slot)}</span>
              ) : null}
            </div>
          ))}

          {grid.rows.map((row) => (
            <BoardRowCells
              key={row.round}
              round={row.round}
              cells={row.cells}
              managers={grid.managers}
              mode={mode}
            />
          ))}

          {/*
            The optional roster summary, shipped only where it is quiet.

            Expanded columns are wide enough to print `2 RB · 3 WR` at the foot
            of the board without taking a pixel from any cell, and it is below
            the last round, so it is read on purpose and never in the way.
            Compact mode does not get it: the whole value of compact is density,
            and there is no honest way to add a line to a 52px column.
          */}
          {mode === 'expanded' ? (
            <>
              <div className="dboard-round dboard-foot-label" aria-hidden="true" />
              {grid.managers.map((manager) => (
                <div
                  key={`foot-${manager.slot}`}
                  className={manager.isMine ? 'dboard-foot dboard-foot-mine' : 'dboard-foot'}
                  data-testid="board-composition"
                  data-slot={manager.slot}
                >
                  {composition.get(manager.slot) || '—'}
                </div>
              ))}
            </>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * One round: the round number, then a cell per manager.
 *
 * Flat children rather than a wrapper element, because the grid is one grid —
 * a row element would have to be `display: contents`, which is the sort of
 * thing that works everywhere until it is asked to be sticky in Safari.
 */
function BoardRowCells({
  round,
  cells,
  managers,
  mode,
}: {
  round: number;
  cells: { round: number; slot: number; entries: BoardEntry[] }[];
  managers: { slot: number; isMine: boolean; name: string }[];
  mode: BoardMode;
}) {
  const bySlot = new Map(cells.map((cell) => [cell.slot, cell]));
  return (
    <>
      <div className="dboard-round" data-testid="board-round" data-round={round}>
        {round}
      </div>
      {managers.map((manager) => {
        const cell = bySlot.get(manager.slot);
        const entries = cell?.entries ?? [];
        return (
          <div
            key={manager.slot}
            className={manager.isMine ? 'dboard-cell-wrap dboard-cell-mine' : 'dboard-cell-wrap'}
            data-cell={`${round}:${manager.slot}`}
          >
            {entries.length === 0 ? (
              /* A round this manager traded away. Quiet, and not apologised for. */
              <div className="dboard-cell dboard-cell-none" aria-hidden="true" />
            ) : (
              entries.map((entry) => (
                <BoardCellView key={entry.pickNo} entry={entry} mode={mode} manager={manager.name} />
              ))
            )}
          </div>
        );
      })}
    </>
  );
}

/**
 * One pick.
 *
 * Compact is the position and nothing else — no name, no score, no ADP, no
 * value, no survival percentage, no tier. That restraint is the feature: a
 * board covered in numbers cannot be read at a glance, and every one of those
 * numbers is already on the card the reader came from.
 *
 * Expanded adds the shortest identity that is still an identity — first initial,
 * last name, position, club mark — and stops there.
 */
function BoardCellView({ entry, mode, manager }: { entry: BoardEntry; mode: BoardMode; manager: string }) {
  const player = entry.player;
  const position = player?.position ?? '';
  const tinted = TINTED.includes(position);
  const classes = ['dboard-cell'];
  if (player) classes.push('dboard-cell-done');
  if (tinted) classes.push(`pos-${position}`);
  if (entry.state === 'current') classes.push('dboard-cell-current');
  if (entry.latest) classes.push('dboard-cell-latest');

  /*
   * What a screen reader hears, in both modes.
   *
   * The visible content is an abbreviation by design — `WR`, `1.03`, a club
   * mark — and abbreviations read badly out loud. So the visible parts are
   * hidden from assistive technology and one plain sentence is offered
   * instead, which is the same sentence whether the board is compact or
   * expanded: the mode is a display choice, not a difference in what is true.
   */
  const spoken = player
    ? `Pick ${entry.label}, ${manager}: ${player.name}, ${position || 'position unknown'}${player.team ? `, ${player.team}` : ''}${entry.traded ? ' (traded pick)' : ''}`
    : entry.state === 'current'
      ? `Pick ${entry.label}, ${manager}, on the clock`
      : `Pick ${entry.label}, ${manager}, not yet made`;

  return (
    <div
      className={classes.join(' ')}
      data-testid="board-cell"
      data-pick={entry.pickNo}
      data-state={entry.state}
      data-position={position || undefined}
      data-latest={entry.latest ? 'yes' : undefined}
      data-traded={entry.traded ? 'yes' : undefined}
      /* Semantic state for the pick on the clock, not just an outline. */
      aria-current={entry.state === 'current' ? 'true' : undefined}
    >
      <span className="sr-only">{spoken}</span>
      <span className="dboard-pick" aria-hidden="true">
        {entry.label}
      </span>
      {player ? (
        mode === 'compact' ? (
          <span className="dboard-pos" aria-hidden="true">
            {position || '—'}
          </span>
        ) : (
          <>
            <span className="dboard-name" aria-hidden="true">
              {player.shortName}
            </span>
            <span className="dboard-meta" aria-hidden="true">
              <span className="dboard-pos-sm">{position || '—'}</span>
              {/*
                The club's own mark, from the one logo primitive this app has.
                Its box is fixed before the image exists and an unknown or
                failed club falls back to the abbreviation, so a slow network
                cannot reflow a cell — see TeamLogo.
              */}
              <TeamLogo team={player.team} />
            </span>
          </>
        )
      ) : null}
    </div>
  );
}
