/**
 * The Matchup screen's pieces.
 *
 * The rule this file is built to is a negative one, and it is the whole product
 * argument: **this is not a scoreboard.** Sleeper already draws a perfectly good
 * scoreboard, and a prettier copy of it would be worth nothing. What is here is
 * the score in as little space as it can honestly take, so that the room left
 * over goes to the two things Sleeper does not have — a projection of where this
 * is going, and one sentence saying what matters about it right now.
 *
 * Everything is layout. No component in this file computes a projection, ranks
 * an insight or decides what is material; all of that arrives from
 * `core/matchup`, already ranked and already worded, for the same reason the
 * draft board arrives scored: the arithmetic belongs where it can be tested.
 *
 * Two accessibility rules are enforced here rather than left to review:
 *
 *  1. **the win probability is never carried by the bar alone.** The percentage
 *     is printed as text beside it, on both sides, and the bar itself is a
 *     labelled `meter`. A reader who cannot separate two hues, or is looking at
 *     this in sunlight, loses nothing.
 *  2. **live, final and injured are words before they are colours.** The green
 *     dot carries "playing now" as its accessible name; `FINAL` is text; a
 *     status mark carries its own name too.
 *
 * One prop appears on nearly every component here: `openable`. It answers
 * whether a given player has a card behind him, and it exists because a row
 * that looks tappable and opens nothing teaches a reader that this screen's
 * taps are unreliable. A player the engine could not score is rendered as a
 * row rather than a control.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { HeroInsight, MatchupForecast, MatchupPlayerView, MatchupTeamView } from '../api.ts';
import { TeamLogo } from './common.tsx';
import { useReducedMotion } from '../gestures.ts';

/* --------------------------------------------------------------- score card */

/**
 * The head-to-head, in one card.
 *
 * Two numbers per side and a bar, while there is anything left to play. The
 * actual score is the loudest thing on it, because it is the only one that is a
 * fact; the projection sits under it in the quiet type reserved for things this
 * app worked out, and the win probability gets the width of the card because it
 * is the number that changes.
 *
 * The projected final is labelled `proj` every time it appears. That label is
 * not decoration: a number this size next to a real score, unlabelled, reads as
 * another real score.
 *
 * Once the matchup is settled both of this app's numbers leave and a result
 * line takes their place. A projection is a statement about what is still to
 * come and a probability is a statement about an open question, and neither is
 * true of a finished afternoon — a card still showing 100% would be a forecast
 * presented as a fact.
 */
export function ScoreCard({
  forecast,
  onExplain,
}: {
  forecast: MatchupForecast;
  /** Opens the detail behind the odds. Absent when there is no forecast. */
  onExplain?: () => void;
}) {
  const { mine, theirs } = forecast.teams;
  const degraded = forecast.degraded;
  const final = forecast.phase === 'final';

  return (
    <div className="matchup-score" data-testid="matchup-score" data-degraded={degraded ? 'true' : 'false'}>
      <div className="matchup-score-teams">
        <TeamColumn team={mine} align="start" final={final} />
        <div className="matchup-versus" aria-hidden="true">
          vs
        </div>
        <TeamColumn team={theirs} align="end" final={final} />
      </div>

      {degraded ? (
        <div className="matchup-degraded" data-testid="matchup-degraded">
          Fantasy Analyst forecast temporarily unavailable. The score above is Sleeper’s and is unaffected.
        </div>
      ) : final ? (
        /* The odds go, the margin arrives, and the recap is the card below. */
        <Result mine={mine} theirs={theirs} {...(onExplain ? { onExplain } : {})} />
      ) : (
        <WinBar
          mine={mine.winProbability ?? 0.5}
          mineName={mine.name}
          theirsName={theirs.name}
          confidence={forecast.freshness}
          {...(onExplain ? { onExplain } : {})}
        />
      )}
    </div>
  );
}

