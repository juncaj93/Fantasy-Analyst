/**
 * beatadp.com — where Sleeper's ADP is actually readable.
 *
 * Sleeper does not publish ADP: every REST path 404s and the GraphQL schema has
 * no ADP field. beatadp.com collects it (alongside several other
 * platforms) and renders it for a chosen scoring format, draft type and QB
 * count — exactly the three things that decide whether a number applies to this
 * league.
 *
 * The page is a Next.js App Router render, so the table is not fetched from an
 * API: the server streams it into the HTML as RSC "flight" chunks pushed into
 * `self.__next_f`. Decoding those chunks yields the players verbatim, along
 * with the list of *slices* the page publishes — every combination of platform,
 * scoring format, draft type and QB count it holds ADP for.
 *
 * Every slice ships in one payload and each player's ADPs are keyed by slice
 * (`SLEEPER|HALF_PPR|REDRAFT|1QB`), so the caller does not ask the page to
 * filter and then hope it did: it names the slice it wants and takes the
 * numbers stored under that name. A slice the page does not publish is missing
 * rather than quietly substituted, which is the property that matters — a
 * half-PPR board built from full-PPR numbers looks perfectly correct.
 *
 * Nothing here runs at request time. A workflow fetches the page, converts it
 * with these functions, and imports the result as a frozen ADP snapshot, so the
 * app's draft board never depends on a third-party site being up mid-draft.
 */

/** One combination of platform and league format the page holds ADP for. */
export interface BeatAdpSlice {
  /** e.g. `SLEEPER`, `ESPN`, `YAHOO`, `FANTASYPROS`. */
  platform: string;
  /** e.g. `PPR`, `HALF_PPR`, `STANDARD`. */
  scoringFormat: string;
  /** e.g. `REDRAFT`, `DYNASTY`. */
  draftType: string;
  /** e.g. `1QB`, `2QB`. */
  qbType: string;
  /** The day the page says these numbers were recorded, `YYYY-MM-DD`. */
  recordedAt: string | null;
  /** How many players the page says this slice ranks. */
  playerCount: number | null;
}

export interface BeatAdpRow {
  name: string;
  position: string | null;
  team: string | null;
  /** ADP by slice, keyed as the page keys it (`SLEEPER|HALF_PPR|REDRAFT|1QB`). */
  adps: Record<string, number>;
}

export interface BeatAdpPage {
  /** Every slice the page publishes, in the order it lists them. */
  slices: BeatAdpSlice[];
  rows: BeatAdpRow[];
}

/** The platform this app wants. Sleeper is the league host, so it is the one. */
export const SLEEPER_PLATFORM = 'SLEEPER';

/**
 * Rebuild the RSC payload from the chunks the page pushes into `self.__next_f`.
 *
 * Each chunk is a JavaScript string literal, so decoding is just JSON string
 * parsing. A chunk that will not decode is skipped rather than aborting the
 * whole payload: the rows live in one contiguous chunk sequence, and an
 * unrelated malformed chunk should not cost us the table.
 */
