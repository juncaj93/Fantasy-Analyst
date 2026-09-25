/**
 * Team: who to start this week, who is on the bench, and whether anybody
 * unrostered would be better.
 *
 * The screen answers one question before any other — **is there anything I
 * should change?** — and it answers it in the first card, above the roster.
 * Under that answer is the roster it was made from, which answers the second:
 * **who does Fantasy Analyst currently recommend starting?** That one is an
 * inset grouped list — white rows on one surface, divided by hairlines, with
 * the position carried by the slot chip on the leading edge rather than by a
 * wash across the row. The tint belongs to the draft board alone, so that a tinted row anywhere
 * in this app means "you are on Draft"; here the colour is in the chip, and the
 * chip also says the word, because a colour that is the only cue is not a cue
 * for everybody.
 *
 * During a draft the screen drops the questions that do not exist yet. Balanced,
 * Floor and Ceiling are three definitions of the best lineup and Compare asks
 * which of two players to start — neither means anything while half the roster
 * is still unpicked, so both wait for the draft to end.
 *
 * There is no lineup-editing control anywhere here, and there is no add, drop or
 * claim either. The app never changes a fantasy lineup and never transacts —
 * every one of these is a sentence the user acts on in Sleeper, by hand.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type LeagueSummary,
  type LineupRecommendation,
  type RosterPlayer,
  type StartSitComparison,
  type StartSitEvaluation,
  type SlotFixture,
  type StartSitRefreshReport,
  type WaiverAdvice,
} from '../api.ts';
import {
  Badge,
  Confidence,
  Empty,
  formatAge,
  InjuryTag,
  Notice,
  PlayerIdentity,
  PositionBadge,
  TeamLogo,
  positionAccentClass,
} from '../components/common.tsx';
import { NavBar, PullToRefresh, SearchField, SegmentedControl, Sheet, SkeletonRows } from '../components/native.tsx';
import {
  AlertCircleIcon,
  CheckIcon,
  CompareIcon,
  DisclosureChevronIcon,
  RefreshIcon,
  StarIcon,
  SwapIcon,
} from '../components/icons.tsx';
import { barWidths, explainGap, layoutFactors, shortName } from '../compareLayout.ts';
import { WeeklyCardSheet } from '../components/weekly.tsx';
import { WaiverDetailSheet, WaiverRow } from '../components/waivers.tsx';
import { FLX_FILTER, orderFilterChips, orderPositions, slotAccepts } from '../../core/sleeper/eligibility.ts';
/*
 * `1.04` during the draft, `#8` afterwards — one rule, shared with the player
 * detail and Trades so the three cannot disagree about which round pick 40 was.
 */
import { rosterRowLabel } from '../../core/draft/provenance.ts';
import { buildRosterShape, startablePositions } from '../../core/sleeper/rosterShape.ts';
import { buildWeeklyCard, type WeeklyContext } from '../../core/startsit/weekCard.ts';
import { buildLineupVerdicts, verdictSubjectId, type LineupVerdictRow } from '../../core/startsit/sleeperLineup.ts';
import { marketLabel } from '../../core/vegas/marketLabel.ts';
import { DstLine } from '../components/dst.tsx';
import { Estimated } from '../components/estimate.tsx';
import type { DstPlan } from '../../core/dst/planner.ts';
import { buildWaiverBoard, type WaiverBoard, type WaiverBoardRow } from '../../core/waivers/board.ts';
import { unwindOne } from '../tabReset.ts';

interface OpenSlot {
  slot: string;
  count: number;
  accepts: string[];
}

