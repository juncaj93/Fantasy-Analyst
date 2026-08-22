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

import { useState, type ReactNode } from 'react';
import type { HeroInsight, MatchupForecast, MatchupPlayerView, MatchupTeamView } from '../api.ts';
import { TeamLogo } from './common.tsx';
import { ChevronIcon } from './icons.tsx';

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
          {...(onExplain ? { onExplain } : {})}
        />
      )}
    </div>
  );
}

function TeamColumn({ team, align, final }: { team: MatchupTeamView; align: 'start' | 'end'; final: boolean }) {
  return (
    <div className="matchup-team" data-align={align} data-testid={`matchup-team-${team.side}`}>
      {/*
        Whose column this is, as a chip over the number rather than a heading
        beside it.

        The name used to be pinned to the card's outer edge while the score sat
        at the inner one, which put a label and the thing it labels a couple of
        centimetres apart with nothing between them — two names hard against the
        outside of the card and two numbers meeting in the middle, so neither
        pair read as belonging to the other. It is a label, so it goes over what
        it labels, and it takes the quietest treatment that still reads as one:
        a small tinted capsule, no border, no colour of its own.

        It never widens the column. `min-width: 0` in the stylesheet keeps a
        joke of a team name from contributing to the column's width — it
        truncates against the score instead, which is the one thing on this card
        that may not move.
      */}
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
/**
 * The odds, as a bar and two percentages — and no words about confidence.
 *
 * A line reading `medium confidence · two kickoffs unknown` used to sit under
 * this bar. It is a real qualification and it has not been deleted: it is a row
 * in the sheet this bar opens, which is where a reader who wants to know how
 * much to trust a number goes. What it was doing *here* was spending the most
 * valuable strip on the page — the one directly above the lineup — on a
 * sentence about the forecast rather than on the forecast, and pushing the
 * starters the reader came for further down a phone.
 *
 * The bar says it is tappable and the sheet behind it says the rest.
 */
function WinBar({
  mine,
  mineName,
  theirsName,
  onExplain,
}: {
  mine: number;
  mineName: string;
  theirsName: string;
  onExplain?: () => void;
}) {
  const minePct = Math.round(mine * 100);
  const theirsPct = 100 - minePct;
  const label = `${mineName} ${minePct}% to win, ${theirsName} ${theirsPct}%`;

  /*
    The two percentages on one line and the bar on the next, rather than the
    bar between them.

    Flanking the bar put `44%` and `56%` at the outer edges of the card, which
    is the width of a phone apart — two halves of one comparison as far from
    each other as the layout allows, and the bar squeezed into what was left.
    Meeting in the middle is how the pair reads as a pair, and it gives the bar
    the full width of the card, which is what makes a few points of difference
    visible at all. The word `win` is said once, between them, because it was
    the same word twice.
  */
  const content = (
    <>
      <span className="matchup-win-values">
        <span className="matchup-win-value" data-testid="matchup-win-mine">
          {minePct}%
        </span>
        <span className="matchup-win-word">win</span>
        <span className="matchup-win-value matchup-win-value-end" data-testid="matchup-win-theirs">
          {theirsPct}%
        </span>
      </span>
      <span
        className="matchup-win-track"
        role="meter"
        aria-valuenow={minePct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
        data-testid="matchup-win-bar"
        /*
          Which way it is going, from our side's number and no other input.

          The bar was one accent blue whether the afternoon was being won or
          lost, which made it a picture of a percentage rather than a reading of
          it — the same object, the same colour, at 68% and at 16%. Green ahead,
          red behind, and neither at exactly even, because a colour that means
          "winning" has to have something it does not mean.

          Read from `minePct` rather than from the raw probability so the colour
          and the printed number can never disagree: 50.4% rounds to `50%` on
          screen, and a bar that was green beside a number saying even would be
          the card contradicting itself in the two millimetres between them.

          The colour is an accelerator and never the carrier. Both percentages
          are printed above it, the `role="meter"` carries the value, and the
          accessible name says it in words — see §38. This is the fourth way of
          saying the same thing, for the reader who takes it in before reading
          anything.
        */
        data-tone={minePct > 50 ? 'ahead' : minePct < 50 ? 'behind' : 'even'}
      >
        <span className="matchup-win-fill" style={{ width: `${minePct}%` }} />
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
    </>
  );
}

/* ------------------------------------------------------------ live insight */

/**
 * Every live insight, as a list — and never on the matchup screen itself.
 *
 * This started as a carousel above the lineup: it advanced itself on a
 * seven-second timer, carried two arrows and a row of dots, and spent a whole
 * line on chrome that said nothing about the matchup. A pass cut it down to a
 * single tappable row reading `Live insights · 2`, which was better and still
 * cost a row of the one screen whose whole purpose is fitting a starting
 * lineup onto a phone.
 *
 * The lock is explicit that no Live Insights card or button appears on the main
 * matchup page, and equally explicit that the feature and its data may stay.
 * Both hold here: the entry point is gone and the insights are a section of the
 * sheet behind the win probability, which is where a reader who wants to know
 * what is moving their odds already goes. Nothing was deleted and nothing is
 * behind a gesture — each row still leads to its own player.
 */
export function InsightList({
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
  if (insights.length === 0) return null;

  return (
    <>
      <div className="detail-label" style={{ marginTop: 12 }}>
        {insights.length === 1 ? 'Live insight' : 'Live insights'}
      </div>
      <div className="dense-group" role="list" aria-label="Live insights">
        {insights.map((candidate) => {
          const canOpen = candidate.playerId != null && openable(candidate.playerId);
          const body = (
            /*
              Wrapped, because the row is a flex container and two bare spans
              inside one become two columns rather than two lines.
            */
            <span className="insight-row-body">
              <span className="insight-row-headline">{candidate.headline}</span>
              {candidate.detail ? <span className="insight-row-detail">{candidate.detail}</span> : null}
            </span>
          );
          return (
            <div role="listitem" key={candidate.key}>
              {canOpen ? (
                <button
                  type="button"
                  className="insight-row"
                  data-testid="insight-row"
                  data-kind={candidate.kind}
                  onClick={() => onOpenPlayer(candidate.playerId!)}
                >
                  {body}
                  <span className="dense-chevron" aria-hidden="true">
                    <ChevronIcon />
                  </span>
                </button>
              ) : (
                <div className="insight-row insight-row-static" data-testid="insight-row" data-kind={candidate.kind}>
                  {body}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
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
