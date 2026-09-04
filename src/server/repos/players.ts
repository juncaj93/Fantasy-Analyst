/** Player + alias persistence, and construction of the in-memory PlayerIndex. */

import { EXCLUDED_POSITIONS } from '../../core/sleeper/transform.ts';
import { PlayerIndex } from '../../core/identity/index.ts';
import type { CanonicalPlayer } from '../../core/identity/types.ts';
import { MAX_BOUND_PARAMS, chunk, nowIso, parseJson, toJson, type Database } from '../db.ts';
import { SlowRead } from './slowRead.ts';
/* The one player matcher, and the recall rule that keeps SQL in step with it. */
import { hasWiderRecall, rankByNormalized, recallTerms } from '../../core/search/players.ts';

interface PlayerRow {
  id: string;
  sleeper_player_id: string | null;
  full_name: string;
  first_name: string;
  last_name: string;
  team: string;
  position: string;
  status: string | null;
  active: number;
  normalized_name: string;
  aliases_json: string;
  external_ids_json: string;
  draft_rank: number | null;
  jersey_number?: number | null;
  height_inches: number | null;
  weight_pounds: number | null;
  age: number | null;
  years_exp: number | null;
}

function toPlayer(row: PlayerRow, extraAliases: string[] = []): CanonicalPlayer {
  return {
    id: row.id,
    sleeperPlayerId: row.sleeper_player_id,
    fullName: row.full_name,
    firstName: row.first_name,
    lastName: row.last_name,
    team: row.team,
    position: row.position,
    status: row.status,
    active: row.active === 1,
    normalizedName: row.normalized_name,
    aliases: [...parseJson<string[]>(row.aliases_json, []), ...extraAliases],
    externalIds: parseJson<Record<string, string>>(row.external_ids_json, {}),
    searchRank: row.draft_rank ?? null,
    jerseyNumber: row.jersey_number ?? null,
    heightInches: row.height_inches ?? null,
    weightPounds: row.weight_pounds ?? null,
    age: row.age ?? null,
    yearsExp: row.years_exp ?? null,
  };
}

/** Positions the app refuses to carry, as SQL. */
const EXCLUDED_LIST = [...EXCLUDED_POSITIONS];
const EXCLUDED_PLACEHOLDERS = EXCLUDED_LIST.map(() => '?').join(',');

/**
 * The columns `toPlayer` actually reads, as SQL.
 *
 * Typed as the keys of `PlayerRow` so it cannot quietly fall behind the shape
 * it is filling: a column added to the interface and forgotten here is a
 * compile error, and one removed from the interface and left here is too.
 */
const PLAYER_COLUMNS: string = Object.keys({
  id: true,
  sleeper_player_id: true,
  full_name: true,
  first_name: true,
  last_name: true,
  team: true,
  position: true,
  status: true,
  active: true,
  normalized_name: true,
  aliases_json: true,
  external_ids_json: true,
  draft_rank: true,
  jersey_number: true,
  height_inches: true,
  weight_pounds: true,
  age: true,
  years_exp: true,
} satisfies Record<keyof PlayerRow, true>).join(', ');

/*
 * The three reads on this repo that `d1 insights` caught spending the daily
 * allowance, and the only three here that are both expensive and stale-safe.
 *
 * `DICTIONARY` holds the *rows*, not the `CanonicalPlayer` objects built from
 * them. The mapping is re-run per call, which costs microseconds and means no
 * caller can be handed an object another caller has since sorted, filtered in
 * place or otherwise adjusted — the aliasing bug this would otherwise be one
 * refactor away from. The read is what was expensive; the mapping never was.
 *
 * See `slowRead.ts` for the measurements and the argument.
 */
const DICTIONARY = new SlowRead<{ players: PlayerRow[]; aliases: { player_id: string; alias: string }[] }>();

