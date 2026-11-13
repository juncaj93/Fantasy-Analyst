/**
 * Each sportsbook's latest game total and spread, per game, from every source
 * (Round 23).
 *
 * The books arrive from different odds APIs at different times (SportsGameOdds
 * at its kickoff-clock looks, TheRundown hourly, The Odds API every eight
 * hours), so averaging them needs a memory of what each book last said and when.
 * That memory is one settings row, read once and written once per pass: a few
 * dozen writes a day against an allowance of 100,000. The game's own row in
 * `vegas_events` is what every screen reads, and it is written only when the
 * combined total or spread actually changes.
 *
 * Games are dropped from the row a day after kickoff, so it stays small (a
 * week's games, a dozen books each: about 15 KB).
 */

import { bookKey, combineGameLines, type CombinedGameLines, type GameBookLine } from '../../core/vegas/combine.ts';
import type { Database } from '../db.ts';
import { SETTING_KEYS, SettingsRepo } from './settings.ts';
import { VegasEventsRepo, type VegasEventRow } from './vegasEvents.ts';

export interface GameBookEntry {
  kickoff: string | null;
  /** The game's two sides in the app's team codes, when a source named them. */
  teams: string[];
  books: GameBookLine[];
}

export type GameBooks = Record<string, GameBookEntry>;

const DAY = 86_400_000;

/** Add one source's books for a game: a book's newer quote replaces its older one. */
export function mergeGameBooks(
  entry: GameBookEntry | undefined,
  incoming: readonly GameBookLine[],
  extra: { kickoff?: string | null; teams?: readonly string[] } = {},
): GameBookEntry {
  const byBook = new Map<string, GameBookLine>();
  for (const b of entry?.books ?? []) byBook.set(bookKey(b.book), b);
  for (const b of incoming) {
    const k = bookKey(b.book);
    const held = byBook.get(k);
    if (!held || Date.parse(b.at) >= Date.parse(held.at)) {
      // A source that quotes only one of the two numbers keeps the other from before.
      byBook.set(k, held && Date.parse(b.at) >= Date.parse(held.at) ? mergeOne(held, b) : b);
    }
  }
  const teams = [...new Set([...(entry?.teams ?? []), ...(extra.teams ?? [])].map((t) => t.toUpperCase()))].slice(0, 2);
  return { kickoff: extra.kickoff ?? entry?.kickoff ?? null, teams, books: [...byBook.values()] };
}

function mergeOne(held: GameBookLine, next: GameBookLine): GameBookLine {
  return {
    ...next,
    total: next.total ?? (sameDay(held, next) ? held.total : null),
    spread: next.spread ?? (sameDay(held, next) ? held.spread : null),
    spreadTeam: next.spread != null ? next.spreadTeam : sameDay(held, next) ? held.spreadTeam : null,
  };
}

/** A number the newer quote left out is kept only if it is recent; otherwise freshness would be overstated. */
function sameDay(held: GameBookLine, next: GameBookLine): boolean {
  return Date.parse(next.at) - Date.parse(held.at) < DAY / 2;
}

/** Did the combined game line change against what `vegas_events` holds? */
export function gameLinesDiffer(stored: VegasEventRow | null | undefined, next: CombinedGameLines): boolean {
  if (next.total == null && next.spread == null) return false;
  const total = stored?.total ?? null;
  if (next.total != null && next.total !== total) return true;
  if (next.spread == null) return false;
  const storedTeam = stored?.spreadTeam?.toUpperCase() ?? null;
  const storedSpread = stored?.spread ?? null;
  if (storedSpread == null || storedTeam == null) return true;
  if (storedTeam === next.spreadTeam) return storedSpread !== next.spread;
  // Same line from the other side reads as the negation.
  return storedSpread !== -next.spread;
}

/**
 * The side a stored game row lacks, when its books name both sides and one of
 * them is the side the row has. Null when nothing is missing or the books do
 * not agree with the row (never guessed).
 */
export function missingOpponent(stored: Pick<VegasEventRow, 'homeTeam' | 'awayTeam'>, teams: readonly string[]): string | null {
  const home = stored.homeTeam?.toUpperCase() || null;
  const away = stored.awayTeam?.toUpperCase() || null;
  if ((home && away) || (!home && !away) || teams.length !== 2) return null;
  const have = (home ?? away)!;
  const sides = teams.map((t) => t.toUpperCase());
  if (!sides.includes(have)) return null;
  return sides.find((t) => t !== have) ?? null;
}

export class GameBooksRepo {
  private readonly settings: SettingsRepo;
  private loaded: GameBooks | null = null;
  private dirty = false;

  constructor(private readonly db: Database) {
    this.settings = new SettingsRepo(db);
  }

  async all(): Promise<GameBooks> {
    if (!this.loaded) {
      const raw = await this.settings.get<GameBooks | null>(SETTING_KEYS.vegasGameBooks, null).catch(() => null);
      this.loaded = raw && typeof raw === 'object' ? raw : {};
    }
    return this.loaded;
  }

  /**
   * Add a source's books for a game, combine, and write the game's row only
   * if the combined line moved. Returns the combined line (null fields when no
   * book is fresh), which the caller can store with its look.
   */
  async addAndCombine(
    eventId: string,
    incoming: readonly GameBookLine[],
    opts: { now: number; kickoff: string | null; teams?: readonly string[]; provider: string },
  ): Promise<CombinedGameLines> {
    const books = await this.all();
    const entry = mergeGameBooks(books[eventId], incoming, { kickoff: opts.kickoff, teams: opts.teams ?? [] });
    books[eventId] = entry;
    this.dirty = true;

    const events = new VegasEventsRepo(this.db);
    const stored = (await events.forEvents([eventId])).get(eventId) ?? null;
    const teams = entry.teams.length > 0 ? entry.teams : [stored?.homeTeam, stored?.awayTeam].filter((t): t is string => !!t);
    const combined = combineGameLines(entry.books, teams, {
      now: opts.now,
      kickoff: entry.kickoff ?? stored?.kickoff ?? null,
      prefer: stored?.spreadTeam ?? null,
    });
    // Only a game already on file: a source with no row for it must not create
    // one, or discovery would read that team's game as known and never buy it.
    //
    // A row discovery saved with one side only (the team it asked about) cannot
    // place a spread quoted for the other side, so that team's players get no
    // Team points. The books name both sides: fill the missing one, once.
    const missingSide = stored ? missingOpponent(stored, entry.teams) : null;
    if (stored && (gameLinesDiffer(stored, combined) || missingSide)) {
      await events.upsertMany([
        {
          eventId,
          provider: stored?.provider ?? opts.provider,
          kickoff: stored?.kickoff ?? entry.kickoff,
          homeTeam: stored.homeTeam ? null : missingSide,
          awayTeam: stored.homeTeam ? missingSide : null,
          total: combined.total,
          spread: combined.spread,
          spreadTeam: combined.spreadTeam,
        },
      ]);
    }
    return combined;
  }

  /** Write the row once, at the end of a pass, dropping games a day past kickoff. */
  async flush(now: number): Promise<void> {
    if (!this.dirty || !this.loaded) return;
    const kept: GameBooks = {};
    for (const [id, entry] of Object.entries(this.loaded)) {
      const at = entry.kickoff ? Date.parse(entry.kickoff) : NaN;
      if (Number.isFinite(at) && at < now - DAY) continue;
      kept[id] = entry;
    }
    await this.settings.set(SETTING_KEYS.vegasGameBooks, kept);
    this.loaded = kept;
    this.dirty = false;
  }
}
