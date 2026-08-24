/**
 * Ingesting the three nflverse feeds Projection v2 added, with the same
 * discipline the injury and usage pipelines already run under.
 *
 * Every mechanism here is inherited rather than invented, and that is the point:
 * conditional GET so the ordinary tick costs a round trip and no bytes, a
 * compare-and-swap lease that expires so a Worker killed mid-parse cannot wedge
 * anything, a daily write ceiling, an anomaly guard that refuses an ingest which
 * would rewrite most of the store, and a `not_published` outcome that is a fact
 * about the calendar rather than an alarm. Three feeds sharing one proven set of
 * mechanisms beats three feeds each with their own idea of what a lease is.
 *
 * ## What is different about these three
 *
 * **The roster is a crosswalk, not football.** It is ingested first on any tick
 * that runs all three, because the snap counts cannot be mapped without it —
 * `pfr_player_id → gsis_id` is a roster lookup — and because a roster refreshed
 * after the snaps would leave a week of snaps unmatched for a day.
 *
 * **The depth chart is read by range.** The file is 44MiB and is written
 * newest-first, so the current chart is its first few hundred kilobytes. See
 * `core/nflverse/depthChart.ts` for the measurements and for the completeness
 * guard that stops a truncated read being stored as a chart with players
 * missing.
 *
 * **The snaps are the reason the roster is here.** `core/usage/nflverse.ts`
 * turned this file down because its only identifier was one this app had never
 * seen. With the crosswalk that is an identifier join, and it resolved 99.7% of
 * the 2025 season's skill-position rows.
 *
 * ## Nothing here is read by a recommendation
 *
 * Phase 1. `ProjectionV2Service` reads these tables and produces a report; the
 * Team and Matchup engines do not import this file, this file's repositories or
 * anything derived from them. That is checked by
 * `tests/projectionV2.boundary.test.ts` rather than promised here.
 */

import { conditionalGet, type FetchLike } from '../../core/source/conditional.ts';
import {
  parseRoster,
  rosterUrl,
  toIdentityLinks,
  SKILL_POSITIONS,
  type RosterRow,
} from '../../core/nflverse/roster.ts';
import {
  DEPTH_PREFIX_BYTES,
  depthChartUrl,
  depthRoles,
  parseDepthChart,
} from '../../core/nflverse/depthChart.ts';
import { parseSnapCounts, snapCountsUrl, SNAP_POSITIONS } from '../../core/nflverse/snapCounts.ts';
import { looksAnomalous } from '../../core/injury/diff.ts';
import {
  DepthChartRepo,
  IdentityCrosswalkRepo,
  NflverseRunRepo,
  NflverseSourceRepo,
  SnapCountRepo,
  type NflverseSourceRun,
  type StoredDepthEntry,
  type StoredSnapWeek,
} from '../repos/nflverse.ts';
import { PlayerRepo } from '../repos/players.ts';
import { usageSeason } from './usageService.ts';
import type { Database } from '../db.ts';

/** The three feed names, which key the shared state table. */
export const NFLVERSE_SOURCES = {
  roster: 'nflverse_roster',
  depth: 'nflverse_depth',
  snaps: 'nflverse_snaps',
} as const;

export type NflverseSourceName = (typeof NFLVERSE_SOURCES)[keyof typeof NFLVERSE_SOURCES];

/** Seconds an ingest lease is held for. The same figure the usage pipeline uses. */
export const INGEST_LEASE_SECONDS = 120;

/**
 * Rows all three feeds together may write in a day.
 *
 * A healthy day is one roster refresh (~900 rows) when the file moves, one depth
 * capture (~950), and one week of snaps (~360) the morning after a game day —
 * so roughly 2,200 on the busiest day of the week and nothing at all on most.
 * 6,000 leaves headroom for a catch-up without leaving room for a runaway.
 */
export const DAILY_WRITE_CEILING = 6_000;

/** Depth-chart captures kept per season. Two: the current chart and the last one. */
export const DEPTH_CAPTURES_KEPT = 2;

export interface NflverseHealth {
  season: string;
  identity: { rows: number; withSleeper: number; withPfr: number; asOf: string | null };
  snaps: { players: number; weeks: number; latestWeek: number | null; rows: number };
  depth: { captures: string[]; latest: string | null };
  runs: Partial<Record<NflverseSourceName, NflverseSourceRun | null>>;
  writesToday: number;
  writeCeiling: number;
  /** One sentence a person can act on. */
  dataHealth: string;
}

