/** Typed API client. All calls are same-origin and credentialed. */

import type { DstPlan } from '../core/dst/planner.ts';
import type { WaiverLeagueIntel } from '../core/waivers/board.ts';
import type { WaiverClaimPlan } from '../core/waivers/claimPlan.ts';
/*
 * The rule about what a response has to be before it is parsed.
 *
 * It lives next door rather than here because it is the one part of this file
 * that is about the wire rather than about this app's endpoints, and because it
 * is the part that has to be provable on its own — see tests/api.errors.test.ts
 * for the answers it is written against, all of which arrived on a real phone
 * in one form or another.
 */
import { ApiError, networkFailure, readJson } from './apiResponse.ts';
import { demoSession } from './demo/session.ts';
import { assertMockAllows } from './mock/session.ts';
import type { MockDraftState } from '../core/draft/mockDraft.ts';
import { cached, clearSessionCache, type CacheOptions } from './sessionCache.ts';
/*
 * Which data source is in force, as part of the identity of a cached response.
 *
 * The same league id means two different leagues across two demo scenarios, so
 * a cache keyed on the path alone would confuse them. It is read from the
 * marker rather than passed in because no screen should have to know a demo
 * exists — the same reason the substitution itself lives at this seam — and the
 * marker is set by `demo/session.ts` in the same breath as the session it
 * describes, so it cannot disagree with the runtime this file routes to.
 */
import { currentWorld } from './world.ts';

/*
 * Re-exported so that `import { ApiError } from './api.ts'` keeps meaning what
 * it has always meant. The class itself moved to `apiResponse.ts` when it grew
 * the fields that say *what kind* of failure it is.
 */
export { ApiError } from './apiResponse.ts';
export type { ApiFailure, FailureKind, ResponseKind } from './apiResponse.ts';

/**
 * The one seam Demo Mode substitutes at.
 *
 * Every screen in this app talks to the server through `api.get` and
 * `api.post`, and both of them go through here — so redirecting this one
 * function is the whole of "render the real product over controlled data".
 * Nothing above it changes: no screen knows a demo exists, no component takes a
 * `demo` prop, and a screen written next year inherits the behaviour for free.
 *
 * The demo runtime refuses anything that is not a read, and it throws when it
 * does. That is the refusal below the UI; the server adds another for requests
 * that never came through here at all.
 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method ?? 'GET';
  /*
   * A rehearsal is read-only, and this is where that is enforced.
   *
   * The same seam, one line above the demo substitution, and for the same
   * reason it is here rather than in a screen: every request in this app goes
   * through this function, so a control somebody forgets to disable, an
   * endpoint added next year and a call typed into a console are all refused
   * without anybody having to remember that Mock Draft exists. It is a no-op
   * — one null check — whenever no mock is running, which is almost always.
   *
   * Unlike the demo, this does not redirect anything: a mock's board is served
   * by the server at its own path, and every other read during a rehearsal is
   * the reader's own live data, which is the point of practising against the
   * real league. See `web/mock/session.ts`.
   */
  assertMockAllows(method, path);
  const session = demoSession();
  if (session) {
    const res = await session.runtime.request(method, path, parseBody(init.body));
    if (res.status >= 400) {
      const message = (res.body as { error?: string } | null)?.error ?? `request failed (${res.status})`;
      /*
       * The demo runtime answers in objects, not in responses, so there is no
       * body to misread and nothing here can be handed markup. It is still
       * given the same shape of error as the network path — a refusal from a
       * rehearsal has to look to a screen exactly like a refusal from the
       * server, or the rehearsal is not rehearsing the thing.
       */
      throw new ApiError(message, res.status, { method, endpoint: path, kind: 'json' });
    }
    return res.body as T;
  }

  let res: Response;
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      headers: init.body ? { 'content-type': 'application/json' } : undefined,
      ...init,
    });
  } catch (cause) {
    /*
     * Nothing arrived. Normalised here so that "the request failed" is one kind
     * of thing to a caller whether the failure was a dropped connection or a
     * page where a payload should have been.
     */
    throw networkFailure(method, path, cause);
  }
  return readJson<T>(res, method, path);
}

function parseBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== 'string') return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

export const api = {
  /**
   * Read something.
   *
   * With no options this is what it has always been: a request, awaited. Pass
   * `onFresh` and it becomes stale-while-revalidate — the promise resolves
   * immediately with whatever the app last saw at this path, and `onFresh` is
   * called a round trip later if the server's answer has changed. That is the
   * difference between a revisited tab painting in the next frame and painting
   * after a round trip; see sessionCache.ts for the measurements.
   *
   * A caller that passes nothing still benefits from request de-duplication and
   * still populates the cache for the next caller, so nothing has to be
   * converted for the cache to start being correct.
   */
  get: <T,>(path: string, options: CacheOptions<T> = {}) =>
    cached<T>(path, currentWorld(), () => request<T>(path), options),
  /**
   * Change something.
   *
   * A write empties the cache. It is the one event that can change an answer
   * already held without this module hearing about it — starring a player,
   * applying a lineup, importing a snapshot, changing a league — and deciding
   * which cached paths a given write invalidates would mean teaching the client
   * what every endpoint means. Dropping everything is correct without that.
   *
   * `invalidates: false` is for the exception, and there is exactly one shape
   * of it: a POST that is really a poll. The draft refresh controller syncs
   * from Sleeper every few seconds, and a write that empties the whole cache on
   * a timer would mean no other tab could ever hold anything for longer than
   * one tick — which is this module's entire purpose, defeated by its own
   * safety rule. The caller taking that route owes the same guarantee by
   * another means; see the sync in DraftScreen, which re-reads the board with
   * `fresh: true` in the same beat.
   */
  post: async <T,>(path: string, body?: unknown, options: { invalidates?: boolean } = {}) => {
    try {
      return await request<T>(path, { method: 'POST', body: body == null ? undefined : JSON.stringify(body) });
    } finally {
      if (options.invalidates !== false) clearSessionCache();
    }
  },
};

// ------------------------------------------------------------------- types
export interface Overview {
  players: number;
  leagues: number;
  selectedLeague: { id: string; name: string; season: string } | null;
  pendingEvidence: number;
  pendingIdentity: number;
  /**
   * Newsletters received and not yet scored with an approved tally.
   *
   * Optional for the same reason `season` is: a client running against a
   * deployment older than this one is handed nothing rather than `undefined`
   * arithmetic, and a missing field means "none waiting" — the direction that
   * shows a mark too seldom rather than one that never clears.
   */
  pendingNewsletters?: number;
  vegas: { provider: string; configured: boolean; fetchedAt: string | null; events: number };
  adpSnapshot: { id: number; label: string; capturedAt: string; matchedCount: number } | null;
  /**
   * Where the season is, and therefore whether Draft is still a destination.
   *
   * Optional so a client running against an older deployment keeps the tab
   * rather than losing it to a missing field — the same safe direction the
   * resolver itself takes when it knows nothing.
   */
  season?: {
    phase: 'preseason' | 'regular' | 'postseason' | 'offseason';
    draftVisible: boolean;
    reason: string;
    assumed: boolean;
  };
  /**
   * The same decision at eight-state resolution.
   *
   * Optional for the same reason `season` is: a client that arrives during a
   * deploy, or one pinned to an older worker, must degrade to the four-state
   * answer rather than to nothing. Anything that only needs "is Draft a
   * destination" should keep reading `season`; this is for the things that have
   * to tell an open draft from a live one.
   */
  lifecycle?: {
    lifecycle:
      | 'offseason'
      | 'preseason'
      | 'draft_open'
      | 'draft_live'
      | 'post_draft'
      | 'regular_season'
      | 'playoffs'
      | 'season_complete';
    phase: 'preseason' | 'regular' | 'postseason' | 'offseason';
    draftVisible: boolean;
    /**
     * Whether Matchup is a destination yet.
     *
     * Optional inside an already-optional field: a client talking to a worker
     * that predates Matchup gets `undefined` and simply does not show the tab,
     * which is the correct behaviour rather than a tab leading to a 404.
     */
    matchupVisible?: boolean;
    draftLive: boolean;
    reason: string;
    assumed: boolean;
  };
}

