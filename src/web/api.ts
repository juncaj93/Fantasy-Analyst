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
  newsRawNet: number;
  newsRecentNet: number;
  components: ComponentScore[];
  total: number;
  reasons: string[];
  counterpoints: string[];
  degraded: boolean;
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
  last21: SignalWindow;
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
}
