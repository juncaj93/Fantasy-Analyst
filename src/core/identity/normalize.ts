/**
 * Name / team / position normalization.
 *
 * Rules (see docs/ARCHITECTURE.md):
 *  - Normalization is for LOOKUP ONLY. Display names are always preserved verbatim.
 *  - Normalization must be pure, deterministic and stable: the same input always
 *    produces the same key, because identity keys are persisted in the database.
 */

/** Generational suffixes stripped from lookup keys (never from display names). */
const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

/**
 * Normalize a person name for lookup.
 *
 * lowercase -> strip accents -> drop apostrophes -> punctuation to space ->
 * strip generational suffixes -> collapse whitespace.
 *
 *   "D'Andre Swift"      -> "dandre swift"
 *   "Marvin Harrison Jr." -> "marvin harrison"
 *   "Amon-Ra St. Brown"  -> "amon ra st brown"
 */
export function normalizeName(input: string): string {
  if (!input) return '';
  const stripped = input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    /*
     * Apostrophes are removed rather than spaced: "d'andre" -> "dandre".
     *
     * Every character a keyboard, a CMS or a copy-paste can produce where a
     * name means an apostrophe, because the ones missing from this class do not
     * fail loudly — they fall through to the separator rule below and become a
     * *space*, so `Jaʼmarr` keys as `ja marr chase` while `Ja'Marr` keys as
     * `jamarr chase`. Two keys for one player, in a function whose output is
     * persisted as an identity key.
     *
     * U+02BC (modifier letter apostrophe) and U+FF07 (fullwidth) were the two
     * that did that. U+2032 (prime) is here for the same reason: it is visually
     * indistinguishable in most fonts and is what some exports emit.
     */
    .replace(/[\u2018\u2019\u02bc\u02b9\uff07\u2032'`\u00b4]/g, '')
    // Everything else non-alphanumeric becomes a separator.
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  if (!stripped) return '';

  const tokens = stripped.split(' ');
  // Only strip suffixes from the tail, and never strip the only token
  // ("Vick Ballard" style single-token lookups must survive).
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1]!;
    if (NAME_SUFFIXES.has(last)) tokens.pop();
    else break;
  }
  return tokens.join(' ');
}

/** Last token of a normalized name, used for surname indexing. */
export function normalizedSurname(input: string): string {
  const n = normalizeName(input);
  if (!n) return '';
  const tokens = n.split(' ');
  return tokens[tokens.length - 1]!;
}

/** First token of a normalized name. */
export function normalizedFirstName(input: string): string {
  const n = normalizeName(input);
  if (!n) return '';
  return n.split(' ')[0]!;
}

/**
 * Given names that sources shorten, paired with their long form.
 *
 * Sleeper calls the Titans quarterback "Cam Ward"; ADP sources call him
 * "Cameron Ward". Four inserted characters is past any sane fuzzy threshold, so
 * without this the row simply finds nothing — which is how a first-round
 * quarterback ended up missing from the draft board entirely.
 *
 * Deliberately short and boring. This is not a nickname dictionary: it holds
 * only mechanical shortenings of the same name, never "Ken" for "Kenneth
 * Gainwell"-style guesses about who someone means. Anything less mechanical
 * belongs in the alias list the user controls.
 */
const GIVEN_NAME_PAIRS: [short: string, long: string][] = [
  ['cam', 'cameron'],
  ['chris', 'christopher'],
  ['dan', 'daniel'],
  ['dave', 'david'],
  ['greg', 'gregory'],
  ['jon', 'jonathan'],
  ['josh', 'joshua'],
  ['matt', 'matthew'],
  ['mike', 'michael'],
  ['nick', 'nicholas'],
  ['rob', 'robert'],
  ['sam', 'samuel'],
  ['tim', 'timothy'],
  ['tom', 'thomas'],
  ['tony', 'anthony'],
  ['will', 'william'],
  ['zach', 'zachary'],
];

