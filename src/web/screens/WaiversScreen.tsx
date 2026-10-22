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
import { api, type LeagueSummary, type WaiverAdvice, type WaiverRefreshReport } from '../api.ts';
import { Empty, Notice } from '../components/common.tsx';
import { NavBar, PullToRefresh, SegmentedControl, SkeletonRows } from '../components/native.tsx';
import { budgetChip, DependentClaims, NoMoveCard, WaiverPlanCard, WaiverRow } from '../components/waivers.tsx';
import { DstLine } from '../components/dst.tsx';
import { buildWaiverBoard, offeredPositions, rowMatches, type WaiverBoardRow } from '../../core/waivers/board.ts';
import { noMoveSummary } from '../../core/waivers/noMove.ts';
import { unwindOne } from '../tabReset.ts';
import { RefreshIcon } from '../components/icons.tsx';
import { TierRowButton, TierSections } from '../components/waiverTiers.tsx';
import { WaiverSheet } from '../components/waiverSheet.tsx';
import { boardSheet, tierSheet } from '../waiverCard.ts';
import { FoldedGroup, WaiverRowGroup } from '../components/waiverCard.tsx';
import type { TierRow, WaiverTiersView } from '../../core/waivers/tierPlan.ts';
import type { NoMoveSummary } from '../../core/waivers/noMove.ts';

const ALL_FILTER = 'ALL';