/**
 * The annual readiness check — `GET /api/diagnostics/rollover`.
 *
 * Not on any screen by default. It is the answer to "is this app ready for the
 * new season", which is a question asked once a year by somebody who needs a
 * real answer rather than a rendered page.
 */
export interface RolloverReport {
  season: string;
  ready: boolean;
  waitingOn: string | null;
  checks: {
    name: string;
    status: 'ready' | 'waiting' | 'stale' | 'failed' | 'skipped';
    wanted: string;
    found: string | null;
    detail: string;
    blocking: boolean;
  }[];
  policy: { category: string; disposition: string; reason: string }[];
  summary: string;
  league: {
    selected: { id: string; name: string; season: string } | null;
    succession: {
      league: { id: string; name: string; season: string } | null;
      confidence: 'exact' | 'likely' | 'ambiguous' | 'none';
      autoSelect: boolean;
      reason: string;
    } | null;
  };
}

export interface ComponentScore {
  key: string;
  label: string;
  display: string;
  score: number;
  weight: number;
  contribution: number;
  unknown: boolean;
}

export interface DraftRecommendationExtras {
  /** Sleeper's current designation — `Questionable`, `Out`, `IR`. */
  status: string | null;
  /** One line of market context, or null when the board has nothing to say. */
  tierContext: string | null;
  /**
   * `Q · hamstring · practised fully` — but only when the injury report added
   * something the badge does not already say. Null for almost everybody.
   */
  injuryLine: string | null;
}

export interface DraftRecommendation extends DraftRecommendationExtras {
  playerId: string;
  name: string;
  position: string;
  team: string;
  /** Sleeper ADP — the market the user is drafting in. */
  adp: number | null;
  /**
   * Raw Underdog ADP, or null when no usable snapshot has priced him.
   *
   * Never filled in from `adp`. A blank DOG means Underdog has not priced him
   * or the snapshot is not trusted — `dogState` on the board says which.
   */
  dogAdp: number | null;
  /** How far past **Sleeper's** ADP this pick is. Unchanged by the blend. */
  adpValue: number | null;
  /** The blended market baseline that priced him, and how it was weighted. */
  marketBlend: {
    adp: number | null;
    weights: { dog: number; sleeper: number };
    nominal: { dog: number; sleeper: number };
    sources: ('dog' | 'sleeper')[];
    singleSource: boolean;
    unknown: boolean;
    note: string;
  };
  /** How far apart the two markets are. Context, never a second bonus. */
  marketDisagreement: { picks: number | null; leader: 'dog' | 'sleeper' | null; note: string | null };
  survivalProbability: number | null;
  newsLifetimeNet: number;
  news30Net: number;
  news7Net: number;
  newsConflicted: boolean;
  components: ComponentScore[];
  total: number;
  /** `total` as a whole number, 0–100, higher is better. Board order follows it. */
  score: number;
  reasons: string[];
  counterpoints: string[];
  degraded: boolean;
  /** What the season-long market expects, in this league's points. */
  marketBaseline: MarketBaseline | null;
  /** The one-line form of it, e.g. "1,085 scrim yd · 8.5 TD". */
  marketHeadline: string | null;
  /**
   * The imported preseason projection, in this league's own points.
   *
   * Historical by nature: what a market-derived model expected of him before
   * the season, under the scoring its snapshot was captured with. Optional so a
   * client on an older deployment simply shows nothing; null when no snapshot
   * covers him, which the row draws as a dash rather than a zero.
   */
  preseasonPoints?: number | null;
  /**
   * The same line taken apart, so the expanded card can show its workings.
   *
   * Optional so a client running against an older deployment simply shows the
   * line without the breakdown rather than breaking. `derived` on a component
   * marks a quantity this app summed from more than one market — never a
   * number any single book quoted.
   */
  marketProps?: {
    headline: string;
    derived: boolean;
    missing: string[];
    components: {
      text: string;
      label: string;
      value: number;
      derived: boolean;
      missing: string[];
      parts: { market: string; line: number; bookCount?: number }[];
    }[];
  } | null;
  /**
   * Why the market number is a good one for his position, and whether the draft
   * market agrees. Optional so a client on an older deployment simply omits the
   * sentence rather than breaking.
   */
  marketStrategy?: {
    kind: 'bullish' | 'bearish' | 'agrees';
    standing: string;
    disagreement: string | null;
    caveat: string | null;
  } | null;
  tierCliff: TierCliff;
  avoid: AvoidTag;
  /** Your rating from the players list. This one moves the ranking. */
  myGuy: MyGuyFlag;
  /** Bookmarked with the ★ on this board. Deliberately no effect on ranking. */
  queued: boolean;
  wait: WaitGuidance;
}

export interface MarketBaseline {
  points: number | null;
  coverage: number;
  contributions: { market: string; line: number; points: number; detail: string }[];
  missing: string[];
  note: string;
}

export interface TierCliff {
  severity: 'none' | 'thinning' | 'last_in_tier';
  tierIndex: number | null;
  remainingInTier: number;
  /** Every available player in his tier, not only the ones after him. */
  tierSize: number;
  /** Whether a gap worth warning about closes the tier, rather than the board running out. */
  tierEndsAtCliff: boolean;
  /** Whether any tier boundary closes it, warning-grade or not. */
  tierEndsAtBoundary: boolean;
  /** The boundary gap that opened this tier; null for the best tier left. */
  tierGapBefore: number | null;
  gapToNextTier: number | null;
  survivingTierMates: number;
  /** Picks to the next available player at the position. */
  gapToNext: number | null;
  /** That gap over the spacing around it — how anomalous the hole is. */
  gapRatio: number | null;
  localMedianGap: number | null;
  positionMedianGap: number | null;
  score: number;
  message: string | null;
}

export interface AvoidTag {
  active: boolean;
  lifetimeNet: number;
  score: number;
  message: string;
  trendNote: string | null;
}

export interface MyGuyFlag {
  level: 0 | 1 | 2 | 3;
  label: string;
  marks: string;
  score: number;
}

export interface WaitGuidance {
  state: 'take_now' | 'risky_to_wait' | 'can_probably_wait' | 'likely_available_later' | 'unknown';
  label: string;
  detail: string;
  survivalProbability: number | null;
}