/**
 * The two counts hold their answer for an hour, not five minutes.
 *
 * Five minutes was set against the Draft board's five-second poll, where it
 * turns 720 reads an hour into 12. It was never the right window for these
 * two, and the clean-day insights read said so: with the dictionary fixed,
 * `COUNT(*) FROM players WHERE active = 1 AND draft_rank IS NOT NULL` and its
 * unfiltered twin were the two largest queries left on the account, together
 * 1,018,556 rows across 308 calls -- 20.4% of the daily allowance to produce
 * two integers.
 *
 * The memo had capped how often they run. It could not touch what a run costs,
 * and that is the whole cost here: a `COUNT` with nothing to narrow it walks
 * every row, 3,307 of them, every single time. The only lever left is the
 * window, and an hour is honest for a number the 09:00 sync rewrites once a
 * day and every other write clears by hand.
 */
export const COUNT_TTL_MS = 60 * 60 * 1_000;

const TOTAL = new SlowRead<number>(COUNT_TTL_MS);
const RANKED = new SlowRead<number>(COUNT_TTL_MS);

/**
 * Remember the total for the full hour, unless there is no table to count.
 *
 * `count()` returns zero for exactly one reason: the table is empty. That
 * makes zero the one answer worth re-reading every time, because it is also
 * the only one that is free -- a `COUNT` walks the rows it counts, so counting
 * an empty table reads none. Holding it saves nothing.
 *
 * What holding it costs is the screen. `playerCount > 0` decides whether Setup
 * says "Connected as Alex" or "the player list has not been downloaded", and a
 * zero is precisely the state somebody is standing on that screen trying to
 * leave. `upsertMany` clears these memos, so a sync that lands on the isolate
 * the reader is already talking to shows up at once -- but nothing guarantees
 * it is the same isolate, and an hour of an app insisting the download you just
 * ran never happened is a bad trade for rows that were free.
 *
 * This deliberately does NOT apply to `countRanked()`, and the difference is
 * the whole reason it is a named function rather than a shared wrapper. That
 * count filters, and a filtered `COUNT` returning zero has still walked every
 * row to find out -- a synced dictionary with no ADP imported yet answers zero
 * at the cost of all 3,307. Re-reading on zero there would turn the memo off
 * for the case it is most needed in. Only `upsertMany` writes `draft_rank`,
 * and it forgets, so the hour stands on its own.
 */
async function dropAnEmptyTable(read: () => Promise<number>, db: Database): Promise<number> {
  const n = await read();
  if (n === 0) TOTAL.forget(db);
  return n;
}

/** Drop every memo for this database. Exported for tests. */
export function forgetPlayerReads(db: Database): void {
  DICTIONARY.forget(db);
  TOTAL.forget(db);
  RANKED.forget(db);
}

export class PlayerRepo {
  constructor(private readonly db: Database) {}

  /**
   * How many players are stored.
   *
   * A `COUNT(*)` with no `WHERE` is a full pass over the table — SQLite has no
   * stored row count to consult, and D1 bills every row it walks — so this is
   * 3,300 rows to render one number on the overview. It was asked 433 times in
   * the day that ran the allowance out, for 28.6% of it. Memoised for an hour,
   * because the count changes when `upsertMany` runs and at no other time --
   * except for zero, which {@link dropAnEmptyTable} refuses to hold.
   */
  async count(): Promise<number> {
    return dropAnEmptyTable(
      () =>
        TOTAL.get(this.db, 'all', async () => {
          const row = await this.db.prepare('SELECT COUNT(*) AS n FROM players').first<{ n: number }>();
          return Number(row?.n ?? 0);
        }),
      this.db,
    );
  }

  /**
   * How many active players Sleeper gives a draft-order rank.
   *
   * Another full pass — neither column is indexed, and indexing them would not
   * help much on a table this small where most rows match. Memoised for the
   * same hour as {@link count}, and refreshed by `upsertMany`, which is the
   * only writer of `draft_rank`.
   *
   * Not zero-guarded, unlike its twin, and deliberately: zero here means the
   * filter matched nothing, not that there was nothing to read. The scan
   * happened either way, so a zero is worth holding exactly as much as any
   * other answer. See {@link dropAnEmptyTable}.
   */
  async countRanked(): Promise<number> {
    return RANKED.get(this.db, 'all', async () => {
      const row = await this.db
        .prepare('SELECT COUNT(*) AS n FROM players WHERE active = 1 AND draft_rank IS NOT NULL')
        .first<{ n: number }>();
      return Number(row?.n ?? 0);
    });
  }