export function WaiversScreen({ leagues, resetNonce }: { leagues: LeagueSummary[]; resetNonce: number }) {
  const selected = leagues.find((l) => l.isSelected) ?? null;
  const [advice, setAdvice] = useState<WaiverAdvice | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>(ALL_FILTER);
  const [open, setOpen] = useState<WaiverBoardRow | null>(null);
  const [openTier, setOpenTier] = useState<TierRow | null>(null);

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
      { when: openTier != null, undo: () => setOpenTier(null) },
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
   * Sleeper, and nothing else.
   *
   * The trending lists and this week's and last week's transactions: about
   * four Sleeper requests and no paid provider. This used to run the start/sit
   * refresh, which buys odds; the props behind the Vegas yardstick keep their
   * own schedule and budget, and nothing on this screen spends it. The pull
   * gesture and the Refresh control below do the same thing.
   */
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(async () => {
    if (!selected) return;
    setRefreshing(true);
    try {
      await api.post<WaiverRefreshReport>(`/api/leagues/${selected.id}/waivers/refresh`, {});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    await load();
    setRefreshing(false);
  }, [load, selected]);

  const board = useMemo(() => (advice?.found ? buildWaiverBoard(advice) : null), [advice]);

  /*
   * The filters, and only the ones that would leave something on screen.
   *
   * `All` always, then the positions actually present, then a flex view when
   * more than one flex-eligible position is on the board — see
   * `offeredPositions`. A chip whose only possible outcome is an empty list is
   * a control that exists to disappoint.
   */
  /*
   * One recommended move, and everything else demoted beneath it.
   *
   * The board used to be one list under the plan, and every row on it wore a
   * verdict badge — so a plan reading `No waiver move recommended` sat above
   * nine names that each looked like a recommendation. The split is the plan's
   * own: a row is *recommended* when the plan claims him, or when the defence
   * planner named him. Everybody else is an option, and says so.
   */
  const claimed = useMemo(
    () => new Set((advice?.claimPlan?.claims ?? []).map((claim) => claim.addPlayerId)),
    [advice],
  );
  const recommended = useMemo(
    () => (board?.rows ?? []).filter((row) => claimed.has(row.playerId) || row.dst != null),
    [board, claimed],
  );
  const others = useMemo(
    () => (board?.rows ?? []).filter((row) => !claimed.has(row.playerId) && row.dst == null),
    [board, claimed],
  );
  /*
   * Scored options and unscored ones, apart.
   *
   * An unscored row is somebody the rest of Sleeper is adding whom this app
   * cannot rate. It does not beat anybody on paper, so it may not sit under a
   * note saying every row does (October 2026 audit), and it gets its own
   * heading and its reasons instead.
   */
  const scoredOthers = useMemo(() => others.filter((row) => row.strength.level !== 'unknown'), [others]);
  const unscored = useMemo(() => others.filter((row) => row.strength.level === 'unknown'), [others]);
  /* The chips narrow the scored options, which is the only list long enough to need them. */
  const segments = useMemo(() => [ALL_FILTER, ...offeredPositions(scoredOthers)], [scoredOthers]);
  const rows = useMemo(() => scoredOthers.filter((row) => rowMatches(row, filter)), [scoredOthers, filter]);
  /*
   * No claim and nobody recommended: the empty answer, said where the plan
   * would be. When the defence line below carries an answer of its own, the
   * headline is about players only, so the two cannot contradict each other.
   */
  const noMove = advice?.found === true && !advice.claimPlan?.surface && recommended.length === 0;
  const summary = useMemo(() => (advice ? noMoveSummary(advice) : null), [advice]);
  const defenceSpeaks = board?.dst?.surface === true;
  const tiers = advice?.found ? (advice.tiers ?? null) : null;
  /*
   * The defence planner's named rows. A defence that fills an empty or bye-week
   * DEF slot is a hole, so it sits with "Do this"; a stream or a playoff stash is
   * worth considering.
   */
  const dstNamed = useMemo(() => (board?.rows ?? []).filter((row) => row.dst != null), [board]);
  const dstHole = dstNamed.filter((row) => row.dst?.decision === 'add');
  const dstConsider = dstNamed.filter((row) => row.dst?.decision !== 'add');



  return (
    <PullToRefresh onRefresh={refresh} label="Waivers" testId="waivers-pull" live={advice?.gameWindow?.live ?? false}>
      {/*
        Team's header, exactly: the shared NavBar with a round `btn btn-icon`
        refresh in the corner, and how old the board is as the bar's subtitle.
        Replaced the `Updated 9:53 AM · Refresh` text line on 1 October 2026.
        The pull gesture and this button run the same Sleeper-only refresh.
      */}
      <NavBar
        title="Waivers"
        testId="waivers-nav"
        subtitle={
          advice?.found ? (
            <>
              <span data-testid="waivers-updated">
                {advice.updatedAt ? `Updated ${formatUpdated(advice.updatedAt)}` : 'Not updated yet'}
              </span>
              {/* The wallet, one muted fact beside the time. */}
              {budgetChip(advice.faab ?? null) ? <span data-testid="waivers-budget"> · {budgetChip(advice.faab ?? null)}</span> : null}
            </>
          ) : undefined
        }
        trailing={
          selected ? (
            <span className="nav-actions-group">
              <button
                className="btn btn-icon"
                data-testid="waivers-refresh"
                aria-label="Refresh waivers from Sleeper"
                title="Refresh"
                disabled={refreshing}
                onClick={() => void refresh()}
              >
                <RefreshIcon className={refreshing ? 'spin' : undefined} />
              </button>
            </span>
          ) : null
        }
      />

      {error ? <Notice tone="error">{error}</Notice> : null}

      {!selected ? (
        <Empty>No league chosen yet. Open Setup to connect Sleeper and pick your league.</Empty>
      ) : loading && !advice ? (
        <SkeletonRows rows={6} testId="waivers-skeleton" />
      ) : !advice ? null : !advice.found ? (
        <Empty>Your roster was not found in this league. Check the connected Sleeper user.</Empty>
      ) : (
        <>
          {/*
            The answer, before the board that supports it.

            Above the position chips deliberately: a chip narrows the *board*,
            and the plan is not a view of the board — it is the claims to enter,
            in the order to enter them, and hiding it behind a filter for WRs
            would hide the tight end claim that the same plan depends on.
          */}
          {tiers ? (
            <>
              {/*
                The tiers. "Do this" holds the plan card (the instruction to type
                into Sleeper, no controls on it) and the move's own row; the
                tiers below it are scored by what each move adds to your best
                lineup over the next three weeks. See core/waivers/tiers.ts.
              */}
              <div className="section-title" data-testid="waivers-recommended-title">
                Do this
              </div>
              <section data-testid="waivers-recommended">
                {/* Numbered lines only when one claim depends on another; a lone claim is its own card. */}
                <DependentClaims plan={advice.claimPlan} />
                {/* One row per "Do this" move: a QB bye and a TE bye are two, each with its own drop. */}
                {(tiers.doThese ?? (tiers.doThis ? [tiers.doThis] : [])).length > 0 ? null : (
                  <NoMoveCard summary={tierNoMove(tiers)} />
                )}
                {dstNamed.length > 0 ? null : <DstLine plan={board?.dst ?? null} />}
                {/* The moves in one card, as "Your lineup" on Team (22 October 2026). */}
                <WaiverRowGroup>
                  {(tiers.doThese ?? (tiers.doThis ? [tiers.doThis] : [])).map((row) => (
                    <TierRowButton key={row.playerId} row={row} onOpen={() => setOpenTier(row)} />
                  ))}
                  {dstHole.map((row) => (
                    <WaiverRow key={row.playerId} row={row} onOpen={() => setOpen(row)} />
                  ))}
                </WaiverRowGroup>
              </section>
              <TierSections
                tiers={tiers}
                onOpen={setOpenTier}
                afterConsider={
                  dstConsider.length > 0
                    ? dstConsider.map((row) => <WaiverRow key={row.playerId} row={row} onOpen={() => setOpen(row)} />)
                    : undefined
                }
              />
            </>
          ) : (
            <>
            <div className="section-title" data-testid="waivers-recommended-title">
              Recommended move
            </div>
            <section data-testid="waivers-recommended">
              <WaiverPlanCard plan={advice.claimPlan} />
              {noMove && summary ? (
                <NoMoveCard summary={summary} {...(defenceSpeaks ? { headline: 'No player move this week' } : {})} />
              ) : null}

              {/*
                The defence, when it has no row of its own to be said in.

                A `wait` or a `hold` names nobody, so it cannot be a row — and it
                is still the answer to "which defence should I add". When the
                planner *has* named somebody, his row below carries the same words
                and this line would be the same recommendation twice.
              */}
              {recommended.some((row) => row.dst != null) ? null : <DstLine plan={board?.dst ?? null} />}

              <WaiverRowGroup>
                {recommended.map((row) => (
                  <WaiverRow key={row.playerId} row={row} onOpen={() => setOpen(row)} />
                ))}
              </WaiverRowGroup>
            </section>

            {scoredOthers.length > 0 ? (
              <>
                <div className="section-title" data-testid="waivers-others-title">
                  Other options to consider
                </div>
                {/*
                  Under a plan, the heading says it all; the note that said
                  "not part of the plan above" was removed on 1 October 2026.
                  With no plan, the note is the reason nothing is recommended.
                */}
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
                <section className={rows.length === 0 ? undefined : 'slot-group'} data-testid="waivers-others">
                  {rows.length === 0 ? (
                    <Empty>{`Nothing else at ${filter} is worth a look.`}</Empty>
                  ) : (
                    rows.map((row) => <WaiverRow key={row.playerId} row={row} onOpen={() => setOpen(row)} />)
                  )}
                </section>
              </>
            ) : null}
            </>
          )}

          {/* Players the rest of Sleeper is adding that the app cannot rate, folded like Team's Bench (22 October 2026). */}
          <FoldedGroup label="Trending" count={unscored.length} testId="waivers-unscored">
            <section data-testid="waivers-unscored">
              {unscored.map((row) => (
                <WaiverRow key={row.playerId} row={row} onOpen={() => setOpen(row)} />
              ))}
            </section>
          </FoldedGroup>
        </>
      )}

      {openTier && tiers && selected ? (
        <WaiverSheet
          model={tierSheet(openTier, tiers, advice?.found ? advice.pickupStart : null)}
          leagueId={selected.id}
          figures={tiers.weekFigures ?? null}
          window={tiers.window}
          onClose={() => setOpenTier(null)}
        />
      ) : null}
      {open && selected ? <WaiverSheet model={boardSheet(open)} leagueId={selected.id} onClose={() => setOpen(null)} /> : null}
    </PullToRefresh>
  );
}

/** The empty "Do this", said as an answer: what else the tiers hold. */
export function tierNoMove(tiers: WaiverTiersView): NoMoveSummary {
  const consider = tiers.consider.length;
  return {
    headline: 'No must-do move this week',
    detail:
      consider > 0
        ? `${consider} move${consider === 1 ? ' is' : 's are'} worth considering below.`
        : tiers.watch.length > 0
          ? 'Nothing on the wire adds enough to your lineup to act on now.'
          : 'Nothing on the wire would improve your lineup over the next three weeks.',
    nearest: null,
  };
}

/**
 * `5:00 AM` today, `Tue 5:00 AM` this week, `Sep 23` before that.
 *
 * In the reader's own clock. The instant is the server's; the words are the
 * phone's.
 */
export function formatUpdated(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'recently';
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const sameDay = at.toDateString() === now.toDateString();
  if (sameDay) return time;
  const days = (now.getTime() - at.getTime()) / 86_400_000;
  if (days < 6) return `${at.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`;
  return at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
