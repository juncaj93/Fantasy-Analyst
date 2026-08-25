/**
 * Matchup: who is winning, where it is going, and what to do about it.
 *
 * The screen answers seven questions in the order somebody actually asks them —
 * who is ahead, what will the final be, what are the odds, what is the biggest
 * remaining swing, what does each side need, who is still live, is there
 * anything to act on — and it answers the first three in the top third of the
 * glass so the fourth through seventh have room.
 *
 * **Sleeper is the score. Fantasy Analyst is everything else.** The two are
 * visually distinguished on purpose: the real score is the largest type on the
 * page and the projection sits under it in the quieter weight this app uses for
 * things it worked out. There is no number anywhere on this screen labelled as
 * Fantasy Analyst's that came from Sleeper's own projection.
 *
 * Nothing here changes a lineup. The decision card says what a change would be
 * worth and the change itself is made in Sleeper, by hand, exactly like every
 * other recommendation in this app.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type LeagueSummary, type LineupImpact, type MatchupResponse, type MatchupPlayerView } from '../api.ts';
import { Empty, Notice } from '../components/common.tsx';
import { NavBar, PullToRefresh, Sheet, SkeletonRows } from '../components/native.tsx';
import {
  BenchSection,
  BestMoveNote,
  BestMoveRow,
  bestMoveState,
  DetailRow,
  InsightList,
  MatchupStatus,
  ScoreCard,
  SlotRow,
  signedPoints,
  winShift,
} from '../components/matchup.tsx';
import { WeeklyCardSheet } from '../components/weekly.tsx';
import { MODE_LABEL } from '../../core/startsit/mode.ts';
import { unwindOne } from '../tabReset.ts';

/**
 * How often the scoreboard is re-read while games are running.
 *
 * Sleeper's matchup endpoint is one small response per league and it is the
 * only thing on this screen that changes minute to minute, so it is the only
 * thing polled. What it costs on the server is bounded by the forecast's own
 * fingerprint cache: a poll that finds the same scores recomputes nothing.
 *
 * Thirty seconds while something is actually live, and nothing at all
 * otherwise — a finished matchup and a Tuesday afternoon are both states in
 * which polling can only produce the same answer.
 */
export const LIVE_POLL_MS = 30_000;