  /**
   * The whole dictionary, as narrow as the code that reads it.
   *
   * Two filters and a column list, and each of the three is here for a measured
   * reason:
   *
   *   - **the columns.** `SELECT *` returned every column of every row —
   *     `search_name`, the timestamps, the raw JSON blobs — to build objects
   *     that use eighteen of them. This is the query every screen ultimately
   *     reads through, over a three-thousand-row table, on a platform that
   *     serialises each row across a network boundary. `PLAYER_COLUMNS` is the
   *     `PlayerRow` interface written as SQL, so the two cannot drift: adding a
   *     field to one without the other fails to compile or fails to bind.
   *   - **the excluded positions**, filtered in SQL rather than after the fact,
   *     so a kicker that was synced before they were dropped disappears now
   *     rather than at the next sync.
   *   - **`active = 1`.** Retired and released players are not draftable, not
   *     rosterable and not searchable, and every consumer of this list already
   *     discards them — after paying to load them. The dictionary carries years
   *     of them.
   */
  async listAll(): Promise<CanonicalPlayer[]> {
    /*
     * Memoised, and this is the one that mattered: 687 calls and 2.27 million
     * rows in a day, 45.4% of the whole allowance, because the Draft board is
     * built from this list and the Draft screen re-asks for the board every
     * five seconds. The dictionary it re-reads was last written at 09:00.
     */
    const { players, aliases } = await DICTIONARY.get(this.db, 'active', async () => {
      const [rows, aliasRows] = await Promise.all([
        this.db
          .prepare(
            `SELECT ${PLAYER_COLUMNS} FROM players
              WHERE active = 1 AND position NOT IN (${EXCLUDED_PLACEHOLDERS})`,
          )
          .bind(...EXCLUDED_LIST)
          .all<PlayerRow>(),
        this.db.prepare('SELECT player_id, alias FROM player_aliases').all<{ player_id: string; alias: string }>(),
      ]);
      return { players: rows.results, aliases: aliasRows.results };
    });

    const aliasesByPlayer = new Map<string, string[]>();
    for (const a of aliases) {
      const list = aliasesByPlayer.get(a.player_id);
      if (list) list.push(a.alias);
      else aliasesByPlayer.set(a.player_id, [a.alias]);
    }
    return players.map((r) => toPlayer(r, aliasesByPlayer.get(r.id) ?? []));
  }

  async buildIndex(): Promise<PlayerIndex> {
    return new PlayerIndex(await this.listAll());
  }

  /**
   * Every player's position, active or not, and nothing else about him.
   *
   * The one read that legitimately wants the whole dictionary rather than the
   * part of it the app shows. Last season's statistics arrive as one payload
   * covering everybody who played, and a player who has since retired or been
   * released still played the season the card looks back at — so filing his
   * line under "unmatched" because he is inactive today would delete last year
   * on a roster that still holds him.
   *
   * Two columns rather than eighteen, because a position is all the caller
   * needs to rank a stat line.
   */
  async positionsById(): Promise<Map<string, string>> {
    const rows = await this.db.prepare('SELECT id, position FROM players').all<{ id: string; position: string }>();
    return new Map(rows.results.map((r) => [r.id, r.position]));
  }

  async getById(id: string): Promise<CanonicalPlayer | null> {
    const row = await this.db.prepare('SELECT * FROM players WHERE id = ?').bind(id).first<PlayerRow>();
    return row ? toPlayer(row) : null;
  }