export class NflverseService {
  private readonly identity: IdentityCrosswalkRepo;
  private readonly snaps: SnapCountRepo;
  private readonly depth: DepthChartRepo;
  private readonly source: NflverseSourceRepo;
  private readonly runs: NflverseRunRepo;
  private readonly players: PlayerRepo;

  constructor(
    db: Database,
    private readonly deps: { fetch?: FetchLike; now?: () => Date; log?: (line: string) => void } = {},
  ) {
    this.identity = new IdentityCrosswalkRepo(db);
    this.snaps = new SnapCountRepo(db);
    this.depth = new DepthChartRepo(db);
    this.source = new NflverseSourceRepo(db);
    this.runs = new NflverseRunRepo(db);
    this.players = new PlayerRepo(db);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private log(line: string): void {
    (this.deps.log ?? console.log)(line);
  }

  /**
   * All three feeds, in dependency order.
   *
   * The roster first, always: the snap join reads the crosswalk it writes, and
   * refreshing them the other way round leaves a week of snaps unmatched until
   * tomorrow. Each is separately caught — a depth chart that fails must not cost
   * the identity refresh that half this phase depends on.
   */
  async refreshAll(season = usageSeason(this.now())): Promise<NflverseSourceRun[]> {
    const out: NflverseSourceRun[] = [];
    for (const step of [
      () => this.refreshRoster(season),
      () => this.refreshDepthChart(season),
      () => this.refreshSnapCounts(season),
    ]) {
      try {
        out.push(await step());
      } catch (err) {
        this.log(`nflverse-refresh step failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return out;
  }

  // ------------------------------------------------------------- roster ---

  async refreshRoster(season = usageSeason(this.now())): Promise<NflverseSourceRun> {
    const source = NFLVERSE_SOURCES.roster;
    return this.ingest(source, season, rosterUrl(season), `${season} rosters`, undefined, async (text, ctx) => {
      const parsed = parseRoster(text, { positions: SKILL_POSITIONS });
      if (parsed.rows.length === 0) {
        return { outcome: 'failed', note: 'no roster rows parsed — the source shape may have changed', written: 0, returned: parsed.rowsInFile, matched: 0, unmatched: parsed.skipped };
      }
      const byGsis = new Map<string, RosterRow>(parsed.rows.map((r) => [r.gsisId!, r]));
      const links = toIdentityLinks(parsed, source, ctx.publishedAt).map((link) => {
        const row = byGsis.get(link.gsisId);
        return { ...link, fullName: row?.fullName ?? null, status: row?.status ?? null };
      });

      const budgeted = await this.spendBudget(links.length, ctx.fetchedAt);
      if (!budgeted.ok) {
        return { outcome: 'failed', note: budgeted.note, written: 0, returned: parsed.rowsInFile, matched: links.length, unmatched: parsed.skipped };
      }

      await this.identity.save(links, ctx.fetchedAt);
      return {
        outcome: 'ok',
        note: null,
        written: links.length,
        returned: parsed.rowsInFile,
        matched: links.filter((l) => l.sleeperId).length,
        unmatched: links.filter((l) => !l.sleeperId).length,
      };
    });
  }

  // -------------------------------------------------------- depth chart ---

  async refreshDepthChart(season = usageSeason(this.now())): Promise<NflverseSourceRun> {
    const source = NFLVERSE_SOURCES.depth;
    return this.ingest(
      source,
      season,
      depthChartUrl(season),
      `${season} depth charts`,
      DEPTH_PREFIX_BYTES,
      async (text, ctx) => {
        const snapshot = parseDepthChart(text, { positions: SKILL_POSITIONS });
        /*
         * A prefix read that did not reach the end of the newest capture is
         * stored as nothing at all. Half a chart is not a smaller chart; it
         * reads as a club having released the players the read did not reach,
         * and the change detector would report a promotion for everyone behind
         * them. The guard lives in the parser and this is where it is obeyed.
         */
        if (!snapshot.complete || snapshot.entries.length === 0) {
          return {
            outcome: 'failed',
            note: snapshot.note ?? 'the depth-chart read was not a complete capture',
            written: 0,
            returned: snapshot.rowsRead,
            matched: 0,
            unmatched: 0,
          };
        }

        const capturedAt = snapshot.capturedAt ?? ctx.publishedAt ?? ctx.fetchedAt;
        const roles = depthRoles(snapshot);
        const rows: StoredDepthEntry[] = [];
        for (const entry of snapshot.entries) {
          if (!entry.gsisId) continue;
          const role = roles.get(entry.gsisId);
          rows.push({
            season,
            capturedAt,
            gsisId: entry.gsisId,
            team: entry.team,
            playerName: entry.playerName || null,
            position: entry.position,
            posGroup: entry.group,
            posSlot: entry.slot,
            posRank: entry.rank,
            starterSlots: role?.starterSlots ?? null,
            schemaVersion: snapshot.schema,
            source,
            fetchedAt: ctx.fetchedAt,
          });
        }

        const budgeted = await this.spendBudget(rows.length, ctx.fetchedAt);
        if (!budgeted.ok) {
          return { outcome: 'failed', note: budgeted.note, written: 0, returned: snapshot.rowsRead, matched: rows.length, unmatched: 0 };
        }

        await this.depth.saveSnapshot(rows);
        const pruned = await this.depth.prune(season, DEPTH_CAPTURES_KEPT).catch(() => 0);
        this.log(`nflverse-depth season=${season} captured=${capturedAt} rows=${rows.length} pruned=${pruned}`);
        return {
          outcome: 'ok',
          note: null,
          written: rows.length,
          returned: snapshot.rowsRead,
          matched: rows.length,
          unmatched: snapshot.entries.length - rows.length,
        };
      },
    );
  }

  // -------------------------------------------------------- snap counts ---

  async refreshSnapCounts(season = usageSeason(this.now())): Promise<NflverseSourceRun> {
    const source = NFLVERSE_SOURCES.snaps;
    return this.ingest(source, season, snapCountsUrl(season), `${season} snap counts`, undefined, async (text, ctx) => {
      const parsed = parseSnapCounts(text, { positions: SNAP_POSITIONS });
      if (parsed.rows.length === 0) {
        return { outcome: 'failed', note: 'no snap rows parsed — the source shape may have changed', written: 0, returned: parsed.rowsInWeek, matched: 0, unmatched: parsed.skipped };
      }

      /*
       * The join the roster file exists for: `pfr_player_id → gsis_id →
       * canonical player`, two identifier hops and no name anywhere. A row that
       * does not resolve is counted and dropped, never guessed at.
       */
      const crosswalk = await this.identity.forSeason(season).catch(() => []);
      const gsisByPfr = new Map<string, string>();
      for (const link of crosswalk) if (link.pfrId) gsisByPfr.set(link.pfrId, link.gsisId);

      const gsisIds = [...new Set(parsed.rows.map((r) => gsisByPfr.get(r.pfrId)).filter((g): g is string => !!g))];
      const players = await this.players.findByExternalGsisIds(gsisIds).catch(() => []);
      const playerByGsis = new Map<string, string>();
      for (const player of players) {
        const gsis = (player.externalIds?.['gsis'] ?? '').trim();
        if (gsis) playerByGsis.set(gsis, player.id);
      }
      /*
       * And the second hop, for the players Sleeper publishes no GSIS id for:
       * the crosswalk's own `sleeper_id` is this app's `players.id`, so a player
       * the indexed lookup above could not find is still reachable. This is the
       * ~16% the bridge exists for.
       */
      for (const link of crosswalk) {
        if (link.sleeperId && !playerByGsis.has(link.gsisId)) playerByGsis.set(link.gsisId, link.sleeperId);
      }

      const rows: StoredSnapWeek[] = [];
      let unmatched = 0;
      for (const row of parsed.rows) {
        const gsisId = gsisByPfr.get(row.pfrId) ?? null;
        const playerId = gsisId ? (playerByGsis.get(gsisId) ?? null) : null;
        if (!playerId) {
          unmatched++;
          continue;
        }
        rows.push({
          playerId,
          season: row.season || season,
          week: row.week,
          gameType: row.gameType,
          team: row.team,
          opponent: row.opponent,
          position: row.position,
          offenseSnaps: row.offenseSnaps,
          offenseShare: row.offenseShare,
          pfrId: row.pfrId,
          gsisId,
          source,
          publishedAt: ctx.publishedAt,
          fetchedAt: ctx.fetchedAt,
        });
      }

      if (rows.length === 0) {
        return { outcome: 'failed', note: 'no snap rows mapped to a known player', written: 0, returned: parsed.rowsInWeek, matched: 0, unmatched };
      }

      /*
       * The same size guard the usage pipeline runs, and for the same failure: a
       * parser that reads every field as empty reports that the whole league's
       * snap share moved at once, which is indistinguishable from a real mass
       * update except by its size.
       */
      const stored = await this.snaps.coverage(season).catch(() => ({ rows: 0, players: 0, weeks: 0, latestWeek: null }));
      if (looksAnomalous({ changed: rows, examined: parsed.rowsInWeek }, stored.rows)) {
        return {
          outcome: 'failed',
          note: `refused: ${rows.length} of ${parsed.rowsInWeek} rows in the week would be rewritten, which looks like a source or parser change`,
          written: 0,
          returned: parsed.rowsInWeek,
          matched: rows.length,
          unmatched,
        };
      }

      const budgeted = await this.spendBudget(rows.length, ctx.fetchedAt);
      if (!budgeted.ok) {
        return { outcome: 'failed', note: budgeted.note, written: 0, returned: parsed.rowsInWeek, matched: rows.length, unmatched };
      }

      await this.snaps.saveWeeks(rows);
      this.log(
        `nflverse-snaps season=${season} week=${parsed.week} parsed=${parsed.rows.length} ` +
          `written=${rows.length} unmatched=${unmatched}`,
      );
      return { outcome: 'ok', note: null, written: rows.length, returned: parsed.rowsInWeek, matched: rows.length, unmatched, week: parsed.week };
    });
  }

  // ------------------------------------------------------------ health ---

  async health(season = usageSeason(this.now())): Promise<NflverseHealth> {
    const [identity, snaps, captures, rosterRun, depthRun, snapRun, writesToday] = await Promise.all([
      this.identity.coverage(season).catch(() => ({ rows: 0, withSleeper: 0, withPfr: 0, asOf: null })),
      this.snaps.coverage(season).catch(() => ({ players: 0, weeks: 0, latestWeek: null, rows: 0 })),
      this.depth.captures(season).catch(() => [] as string[]),
      this.runs.latest(NFLVERSE_SOURCES.roster).catch(() => null),
      this.runs.latest(NFLVERSE_SOURCES.depth).catch(() => null),
      this.runs.latest(NFLVERSE_SOURCES.snaps).catch(() => null),
      this.source.writesToday(this.now().toISOString().slice(0, 10)).catch(() => 0),
    ]);

    const parts: string[] = [];
    if (identity.rows === 0) parts.push('no identity crosswalk yet');
    else
      parts.push(
        `${identity.rows} crosswalk rows, ${pct(identity.withSleeper, identity.rows)} with a Sleeper id and ` +
          `${pct(identity.withPfr, identity.rows)} with a PFR id`,
      );
    parts.push(captures.length === 0 ? 'no depth chart stored' : `depth chart from ${captures[0]}`);
    parts.push(
      snaps.rows === 0
        ? 'no snap counts stored'
        : `snaps through week ${snaps.latestWeek} for ${snaps.players} players`,
    );

    return {
      season,
      identity,
      snaps,
      depth: { captures, latest: captures[0] ?? null },
      runs: {
        [NFLVERSE_SOURCES.roster]: rosterRun,
        [NFLVERSE_SOURCES.depth]: depthRun,
        [NFLVERSE_SOURCES.snaps]: snapRun,
      },
      writesToday,
      writeCeiling: DAILY_WRITE_CEILING,
      dataHealth: parts.join('; '),
    };
  }

  // ------------------------------------------------------------ plumbing ---

  /**
   * One conditional fetch, one lease, one parse — for whichever feed asked.
   *
   * Everything the three feeds share, once. `parse` is handed the body and
   * returns what happened; it never sees the lease, the fingerprint or the run
   * bookkeeping, so a new feed cannot forget one of them.
   */
  private async ingest(
    source: NflverseSourceName,
    season: string,
    url: string,
    describe: string,
    rangeBytes: number | undefined,
    parse: (
      text: string,
      ctx: { fetchedAt: string; publishedAt: string | null },
    ) => Promise<{
      outcome: 'ok' | 'failed';
      note: string | null;
      written: number;
      returned: number;
      matched: number;
      unmatched: number;
      week?: number;
    }>,
  ): Promise<NflverseSourceRun> {
    const now = this.now();
    const fetchedAt = now.toISOString();
    const base: NflverseSourceRun = {
      source,
      season,
      week: null,
      fetchedAt,
      publishedAt: null,
      rowsReturned: 0,
      matched: 0,
      unmatched: 0,
      rowsWritten: 0,
      outcome: 'failed',
      note: null,
    };

    const known = await this.source.get(source, season).catch(() => null);
    const fetched = await conditionalGet(url, {
      fetch: this.deps.fetch,
      fingerprint: known ? { etag: known.etag, lastModified: known.lastModified } : null,
      describe,
      rangeBytes,
    });

    if (fetched.outcome === 'not_modified') {
      await this.source.recordCheck(source, season, {
        checkedAt: fetchedAt,
        etag: fetched.fingerprint.etag,
        lastModified: fetched.fingerprint.lastModified,
        outcome: 'not_modified',
        note: null,
      });
      await this.source.recordIngestSuccess(source, season, null).catch(() => {});
      return { ...base, outcome: 'not_modified', note: 'source unchanged', publishedAt: known?.sourceModifiedAt ?? null };
    }

    if (fetched.outcome !== 'ok' || fetched.text == null) {
      /*
       * A 404 is the calendar, not a fault: `snap_counts_2026.csv` does not
       * exist in August because no games have been played, and an alarm that
       * cannot tell that from an outage is one nobody reads in November.
       */
      await this.source.recordCheck(source, season, {
        checkedAt: fetchedAt,
        outcome: fetched.outcome,
        note: fetched.note,
      });
      if (fetched.outcome === 'failed') {
        await this.source.recordIngestFailure(source, season, fetchedAt, fetched.note ?? 'fetch failed').catch(() => {});
      }
      const run: NflverseSourceRun = { ...base, outcome: fetched.outcome, note: fetched.note };
      await this.runs.record(run).catch(() => {});
      return run;
    }

    const owner = `${fetchedAt}:${source}:${season}`;
    const holds = await this.source.acquireLock(source, season, owner, now, INGEST_LEASE_SECONDS).catch(() => false);
    if (!holds) {
      return { ...base, outcome: 'ok', note: 'another ingest is already running' };
    }

    try {
      const result = await parse(fetched.text, { fetchedAt, publishedAt: fetched.publishedAt });
      const run: NflverseSourceRun = {
        ...base,
        week: result.week ?? null,
        publishedAt: fetched.publishedAt,
        rowsReturned: result.returned,
        matched: result.matched,
        unmatched: result.unmatched,
        rowsWritten: result.written,
        outcome: result.outcome,
        note: result.note,
      };
      if (result.outcome === 'ok') {
        await this.source.recordCheck(source, season, {
          checkedAt: fetchedAt,
          etag: fetched.fingerprint.etag,
          lastModified: fetched.fingerprint.lastModified,
          sourceModifiedAt: fetched.publishedAt,
          ingestedAt: fetchedAt,
          outcome: 'ok',
          note: null,
        });
        await this.source.recordIngestSuccess(source, season, result.week ?? null).catch(() => {});
      } else {
        await this.source.recordCheck(source, season, { checkedAt: fetchedAt, outcome: 'failed', note: result.note });
        await this.source.recordIngestFailure(source, season, fetchedAt, result.note ?? 'ingest failed').catch(() => {});
      }
      await this.runs.record(run).catch(() => {});
      return run;
    } catch (err) {
      const note = err instanceof Error ? err.message : String(err);
      await this.source.recordCheck(source, season, { checkedAt: fetchedAt, outcome: 'failed', note });
      await this.source.recordIngestFailure(source, season, fetchedAt, note).catch(() => {});
      const run: NflverseSourceRun = { ...base, note };
      await this.runs.record(run).catch(() => {});
      return run;
    } finally {
      await this.source.releaseLock(source, season, owner).catch(() => {});
    }
  }

  /** The shared daily ceiling, checked before a write rather than after it. */
  private async spendBudget(rows: number, at: string): Promise<{ ok: boolean; note: string | null }> {
    const day = at.slice(0, 10);
    const spent = await this.source.writesToday(day).catch(() => 0);
    if (spent + rows > DAILY_WRITE_CEILING) {
      return {
        ok: false,
        note: `refused: ${spent} nflverse writes already today, ${rows} more would pass the ${DAILY_WRITE_CEILING} ceiling`,
      };
    }
    await this.source.addWrites(day, rows, at).catch(() => {});
    return { ok: true, note: null };
  }
}

function pct(part: number, whole: number): string {
  if (whole <= 0) return '0%';
  return `${Math.round((part / whole) * 100)}%`;
}
