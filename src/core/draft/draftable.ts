/**
 * Who belongs in a draft recommendation.
 *
 * The Draft board used to answer this by accident. It kept a player only if
 * some ranking had priced him, which excluded every unpriced current player —
 * about two hundred names in, three thousand out — and that was the ceiling the
 * deep-coverage work removed. Removing it was right. What went with it was the
 * only thing keeping retired players off the board, and they came straight
 * back.
 *
 * ## Why Sleeper cannot answer this on its own
 *
 * The obvious fixes do not work, and the evidence is worth keeping here so the
 * next person does not spend an afternoon rediscovering it. Sampled from the
 * live `api.sleeper.app/v1/players/nfl` dictionary in August 2025:
 *
 * | player        | `active` | `team` | `status` | `search_rank` | last played |
 * |---------------|----------|--------|----------|---------------|-------------|
 * | Chris Carson  | `true`   | `null` | `Active` | 200           | 2021        |
 * | Chase Edmonds | `true`   | `null` | `Active` | 253           | 2023        |
 * | Kareem Hunt   | `true`   | `null` | `Active` | 242           | 2024        |
 *
 * Carson has not taken a snap in four years. Hunt carried the ball two hundred
 * times last season and is an ordinary free agent somebody will sign. **Sleeper
 * records them identically.** `active` is true for all three, `status` says
 * "Active" for all three, neither has a team, and `search_rank` — which measures
 * who gets looked up, not who gets picked — puts the retired player *ahead* of
 * the current one. There is no flag to filter on, so filtering on one would be
 * guessing with the appearance of rigour.
 *
 * ## What does separate them
 *
 * Somebody is willing to price Hunt. A player with no NFL team **and** no price
 * from either market is a player no employer and no market has an opinion
 * about, and he is not a pick in anybody's draft.
 *
 * Deliberately an *and* of two absences, because either one alone is a perfectly
 * ordinary state:
 *
 *   - **On a team is enough.** Audric Estime (NO), Brashard Smith (KC) and
 *     J.J. McCarthy (MIN) were all in the reported cluster, all unpriced, and
 *     all genuinely draftable deep players. A rule that dropped them would be
 *     deleting the feature this pool exists for.
 *   - **Priced is enough**, by either market. This is what keeps the rule from
 *     collapsing into "exclude every free agent": a free agent the market has an
 *     opinion about keeps his place, which is exactly the case the brief calls
 *     out as one that must survive.
 *
 * It is also, deliberately, not a claim about quality. A draftable player with
 * no price still shows `ADP —`, `Val —`, `Next —` and an unknown Score; this
 * decides only whether he is on the board at all.
 *
 * ## Scope
 *
 * Recommendations only. Deep Players search reads the player table directly and
 * is not filtered by this — looking somebody up is not the same act as being
 * offered him with a clock running.
 */

/** The little this needs to know about a player. Anything richer also works. */
export interface DraftableInput {
  /** NFL team abbreviation, or null for a free agent. */
  team: string | null;
  /** Sleeper ADP for this league, when a ranking has priced him. */
  sleeperAdp: number | null;
  /** Raw Underdog ADP, when that market has priced him. */
  dogAdp: number | null;
}

/**
 * Could somebody actually draft this player?
 *
 * Pure, total, and name-free. There is no exclusion list here and there must
 * never be one: a rule that names players is a rule that stops working the day
 * after it is written.
 */
export function isDraftable(input: DraftableInput): boolean {
  return hasTeam(input.team) || priced(input.sleeperAdp) || priced(input.dogAdp);
}

/** Why he is on the board, for diagnostics and for the pool-health probe. */
export function draftableReason(input: DraftableInput): string {
  if (hasTeam(input.team)) return `on an NFL roster (${input.team})`;
  if (priced(input.sleeperAdp) && priced(input.dogAdp)) return 'a free agent both markets have priced';
  if (priced(input.sleeperAdp)) return 'a free agent Sleeper has priced';
  if (priced(input.dogAdp)) return 'a free agent Underdog has priced';
  return 'no NFL team and no market price';
}

/**
 * A team, and not the several ways a player can appear to have one.
 *
 * Sleeper writes `null` for a free agent, and the normalizer can produce an
 * empty string. `FA` is not a team either — some feeds spell free agency that
 * way, and treating it as a club would readmit exactly the players this exists
 * to keep out, on a technicality.
 */
function hasTeam(team: string | null | undefined): boolean {
  if (team == null) return false;
  const value = team.trim().toUpperCase();
  return value !== '' && value !== 'FA' && value !== 'NONE';
}

function priced(adp: number | null | undefined): boolean {
  return adp != null && Number.isFinite(adp);
}