export interface SlotProgress {
  slot: string;
  filled: number;
  required: number;
  accepts: string[];
  /** The bench row: depth held, not a starting slot left open. */
  bench?: boolean;
}

/**
 * What the expanded card adds to what the collapsed one already showed.
 *
 * Fetched separately, and only once a card is open: the board must never wait
 * on a third party mid-draft.
 */
export interface PlayerDetail {
  playerId: string;
  lastSeason: {
    season: string;
    gamesPlayed: number | null;
    /** `WR7`. Null when he did not score — which is not "finished last". */
    positionRank: string | null;
    scoring: string;
  } | null;
  outlook: {
    season: string;
    title: string;
    /**
     * What to show: a selection of the provider's own sentences, in their own
     * order, or the whole thing when no trustworthy selection could be made.
     */
    text: string;
    /** True when `text` is a selection, so the card can say so and offer the rest. */
    summarised: boolean;
    /** The whole outlook, in the words of whoever wrote it. */
    fullText: string;
    /** Who wrote it. Shown on the card, not merely stored. */
    source: string | null;
    fetchedAt: string;
  } | null;
  /** Why there is no outlook, when there is none. */
  outlookNote: string | null;
  /**
   * What a market-derived model projected for his season, before it began.
   *
   * Optional so an older deployment simply shows nothing. Always shown with its
   * date and the scoring it was captured under: after week one the number is
   * history, and a bare figure would read as a current expectation.
   */
  preseasonProjection?: {
    points: number;
    label: string;
    scoringLabel: string;
    capturedAt: string;
  } | null;
  /**
   * `2025: missed 9 games with a toe injury` — one line about last season, or
   * a label like `Major injury history: ACL` when only the outlook named one.
   *
   * Reconciled against the games played shown above it, so the two can never
   * describe different seasons. Null when there is nothing to say.
   */
  injuryContext: string | null;
  /** The arithmetic behind that line, for evidence and debug views. */
  availability: {
    season: string;
    gamesPlayed: number | null;
    gamesAvailable: number | null;
    gamesMissedTotal: number | null;
    injuryAttributedMisses: number;
    unresolvedMisses: number | null;
    confidence: string;
    parts: { part: string; games: number; episodes: number }[];
    corroborated: boolean;
  } | null;
  /** Current availability: designation, body part, practice week, provenance. */
  injury: {
    designation: string;
    label: string;
    line: string | null;
    bodyPart: string | null;
    practice: string | null;
    provenance: string | null;
    freshness: string;
    confidence: string;
    conflict: string | null;
  } | null;
  /**
   * One sentence explaining the tally, selected from the evidence ledger.
   *
   * It is on this payload — the one shared detail request every screen already
   * makes — rather than on each screen's own list, so Draft, Team, Waivers,
   * Trades and Players show the same sentence instead of six renderers each
   * deciding what the evidence means.
   *
   * `scoreDelta` is always 0 and is on the wire deliberately: the takeaway
   * explains a number the tally already produced from the same evidence, and
   * anything that counted it again would be counting it twice.
   */
  newsletterTakeaway: {
    text: string;
    sourceName: string;
    sourceDate: string;
    corroboration: number;
    derivation: 'extracted' | 'templated';
    evidenceItemIds: string[];
    scoreDelta: 0;
  } | null;
  /**
   * Physical and age context, and usually none.
   *
   * A flag fires only where a measurement is in genuine tension with a role.
   * Height and weight arrive as null unless a physical flag fired — the server
   * withholds them rather than trusting the card to hide them — and nothing
   * here moves a number: `scoreDelta` is always 0.
   */
  profile: {
    flags: { key: string; text: string; kind: 'physical' | 'age'; weight: 'context' }[];
    showMeasurements: boolean;
    scoreDelta: 0;
    heightInches: number | null;
    weightPounds: number | null;
  };
}

export interface RosterAlert {
  key: string;
  severity: 'info' | 'warn' | 'urgent';
  message: string;
  detail: string;
  positions: string[];
}

/**
 * One turn of a practice draft.
 *
 * The board in here is a `DraftBoard`, produced by the same assembly and the
 * same engines as the live one, over a substituted pick stream — so every
 * component that draws a real board draws a mock one with no change. What is
 * wrapped around it is the rehearsal's own state, which the browser stores and
 * posts back, and whose turn it is.
 *
 * See `core/draft/mockBoard.ts`. Nothing about a mock is kept on the server.
 */
export interface MockBoardResponse {
  state: MockDraftState;
  board: DraftBoard;
  /** The seat on the clock, or null once the rehearsal is over. */
  onTheClock: number | null;
  yourTurn: boolean;
  complete: boolean;
  made: { pickNo: number; slot: number; playerId: string; by: 'you' | 'bot' }[];
  /** Why a pick was not accepted, or null. Shown to the reader as written. */
  refused: string | null;
  notes: string[];
}

export interface DraftBoard {
  draftId: string;
  status: string;
  type: string;
  teams: number;
  rounds: number;
  currentPick: number;
  picksMade: number;
  mySlot: number | null;
  myNextPick: number | null;
  /** The pick "will he last" is measured against: your next one after this. */
  waitHorizonPick: number | null;
  picksUntilMyTurn: number | null;
  onTheClock: boolean;
  league: { id: string; name: string; scoringLabel: string; notes: string[] };
  rosterCounts: Record<string, number>;
  myRoster: { playerId: string; name: string; position: string; team: string; pickNo: number }[];
  adpSnapshot: { id: number; label: string; capturedAt: string; matched: number } | null;
  /**
   * Where the DOG column stands, and — when it is absent — why.
   *
   * Optional so a client running against an older deployment simply shows no
   * DOG rather than breaking. The reason string is what stops a blank column
   * from being ambiguous between "Underdog has not priced him" and "we stopped
   * trusting the file".
   */
  dogState?: {
    available: boolean;
    provider: string | null;
    sourceType: string | null;
    snapshotAt: string | null;
    fetchedAt: string | null;
    freshness: 'fresh' | 'aging' | 'stale' | 'unknown';
    ageHours: number | null;
    matched: number;
    reason: string;
  };
  /** Who priced the season markets behind every `MKT` line, and when. */
  marketSource?: { provider: string; season: string; fetchedAt: string } | null;
  /** How the market baseline is weighted for this league, and on what basis. */
  marketFormat?: {
    format: 'standard' | 'best_ball';
    bestBall: boolean;
    confident: boolean;
    basis: string;
    weights: { dog: number; sleeper: number };
    reason: string;
  };
  recommendations: DraftRecommendation[];
  rosterAlerts: RosterAlert[];
  /** Every starting slot the league has, filled out of required. */
  rosterProgress: SlotProgress[];
  round: number;
  startablePositions: string[];
  /** Whether the W/R/T flex view is worth a chip in this league. */
  offersFlex?: boolean;
  /**
   * The drafting managers, one per seat, in column order.
   *
   * Read by the draft-board overlay and by nothing else. Optional so a client
   * running against an older deployment simply gets `Team 4` columns rather
   * than a broken board.
   */
  managers?: { slot: number; name: string; isMine: boolean }[];
  /**
   * Every completed pick, with the manager who actually made it.
   *
   * This is why the board overlay needs no request of its own: the picks travel
   * with the board the live refresh already rebuilds, so a new pick reaches the
   * grid through exactly the sync that was already running.
   */
  boardPicks?: { pickNo: number; playerId: string; name: string; position: string; team: string; ownerSlot: number }[];
  /** Owner slot per pick, only in a draft where Sleeper published a trade. */
  pickOwners?: number[] | null;
  /**
   * How many players survived each stage that can lose one.
   *
   * Not drawn on the board — it is read by the production probe, which is what
   * makes a silently truncated pool visible instead of plausible.
   */
  poolHealth: {
    activeEligible: number;
    drafted: number;
    scored: number;
    returned: number;
    withAdp: number;
    withoutAdp: number;
    deepestAdp: number | null;
    byPosition: Record<string, number>;
    cap: number;
  };
  warnings: string[];
}

