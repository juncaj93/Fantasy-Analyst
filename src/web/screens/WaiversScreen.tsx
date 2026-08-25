/**
 * Waivers: who is available, and whether he is worth a claim.
 *
 * The screen the season replaces Draft with. It is deliberately the same shape
 * as the draft board — a list of players, ranked, with the reasoning one tap in
 * — because it is the same activity at a different time of year, and a reader
 * who learned one has learned the other.
 *
 * **It is a shell over a view model, and that is the design.** Everything on a
 * row that a start/sit engine can know, it knows now: how much better he is
 * than the man he would replace, which slot he fills, and why. Everything that
 * depends on the twelve people in *your* league — what he will cost, who else
 * is bidding, what he is worth in four weeks' time — is read from the row if it
 * is there and reported as unknown if it is not. Not estimated. Not
 * extrapolated from a projection. A FAAB figure the reader trusts and we
 * invented is the one thing this page must never produce; see
 * core/waivers/board.ts.
 *
 * Nothing here adds, drops, claims or bids. Every row is a sentence the reader
 * acts on in Sleeper, by hand.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type LeagueSummary, type StartSitRefreshReport, type WaiverAdvice } from '../api.ts';
import { Empty, Notice } from '../components/common.tsx';
import { NavBar, PullToRefresh, SegmentedControl, SkeletonRows } from '../components/native.tsx';
import { WaiverDetailSheet, WaiverRow } from '../components/waivers.tsx';
import { DstLine } from '../components/dst.tsx';
import { buildWaiverBoard, rowMatches, type WaiverBoardRow } from '../../core/waivers/board.ts';
import { unwindOne } from '../tabReset.ts';

const ALL_FILTER = 'ALL';

export function WaiversScreen({ leagues, resetNonce }: { leagues: LeagueSummary[]; resetNonce: number }) {
  const selected = leagues.find((l) => l.isSelected) ?? null;
  const [advice, setAdvice] = useState<WaiverAdvice | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>(ALL_FILTER);
  const [open, setOpen] = useState<WaiverBoardRow | null>(null);

  /*
   * Tapping Waivers while already on Waivers.
   *
   * The open row's detail closes and the position filter goes back to All,
   * which is this screen's resting state — a filter here narrows the *board*
   * rather than recording anything, so returning it is returning the view and
   * not discarding a decision. Then the top.
   */
  useEffect(() => {
    if (resetNonce === 0) return;
    unwindOne([
      { when: open != null, undo: () => setOpen(null) },
      { when: filter !== ALL_FILTER, undo: () => setFilter(ALL_FILTER) },
    ]);
  }, [resetNonce]);

  const load = useCallback(async () => {
    if (!selected) {
      setLoading(false);
      return;
    }
    try {
      setAdvice(await api.get<WaiverAdvice>(`/api/leagues/${selected.id}/waivers`, { onFresh: setAdvice }));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [selected]);

  useEffect(() => {
    void load();
  }, [load]);

  /*
   * The same pull, the same pipeline, the same single-flight guard as Team.
   *
   * And deliberately no control in the navigation bar: a second way to ask for
   * the same thing is what this app has just finished removing from the screen
   * next door.
   */
  const refresh = useCallback(async () => {
    try {
      await api.post<StartSitRefreshReport>('/api/startsit/refresh', {});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    await load();
  }, [load]);

  const board = useMemo(() => (advice?.found ? buildWaiverBoard(advice) : null), [advice]);

  /*
   * The filters, and only the ones that would leave something on screen.
   *
   * `All` always, then the positions actually present, then a flex view when
   * more than one flex-eligible position is on the board — see
   * `offeredPositions`. A chip whose only possible outcome is an empty list is
   * a control that exists to disappoint.
   */
  const segments = useMemo(() => [ALL_FILTER, ...(board?.positions ?? [])], [board]);
  const rows = useMemo(() => (board?.rows ?? []).filter((row) => rowMatches(row, filter)), [board, filter]);

  return (
    <PullToRefresh onRefresh={refresh} label="Waivers" testId="waivers-pull">
      <NavBar title="Waivers" testId="waivers-nav" />

      {error ? <Notice tone="error">{error}</Notice> : null}

      {!selected ? (
        <Empty>No league chosen yet. Open Setup to connect Sleeper and pick your league.</Empty>
      ) : loading && !advice ? (
        <SkeletonRows rows={6} testId="waivers-skeleton" />
      ) : !advice?.found ? (
        <Empty>Your roster was not found in this league. Check the connected Sleeper user.</Empty>
      ) : (
        <>
          {segments.length > 1 ? (
            <SegmentedControl
              label="Filter by position"
              testId="waiver-filters"
              compact
              value={filter}
              onChange={setFilter}
              segments={segments.map((p) => ({ id: p, label: p, testId: `waiver-filter-${p.toLowerCase()}` }))}
            />
          ) : null}

          {/*
            The defence, above the board rather than inside it.

            A `wait` or a `hold` names nobody, so it cannot be a row — and it is
            still the answer to "which defence should I add", which is the
            question this page exists for. It sits above the list because it is
            about a slot rather than about a player, and it draws nothing at all
            in a league that does not start a defence.
          */}
          <DstLine plan={board?.dst ?? null} />

          {rows.length === 0 ? (
            /*
              Nothing on the board, said once — and not said at all when the
              defence line above is already carrying an answer. A page reading
              `Add PIT` over `Nothing available beats what you already have` is
              two claims about the same wire.
            */
            board?.dst?.surface && filter === ALL_FILTER ? null : (
              <Empty>
                {filter === ALL_FILTER
                  ? (board?.headline ?? 'Nothing available beats what you already have.')
                  : `Nothing available at ${filter} beats what you already have.`}
              </Empty>
            )
          ) : (
            rows.map((row) => <WaiverRow key={row.playerId} row={row} onOpen={() => setOpen(row)} />)
          )}

          {/*
            What the page knows it does not know — and nothing about its own
            bookkeeping.

            Three lines used to close this screen: how many players were
            checked, which fields are missing, and a sentence promising the app
            never transacts. Only the middle one changes a decision, because it
            says a blank means *unknown* rather than *zero*; it is kept, without
            the count in front of it. A tally of how many free agents were
            considered is the engine describing its own work to a reader who
            came here to decide on two names.

            The promise is not deleted from the app — it is on the detail sheet
            beside the bid it qualifies, which is where somebody about to act
            actually is. And it is enforced by something stronger than a
            sentence: there is no control on this screen that could transact,
            which `e2e-production/smoke.spec.ts` asserts by reading every button
            on it.
          */}
          {board && board.pending.length > 0 ? (
            <div className="faint" data-testid="waivers-pending" style={{ margin: '4px 4px 8px' }}>
              {joinFields(board.pending)} {board.pending.length === 1 ? 'arrives' : 'arrive'} with league
              intelligence — shown as unknown rather than estimated.
            </div>
          ) : null}

          {(board?.notes ?? []).map((note) => (
            <div className="faint" key={note} style={{ margin: '0 4px 4px' }}>
              {note}
            </div>
          ))}
        </>
      )}

      {open ? <WaiverDetailSheet row={open} onClose={() => setOpen(null)} /> : null}
    </PullToRefresh>
  );
}

/**
 * The columns still waiting, in a sentence.
 *
 * Read from the board rather than hardcoded, because they arrive separately:
 * competition and multi-week value land with the league-intelligence pass and
 * expected cost needs bid history behind it as well. A fixed list of three goes
 * on claiming a field is missing after it has arrived, which is the one thing
 * this line must never do — it is the page's own statement about what it knows.
 */
function joinFields(pending: string[]): string {
  const labels = pending.map((p) => (p === 'expected cost' ? 'Expected cost' : p));
  if (labels.length === 1) return labels[0]!;
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}
