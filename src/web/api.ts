/** Typed API client. All calls are same-origin and credentialed. */

import type { WaiverLeagueIntel } from '../core/waivers/board.ts';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: init.body ? { 'content-type': 'application/json' } : undefined,
    ...init,
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const message = (body as { error?: string } | null)?.error ?? `request failed (${res.status})`;
    throw new ApiError(message, res.status);
  }
  return body as T;
}

export const api = {
  get: <T,>(path: string) => request<T>(path),
  post: <T,>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body == null ? undefined : JSON.stringify(body) }),
};

// ------------------------------------------------------------------- types
export interface Overview {
  players: number;
  leagues: number;
  selectedLeague: { id: string; name: string; season: string } | null;
  pendingEvidence: number;
  pendingIdentity: number;
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
  /** The one-line form of it, e.g. "1,085 rec yds · 84 rec". */
  marketHeadline: string | null;
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
  stars: string;
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
  /** True when the email itself was kept, so its rules can be re-run. */
  bodyRetained?: boolean;
}

export interface ReprocessDisagreement {
  playerId: string;
  excerpt: string;
  storedPolarity: string;
  storedMagnitude: number;
  newPolarity: string;
  newMagnitude: number;
  ruleId: string | null;
}

export interface ReprocessPreview {
  messageId: string;
  wouldAdd: number;
  alreadyStored: number;
  stale: ReprocessDisagreement[];
  protectedByUser: ReprocessDisagreement[];
  playersAffected: number;
  tallyDelta: { playerId: string; net: number }[];
  detail: string;
}

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
  score: number | null;
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