export interface SignalWindow {
  positive: number;
  negative: number;
  net: number;
  items: number;
}

export interface PlayerSignal {
  playerId: string;
  raw: SignalWindow;
  last7: SignalWindow;
  last30: SignalWindow;
  seasonToDate: SignalWindow;
  categoryBreakdown: Record<string, { positive: number; negative: number; items: number }>;
  pendingCount: number;
  mixedCount: number;
  /**
   * Counted items carrying a period rather than a moment — a backfilled running
   * tally. They are kept out of `last7`, so this is what tells a zero there
   * apart from a genuinely quiet week.
   */
  carriedOverItems: number;
  lastEvidenceAt: string | null;
}

export interface EvidenceItem {
  id: string;
  playerId: string;
  playerName?: string;
  playerPosition?: string;
  playerTeam?: string;
  sourceName: string;
  sourceDate: string;
  excerpt: string;
  contextSummary: string | null;
  category: string | null;
  polarity: string;
  magnitude: number;
  confidence: string;
  confidenceScore: number;
  ruleId: string | null;
  reviewStatus: string;
  userOverride: { polarity?: string; magnitude?: number; category?: string; note?: string } | null;
}

export interface IdentityReview {
  id: number;
  sourceMessageId: string;
  sourceDate: string;
  excerpt: string;
  matchedText: string;
  reason: string;
  candidates: { playerId: string; name: string; team: string; position: string; detail: string }[];
  proposedPolarity: string | null;
  proposedCategory: string | null;
}

export interface SetupStep {
  id: 'sleeper' | 'league' | 'adp' | 'newsletter' | 'vegas';
  title: string;
  state: 'ok' | 'warn' | 'todo' | 'off';
  summary: string;
  action: string | null;
}

export interface NewsletterStatus {
  address: string | null;
  addressConfigured: boolean;
  senderConfigured: boolean;
  expectedSenders: string[];
  subjectFilters: string[];
  enabled: boolean;
  lastReceivedAt: string | null;
  lastReceivedFrom: string | null;
  lastReceivedSubject: string | null;
  lastReceivedStatus: string | null;
  lastProcessedAt: string | null;
  lastProcessedDetail: string | null;
  lastError: string | null;
  /** The issue waiting for its approved ChatGPT tally, or null when there is none. */
  pendingTally: {
    messageId: string;
    subject: string;
    receivedAt: string;
    /** Every issue still to be scored, this one included. */
    waiting: number;
  } | null;
  totals: {
    emailsReceived: number;
    newslettersProcessed: number;
    quarantined: number;
    evidenceItems: number;
    autoAppliedPositive: number;
    autoAppliedNegative: number;
    needsReview: number;
  };
}

export interface NewsletterCoverage {
  sentences?: number;
  repairs?: string[];
  sentencesWithPlayers?: number;
  classifiedSentences?: number;
  unclassifiedSentences?: number;
  ambiguousIdentitySentences?: number;
  samples?: { excerpt: string; players: string[] }[];
  unknownNames?: string[];
}

export interface NewsletterMessage {
  messageId: string;
  fromAddress: string;
  subject: string;
  receivedAt: string;
  status: string;
  evidenceCount: number;
  pendingCount: number;
  autoAppliedCount: number;
  identityReviewCount: number;
  rejectReason: string | null;
  detail: string | null;
  coverage: NewsletterCoverage | null;
  /** True when the email itself was kept, so it can be copied for ChatGPT. */
  bodyRetained?: boolean;
  /**
   * Where this issue stands in the reviewed-tally workflow.
   *
   * Optional so a client running against an older deployment reads `undefined`
   * rather than a wrong word, and shows the issue without claiming anything
   * about whether it has been scored.
   */
  tallyState?: 'awaiting' | 'applied' | 'not_applicable';
  talliedAt?: string | null;
}

export interface AiTallyPreviewRow {
  name: string;
  playerId: string;
  playerName: string;
  score: number;
  reason: string;
  dedupeKey: string;
  alreadyImported: boolean;
  contested: boolean;
  parserRows: ParserRowDisposition[];
}

export interface ParserRowDisposition {
  id: string;
  ruleId: string | null;
  excerpt: string;
  polarity: string;
  magnitude: number;
  disposition: 'superseded' | 'needs_review' | 'protected';
}

export interface AiTallyPreview {
  messageId: string;
  protocolOk: boolean;
  error: string | null;
  /** Set when this exact tally has already been applied to this newsletter. */
  alreadyAppliedAt: string | null;
  rowsParsed: number;
  ready: AiTallyPreviewRow[];
  /** Already in the ledger, retired by a later paste, and asked for again. */
  reinstated: AiTallyPreviewRow[];
  duplicates: AiTallyPreviewRow[];
  pending: AiTallyPreviewRow[];
  ambiguous: { name: string; score: number; reason: string; candidates: string[] }[];
  unmatched: { name: string; score: number; reason: string }[];
  conflicts: string[];
  rejected: { line: string; lineNumber: number; why: string }[];
  wouldRetire: { id: string; playerId: string; excerpt: string; polarity: string; magnitude: number }[];
  protectedByUser: { playerId: string; excerpt: string }[];
  parserSuperseded: ParserRowDisposition[];
  parserNeedsReview: ParserRowDisposition[];
  tallyDelta: { playerId: string; playerName: string; net: number }[];
  detail: string;
}

export interface AiTallyApplyOutcome {
  messageId: string;
  inserted: number;
  reinstated: number;
  alreadyPresent: number;
  identityReviews: number;
  retired: number;
  protectedByUser: number;
  parserSuperseded: number;
  parserNeedsReview: number;
  playersTouched: number;
  /** True once the newsletter has an approved tally and stops asking for attention. */
  completed: boolean;
  /** True when this exact tally had already been applied and this call wrote nothing. */
  replayed: boolean;
  detail: string;
}

/*
 * Data health, typed from the model the server derives it with.
 *
 * Re-exported rather than restated, so the contract cannot drift: the screen
 * renders exactly the shape `DataHealthService` produces and Demo Mode's
 * `buildDemoDataHealth` produces, and a field added to one is a field the other
 * two have to account for. Type-only, so nothing reaches the bundle.
 */
export type { DataHealthView, RunHealth, SourceHealth } from '../core/health/model.ts';

