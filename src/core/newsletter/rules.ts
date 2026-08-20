/**
 * Editable newsletter classification rules.
 *
 * This file is DATA, not logic. `classify.ts` contains the single evaluation
 * algorithm; every phrase family lives here so rules can be added, retuned or
 * disabled without touching the engine.
 *
 * Magnitude policy (docs/01_DATA_MODEL.md says not to invent magnitude rules):
 *   1 = default for every rule
 *   2 = "meaningful" — an explicit, documented role/health change
 *   3 = "major" — season-altering (season-ending injury, suspension, surgery,
 *       outright named starter/benching)
 * Anything not explicitly listed as 2 or 3 stays at 1.
 */

export type Polarity = 'positive' | 'negative' | 'neutral' | 'mixed' | 'uncertain';

export type EvidenceCategory =
  | 'injury'
  | 'health'
  | 'practice'
  | 'role'
  | 'usage'
  | 'depth_chart'
  | 'competition'
  | 'transaction'
  | 'performance'
  | 'suspension'
  | 'coach_comment'
  | 'other';

export interface ClassificationRule {
  id: string;
  category: EvidenceCategory;
  polarity: 'positive' | 'negative';
  magnitude: 1 | 2 | 3;
  /** Regex source, matched case-insensitively against a single sentence. */
  pattern: RegExp;
  /**
   * Deterministic context template. Rendered with `{player}` only — never
   * generated prose. When absent, a truncated excerpt is stored instead.
   */
  template?: string;
  /**
   * The pattern already encodes its own negation ("did not practice"), so the
   * negation scanner must not flip it a second time.
   */
  selfNegating?: boolean;
  /** Rule is disabled without deleting it (keeps historical `rule_id` valid). */
  enabled?: boolean;
}

/**
 * Negation cues. Matched in a bounded token window immediately before a rule
 * hit, stopping at clause boundaries.
 */
export const NEGATION_CUES: RegExp[] = [
  /\bnot\b/i,
  /\bn't\b/i,
  /\bno\b/i,
  /\bnever\b/i,
  /\bno longer\b/i,
  /\bwithout\b/i,
  /\bavoided\b/i,
  /\bunlikely to\b/i,
  /\bdenied\b/i,
  /\bdispelled\b/i,
];

/** Words that terminate a negation scan: negation does not cross these. */
export const CLAUSE_BOUNDARIES = /[,;:]|\b(but|although|though|while|however|despite|yet|because)\b/i;

/** How many tokens before a match are scanned for a negation cue. */
export const NEGATION_WINDOW_TOKENS = 5;

/** Hedging language that caps confidence at `medium`. */
export const HEDGE_PATTERNS: RegExp[] = [
  /\bcould\b/i,
  /\bmay\b/i,
  /\bmight\b/i,
  /\bif\b/i,
  /\breportedly\b/i,
  /\brumor(ed|s)?\b/i,
  /\bspeculat(e|ion|ing)\b/i,
  /\bpotentially\b/i,
  /\bappears? to\b/i,
  /\bsome\b/i,
  /\bshould\b/i,
  /\bexpected to (?:be )?(?:possibly|maybe)\b/i,
];

/** Contrast connectives that make a sentence a candidate for `mixed`. */
export const CONTRAST_PATTERNS: RegExp[] = [
  /\bbut\b/i,
  /\bhowever\b/i,
  /\balthough\b/i,
  /\bthough\b/i,
  /\bdespite\b/i,
  /\bwhile\b/i,
  /\bon the other hand\b/i,
];

