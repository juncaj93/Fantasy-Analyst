/**
 * Storing one look at a game (Round 23), shared by every odds source.
 *
 * SportsGameOdds' kickoff-clock looks, a person's refresh, TheRundown's hourly
 * game lines and The Odds API's Friday props all arrive here, so there is one
 * place that averages by book and writes only what changed.
 */

import { combineLook } from '../../core/vegas/combineProps.ts';
import type { CombinedGameLines, GameBookLine } from '../../core/vegas/combine.ts';
import type { RawPropSet } from '../../core/vegas/types.ts';
import type { PlayerIndex } from '../../core/identity/index.ts';
import type { Database } from '../db.ts';
import { GameBooksRepo } from '../repos/gameBooks.ts';
import { PlayerRepo } from '../repos/players.ts';
import { PropsRepo } from '../repos/props.ts';

export class LookStore {
  readonly gameBooks: GameBooksRepo;
  private readonly props: PropsRepo;

  constructor(private readonly db: Database) {
    this.gameBooks = new GameBooksRepo(db);
    this.props = new PropsRepo(db);
  }

  /** Add one source's game lines (no player lines) for a game already on file. */
  async storeGameBooks(
    eventId: string,
    books: readonly GameBookLine[],
    opts: { now: number; kickoff: string | null; teams?: readonly string[]; provider: string },
  ): Promise<CombinedGameLines> {
    return this.gameBooks.addAndCombine(eventId, books, opts);
  }

  /**
   * Store one look at a game (Round 23).
   *
   *   1. The game's books (each sportsbook's total and spread) join what other
   *      looks and sources said; the combined line is written to the game's row
   *      only if it moved (`GameBooksRepo`).
   *   2. The player lines are averaged by book and compared with what is on
   *      file; only the ones that changed are written (`combineLook`).
   *   3. The look itself is one small row: when it happened, the combined game
   *      line, and the combined player lines for audit. It is what the kickoff
   *      clock and the refresh button read to know how old a game's lines are.
   */
  async storeLook(set: RawPropSet): Promise<void> {
    const at = Date.parse(set.fetchedAt);
    const now = Number.isFinite(at) ? at : Date.now();
    const kickoff = set.gameStart || null;
    const lines = set.gameLines;
    const incoming: GameBookLine[] =
      lines?.books && lines.books.length > 0
        ? lines.books
        : lines && (lines.total != null || lines.spread != null)
          ? [{ book: set.provider, total: lines.total, spread: lines.spread, spreadTeam: lines.spreadTeam, at: set.fetchedAt, source: set.provider }]
          : [];
    const combined =
      incoming.length > 0
        ? await this.gameBooks.addAndCombine(set.eventId, incoming, {
            now,
            kickoff,
            ...(lines?.teams ? { teams: lines.teams } : {}),
            provider: set.provider,
          })
        : null;

    const stored = await this.props.currentForEvent(set.eventId);
    const look = combineLook(set.quotes ?? [], stored, await this.playerIndex(), { now, kickoff, source: set.provider });

    await this.props.put({
      provider: set.provider,
      eventId: set.eventId,
      gameStart: set.gameStart,
      fetchedAt: set.fetchedAt,
      raw: {
        ...set,
        gameLines: {
          total: combined?.total ?? lines?.total ?? null,
          spread: combined?.spread ?? lines?.spread ?? null,
          spreadTeam: combined?.spread != null ? combined.spreadTeam : (lines?.spreadTeam ?? null),
        },
        quotes: look.current.map((p) => ({
          playerName: p.sourcePlayerName,
          market: p.market,
          line: p.line,
          overPrice: p.overPrice,
          underPrice: null,
          book: `average of ${p.bookCount}`,
        })),
        delta: true,
      },
    });
    const snapshotId = await this.props.snapshotId(set.provider, set.eventId, set.fetchedAt);
    if (snapshotId != null) await this.props.saveChanges(snapshotId, look.changed);
  }

  /**
   * The player dictionary, read and indexed once per refresh.
   *
   * It was rebuilt for every game stored: all 3,309 players read and indexed
   * again for each of the eight to ten games a weekend run stores, when none of
   * them can change in between.
   */
  private indexOnce: Promise<PlayerIndex> | null = null;
  private playerIndex(): Promise<PlayerIndex> {
    // A read that failed is not kept, so the next game asks again as before.
    this.indexOnce ??= new PlayerRepo(this.db).buildIndex().catch((err: unknown) => {
      this.indexOnce = null;
      throw err;
    });
    return this.indexOnce;
  }

  /** Write the per-book game lines row once, at the end of a pass. */
  async flush(now: number): Promise<void> {
    await this.gameBooks.flush(now);
  }
}
