/**
 * 2026 becomes 2027 without anybody touching a database.
 *
 * The user experience this is written to produce: in March the new Sleeper
 * leagues appear, the app works out which one continues the league they were in,
 * and the only thing they are ever asked is a question that genuinely has two
 * answers. No migration, no reset, no code edit, and — the part that is easy to
 * get wrong — no 2026 state wearing 2027's clothes.
 *
 * Two decisions live here, and they are separate on purpose.
 *
 * **Which league is the successor.** Sleeper answers this itself most of the
 * time: a league created by rolling last season's forward carries
 * `previous_league_id`, which is an exact edge and needs no cleverness. When it
 * is absent — the commissioner made a fresh league instead — the app is left
 * matching on name, size and scoring, and the honest thing to do with a
 * three-signal match is *offer* it, not take it. `confidence: 'exact'` may be
 * applied silently; anything else is a question.
 *
 * **What survives the boundary.** This is the half that decides whether the app
 * is right in September. The rule is a question about where the truth lives:
 *
 *   - **Carry forward, with decay** anything whose subject is a *person* and
 *     whose evidence is behavioural. How a manager bids FAAB, whether they
 *     accept lopsided trades, how this app's own recommendations scored. Those
 *     are facts about someone who is still in the league, they took a year to
 *     learn, and throwing them away makes the app stupid every March.
 *
 *   - **Rebuild from current truth** anything whose subject is *this season*.
 *     Rosters, the draft, injuries, ADP, the waiver pool, standings, props, the
 *     schedule, live recommendations. Every one of these has an authoritative
 *     source that will answer for 2027, and every one of them is actively
 *     harmful if last season's copy is served while that source is quiet. A
 *     2026 OUT designation surviving into 2027 is not a stale cache; it is the
 *     app telling somebody a healthy player is injured.
 *
 * The asymmetry is the point. Carrying forward is opt-in, per category, with a
 * decay attached; resetting is the default. When a new store is added and
 * nobody thinks about rollover, it resets — which is the direction that is
 * merely wasteful rather than wrong.
 */

/** What happens to a category of stored state when the season turns over. */
export type RolloverDisposition =
  /** Kept, aged by `halfLifeSeasons`. Behavioural facts about people. */
  | 'carry_decayed'
  /** Kept verbatim and never read as current. Queryable history. */
  | 'retain_history'
  /** Dropped and rebuilt from the provider. Everything about this season. */
  | 'rebuild';

export interface RolloverRule {
  /** The store this governs, named as the user would recognise it. */
  category: string;
  disposition: RolloverDisposition;
  /**
   * Seasons after which a carried signal counts half as much.
   *
   * Only meaningful for `carry_decayed`. One season is deliberate: a manager's
   * bidding from two years ago is a different person's habits half the time —
   * leagues turn over, people change how they play — so the weight should be
   * noticeably down by the second season and negligible by the fourth.
   */
  halfLifeSeasons?: number;
  /** Why, in one line. Surfaced in the rollover diagnostic. */
  reason: string;
}

/**
 * Every category of stored state, and what happens to it.
 *
 * Exhaustive on purpose. A category that is not listed is not "unknown", it is
 * a gap in this table, and the readiness check reports the table so a gap is
 * visible rather than inferred.
 */
