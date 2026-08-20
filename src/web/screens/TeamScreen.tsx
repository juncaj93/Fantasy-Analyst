/**
 * Team: who to start this week, who is on the bench, and whether anybody
 * unrostered would be better.
 *
 * The screen answers one question at a glance — **who does Fantasy Analyst
 * currently recommend starting?** — and it answers it in the same visual
 * language the rest of the app uses for a position: a recommended starter keeps
 * the position tint on its card, a backup sits underneath on the ordinary
 * surface. The colour is an accelerator; every card also says the word, because
 * a tint that is the only cue is not a cue for everybody.
 *
 * There is no lineup-editing control anywhere here, and there is no add, drop or
 * claim either. The app never changes a fantasy lineup and never transacts —
 * every one of these is a sentence the user acts on in Sleeper, by hand.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  type LeagueSummary,
  type LineupRecommendation,
  type LineupSlot,
  type RosterPlayer,
  type StartSitComparison,
  type StartSitEvaluation,
  type StartSitMode,
  type StartSitRefreshReport,
  type FaabAdvice,
  type WaiverAdvice,
} from '../api.ts';
import { MODE_DESCRIPTION, MODE_LABEL, START_SIT_MODES } from '../../core/startsit/mode.ts';
import {
  Badge,
  Confidence,
  Empty,
  formatAge,
  InjuryTag,
  Notice,
  PositionBadge,
  Unknown,
  positionCardClass,
} from '../components/common.tsx';
import { NavBar, PullToRefresh, SearchField, SegmentedControl, Sheet, SkeletonRows } from '../components/native.tsx';
import { WeeklyCardSheet } from '../components/weekly.tsx';
import { WaiverDetailSheet, WaiverRow } from '../components/waivers.tsx';
import { FLX_FILTER, offersFlexFilter, orderPositions, slotAccepts } from '../../core/sleeper/eligibility.ts';
/*
 * `1.04` during the draft, `#8` afterwards — one rule, shared with the player
 * detail and Trades so the three cannot disagree about which round pick 40 was.
 */
import { rosterRowLabel } from '../../core/draft/provenance.ts';
import { buildRosterShape, startablePositions } from '../../core/sleeper/scoring.ts';
import { buildWeeklyCard, type WeeklyContext } from '../../core/startsit/weekCard.ts';
import { buildWaiverBoard, type WaiverBoard, type WaiverBoardRow } from '../../core/waivers/board.ts';

interface OpenSlot {
  slot: string;
  count: number;
  accepts: string[];
}

interface RosterResponse {
  league: { id: string; name: string; scoringLabel: string; notes: string[] };
  starters: RosterPlayer[];
  bench: RosterPlayer[];
  /** True while the draft is running: `drafted` is the current truth, not `starters`. */
  live: boolean;
  drafted: (RosterPlayer & { pickNo: number | null })[];
  counts: Record<string, number>;
  filled: number;
  remaining: number;
  openStarters: OpenSlot[];
  picksMade: number;
  found: boolean;
}

/** How many players may be compared at once. Matched by the server. */
const MAX_COMPARE = 4;

/**
 * How deep the comparison picker's list goes.
 *
 * The search itself reaches the whole player universe — the server searches
 * every name and only then cuts to this — so the number is about *browsing*:
 * how far somebody who has typed nothing can scroll before the list ends. Forty
 * was the draft board's old cap and it ended silently, looking exactly like the
 * end of the player pool rather than the end of a page.
 */
const PICKER_ROWS = 100;

const ALL_FILTER = 'ALL';