const GIVEN_NAME_VARIANTS = new Map<string, string[]>();
for (const [short, long] of GIVEN_NAME_PAIRS) {
  GIVEN_NAME_VARIANTS.set(short, [...(GIVEN_NAME_VARIANTS.get(short) ?? []), long]);
  GIVEN_NAME_VARIANTS.set(long, [...(GIVEN_NAME_VARIANTS.get(long) ?? []), short]);
}

/**
 * Other spellings of the same name, differing only in the given name.
 *
 * Returns the alternatives, never the input itself, and an empty list when the
 * given name has no known long or short form.
 */
export function givenNameVariants(input: string): string[] {
  const n = normalizeName(input);
  const tokens = n.split(' ').filter(Boolean);
  if (tokens.length < 2) return [];
  const alternatives = GIVEN_NAME_VARIANTS.get(tokens[0]!);
  if (!alternatives) return [];
  const rest = tokens.slice(1).join(' ');
  return alternatives.map((given) => `${given} ${rest}`);
}

/**
 * "F. Last" / "F Last" initial form, e.g. "j jefferson" for Justin Jefferson.
 * Returns '' when the name has fewer than two tokens.
 */
export function initialForm(input: string): string {
  const n = normalizeName(input);
  const tokens = n.split(' ').filter(Boolean);
  if (tokens.length < 2) return '';
  return `${tokens[0]![0]} ${tokens.slice(1).join(' ')}`;
}

/**
 * Team abbreviation aliases. Sleeper is the canonical vocabulary; the values on
 * the right are what other sources emit.
 */
const TEAM_ALIASES: Record<string, string> = {
  JAC: 'JAX',
  JAG: 'JAX',
  LA: 'LAR',
  STL: 'LAR',
  SD: 'LAC',
  OAK: 'LV',
  LVR: 'LV',
  WSH: 'WAS',
  WFT: 'WAS',
  ARZ: 'ARI',
  BLT: 'BAL',
  CLV: 'CLE',
  HST: 'HOU',
  KAN: 'KC',
  KCC: 'KC',
  NOR: 'NO',
  NWE: 'NE',
  SFO: 'SF',
  TAM: 'TB',
  GNB: 'GB',
  NNY: 'NYG',
  FA: '',
  FREE: '',
  NONE: '',
};

/** Canonical Sleeper team codes. Empty string means "no team / free agent". */
export function normalizeTeam(input: string | null | undefined): string {
  if (!input) return '';
  const up = input.trim().toUpperCase().replace(/[^A-Z]/g, '');
  if (!up) return '';
  return TEAM_ALIASES[up] ?? up;
}

const POSITION_ALIASES: Record<string, string> = {
  PK: 'K',
  DST: 'DEF',
  'D/ST': 'DEF',
  DEFENSE: 'DEF',
  DS: 'DEF',
  HB: 'RB',
  FB: 'RB',
  WRTE: 'WR',
  PN: 'P',
};

/** Canonical fantasy position codes (QB/RB/WR/TE/K/DEF/...). */
export function normalizePosition(input: string | null | undefined): string {
  if (!input) return '';
  const up = input.trim().toUpperCase().replace(/[^A-Z/]/g, '');
  if (!up) return '';
  return POSITION_ALIASES[up] ?? up.replace(/\//g, '');
}

/**
 * Optimal string alignment (Damerau-Levenshtein) distance with an early-exit
 * bound. Used for fuzzy candidate generation only.
 *
 * Adjacent transpositions cost 1 rather than 2, because swapped letters
 * ("Nacau" for "Nacua") are the most common way a name gets miscopied.
 */
export function editDistance(a: string, b: string, max = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  // Three rolling rows: i-2, i-1 and the current one.
  let twoBack = new Array<number>(b.length + 1).fill(0);
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0]!;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, twoBack[j - 2]! + 1);
      }
      curr[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    const spare = twoBack;
    twoBack = prev;
    prev = curr;
    curr = spare;
  }
  return prev[b.length]!;
}