interface RosterResponse {
  league: { id: string; name: string; scoringLabel: string; notes: string[] };
  /**
   * The league's starting slots in Sleeper's own order, and who is in each.
   *
   * `starters` below is the same lineup as a set and is what the older parts of
   * this screen read. These two are what let the lineup be drawn as slots with
   * a verdict on each — the order the reader sees in Sleeper, and the player
   * he has in each one.
   *
   * `starterSlotIds` is absent on a roster synced before migration 0039, which
   * is read as "the order is not known" rather than as an empty lineup: the
   * same starters are then placed by eligibility. Both are optional so an older
   * server degrades to the set-based view instead of drawing a blank lineup.
   */
  rosterPositions?: string[];
  starterSlotIds?: (string | null)[];
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
  /** One line of draft advice, derived server-side from roster need. */
  bestMove?: { text: string; positions: string[]; kind: string } | null;
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
  resetNonce,
}: {
  leagues: LeagueSummary[];
  onLeaguesChanged: () => void;
  /** Bumped when Team is tapped while already on Team — see `App`. */
  resetNonce: number;
}) {
  const selected = leagues.find((l) => l.isSelected) ?? null;
  const [roster, setRoster] = useState<RosterResponse | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error' | 'warn'; text: string } | null>(null);
  const [lineup, setLineup] = useState<LineupRecommendation | null>(null);
  const [waivers, setWaivers] = useState<WaiverAdvice | null>(null);
  /** What the last all-source refresh did, per source. */
  const [refresh, setRefresh] = useState<StartSitRefreshReport | null>(null);
  /**
   * Whether a refresh is in flight, so the button can say so.
   *
   * The pull gesture has the rubber band to show its work; a button has
   * nothing, and a control that looks identical while a two-second round trip
   * happens is one a reader presses again.
   */
  const [refreshing, setRefreshing] = useState(false);
  /** Open with the slot it was launched from, and whoever it was launched on. */
  const [compare, setCompare] = useState<{ slot: string | null; seed: string[] } | null>(null);
  /** Which of your players the weekly card is open on. */
  const [weekly, setWeekly] = useState<{ playerId: string; context: WeeklyContext } | null>(null);
  /** Which waiver row's detail is open. */
  const [waiverDetail, setWaiverDetail] = useState<WaiverBoardRow | null>(null);

  /*
   * Tapping Team while already on Team.
   *
   * Everything closed is a sheet or a panel this screen opened over itself —
   * the comparison, a player's week, a waiver row's detail. None of it is a
   * decision the reader made about their roster, so unwinding it costs them
   * nothing and gets them back to the lineup, which is what the tab is for.
   */
  useEffect(() => {
    if (resetNonce === 0) return;
    unwindOne([
      { when: compare != null, undo: () => setCompare(null) },
      { when: weekly != null, undo: () => setWeekly(null) },
      { when: waiverDetail != null, undo: () => setWaiverDetail(null) },
      { when: message != null, undo: () => setMessage(null) },
    ]);
  }, [resetNonce]);

  const loadRoster = useCallback(async () => {
    if (!selected) return;
    try {
      setRoster(await api.get<RosterResponse>(`/api/leagues/${selected.id}/roster`, { onFresh: setRoster }));
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  }, [selected]);

  /**
   * The lineup, under whichever posture the week actually calls for.
   *
   * There is no `mode` in this request any more. The screen used to send
   * whichever of Balanced, Floor and Ceiling the reader had tapped, along with
   * a ref to guard against an older mode's answer landing on top of a newer
   * one — machinery that existed entirely to keep a control and a response in
   * step. The server resolves the posture itself now, from the week's margin
   * and the live scoreline, and reports back which one it chose and why; see
   * `LineupRecommendation.mode` and `core/startsit/modeSuggest.ts`.
   */
  const loadLineup = useCallback(async () => {
    if (!selected) return;
    try {
      setLineup(await api.get<LineupRecommendation>(`/api/leagues/${selected.id}/lineup`, { onFresh: setLineup }));
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  }, [selected]);

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
      setWaivers(await api.get<WaiverAdvice>(`/api/leagues/${selected.id}/waivers`, { onFresh: setWaivers }));
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

  /**
   * The same refresh, from a control rather than from a gesture.
   *
   * It wraps `refreshAll` rather than repeating it: one refresh on this screen,
   * one scope, one report line under the row. All this adds is the in-flight
   * flag, which the pull does not need because the rubber band already says it.
   */
  const runRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refreshAll();
    } finally {
      setRefreshing(false);
    }
  }, [refreshAll, refreshing]);

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
   * The lineup as slots, against the one Sleeper actually holds.
   *
   * This is the screen's spine now. It is derived rather than fetched — both
   * halves already arrived, one on the roster and one on the recommendation —
   * so it cannot disagree with either, and it costs a request from neither.
   */
  const verdicts = useMemo<LineupVerdictRow[]>(() => {
    if (!roster || !lineup?.slots?.length) return [];
    return buildLineupVerdicts({
      rosterPositions: roster.rosterPositions ?? [],
      starterIds: (roster.starters ?? []).map((p) => p.playerId),
      ...(roster.starterSlotIds ? { starterSlotIds: roster.starterSlotIds } : {}),
      slots: lineup.slots,
      /*
       * The changes the optimiser would actually stand behind, and only those.
       * Without this the rows would propose swaps the card above them declines
       * to make — one screen answering to two rules.
       *
       * Passed as pairs rather than as incoming ids: the rows need to know who
       * each change is *instead of*, or `→ Start X instead` prints on whichever
       * row the slot ordering put it beside.
       */
      suggestedSwaps: lineup.swaps ?? [],
      positionOf: (id) => byId.get(id)?.position ?? null,
    });
  }, [roster, lineup, byId]);

  /*
   * The bench: who Sleeper is not starting.
   *
   * "Not in the *recommended* lineup" is what this used to mean, and it stopped
   * being right when the list above became Sleeper's lineup rather than this
   * app's. A player Sleeper starts appears in a slot row up there — as the man
   * to keep, or the man a swap would replace — and listing him here as well put
   * him in two places at once, in one case saying keep him above and showing
   * him benched below.
   *
   * So the two lists now split on the same fact the reader's own app splits on:
   * a slot row holds whoever Sleeper has in that slot, and the bench holds
   * everybody else. A player the app wants *started* stays here, because here
   * is where he actually is — the row above names him in its verdict line, and
   * the two together say "he is on your bench, and he should not be". Claiming
   * him for the lineup would leave the bench describing a roster the reader
   * does not have.
   *
   * Order is unchanged: best replacement first, then the ones that could not be
   * scored, then anybody the lineup never saw.
   */
  const bench = useMemo(() => {
    if (!roster) return [];
    const inSleeperLineup = new Set(
      verdicts.map((r) => r.currentPlayerId).filter((id): id is string => id != null),
    );
    /* Before the lineup exists there are no rows, so fall back to the app's own. */
    const spokenFor = inSleeperLineup.size > 0 ? inSleeperLineup : startingIds;
    const order = [
      ...(lineup?.bench ?? []).map((e) => e.playerId),
      ...(lineup?.undecidable ?? []).map((e) => e.playerId),
    ];
    const ranked = order.map((id) => byId.get(id)).filter((p): p is RosterPlayer => p != null && !spokenFor.has(p.playerId));
    const seen = new Set(ranked.map((p) => p.playerId));
    const rest = [...byId.values()].filter((p) => !seen.has(p.playerId) && !spokenFor.has(p.playerId));
    return [...ranked, ...rest];
  }, [roster, lineup, byId, startingIds, verdicts]);


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
    const count = lineup.swaps.length + (lineup.fills?.length ?? 0);
    if (count === 0) return 'No better option';
    return `${count} strong alternative${count === 1 ? '' : 's'}`;
  }, [lineup]);

  const weeklyCard = useMemo(() => {
    if (!weekly) return null;
    const evaluation = evaluations.get(weekly.playerId);
    /*
     * The sheet is handed the same published figure the row was.
     *
     * The card recomputes the projection from the evaluation rather than reading
     * the row's answer, which is right — one function owns the word — but it
     * means the fallback has to reach it too, or a row showing 20.9 would open a
     * sheet showing nothing. The server already told us which of the two this
     * number is, so where it said `sleeper` we hand the number straight back as
     * the published figure; `weeklyProjection` still prefers a market over it
     * and would ignore it if one existed.
     */
    const published = evaluation?.projectionSource === 'sleeper' ? (evaluation.projection ?? null) : null;
    return evaluation ? buildWeeklyCard(evaluation, { ...weekly.context, published }) : null;
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
    <PullToRefresh onRefresh={refreshAll} label="Team" testId="team-pull" live={lineup?.gameWindow?.live ?? false}>
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
      {/*
        The league's name, and the two controls, on one bar.

        They were a row of their own underneath, pushed to the trailing edge
        with nothing on the left of them — which is what a control row looks
        like when the thing that used to fill it has gone: the risk chips were
        removed and the buttons kept the row they had shared. Reported as
        floating with empty space beside them, and that is exactly what it was.

        The bar already has a trailing slot, used by Setup, Players, Draft and
        Review for the same purpose, so this is the app's existing arrangement
        rather than a new one — and it gives the roster back a whole row.

        Neither control exists during a draft. Compare asks which of two players
        to start and Refresh re-reads a week; neither question exists while the
        roster is still being assembled. The flag is the roster's own `live`,
        the same one that decides whether the live view is drawn at all.
      */}
      {selected ? (
        <NavBar
          testId="league-card"
          title={selected.name}
          trailing={
            roster?.live ? null : (
              <span className="nav-actions-group" data-testid="team-controls">
                <button
                  className="btn btn-icon"
                  data-testid="compare-open"
                  aria-label="Compare players"
                  title="Compare players"
                  onClick={() => setCompare({ slot: null, seed: [] })}
                >
                  <CompareIcon />
                </button>
                {/*
                  The same refresh the pull gesture runs, and deliberately so.

                  `refreshAll` posts to the all-source orchestrator — the one
                  Data Health's "Refresh now" calls — and then re-reads the
                  roster, the lineup and the waiver scan. It is single-flight,
                  so a tap while a pull is already running costs nothing. It
                  exists beside the gesture because a gesture is
                  undiscoverable, and this is the screen a reader comes back to
                  when he thinks something has changed.
                */}
                <button
                  className="btn btn-icon"
                  data-testid="team-refresh"
                  aria-label="Refresh roster and this week's data"
                  title="Refresh"
                  disabled={refreshing}
                  onClick={() => void runRefresh()}
                >
                  <RefreshIcon className={refreshing ? 'spin' : undefined} />
                </button>
              </span>
            )
          }
        />
      ) : (
        <NavBar title="Team" />
      )}

      {message ? <Notice tone={message.tone === 'ok' ? 'ok' : message.tone === 'error' ? 'error' : 'warn'}>{message.text}</Notice> : null}

      {!selected ? (
        <Empty>No league chosen yet. Open Setup to connect Sleeper and pick your league.</Empty>
      ) : (
        <>
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

              {/*
                What to change, before the inventory it is about.

                This card used to sit under the bench, three sections down: the
                screen opened with eight recommended starters, folded a bench
                under them, and only then said whether any of it needed
                touching. That is the wrong way round for the one question this
                tab exists to answer — *what should I change?* — because it
                makes the reader scan a roster they already own before learning
                whether there is anything to do with it. On a 390pt phone the
                answer was below the fold on every visit.

                So the answer comes first and the roster follows as its
                evidence. Nothing about the answer itself has moved: it is the
                same `LineupCard`, reading the same `lineup` the starters below
                are drawn from, with the same swap, the same threshold and the
                same disclosure. This is an ordering change and only an
                ordering change.

                It is also deliberately the *only* thing up here. The defence
                line and the waiver teaser are recommendations too, and both
                stay below the roster where they were: a screen with three
                cards of equal weight at the top has no primary
                recommendation at all.
              */}
              {!roster.live && lineup?.found ? <LineupCard lineup={lineup} /> : null}

              {hasRecommendation && !roster.live ? (
                <>
                  {/*
                    "Your lineup", because that is whose it is.
                    
                    It used to read `Recommended starters`, which named a list
                    this app had made up rather than the one the reader owns.
                    The rows below are his own Sleeper lineup, slot by slot, in
                    Sleeper's order, annotated — so the heading names the thing
                    on the screen and the annotations are the opinion.
                  */}
                  <div className="section-title" data-testid="starters-title">
                    Your lineup
                    <span className="faint section-title-note">{lineupSummary(verdicts)}</span>
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
                  {verdicts.map((row, i) => (
                    <VerdictCard
                      key={`${row.slot}-${i}`}
                      row={row}
                      current={row.currentPlayerId ? (byId.get(row.currentPlayerId) ?? null) : null}
                      recommended={row.recommendedPlayerId ? (byId.get(row.recommendedPlayerId) ?? null) : null}
                      currentProjection={{
                        points: row.currentPlayerId ? (evaluations.get(row.currentPlayerId)?.projection ?? null) : null,
                        source: row.currentPlayerId
                          ? (evaluations.get(row.currentPlayerId)?.projectionSource ?? null)
                          : null,
                      }}
                      /*
                       * The fixture of whoever leads the row, looked up the
                       * same way the projection beside it is, so the chip and
                       * the number are always about the same man.
                       */
                      fixture={(() => {
                        const id = verdictSubjectId(row);
                        return id ? (evaluations.get(id)?.fixture ?? null) : null;
                      })()}
                      /*
                       * A swap opens the comparison, seeded with both men.
                       *
                       * That is the decision the row is actually about, and the
                       * tool for it already exists — sending the reader to one
                       * player's card would make them go and find the other.
                       */
                      onOpen={() => {
                        if (row.verdict === 'swap' && row.currentPlayerId && row.recommendedPlayerId) {
                          setCompare({ slot: row.slot, seed: [row.currentPlayerId, row.recommendedPlayerId] });
                          return;
                        }
                        /*
                         * The card belongs to whoever the row is *about*, which
                         * is not always who this app would start there — see
                         * `verdictSubjectId`, which both this and the row's own
                         * headline are now drawn from. Reading the two ids in
                         * the opposite order here is what opened Kenneth
                         * Walker's card from Ladd McConkey's row.
                         */
                        const subject = verdictSubjectId(row);
                        if (subject) {
                          openPlayer(subject, {
                            starting: true,
                            slot: row.slot,
                            alreadyStarting: subject === row.currentPlayerId,
                            locked: row.locked,
                          });
                          return;
                        }
                        setCompare({ slot: row.slot, seed: [] });
                      }}
                    />
                  ))}
                  </div>
                </>
              ) : null}

              {/*
                Then the bench, then the wire.

                The order above this is the screen's whole argument now: the
                changes card says whether anything needs doing, the starters
                say what the recommendation actually is, the folded bench keeps
                the rest of the roster on one screen, and the free-agent scan —
                a different question about players you do not own — goes last.
              */}
              {/*
                Nothing about a week, while the week has not been reached.

                A draft has no lineup and no bench: every player held is simply
                held, which is what the list above already says. What was drawn
                here mid-draft was a `Recommended starters` heading over eight
                `Nobody eligible yet` rows and a `Bench (0)` under it — a screen
                and a half of furniture answering a question nobody had asked,
                between the roster and the bottom of the page.

                The same flag governs all of it, so there is one answer on this
                screen to "is a draft happening" rather than four.
              */}
              {roster.live ? null : (
                <BenchSection
                  players={bench}
                  projectionOf={(playerId) => ({
                    points: evaluations.get(playerId)?.projection ?? null,
                    source: evaluations.get(playerId)?.projectionSource ?? null,
                  })}
                  fixtureOf={(playerId) => evaluations.get(playerId)?.fixture ?? null}
                  summary={benchSummary}
                  onOpen={(playerId) => openPlayer(playerId, { starting: false })}
                />
              )}

              {/*
                Neither of these exists yet while a draft is running.

                `Waiver upgrades` offers free agents to a manager whose next
                transaction is a draft pick, and the defence line is a slot
                decision for a week that has not started. Both were drawn
                through the whole draft, under the roster, answering questions
                nobody had yet; the same flag that hides the mode chips, Compare
                and the changes card above hides them, so there is one answer on
                this screen to "is a draft happening".
              */}
              {roster.live ? null : (
                <WaiverSection board={waiverBoard} dst={waivers?.dst ?? null} onOpen={setWaiverDetail} />
              )}
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
          ownedByMe={(id) => byId.has(id)}
          onClose={() => setCompare(null)}
        />
      ) : null}
    </PullToRefresh>
  );
}

/**
 * What the number on the trailing edge of a Team row is, in words.
 *
 * It is the same answer in every game state, which is the point of having one
 * function say it: Team draws a **projection** pregame, live and after the
 * final whistle, because it never reads Sleeper's running points at all — those
 * belong to Matchup, which takes them from `players_points`. A bare number in a
 * compact row cannot say which of the two it is, so the word travels with it in
 * the tooltip and in the row's accessible name.
 *
 * The unavailable case says so out loud rather than going quiet. `—` is legible
 * to somebody looking at the row; to somebody listening to it, an aria-label
 * that simply omits the number is a row that sounds like it has no opinion
 * instead of one that has said it does not know.
 *
 * ## And whose number it is
 *
 * Some of these are not this app's. Where no betting market has priced a player,
 * the value is Rotowire's published weekly projection by way of Sleeper — a
 * display-only fallback that no recommendation here is built on. Both functions
 * below therefore take the source and say it, because a borrowed number rendered
 * as though it were ours is the one failure the whole chain exists to prevent.
 *
 * On the face of the row the mark is deliberately quiet: a dotted underline
 * under the figure and nothing else, because eight rows each shouting a
 * provenance would drown the number they are about. The words are in the
 * tooltip, in the accessible name, in the sheet the row opens and in the note
 * above the list. See `core/startsit/projection.ts`.
 */
