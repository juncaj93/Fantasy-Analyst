/**
 * Cache keys that cannot collide across a rollover.
 *
 * The requirement in one line: **Week 3 2026 and Week 3 2027 must never be the
 * same key.** Most of this app's storage already satisfies it structurally —
 * `player_injury_reports` is keyed `(player_id, season, week)`,
 * `player_usage_weeks` likewise, `injury_source_state` is `(source, season)` —
 * because those tables were designed after the lesson had been learned once.
 *
 * What is *not* structurally safe is anything keyed by a string somebody built
 * by hand: setting keys, in-memory memo maps, ETag/fingerprint labels, the
 * names in the sync log. Those are the ones that quietly work for a year and
 * then serve a 2026 answer to a 2027 question, and the failure is invisible
 * because the value looks perfectly well-formed — it is just a year old.
 *
 * So keys get built here or not at all. Every function takes the season as its
 * first argument, positionally, so a caller physically cannot forget it: the
 * type checker rejects `injuryKey('reports')` before anybody has to notice that
 * the key it would have produced is the same one next season will produce.
 *
 * The format is deliberately readable — `injury:2027:reports:w3` — because
 * these end up in a settings table a human reads during a rollover, and a
 * hashed key would turn "is this last season's?" into an unanswerable question
 * at exactly the moment somebody needs to answer it.
 */

/** The separator. Colons, because no season, source or week contains one. */
const SEP = ':';

function part(value: string | number | null | undefined): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  // A component containing the separator would make the key ambiguous, which is
  // the one thing this module exists to prevent. Substitute rather than throw:
  // a mangled-but-unique key beats an exception thrown from a cache read.
  return text.replace(/:/g, '_');
}

/**
 * A season-scoped key from ordered components.
 *
 * `seasonKey('2027', 'injury', 'reports', 3)` -> `"2027:injury:reports:3"`.
 * Nullish components are dropped, so an optional week does not leave a hole.
 */
export function seasonKey(season: string, ...components: (string | number | null | undefined)[]): string {
  const head = part(season) ?? 'unknown';
  const tail = components.map(part).filter((c): c is string => c != null);
  return [head, ...tail].join(SEP);
}

/**
 * The season a key was built for, or null if it was not built by `seasonKey`.
 *
 * The inverse matters as much as the forward direction. Sweeping last season's
 * entries out of a key/value store at rollover means being able to look at a
 * key and say which season it belongs to, and a store that cannot answer that
 * can only be cleared wholesale — which would also throw away the manager
 * tendencies §2 says to carry forward.
 */
export function seasonOfKey(key: string): string | null {
  const head = key.split(SEP, 1)[0] ?? '';
  return /^\d{4}$/.test(head) ? head : null;
}

/**
 * Whether `key` belongs to a season other than `season`.
 *
 * Keys with no season prefix answer `false`: they are not this season's, but
 * they are not last season's either, and a rollover sweep must not delete
 * something it does not understand.
 */
export function isForeignSeasonKey(key: string, season: string): boolean {
  const owner = seasonOfKey(key);
  return owner != null && owner !== season;
}

/**
 * Week-scoped key. The week is required and folded into the key, so the
 * two-argument mistake — a weekly value stored under a season-only key, then
 * read back next week — cannot compile.
 */
export function weekKey(season: string, week: number, ...components: (string | number | null | undefined)[]): string {
  return seasonKey(season, ...components, `w${week}`);
}

/**
 * Key for anything scoped to one league in one season.
 *
 * League ids are already unique across seasons on Sleeper — a 2027 league gets
 * a new id — but they are not *legible*, and a key that reads
 * `2027:league:1180…:roster` tells a human at a glance what a bare id would not.
 * The season also makes the sweep in `isForeignSeasonKey` work on league data,
 * which a bare id would not.
 */
export function leagueKey(
  season: string,
  leagueId: string,
  ...components: (string | number | null | undefined)[]
): string {
  return seasonKey(season, 'league', leagueId, ...components);
}

/**
 * Key for a per-source ingest fact: fingerprints, last-checked stamps, notes.
 *
 * The one that would have broken. A source whose state was stored under
 * `"injury.fingerprint"` would, on the first 2027 tick, send 2026's ETag as
 * `If-None-Match` against the 2027 file — and get a 200 with the whole file,
 * every time, forever, because the validator can never match. Cheap in August,
 * expensive in November, and silent throughout.
 */
export function sourceKey(season: string, source: string, ...components: (string | number | null | undefined)[]): string {
  return seasonKey(season, 'source', source, ...components);
}
