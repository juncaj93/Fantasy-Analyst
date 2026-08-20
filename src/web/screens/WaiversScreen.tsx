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
import { buildWaiverBoard, rowMatches, type WaiverBoardRow } from '../../core/waivers/board.ts';

const ALL_FILTER = 'ALL';

export function WaiversScreen({ leagues }: { leagues: LeagueSummary[] }) {
  const selected = leagues.find((l) => l.isSelected) ?? null;
  const [advice, setAdvice] = useState<WaiverAdvice | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>(ALL_FILTER);
  const [open, setOpen] = useState<WaiverBoardRow | null>(null);

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

          {rows.length === 0 ? (
            <Empty>
              {filter === ALL_FILTER
                ? (board?.headline ?? 'Nothing available beats what you already have.')
                : `Nothing available at ${filter} beats what you already have.`}
            </Empty>
          ) : (
            rows.map((row) => <WaiverRow key={row.playerId} row={row} onOpen={() => setOpen(row)} />)
          )}

          {/*
            What the page knows it does not know, said once at the bottom rather
            than as four empty fields on every row.
          */}
          {board && board.pending.length > 0 ? (
            <div className="faint" data-testid="waivers-pending" style={{ margin: '4px 4px 8px' }}>
              {board.considered} available players checked. {joinFields(board.pending)}{' '}
              {board.pending.length === 1 ? 'arrives' : 'arrive'} with league intelligence — shown as unknown rather
              than estimated.
            </div>
          ) : (
            <div className="faint" style={{ margin: '4px 4px 8px' }}>
              {board?.considered ?? 0} available players checked.
            </div>
          )}

          <div className="faint" style={{ margin: '0 4px 8px' }}>
            Advisory only — add, drop or bid in Sleeper. This app never makes a transaction.
          </div>

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