export function MatchupScreen({ leagues, resetNonce }: { leagues: LeagueSummary[]; resetNonce: number }) {
  const selected = leagues.find((l) => l.isSelected) ?? null;
  const [data, setData] = useState<MatchupResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openPlayer, setOpenPlayer] = useState<string | null>(null);
  const [oddsOpen, setOddsOpen] = useState(false);
  const [bestMoveOpen, setBestMoveOpen] = useState(false);
  /*
   * Tapping Matchup while already on Matchup.
   *
   * All three of the things this screen opens over itself — a player's card,
   * the best-move sheet and the sheet behind the odds — close, and the board
   * comes back to the top. The matchup itself is not reloaded: what is on
   * screen is the live state, and a tab tap is a request to see it, not to
   * refetch it.
   *
   * The player card is the innermost rung because it is the one opened *from*
   * either sheet; the two sheets are siblings and never open together, so
   * their order between themselves decides nothing.
   */
  useEffect(() => {
    if (resetNonce === 0) return;
    unwindOne([
      { when: openPlayer != null, undo: () => setOpenPlayer(null) },
      { when: bestMoveOpen, undo: () => setBestMoveOpen(false) },
      { when: oddsOpen, undo: () => setOddsOpen(false) },
    ]);
  }, [resetNonce]);

  /** Guards against two loads overlapping — the later answer could be older. */
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (!selected || inFlight.current) return;
    inFlight.current = true;
    try {
      setData(await api.get<MatchupResponse>(`/api/leagues/${selected.id}/matchup`, { onFresh: setData }));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlight.current = false;
    }
  }, [selected]);

  useEffect(() => {
    void load();
  }, [load]);

  /*
   * The poll, what turns it on, and the three things that switch it off.
   *
   * It stops while the tab is in the background and resumes on the way back —
   * which is what stops the "refresh storm" §35 warns about, where a focus, a
   * pageshow and a visibility change all fire on the same return and each
   * starts its own request. There is exactly one timer and one visibility
   * listener in this screen, and this is still it.
   *
   * What changed is what it watches. A live matchup was the only thing on this
   * screen that went out of date on its own, until the best move came up from
   * the odds sheet and onto the page — and *that* goes out of date at a
   * kickoff, which is precisely when nothing is live yet and the old condition
   * was false. A reader holding the screen open at 12:55 on a Sunday would have
   * been looking at `Start J. Doe over A. Smith` at 1:05, with both games
   * running and the swap no longer legal for anybody. §5 of the brief is
   * absolute about that: a recommendation must never remain visibly actionable
   * after it has stopped being actionable.
   *
   * So the poll runs while there is a recommendation on screen as well, and
   * that condition turns itself off: `decision.best` only exists while both of
   * the players it names are still unstarted, so the first poll after either
   * kickoff removes the move *and* the reason to keep polling. The cost is the
   * same bounded thing the live poll already costs — the forecast's fingerprint
   * covers every game's clock, so a poll that finds nothing changed recomputes
   * nothing and returns the cached forecast.
   */
  const live = data?.forecast?.phase === 'live';
  const actionable = Boolean(data?.forecast && !data.forecast.degraded && data.forecast.decision.best);
  const watching = live || actionable;
  useEffect(() => {
    if (!watching) return;
    let handle = 0;
    const start = () => {
      window.clearInterval(handle);
      handle = window.setInterval(() => void load(), LIVE_POLL_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        window.clearInterval(handle);
        return;
      }
      // Straight back to current on return, then back on the clock.
      void load();
      start();
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(handle);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [watching, load]);

  const forecast = data?.forecast ?? null;

  /** Every player on screen, by id, so a hero card can open the man it names. */
  const players = useMemo(() => {
    const map = new Map<string, MatchupPlayerView>();
    if (!forecast) return map;
    for (const row of forecast.slots) {
      if (row.mine) map.set(row.mine.playerId, row.mine);
      if (row.theirs) map.set(row.theirs.playerId, row.theirs);
    }
    for (const player of [...forecast.bench.mine, ...forecast.bench.theirs]) map.set(player.playerId, player);
    return map;
  }, [forecast]);

  /** What the slot between the score and the lineup is currently saying. */
  const moveState = forecast ? bestMoveState(forecast) : null;
  const move = moveState?.kind === 'move' ? moveState.move : null;

  /*
   * A sheet cannot outlive the recommendation it explains.
   *
   * The poll above removes a move the moment a kickoff makes it illegal, which
   * takes the row off the page — and would have left the sheet the reader had
   * opened from it standing over an empty page, explaining a swap nobody can
   * make any more. Keyed on the swap rather than on the object so a poll that
   * returns the same advice does not close a sheet somebody is reading.
   */
  const moveKey = move ? `${move.inPlayerId}>${move.outPlayerId}@${move.slot}` : null;
  useEffect(() => {
    if (moveKey === null) setBestMoveOpen(false);
  }, [moveKey]);

  const card = openPlayer ? (data?.cards[openPlayer] ?? null) : null;
  /*
   * A card exists for everybody the engine could score, which is nearly
   * everybody and not quite. A player Sleeper rosters that the dictionary has
   * not synced has no evaluation, so there is nothing to open — and a row that
   * looks tappable and does nothing is worse than one that does not.
   */
  const openable = useCallback((playerId: string) => Boolean(data?.cards[playerId]), [data]);

  return (
    <PullToRefresh onRefresh={load} label="Matchup" testId="matchup-pull">
      <NavBar
        testId="matchup-nav"
        title={data ? `Week ${data.week} Matchup` : 'Matchup'}
        {...(forecast ? { trailing: <MatchupStatus phase={forecast.phase} /> } : {})}
      />

      {error ? <Notice tone="error">{error}</Notice> : null}

      {!selected ? (
        <Empty>No league chosen yet. Open Setup to connect Sleeper and pick your league.</Empty>
      ) : !data ? (
        <SkeletonRows rows={8} testId="matchup-skeleton" />
      ) : !data.found || !forecast ? (
        <Empty>{data.reason ?? 'No matchup to show for this week.'}</Empty>
      ) : (
        <>
          <ScoreCard forecast={forecast} {...(forecast.degraded ? {} : { onExplain: () => setOddsOpen(true) })} />

          {/*
            No Live Insights element here, which the lock is explicit about: the
            main matchup page carries no such card or button. The insights
            themselves are not gone — they are a section of the sheet behind the
            win probability, one tap from the number they are about. See
            `InsightList`.
          */}

          {/*
            The answer, directly under the score and directly above the lineup
            it is about — which is the whole of this pass. Everything that
            explains it is still one tap away and nothing that explains it came
            up here with it.
          */}
          {move ? (
            <BestMoveRow move={move} players={players} onOpen={() => setBestMoveOpen(true)} />
          ) : null}

          <div className="section-title section-title-row" data-testid="starters-title">
            <span className="matchup-starters-label">Starters</span>
            {moveState ? <BestMoveNote state={moveState} /> : null}
          </div>
          <div className="matchup-rows">
            {forecast.slots.map((row, i) => (
              <SlotRow
                key={`${row.slot}-${i}`}
                slot={row.slot}
                mine={row.mine}
                theirs={row.theirs}
                onOpen={(player) => setOpenPlayer(player.playerId)}
                openable={openable}
              />
            ))}
          </div>

          <BenchSection
            mine={forecast.bench.mine}
            theirs={forecast.bench.theirs}
            onOpen={(player) => setOpenPlayer(player.playerId)}
            openable={openable}
          />
        </>
      )}

      {card ? (
        <WeeklyCardSheet
          card={card}
          onClose={() => setOpenPlayer(null)}
          /*
           * The sheet's second action belongs to the Team screen, where a
           * comparison can actually change something. From here the useful
           * next step is simply back to the matchup, so the control closes it.
           */
          onCompare={() => setOpenPlayer(null)}
        />
      ) : null}

      {bestMoveOpen && move ? (
        <BestMoveSheet
          move={move}
          options={forecast?.decision.options ?? []}
          players={players}
          onClose={() => setBestMoveOpen(false)}
          /*
           * Swapped, never stacked. The best-move sheet closes in the same beat
           * the player's card opens, so there is one modal on screen at a time
           * and one Escape, one backdrop tap and one downward swipe to get out
           * of it — exactly what the insight rows in the odds sheet already do.
           */
          onOpenPlayer={(playerId) => {
            setBestMoveOpen(false);
            setOpenPlayer(playerId);
          }}
          openable={openable}
        />
      ) : null}

      {oddsOpen && forecast ? (
        <OddsSheet
          forecast={forecast}
          players={players}
          onClose={() => setOddsOpen(false)}
          onOpenPlayer={setOpenPlayer}
          openable={openable}
        />
      ) : null}
    </PullToRefresh>
  );
}

/**
 * Why this is the move, and what else was close.
 *
 * A sheet of its own rather than the odds sheet, and the difference is the
 * question being asked. A reader who taps a win probability is asking what is
 * behind a number; a reader who taps `Best move` has already been told what to
 * do and is asking whether to believe it. Sending the second one into `Behind
 * the odds` would answer him four sections later, under a heading about
 * something else.
 *
 * The order is the order the question unfolds in: the swap, what it costs or
 * gains, what it moves the odds to, why — and only then the moves that did not
 * win, which are the answer to "was this close?" and belong nowhere near the
 * page. `gain` is deliberately absent everywhere: `44% → 48%` already contains
 * it, and printing `+4 points of win probability` beside it is the same fact
 * twice in two units.
 */
function BestMoveSheet({
  move,
  options,
  players,
  onClose,
  onOpenPlayer,
  openable,
}: {
  move: LineupImpact;
  /** Every legal change above the threshold, best first. */
  options: LineupImpact[];
  players: Map<string, MatchupPlayerView>;
  onClose: () => void;
  onOpenPlayer: (playerId: string) => void;
  /** Whether tapping through to this player would show anything. */
  openable: (playerId: string) => boolean;
}) {
  const name = (playerId: string, fallback: string) => players.get(playerId)?.name ?? fallback;
  /*
   * `best` and `options[0]` are the same recommendation and not the same
   * object: they are one object in the model and two after a round trip
   * through JSON, so identity says they differ and the swap they name says
   * they do not. Compared on what a swap *is* — who comes in, who goes out and
   * where — which is true on both sides of the wire.
   */
  const swap = (impact: LineupImpact) => `${impact.inPlayerId}>${impact.outPlayerId}@${impact.slot}`;
  const others = options.filter((option) => swap(option) !== swap(move));

  return (
    <Sheet title="Best move" onClose={onClose} testId="best-move-sheet">
      <div className="matchup-best-move-lead" data-testid="best-move-lead">
        Start {name(move.inPlayerId, move.inName)} over {name(move.outPlayerId, move.outName)}{' '}
        <span className="faint">({move.slot})</span>
      </div>

      {/*
        The two men it names, as the way through to their evidence.

        Only for a player the engine could score, on the same rule every other
        row in this app follows: a control that opens nothing teaches a reader
        that taps here are unreliable. Each closes this sheet before opening
        his card, so there is never a sheet over a sheet.
      */}
      <div data-testid="best-move-players">
        {[
          { playerId: move.inPlayerId, fallback: move.inName, role: 'in' },
          { playerId: move.outPlayerId, fallback: move.outName, role: 'out' },
        ].map((player) =>
          openable(player.playerId) ? (
            <button
              key={player.playerId}
              type="button"
              className="matchup-best-move-player"
              data-testid="best-move-player"
              data-role={player.role}
              onClick={() => onOpenPlayer(player.playerId)}
              aria-label={`Open ${players.get(player.playerId)?.fullName ?? player.fallback}`}
            >
              <span className="matchup-best-move-player-name">{name(player.playerId, player.fallback)}</span>
              <span className="faint">{player.role === 'in' ? 'coming in' : 'going out'}</span>
            </button>
          ) : null,
        )}
      </div>

      <DetailRow label="Projected points">{signedPoints(move.pointsDelta)}</DetailRow>
      <DetailRow label="Win probability">{winShift(move)}</DetailRow>

      {/*
        The engine's own sentence, on its own line and in the register this app
        keeps for reasons. Not restated, not summarised, not rewritten here —
        it is written where the comparison is made, which is the only place
        that knows why one lineup beat another.
      */}
      <div className="faint" style={{ margin: '8px 2px 0' }} data-testid="best-move-reason">
        {move.reason}
      </div>

      {others.length > 0 ? (
        <>
          <div className="detail-label" style={{ marginTop: 12 }} data-testid="best-move-others-title">
            Other worthwhile moves ({others.length})
          </div>
          <div data-testid="best-move-others">
            {others.map((option) => (
              <div key={swap(option)} className="matchup-best-move-other" data-testid="best-move-other">
                <span className="matchup-best-move-other-swap">
                  Start {name(option.inPlayerId, option.inName)} over {name(option.outPlayerId, option.outName)}
                  <span className="faint"> · {option.slot}</span>
                </span>
                <span className="matchup-best-move-other-odds">{winShift(option)}</span>
              </div>
            ))}
          </div>
        </>
      ) : null}

      <div className="faint" style={{ margin: '10px 2px 0' }} data-testid="best-move-footer">
        Change your lineup in Sleeper. Fantasy Analyst does not edit it.
      </div>
    </Sheet>
  );
}

/**
 * What is behind the odds.
 *
 * Everything the brief asks the engine to be able to answer, kept off the main
 * screen and put one tap away: the biggest remaining swings, which question the
 * lineup should be asked, and how confident the forecast is. The approved
 * concept rejected all of this as permanent furniture and it is right — but
 * "not on the screen" is not the same as "not available", and a reader who taps
 * a win probability is asking exactly this question.
 *
 * What is deliberately *not* here is the recommendation itself. It has its own
 * home now — the `Best move` row above the starters, and the sheet behind it —
 * and a fact with two primary homes is a fact the reader has to reconcile. The
 * only thing this sheet still says about the lineup is the one thing that home
 * cannot: which of the three empty cases is the reason there is no move to
 * make. See the note above that branch.
 */
function OddsSheet({
  forecast,
  players,
  onClose,
  onOpenPlayer,
  openable,
}: {
  forecast: NonNullable<MatchupResponse['forecast']>;
  players: Map<string, MatchupPlayerView>;
  onClose: () => void;
  onOpenPlayer: (playerId: string) => void;
  /** Whether tapping through to this player would show anything. */
  openable: (playerId: string) => boolean;
}) {
  const decision = forecast.decision;
  const name = (id: string) => players.get(id)?.name ?? id;

  return (
    <Sheet title="Behind the odds" onClose={onClose} testId="odds-sheet">
      <DetailRow label="Projected final">
        {forecast.teams.mine.projectedFinal?.toFixed(1) ?? '—'} — {forecast.teams.theirs.projectedFinal?.toFixed(1) ?? '—'}
      </DetailRow>
      <DetailRow label="Win probability">
        {Math.round((forecast.teams.mine.winProbability ?? 0) * 100)}% · {forecast.draws.toLocaleString()} simulated
        afternoons
      </DetailRow>
      <DetailRow label="Recommended mode">{MODE_LABEL[forecast.suggestedMode.mode]}</DetailRow>
      {/*
        Why, on its own line.

        The sentence is a sentence and putting it in the value column turns a
        two-word answer into four ragged right-aligned lines. The reason belongs
        under the row it explains, in the register the app uses for reasons.
      */}
      <div className="faint" style={{ margin: '4px 2px 0' }} data-testid="mode-why">
        {forecast.suggestedMode.detail}
      </div>
      {forecast.freshness.detail ? (
        <DetailRow label="Confidence">
          {forecast.freshness.level} · {forecast.freshness.detail}
        </DetailRow>
      ) : null}

      {/*
        The insights, where the entry point on the main screen used to lead.

        They sit above the swings deliberately: an insight is the engine saying
        what is happening now, and the leverage list is what could still change
        it. A reader who opened this sheet by tapping a win probability is
        asking both questions in that order.
      */}
      <InsightList insights={forecast.insights} onOpenPlayer={(id) => { onClose(); onOpenPlayer(id); }} openable={openable} />

      {forecast.leverage.length > 0 ? (
        <>
          <div className="detail-label" style={{ marginTop: 12 }}>
            Biggest remaining swings
          </div>
          <div data-testid="leverage-list">
            {forecast.leverage.slice(0, 4).map((row) => (
              <button
                key={row.playerId}
                type="button"
                className="matchup-leverage"
                data-testid="leverage-row"
                onClick={() => {
                  onClose();
                  onOpenPlayer(row.playerId);
                }}
              >
                <span className="matchup-leverage-name">
                  {name(row.playerId)}
                  <span className="faint"> · {row.side === 'mine' ? 'yours' : 'theirs'}</span>
                </span>
                <span className="matchup-leverage-swing">
                  {Math.round(row.swing * 100)}% swing
                  <span className="faint">
                    {' '}
                    {row.floor.toFixed(1)}–{row.ceiling.toFixed(1)}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </>
      ) : null}

      {/*
        Why there is nothing to change, and only that.

        This section used to restate the recommendation — the swap, the odds it
        moves and the reason for it — under a heading called `Lineup impact`.
        Every one of those facts is now on the Matchup screen itself, in the
        `Best move` row above the starters, and spelled out again in the sheet
        behind it. One fact, one primary home: the sheet that explains a *number*
        has no business printing the app's headline recommendation a third time,
        four sections below where the reader already read it.

        What was **only** ever here is the other branch. `decision.note` tells
        the three empty cases apart — the decisions are locked, the bench cannot
        legally fill a slot, or no change wins more often — and the screen's own
        note says one thing for all three. So the unique half stays, and the
        duplicated half is gone.

        Keyed on the note rather than on the absence of a move, which is the same
        condition said in the terms this block is actually about: the model
        writes a note exactly when it has no change to offer, and a heading over
        an empty paragraph is not an improvement on the duplication it replaced.
      */}
      {decision.note ? (
        <>
          <div className="detail-label" style={{ marginTop: 12 }}>
            Lineup impact
          </div>
          <div className="faint" data-testid="lineup-impact">
            {decision.note}
          </div>
        </>
      ) : null}

      <div className="faint" style={{ margin: '10px 2px 0' }}>
        Advisory only. Change a lineup in Sleeper — this app never edits one. Model {forecast.modelVersion}.
      </div>
    </Sheet>
  );
}