export interface SetupStatus {
  steps: SetupStep[];
  readyForDraft: boolean;
  sleeper: { connected: boolean; username: string | null; displayName: string | null; playersSynced: number };
  league: {
    selected: boolean;
    id: string | null;
    name: string | null;
    season: string | null;
    teams: number;
    scoringLabel: string | null;
    notes: string[];
    draftId: string | null;
    rosterFound: boolean;
  };
  adp: {
    rankedPlayers: number;
    source: string;
    imported: boolean;
    label: string | null;
    capturedAt: string | null;
    totalRows: number;
    matched: number;
    unresolved: number;
  };
  newsletter: NewsletterStatus;
  vegas: {
    provider: string;
    live: boolean;
    lastRefreshedAt: string | null;
    events: number;
    note: string;
    /** The month's provider allowance, read from the ledger. */
    budget: {
      state: string;
      used: number;
      limit: number;
      remaining: number;
      month: string;
      source: string;
      note: string;
      bySource: Record<string, number>;
    };
    season: {
      season: string;
      players: number;
      quotes: number;
      unresolved: number;
      fetchedAt: string | null;
      stale: boolean;
      reason: string;
    };
  };
  /** Where the expanded player card's extra sections come from, and coverage. */
  playerDetail: {
    stats: {
      season: string;
      source: string;
      players: number;
      lastRunAt: string | null;
      returned: number | null;
      unmatched: number | null;
      rankDisagreements: number | null;
      scoring: string;
    };
    outlook: {
      season: string;
      source: string;
      stored: number;
      noneAvailable: number;
      newestAt: string | null;
    };
    /** Sleeper publishes none. The note says so in words. */
    rosterPercent: { available: false; note: string };
  };
  /** Where a player's availability comes from, and how much of it landed. */
  injury: {
    statusSource: string;
    reportSource: string;
    season: string;
    players: number;
    latestWeek: number | null;
    summary: string;
    lastRun: {
      source: string;
      season: string;
      latestWeek: number | null;
      fetchedAt: string;
      publishedAt: string | null;
      rowsReturned: number;
      matchedById: number;
      matchedByName: number;
      unmatched: number;
      outcome: 'ok' | 'not_published' | 'failed';
      note: string | null;
    } | null;
    /** When we last looked. Moves every five minutes, change or no change. */
    checkedAt: string | null;
    /** When the report itself last changed. The one that qualifies a designation. */
    sourceModifiedAt: string | null;
    /** When anything was last stored. */
    ingestedAt: string | null;
    lastOutcome: string | null;
    lastNote: string | null;
    /**
     * The stored HTTP validators. Present means the last check had something to
     * ask about; absent means the file for this season does not exist yet.
     */
    etag: string | null;
    lastModified: string | null;
    /** Ingests that started and did not finish, in a row. Zero is healthy. */
    consecutiveFailures: number;
    failingSince: string | null;
    caughtUpThrough: number | null;
    /** One sentence about whether the data can be trusted, not just checked. */
    dataHealth: string;
    /**
     * Last season's backfill. Separate from everything above, which is about
     * the season being played — history never answers a question about today.
     */
    history: {
      season: string;
      phase: string | null;
      weeksDone: number;
      lastWeek: number | null;
      rowsSeen: number;
      playersSummarized: number;
      significantPlayers: number;
      etag: string | null;
      lastModified: string | null;
      ingestedAt: string | null;
      lastOutcome: string | null;
      completedAt: string | null;
      note: string | null;
    };
    writesToday: number;
    writeCeiling: number;
    recentEvents: {
      playerId: string;
      week: number;
      kind: string;
      from: string | null;
      to: string | null;
      detectedAt: string;
    }[];
  };
  /**
   * Per-game usage — the input the role detector reads.
   *
   * `playersWithEnoughGames` against `minimumGames` is the number that matters:
   * every other count here can look healthy while every card still says
   * "insufficient data", because a trend needs three recent games and three of
   * baseline before it is a trend rather than a fortnight.
   */
  usage: {
    source: string;
    season: string;
    players: number;
    playersWithEnoughGames: number;
    minimumGames: number;
    weeks: number;
    latestWeek: number | null;
    rows: number;
    summary: string;
    lastRun: {
      source: string;
      season: string;
      week: number | null;
      latestWeek: number | null;
      fetchedAt: string;
      publishedAt: string | null;
      rowsReturned: number;
      matchedById: number;
      matchedByName: number;
      unmatched: number;
      rowsWritten: number;
      outcome: 'ok' | 'not_published' | 'failed';
      note: string | null;
    } | null;
    /** When we last looked. Moves daily, change or no change. */
    checkedAt: string | null;
    /** When the file itself last changed. */
    sourceModifiedAt: string | null;
    /** When anything was last stored. */
    ingestedAt: string | null;
    lastOutcome: string | null;
    lastNote: string | null;
    etag: string | null;
    lastModified: string | null;
    consecutiveFailures: number;
    failingSince: string | null;
    caughtUpThrough: number | null;
    dataHealth: string;
    writesToday: number;
    writeCeiling: number;
  };
}

export interface LeagueSummary {
  id: string;
  name: string;
  season: string;
  teams: number;
  isSelected: boolean;
  scoringLabel: string;
  notes: string[];
  rosterPositions: string[];
  draftId: string | null;
  /**
   * NFL teams this league's room drafts earlier than the market.
   *
   * Optional and usually empty. It reaches `Next%` alone — the model's estimate
   * of what somebody else will do — and never a Score, a tier or a `Val`.
   */
  localTeams?: string[];
}

export interface RosterPlayer {
  playerId: string;
  name: string;
  position: string;
  team: string;
  status: string | null;
  /**
   * The number on his shirt, when Sleeper records one.
   *
   * What a Team row shows once the draft is over. Optional so a client running
   * against an older deployment falls back to the pick rather than breaking.
   */
  jerseyNumber?: number | null;
  newsNet: number;
  recentNet: number;
  pending: number;
}