export const ROLLOVER_RULES: readonly RolloverRule[] = [
  // ---- behavioural, carried with decay --------------------------------------
  {
    category: 'manager FAAB tendencies',
    disposition: 'carry_decayed',
    halfLifeSeasons: 1,
    reason: 'how somebody bids is a fact about them, and it took a season to learn',
  },
  {
    category: 'manager trade tendencies',
    disposition: 'carry_decayed',
    halfLifeSeasons: 1,
    reason: 'the same manager makes the same kind of offer next year',
  },
  {
    category: 'model grading',
    disposition: 'carry_decayed',
    halfLifeSeasons: 2,
    reason: 'how well this app has been calling it is about the app, not the season',
  },

  // ---- history, kept and never read as current ------------------------------
  {
    category: 'historical recommendations',
    disposition: 'retain_history',
    reason: 'queryable for last season; never sourced for a decision this season',
  },
  {
    category: 'evidence ledger',
    disposition: 'retain_history',
    reason: 'the ledger is append-only and its rows carry their own dates',
  },
  {
    category: 'injury history',
    disposition: 'retain_history',
    reason: 'last season’s missed games are context, kept in their own table',
  },

  // ---- rebuilt from current truth -------------------------------------------
  { category: 'roster', disposition: 'rebuild', reason: 'Sleeper is authoritative and answers immediately' },
  { category: 'draft', disposition: 'rebuild', reason: 'a new season has a new draft' },
  { category: 'injuries', disposition: 'rebuild', reason: 'a designation from last season is a false statement about this one' },
  { category: 'ADP', disposition: 'rebuild', reason: 'last season’s market is not this season’s market' },
  { category: 'waiver pool', disposition: 'rebuild', reason: 'derived entirely from the current roster set' },
  { category: 'standings', disposition: 'rebuild', reason: 'nobody has played a game yet' },
  { category: 'props', disposition: 'rebuild', reason: 'season-scoped by definition' },
  { category: 'schedule', disposition: 'rebuild', reason: 'the NFL publishes a new one' },
  { category: 'current recommendations', disposition: 'rebuild', reason: 'every input beneath them has changed' },
] as const;

/**
 * The multiplier a carried signal keeps after `seasonsElapsed` seasons.
 *
 * Continuous rather than stepped, so a signal does not lurch on 1 March; and
 * floored at zero seasons so a signal from the current season is never
 * discounted for being current.
 */
export function carryWeight(rule: RolloverRule, seasonsElapsed: number): number {
  if (rule.disposition !== 'carry_decayed') return rule.disposition === 'retain_history' ? 1 : 0;
  const half = rule.halfLifeSeasons ?? 1;
  const elapsed = Math.max(0, seasonsElapsed);
  return Math.pow(0.5, elapsed / half);
}

/** Look up one category's rule. Null when the table has no entry for it. */
export function rolloverRule(category: string): RolloverRule | null {
  return ROLLOVER_RULES.find((r) => r.category === category) ?? null;
}

// ---------------------------------------------------------------- succession

/** The parts of a Sleeper league this decision reads. */
export interface LeagueLike {
  id: string;
  name: string;
  season: string;
  totalRosters: number;
  /** Sleeper's own edge back to the league this one continues. */
  previousLeagueId?: string | null;
  /** A stable label for the scoring rules, e.g. `"PPR"`, `"Half-PPR"`. */
  scoringLabel?: string | null;
}

export type SuccessionConfidence = 'exact' | 'likely' | 'ambiguous' | 'none';

export interface SuccessionResult {
  /** The league to move to, or null when the user must be asked. */
  league: LeagueLike | null;
  confidence: SuccessionConfidence;
  /** Every candidate considered, best first, for the disambiguation prompt. */
  candidates: LeagueLike[];
  /** Whether the app may switch without asking. */
  autoSelect: boolean;
  reason: string;
}

/**
 * Which of this season's leagues continues last season's.
 *
 * `candidates` should be the user's leagues for the *new* season; `previous` is
 * the league they were using. Never throws, never picks on one weak signal, and
 * never picks at all when two candidates look equally like the answer — being
 * asked one question in March is a smaller cost than silently analysing the
 * wrong league until somebody notices in September.
 */
