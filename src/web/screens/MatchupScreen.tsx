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
import { api, type LeagueSummary, type MatchupResponse, type MatchupPlayerView } from '../api.ts';
import { Empty, Notice } from '../components/common.tsx';
import { NavBar, PullToRefresh, Sheet, SkeletonRows } from '../components/native.tsx';
import {
  BenchSection,
  DetailRow,
  InsightList,
  MatchupStatus,
  ScoreCard,
  SlotRow,
} from '../components/matchup.tsx';
import { WeeklyCardSheet } from '../components/weekly.tsx';
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
  /*
   * Tapping Matchup while already on Matchup.
   *
   * Both of the things this screen opens over itself (a player's card and the
   * sheet behind the odds) close, and the board
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
   * The poll, and what switches it off.
   *
   * It stops while the tab is in the background and resumes on the way back,
   * which is what stops the "refresh storm" where a focus, a pageshow and a
   * visibility change all fire on the same return. One timer and one
   * visibility listener, running only while a game is live.
   */
  /*
   * Since October 2026 this screen recommends nothing (Team's Best move card
   * is the only start/sit advice in the app), so the only thing here that goes
   * out of date on its own is a live game.
   */
  const watching = data?.forecast?.phase === 'live';
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

  const card = openPlayer ? (data?.cards[openPlayer] ?? null) : null;
  /*
   * A card exists for everybody the engine could score, which is nearly
   * everybody and not quite. A player Sleeper rosters that the dictionary has
   * not synced has no evaluation, so there is nothing to open — and a row that
   * looks tappable and does nothing is worse than one that does not.
   */
  const openable = useCallback((playerId: string) => Boolean(data?.cards[playerId]), [data]);

  return (
    <PullToRefresh onRefresh={load} label="Matchup" testId="matchup-pull" live={data?.gameWindow?.live ?? false}>
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
            No advice on this screen, since October 2026. The Team screen's Best
            move card is the one place the app says who to start, so the two
            screens cannot disagree; the starters sit directly under the score.
          */}
          <div className="section-title section-title-row" data-testid="starters-title">
            <span className="matchup-starters-label">Starters</span>
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
 * What is behind the odds.
 *
 * Everything the brief asks the engine to be able to answer, kept off the main
 * screen and put one tap away: the biggest remaining swings, which question the
 * lineup should be asked, and how confident the forecast is. The approved
 * concept rejected all of this as permanent furniture and it is right — but
 * "not on the screen" is not the same as "not available", and a reader who taps
 * a win probability is asking exactly this question.
 *
 * What is deliberately *not* here is any recommendation. Since October 2026
 * the Team screen's Best move card is the only place the app says who to
 * start, so this sheet explains the number and nothing else.
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

      <div className="faint" style={{ margin: '10px 2px 0' }}>
        Model {forecast.modelVersion}
      </div>
    </Sheet>
  );
}