export interface StartSitEvaluation {
  playerId: string;
  name: string;
  position: string;
  team: string;
  expectation: {
    points: number | null;
    contributions: { market: string; line: number | null; points: number; detail: string }[];
    missingMarkets: string[];
    coverage: number;
    notes: string[];
  };
  components: {
    key: string;
    label: string;
    display: string;
    value: number;
    /** The value before the Floor/Ceiling multiplier, on newer deployments. */
    baseValue?: number;
    modeWeight?: number;
    unknown: boolean;
  }[];
  score: number | null;
  /**
   * The weekly fantasy projection, or null when there is not an honest one.
   *
   * Optional for the same reason as `LineupSlot.projection`: an older server
   * does not send it, and absent means unknown rather than "use the score".
   */
  projection?: number | null;
  /**
   * Where {@link projection} came from: this app's betting-market model, or
   * Rotowire's published weekly figure by way of Sleeper.
   *
   * Optional and absent on an older server, which is read as "not stated"
   * rather than as "ours" — a number whose provenance nobody sent is a number
   * this app must not claim.
   */
  projectionSource?: 'market' | 'sleeper' | null;
  confidence: string;
  confidenceReasons: string[];
  /** `Questionable · hamstring · practised fully`, or null when healthy. */
  statusFlag: string | null;
  /** True when he must not be recommended as a starter: Out, IR, PUP, suspended. */
  ruledOut: boolean;
  injury: {
    designation: string;
    bodyPart: string | null;
    freshness: string;
    confidence: string;
    conflict: boolean;
    conflictNote: string | null;
    practice: { trend: string; label: string | null; latest: string };
  };
  lock: { locked: boolean; kickoff: string | null; reason: string };
  movement: {
    significant: { market: string; direction: string; from: number; to: number; display: string }[];
    direction: string;
    headline: string | null;
  };
  role: { trend: string; label: string; detail: string; games: number };
  /*
   * Everything below arrives from the intelligence pass and is optional, so a
   * screen built against this file keeps rendering against a deployment that
   * predates it. Absent means the server did not send it, which the UI shows as
   * nothing rather than as a zero.
   */
  mode?: StartSitMode;
  usage?: { perGame: number | null; unit: string; points: number; games: number; display: string; unknown: boolean };
  roleProfile?: { bucket: string; label: string; adot: number | null; games: number; confidence: string; detail: string | null };
  tdDependency?: { profile: string; share: number | null; touchdowns: number; scoringGames: number; games: number; display: string };
  gameScript?: { points: number; impliedTeamTotal: number | null; favoured: boolean | null; display: string; unknown: boolean };
  weather?: { points: number; unknown: boolean; indoor: boolean; display: string };
  matchup?: { points: number; unknown: boolean; rating: string; sample: number; display: string };
  availability?: { state: string; label: string; detail: string | null; risky: boolean };
  /** The two to four things that decided it, biggest first. */
  drivers?: string[];
  /** Where the evidence points different ways. */
  conflicts?: string[];
  opponent?: string | null;
  /**
   * Expected points, points over expectation, and anything else the
   * intelligence pass adds — already labelled and already formatted.
   *
   * The weekly card prints these as given and computes none of them. Absent
   * until that work merges, and absent renders as nothing.
   */
  advanced?: { key: string; label: string; value: string; detail?: string | null }[];
  /** What would move the recommendation, once the sensitivity pass exists. */
  whatWouldChange?: string[];
}

/** Floor, Balanced or Ceiling — which question Start/Sit is answering. */
export type StartSitMode = 'balanced' | 'floor' | 'ceiling';

/** Which lineup spot a comparison is actually about. */
export interface ComparisonSlot {
  slot: string | null;
  accepts: string[];
  /** False when the selected players share no legal lineup slot. */
  comparable: boolean;
  detail: string;
}

export interface StartSitComparison {
  league: { id: string; name: string; scoringLabel: string };
  dataFreshness: { fetchedAt: string | null; provider: string | null; events: number };
  /** Absent on responses from an older deployment. */
  slot?: ComparisonSlot;
  evaluations: StartSitEvaluation[];
  recommendedPlayerId: string | null;
  margin: number | null;
  confidence: string;
  reasons: string[];
  warnings: string[];
  lateSwap: {
    verdict: string;
    label: string;
    detail: string;
    gapHours: number | null;
    advantage: number | null;
  };
  mode?: StartSitMode;
  /** Whether the betting market would make the same call. Never obeyed. */
  market?: {
    verdict: 'agrees' | 'neutral' | 'disagrees' | 'unavailable';
    label: string;
    detail: string;
    marketMargin: number | null;
    material: boolean;
  };
}

export interface LineupSlot {
  slot: string;
  accepts: string[];
  playerId: string | null;
  name: string | null;
  position: string | null;
  /** The comparable start/sit score the optimiser ranked with. Not a forecast. */
  score: number | null;
  /**
   * The weekly fantasy projection, or null when there is not an honest one.
   *
   * Optional because a deployment older than this one does not send it, and
   * absent is read as "unknown" rather than falling back to `score` — falling
   * back is exactly the bug this field exists to end.
   */
  projection?: number | null;
  /**
   * Where {@link projection} came from: this app's betting-market model, or
   * Rotowire's published weekly figure by way of Sleeper.
   *
   * Optional and absent on an older server, which is read as "not stated"
   * rather than as "ours" — a number whose provenance nobody sent is a number
   * this app must not claim.
   */
  projectionSource?: 'market' | 'sleeper' | null;
  alreadyStarting: boolean;
  locked: boolean;
  /** The two to four things that decided this player. Absent on older servers. */
  drivers?: string[];
  /** Where the evidence points different ways. */
  conflicts?: string[];
}

export interface LineupSwap {
  slot: string;
  inPlayerId: string;
  inName: string;
  outPlayerId: string;
  outName: string;
  gain: number;
  reason: string;
}

export interface LineupRecommendation {
  league: { id: string; name: string; scoringLabel: string };
  found: boolean;
  error?: string;
  dataFreshness: { fetchedAt: string | null; provider: string | null; events: number };
  /** The slots this league starts, which is the order the Team screen uses. */
  rosterShape?: {
    starters: Record<string, number>;
    flex: { slot: string; positions: string[] }[];
    totalStarters: number;
    superflex: boolean;
  };
  slots: LineupSlot[];
  /**
   * The evaluations behind the slots. Absent on an older deployment, which the
   * weekly card treats as "no card for a starter yet" rather than as an error.
   */
  starters?: StartSitEvaluation[];
  bench: StartSitEvaluation[];
  undecidable: StartSitEvaluation[];
  swaps: LineupSwap[];
  recommendedPoints: number;
  currentPoints: number | null;
  confidence: string;
  warnings: string[];
  notes: string[];
  mode?: StartSitMode;
  /** Availability risks that depend on the bench rather than on the player. */
  lateSwapRisks?: { playerId: string; name: string; verdict: string; detail: string; starting: boolean }[];
}

/** What one tap of the Start/Sit refresh actually did, per source. */
export interface StartSitRefreshReport {
  startedAt: string;
  finishedAt: string;
  deduped: boolean;
  sources: {
    source: 'sleeper' | 'injury' | 'usage' | 'vegas' | 'weather';
    outcome: 'updated' | 'current' | 'unavailable' | 'skipped' | 'blocked';
    detail: string;
    freshAt: string | null;
  }[];
  headline: string;
  complete: boolean;
}


/**
 * Waiver-aware lineup advice.
 *
 * Advisory in every sense: there is no add, drop, claim or bid anywhere in this
 * app, and nothing on this type describes a transaction that happened.
 */
export interface WaiverCandidate {
  playerId: string;
  name: string;
  position: string;
  team: string;
  score: number | null;
  /** Points gained over whoever the optimiser has in the slot. */
  gain: number;
  reasons: string[];
  statusFlag: string | null;
  /** The role assessment behind the points, carried rather than described. */
  role: { trend: string; games: number };
  /*
   * What your league's own managers imply: what he will cost, who else wants
   * him, and what he is worth past Sunday. Optional, and absent means unknown —
   * the Waivers page says so rather than estimating any of them. The shapes are
   * defined once, beside the view model that reads them, in
   * core/waivers/board.ts.
   */
  faab?: WaiverLeagueIntel['faab'];
  competition?: WaiverLeagueIntel['competition'];
  multiWeek?: WaiverLeagueIntel['multiWeek'];
  leagueRank?: number | null;
}

