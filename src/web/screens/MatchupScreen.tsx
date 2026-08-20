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
import { BenchSection, DetailRow, HeroCarousel, MatchupStatus, ScoreCard, SlotRow } from '../components/matchup.tsx';
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
  /*
   * Tapping Matchup while already on Matchup.
   *
   * Both of the things this screen opens over itself — a player's card and the
   * sheet behind the odds — close, and the board comes back to the top. The
   * matchup itself is not reloaded: what is on screen is the live state, and a
   * tab tap is a request to see it, not to refetch it.
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
      setData(await api.get<MatchupResponse>(`/api/leagues/${selected.id}/matchup`));
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
   * The live poll, and the three things that switch it off.
   *
   * It runs only while the matchup is actually live, it stops while the tab is
   * in the background, and it resumes on the way back — which is what stops the
   * "refresh storm" §35 warns about, where a focus, a pageshow and a visibility
   * change all fire on the same return and each starts its own request. There
   * is exactly one timer and one visibility listener in this screen.
   */
  const live = data?.forecast?.phase === 'live';
  useEffect(() => {
    if (!live) return;
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
  }, [live, load]);

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

          <HeroCarousel insights={forecast.insights} onOpenPlayer={setOpenPlayer} openable={openable} />

          <div className="section-title" data-testid="starters-title">
            Starters
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
        <OddsSheet forecast={forecast} players={players} onClose={() => setOddsOpen(false)} onOpenPlayer={setOpenPlayer} />
      ) : null}
    </PullToRefresh>
  );
}

/**
 * What is behind the odds.
 *
 * Everything the brief asks the engine to be able to answer, kept off the main
 * screen and put one tap away: the biggest remaining swings, what a lineup
 * change would be worth, and which question the lineup should be asked. The
 * approved concept rejected all of this as permanent furniture and it is right
 * — but "not on the screen" is not the same as "not available", and a reader
 * who taps a win probability is asking exactly this question.
 */
function OddsSheet({
  forecast,
  players,
  onClose,
  onOpenPlayer,
}: {
  forecast: NonNullable<MatchupResponse['forecast']>;
  players: Map<string, MatchupPlayerView>;
  onClose: () => void;
  onOpenPlayer: (playerId: string) => void;
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

      <div className="detail-label" style={{ marginTop: 12 }}>
        Lineup impact
      </div>
      {decision.best ? (
        <div className="matchup-decision" data-testid="lineup-impact">
          <div>
            <strong>
              Start {name(decision.best.inPlayerId)} over {name(decision.best.outPlayerId)}
            </strong>{' '}
            <span className="faint">({decision.best.slot})</span>
          </div>
          <div className="faint">
            {Math.round(decision.best.winNow * 100)}% → {Math.round(decision.best.winAfter * 100)}% ·{' '}
            {decision.best.reason}
          </div>
        </div>
      ) : (
        <div className="faint" data-testid="lineup-impact">
          {decision.note}
        </div>
      )}

      <div className="faint" style={{ margin: '10px 2px 0' }}>
        Advisory only. Change a lineup in Sleeper — this app never edits one. Model {forecast.modelVersion}.
      </div>
    </Sheet>
  );
}