function TeamColumn({ team, align, final }: { team: MatchupTeamView; align: 'start' | 'end'; final: boolean }) {
  return (
    <div className="matchup-team" data-align={align} data-testid={`matchup-team-${team.side}`}>
      <div className="matchup-team-name" title={team.name}>
        {team.name}
      </div>
      {team.record ? <div className="matchup-team-record">{team.record}</div> : null}
      <div className="matchup-team-score" data-testid={`matchup-actual-${team.side}`}>
        {team.actual.toFixed(2)}
      </div>
      {/*
        The projection is a statement about what is still to come, so it stops
        being one the moment nothing is. Printing "125.9 proj" beside a settled
        score would be inviting the reader to grade a forecast against a result
        in the two millimetres between two numbers.
      */}
      {final ? null : (
        <div className="matchup-team-proj" data-testid={`matchup-proj-${team.side}`}>
          {team.projectedFinal == null ? (
            <span className="faint">no forecast</span>
          ) : (
            <>
              {team.projectedFinal.toFixed(1)} <span className="matchup-proj-label">proj</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** How it finished, in the one line that replaces the odds. */
function Result({
  mine,
  theirs,
  onExplain,
}: {
  mine: MatchupTeamView;
  theirs: MatchupTeamView;
  onExplain?: () => void;
}) {
  const margin = Math.round(Math.abs(mine.actual - theirs.actual) * 100) / 100;
  const text =
    mine.actual === theirs.actual ? 'Tied' : `${mine.actual > theirs.actual ? 'Won' : 'Lost'} by ${margin.toFixed(2)}`;

  if (!onExplain) {
    return (
      <div className="matchup-result" data-testid="matchup-result">
        {text}
      </div>
    );
  }
  return (
    <button
      type="button"
      className="matchup-result"
      data-testid="matchup-result"
      onClick={onExplain}
      aria-label={`${text}. Show what the forecast had said.`}
    >
      {text}
    </button>
  );
}

/**
 * The odds, as a number twice and a bar once.
 *
 * The bar is a `meter` with a real accessible name, so it is read as "your win
 * probability, 61%" rather than as a decorative rectangle. Both percentages are
 * printed because the two are not redundant to a reader scanning one side of
 * the screen — and because 39/61 is instantly legible in a way one number is
 * not.
 */
function WinBar({
  mine,
  mineName,
  theirsName,
  confidence,
  onExplain,
}: {
  mine: number;
  mineName: string;
  theirsName: string;
  confidence: MatchupForecast['freshness'];
  onExplain?: () => void;
}) {
  const minePct = Math.round(mine * 100);
  const theirsPct = 100 - minePct;
  const label = `${mineName} ${minePct}% to win, ${theirsName} ${theirsPct}%`;

  const content = (
    <>
      <span className="matchup-win-value" data-testid="matchup-win-mine">
        {minePct}% <span className="matchup-win-word">win</span>
      </span>
      <span
        className="matchup-win-track"
        role="meter"
        aria-valuenow={minePct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
        data-testid="matchup-win-bar"
      >
        <span className="matchup-win-fill" style={{ width: `${minePct}%` }} />
      </span>
      <span className="matchup-win-value matchup-win-value-end" data-testid="matchup-win-theirs">
        {theirsPct}% <span className="matchup-win-word">win</span>
      </span>
    </>
  );

  return (
    <>
      {onExplain ? (
        <button type="button" className="matchup-win" onClick={onExplain} data-testid="matchup-win" aria-label={`${label}. Show what is behind it.`}>
          {content}
        </button>
      ) : (
        <div className="matchup-win" data-testid="matchup-win">
          {content}
        </div>
      )}
      {/*
        Confidence, and only when it is materially weak.

        §32's rule: this must not dominate the card. A forecast built on full
        coverage says nothing at all here, which is what makes the line worth
        reading on the Sunday it does appear.
      */}
      {confidence.level !== 'high' && confidence.detail ? (
        <div className="matchup-confidence" data-testid="matchup-confidence">
          {confidence.level} confidence · {confidence.detail}
        </div>
      ) : null}
    </>
  );
}

/* ---------------------------------------------------------- hero carousel */

/**
 * One live insight at a time.
 *
 * The card is the reason this screen exists, so it gets the space a hero gets —
 * and it gets exactly one card's worth of it. A stack of three would be a
 * dashboard, which is the thing the approved concept explicitly is not.
 *
 * Three behaviours, and each is there for a stated reason:
 *
 *  - **it auto-advances slowly**, and only when there is more than one card to
 *    advance to. Fast enough to notice, slow enough to finish reading — see
 *    {@link CYCLE_MS}. It stops the moment the reader touches it, because
 *    something that moves while you are reading it is worse than something
 *    static.
 *  - **it can be swiped**, and it can also be paged by a button, because a
 *    gesture must never be the only way to reach anything.
 *  - **it does not pretend.** One insight means one card, no dots and no
 *    rotation. A carousel with a single slide is a control that lies about
 *    having more to say.
 */
export const CYCLE_MS = 7000;

export function HeroCarousel({
  insights,
  onOpenPlayer,
  openable,
}: {
  insights: HeroInsight[];
  onOpenPlayer: (playerId: string) => void;
  /**
   * Whether tapping through to this player would actually show something.
   *
   * A player the engine could not score has no card, so the control that would
   * open one is not drawn. A button that does nothing is worse than no button:
   * it teaches the reader that taps on this screen sometimes fail.
   */
  openable: (playerId: string) => boolean;
}) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const reducedMotion = useReducedMotion();
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  // A shorter list than last time must never leave the index past its end.
  const count = insights.length;
  const active = count === 0 ? 0 : Math.min(index, count - 1);

  useEffect(() => {
    if (count <= 1 || paused || reducedMotion) return;
    const handle = window.setInterval(() => setIndex((i) => (i + 1) % count), CYCLE_MS);
    return () => window.clearInterval(handle);
  }, [count, paused, reducedMotion]);

  const go = useCallback(
    (next: number) => {
      if (count === 0) return;
      setIndex(((next % count) + count) % count);
      setPaused(true);
    },
    [count],
  );

  if (count === 0) return null;
  const insight = insights[active]!;

  return (
    <div
      className="hero-card"
      data-testid="hero-card"
      data-kind={insight.kind}
      data-urgency={insight.urgency}
      data-index={active}
      data-count={count}
      onTouchStart={(e) => {
        const touch = e.touches[0];
        if (touch) touchStart.current = { x: touch.clientX, y: touch.clientY };
      }}
      onTouchEnd={(e) => {
        const start = touchStart.current;
        touchStart.current = null;
        const touch = e.changedTouches[0];
        if (!start || !touch) return;
        const dx = touch.clientX - start.x;
        const dy = touch.clientY - start.y;
        // Horizontal, and clearly so: a diagonal drag is the page scrolling,
        // and stealing it would make the list feel stuck.
        if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
        go(active + (dx < 0 ? 1 : -1));
      }}
    >
      <div className="hero-body">
        <div className="hero-headline" data-testid="hero-headline">
          {insight.headline}
        </div>
        {insight.detail ? (
          <div className="hero-detail" data-testid="hero-detail">
            {insight.detail}
          </div>
        ) : null}
        {insight.playerId && openable(insight.playerId) ? (
          <button
            type="button"
            className="hero-action"
            data-testid="hero-action"
            onClick={() => onOpenPlayer(insight.playerId!)}
          >
            View details ›
          </button>
        ) : null}
      </div>

      {count > 1 ? (
        <div className="hero-pager" data-testid="hero-pager">
          <button
            type="button"
            className="hero-step"
            aria-label="Previous insight"
            data-testid="hero-prev"
            onClick={() => go(active - 1)}
          >
            ‹
          </button>
          <span className="hero-dots" role="tablist" aria-label="Live insights">
            {insights.map((candidate, i) => (
              <button
                key={candidate.key}
                type="button"
                role="tab"
                className={i === active ? 'hero-dot hero-dot-on' : 'hero-dot'}
                aria-selected={i === active}
                aria-label={`Insight ${i + 1} of ${count}: ${candidate.headline}`}
                data-testid="hero-dot"
                onClick={() => go(i)}
              />
            ))}
          </span>
          <button
            type="button"
            className="hero-step"
            aria-label="Next insight"
            data-testid="hero-next"
            onClick={() => go(active + 1)}
          >
            ›
          </button>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ player rows */

/**
 * One lineup slot, both sides of it, on one line.
 *
 * The centre pill is the fixed point: it never moves, whatever the names either
 * side of it are, which is what lets a reader scan straight down the column of
 * positions. Everything else is given the space that is left, and the names
 * truncate rather than wrap — a row that grows to two lines costs a player off
 * the bottom of the screen, and §16 is explicit that fitting the lineup is the
 * point.
 */
export function SlotRow({
  slot,
  mine,
  theirs,
  onOpen,
  openable,
}: {
  slot: string;
  mine: MatchupPlayerView | null;
  theirs: MatchupPlayerView | null;
  onOpen: (player: MatchupPlayerView) => void;
  /** Whether this player has a card to open. See {@link HeroCarousel}. */
  openable: (playerId: string) => boolean;
}) {
  return (
    <div className="matchup-row" data-testid="matchup-row" data-slot={slot}>
      <PlayerHalf player={mine} side="mine" onOpen={onOpen} openable={openable} />
      <span className={`slot-pill slot-pill-${slot.toLowerCase().replace(/[^a-z]/g, '')}`} data-testid="slot-pill">
        {slot}
      </span>
      <PlayerHalf player={theirs} side="theirs" onOpen={onOpen} openable={openable} />
    </div>
  );
}

function PlayerHalf({
  player,
  side,
  onOpen,
  openable,
}: {
  player: MatchupPlayerView | null;
  side: 'mine' | 'theirs';
  onOpen: (player: MatchupPlayerView) => void;
  openable: (playerId: string) => boolean;
}) {
  if (!player) {
    return (
      <div className="matchup-half" data-side={side} data-empty="true">
        <span className="matchup-name faint">Empty</span>
      </div>
    );
  }

  const name = (
    <span className="matchup-name-block">
      <span className="matchup-name" title={player.fullName}>
        {player.name}
      </span>
      <LiveMark player={player} />
    </span>
  );

  const score = (
    <span className="matchup-points">
      <span className="matchup-actual" data-testid="matchup-player-actual">
        {player.actual.toFixed(1)}
      </span>
      <span className="matchup-player-proj" data-testid="matchup-player-proj">
        {player.projectedFinal == null ? '—' : player.projectedFinal.toFixed(1)}
      </span>
    </span>
  );

  const body = (
    <>
      {side === 'mine' ? (
        <>
          <TeamLogo team={player.team} />
          {name}
          {score}
        </>
      ) : (
        <>
          {score}
          {name}
          <TeamLogo team={player.team} />
        </>
      )}
    </>
  );

  const label = `${player.fullName}, ${player.actual.toFixed(1)} points${
    player.projectedFinal == null ? '' : `, projected ${player.projectedFinal.toFixed(1)}`
  }${player.statusFlag ? `, ${STATUS_WORD[player.statusFlag] ?? player.statusFlag}` : ''}`;

  /*
   * A row the engine could not score is a row, not a control.
   *
   * It still shows everything Sleeper knows about him — his points are real —
   * and it does not pretend to lead anywhere, because there is no card behind
   * it. Rendering it as a button that opens nothing is how a screen teaches
   * somebody that its taps are unreliable.
   */
  if (!openable(player.playerId)) {
    return (
      <div
        className="matchup-half"
        data-side={side}
        data-testid="matchup-player"
        data-player-id={player.playerId}
        data-phase={player.phase}
        data-openable="false"
        aria-label={label}
      >
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      className="matchup-half"
      data-side={side}
      data-testid="matchup-player"
      data-player-id={player.playerId}
      data-phase={player.phase}
      data-openable="true"
      aria-label={label}
      onClick={() => onOpen(player)}
    >
      {body}
    </button>
  );
}

/** What a status mark means, spelled out for anything reading it aloud. */
const STATUS_WORD: Record<string, string> = {
  Q: 'questionable',
  D: 'doubtful',
  OUT: 'out',
};

/**
 * Live, not started, finished — and the injury mark when it is material.
 *
 * A dot with a word behind it. §20 asks for subtlety, and subtlety on a screen
 * that somebody has to read at arm's length means a two-pixel dot plus a real
 * accessible name, not a dot on its own.
 */
function LiveMark({ player }: { player: MatchupPlayerView }) {
  if (player.statusFlag) {
    return (
      <span
        className={`matchup-status matchup-status-${player.statusFlag.toLowerCase()}`}
        data-testid="matchup-status"
        title={STATUS_WORD[player.statusFlag] ?? player.statusFlag}
        aria-label={STATUS_WORD[player.statusFlag] ?? player.statusFlag}
      >
        {player.statusFlag}
      </span>
    );
  }
  if (player.phase === 'live') {
    return (
      <span className="matchup-live-dot" data-testid="matchup-live-dot" aria-label="playing now" title="playing now" />
    );
  }
  // Finished and not-yet-started both render nothing. A mark on every row is a
  // mark that means nothing.
  return null;
}

/* ------------------------------------------------------------------ bench */

/**
 * Both benches, collapsed.
 *
 * Closed by default and closed on arrival every time, which is deliberate: the
 * bench is hindsight, and hindsight belongs behind a tap. Expanded, it is the
 * same left-against-right shape as the starters — the two lists are the same
 * kind of thing and a second layout for the second one would be a second thing
 * to learn.
 */
export function BenchSection({
  mine,
  theirs,
  onOpen,
  openable,
}: {
  mine: MatchupPlayerView[];
  theirs: MatchupPlayerView[];
  onOpen: (player: MatchupPlayerView) => void;
  openable: (playerId: string) => boolean;
}) {
  const [open, setOpen] = useState(false);
  const rows = Math.max(mine.length, theirs.length);
  if (rows === 0) return null;

  return (
    <div className="matchup-bench" data-testid="matchup-bench" data-open={open ? 'true' : 'false'}>
      <button
        type="button"
        className="matchup-bench-toggle"
        data-testid="bench-toggle"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <span>Bench ({mine.length})</span>
        <span className="matchup-bench-chevron" aria-hidden="true">
          {open ? '▴' : '▾'}
        </span>
      </button>
      {open ? (
        <div data-testid="bench-rows">
          {Array.from({ length: rows }, (_, i) => (
            <SlotRow
              key={i}
              slot={mine[i]?.position ?? theirs[i]?.position ?? 'BN'}
              mine={mine[i] ?? null}
              theirs={theirs[i] ?? null}
              onOpen={onOpen}
              openable={openable}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- status */

/** `LIVE` / `FINAL` / `Sunday` — the state of the whole matchup, quietly. */
export function MatchupStatus({ phase }: { phase: MatchupForecast['phase'] }) {
  if (phase === 'final') {
    return (
      <span className="matchup-state matchup-state-final" data-testid="matchup-state">
        FINAL
      </span>
    );
  }
  if (phase === 'live') {
    return (
      <span className="matchup-state matchup-state-live" data-testid="matchup-state">
        <span className="matchup-live-dot" aria-hidden="true" /> LIVE
      </span>
    );
  }
  return (
    <span className="matchup-state" data-testid="matchup-state">
      Scheduled
    </span>
  );
}

/** A small labelled block used inside the odds detail sheet. */
export function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="matchup-detail-row">
      <span className="matchup-detail-label">{label}</span>
      <span className="matchup-detail-value">{children}</span>
    </div>
  );
}