export interface WaiverUpgrade {
  slot: string;
  accepts: string[];
  /** `unfilled` when nobody on the roster can legally start there. */
  need: 'unfilled' | 'upgrade';
  currentPlayerId: string | null;
  currentName: string | null;
  currentScore: number | null;
  bar: number;
  candidates: WaiverCandidate[];
}

export interface WaiverAdvice {
  league: { id: string; name: string; scoringLabel: string };
  found: boolean;
  upgrades: WaiverUpgrade[];
  /** Said plainly when nothing available beats what the roster already has. */
  headline: string | null;
  notes: string[];
  considered: number;
  threshold?: number;
  pool?: { scanned: number; perPosition: number };
  /** What each upgrade would cost, or why no price can honestly be quoted. */
  faab?: FaabAdvice | null;
  /**
   * The defence decision, or null when this league does not have one.
   *
   * It rides on this response rather than on an endpoint of its own so Team and
   * Waivers cannot draw two different answers to the same question — Team
   * already fetches this, and a second request would have been a second chance
   * to disagree.
   */
  dst?: DstPlan | null;
  /**
   * The claims to enter, in the order to enter them.
   *
   * Computed by the server rather than by the screen, on the same principle as
   * the defence plan above: the wording is written once, next to the arithmetic
   * that justifies it, and both screens that read this response are drawing the
   * same sentences. Absent on a deployment whose planner could not run, which
   * the screen reads as "no plan" and never as "no move".
   */
  claimPlan?: WaiverClaimPlan | null;
}

/** A roster's budget position, in dollars and as a share of the league. */
export interface RosterBudget {
  rosterId: number;
  ownerName: string | null;
  isMine: boolean;
  /** Null whenever the league total or this roster's spend is unknown. */
  remaining: number | null;
  spent: number | null;
  share: number | null;
}

/**
 * Three numbers that are not the same number: what the room will pay, what he
 * is worth to you, and the line past which winning is worse than losing.
 */
export interface FaabBid {
  playerId: string;
  name: string;
  expected: { low: number; high: number } | null;
  recommended: number | null;
  doNotExceed: number | null;
  /** `Expected $17–22 · Recommended max $19 · Preserve budget for RB depth` */
  headline: string;
  reasons: string[];
  worth: number | null;
  components: { key: string; label: string; factor: number; note: string }[];
  confidence: 'none' | 'low' | 'medium' | 'high';
  /** Set whenever the answer is deliberately not a number. */
  withheld: string | null;
  /** `Bid $24 → $41 remaining · still above 6/9 managers`, or nothing. */
  opportunity: {
    spend: number;
    remainingAfter: number;
    line: string;
    above: number;
    comparable: number;
    droppedBelow: string[];
  } | null;
  /** `#2 trending add · still available in your league`, or nothing. */
  trending: string | null;
  /** Whether the market and our own read agree, and what that is allowed to change. */
  disagreement: {
    kind: 'market_ahead' | 'model_ahead' | 'agreed' | 'quiet' | 'unknown';
    label: string;
    line: string | null;
    confidenceDelta: number;
    affects: 'bid_price_and_confidence_only';
  };
}

export interface FaabAdvice {
  rule: { total: number | null; usesFaab: boolean; provenance: string };
  mine: RosterBudget | null;
  rosters: RosterBudget[];
  prices: {
    sample: number;
    median: number | null;
    low: number | null;
    high: number | null;
    max: number | null;
    highestLosing: number | null;
    losingBidsComplete: boolean;
    confidence: 'none' | 'low' | 'medium' | 'high';
  };
  /** One line about what is and is not knowable about losing bids. */
  losingBids: string;
  bids: FaabBid[];
  notes: string[];
  trendingCapturedAt: string | null;
}

/** What a bench slot is earning, against what the wire would put in it. */
export interface BenchAdvice {
  found: boolean;
  league?: { id: string; name: string };
  dropCandidates: BenchSlotValue[];
  ranked: BenchSlotValue[];
  notes: string[];
}

export interface BenchSlotValue {
  playerId: string;
  name: string;
  position: string;
  slotValue: number;
  /** Slot value minus what a free agent would give you. The real question. */
  surplus: number;
  components: { key: string; label: string; value: number; note: string }[];
  reasons: string[];
  protected: string | null;
}

/** Help My Scores: unresolved names and what they are costing. */
export interface RepairStatus {
  groups: {
    alias: string;
    normalizedAlias: string;
    items: number;
    net: number;
    net30: number;
    example: string;
    candidates: { playerId: string; name: string; team: string; position: string; detail: string }[];
  }[];
  suspicions: { alias: string; net: number; items: number; candidate: { playerId: string; name: string } }[];
  summary: { names: number; items: number; net: number; headline: string };
}


/** Trade intelligence: what has changed lately, and who holds them. */
export interface TradeSuggestion {
  /** Where this league drafted him, when it did. */
  draft?: DraftProvenance | null;
  /**
   * The manager who holds him, by name.
   *
   * A trade is a conversation with a person, and `ownership: 'other'` is not a
   * person. Null for a free agent, for your own players, and wherever Sleeper
   * has not named the seat — never a stand-in like `Roster 4`.
   */
  owner?: string | null;
  playerId: string;
  name: string;
  position: string;
  team: string;
  ownership: 'mine' | 'other' | 'free';
  verdict: string;
  label: string;
  windows: {
    lifetime: number;
    season: number;
    last30: number;
    last7: number;
    items30: number;
    itemsLifetime: number;
  };
  /**
   * Availability, classified by how long it lasts rather than how bad it is —
   * a one-week Questionable is not a sell signal.
   */
  injury: {
    category: 'healthy' | 'temporary' | 'multi_week' | 'major_recovery';
    urgencyDelta: number;
    line: string | null;
    note: string | null;
  };
  urgency: number;
  confidence: 'high' | 'medium' | 'low';
  reasons: string[];
  counterpoints: string[];
}

/**
 * Where a player came from, when this league drafted him.
 *
 * `Drafted 1.02 by Joe`. Absent for a waiver pickup and for a league with no
 * draft attached — both of which are ordinary, and neither of which gets a
 * made-up pick number.
 */
export interface DraftProvenance {
  pick: string;
  managerName: string | null;
  line: string;
}

export interface TradeBoard {
  league: { id: string; name: string } | null;
  sections: { verdict: string; label: string; players: TradeSuggestion[] }[];
  suggestions: TradeSuggestion[];
  considered: number;
  warnings: string[];
}

/**
 * `GET /api/trades/smart` — Smart Bilateral Trades.
 *
 * The offer shapes are imported from core rather than restated here. They are
 * computed by a pure module both sides of the wire already compile, and a
 * second hand-written copy of a nine-field evaluation is a copy that drifts the
 * first time a field is added — the same rule the matchup forecast follows two
 * blocks below.
 */
export type {
  Fairness,
  FairnessBand,
  OfferEvaluation,
  OfferPlayer,
  RosterRationale,
  SideOutcome,
} from '../core/trades/bilateral.ts';
export type { ActivityClass, ManagerFit } from '../core/trades/managerFit.ts';
export type { TradeCapability } from '../core/trades/capability.ts';

