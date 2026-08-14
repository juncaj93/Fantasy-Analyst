/** Typed API client. All calls are same-origin and credentialed. */

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

export interface DraftRecommendation {
  playerId: string;
  name: string;
  position: string;
  team: string;
  adp: number | null;
  adpValue: number | null;
  survivalProbability: number | null;
  newsLifetimeNet: number;
  news30Net: number;
  news7Net: number;
  newsConflicted: boolean;
  components: ComponentScore[];
  total: number;
  reasons: string[];
  counterpoints: string[];
  degraded: boolean;
  tierCliff: TierCliff;
  avoid: AvoidTag;
  myGuy: MyGuyFlag;
  wait: WaitGuidance;
}

export interface TierCliff {
  severity: 'none' | 'thinning' | 'last_in_tier';
  tierIndex: number | null;
  remainingInTier: number;
  gapToNextTier: number | null;
  survivingTierMates: number;
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
  picksUntilMyTurn: number | null;
  onTheClock: boolean;
  league: { id: string; name: string; scoringLabel: string; notes: string[] };
  rosterCounts: Record<string, number>;
  myRoster: { playerId: string; name: string; position: string; team: string; pickNo: number }[];
  adpSnapshot: { id: number; label: string; capturedAt: string; matched: number } | null;
  recommendations: DraftRecommendation[];
  rosterAlerts: RosterAlert[];
  /** Every starting slot the league has, filled out of required. */
  rosterProgress: SlotProgress[];
  round: number;
  startablePositions: string[];
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
  vegas: { provider: string; live: boolean; lastRefreshedAt: string | null; events: number; note: string };
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
}

export interface RosterPlayer {
  playerId: string;
  name: string;
  position: string;
  team: string;
  status: string | null;
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
  components: { key: string; label: string; display: string; value: number; unknown: boolean }[];
  score: number | null;
  confidence: string;
  confidenceReasons: string[];
  statusFlag: string | null;
  lock: { locked: boolean; kickoff: string | null; reason: string };
  movement: {
    significant: { market: string; direction: string; from: number; to: number; display: string }[];
    direction: string;
    headline: string | null;
  };
  role: { trend: string; label: string; detail: string; games: number };
}

export interface StartSitComparison {
  league: { id: string; name: string; scoringLabel: string };
  dataFreshness: { fetchedAt: string | null; provider: string | null; events: number };
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
  slots: LineupSlot[];
  bench: StartSitEvaluation[];
  undecidable: StartSitEvaluation[];
  swaps: LineupSwap[];
  recommendedPoints: number;
  currentPoints: number | null;
  confidence: string;
  warnings: string[];
  notes: string[];
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
  urgency: number;
  confidence: 'high' | 'medium' | 'low';
  reasons: string[];
  counterpoints: string[];
}

export interface TradeBoard {
  league: { id: string; name: string } | null;
  sections: { verdict: string; label: string; players: TradeSuggestion[] }[];
  suggestions: TradeSuggestion[];
  considered: number;
  warnings: string[];
}