export function findSuccessorLeague(previous: LeagueLike | null, candidates: readonly LeagueLike[]): SuccessionResult {
  const pool = candidates.filter((c) => c.season !== previous?.season);

  if (pool.length === 0) {
    return {
      league: null,
      confidence: 'none',
      candidates: [],
      autoSelect: false,
      reason: previous
        ? `no ${nextSeasonOf(previous.season)} league has appeared on Sleeper yet`
        : 'no leagues found for the new season',
    };
  }

  /*
   * Sleeper's own edge, when it exists, is the whole answer.
   *
   * A league created with "start a new season" carries `previous_league_id`
   * pointing at the one it continues. That is not a heuristic — it is the
   * commissioner's own statement of succession, recorded at the moment they
   * made it — and no amount of name-matching should be allowed to override it.
   */
  if (previous) {
    const linked = pool.filter((c) => c.previousLeagueId && c.previousLeagueId === previous.id);
    if (linked.length === 1) {
      return {
        league: linked[0]!,
        confidence: 'exact',
        candidates: linked,
        autoSelect: true,
        reason: `Sleeper links "${linked[0]!.name}" to last season's league`,
      };
    }
    if (linked.length > 1) {
      return {
        league: null,
        confidence: 'ambiguous',
        candidates: linked,
        autoSelect: false,
        reason: `${linked.length} leagues claim to continue last season's — pick one`,
      };
    }
  }

  // A single league and nothing to compare it against is not evidence.
  if (!previous) {
    return {
      league: pool.length === 1 ? pool[0]! : null,
      confidence: pool.length === 1 ? 'likely' : 'ambiguous',
      candidates: [...pool],
      autoSelect: false,
      reason:
        pool.length === 1
          ? `one league for the new season: "${pool[0]!.name}"`
          : `${pool.length} leagues for the new season — pick one`,
    };
  }

  const scored = pool
    .map((league) => ({ league, score: similarity(previous, league) }))
    .sort((a, b) => b.score - a.score || (a.league.id < b.league.id ? -1 : 1));

  const best = scored[0]!;
  const runnerUp = scored[1] ?? null;

  /*
   * A weak best, or a best that is not clearly best, is a question.
   *
   * Two thresholds, both doing real work: a league that matches on nothing but
   * size is not a successor (0.6 requires the name or the scoring to agree
   * too), and a league that beats its rival by a hair is not distinguishable
   * from it (0.15 is roughly "one whole signal apart").
   */
  const decisive = best.score >= 0.6 && (!runnerUp || best.score - runnerUp.score >= 0.15);

  return {
    league: decisive ? best.league : null,
    confidence: decisive ? 'likely' : 'ambiguous',
    candidates: scored.map((s) => s.league),
    autoSelect: false,
    reason: decisive
      ? `"${best.league.name}" looks like the continuation of "${previous.name}"`
      : `more than one league could continue "${previous.name}" — pick one`,
  };
}

/**
 * How much two leagues look like the same league a year apart, in [0, 1].
 *
 * Name carries the most because it is the thing a commissioner keeps and a
 * coincidence is unlikely; size is worth little alone because half of all
 * leagues have twelve teams.
 */
function similarity(previous: LeagueLike, candidate: LeagueLike): number {
  let score = 0;
  if (normalise(previous.name) === normalise(candidate.name)) score += 0.55;
  else if (nameStem(previous.name) && nameStem(previous.name) === nameStem(candidate.name)) score += 0.4;
  if (previous.totalRosters === candidate.totalRosters) score += 0.2;
  if (previous.scoringLabel && previous.scoringLabel === candidate.scoringLabel) score += 0.25;
  return score;
}

/** Lower-cased, punctuation-free, whitespace-collapsed. */
function normalise(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * The name with a trailing year dropped.
 *
 * "The Junculator 2026" and "The Junculator 2027" are the same league, and the
 * only thing standing between them is the number somebody typed into the name.
 */
function nameStem(name: string): string {
  return normalise(name).replace(/\s*\b(19|20)\d{2}\b\s*$/, '').trim();
}

function nextSeasonOf(season: string): string {
  const n = Number.parseInt(season, 10);
  return Number.isFinite(n) ? String(n + 1) : season;
}