import type { OfferEvaluation } from '../core/trades/bilateral.ts';
import type { TradeCapability } from '../core/trades/capability.ts';

export interface SmartTradeBoard {
  league: { id: string; name: string } | null;
  /** True when at least one offer cleared every gate. */
  found: boolean;
  offers: OfferEvaluation[];
  /** What the search did. Developer-facing; no screen reads it. */
  search: {
    partners: number;
    generated: number;
    scored: number;
    viable: number;
    surfaced: number;
    bounds: Record<string, number>;
  };
  /** Whether this league can trade at all. Best ball and disable_trades block. */
  capability: TradeCapability;
  history: {
    /** False only when no league was resolved — the counts mean nothing then. */
    measured: boolean;
    profiles: number;
    seasonsComplete: string[];
    complete: boolean;
    leagueRate: number | null;
  };
  notes: string[];
  warnings: string[];
}

/**
 * `GET /api/leagues/:id/trades/ladder?playerId=` — what one named player costs.
 *
 * The negotiation half of Trades, where the board above is the discovery half.
 * It prices four lineup passes — my roster with and without him, his owner's
 * roster with and without him — so it is asked for one player at a time, on
 * demand, and never as part of a screen's first paint.
 *
 * The shapes come from core for the same reason the bilateral ones do: they are
 * computed by pure modules both sides of the wire already compile, and a
 * hand-written second copy is a copy that drifts.
 */
export type { LadderInputs, TradeLadder, TradeSide } from '../core/trades/ladder.ts';
export type { ConsolidationAdvice, ConsolidationVerdict } from '../core/trades/consolidation.ts';
export type { ManagerTradeProfile, NegotiationStyle } from '../core/managers/tradeProfile.ts';

import type { TradeLadder } from '../core/trades/ladder.ts';
import type { ConsolidationAdvice } from '../core/trades/consolidation.ts';
import type { ManagerTradeProfile } from '../core/managers/tradeProfile.ts';

/**
 * A stored manager profile, with what the cache knows about its freshness.
 *
 * Restated here rather than imported because the type is declared in
 * `server/repos/`, and nothing under `web/` imports from the server — the
 * boundary `tests/infrastructureIsolation.test.ts` keeps. It is five fields and
 * they are the wire's, not the repository's.
 */
export interface CachedManagerProfile<T> {
  profile: T;
  /** Completed observations behind the profile. */
  sample: number;
  /** False until the sample clears the profile's own threshold. Read this first. */
  confident: boolean;
  computedAt: string;
  /** True when the cached row is older than the profile TTL. */
  stale: boolean;
}

/** Who holds the target, and what this league's history says about him. */
export interface LadderPartner {
  rosterId: number;
  /** Null wherever Sleeper has not named the seat — never a stand-in. */
  ownerName: string | null;
  /** Null when no profile has ever been built for this manager. */
  profile: CachedManagerProfile<ManagerTradeProfile> | null;
}

/**
 * Either a priced ladder, or the one honest reason there is no trade to price.
 *
 * `found: false` is not an error and is not a 404: a player nobody else rosters
 * is a waiver add, and saying so answers the reader's actual question.
 */
export type TradeLadderResponse =
  | { found: false; reason: string }
  | {
      found: true;
      league: { id: string; name: string };
      partner: LadderPartner;
      target: { playerId: string; name: string; position: string; value: number };
      ladder: TradeLadder;
      /** Whether turning depth into one better player suits this roster at all. */
      consolidation: ConsolidationAdvice | null;
    };

/**
 * `GET /api/leagues/:id/matchup` — this week's head-to-head.
 *
 * The forecast's own shapes are imported from core rather than restated here.
 * They are computed by a pure module that both sides of the wire already
 * compile, and a second hand-written copy of a nine-field player row is a copy
 * that drifts the first time a field is added.
 */
export type {
  MatchupForecast,
  MatchupPlayerView,
  MatchupSlotRow,
  MatchupTeamView,
} from '../core/matchup/model.ts';
export type { HeroInsight, MatchupPhase } from '../core/matchup/insights.ts';
export type { PlayerLeverage } from '../core/matchup/needs.ts';
/*
 * The lineup decision, for the same reason as everything above it.
 *
 * `decision` has always been on the wire inside the forecast; what is new is
 * that a component now draws one of these on its own, and a component that
 * draws one needs to be able to name its type without reaching past this
 * module into core.
 */
export type { LineupDecision, LineupImpact } from '../core/matchup/decision.ts';

import type { MatchupForecast } from '../core/matchup/model.ts';
import type { WeeklyCard } from '../core/startsit/weekCard.ts';

export interface MatchupResponse {
  league: { id: string; name: string; season: string; scoringLabel: string };
  week: number;
  season: string;
  /** False when this league has no matchup scheduled for this week. */
  found: boolean;
  /** The plain-language why, when it is not found. */
  reason: string | null;
  forecast: MatchupForecast | null;
  /** The shared player sheet's contents, by player id, so a tap costs nothing. */
  cards: Record<string, WeeklyCard>;
  cached: boolean;
}

/**
 * One stored preseason projection capture, as Setup lists it.
 *
 * `scoringKey` is on the wire because a capture taken under other rules is
 * kept rather than discarded, and Setup has to be able to say why it is not
 * being used — an invisible snapshot looks like a bug in the import.
 */
export interface ProjectionSnapshotSummary {
  id: number;
  season: string;
  source: string;
  capturedAt: string;
  scoringKey: string;
  scoringLabel: string;
  importedAt: string;
  label: string;
  lastUpdated: string | null;
  rows: number;
  players: number;
  unresolved: number;
}

/** What Setup shows before anything is pasted: what is loaded, under what rules. */
export interface ProjectionStatus {
  season: string;
  league: { id: string; name: string } | null;
  /** Null when no league is selected, which is why nothing can be imported. */
  scoringKey: string | null;
  scoringLabel: string | null;
  /** The capture the board is reading — matched to the league's own scoring. */
  current: ProjectionSnapshotSummary | null;
  /** Everything else on file for the season, including other scoring profiles. */
  others: ProjectionSnapshotSummary[];
}

/**
 * The answer to both Preview and Apply, which differ only by `committed`.
 *
 * Counts are reported whole — parsed, matched, unresolved, rejected — because
 * the decision a reader makes at the preview is "is this the right table", and
 * a matched count with no denominator cannot answer that.
 */
export interface ProjectionImportResult {
  committed: boolean;
  source: string;
  season: string;
  capturedAt: string;
  capturedFrom: 'paste' | 'declared';
  lastUpdated: string | null;
  scoringKey: string;
  scoringLabel: string;
  label: string;
  counts: {
    parsed: number;
    accepted: number;
    rejected: number;
    matched: number;
    ambiguous: number;
    unmatched: number;
  };
  rejected: { rowNumber: number; reason: string; text: string }[];
  warnings: string[];
  needsReview: {
    name: string;
    status: 'ambiguous' | 'unmatched';
    candidates: { playerId: string; name: string; confidence: number }[];
  }[];
  replaces: ProjectionSnapshotSummary | null;
  otherSnapshots: ProjectionSnapshotSummary[];
  sample: { name: string; position: string | null; team: string | null; points: number }[];
  reviewsFiled: number;
}