export function decodeFlight(html: string): string {
  const chunks = html.matchAll(/self\.__next_f\.push\(\[1,\s*("(?:[^"\\]|\\.)*")\]\)/g);
  let out = '';
  for (const match of chunks) {
    try {
      out += JSON.parse(match[1]!) as string;
    } catch {
      // Not a decodable string literal; the remaining chunks still are.
    }
  }
  return out;
}

/**
 * Read one complete JSON value starting at `start`, respecting strings and
 * escapes so a brace inside a player name cannot end the value early.
 *
 * Returns null when the value is truncated — the flight payload is streamed, so
 * a partial final chunk is a real possibility rather than a theoretical one.
 */
export function sliceJsonValue(text: string, start: number): string | null {
  const open = text[start];
  if (open !== '[' && open !== '{') return null;
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseAt(flight: string, key: string): unknown {
  const marker = `"${key}":`;
  let from = 0;
  for (;;) {
    const at = flight.indexOf(marker, from);
    if (at < 0) return null;
    const valueAt = at + marker.length;
    const slice = sliceJsonValue(flight, valueAt);
    if (slice) {
      try {
        return JSON.parse(slice) as unknown;
      } catch {
        // Keep looking: an earlier occurrence may be a different, unrelated key.
      }
    }
    from = at + marker.length;
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The name a slice's ADP numbers are stored under, on the page and here.
 *
 * Building it from the four parts rather than pasting a string together at each
 * call site is the whole point: the key *is* the format check, so there is one
 * place that decides how it is spelled.
 */
export function sliceKey(slice: {
  platform: string;
  scoringFormat: string;
  draftType: string;
  qbType: string;
}): string {
  return [slice.platform, slice.scoringFormat, slice.draftType, slice.qbType]
    .map((part) => part.trim().toUpperCase())
    .join('|');
}

/**
 * The published slice matching the one asked for, or null when the page does
 * not publish it. Null is an answer, not a failure to look: a caller must not
 * fall back to a neighbouring format.
 */
export function findSlice(
  slices: readonly BeatAdpSlice[],
  wanted: { platform: string; scoringFormat: string; draftType: string; qbType: string },
): BeatAdpSlice | null {
  const key = sliceKey(wanted);
  return slices.find((slice) => sliceKey(slice) === key) ?? null;
}

/**
 * Parse a fetched platform-ADP page into the slices it publishes and its rows.
 *
 * Both come back as the page states them. Nothing here decides which slice
 * applies to a league — that is `findSlice` and the caller's business — and a
 * page whose payload has changed shape again yields no slices and no rows
 * rather than a plausible-looking half of one.
 */
export function parseBeatAdpPage(html: string): BeatAdpPage {
  const flight = decodeFlight(html);

  const rawSlices = parseAt(flight, 'slices');
  const slices: BeatAdpSlice[] = [];
  if (Array.isArray(rawSlices)) {
    for (const entry of rawSlices) {
      const rec = entry as Record<string, unknown> | null;
      const platform = str(rec?.['platform']);
      const scoringFormat = str(rec?.['scoringFormat']);
      const draftType = str(rec?.['draftType']);
      const qbType = str(rec?.['qbType']);
      // All four name the slice. One missing makes it unidentifiable, and an
      // unidentifiable slice is worse than no slice.
      if (!platform || !scoringFormat || !draftType || !qbType) continue;
      slices.push({
        platform,
        scoringFormat,
        draftType,
        qbType,
        recordedAt: str(rec?.['recordedAt']),
        playerCount: num(rec?.['playerCount']),
      });
    }
  }

  const rawPlayers = parseAt(flight, 'players');
  const rows: BeatAdpRow[] = [];
  if (Array.isArray(rawPlayers)) {
    for (const entry of rawPlayers) {
      const rec = entry as Record<string, unknown> | null;
      const name = str(rec?.['fullName']);
      if (!name) continue;

      const adps: Record<string, number> = {};
      const rawAdps = (rec?.['adps'] ?? null) as Record<string, unknown> | null;
      for (const [key, value] of Object.entries(rawAdps ?? {})) {
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
          adps[key.toUpperCase()] = value;
        }
      }

      rows.push({
        name,
        position: str(rec?.['position']),
        team: str(rec?.['teamId']),
        adps,
      });
    }
  }

  return { slices, rows };
}

/**
 * Convert parsed rows into the JSON the ADP importer already understands.
 *
 * `key` names one slice — `SLEEPER|HALF_PPR|REDRAFT|1QB` — and only the numbers
 * stored under it are read. Only players that slice actually ranks are
 * included: a player it has no ADP for is not a player with a bad ADP, and
 * inventing one (from another platform, another format, or the consensus) would
 * silently mix sources inside a single snapshot.
 *
 * `rank` is derived from the ADP ordering rather than taken from the page,
 * because the page's row order follows whichever column the reader sorted by.
 */
export function toAdpImportFile(rows: BeatAdpRow[], sliceName: string): string {
  const key = sliceName.trim().toUpperCase();
  const ranked = rows
    .filter((row) => typeof row.adps[key] === 'number')
    .sort((a, b) => a.adps[key]! - b.adps[key]!)
    .map((row, i) => ({
      name: row.name,
      team: row.team ?? '',
      position: row.position ?? '',
      adp: row.adps[key]!,
      rank: i + 1,
    }));
  return JSON.stringify(ranked, null, 2);
}