  /**
   * Fetch a known set of players in one query.
   *
   * A whole roster is 15-20 ids. Looking them up one at a time is 15-20 round
   * trips, and loading the full 3,300-row table to pick 15 out of it is worse.
   * Ids that do not exist are simply absent from the result.
   */
  async listByIds(ids: string[]): Promise<Map<string, CanonicalPlayer>> {
    const unique = [...new Set(ids)].filter(Boolean);
    if (unique.length === 0) return new Map();
    const found = new Map<string, CanonicalPlayer>();
    for (const batch of chunk(unique, MAX_BOUND_PARAMS)) {
      const placeholders = batch.map(() => '?').join(',');
      const rows = await this.db
        .prepare(`SELECT * FROM players WHERE id IN (${placeholders})`)
        .bind(...batch)
        .all<PlayerRow>();
      for (const r of rows.results) found.set(r.id, toPlayer(r));
    }
    return found;
  }

  /**
   * Upsert the Sleeper player dump.
   * Deterministic aliases are refreshed; user-supplied aliases in
   * `player_aliases` are untouched.
   */
  async upsertMany(players: CanonicalPlayer[]): Promise<{ written: number }> {
    const now = nowIso();
    let written = 0;
    for (const batch of chunk(players, 200)) {
      const statements = batch.map((p) =>
        this.db
          .prepare(
            `INSERT INTO players (
               id, sleeper_player_id, full_name, first_name, last_name, team, position,
               status, active, normalized_name, aliases_json, external_ids_json, draft_rank,
               jersey_number, height_inches, weight_pounds, age, years_exp,
               created_at, updated_at
             ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET
               sleeper_player_id = excluded.sleeper_player_id,
               full_name         = excluded.full_name,
               first_name        = excluded.first_name,
               last_name         = excluded.last_name,
               team              = excluded.team,
               position          = excluded.position,
               status            = excluded.status,
               active            = excluded.active,
               normalized_name   = excluded.normalized_name,
               aliases_json      = excluded.aliases_json,
               external_ids_json = excluded.external_ids_json,
               draft_rank        = excluded.draft_rank,
               jersey_number     = excluded.jersey_number,
               -- COALESCE, not a plain overwrite: a sync that could not read a
               -- measurement must not erase the one already stored. Absent is
               -- "not said this time", which is not the same as "not true".
               height_inches     = COALESCE(excluded.height_inches, players.height_inches),
               weight_pounds     = COALESCE(excluded.weight_pounds, players.weight_pounds),
               age               = COALESCE(excluded.age, players.age),
               years_exp         = COALESCE(excluded.years_exp, players.years_exp),
               updated_at        = excluded.updated_at`,
          )
          .bind(
            p.id,
            p.sleeperPlayerId,
            p.fullName,
            p.firstName,
            p.lastName,
            p.team,
            p.position,
            p.status,
            p.active ? 1 : 0,
            p.normalizedName,
            toJson(p.aliases),
            toJson(p.externalIds ?? {}),
            p.searchRank ?? null,
            p.jerseyNumber ?? null,
            p.heightInches ?? null,
            p.weightPounds ?? null,
            p.age ?? null,
            p.yearsExp ?? null,
            now,
            now,
          ),
      );
      await this.db.batch(statements);
      written += batch.length;
    }
    /*
     * The dictionary and both counts are now whatever this just wrote, so the
     * memo is dropped rather than left to expire. This is what makes a manual
     * re-sync from Setup show its result immediately instead of up to five
     * minutes later, and it is why the window is safe to have at all.
     */
    forgetPlayerReads(this.db);
    return { written };
  }