export function TeamScreen({
  leagues,
  onLeaguesChanged,
}: {
  leagues: LeagueSummary[];
  onLeaguesChanged: () => void;
}) {
  const selected = leagues.find((l) => l.isSelected) ?? null;
  const [roster, setRoster] = useState<RosterResponse | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error' | 'warn'; text: string } | null>(null);
  const [lineup, setLineup] = useState<LineupRecommendation | null>(null);
  const [waivers, setWaivers] = useState<WaiverAdvice | null>(null);
  /*
   * Which question the lineup is answering.
   *
   * Component state rather than a stored preference: it is a question asked
   * now, it recomputes in one request, and a remembered mode would mean the
   * screen quietly answering something other than what the control shows on the
   * next visit. Changing it reloads the lineup immediately — see `loadLineup`.
   */
  const [mode, setMode] = useState<StartSitMode>('balanced');
  /** What the last all-source refresh did, per source. */
  const [refresh, setRefresh] = useState<StartSitRefreshReport | null>(null);
  /** Open with the slot it was launched from, and whoever it was launched on. */
  const [compare, setCompare] = useState<{ slot: string | null; seed: string[] } | null>(null);
  /** Which of your players the weekly card is open on. */
  const [weekly, setWeekly] = useState<{ playerId: string; context: WeeklyContext } | null>(null);
  /** Which waiver row's detail is open. */
  const [waiverDetail, setWaiverDetail] = useState<WaiverBoardRow | null>(null);

  const loadRoster = useCallback(async () => {
    if (!selected) return;
    try {
      setRoster(await api.get<RosterResponse>(`/api/leagues/${selected.id}/roster`));
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  }, [selected]);

  const loadLineup = useCallback(async () => {
    if (!selected) return;
    try {
      setLineup(await api.get<LineupRecommendation>(`/api/leagues/${selected.id}/lineup?mode=${mode}`));
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  }, [selected, mode]);

  /*
   * The free-agent scan arrives on its own, after the roster.
   *
   * It is the only part of this screen that has to look outside the roster, and
   * it must never be the reason the roster is slow to appear — so it is a
   * separate request whose failure costs the waiver card and nothing else.
   */
  const loadWaivers = useCallback(async () => {
    if (!selected) return;
    try {
      setWaivers(await api.get<WaiverAdvice>(`/api/leagues/${selected.id}/waivers`));
    } catch {
      setWaivers(null);
    }
  }, [selected]);

  useEffect(() => {
    void loadRoster();
    void loadLineup();
    void loadWaivers();
  }, [loadRoster, loadLineup, loadWaivers]);

  /**
   * What a pull down the screen does.
   *
   * One request to the existing all-source refresh — the same orchestrator the
   * "Refresh data" button used to call, with the same dedupe, the same budget
   * refusal and the same per-source report — and then the three reads this
   * screen is drawn from. It also subsumes the old bar control: syncing the
   * league from Sleeper is the refresh's first source, so there is no longer a
   * reason for two separate ways to ask.
   *
   * Concurrency is the gesture's problem and it is already solved: the hook is
   * single-flight, so a second pull while this is running moves nothing and
   * requests nothing.
   */
  const refreshAll = useCallback(async () => {
    setMessage(null);
    try {
      const report = await api.post<StartSitRefreshReport>('/api/startsit/refresh', {});
      setRefresh(report);
      onLeaguesChanged();
      // Recompute against whatever actually landed. A refresh that updates the
      // sources and leaves the screen showing the old answer is worse than none.
      await Promise.all([loadRoster(), loadLineup(), loadWaivers()]);
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  }, [loadRoster, loadLineup, loadWaivers, onLeaguesChanged]);

  /** Every player on the roster, however Sleeper currently has them arranged. */
  const byId = useMemo(() => {
    const map = new Map<string, RosterPlayer>();
    for (const p of roster?.starters ?? []) map.set(p.playerId, p);
    for (const p of roster?.bench ?? []) map.set(p.playerId, p);
    return map;
  }, [roster]);

  const startingIds = useMemo(
    () => new Set((lineup?.slots ?? []).map((s) => s.playerId).filter((id): id is string => id != null)),
    [lineup],
  );

  /*
   * The bench, in the order the recommendation puts it.
   *
   * Best replacement first, then the players it could not score at all, then
   * anybody the lineup never saw. Never a cross-position ranking against the
   * starters: a backup quarterback above a starting flex answers no question.
   */
  const bench = useMemo(() => {
    if (!roster) return [];
    const order = [
      ...(lineup?.bench ?? []).map((e) => e.playerId),
      ...(lineup?.undecidable ?? []).map((e) => e.playerId),
    ];
    const ranked = order.map((id) => byId.get(id)).filter((p): p is RosterPlayer => p != null && !startingIds.has(p.playerId));
    const seen = new Set(ranked.map((p) => p.playerId));
    const rest = [...byId.values()].filter((p) => !seen.has(p.playerId) && !startingIds.has(p.playerId));
    return [...ranked, ...rest];
  }, [roster, lineup, byId, startingIds]);

  const hasRecommendation = Boolean(lineup?.found && (lineup?.slots.length ?? 0) > 0);

  /*
   * Every evaluation the lineup already computed, by player.
   *
   * The weekly card is built from these rather than from a request of its own:
   * the numbers arrived with the recommendation, they are the numbers the
   * recommendation was made from, and a card that fetched its own would be a
   * second opinion waiting to disagree with the row that opened it. It also
   * means the sheet opens instantly, which is most of why it is worth having.
   */
  const evaluations = useMemo(() => {
    const map = new Map<string, StartSitEvaluation>();
    for (const e of [...(lineup?.starters ?? []), ...(lineup?.bench ?? []), ...(lineup?.undecidable ?? [])]) {
      map.set(e.playerId, e);
    }
    return map;
  }, [lineup]);

  /** The waiver advice, turned from slot-shaped comparisons into decisions. */
  const waiverBoard = useMemo(() => (waivers?.found ? buildWaiverBoard(waivers) : null), [waivers]);

  /**
   * What the folded bench is worth saying in four words.
   *
   * The optimiser has already answered this — a swap *is* a bench player who
   * would start — so the summary counts its swaps rather than forming a second
   * opinion about the same players. Silent when the lineup could not be
   * computed at all, because "No better option" would then be a claim nobody
   * checked.
   */
  const benchSummary = useMemo(() => {
    if (!lineup?.found) return null;
    const count = lineup.swaps.length;
    if (count === 0) return 'No better option';
    return `${count} strong alternative${count === 1 ? '' : 's'}`;
  }, [lineup]);

  const weeklyCard = useMemo(() => {
    if (!weekly) return null;
    const evaluation = evaluations.get(weekly.playerId);
    return evaluation ? buildWeeklyCard(evaluation, weekly.context) : null;
  }, [weekly, evaluations]);

  /**
   * Open one of your players.
   *
   * The concise weekly card when the engine has an evaluation for him, which is
   * every player it could score. When it could not — a player missing from the
   * dictionary, a roster spot the lineup never saw — the comparison sheet opens
   * instead, because a card built from nothing would be a card saying nothing.
   */
  const openPlayer = (playerId: string, context: WeeklyContext) => {
    if (evaluations.has(playerId)) setWeekly({ playerId, context });
    else setCompare({ slot: context.slot ?? null, seed: [playerId] });
  };

  return (
    /*
     * The whole screen is the refresh gesture's surface.
     *
     * Not the list, and not a strip at the top: the reader pulls the page they
     * are looking at, which is what every iPhone app does and is why nobody has
     * to be told about it. It is also why there is no longer a refresh control
     * anywhere on this screen — see the note on the navigation bar.
     */
    <PullToRefresh onRefresh={refreshAll} label="Team" testId="team-pull">
      {/*
        The league is the page's identity, so it is the page's title — and only
        the title.

        The bar used to carry the season, the team count and the scoring format
        under the name, and a row of badges under that repeating the flex count
        and the passing-TD rule. Every one of those is a fact about the league
        that the engine reads and the reader does not: they do not change what to
        do this week, they never changed between visits, and on a phone they cost
        two rows of the screen before the first player appeared. They are still
        exactly where they were in the data — Setup shows the league's settings,
        and every recommendation below is computed from them.
      */}
      {/*
        The league's name, and nothing else in the bar.

        There was a Refresh control on the trailing edge and a "Refresh data"
        button under it, which between them made three ways of asking the same
        question — and put the most-tapped control on a phone in the corner
        hardest for a thumb to reach. Both are gone: pulling the screen down
        refreshes it, which is the gesture the reader already knows and the one
        that costs no glass at all. See `PullToRefresh` below.
      */}
      {selected ? <NavBar testId="league-card" title={selected.name} /> : <NavBar title="Team" />}

      {message ? <Notice tone={message.tone === 'ok' ? 'ok' : message.tone === 'error' ? 'error' : 'warn'}>{message.text}</Notice> : null}

      {!selected ? (
        <Empty>No league chosen yet. Open Setup to connect Sleeper and pick your league.</Empty>
      ) : (
        <>
          {/*
            Four controls on one row of a phone.

            Three of them are the question being asked — same players, same
            evidence, a different definition of "best" — and they reuse the
            filter row the Draft board already uses, because it is a
            filter-shaped decision and a second control vocabulary for it would
            be a new thing to learn for no gain. The fourth opens the comparison
            over the page, because a comparison is a question asked *about* this
            roster and answered back to it.

            They share a row rather than taking two, which is worth an entire
            player card at 375px. `compact` gives up horizontal padding and a
            step of type size to do it and gives up no tap target at all — the
            chips are still 44px tall, and so is the button beside them.
          */}
          <div className="control-row" data-testid="team-controls">
            <SegmentedControl
              label="Recommendation mode"
              testId="mode-row"
              compact
              value={mode}
              onChange={setMode}
              segments={START_SIT_MODES.map((option) => ({
                id: option,
                label: MODE_LABEL[option],
                ariaLabel: `${MODE_LABEL[option]} — ${MODE_DESCRIPTION[option]}`,
                testId: `mode-${option}`,
              }))}
            />
            <button
              className="btn btn-compact"
              data-testid="compare-open"
              onClick={() => setCompare({ slot: null, seed: [] })}
            >
              Compare
            </button>
          </div>

          {refresh ? (
            <div className="faint" data-testid="refresh-status" style={{ margin: '0 4px 10px' }}>
              {refresh.headline}
              {refresh.sources.some((s) => s.outcome === 'unavailable' || s.outcome === 'blocked' || s.outcome === 'skipped')
                ? ` — ${refresh.sources
                    .filter((s) => s.outcome === 'unavailable' || s.outcome === 'blocked' || s.outcome === 'skipped')
                    .map((s) => `${s.source}: ${s.detail}`)
                    .join('; ')}`
                : ''}
            </div>
          ) : null}

          {!roster ? (
            <SkeletonRows rows={6} testId="roster-skeleton" />
          ) : !roster.found ? (
            <Empty>Your roster was not found in this league. Check the connected Sleeper user.</Empty>
          ) : (
            <>
              {/*
                During a draft the live view goes first, because that is the
                current truth. It is added to rather than swapped in: if Sleeper
                also has a settled lineup, hiding it would take away the
                start/sit comparison for no reason.
              */}
              {roster.live ? <LiveDraftRoster roster={roster} /> : null}

              {hasRecommendation ? (
                <>
                  <div className="section-title" data-testid="starters-title">
                    Recommended starters
                  </div>
                  {/*
                    One inset group, not eight floating cards.

                    The lineup is a set of slots read top to bottom, which is
                    exactly what an inset grouped list is for: one surface, the
                    slots divided by hairlines, and the rounding at the two ends
                    of the set rather than around each row. The recommended
                    starters keep their position tint inside it — see
                    `.starter-row.card-pos` — because eight slots is the one
                    place in the app where the tint is showing the shape of a
                    week rather than decorating a list.
                  */}
                  <div className="slot-group" data-testid="starters-group">
                  {lineup!.slots.map((slot, i) => (
                    <StarterCard
                      key={`${slot.slot}-${i}`}
                      slot={slot}
                      player={slot.playerId ? (byId.get(slot.playerId) ?? null) : null}
                      onOpen={() =>
                        slot.playerId
                          ? openPlayer(slot.playerId, {
                              starting: true,
                              slot: slot.slot,
                              alreadyStarting: slot.alreadyStarting,
                              locked: slot.locked,
                            })
                          : setCompare({ slot: slot.slot, seed: [] })
                      }
                    />
                  ))}
                  </div>
                </>
              ) : null}

              {/*
                Bench, then the changes, then the waiver wire.

                That order is the screen's whole argument: the starters answer
                "who do I start", the folded bench keeps the answer on one
                screen, and the card immediately under it is the only thing on
                the page asking to be *acted* on. The free-agent scan is a
                different question and goes last.
              */}
              <BenchSection
                players={bench}
                scoreOf={(playerId) => evaluations.get(playerId)?.score ?? null}
                summary={benchSummary}
                onOpen={(playerId) => openPlayer(playerId, { starting: false })}
              />

              {lineup?.found ? <LineupCard lineup={lineup} /> : null}

              {waiverBoard ? (
                <WaiverSection board={waiverBoard} faab={waivers?.faab ?? null} onOpen={setWaiverDetail} />
              ) : null}
            </>
          )}
        </>
      )}

      {/*
        The concise weekly card, and the way out of it.

        Compare is reachable from inside it rather than instead of it: the sheet
        answers "what about him this week" in one screen, and the reader who
        wants the whole breakdown says so. Opening the comparison closes this,
        because two stacked sheets is a place a phone user gets lost in.
      */}
      {weeklyCard ? (
        <WeeklyCardSheet
          card={weeklyCard}
          onClose={() => setWeekly(null)}
          onCompare={() => {
            const slot = weekly?.context.slot ?? null;
            const seed = [weeklyCard.playerId];
            setWeekly(null);
            setCompare({ slot, seed });
          }}
        />
      ) : null}

      {waiverDetail ? (
        <WaiverDetailSheet
          row={waiverDetail}
          onClose={() => setWaiverDetail(null)}
          onCompare={() => {
            const row = waiverDetail;
            setWaiverDetail(null);
            setCompare({ slot: row.fit.slot, seed: [row.playerId] });
          }}
        />
      ) : null}

      {compare && selected ? (
        <CompareSheet
          leagueId={selected.id}
          rosterPositions={selected.rosterPositions}
          slot={compare.slot}
          seed={compare.seed}
          nameOf={(id) => byId.get(id)?.name ?? id}
          onClose={() => setCompare(null)}
        />
      ) : null}
    </PullToRefresh>
  );
}

/**
 * One recommended starter, in the slot the league actually starts.
 *
 * The card keeps the position tint, which is what makes the recommended lineup
 * readable at arm's length. **The tint is never the only cue**: the slot is
 * printed on the card, the row is labelled as a starter for anything reading it
 * aloud, and an empty slot says so in words rather than by being a paler shade
 * of the same thing.
 */
function StarterCard({
  slot,
  player,
  onOpen,
}: {
  slot: LineupSlot;
  player: RosterPlayer | null;
  /** Tapping a player opens his week — see `openPlayer`. */
  onOpen: () => void;
}) {
  if (!slot.playerId || !slot.name) {
    return (
      <div className="player-row" data-testid="starter-row" data-slot={slot.slot} data-starter="empty">
        {/*
          One line, and quietly.

          This used to be two: "Nobody eligible to start here" at the weight and
          size of a player's name, with "Takes QB" on a second line under it. A
          roster that is four players deep in the middle of a draft has four or
          five of these, and at name weight they were the loudest thing on the
          screen — a list shouting about what it does not have, above the answer
          it does. What the slot takes is the same sentence continued, so it
          sits on the same line, and neither half is a name so neither is set
          like one.
        */}
        <div className="player-row-top">
          <span className="slot-label">{slot.slot}</span>
          <span className="empty-slot-line">
            Nobody eligible to start here <span className="faint">— takes {slot.accepts.join(', ')}</span>
          </span>
        </div>
      </div>
    );
  }

  const position = player?.position ?? slot.position ?? '';
  /*
   * The one line under the row, and usually there is none.
   *
   * A conflict is the only thing a collapsed card still says in a sentence,
   * because it is the only one that changes what the reader does with the card:
   * it says this call is close and the evidence disagrees with itself. The
   * drivers — *why* he is the pick — moved into the sheet the card opens, where
   * they sit beside the numbers they came from instead of costing a line on
   * every one of eight rows.
   */
  const consequence = (slot.conflicts ?? [])[0] ?? null;

  return (
    <button
      className={positionCardClass(position, 'starter-row')}
      data-testid="starter-row"
      data-slot={slot.slot}
      data-starter="true"
      data-position={position.toUpperCase()}
      data-player-id={slot.playerId}
      /*
       * The whole state of the row, in the accessible name.
       *
       * This is where "starter" survives now that the word has left the face of
       * the card: the section heading above says it once, the slot chip says
       * which spot, and anything reading the row aloud gets the sentence.
       */
      aria-label={
        `${slot.name}, recommended starter at ${slot.slot}` +
        `${slot.score == null ? '' : `, projected ${slot.score.toFixed(1)} points`}` +
        `${slot.locked ? ', locked' : ''}` +
        `${!slot.alreadyStarting && !slot.locked ? ', not in your Sleeper lineup' : ''}` +
        `${player?.status ? `, ${player.status}` : ''}`
      }
      onClick={onOpen}
    >
      <div className="player-row-top">
        <span className="slot-label">{slot.slot}</span>
        <span className="player-name">{slot.name}</span>
        {/*
          Only the tags that change what the reader does: the spot is settled,
          Sleeper does not agree yet, or he may not play. Everything else — the
          market, the role, the matchup, the props — is one tap away.
        */}
        <span className="row-tags">
          {slot.locked ? (
            <span className="tag tag-calm tag-mini" data-testid="locked-tag">
              Locked
            </span>
          ) : null}
          {!slot.alreadyStarting && !slot.locked ? (
            <span className="tag tag-warn tag-mini" data-testid="not-in-lineup-tag">
              Not in Sleeper
            </span>
          ) : null}
          <InjuryTag status={player?.status} />
        </span>
        {/*
          The projection carries its weight in type rather than in a label: it
          is the only number on the row, it is tabular so eight of them line up
          down the column, and the word "projected" is in the accessible name.
        */}
        <span className="proj" data-testid="starter-proj" title="Projected points">
          {slot.score == null ? '—' : slot.score.toFixed(1)}
        </span>
        <PositionBadge position={position} team={player?.team ?? ''} />
      </div>
      {consequence ? (
        <div className="player-row-consequence" data-testid="starter-conflict">
          {consequence}
        </div>
      ) : null}
    </button>
  );
}

/**
 * A backup: the same row, on the ordinary surface.
 *
 * No card tint, and that absence is the whole point — it is what makes the
 * tinted cards above read as an answer rather than as decoration. The position
 * badge stays, because "which position is this" is still a fact worth knowing
 * about a bench player.
 */
function BenchCard({ player, score, onOpen }: { player: RosterPlayer; score: number | null; onOpen: () => void }) {
  return (
    <button
      className="player-row bench-row"
      data-testid="bench-row"
      data-starter="false"
      data-position={(player.position ?? '').toUpperCase()}
      data-player-id={player.playerId}
      aria-label={`${player.name}, bench${score == null ? '' : `, projected ${score.toFixed(1)} points`}`}
      onClick={onOpen}
    >
      <div className="player-row-top">
        <span className="slot-label">BN</span>
        <span className="player-name">{player.name}</span>
        <span className="row-tags">
          <InjuryTag status={player.status} />
        </span>
        <span className="proj" title="Projected points">
          {score == null ? '—' : score.toFixed(1)}
        </span>
        <PositionBadge position={player.position} team={player.team} />
      </div>
    </button>
  );
}

/**
 * The bench, folded away.
 *
 * The screen's job is to answer *who do I start* before anything else, and on a
 * 360px phone the bench was pushing the last recommended starters — and the
 * changes card, which is the thing to act on — below the fold. So it is a
 * chevron: the count is on it, the one useful summary is beside it, and the
 * players are one tap away.
 *
 * The control is deliberately the same one the Matchup screen uses, down to the
 * test ids: two screens with a foldaway bench should not be two interactions to
 * learn. And the rows are not rendered while it is closed, so a collapsed bench
 * costs the layout nothing rather than merely hiding it.
 */
function BenchSection({
  players,
  scoreOf,
  summary,
  onOpen,
}: {
  players: RosterPlayer[];
  scoreOf: (playerId: string) => number | null;
  /** `1 strong alternative` / `No better option`, or nothing worth saying. */
  summary: string | null;
  onOpen: (playerId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (players.length === 0) return null;

  return (
    <div className="bench" data-testid="team-bench" data-open={open ? 'true' : 'false'}>
      <button
        type="button"
        className="bench-toggle"
        data-testid="bench-toggle"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <span className="bench-label">Bench ({players.length})</span>
        {summary ? <span className="bench-summary">{summary}</span> : null}
        <span className="bench-chevron" aria-hidden="true">
          {open ? '▴' : '▾'}
        </span>
      </button>
      {open ? (
        <div data-testid="bench-rows">
          {players.map((p) => (
            <BenchCard key={p.playerId} player={p} score={scoreOf(p.playerId)} onOpen={() => onOpen(p.playerId)} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Whether anybody unrostered would actually be an improvement.
 *
 * Quiet by default: the interesting case is usually that there is nothing to
 * do, and a section that shouts about three marginal adds every week is one the
 * reader stops looking at.
 *
 * What it shows when there *is* something is one row per player rather than a
 * paragraph per slot. The old card printed the slot, the current player, his
 * score, the best available, his position, his team, his score, his gain, every
 * reason he was picked, a Compare button and a sentence listing the runners-up
 * — five lines and a control for each of up to three slots, on the screen where
 * the roster is supposed to be. The row below carries the same decision in
 * three lines, and everything that was cut is a tap away in the detail sheet.
 *
 * Nothing here executes anything — "available" means available in Sleeper, and
 * the add is made there.
 */
function WaiverSection({
  board,
  faab,
  onOpen,
}: {
  board: WaiverBoard;
  /** The league's wallet, which belongs under the rows rather than on one. */
  faab: FaabAdvice | null;
  onOpen: (row: WaiverBoardRow) => void;
}) {
  if (board.rows.length === 0) {
    return (
      <div className="card card-tight" data-testid="waiver-card">
        <div className="faint" data-testid="waiver-verdict">
          {board.headline ?? 'No waiver comparison available yet.'}
        </div>
      </div>
    );
  }

  return (
    <div data-testid="waiver-card">
      <div className="section-title" data-testid="waiver-title">
        Waiver upgrades
      </div>
      {board.rows.slice(0, TEAM_WAIVER_ROWS).map((row) => (
        <WaiverRow key={row.playerId} row={row} onOpen={() => onOpen(row)} />
      ))}
      {/*
        The wallet the prices above were quoted from. It belongs to the league
        rather than to any one row, so it sits under them once — see the note on
        `BudgetFooter`, which is the league-intelligence pass's own component and
        is used here unchanged.
      */}
      <BudgetFooter faab={faab} />
      <div className="faint" style={{ margin: '2px 4px 12px' }}>
        {board.considered} available players checked. Advisory only — add, drop or bid in Sleeper. This app
        never makes a transaction.
        {board.pending.length > 0 ? ` ${capitalise(board.pending.join(', '))} is not known yet.` : ''}
      </div>
    </div>
  );
}

/**
 * How many waiver rows the Team screen shows before it stops.
 *
 * Team is a roster screen with a waiver section, not a waiver screen: three is
 * enough to answer "is there anything I should be doing", and the whole board —
 * every position, every filter — is one tab away. The cut is stated in the line
 * under the rows rather than left as a silent truncation.
 */
const TEAM_WAIVER_ROWS = 3;

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The budget the advice above was priced against, said out loud.
 *
 * A recommendation of $19 means nothing without the wallet it came from, and
 * the two numbers that make it legible — what is left, and what winning has
 * cost in this league — are exactly the two a reader would otherwise have to go
 * to Sleeper to find.
 */
function BudgetFooter({ faab }: { faab: FaabAdvice | null }) {
  if (!faab) return null;
  if (!faab.rule.usesFaab) {
    return (
      <div className="faint" style={{ marginTop: 6 }} data-testid="faab-budget">
        {faab.rule.provenance}.
      </div>
    );
  }
  const mine = faab.mine;
  return (
    <div className="faint" style={{ marginTop: 6 }} data-testid="faab-budget">
      {mine?.remaining == null
        ? 'Your remaining budget is unknown.'
        : `$${mine.remaining} of $${faab.rule.total} left.`}
      {faab.prices.sample > 0
        ? ` Winning bids here have run $${faab.prices.low}–${faab.prices.high} across ${faab.prices.sample}.`
        : ' No winning bids recorded in this league yet.'}
      <div>{faab.losingBids}</div>
    </div>
  );
}

/**
 * Pick two to four players and rank them for one lineup spot.
 *
 * The pool is the whole player universe, not the roster: "start my tight end or
 * the one on waivers" is an ordinary question, and a picker that could only see
 * players you already own could not ask it. Who is *addable* is the waiver
 * card's business; this ranks whoever is chosen.
 *
 * Everything below the picker comes from the same start/sit engine the lineup
 * above was built with — there is exactly one scoring formula in this app.
 */
function CompareSheet({
  leagueId,
  rosterPositions,
  slot,
  seed,
  nameOf,
  onClose,
}: {
  leagueId: string;
  rosterPositions: string[];
  /** The slot this was launched from, or null when launched from the header. */
  slot: string | null;
  seed: string[];
  nameOf: (id: string) => string;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState(() => {
    // Launched from a slot that takes exactly one position, the picker starts
    // narrowed to it; from a flex slot, to the flex view. Both are a starting
    // point the reader can change, never a restriction.
    if (!slot) return ALL_FILTER;
    const accepts = slotAccepts(slot);
    if (accepts.length === 1) return accepts[0]!;
    return FLX_FILTER;
  });
  const [ids, setIds] = useState<string[]>(() => [...new Set(seed)].slice(0, MAX_COMPARE));
  const [names, setNames] = useState<Record<string, string>>(() =>
    Object.fromEntries(seed.map((id) => [id, nameOf(id)])),
  );
  const [results, setResults] = useState<PickerPlayer[]>([]);
  const [loading, setLoading] = useState(false);
  const [comparison, setComparison] = useState<StartSitComparison | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const segments = useMemo(() => {
    const startable = startablePositions(buildRosterShape(rosterPositions));
    if (startable.size === 0) return [ALL_FILTER];
    // FLX last, as everywhere else: a view over three positions, after them.
    return [ALL_FILTER, ...orderPositions(startable), ...(offersFlexFilter(startable) ? [FLX_FILTER] : [])];
  }, [rosterPositions]);

  useEffect(() => {
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      setLoading(true);
      try {
        const filter = position === ALL_FILTER ? '' : `&position=${encodeURIComponent(position)}`;
        const res = await api.get<{ players: PickerPlayer[] }>(
          `/api/players?q=${encodeURIComponent(query)}&leagueId=${encodeURIComponent(leagueId)}${filter}&limit=${PICKER_ROWS}`,
        );
        if (!cancelled) setResults(res.players);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [query, position, leagueId]);

  /**
   * Add or remove one player.
   *
   * A player already chosen is removed, which is the only way a tap on a
   * selected row can be read. A fifth is refused out loud rather than silently
   * dropping the first — quietly rewriting the selection is how a reader ends up
   * comparing three players they did not choose.
   */
  const toggle = (player: PickerPlayer) => {
    setComparison(null);
    setError(null);
    setIds((current) => {
      if (current.includes(player.id)) return current.filter((id) => id !== player.id);
      if (current.length >= MAX_COMPARE) {
        setError(`Up to ${MAX_COMPARE} players at once. Remove one to add another.`);
        return current;
      }
      setNames((n) => ({ ...n, [player.id]: player.name }));
      return [...current, player.id];
    });
  };

  const compare = async () => {
    setBusy(true);
    setError(null);
    try {
      setComparison(
        await api.post<StartSitComparison>('/api/startsit/compare', {
          leagueId,
          playerIds: ids,
          slot,
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title={slot ? `Compare for ${slot}` : 'Compare players'} onClose={onClose} testId="compare-sheet">
      <div className="faint" style={{ margin: '0 2px 8px' }} data-testid="compare-hint">
        Choose 2–{MAX_COMPARE} players. Anyone in the league is fair game — your roster, the bench, or the
        free-agent pool.
      </div>

      {ids.length > 0 ? (
        <div className="tag-row" data-testid="compare-selection">
          {ids.map((id) => (
            <button
              key={id}
              type="button"
              className="tag tag-calm chip-removable"
              data-testid="compare-chosen"
              data-player-id={id}
              aria-label={`Remove ${names[id] ?? id} from the comparison`}
              onClick={() => {
                setComparison(null);
                setError(null);
                setIds((current) => current.filter((x) => x !== id));
              }}
            >
              {names[id] ?? id} ✕
            </button>
          ))}
        </div>
      ) : null}

      <div style={{ margin: '8px 0' }}>
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Search players"
          label="Search players to compare"
          testId="compare-search"
        />
      </div>

      <SegmentedControl
        label="Filter by position"
        value={position}
        onChange={setPosition}
        segments={segments.map((p) => ({
          id: p,
          label: p,
          ...(p === FLX_FILTER
            ? { ariaLabel: 'Flex-eligible players: running backs, receivers and tight ends', testId: 'flx-filter' }
            : {}),
        }))}
      />

      {error ? <Notice tone="warn">{error}</Notice> : null}

      <div className="btn-row" style={{ margin: '8px 2px' }}>
        <button
          className="btn btn-primary"
          data-testid="compare-run"
          disabled={ids.length < 2 || busy}
          onClick={() => void compare()}
        >
          {busy ? 'Comparing…' : `Compare ${ids.length} player${ids.length === 1 ? '' : 's'}`}
        </button>
      </div>

      {comparison ? <ComparisonCard comparison={comparison} /> : null}

      {loading && results.length === 0 ? (
        <SkeletonRows rows={5} testId="compare-skeleton" />
      ) : results.length === 0 ? (
        <Empty>Nobody matching that search.</Empty>
      ) : (
        <div role="list" aria-label="Players to compare">
          {results.map((p) => {
            const chosen = ids.includes(p.id);
            return (
              <button
                key={p.id}
                className={chosen ? 'player-row player-row-open' : 'player-row'}
                data-testid="compare-candidate"
                data-player-id={p.id}
                data-chosen={chosen ? 'true' : 'false'}
                aria-pressed={chosen}
                onClick={() => toggle(p)}
              >
                <div className="player-row-top">
                  <span className="rank">{chosen ? '✓' : ''}</span>
                  <span className="player-name">{p.name}</span>
                  <PositionBadge position={p.position} team={p.team} />
                </div>
                <div className="player-row-metrics">
                  <span className="metric">{availabilityLabel(p.availability)}</span>
                  {p.status ? <Badge tone="warn">{p.status}</Badge> : null}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </Sheet>
  );
}

interface PickerPlayer {
  id: string;
  name: string;
  position: string;
  team: string;
  status: string | null;
  /** Absent when the response predates league-aware availability. */
  availability?: 'mine' | 'rostered' | 'available';
}

function availabilityLabel(availability: PickerPlayer['availability']): string {
  if (availability === 'mine') return 'Your roster';
  if (availability === 'rostered') return 'Rostered elsewhere';
  if (availability === 'available') return 'Free agent';
  return '';
}

/**
 * Whole-roster start/sit, as a difference from what Sleeper currently has set.
 *
 * The recommended lineup itself is drawn above as cards; this is the part that
 * asks something of the reader — which slots differ, and by how much. Nothing
 * here can alter a lineup: Sleeper is still where a change is made.
 */
function LineupCard({ lineup }: { lineup: LineupRecommendation }) {
  const gain =
    lineup.currentPoints == null ? null : Math.round((lineup.recommendedPoints - lineup.currentPoints) * 10) / 10;

  /*
   * The change worth making, and everything else.
   *
   * The optimiser already sorts its swaps biggest-gain-first, so "the best one"
   * is the first one rather than a new judgement made here.
   */
  const [best = null, ...rest] = lineup.swaps;
  const risks = lineup.lateSwapRisks ?? [];
  const material = risks.filter((r) => r.starting);
  const quiet = risks.filter((r) => !r.starting);

  return (
    <div className="card" data-testid="lineup-card">
      <div className="header-row">
        <strong>Changes to consider</strong>
        <Confidence level={lineup.confidence} />
      </div>

      {best == null ? (
        <div className="faint" data-testid="lineup-verdict">
          {lineup.currentPoints == null
            ? 'No changes to suggest from what is known so far.'
            : 'Your lineup already matches the recommendation.'}
        </div>
      ) : (
        <>
          {/*
            The best change, and only the best change.

            Three suggestions stacked on a phone is a list to work through; the
            biggest one is a thing to do. The others have not gone anywhere —
            they are named under it and spelled out in the disclosure — but the
            card's first line is now a single action with a number on it.
          */}
          <div className="swap" data-testid="lineup-swap">
            <div>
              <strong>Start {best.inName}</strong> over {best.outName} <span className="faint">({best.slot})</span>
            </div>
            <div className="faint">
              +{best.gain} pts · {best.reason}
            </div>
          </div>
          {rest.length > 0 ? (
            <div className="faint" data-testid="lineup-verdict">
              {rest.length} smaller change{rest.length === 1 ? '' : 's'} below
              {gain != null && gain > 0 ? ` · ${gain} pts in total` : ''}
            </div>
          ) : null}
          <div className="faint" style={{ margin: '4px 2px 0' }}>
            Make changes in Sleeper — this app never edits a lineup.
          </div>
        </>
      )}

      {/*
        The one risk that is worth a line above the fold, and no others.

        A late-swap risk on somebody *starting* is a Sunday-morning problem the
        reader has to plan for. The same risk on a bench player is a fact about
        a player they are not starting, and the warnings beside it are usually
        about missing data — both are true, neither changes what to do first, so
        both wait inside the disclosure.
      */}
      {material.map((risk) => (
        <div className="hint hint-caution" key={risk.playerId} data-testid="late-swap-risk">
          {risk.name} — {risk.detail}
        </div>
      ))}

      <details className="disclosure">
        <summary>Recommended lineup in full</summary>

        {rest.length > 0 ? (
          <div data-testid="lineup-rest">
            {rest.map((s) => (
              <div className="swap" key={`${s.inPlayerId}-${s.outPlayerId}`} data-testid="lineup-swap-more">
                <div>
                  <strong>Start {s.inName}</strong> over {s.outName} <span className="faint">({s.slot})</span>
                </div>
                <div className="faint">
                  +{s.gain} pts · {s.reason}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {lineup.warnings.map((w) => (
          <div className="hint hint-caution" key={w}>
            {w}
          </div>
        ))}
        {quiet.map((risk) => (
          <div className="hint hint-caution" key={risk.playerId} data-testid="late-swap-risk-quiet">
            {risk.name} — {risk.detail}
          </div>
        ))}

        <table className="compact">
          <thead>
            <tr>
              <th>Slot</th>
              <th>Player</th>
              <th>Score</th>
            </tr>
          </thead>
          <tbody>
            {lineup.slots.map((s, i) => (
              <tr key={`${s.slot}-${i}`}>
                <td>{s.slot}</td>
                <td>
                  {s.name ?? <Unknown what="nobody eligible" />}
                  {/* A locked slot is settled, so it never carries a change arrow. */}
                  {s.locked ? <span className="tag tag-calm" data-testid="locked-tag"> 🔒 Locked</span> : null}
                  {s.name && !s.alreadyStarting && !s.locked ? ' ←' : ''}
                </td>
                <td>{s.score == null ? <Unknown what="score" /> : s.score.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {lineup.bench.length > 0 ? (
          <div className="faint" style={{ marginTop: 6 }}>
            Bench: {lineup.bench.map((e) => `${e.name} (${e.score?.toFixed(1) ?? '—'})`).join(', ')}
          </div>
        ) : null}
        {lineup.undecidable.length > 0 ? (
          <div className="faint" style={{ marginTop: 6 }}>
            Not enough data to rank: {lineup.undecidable.map((e) => e.name).join(', ')}
          </div>
        ) : null}
        {lineup.notes.map((n) => (
          <div className="faint" key={n}>
            {n}
          </div>
        ))}
      </details>
    </div>
  );
}

function ComparisonCard({ comparison }: { comparison: StartSitComparison }) {
  const winner = comparison.evaluations.find((e) => e.playerId === comparison.recommendedPlayerId);
  /*
   * A comparison with no legal shared slot is reported, never forced.
   *
   * The numbers underneath are still honest — they are the same per-player
   * evaluation as everywhere else — but "Start X" over a set of players who
   * cannot occupy the same spot would be answering a question nobody asked.
   */
  const comparable = comparison.slot?.comparable ?? true;
  const ranked = [...comparison.evaluations].sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));

  return (
    <div className="card" data-testid="comparison">
      {/*
        The recommendation, first and loudest.

        A start/sit screen is one question with one answer, and everything under
        it is why. The answer used to be a line of bold text among six other
        lines of bold text; it is now the only thing on the card that looks like
        a conclusion. Nothing about how it is reached has changed.
      */}
      <div className={winner && comparable ? 'verdict verdict-take' : 'verdict verdict-calm'}>
        <div className="verdict-label" data-testid="comparison-verdict">
          {!comparable
            ? 'Not the same lineup decision'
            : winner
              ? `Start ${winner.name}`
              : 'No recommendation'}
        </div>
        <div className="verdict-detail">
          <Confidence level={comparison.confidence} /> · Vegas data{' '}
          {comparison.dataFreshness.provider ?? 'none'} · {formatAge(comparison.dataFreshness.fetchedAt)}
        </div>
      </div>

      {comparison.slot ? (
        <div className={comparable ? 'faint' : 'hint hint-caution'} data-testid="comparison-slot">
          {comparison.slot.detail}
        </div>
      ) : null}

      {/*
        The order, said plainly. The brief asks for a ranking rather than only a
        winner, and with four players a table alone buries it.
      */}
      {comparable && ranked.length > 0 ? (
        <ol className="reason-list" data-testid="comparison-order" style={{ margin: '8px 0' }}>
          {/* The list numbers itself; printing the position again reads "2. 2." */}
          {ranked.map((e, i) => (
            <li key={e.playerId}>
              {i === 0 ? <strong>Start: {e.name}</strong> : e.name}
              {e.score == null ? ' — not enough data to rank' : ` — ${e.score.toFixed(1)}`}
            </li>
          ))}
        </ol>
      ) : null}

      {/*
        Compact tags for the two things a projection cannot express: whether
        kickoff timing is a problem, and whether the market has moved since the
        last look. The numbers behind them are in the reasons and warnings
        below rather than repeated here.
      */}
      <div className="tag-row">
        {comparison.lateSwap && comparison.lateSwap.verdict !== 'no_risk' && comparison.lateSwap.verdict !== 'unknown' ? (
          <span
            className={comparison.lateSwap.verdict === 'consider_early_option' ? 'tag tag-urgent' : 'tag tag-calm'}
            title={comparison.lateSwap.detail}
            data-testid="late-swap-tag"
          >
            ⏱ {comparison.lateSwap.label}
          </span>
        ) : null}
        {comparison.evaluations
          .filter((e) => e.movement?.headline)
          .map((e) => (
            <span
              key={`move-${e.playerId}`}
              className={e.movement.direction === 'up' ? 'tag tag-star' : 'tag tag-warn'}
              title={e.movement.significant.map((m) => m.display).join('; ')}
              data-testid="movement-tag"
            >
              {e.movement.direction === 'up' ? '↑' : '↓'} {e.name}: {e.movement.headline}
            </span>
          ))}
        {comparison.evaluations
          .filter((e) => e.lock?.locked)
          .map((e) => (
            <span key={`lock-${e.playerId}`} className="tag tag-calm" data-testid="locked-tag">
              🔒 {e.name} locked
            </span>
          ))}
      </div>

      {/*
        Availability, per player, in the terms a lineup decision is made in.
        `Q · hamstring · limited → full` is the whole difference between two
        players who are both "Questionable", and it is where the injury report
        earns its place. Nothing shows for anybody healthy.
      */}
      {comparison.evaluations
        .filter((e) => e.statusFlag)
        .map((e) => (
          <div className="injury-line" key={`inj-${e.playerId}`} data-testid="startsit-injury">
            {e.name}: {e.statusFlag}
            {e.injury?.conflictNote ? <span className="faint"> — sources disagree ({e.injury.conflictNote})</span> : null}
          </div>
        ))}

      {comparison.warnings.map((w) => (
        <div className="hint hint-caution" key={w}>
          {w}
        </div>
      ))}

      {comparison.reasons.length > 0 ? (
        <ul className="reason-list" style={{ margin: '8px 0' }}>
          {comparison.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}

      <table className="compact">
        <thead>
          <tr>
            <th>Player</th>
            <th>Vegas</th>
            <th>Score</th>
            <th>Coverage</th>
          </tr>
        </thead>
        <tbody>
          {comparison.evaluations.map((e) => (
            <tr key={e.playerId}>
              <td>
                {comparable && e.playerId === comparison.recommendedPlayerId ? '★ ' : ''}
                {e.name}
              </td>
              <td>{e.expectation.points == null ? <Unknown what="Vegas expectation" /> : e.expectation.points.toFixed(1)}</td>
              <td>{e.score == null ? <Unknown what="score" /> : e.score.toFixed(1)}</td>
              <td>{Math.round(e.expectation.coverage * 100)}%</td>
            </tr>
          ))}
        </tbody>
      </table>

      {comparison.evaluations.map((e) => (
        <details className="disclosure" key={e.playerId}>
          <summary>{e.name} breakdown</summary>
          <div className="components">
            {e.components.map((c) => (
              <div className="component" key={c.key}>
                <span className="component-label">
                  {c.label}
                  {c.unknown ? ' (unknown)' : ''}
                </span>
                <span className="component-value">{c.value.toFixed(2)}</span>
                <span className="component-detail">{c.display}</span>
              </div>
            ))}
          </div>
          {e.expectation.contributions.length > 0 ? (
            <div className="components">
              {e.expectation.contributions.map((c) => (
                <div className="component" key={c.market}>
                  <span className="component-label">{c.market}</span>
                  <span className="component-value">{c.points.toFixed(2)}</span>
                  <span className="component-detail">{c.detail}</span>
                </div>
              ))}
            </div>
          ) : null}
          {e.expectation.notes.map((n) => (
            <div className="faint" key={n}>
              {n}
            </div>
          ))}
        </details>
      ))}
    </div>
  );
}


/**
 * The roster during an active draft.
 *
 * Deliberately not a starters/bench split: mid-draft nobody has decided who
 * starts, and showing a lineup would invent that decision. Players held,
 * grouped by position, plus the requirements still open.
 */
function LiveDraftRoster({
  roster,
}: {
  roster: {
    /** `draftPick` is `pickNo` said as `1.04`; both travel so neither is re-derived. */
    drafted: (RosterPlayer & { pickNo: number | null; draftPick?: string | null })[];
    counts: Record<string, number>;
    filled: number;
    remaining: number;
    openStarters: OpenSlot[];
    picksMade: number;
    /** Seats in the draft, so a client can format a pick it was handed raw. */
    teams?: number;
  };
}) {
  /*
   * QB, RB, WR, TE, then the flex positions, then defence.
   *
   * This was `Object.keys(...).sort()`, which is alphabetical — so a roster
   * opened with DEF above QB, and QB above RB, in an order no fantasy site has
   * ever used. `orderPositions` is the same helper the draft board's chips and
   * the Players filter already go through, so all three now read in one order
   * and cannot drift apart again. Anything unexpected is kept and put last
   * rather than dropped.
   */
  const positions = orderPositions(Object.keys(roster.counts));
  return (
    <>
      {/*
        Live, but quietly so: a dot and a word, not a coloured banner. What is
        still missing is the sentence worth reading here, so it gets the type.
      */}
      <div className="card card-tight" data-testid="live-draft-card">
        <div className="header-row">
          <span className="live-dot">Live draft</span>
          <span className="faint">
            {roster.picksMade} {roster.picksMade === 1 ? 'pick' : 'picks'} · {roster.filled} filled ·{' '}
            {roster.remaining} left
          </span>
        </div>
        {roster.openStarters.length > 0 ? (
          <div className="muted" style={{ marginTop: 4 }}>
            Still need:{' '}
            <strong>
              {roster.openStarters.map((o) => `${o.count > 1 ? `${o.count} ` : ''}${o.slot}`).join(', ')}
            </strong>
          </div>
        ) : (
          <div className="muted" style={{ marginTop: 4 }}>
            Every starting slot is covered.
          </div>
        )}
      </div>

      {/*
        One card per position group holding one line per player, rather than one
        card per player. Same information, roughly three times as many players
        on a phone screen.
      */}
      {roster.drafted.length === 0 ? (
        <Empty>Nothing drafted yet. Your picks appear here as you make them.</Empty>
      ) : (
        positions.map((position) => (
          <div key={position}>
            <div className="section-title">
              {position} ({roster.counts[position]})
            </div>
            <div className="list-card">
              {roster.drafted
                .filter((p) => (p.position || 'UNKNOWN') === position)
                .map((p) => (
                  <div key={p.playerId} className="roster-line" data-testid="drafted-line">
                    <span className="player-name">{p.name}</span>
                    <PositionBadge position={p.position} team={p.team} />
                    {/*
                      `1.04` while the draft runs, `#8` once it is over.

                      `#40` — the overall pick number — was neither. Nobody
                      thinks in overall pick numbers, and read as a jersey it is
                      a number no player wears. Which of the two is wanted is
                      decided by whether the draft is live rather than by the
                      date, and the pick is not lost when it stops being the
                      headline: it moves into the player's detail. See
                      core/draft/provenance.ts.
                    */}
                    <span
                      className="pick-no"
                      data-testid="roster-row-label"
                      title={
                        p.draftPick
                          ? `Drafted ${p.draftPick}`
                          : p.pickNo
                            ? `Pick ${p.pickNo}`
                            : 'On the roster, with no draft pick behind him'
                      }
                    >
                      {/*
                        `drafting: true` because this component only renders
                        while the draft is live — see `live` on the roster
                        response, which is what chooses between this view and
                        the starters/bench one. The flag is passed explicitly
                        rather than assumed inside the helper so the same helper
                        can answer for the post-draft view too.
                      */}
                      {p.draftPick ??
                        rosterRowLabel({
                          drafting: true,
                          pickNo: p.pickNo,
                          jerseyNumber: p.jerseyNumber,
                          teams: roster.teams ?? 12,
                        })}
                    </span>
                  </div>
                ))}
            </div>
          </div>
        ))
      )}
    </>
  );
}