/*
 * `preseason` is in the union because the ladder has three tiers, not because
 * the lineup pass serves one. `assembleLineup` passes `weeklyProjection` a
 * published figure and no preseason total, deliberately: a lineup is a
 * recommendation this app makes, a borrowed weekly figure is already ranked at
 * a discount there, and an August season total flattened over sixteen games is
 * not a claim about Sunday that a *starting* decision should turn on. The
 * Compare sheet and the Matchup screen do serve it, and this row would draw it
 * correctly the day that changes rather than falling through to "from betting
 * markets", which is what an unhandled third case would have printed.
 */
type RowProjectionSource = 'market' | 'sleeper' | 'preseason' | null | undefined;

function projectionTitle(projection: number | null | undefined, source: RowProjectionSource): string {
  if (projection == null) return 'No projection yet — no betting market has priced him';
  if (source === 'sleeper') return "Projected points · Rotowire's published figure, via Sleeper";
  if (source === 'preseason') {
    return 'Projected points · a rough estimate — his preseason season total over a full season of games';
  }
  return 'Projected points · from betting markets';
}

function spokenProjection(projection: number | null | undefined, source: RowProjectionSource): string {
  if (projection == null) return ', projection unavailable';
  if (source === 'preseason') {
    return `, roughly ${projection.toFixed(1)} points, estimated from his preseason season projection`;
  }
  const whose = source === 'sleeper' ? ", Rotowire's published figure via Sleeper" : '';
  return `, projected ${projection.toFixed(1)} points${whose}`;
}

/**
 * What the nine rows add up to, in one clause beside the heading.
 *
 * The heading names a lineup; this says whether anything is wrong with it,
 * which is the question the reader opened the screen with. Silence would be
 * ambiguous — a screen showing nine quiet rows could equally mean "all good" or
 * "nothing was checked" — so the settled case says so out loud.
 */
function lineupSummary(rows: LineupVerdictRow[]): string {
  if (rows.length === 0) return '';
  const changes = rows.filter((r) => (r.verdict === 'swap' || r.verdict === 'fill') && !r.locked).length;
  if (changes > 0) return `${changes} change${changes === 1 ? '' : 's'} to make`;
  const unscored = rows.filter((r) => r.verdict === 'no_pick').length;
  if (unscored > 0) return `nothing to change${unscored === 1 ? ', one slot unscored' : `, ${unscored} slots unscored`}`;
  return 'nothing to change';
}

/**
 * One slot of the reader's own lineup, and what this app would do with it.
 *
 * The row that replaced `Recommended starters`. The difference is whose lineup
 * it draws: this one starts from what Sleeper holds and annotates it, so a slot
 * the app agrees with is still a row. That is deliberate and it is most of the
 * point — nine rows where five are quiet says "I looked at nine and five are
 * fine", and a screen that printed only the two problems would leave the reader
 * wondering what it had not examined.
 *
 * Left to right it is the same sentence every other list in this app opens
 * with — who, then what about him, then what he is worth — and the verdict
 * takes a second line only when it has two names to fit on it.
 */
