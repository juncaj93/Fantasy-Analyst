/**
 * A player's current availability, and whether his history is worth a line.
 *
 * Two separate questions that both look like "injury", kept apart on purpose:
 *
 *   - **status** is what Sleeper says about him right now — Questionable, Out,
 *     IR. It is a fact from the league host, it is short, and it belongs on the
 *     collapsed card because it changes a pick before anything is expanded.
 *   - **history** is whether he is coming back from something that still shapes
 *     this season. That is not a field anywhere; it is a sentence someone wrote,
 *     and the only honest way to have it is to find it in text the app already
 *     holds.
 *
 * Neither touches the ranking. This module is read by the screen and by the
 * player-detail service, and by nothing that scores anybody — surfacing a status
 * the engine already accounts for elsewhere would be counting it twice.
 */

export type InjuryTone = 'caution' | 'serious' | 'out';

export interface InjuryStatusTag {
  /** `Q`, `D`, `OUT`, `IR`, `PUP`, `SUS`. Short enough for a dense row. */
  code: string;
  /** The full word, for the accessible name and the tooltip. */
  label: string;
  tone: InjuryTone;
}

/**
 * Sleeper's status vocabulary, mapped to something a row can carry.
 *
 * The list is closed on purpose. Sleeper's `injury_status` is a small set, and
 * an unrecognised value is left untagged rather than printed raw — a badge
 * reading `COV` or `DNR` on a draft board is noise, and inventing a severity for
 * a string nobody has seen is worse.
 */
const STATUS_TAGS: Record<string, InjuryStatusTag> = {
  QUESTIONABLE: { code: 'Q', label: 'Questionable', tone: 'caution' },
  DOUBTFUL: { code: 'D', label: 'Doubtful', tone: 'serious' },
  OUT: { code: 'OUT', label: 'Out', tone: 'out' },
  IR: { code: 'IR', label: 'Injured reserve', tone: 'out' },
  'INJURED RESERVE': { code: 'IR', label: 'Injured reserve', tone: 'out' },
  PUP: { code: 'PUP', label: 'Physically unable to perform', tone: 'out' },
  SUS: { code: 'SUS', label: 'Suspended', tone: 'out' },
  SUSPENDED: { code: 'SUS', label: 'Suspended', tone: 'out' },
};

/**
 * The tag for a player's current status, or `null` when there is nothing to say.
 *
 * `null` covers the overwhelming majority: a healthy player has no tag, and a
 * board where every row carries a badge is a board where the badge means
 * nothing. Note that the canonical `status` field falls back to Sleeper's roster
 * status when there is no injury, so `Active` arrives here constantly and must
 * come back untagged.
 */
export function injuryStatusTag(status: string | null | undefined): InjuryStatusTag | null {
  if (!status) return null;
  return STATUS_TAGS[status.trim().toUpperCase()] ?? null;
}

/**
 * Major injuries worth naming, and the words that actually identify them.
 *
 * Every entry is a specific diagnosis or procedure. That is the whole test for
 * inclusion: "missed time", "limited", "banged up" and "did not practice" are
 * deliberately absent, because a player who missed four games with something
 * nobody named does not have a major injury history — he has a gap in a game
 * log, and calling that an ACL is exactly the fabrication this project refuses.
 */
const MAJOR_INJURIES: { label: string; patterns: RegExp[] }[] = [
  { label: 'ACL', patterns: [/\bACL\b/, /\banterior cruciate\b/i] },
  { label: 'Achilles', patterns: [/\bachilles\b/i] },
  { label: 'Lisfranc', patterns: [/\blisfranc\b/i] },
  { label: 'MCL', patterns: [/\bMCL\b/, /\bmedial collateral\b/i] },
  { label: 'patellar tendon', patterns: [/\bpatellar\b/i] },
  { label: 'torn labrum', patterns: [/\blabrum\b/i] },
  { label: 'ruptured quad', patterns: [/\bquad(riceps)? (tear|rupture)/i, /\btorn quad/i] },
  { label: 'broken leg', patterns: [/\b(broken|fractured) (leg|tibia|fibula|femur)\b/i] },
  { label: 'broken foot', patterns: [/\b(broken|fractured) (foot|metatarsal|jones)\b/i] },
  { label: 'broken collarbone', patterns: [/\b(broken|fractured) (collarbone|clavicle)\b/i] },
  { label: 'shoulder surgery', patterns: [/\bshoulder surgery\b/i] },
  { label: 'back surgery', patterns: [/\bback surgery\b/i] },
  { label: 'neck surgery', patterns: [/\bneck surgery\b/i] },
  { label: 'knee surgery', patterns: [/\bknee surgery\b/i, /\bmicrofracture\b/i] },
  { label: 'ankle surgery', patterns: [/\bankle surgery\b/i] },
  { label: 'hip surgery', patterns: [/\bhip surgery\b/i] },
  { label: 'concussions', patterns: [/\bconcussions\b/i, /\bconcussion history\b/i] },
];

export interface InjuryHistory {
  /** What was found, deduplicated and in the order the list defines. */
  injuries: string[];
  /** `Major injury history: ACL, shoulder surgery` — one line, never a story. */
  line: string;
}

/**
 * Name the major injuries a piece of supported text explicitly mentions.
 *
 * This does not summarise, infer or diagnose. It reports which of a closed list
 * of named injuries appear in text the app already has — which is why the
 * output is a list of labels and not a sentence of its own. Everything the
 * reader needs beyond the label is in the outlook above it, in the words of
 * whoever wrote it.
 *
 * Returns `null` when nothing named is present, which is the normal answer, and
 * the card then renders no section at all rather than an empty heading.
 */
export function majorInjuryHistory(text: string | null | undefined): InjuryHistory | null {
  if (!text) return null;
  const found: string[] = [];
  for (const injury of MAJOR_INJURIES) {
    if (injury.patterns.some((p) => p.test(text))) found.push(injury.label);
  }
  if (found.length === 0) return null;
  // Two is already the edge of useful on one line; a third is a medical history.
  const shown = found.slice(0, 2);
  return { injuries: found, line: `Major injury history: ${shown.join(', ')}` };
}