  /** Add a user- or source-supplied alias. Idempotent. */
  async addAlias(playerId: string, alias: string, normalizedAlias: string, source: string, confidence = 1): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO player_aliases (player_id, alias, normalized_alias, source, confidence, created_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(player_id, normalized_alias) DO UPDATE SET
           alias = excluded.alias, source = excluded.source, confidence = excluded.confidence`,
      )
      .bind(playerId, alias, normalizedAlias, source, confidence, nowIso())
      .run();
    // `listAll` joins the aliases in, so a new nickname invalidates it too.
    forgetPlayerReads(this.db);
  }

  /**
   * The nicknames stored for a player.
   *
   * `getById` reports the deterministic ones derived from the name ("M. Vance");
   * these are the ones somebody actually taught the app, which is what the
   * nickname UI needs to show and be able to remove.
   */
  async listAliases(playerId: string): Promise<{ alias: string; normalized: string; source: string }[]> {
    const rows = await this.db
      .prepare('SELECT alias, normalized_alias, source FROM player_aliases WHERE player_id = ? ORDER BY alias')
      .bind(playerId)
      .all<{ alias: string; normalized_alias: string; source: string }>();
    return rows.results.map((r) => ({ alias: r.alias, normalized: r.normalized_alias, source: r.source }));
  }

  /**
   * Forget a nickname.
   *
   * Scoped to one player so removing a nickname cannot disturb another player
   * who legitimately uses the same normalized key.
   */
  async removeAlias(playerId: string, normalizedAlias: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM player_aliases WHERE player_id = ? AND normalized_alias = ?')
      .bind(playerId, normalizedAlias)
      .run();
    forgetPlayerReads(this.db);
  }

  /** Search by name fragment for the Players screen. */
  /**
   * Players whose lookup key is one of these, and nothing else.
   *
   * The injury ingest needs to resolve a few hundred names out of a dictionary
   * of four thousand, and building an in-memory index of the whole dictionary to
   * do it cost 17ms of CPU — more than a Worker invocation is allowed in total.
   * This asks the indexed column for exactly the keys in hand instead.
   *
   * Returns every candidate for an ambiguous key rather than picking one: the
   * caller decides, and declining is a legitimate answer.
   */
  async findByNormalizedNames(names: string[]): Promise<CanonicalPlayer[]> {
    const unique = [...new Set(names.filter((n) => n.length > 0))];
    if (unique.length === 0) return [];
    const out: CanonicalPlayer[] = [];
    for (const batch of chunk(unique, MAX_BOUND_PARAMS)) {
      const holes = batch.map(() => '?').join(', ');
      const { results } = await this.db
        .prepare(`SELECT * FROM players WHERE normalized_name IN (${holes})`)
        .bind(...batch)
        .all<PlayerRow>();
      for (const row of results ?? []) out.push(toPlayer(row));
    }
    return out;
  }

  /**
   * Players carrying any of these GSIS ids.
   *
   * The identifier half of the same lookup `findByNormalizedNames` does for
   * names, and deliberately the same shape: one indexed `IN (...)` per batch,
   * bounded by the rows actually being ingested rather than by the size of the
   * dictionary. That is what makes preferring the identifier affordable inside
   * a Worker's CPU budget — see migration 0020 for why it was not before.
   */
  async findByExternalGsisIds(ids: (string | null | undefined)[]): Promise<CanonicalPlayer[]> {
    const unique = [...new Set(ids.map((id) => (id ?? '').trim()).filter((id) => id.length > 0))];
    if (unique.length === 0) return [];
    const out: CanonicalPlayer[] = [];
    for (const batch of chunk(unique, MAX_BOUND_PARAMS)) {
      const holes = batch.map(() => '?').join(', ');
      const { results } = await this.db
        .prepare(`SELECT * FROM players WHERE gsis_id IN (${holes})`)
        .bind(...batch)
        .all<PlayerRow>();
      for (const row of results ?? []) out.push(toPlayer(row));
    }
    return out;
  }

  /**
   * Players matching a typed query, ranked by the one shared matcher.
   *
   * This used to be a single `LIKE '%query%'` against the raw name, and it was
   * literal in every way that matters: `Ja'Marr` found nobody, because the
   * stored key has no apostrophe and the query still had one; `Amon Ra` found
   * nobody, for the mirror-image reason; a one-letter slip found nobody at all.
   * Meanwhile the draft board — which filters a list already in memory —
   * answered all three correctly, so the same query gave two different answers
   * on two screens of the same app.
   *
   * It is now two steps, and the split is the whole design:
   *
   *   1. **recall** — SQL narrows the dictionary to plausible candidates, using
   *      terms the matcher itself supplies (`recallTerms`), against the two
   *      indexed forms of the key. Cheap, indexed, and bounded.
   *   2. **rank** — `rankByQuery` decides which of those actually match and in
   *      what order. The database never decides that.
   *
   * Recall is deliberately wider than the answer. A word's three-character
   * prefix is included so a typo later in the word still reaches the matcher,
   * which then throws away everything that does not survive its edit-distance
   * guard. Recalling too much costs a bounded scan; recalling too little means
   * a player who *would* have matched is silently never offered.
   *
   * Ranking happens off `normalized_name` rather than off the display name:
   * re-normalizing every row costs a chain of regexes per player, and over the
   * dictionary that measured 9.5ms against 5.4ms on a platform that allows a
   * Worker 10ms in total. Here it only ever runs over the recalled set.
   */
  async search(query: string, limit = 40): Promise<CanonicalPlayer[]> {
    const fast = await this.recallAndRank(query, limit, false);
    /*
     * A second, wider attempt — but only when the first found nobody.
     *
     * The fast pass recalls on each word's opening characters, which cannot see
     * a typo that lands *inside* those characters: `Vnace` for `Vance`. An
     * in-memory surface matches that without trying, so skipping it here would
     * leave Draft and Players disagreeing about an ordinary slip.
     *
     * Measured rather than assumed: folding the wider terms into the first
     * query costs 5.9ms and 660 rows to rank; running them alone, only on a
     * miss, costs 1.3ms. The common keystroke pays nothing for the rare one,
     * and a query that already found somebody never runs it at all.
     */
    if (fast.length > 0 || !hasWiderRecall(query)) return fast;
    return this.recallAndRank(query, limit, true);
  }

  private async recallAndRank(query: string, limit: number, wide: boolean): Promise<CanonicalPlayer[]> {
    const terms = recallTerms(query, { wide });

    /*
     * Every word must find a home, and may find it in either form of the key.
     *
     * `normalized_name` is `amon ra st brown`; `search_name` is the same with
     * the spaces squeezed out. A word typed with the hyphen dropped only ever
     * appears in the second, which is why migration 0024 added it.
     */
    const clauses: string[] = [];
    const bindings: string[] = [];
    for (const alternatives of terms) {
      const ors: string[] = [];
      for (const term of alternatives) {
        ors.push('normalized_name LIKE ?', 'search_name LIKE ?');
        bindings.push(`%${term}%`, `%${term}%`);
      }
      clauses.push(`(${ors.join(' OR ')})`);
    }

    /*
     * An empty query is "no filter", not "no players".
     *
     * `recallTerms('')` is an empty list, and an early return of `[]` here
     * would have been the natural reading of that — which is exactly wrong, and
     * wrong in a way the caller cannot see. Every other search surface treats a
     * cleared field as "show me everyone", so this one does too.
     */
    const textClause = clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : '';

    /*
     * The recall pool, deliberately larger than the page being asked for.
     *
     * The matcher discards from this set rather than adding to it, so a pool cut
     * to `limit` would hand back fewer than `limit` answers whenever anything in
     * it scored badly — which reads as "there are no more players called that".
     * Capped so a broad recall cannot pull the whole table into a Worker.
     */
    const pool = Math.min(Math.max(limit * 5, 200), 1_000);

    const rows = await this.db
      .prepare(
        `SELECT * FROM players
          WHERE active = 1
            AND position NOT IN (${EXCLUDED_PLACEHOLDERS})${textClause}
          ORDER BY LENGTH(full_name), full_name
          LIMIT ?`,
      )
      .bind(...EXCLUDED_LIST, ...bindings, pool)
      .all<PlayerRow>();

    const candidates = rows.results.map((r) => toPlayer(r));
    /*
     * Ranked by the shared matcher, tie-broken by the order SQL returned.
     *
     * That order is shortest-name-first, which is the same "the query covers
     * more of this name" instinct the matcher would otherwise have to encode
     * twice — and `rankByNormalized` is a stable sort, so it survives.
     */
    return rankByNormalized(candidates, query, (p) => p.normalizedName).slice(0, limit);
  }
}