export const POSITIVE_RULES: ClassificationRule[] = [
  {
    id: 'pos.named_starter',
    category: 'depth_chart',
    polarity: 'positive',
    magnitude: 3,
    pattern: /\b(named|will be|is) the (starter|starting (qb|rb|wr|te|quarterback|running back|receiver|tight end))\b|\bnamed (the )?starter\b|\bwon the (starting )?(job|role|competition)\b/i,
    template: 'Named the starter.',
  },
  {
    id: 'pos.promoted',
    category: 'depth_chart',
    polarity: 'positive',
    /**
     * Movement UP THE DEPTH CHART, which is not the same as movement upward.
     *
     * This used to accept the bare verbs `climbed`, `moved up` and `elevated`.
     * On a real issue that made "Cyrus Allen climbed the ladder to get that
     * one" — a highlight caption for a leaping catch, sitting in the fun-stuff
     * section between a fan sneaking into camp and a Madden rating — the single
     * signal the whole newsletter produced, auto-applied at high confidence.
     *
     * So the loose verbs now need a depth chart to climb, and `elevated` needs
     * something to be elevated to: a player elevates his game, and it means
     * nothing about his role. `promoted` stays bare because in football writing
     * it reliably means the depth chart, and the practice-squad exclusion it
     * already carried stays with it — a practice-squad elevation is a roster
     * mechanic, not a promotion.
     */
    magnitude: 2,
    pattern:
      /\b(?:(?:was|been|officially)\s+)?promoted\b(?![^.]*\bpractice squad\b)|\belevated to\b(?![^.]*\bpractice squad\b)|\b(?:climbed|moved up|jumped|leapfrogged|worked his way up|moving up)\b[^.]{0,40}\bdepth chart\b|\bup the depth chart\b/i,
    template: 'Promoted on the depth chart.',
  },
  {
    id: 'pos.first_team_reps',
    category: 'role',
    polarity: 'positive',
    magnitude: 2,
    pattern: /\b(first[- ]team|1st[- ]team|starters?'? )\s?reps\b|\bworking with the (first|ones|1s)\b|\breps with the (first team|starters|ones)\b/i,
    template: 'Taking first-team reps.',
  },
  {
    id: 'pos.expected_to_lead',
    category: 'role',
    polarity: 'positive',
    magnitude: 2,
    pattern: /\bexpected to (lead|handle|see the (bulk|majority)|be the (lead|primary|featured|main))\b|\bset to (lead|start)\b|\bin line (for|to) (the )?(lead|starting|featured)\b/i,
    template: 'Expected to lead the position group.',
  },
  {
    id: 'pos.increased_workload',
    category: 'usage',
    polarity: 'positive',
    magnitude: 2,
    pattern: /\b(increased|expanded|larger|bigger|heavier|more) (workload|role|usage|snaps?|touches|target share|opportunit(y|ies))\b|\bworkload (is )?(increasing|growing)\b|\bmore involved\b/i,
    template: 'Workload increasing.',
  },
  {
    id: 'pos.expanded_role',
    category: 'role',
    polarity: 'positive',
    magnitude: 2,
    pattern: /\b(expanded|bigger|larger|added|new) role\b|\brole (is )?(expanding|growing)\b/i,
    template: 'Role expanding.',
  },
  {
    id: 'pos.cleared',
    category: 'health',
    polarity: 'positive',
    magnitude: 2,
    pattern: /\b(cleared|activated off|activated from|passed his physical|off the injury report|out of the concussion protocol|cleared concussion protocol)\b/i,
    template: 'Cleared to play.',
  },
  {
    id: 'pos.returned_to_practice',
    category: 'practice',
    polarity: 'positive',
    magnitude: 2,
    pattern: /\b(returned to|back (at|to|in)) (full )?practice\b|\b(practiced|participated) in full\b|\bfull (practice )?participant\b|\bfull go\b/i,
    template: 'Returned to practice.',
  },
  {
    id: 'pos.healthy',
    category: 'health',
    polarity: 'positive',
    magnitude: 1,
    pattern: /\b(is |looks |appears |fully )?(healthy|100 ?%|full(y)? recovered|no restrictions)\b/i,
    template: 'Reported healthy.',
  },
  {
    id: 'pos.extension',
    category: 'transaction',
    polarity: 'positive',
    magnitude: 1,
    pattern: /\b(signed|agreed to|received) (a |an )?(contract )?(extension|new deal|multi-?year)\b|\bextension\b/i,
    template: 'Signed a contract extension.',
  },
  {
    id: 'pos.featured',
    category: 'role',
    polarity: 'positive',
    magnitude: 2,
    pattern: /\b(featured|focal point|centerpiece|bell[- ]?cow|workhorse|every[- ]down (back|player)|three[- ]down (back|role))\b/i,
    template: 'Featured in the offense.',
  },
  {
    id: 'pos.goal_line',
    category: 'usage',
    polarity: 'positive',
    magnitude: 2,
    pattern: /\b(goal[- ]?line|short[- ]?yardage|red[- ]?zone) (work|role|back|touches|looks|usage|carries)\b|\bwill handle (the )?goal[- ]?line\b/i,
    template: 'Handling goal-line work.',
  },
  {
    id: 'pos.receiving_work',
    category: 'usage',
    polarity: 'positive',
    magnitude: 1,
    pattern: /\b(receiving|passing[- ]down|third[- ]down) (work|role|back|snaps|usage)\b|\b(more|increased) (targets|receptions|routes)\b|\brunning more routes\b/i,
    template: 'Seeing receiving work.',
  },
  {
    id: 'pos.coach_praise',
    category: 'coach_comment',
    polarity: 'positive',
    magnitude: 1,
    pattern: /\b(coach|staff|coaching staff|head coach|oc|offensive coordinator)[^.]{0,40}\b(prais(ed|ing)|rav(ed|ing)|complimented|high on|impressed (by|with)|loves?)\b|\bdrawing (rave )?reviews\b|\bearned praise\b/i,
    template: 'Praised by the coaching staff.',
  },
  {
    id: 'pos.standout_camp',
    category: 'performance',
    polarity: 'positive',
    magnitude: 1,
    pattern: /\b(standout|star(ring|red)?|shining|impressive|strong|best) (camp|training camp|offseason|preseason|showing)\b|\b(camp|preseason) standout\b|\bturning heads\b|\bstanding out\b/i,
    template: 'Standout camp performance.',
  },
  {
    id: 'pos.breakout',
    category: 'performance',
    polarity: 'positive',
    magnitude: 1,
    pattern: /\bbreak[- ]?out\b|\bbreaking out\b|\bleap\b|\btak(ing|en) a (big )?step (forward|up)\b/i,
    template: 'Breakout signal.',
  },
  {
    id: 'pos.no_longer_limited',
    category: 'practice',
    polarity: 'positive',
    magnitude: 1,
    pattern: /\bno longer (limited|on the injury report|listed)\b|\bremoved from the injury report\b/i,
    template: 'No longer limited.',
    selfNegating: true,
  },
  {
    id: 'pos.no_missed_time',
    category: 'health',
    polarity: 'positive',
    magnitude: 1,
    pattern: /\b(not expected to miss (any )?time|won'?t miss (any )?time|no missed time|avoided (a )?(serious|significant) injury|no structural damage|dodged a bullet)\b/i,
    template: 'Not expected to miss time.',
    selfNegating: true,
  },
  {
    id: 'pos.not_concerned',
    category: 'health',
    polarity: 'positive',
    magnitude: 1,
    pattern: /\b((is|are|team is|staff is)? ?not concerned|no concern|is ?n't concerned|downplayed the (injury|concern))\b/i,
    template: 'Team is not concerned.',
    selfNegating: true,
  },
];

export const NEGATIVE_RULES: ClassificationRule[] = [
  {
    id: 'neg.season_ending',
    category: 'injury',
    polarity: 'negative',
    magnitude: 3,
    pattern: /\b(season[- ]ending|out for the (season|year)|torn (acl|achilles|patellar|pectoral)|ruptured|placed on (injured reserve|ir)\b|\bir\b)/i,
    template: 'Season-ending injury.',
  },
  {
    id: 'neg.surgery',
    category: 'injury',
    polarity: 'negative',
    magnitude: 3,
    pattern: /\b(surgery|underwent (a )?procedure|will have (an? )?operation|scoped)\b/i,
    template: 'Undergoing surgery.',
  },
  {
    id: 'neg.suspended',
    category: 'suspension',
    polarity: 'negative',
    magnitude: 3,
    pattern: /\b(suspend(ed|sion)|banned for|violation of the (league'?s )?(substance|performance|personal conduct) policy)\b/i,
    template: 'Suspension announced.',
  },
  {
    id: 'neg.injured',
    category: 'injury',
    polarity: 'negative',
    magnitude: 2,
    pattern: /\b(injur(ed|y)|strained?|sprain(ed)?|hamstring|groin|high[- ]ankle|concussion|fracture(d)?|broken)\b/i,
    template: 'Dealing with an injury.',
  },
  {
    id: 'neg.setback',
    category: 'injury',
    polarity: 'negative',
    magnitude: 2,
    pattern: /\b(setback|re-?aggravated|re-?injured|flare[- ]?up|not progressing|slower than expected)\b/i,
    template: 'Suffered a setback.',
  },
  {
    id: 'neg.out',
    category: 'injury',
    polarity: 'negative',
    magnitude: 2,
    pattern: /\b(ruled out|will (miss|sit)|expected to miss|out (this week|for|indefinitely)|sidelined)\b/i,
    template: 'Expected to miss time.',
  },
  {
    id: 'neg.did_not_practice',
    category: 'practice',
    polarity: 'negative',
    magnitude: 2,
    pattern: /\b(did ?n[o']?t practice|did not participate|dnp\b|missed (practice|another practice|multiple practices)|sat out (of )?practice|held out of practice)\b/i,
    template: 'Did not practice.',
    selfNegating: true,
  },
  {
    id: 'neg.limited',
    category: 'practice',
    polarity: 'negative',
    magnitude: 1,
    pattern: /\b(limited (in )?(practice|participant|participation)?|limited)\b/i,
    template: 'Limited in practice.',
  },
  {
    id: 'neg.demoted',
    category: 'depth_chart',
    polarity: 'negative',
    magnitude: 3,
    pattern: /\b(demot(ed|ion)|benched|lost the (starting )?(job|role)|dropped (down|to)|fell (down|to) (the )?(second|third|depth))\b/i,
    template: 'Demoted on the depth chart.',
  },
  {
    id: 'neg.backup',
    category: 'depth_chart',
    polarity: 'negative',
    magnitude: 2,
    pattern: /\b(backup|second[- ]?string|third[- ]?string|behind [A-Z][a-z]+|buried on the depth chart|with the (twos|2s|second team))\b/i,
    template: 'Working as a backup.',
  },
  {
    id: 'neg.lost_reps',
    category: 'role',
    polarity: 'negative',
    magnitude: 2,
    pattern: /\b(lost (reps|snaps|work|touches)|fewer (reps|snaps|touches|targets)|reps (have )?(declin|decreas)(ed|ing))\b/i,
    template: 'Losing reps.',
  },
  {
    id: 'neg.committee',
    category: 'usage',
    polarity: 'negative',
    magnitude: 2,
    pattern: /\b(committee|split(ting)? (work|carries|snaps|touches|time)|timeshare|rotation(al)?|by committee|share (the )?(backfield|workload))\b/i,
    template: 'Role may be limited by committee usage.',
  },
  {
    id: 'neg.snap_reduction',
    category: 'usage',
    polarity: 'negative',
    magnitude: 2,
    pattern: /\b(snap (count )?(reduction|decrease)|reduced (snaps|role|workload|usage)|snap share (dropp|declin)(ed|ing)|scaled back)\b/i,
    template: 'Snap share reduced.',
  },
  {
    id: 'neg.struggling',
    category: 'performance',
    polarity: 'negative',
    magnitude: 1,
    pattern: /\b(struggl(ed|ing|es)|poor (camp|showing|performance)|dropped passes|drop issues|inconsistent|underwhelming|disappointing)\b/i,
    template: 'Struggling.',
  },
  {
    id: 'neg.competition',
    category: 'competition',
    polarity: 'negative',
    magnitude: 1,
    pattern: /\b(competition (is )?(increasing|heating up|added)|open competition|pushing (him )?for (the )?(job|role|snaps)|drafted (a|another)|signed (a|another) (veteran|rb|wr|te|qb)|challenging (him )?for)\b/i,
    template: 'Competition increasing.',
  },
  {
    id: 'neg.questionable_role',
    category: 'role',
    polarity: 'negative',
    magnitude: 1,
    pattern: /\b(role (is )?(unclear|uncertain|in question|murky)|unclear (role|path to (snaps|touches))|questionable role|no defined role)\b/i,
    template: 'Role unclear.',
  },
  {
    id: 'neg.holdout',
    category: 'transaction',
    polarity: 'negative',
    magnitude: 2,
    pattern: /\b(hold[- ]?out|holding out|contract dispute|trade request|requested a trade|hold[- ]?in)\b/i,
    template: 'Contract/holdout situation.',
  },
  {
    id: 'neg.questionable_tag',
    category: 'injury',
    polarity: 'negative',
    magnitude: 1,
    pattern: /\b(listed as (questionable|doubtful)|game[- ]time decision|questionable for)\b/i,
    template: 'Listed as questionable.',
  },
  {
    id: 'neg.concern',
    category: 'health',
    polarity: 'negative',
    magnitude: 1,
    pattern: /\b(concern(ed|s|ing)?|worried|worry|banged up|nagging)\b/i,
    template: 'Reported concern.',
  },
];

export const ALL_RULES: ClassificationRule[] = [...POSITIVE_RULES, ...NEGATIVE_RULES];

export function activeRules(rules: ClassificationRule[] = ALL_RULES): ClassificationRule[] {
  return rules.filter((r) => r.enabled !== false);
}

export function ruleById(id: string, rules: ClassificationRule[] = ALL_RULES): ClassificationRule | undefined {
  return rules.find((r) => r.id === id);
}