function VerdictCard({
  row,
  current,
  recommended,
  currentProjection,
  fixture,
  onOpen,
}: {
  row: LineupVerdictRow;
  /** Who Sleeper has in the slot, hydrated. Null when Sleeper left it empty. */
  current: RosterPlayer | null;
  /** Who this app would start, hydrated. Null when it will not fill the slot. */
  recommended: RosterPlayer | null;
  /**
   * The incumbent's own projection and whose it is, for the rows he leads.
   *
   * One object rather than two props for the reason stated all over this
   * codebase: a row that could be handed a number without its provenance is a
   * row that could print Rotowire's model as this app's.
   */
  currentProjection: { points: number | null; source: RowProjectionSource };
  /** The row subject's fixture, resolved by the caller from the same map. */
  fixture: SlotFixture | null;
  onOpen: () => void;
}) {
  /*
   * Whose row it is.
   *
   * The incumbent on every verdict except `fill`, where there is no incumbent
   * and the recommendation is the only person in the story. A `swap` therefore
   * leads with the man currently starting — the reader is looking for his own
   * lineup, and finding a stranger's name in the slot is how a screen loses him
   * — and the change is stated underneath, in the order he would act on it.
   *
   * The rule itself is `verdictSubjectId`, shared with the tap handler that
   * opens this row, because a headline and a tap that each decided this for
   * themselves is precisely how the row came to open the wrong man's card.
   */
  const subjectId = verdictSubjectId(row);
  const subject = (subjectId != null && subjectId === recommended?.playerId ? recommended : current) ?? current ?? recommended;
  const position = subject?.position ?? '';
  /*
   * The row's own vacancy, and not simply the first one in the slot's list.
   *
   * `vacancy` describes every rostered player the slot could have used, best
   * candidate first, and on a one-player slot the first of them is the row's
   * subject. On a league with **two FLEX slots** it is not: both empty flexes
   * are handed the same list, ordered incumbent-first and then by name, so
   * both rows took the alphabetically-first player's reason and one of them
   * was about somebody else.
   *
   * Reproduced in `tests/lineup.vacancy.test.ts` on a two-FLEX roster holding
   * `Aaron Unpriced` (no figure at all) and `Zach Unpriced` (9.4 from
   * Rotowire): Zach's row drew 9.4 from his own evaluation and took Aaron's
   * `can't be scored this week` for its note, which is the 15 September report
   * reappearing through a second door after the first was shut in #271.
   *
   * So the row looks up the man it is actually about, and falls back to the
   * ordered first only where there is nobody to look up — the empty-slot
   * branch below, which is the case that ordering was written for.
   */
  const blocked = (subject ? row.vacancy.find((v) => v.playerId === subject.playerId) : null) ?? row.vacancy[0] ?? null;
  const borrowed = blocked?.publishedProjection ?? null;
  /* The figure belonging to whoever leads the row — see the trailing field. */
  const shown =
    row.verdict === 'fill'
      ? { points: row.projection, source: row.projectionSource }
      : currentProjection;

  /*
   * A row may not say there is no figure while a figure is on it.
   *
   * The rule #271 established, applied to the figure the row *draws* rather
   * than to one of the two tiers it could have come from. That fix keyed on
   * `borrowed` — Rotowire's number, carried on the vacancy — because that was
   * the tier in the report. But `.proj` above renders `shown.points`, which is
   * `weeklyProjection`'s answer: this app's own market number when a book has
   * priced him, and Rotowire's only when none has. A row holding the *first*
   * of those, with no borrowed figure on its vacancy, passed the old guard and
   * printed `can't be scored this week` underneath a number all the same.
   *
   * Only an `unscorable` vacancy makes that claim. An availability note is not
   * contradicted by a figure and must survive beside one — a player on injured
   * reserve whose row said nothing but his name and a number is the regression
   * `never highlights a player who cannot play` was written to catch, and
   * suppressing on the presence of a number alone would reintroduce it.
   */
  const denialBesideAFigure = (blocked?.kind ?? 'unscorable') === 'unscorable' && shown.points != null;

  if (!subject) {
    /*
     * Empty in Sleeper and empty here, which is still two different sentences.
     *
     * `Nobody eligible yet` is true of a half-drafted roster and false of one
     * that holds a player for the slot this app cannot put a number on — the
     * defence nobody has quoted, sitting on the bench rather than in the
     * lineup. That distinction is the whole of the earlier fix and it has to
     * survive the row being rebuilt around Sleeper's lineup, because this is
     * exactly the slot where the reader has nothing else to go on.
     */
    const accepts = row.accepts.length > 1 ? row.accepts.join(', ') : null;
    return (
      <div
        className="player-row"
        data-testid="starter-row"
        data-slot={row.slot}
        data-starter="empty"
        data-verdict={row.verdict}
        data-vacancy={blocked ? 'explained' : 'none'}
        aria-label={
          blocked
            ? `${row.slot}: ${blocked.name} ${blocked.reason}` +
              (borrowed != null ? `, ${spokenProjection(borrowed, 'sleeper')}` : '') +
              (blocked.detail ? `, ${blocked.detail}` : '')
            : `${row.slot}: nobody eligible yet`
        }
      >
        <div className="player-row-top">
          <span className="slot-label">{row.slot}</span>
          {blocked ? (
            <span className="empty-slot-line" data-testid="vacancy-line">
              <span className="vacancy-name">{blocked.name}</span> {blocked.reason}
            </span>
          ) : (
            <span className="empty-slot-line">
              Nobody eligible yet
              {accepts ? <span className="faint"> · {accepts}</span> : null}
            </span>
          )}
          {/*
            * Somebody else's number, on the one row this app has none of its own.
            *
            * A defence nobody has priced used to leave the column blank, which
            * read as "nothing is known about Jacksonville" when what was true
            * was "this app cannot rank him and Rotowire projects 8.6". The
            * figure sits in the same field, at the same width, wearing the same
            * borrowed styling every other published number wears.
            *
            * The sentence beside it names the figure rather than denying it.
            * It used to read "can't be scored this week" while 6.6 sat on the
            * same row, which was two true halves adding up to nonsense: the
            * word "scored" meant "ranked" to the optimiser and "given a
            * number" to the reader. `unscorableReason` now says which.
            */}
          {borrowed != null ? (
            <span className="row-value">
              <span
                className="proj"
                data-testid="vacancy-proj"
                data-projection-source="sleeper"
                title={projectionTitle(borrowed, 'sleeper')}
              >
                {borrowed.toFixed(1)}
              </span>
            </span>
          ) : null}
        </div>
        {blocked && (blocked.detail || accepts) ? (
          <div className="faint vacancy-detail">
            {[blocked.detail, accepts ? `takes ${accepts}` : null].filter(Boolean).join(' · ')}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <button
      className={positionAccentClass(position, 'player-row starter-row')}
      data-testid="starter-row"
      data-slot={row.slot}
      data-starter="true"
      data-verdict={row.verdict}
      data-position={position.toUpperCase()}
      /*
       * Two ids, because the row is now about two people.
       *
       * `data-player-id` is whoever leads the row — the incumbent on every
       * verdict but `fill` — and `data-recommended-player-id` is who this app
       * would actually start. They differ on exactly the rows that matter, and
       * keeping them apart is what lets "is an unplayable player being
       * recommended" stay a question the DOM can answer. It is not the same
       * question as "does an unplayable player appear on the screen", which he
       * now does on purpose: his slot is the one you have to fix.
       */
      data-player-id={subject.playerId}
      data-recommended-player-id={row.recommendedPlayerId ?? ''}
      /*
       * The whole row in one sentence: the slot, who is in it, and the verdict.
       * A reader hearing this should not need the visible layout to act.
       */
      aria-label={
        `${row.slot}: ${subject.name}` +
        (row.verdict === 'keep' ? ', keep him' : '') +
        (row.verdict === 'swap' ? `, start ${row.recommendedName} instead` : '') +
        (row.verdict === 'fill' ? ', this slot is empty in Sleeper' : '') +
        /*
         * The same rule the visible line follows, because a listener is read
         * the projection a sighted reader can see: without this the label was
         * "Jacksonville, can't be scored this week, projected 9.4 by Rotowire",
         * which is the contradiction in one breath instead of two lines.
         */
        (row.verdict === 'no_pick' && !denialBesideAFigure
          ? `, ${blocked?.reason ?? 'cannot be scored this week'}`
          : '') +
        spokenProjection(shown.points, shown.source) +
        (row.locked ? ', locked' : '') +
        (subject.status ? `, ${subject.status}` : '')
      }
      onClick={onOpen}
    >
      <div className="player-row-top">
        {/*
          Position, club, name — the leading edge every list in this app shares.

          The slot does *not* go here, and that is load-bearing rather than a
          preference: the identity cluster is a fixed-width pill so that every
          name on the screen starts on the same x, starter or bench, and a slot
          chip in front of it shifts the whole row by however many letters the
          slot happens to have. `FLEX` and `QB` are different widths, so it does
          not even shift them by the same amount — the column goes ragged, which
          is what `e2e/row-alignment.spec.ts` exists to catch and did.
        */}
        <PlayerIdentity position={position} team={subject.team ?? ''} />
        <span className="player-name">{subject.name}</span>
        <InjuryTag status={subject.status} />
        {/*
          The tags about the *slot*, after the name, for the reason above.

          The slot is named only where the pill has not already said it: a back
          in an RB spot would be the row saying `RB` twice, and a back in a FLEX
          spot is the one case where the slot carries something the pill cannot.
        */}
        <span className="row-tags">
          {position && position.toUpperCase() !== row.slot.toUpperCase() ? (
            <span className="tag tag-calm tag-mini" data-testid="slot-tag" title={`Starting at ${row.slot}`}>
              {row.slot}
            </span>
          ) : null}
          {row.locked ? (
            <span className="tag tag-calm tag-mini" data-testid="locked-tag">
              Locked
            </span>
          ) : null}
          {/*
            Last in the cluster, so it is the first thing to wrap on a narrow
            screen rather than pushing `Locked` off the row. The slot and the
            lock change what the reader can *do*; the fixture is context.
          */}
          <FixtureChip fixture={fixture} />
        </span>
        <span className="row-value">
          {/*
            The subject's own number, and never the other man's.

            On a `swap` this is the incumbent's, because he is the subject of
            the row; the challenger's is on the verdict line beside his name,
            where it reads as part of the proposal rather than as a correction
            to the figure above it.
          */}
          <span
            className="proj"
            data-testid="starter-proj"
            data-projection-source={shown.source ?? 'none'}
            title={projectionTitle(shown.points, shown.source)}
          >
            {shown.points == null ? '—' : shown.points.toFixed(1)}
          </span>
        </span>
      </div>
      {/*
        The verdict, on its own line, and only when it is not `keep`.

        A quiet row is the message for a slot with nothing to do — a tick or a
        `Keep` badge on five of nine rows is noise competing with the two rows
        that matter. What earns a line is a change, or a reason there is not one.
      */}
      {row.verdict === 'swap' ? (
        <div className="verdict-line" data-testid="verdict-swap">
          <span className="verdict-arrow" aria-hidden="true">→</span> Start{' '}
          <span className="verdict-name">{row.recommendedName}</span> instead
          {row.projection != null ? <span className="faint"> · {row.projection.toFixed(1)}</span> : null}
        </div>
      ) : null}
      {row.verdict === 'fill' ? (
        <div className="verdict-line" data-testid="verdict-fill">
          <span className="verdict-arrow" aria-hidden="true">→</span> This slot is empty in Sleeper
        </div>
      ) : null}
      {/*
        Why there is no recommendation — but only when the row cannot show it.

        This used to draw under every `no_pick`, and under the defence it read
        `is projected 10.22 by Rotowire, but no betting market has priced him,
        so this app will not rank him`: a sentence the length of the row it was
        explaining, saying what the dotted rule on the figure beside it already
        says, and what the figure's own title and the row's `aria-label` say
        again. Three places was two too many.

        So it is drawn only where nothing else can carry it. A borrowed figure
        marks itself, and `borrowed != null` is exactly that case. A player on
        injured reserve has no figure to mark and no other way to say it — his
        row would otherwise be a name, a dash and no reason — so his line
        stays, which is the distinction the first attempt at this missed and
        `never highlights a player who cannot play` caught.
      */}
      {row.verdict === 'no_pick' && !denialBesideAFigure && borrowed == null ? (
        <div className="faint verdict-line" data-testid="verdict-no-pick">
          {blocked ? `${blocked.reason}${blocked.detail ? ` — ${blocked.detail}` : ''}` : 'Cannot be scored this week'}
        </div>
      ) : null}
    </button>
  );
}

/**
 * `vs BAL · soft` — who he plays, and what that defence gives up to his role.
 *
 * The rating is not this screen's opinion. It is `assessMatchup`'s, which is
 * the same read that already moved the number on the right of this row, so the
 * chip and the projection cannot tell the reader two different stories. A
 * second difficulty scale invented for display is the one thing this must not
 * be.
 *
 * **The word is the signal; the colour agrees with it.** `soft` and `tough`
 * are printed, not merely tinted, so the distinction survives greyscale, a
 * colour-blind reader, and a screenshot pasted into a group chat. In September
 * the honest answer is usually `insufficient_data` — the defence has not faced
 * enough of his role to be described — and then the chip names the fixture and
 * says nothing else, which is a grey chip and no word.
 */
function FixtureChip({ fixture }: { fixture: SlotFixture | null | undefined }) {
  if (!fixture) return null;
  const verdict = fixture.rating === 'soft' || fixture.rating === 'tough' ? fixture.rating : null;
  return (
    <span
      className="fixture-chip"
      data-testid="fixture-chip"
      data-rating={fixture.rating}
      title={fixture.note}
      aria-label={verdict ? `${fixture.spoken}, a ${verdict} matchup. ${fixture.note}` : `${fixture.spoken}. ${fixture.note}`}
    >
      <span>{fixture.label}</span>
      {verdict ? (
        <span className="fixture-chip-verdict" aria-hidden="true">
          · {verdict}
        </span>
      ) : null}
    </span>
  );
}

/**
 * A backup: the same row, on the ordinary surface.
 *
 * No card tint, and that absence is the whole point — it is what makes the
 * tinted cards above read as an answer rather than as decoration.
 *
 * Everything else about the row is deliberately identical to a starter's:
 * `PlayerIdentity`, then the name, then the value in `.row-value`, in the same
 * fields at the same widths. A bench that lines up with the lineup above it is
 * the whole reason the fold is safe to open — the columns do not move when it
 * does, so opening it adds rows rather than rearranging the screen.
 */
function BenchCard({
  player,
  fixture,
  projection,
  projectionSource,
  onOpen,
}: {
  player: RosterPlayer;
  /** His fixture, resolved by the caller from the evaluation map. */
  fixture: SlotFixture | null;
  /** The weekly projection, never the ranking score — see `StarterCard`. */
  projection: number | null;
  /** Whose projection it is. Travels with the number, always — see `projectionTitle`. */
  projectionSource: RowProjectionSource;
  onOpen: () => void;
}) {
  const position = player.position ?? '';
  return (
    <button
      className="player-row bench-row"
      data-testid="bench-row"
      data-starter="false"
      data-position={position.toUpperCase()}
      data-player-id={player.playerId}
      aria-label={
        `${player.name}${position ? `, ${position}` : ''}, on your bench` +
        spokenProjection(projection, projectionSource) +
        `${player.status ? `, ${player.status}` : ''}`
      }
      onClick={onOpen}
    >
      <div className="player-row-top">
        {/*
          His position, and not `BN`.

          `BN` is where he is sitting, which the section he is inside already
          says — and it occupied the one column on the row that every other list
          in the app uses for what he *plays*. So the bench told the reader the
          same thing eight times and never once said which of the eight was a
          receiver, while the club's mark sat at the far trailing edge next to a
          number it has nothing to do with. Both facts are now on the leading
          edge, in the same cluster, at the same widths as the starters above.
        */}
        <PlayerIdentity position={position} team={player.team ?? ''} />
        <span className="player-name">{player.name}</span>
        {/*
          The same chip the starters carry, for the same reason.

          A bench decision is a comparison against a starter, and "who does he
          play" is half of it. Leaving it off down here would mean the reader
          has to open two cards to compare two fixtures that both already fit
          on the rows.
        */}
        <FixtureChip fixture={fixture} />
        {/*
          Against the name, exactly as on a starter — a direct child of the row
          rather than wrapped, so the seam either side of it is the row's own gap
          on both.

          Nothing about a lineup slot, because a bench player holds none — and
          because the lineup above now accounts for everybody who does. The
          `Starting in Sleeper` tag that briefly lived here was the smaller fix
          for a problem the slot rows solve properly: a player Sleeper starts is
          in a row up there, so he is no longer down here to be tagged.
        */}
        <InjuryTag status={player.status} />

        {/* The same field, the same semantics, the same dash — see `StarterCard`. */}
        <span className="row-value">
          <span
            className="proj"
            data-testid="bench-proj"
            data-projection-source={projectionSource ?? 'none'}
            title={projectionTitle(projection, projectionSource)}
          >
            {projection == null ? '—' : projection.toFixed(1)}
          </span>
        </span>
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
  projectionOf,
  fixtureOf,
  summary,
  onOpen,
}: {
  players: RosterPlayer[];
  /**
   * The weekly projection for a bench player and whose it is, or unknown.
   *
   * One function returning both rather than two returning halves, because a row
   * that could be handed a number without its provenance is a row that could
   * print somebody else's model as this app's.
   */
  projectionOf: (playerId: string) => { points: number | null; source: RowProjectionSource };
  fixtureOf: (playerId: string) => SlotFixture | null;
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
          <DisclosureChevronIcon open={open} />
        </span>
      </button>
      {open ? (
        <div data-testid="bench-rows">
          {players.map((p) => (
            <BenchCard
              key={p.playerId}
              player={p}
              fixture={fixtureOf(p.playerId)}
              projection={projectionOf(p.playerId).points}
              projectionSource={projectionOf(p.playerId).source}
              onOpen={() => onOpen(p.playerId)}
            />
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
  dst,
  onOpen,
}: {
  board: WaiverBoard | null;
  /**
   * The defense plan, which is a different question with the same answer shape.
   *
   * Drawn *inside* this section rather than as a card floating above it, and
   * that is a grouping change and only a grouping change. The two are still
   * computed by different modules against different bars — the planner reasons
   * over byes, the weeks ahead and a bench spot; the board over this week's
   * gain on the man it would replace — and merging those would be merging two
   * answers to two different questions.
   *
   * But "add somebody from the wire" is one heading to a reader, and a defense
   * arriving as a lone Stream card above the section it belongs beside read as
   * an orphan — reported as a defense "showing in the wrong place". One
   * heading, two kinds of row under it, each still saying which it is.
   */
  dst: DstPlan | null;
  onOpen: (row: WaiverBoardRow) => void;
}) {
  /*
   * The defense is not one of these rows on this screen.
   *
   * `DstLine` carries it, and a teaser row that repeated it would put the same
   * recommendation on the same screen twice, in two different shapes, one of
   * them ranked by a gain measured against a different bar. The Waivers board
   * draws it as a row instead, because that is the page where "which defense
   * should I add" is a list question.
   */
  const rows = (board?.rows ?? []).filter((row) => row.dst == null);
  const line = <DstLine plan={dst} />;
  const hasDefenseLine = dst != null && dst.surface && dst.headline.length > 0;

  if (rows.length === 0) {
    /*
     * A defense line with no upgrades beside it still belongs under the
     * heading — otherwise it is the same orphan card, one section lower.
     */
    if (hasDefenseLine) {
      return (
        <div data-testid="waiver-card">
          <div className="section-title" data-testid="waiver-title">
            Waiver upgrades
          </div>
          {line}
        </div>
      );
    }
    return (
      <div className="card card-tight" data-testid="waiver-card">
        <div className="faint" data-testid="waiver-verdict">
          {board?.headline ?? 'No waiver comparison available yet.'}
        </div>
      </div>
    );
  }

  return (
    <div data-testid="waiver-card">
      <div className="section-title" data-testid="waiver-title">
        Waiver upgrades
      </div>
      {/*
        The defense first, because it is a slot decision rather than a value
        add: "is my DEF spot right this week" is a smaller and more urgent
        question than "is there somebody better on the wire".
      */}
      {line}
      {rows.slice(0, TEAM_WAIVER_ROWS).map((row) => (
        <WaiverRow key={row.playerId} row={row} onOpen={() => onOpen(row)} />
      ))}
      {/*
        The wallet is not on this screen, and the reason is what this section is.

        Team shows the strongest two upgrades as a *teaser* — see
        `TEAM_WAIVER_ROWS`. A wallet is the frame you read a bid against, and
        there are no bids here to read: the rows below the fold, the ones the
        budget would actually be spent on, are on Waivers. So `BudgetFooter`
        moved to the bottom of that page, under the board it prices, where it is
        beside the numbers it qualifies rather than under two of them.
      */}
      {/*
        And nothing under them.

        This closed with `Expected cost, likely competition, multi-week value is
        not known yet.` — the engine's own bookkeeping, in the engine's own
        vocabulary, at the foot of a screen about a roster. The rows it
        qualifies already say it where it matters: an unknown field draws as a
        dash with its reason attached (see `UnknownField` in
        `components/waivers.tsx`), which is the same claim made once, beside the
        blank it is about, instead of restated as a sentence nobody asked for.

        The full board on Waivers still carries the sentence, because that page
        is where the fields are read as a set.
      */}
    </div>
  );
}

/**
 * How many waiver rows the Team screen shows before it stops.
 *
 * Team is a roster screen with a waiver section, not a waiver screen: the
 * strongest two answer "is there anything I should be doing", and the whole
 * board — every position, every filter — is one tab away. It was three, which
 * is a third of a phone screen spent reproducing a tab that already exists.
 */
const TEAM_WAIVER_ROWS = 2;

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
  ownedByMe,
  onClose,
}: {
  leagueId: string;
  rosterPositions: string[];
  /** The slot this was launched from, or null when launched from the header. */
  slot: string | null;
  seed: string[];
  nameOf: (id: string) => string;
  /** Whether a player is on the reader's roster, for the tag on his card. */
  ownedByMe: (id: string) => boolean;
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
  /*
   * Whose each chosen player is. Seeded from the roster, and filled in from
   * the picker's own rows as they arrive, which carry the league's answer.
   */
  const [owners, setOwners] = useState<Record<string, PickerPlayer['availability']>>(() =>
    Object.fromEntries(seed.filter((id) => ownedByMe(id)).map((id) => [id, 'mine' as const])),
  );
  const [results, setResults] = useState<PickerPlayer[]>([]);
  const [loading, setLoading] = useState(false);
  const [comparison, setComparison] = useState<StartSitComparison | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The player being swapped out, while the reader picks his replacement.
   *
   * Set by the swap button on a player's card and cleared by the pick. While
   * it is set, a tap on a search result *replaces* that player in the same
   * position and re-runs the comparison, so the reader lands back on an
   * answer rather than on a half-built selection.
   */
  const [swapping, setSwapping] = useState<string | null>(null);
  const search = useRef<HTMLDivElement | null>(null);

  useComparisonFonts();

  useEffect(() => {
    setOwners((current) => {
      let next = current;
      for (const p of results) {
        if (p.availability && current[p.id] !== p.availability) {
          if (next === current) next = { ...current };
          next[p.id] = p.availability;
        }
      }
      return next;
    });
  }, [results]);

  const segments = useMemo(() => {
    const startable = startablePositions(buildRosterShape(rosterPositions));
    if (startable.size === 0) return [ALL_FILTER];
    // The same row the draft board and the players list draw, from the same
    // helper: positions, then FLX over three of them, then DEF at the end.
    return [ALL_FILTER, ...orderFilterChips(startable)];
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
    if (player.availability) setOwners((o) => ({ ...o, [player.id]: player.availability }));
    if (swapping) {
      replace(swapping, player);
      return;
    }
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

  /**
   * Put `player` where `out` was, and answer again.
   *
   * The position in the list is kept, so the chips do not reshuffle under the
   * reader. Choosing somebody already in the comparison is refused out loud:
   * a comparison of a player against himself is not a question.
   */
  const replace = (out: string, player: PickerPlayer) => {
    setError(null);
    if (player.id === out) {
      setSwapping(null);
      return;
    }
    if (ids.includes(player.id)) {
      setError(`${player.name} is already in this comparison. Pick somebody else, or cancel the swap.`);
      return;
    }
    const next = ids.map((id) => (id === out ? player.id : id));
    setNames((n) => ({ ...n, [player.id]: player.name }));
    setIds(next);
    setSwapping(null);
    setQuery('');
    if (next.length >= 2) void compare(next);
    else setComparison(null);
  };

  /** Start a swap: remember who is going, and hand the reader the search. */
  const startSwap = (playerId: string) => {
    setError(null);
    setSwapping(playerId);
    /*
     * Focused inside the tap, not on a later frame, so iOS counts it as the
     * reader's own and raises the keyboard. The field is scrolled to the
     * middle of the card, above where the keyboard will land.
     */
    const input = search.current?.querySelector('input');
    input?.focus({ preventScroll: true });
    search.current?.scrollIntoView({ block: 'center' });
  };

  const compare = async (playerIds: string[] = ids) => {
    setBusy(true);
    setError(null);
    try {
      setComparison(
        await api.post<StartSitComparison>('/api/startsit/compare', {
          leagueId,
          playerIds,
          slot,
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Opened from a swap, the answer is already the question.
   *
   * Tapping `Start A over B` and then being asked to tap `Compare 2 players` is
   * a step with nothing in it: the reader chose nobody, the sheet chose both,
   * and the button's only job is to confirm a selection that was not made by
   * hand. So a sheet that opens with a full pair runs itself and shows the
   * comparison.
   *
   * Mount only, and deliberately so. Once the sheet is open the chips are the
   * reader's again — adding or removing one clears the result and puts the
   * button back, which is the behaviour that lets a comparison be re-aimed
   * without re-opening anything.
   */
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    const pair = [...new Set(seed)].slice(0, MAX_COMPARE);
    if (pair.length >= 2) void compare(pair);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const title = slot ? `Compare for ${slot}` : 'Compare players';
  const shownSlot = comparison?.slot?.comparable ? comparison.slot.slot : null;
  const subtitle = [
    comparison?.week != null ? `Week ${comparison.week}` : null,
    shownSlot ? `${shownSlot} slot` : slot ? `${slot} slot` : 'Any lineup spot',
  ]
    .filter(Boolean)
    .join(' · ');

  const picker = (
    <>
      {comparison ? (
        <div className="cmp-eyebrow cmp-picker-head" data-testid="compare-edit-head">
          Change players
        </div>
      ) : (
        <div className="faint" style={{ margin: '0 2px 8px' }} data-testid="compare-hint">
          Choose 2–{MAX_COMPARE} players. Anyone in the league is fair game — your roster, the bench, or the
          free-agent pool.
        </div>
      )}

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
                if (swapping === id) setSwapping(null);
                setIds((current) => current.filter((x) => x !== id));
              }}
            >
              {names[id] ?? id} ✕
            </button>
          ))}
        </div>
      ) : null}

      {swapping ? (
        <div className="cmp-swapping" role="status" data-testid="compare-swapping">
          <span>
            Pick a player to replace <strong>{names[swapping] ?? swapping}</strong>.
          </span>
          <button type="button" className="btn btn-sm" data-testid="compare-swap-cancel" onClick={() => setSwapping(null)}>
            Cancel
          </button>
        </div>
      ) : null}

      <div style={{ margin: '8px 0' }} ref={search}>
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Search players"
          label={swapping ? `Search for a player to replace ${names[swapping] ?? swapping}` : 'Search players to compare'}
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

      {swapping ? null : (
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
      )}

      {loading && results.length === 0 ? (
        <SkeletonRows rows={5} testId="compare-skeleton" />
      ) : results.length === 0 ? (
        <Empty>Nobody matching that search.</Empty>
      ) : (
        <div role="list" aria-label={swapping ? 'Players to swap in' : 'Players to compare'}>
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
    </>
  );

  return (
    <Sheet
      title={
        <span className="cmp-title">
          <span className="cmp-title-main">{title}</span>
          <span
            className="cmp-title-sub"
            {...(comparison?.slot?.comparable ? { 'data-testid': 'comparison-slot', title: comparison.slot.detail } : {})}
          >
            {subtitle}
          </span>
        </span>
      }
      accessibleLabel={title}
      className="sheet-compare"
      onClose={onClose}
      testId="compare-sheet"
    >
      {/*
        With an answer on screen, the answer leads and the picker follows it
        under "Change players". Before there is one, the picker is all there is.
        Busy is shown on the answer itself, so a swap does not blank the sheet.
      */}
      {comparison ? (
        <div aria-busy={busy} className={busy ? 'cmp-busy' : undefined}>
          <ComparisonCard comparison={comparison} availability={owners} onSwap={startSwap} />
        </div>
      ) : null}
      {picker}
    </Sheet>
  );
}

/**
 * The compare sheet's three faces, loaded when the sheet first opens.
 *
 * Space Grotesk for headings, IBM Plex Sans for text and IBM Plex Mono for
 * every number, as approved in the redesign mockup. Requested here rather
 * than in the page head so the rest of the app pays nothing for them: one
 * stylesheet link, added once, the first time anybody compares. `swap` means
 * the sheet draws immediately in the system face and changes face when the
 * files arrive, so an offline phone just keeps the system face.
 */
const COMPARISON_FONTS =
  'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600&family=IBM+Plex+Sans:wght@400;500;600&family=Space+Grotesk:wght@500;600;700&display=swap';

function useComparisonFonts() {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (document.querySelector('link[data-fonts="comparison"]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = COMPARISON_FONTS;
    link.dataset.fonts = 'comparison';
    document.head.appendChild(link);
  }, []);
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
 * The first thing on the screen, because it is the part that asks something of
 * the reader — which slots differ, and by how much. The recommended lineup
 * itself is drawn below it as cards: the answer, then the roster it was made
 * from. Nothing here can alter a lineup: Sleeper is still where a change is
 * made.
 */
/**
 * How well sourced this answer is, as a count rather than as an adjective.
 *
 * The chip said `low confidence` and nothing else, and the owner's question
 * about it was the right one: low compared to what, and decided by whom? The
 * word is `worstConfidence` — the *worst* single player in the lineup — so one
 * unpriced defence takes the whole card to `low` while the other fourteen rows
 * are fine. True, and unreadable as a summary.
 *
 * The fact underneath it is a count: how many of the players this answer was
 * built from carry a betting market, against how many there are. That is what
 * "confidence" has always meant here, said in the terms that produced it, and
 * it moves for a reason a reader can see — a market arrives on Thursday and the
 * number goes up.
 *
 * The adjective is not thrown away. It stays in the title and the accessible
 * name, where a reader who wants the app's own judgement can still find it, and
 * where a screen reader announces both.
 */
function LineupSourcing({ lineup }: { lineup: LineupRecommendation }) {
  const filled = lineup.slots.filter((slot) => slot.playerId);
  const priced = filled.filter((slot) => slot.projectionSource === 'market').length;
  if (filled.length === 0) return <Confidence level={lineup.confidence} />;

  return (
    <span
      className={`badge badge-confidence${lineup.confidence === 'low' ? ' badge-confidence-low' : ''}`}
      data-testid="lineup-sourcing"
      data-confidence={lineup.confidence}
      title={`${lineup.confidence} confidence — ${priced} of ${filled.length} starters have a betting market`}
      aria-label={`${lineup.confidence} confidence. ${priced} of ${filled.length} starters priced by a betting market.`}
    >
      {priced}/{filled.length} priced
    </span>
  );
}

function LineupCard({ lineup }: { lineup: LineupRecommendation }) {
  /*
   * The change worth making, and everything else.
   *
   * The optimiser already sorts its swaps biggest-gain-first, so "the best one"
   * is the first one rather than a new judgement made here.
   */
  const [best = null] = lineup.swaps;
  /*
   * An empty slot is a change too, and usually the bigger one.
   *
   * Carried apart from the swaps because it names nobody to bench; see
   * `LineupFill`. It leads when it is worth more than the best swap, which is
   * the same biggest-gain-first rule the swap list already follows.
   */
  const [fill = null] = lineup.fills ?? [];
  const change =
    fill != null && (best == null || fill.gain >= best.gain)
      ? { ...fill, tail: `at ${fill.slot}, empty in Sleeper`, testId: 'lineup-fill' }
      : best && { ...best, tail: `over ${best.outName}`, testId: 'lineup-swap' };
  const risks = lineup.lateSwapRisks ?? [];
  const material = risks.filter((r) => r.starting);

  return (
    <div className="card lineup-card" data-testid="lineup-card">
      <div className="header-row">
        <strong>Changes to consider</strong>
        <LineupSourcing lineup={lineup} />
      </div>

      {change == null ? (
        <div className="faint" data-testid="lineup-verdict">
          {lineup.currentPoints == null
            ? 'No changes to suggest from what is known so far.'
            : 'Your lineup already matches the recommendation.'}
        </div>
      ) : (
        /*
         * One change, one line, one number.
         *
         * This card used to run to a third of the screen: the swap, its
         * engine-side reason ("a positive recent signal (+1 net over 1
         * item(s))"), a count of the smaller changes, a promise that the app
         * never edits a lineup, and a disclosure headed `Recommended lineup in
         * full`. Every one of those was true and none of them was what the
         * reader came for, which is *what to change*.
         *
         * The smaller changes are not lost and were never only here: every slot
         * row below carries its own verdict, so a swap the app wants appears
         * under the man it replaces — which is the same list, in the place it is
         * actually actionable. The full recommended lineup is that list of rows.
         * Repeating both above them was the card competing with the screen.
         */
        <div className="lineup-change" data-testid={change.testId}>
          <span className="lineup-change-names">
            Start <strong>{change.inName}</strong> {change.tail}
          </span>
          <span className="lineup-change-meta">
            <span className="lineup-change-gain">+{change.gain}</span>
            <span className="lineup-change-slot">{change.slot}</span>
          </span>
        </div>
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

      {/*
        And nothing else on the card.

        `How this was worked out` was a disclosure of the lineup's notes, and
        the notes are about the *lineup* while the card is about one change.
        Opened under `Start RJ Harvey over Jayden Reed` it read: Tampa Bay
        could not be scored, Kenneth Walker is in FLEX rather than RB, three of
        fifteen players use Rotowire's figure, one projection below is
        Rotowire's, no published projection is quoted for QB. Five true
        sentences, none of them about RJ Harvey, under a heading promising to
        explain him.

        The provenance they carry has a better home and already has it: a
        borrowed figure is drawn with a dotted rule on the row it belongs to,
        with the source in that figure's own title and in the row's
        `aria-label`. That is the claim made *beside the number it is about*,
        which is what the disclosure was reaching for and could not do from up
        here.

        So the card is the header and the change, and nothing else.
      */}
    </div>
  );
}

/**
 * Two to four players, laid out so the decision comes first.
 *
 * ## What this replaced, and why
 *
 * A single table: `Projected` at the top, then the start/sit score, then every
 * factor the engine has, one full-width row each, dashes included. On the FLEX
 * comparison the owner photographed on 25 September 2026 (Bateman against
 * Collins), five of fourteen rows were dashes for both men, and the number
 * that decides the lineup sat *under* a projection that pointed the other way
 * (8.7 against 12.3 projected, 9.1 against −0.3 on the score) with nothing on
 * screen saying why.
 *
 * So the order is the order of the question:
 *
 *  1. who is being compared, and whose they are (the identity row, which is
 *     also where a player is swapped out);
 *  2. the answer: the start/sit score, big for the leader, a bar per player on
 *     one scale, and one line naming the factors that make up the gap;
 *  3. the raw projection, smaller, because it is context and not the verdict;
 *  4. the working, in three short cards, with a factor nobody has a value for
 *     collapsed into one sentence instead of a row of dashes;
 *  5. the engine's own note about market coverage, when there is one.
 *
 * Nothing here computes a score. Every number is the one the server sent, and
 * the grouping, the bars and the gap line are arithmetic on those numbers; see
 * `compareLayout.ts`.
 *
 * ## A dash is not a zero
 *
 * `evaluatePlayer` sums only the components it marks `unknown: false`, so an
 * unknown component contributes nothing and is drawn `—`, with the engine's
 * reason in its title and accessible name. A genuinely computed zero (an
 * uncharged availability, say) still prints `0.00`, because that is a real
 * reading.
 *
 * ## Why the factor cards are tables
 *
 * Every cell is the value of one named factor for one named player, which is
 * the one structure a screen reader already navigates in two dimensions. The
 * player names are drawn once, above the first card, and each table carries
 * them again as a visually hidden header row so that "Availability, Nico
 * Collins, −2.10" is still announced as such.
 */
function ComparisonCard({
  comparison,
  availability,
  onSwap,
}: {
  comparison: StartSitComparison;
  /** Whose each player is, when the sheet knows. */
  availability: Record<string, PickerPlayer['availability']>;
  /** Start replacing one player; the sheet owns the search that finishes it. */
  onSwap: (playerId: string) => void;
}) {
  const winner = comparison.evaluations.find((e) => e.playerId === comparison.recommendedPlayerId);
  /*
   * A comparison with no legal shared slot is reported, never forced. The
   * numbers are still the same per-player evaluation as everywhere else, but
   * "Start X" over players who cannot occupy the same spot would be answering
   * a question nobody asked.
   */
  const comparable = comparison.slot?.comparable ?? true;
  const ranked = [...comparison.evaluations].sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
  /*
   * Column order is the ranking when there is one, and the reader's own order
   * when there is not: the eye starts at the first column, and the recommended
   * player should be the one it lands on.
   */
  const columns = comparable ? ranked : comparison.evaluations;
  const pick = comparable && winner ? winner : null;
  const runnerUp = pick ? ranked.find((e) => e.playerId !== pick.playerId && e.score != null) ?? null : null;

  const { groups, untracked } = layoutFactors(columns);
  const componentOf = (e: StartSitEvaluation, key: string) => e.components.find((c) => c.key === key) ?? null;

  const scoreBars = barWidths(columns.map((e) => e.score));
  const projectionBars = barWidths(columns.map((e) => e.projection ?? null));
  const gap = pick && runnerUp ? explainGap(pick, runnerUp) : null;

  /*
   * The closing note is the engine's own sentence about market coverage,
   * written by `assessMarketComparability` — the "Market coverage differs"
   * line this app already prints. Pulled out of `reasons` and `warnings` so it
   * is said once, in the callout, rather than twice.
   */
  const insight = comparison.comparability?.detail ?? null;
  const warnings = comparison.warnings.filter((w) => w !== insight);
  const reasons = comparison.reasons.filter((r) => r !== insight);

  const cols = columns.length;
  /* The label column takes 1.3 shares and each player one, as in the approved mockup. */
  const labelShare = `${((1.3 / (1.3 + cols)) * 100).toFixed(2)}%`;
  const playerShare = `${((1 / (1.3 + cols)) * 100).toFixed(2)}%`;

  const showLateSwap =
    comparison.lateSwap != null && comparison.lateSwap.verdict !== 'no_risk' && comparison.lateSwap.verdict !== 'unknown';
  const moving = comparison.evaluations.filter((e) => e.movement?.headline);
  const locked = comparison.evaluations.filter((e) => e.lock?.locked);

  const valueTone = (value: number) => (value < 0 ? 'cmp-num cmp-num-neg' : 'cmp-num');

  return (
    <div
      className="cmp"
      data-testid="comparison"
      data-columns={cols}
      style={{ ['--cmp-cols' as string]: String(cols) }}
    >
      {/* 1. Who. */}
      <ul className="cmp-players" aria-label="Players in this comparison">
        {columns.map((e) => {
          const owner = availability[e.playerId];
          return (
            <li
              key={e.playerId}
              className={owner === 'mine' ? 'cmp-player cmp-player-mine' : 'cmp-player'}
              data-testid="compare-column"
              data-player-id={e.playerId}
              data-pick={pick?.playerId === e.playerId ? 'true' : 'false'}
            >
              <div className="cmp-player-top">
                <OwnerTag owner={owner} />
                <button
                  type="button"
                  className="cmp-swap"
                  data-testid="compare-swap"
                  data-player-id={e.playerId}
                  aria-label={`Swap ${e.name} for another player`}
                  onClick={() => onSwap(e.playerId)}
                >
                  <SwapIcon size={16} />
                </button>
              </div>
              <div className="cmp-player-name">{e.name}</div>
              {/*
                Position, club and fixture, from the label `fixtureOf` already
                wrote. Not re-derived from `opponent` and `home` here: `vs` and
                `@` have been swapped once in this codebase by exactly that
                second derivation.
              */}
              <div className="cmp-player-meta">
                {e.position}
                {e.team ? ` · ${e.team}` : ''}
                {e.fixture?.label ? ` · ${e.fixture.label}` : ''}
              </div>
            </li>
          );
        })}
      </ul>

      {/* 2. The answer. */}
      <section className="cmp-verdict" aria-label="Start/sit score">
        <div className="cmp-verdict-label">
          {pick ? <CheckIcon size={14} /> : null}
          <span>{pick ? 'Recommended · start/sit score' : 'Start/sit score'}</span>
        </div>
        <div className="cmp-verdict-head">
          {pick && pick.score != null ? <span className="cmp-verdict-score">{pick.score.toFixed(1)}</span> : null}
          <span className="cmp-verdict-name" data-testid="comparison-verdict">
            {!comparable ? 'Not the same lineup decision' : pick ? `Start ${pick.name}` : 'No recommendation'}
          </span>
        </div>

        <ul className="cmp-bars" data-row="score">
          {columns.map((e, i) => (
            <li key={e.playerId} className={pick?.playerId === e.playerId ? 'cmp-bar cmp-bar-pick' : 'cmp-bar'}>
              <span className="cmp-bar-name">{shortName(e.name)}</span>
              <span className="cmp-bar-value" data-player-id={e.playerId}>
                {e.score == null ? (
                  <CompareMissing reason="not enough data to rank him" label="Start/sit score" name={e.name} />
                ) : (
                  <span title="The comparable figure this verdict was made on: the market expectation plus this app's own bounded adjustments. Not a forecast.">
                    {e.score.toFixed(1)}
                  </span>
                )}
              </span>
              <span className="cmp-bar-track" aria-hidden="true">
                {scoreBars[i] != null ? <span className="cmp-bar-fill" style={{ width: `${scoreBars[i]}%` }} /> : null}
              </span>
            </li>
          ))}
        </ul>

        {/*
          Why the leader leads, in the engine's own factors.

          The score is the sum of the known components, so naming the biggest
          gaps between them is a decomposition of the number above, not a
          story about it. When the leader's raw projection is the lower one,
          the line says so first, because that is the case the reader cannot
          reconcile alone.
        */}
        {pick && comparison.margin != null ? (
          <p className="cmp-verdict-why" data-testid="comparison-margin">
            {comparison.margin === 0 ? (
              'Level on the score. The tie is broken by the reasons below.'
            ) : (
              <>
                {shortName(pick.name)} is ahead by <span className="cmp-num">{comparison.margin.toFixed(1)}</span>
                {gap?.projectionShortfall != null ? (
                  <>
                    {' '}
                    despite a projection <span className="cmp-num">{gap.projectionShortfall.toFixed(1)}</span> lower
                  </>
                ) : null}
                .
                {gap && gap.drivers.length > 0 ? (
                  <>
                    {' '}
                    Most of the gap:{' '}
                    {gap.drivers.map((d, i) => (
                      <span key={d.label}>
                        {i > 0 ? ', ' : ''}
                        {d.label} <span className="cmp-num">+{d.delta.toFixed(1)}</span>
                      </span>
                    ))}
                    .
                  </>
                ) : null}
              </>
            )}
          </p>
        ) : null}

        <div className="cmp-verdict-meta">
          <Confidence level={comparison.confidence} /> · Vegas data {comparison.dataFreshness.provider ?? 'none'} ·{' '}
          {formatAge(comparison.dataFreshness.fetchedAt)}
        </div>
      </section>

      {!comparable && comparison.slot ? (
        <div className="hint hint-caution" data-testid="comparison-slot">
          {comparison.slot.detail}
        </div>
      ) : null}

      {/*
        Compact tags for the things a score cannot express: whether kickoff
        timing is a problem, whether the market has moved, whether a game has
        started.
      */}
      {showLateSwap || moving.length > 0 || locked.length > 0 ? (
        <div className="tag-row">
          {showLateSwap ? (
            <span
              className={comparison.lateSwap.verdict === 'consider_early_option' ? 'tag tag-urgent' : 'tag tag-calm'}
              title={comparison.lateSwap.detail}
              data-testid="late-swap-tag"
            >
              ⏱ {comparison.lateSwap.label}
            </span>
          ) : null}
          {moving.map((e) => (
            <span
              key={`move-${e.playerId}`}
              className={e.movement.direction === 'up' ? 'tag tag-star' : 'tag tag-warn'}
              title={e.movement.significant.map((m) => m.display).join('; ')}
              data-testid="movement-tag"
            >
              {e.movement.direction === 'up' ? '↑' : '↓'} {e.name}: {e.movement.headline}
            </span>
          ))}
          {locked.map((e) => (
            <span key={`lock-${e.playerId}`} className="tag tag-calm" data-testid="locked-tag">
              🔒 {e.name} locked
            </span>
          ))}
        </div>
      ) : null}

      {warnings.map((w) => (
        <div className="hint hint-caution" key={w}>
          {w}
        </div>
      ))}

      {/* 3. The projection: context, drawn quieter than the answer. */}
      <section className="cmp-proj-card" aria-label="Projected points">
        <div className="cmp-eyebrow">Projected points</div>
        <ul className="cmp-bars cmp-bars-quiet" data-row="projection">
          {columns.map((e, i) => (
            <li key={e.playerId} className="cmp-bar">
              <span className="cmp-bar-name">{shortName(e.name)}</span>
              <span className="cmp-bar-value" data-player-id={e.playerId}>
                <CompareProjection evaluation={e} />
              </span>
              <span className="cmp-bar-track" aria-hidden="true">
                {projectionBars[i] != null ? (
                  <span className="cmp-bar-fill" style={{ width: `${projectionBars[i]}%` }} />
                ) : null}
              </span>
            </li>
          ))}
        </ul>
        {/*
          Whose numbers these are, said once under them rather than per value.
          Composed on the server, where the published feed's own assumptions
          are legible. See `assembleComparison`.
        */}
        {(comparison.projectionNotes ?? []).map((note) => (
          <div className="faint compare-provenance" key={note} data-testid="compare-projection-note">
            {note}
          </div>
        ))}
      </section>

      {/* 4. The working. */}
      <div className="cmp-stats" data-testid="compare-grid" data-columns={cols}>
        <div className="cmp-eyebrow cmp-stats-title">Why the scores differ</div>
        <div className="cmp-stats-head" aria-hidden="true">
          <span />
          {columns.map((e) => (
            <span key={e.playerId} className="cmp-stats-name">
              {shortName(e.name)}
            </span>
          ))}
        </div>

        {groups.map((group) => {
          // Coverage is a market fact about every player, so the market card
          // always has at least that row.
          if (group.factors.length === 0 && group.id !== 'market') return null;
          return (
            <section key={group.id} className="cmp-group" data-group={group.id}>
              <div className="cmp-group-title" aria-hidden="true">
                {group.title}
              </div>
              <table className="cmp-table">
                <caption className="sr-only">{group.title}</caption>
                <colgroup>
                  <col style={{ width: labelShare }} />
                  {columns.map((e) => (
                    <col key={e.playerId} style={{ width: playerShare }} />
                  ))}
                </colgroup>
                <thead className="sr-only">
                  <tr>
                    <th scope="col">Factor</th>
                    {columns.map((e) => (
                      <th scope="col" key={e.playerId}>
                        {e.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {group.id === 'market' ? (
                    <tr data-row="coverage">
                      <th scope="row" className="cmp-label">
                        Market coverage
                      </th>
                      {columns.map((e) => (
                        <td key={e.playerId} className="cmp-cell" data-player-id={e.playerId}>
                          <span
                            className={e.expectation.coverage > 0 ? 'cmp-num' : 'cmp-num compare-zero-coverage'}
                            title={
                              e.expectation.missingMarkets.length > 0
                                ? `No line for: ${e.expectation.missingMarkets.join(', ')}`
                                : 'Every market this position is priced on has a line'
                            }
                          >
                            {Math.round(e.expectation.coverage * 100)}%
                          </span>
                        </td>
                      ))}
                    </tr>
                  ) : null}
                  {group.factors.map((factor) => (
                    <tr key={factor.key} data-factor={factor.key}>
                      <th scope="row" className="cmp-label">
                        {factor.label}
                      </th>
                      {columns.map((e) => {
                        const component = componentOf(e, factor.key);
                        return (
                          <td key={e.playerId} className="cmp-cell" data-testid="compare-cell" data-player-id={e.playerId}>
                            {component == null ? (
                              <CompareMissing
                                reason={`${factor.label.toLowerCase()} is not part of how he is scored`}
                                label={factor.label}
                                name={e.name}
                              />
                            ) : component.unknown ? (
                              <CompareMissing reason={component.display} label={factor.label} name={e.name} />
                            ) : (
                              <span className={valueTone(component.value)} title={component.display}>
                                {component.value.toFixed(2)}
                              </span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          );
        })}

        {/*
          The factors nobody in this comparison has a value for, said once.

          Five rows of `— —` on the photographed sheet said "we could not read
          this" five times. It is still worth knowing which factors were not
          read, so they are named, in one line, instead of drawn.
        */}
        {untracked.length > 0 ? (
          <p className="cmp-untracked" data-testid="compare-untracked">
            Not tracked for this matchup: {untracked.map((f) => f.label.toLowerCase()).join(', ')}.
          </p>
        ) : null}
      </div>

      {/* 5. The engine's note about coverage, when the two were priced differently. */}
      {insight ? (
        <div className="cmp-insight" role="note" data-testid="compare-insight">
          <AlertCircleIcon size={16} />
          <p>{insight}</p>
        </div>
      ) : null}

      {reasons.length > 0 ? (
        <ul className="reason-list cmp-reasons">
          {reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}

      {/*
        Availability, per player, in the terms a lineup decision is made in.
        `Q · hamstring · limited → full` is the whole difference between two
        players who are both "Questionable". Nothing shows for anybody healthy.
      */}
      {comparison.evaluations
        .filter((e) => e.statusFlag)
        .map((e) => (
          <div className="injury-line" key={`inj-${e.playerId}`} data-testid="startsit-injury">
            {e.name}: {e.statusFlag}
            {e.injury?.conflictNote ? <span className="faint"> — sources disagree ({e.injury.conflictNote})</span> : null}
          </div>
        ))}

      {/*
        The long view: every component with the engine's own sentence beside
        it, the market contributions, the expectation's notes. Collapsed, for
        the reader who wants one player's whole profile.
      */}
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
                <span className="component-value">{c.unknown ? '—' : c.value.toFixed(2)}</span>
                <span className="component-detail">{c.display}</span>
              </div>
            ))}
          </div>
          {e.expectation.contributions.length > 0 ? (
            <div className="components">
              {e.expectation.contributions.map((c) => (
                <div className="component" key={c.market}>
                  <span className="component-label">{marketLabel(c.market)}</span>
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
 * Whose a player is, as a small tag on his card.
 *
 * Three states, the same three the picker already reads from the league
 * (`availabilityLabel`), each with a word so the colour never carries it
 * alone. Nothing at all when the sheet has not been told, rather than a guess.
 */
function OwnerTag({ owner }: { owner: PickerPlayer['availability'] }) {
  if (owner === 'mine') {
    return (
      <span className="cmp-owner cmp-owner-mine">
        <StarIcon size={12} />
        On your team
      </span>
    );
  }
  if (owner === 'available') return <span className="cmp-owner cmp-owner-free">Free agent</span>;
  if (owner === 'rostered') return <span className="cmp-owner">Rostered elsewhere</span>;
  return <span />;
}

/**
 * A cell with nothing in it, and the reason why.
 *
 * Not `0.00`, and not an empty cell either: an empty cell in a grid reads as a
 * rendering fault, and the reader cannot tell it from a column that failed to
 * load. The dash is a mark that means "asked, and there is no answer", the
 * reason is in the title for a pointer and in the accessible name for a screen
 * reader, and the two are the same sentence the engine wrote.
 */
function CompareMissing({ reason, label, name }: { reason: string; label: string; name: string }) {
  return (
    <span
      className="compare-missing"
      data-testid="compare-missing"
      title={`${label} — ${reason}. No value is being invented.`}
      aria-label={`${label} for ${name}: no data. ${reason}.`}
    >
      —
    </span>
  );
}

/**
 * The projection, with the tier it came from marked on it.
 *
 * Three tiers and three treatments, and the vocabulary is deliberately the one
 * the Matchup screen already uses rather than a second one invented here: plain
 * for this app's own market-derived figure, a dotted rule for Rotowire's
 * published week, a dashed rule and an `EST` tag for a preseason season total
 * over a full season of games (a tilde until it was read as a minus sign; see
 * `components/estimate.tsx`). See `core/startsit/projection.ts` for the ladder
 * and `.matchup-player-proj-estimated` for where the marks came from.
 *
 * The mark is the corroboration; the title and the accessible name are the
 * claim. Neither the rule nor the tag is carrying the meaning on its own,
 * which is the rule this app keeps everywhere colour or ornament says something.
 */
function CompareProjection({ evaluation }: { evaluation: StartSitEvaluation }) {
  const points = evaluation.projection;
  const source = evaluation.projectionSource ?? null;
  if (points == null) {
    return (
      <CompareMissing
        reason="no betting market, no published weekly figure and no preseason projection for him"
        label="Projected points"
        name={evaluation.name}
      />
    );
  }

  /*
   * The words come from the two helpers the Team rows already use.
   *
   * They said the same three things in slightly different sentences, which is
   * two vocabularies for one idea on one screen — and the reader can have both
   * open at once, because Compare is a sheet over the Team screen. One set of
   * strings, said the same way in the row and in the grid.
   */
  return (
    <span
      className={`compare-proj${source === 'market' || source == null ? '' : ' compare-proj-borrowed'}${
        source === 'preseason' ? ' compare-proj-preseason' : ''
      }`}
      data-testid="compare-projection"
      data-projection-source={source ?? 'none'}
      title={projectionTitle(points, source)}
      aria-label={`${evaluation.name}${spokenProjection(points, source)}.`}
    >
      {source === 'preseason' ? <Estimated value={points} digits={1} /> : points.toFixed(1)}
    </span>
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
    bestMove?: { text: string; positions: string[]; kind: string } | null;
    /** Seats in the draft, so a client can format a pick it was handed raw. */
    teams?: number;
  };
}) {
  /*
   * QB, RB, WR, TE, then the flex positions, then defence.
   *
   * This was `Object.keys(...).sort()`, which is alphabetical — so a roster
   * opened with DEF above QB, and QB above RB, in an order no fantasy site has
   * ever used. `orderPositions` is the reading order every list in the app
   * shares, and the chip rows layer their own two rules on top of it — see
   * `orderFilterChips`. A roster summary has neither a FLX chip nor a row to
   * scan for receivers, so it takes the plain order. Anything unexpected is
   * kept and put last rather than dropped.
   */
  const positions = orderPositions(Object.keys(roster.counts));
  return (
    <>
      {/*
        The advice, and nothing else.

        This card used to open with a status block: a `LIVE DRAFT` dot, a count
        of picks made and slots filled and left, and a sentence saying either
        which starting slots were still open or that they all were covered. All
        of it was true and none of it was worth the height. A reader looking at
        this screen is mid-draft, on the clock, and already knows they are
        drafting; the roster underneath is the count, group heading by group
        heading; and "which slots are open" is the *input* to the sentence
        below rather than a second reading of it — the card was showing its own
        working above its answer.

        So what is left is the answer. One line, one mark, no rule to separate
        it from anything, and the card is drawn at all only when there is a move
        to name. The counts and the open-slot breakdown are untouched in the
        roster response and still feed the recommendation.

        Computed on the server from the need breakdown the draft engine derives
        from **this league's own starting slots** — see core/draft/bestMove.ts
        and `computeNeed`. Nothing here, and nothing there, asks whether the
        draft is Best Ball: the roster shape is the input, so a Best Ball board,
        a redraft board and a league with two flexes each get the sentence their
        own shape produces. This element prints it; it does not decide it.
      */}
      {roster.bestMove ? (
        <div className="card card-tight" data-testid="live-draft-card">
          <div className="best-move" data-testid="best-move" data-kind={roster.bestMove.kind}>
            <span className="best-move-mark" aria-hidden="true">
              ★
            </span>
            <span>
              <strong>Best move:</strong> {roster.bestMove.text}
            </span>
          </div>
        </div>
      ) : null}

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
            {/*
              One player per line, and the line is short.

              This was two players per row for one deployment, on the argument
              that a name, a club and a pick cost a third of a phone's width and
              the rest was air. Half a phone turned out not to be enough for a
              name — most cells truncated — and a cell that took two lines to
              hold three short things read as a grid of boxes rather than as a
              roster. The density it was after is bought in `.roster-list` by
              making the row shorter instead of narrower.
            */}
            <div className="list-card roster-list">
              {roster.drafted
                .filter((p) => (p.position || 'UNKNOWN') === position)
                .map((p) => (
                  <div key={p.playerId} className="roster-line" data-testid="drafted-line">
                    {/*
                      The club, first, on the same x as every other club on the
                      roster.

                      It used to sit on the trailing edge next to the pick, on
                      the argument that a number and the badge of the team
                      behind it are one thought. They are — but the badge is a
                      fact about the *player*, and pairing it with the pick put
                      the two things that identify him at opposite ends of a row
                      whose only other content is his name. On the leading edge
                      it starts a column: run an eye down a twenty-two man
                      roster and the clubs are a list, which is how a manager
                      notices he has taken four Eagles.

                      Still no position pill, on either edge. The card's own
                      heading — `TE (2)` — has already said the position, and
                      the prior pass took it out of this treatment deliberately.
                      The mark is drawn at the same inline size the player rows
                      use, so a club is one size everywhere it sits inside a
                      name.
                    */}
                    <span className="roster-line-club">
                      <TeamLogo team={p.team} />
                    </span>
                    <span className="player-name">{p.name}</span>
                    {/*
                      His availability, against his name — the same placement
                      the recommended-starter rows use, for the same reason. It
                      is a fact about the player, not about the pick beside it.
                    */}
                    <InjuryTag status={p.status} />
                    {/*
                      And the pick, alone on the trailing edge.

                      One value on the right of the row, on one column, on every
                      line: the reader can run down the picks as easily as down
                      the clubs, which they could not do while the mark was
                      shifting the number sideways by however wide the mark was.
                    */}
                    <span className="row-value">
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
