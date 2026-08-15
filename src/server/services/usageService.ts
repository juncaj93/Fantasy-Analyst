/**
 * One place that knows how a player is actually being used.
 *
 * Two responsibilities, kept apart exactly as the injury service keeps them:
 *
 *   - **ingest** pulls the published weekly stats, maps them onto canonical
 *     players, stores the week, and records exactly what landed;
 *   - **read** assembles the per-game series the role detector needs.
 *
 * Nothing here decides what a rising target count *means* — `assessRole` does
 * that, and it has been written and tested since the season brief with nothing
 * to read. This decides what is true, how old it is, and how much of it there
 * is.
 *
 * ## Failure is a state, not an exception
 *
 * Every screen worked before this existed and must keep working when it breaks.
 * `refresh` returns what happened rather than throwing, a preseason 404 is
 * reported as "not published yet", and the read path returning nothing simply
 * puts the detector back to `insufficient_data`, which is what it has always
 * said.
 *
 * ## Why this runs daily and not every five minutes
 *
 * The injury check runs every five minutes because a player is ruled out ninety
 * minutes before kickoff and no fixed window covers that. Usage is the opposite
 * kind of fact: a game's target count is settled when the game ends and never
 * changes again, so there is no hour of the day at which asking more often
 * learns anything. It rides the daily 09:00 UTC cron, which is roughly 5am
 * Eastern — after Sunday's late games and Monday night have finished and
 * nflverse's own pipeline has run. A Sunday-night game that lands too late for
 * Monday's tick is picked up on Tuesday's, six days before it could matter to a
 * lineup.
 */

import type { Database } from '../db.ts';
import { UsageRepo, UsageSourceRepo, type StoredUsageWeek, type UsageSourceRun } from '../repos/usage.ts';
import { PlayerRepo } from '../repos/players.ts';
import { normalizeName } from '../../core/identity/normalize.ts';
import type { CanonicalPlayer } from '../../core/identity/types.ts';
import { looksAnomalous } from '../../core/injury/diff.ts';
import { resolveToCanonical, type IdentityIndex } from './injuryService.ts';
import { diffUsage, keyOf, type ComparableUsage } from '../../core/usage/diff.ts';
import { toRoleMetrics, ROLE_WINDOW_GAMES } from '../../core/usage/role.ts';
import { fetchWeeklyUsage, type FetchLike, type UsageRow } from '../../core/usage/nflverse.ts';
import { WEEKLY_THRESHOLDS, type RoleMetric } from '../../core/startsit/decisions.ts';

export const USAGE_SOURCE = 'nflverse';

/**
 * How long one invocation may own the ingest.
 *
 * Comfortably longer than a parse of the file and comfortably shorter than the
 * gap between ticks, so a crashed Worker costs at most one skipped check rather
 * than a wedged pipeline.
 */
export const INGEST_LEASE_SECONDS = 120;

/**
 * The most rows this pipeline may write in a UTC day before it stops.
 *
 * D1's free tier allows 100,000 across everything. A healthy day here is one
 * week of ~350 skill-position rows on the morning after a game day and zero on
 * the days between; a catch-up day is a second week on top. Two thousand is far
 * above any legitimate day and far below anything that would threaten the rest
 * of the app — and it is a separate ledger from the injury one, so neither
 * pipeline can spend the other's allowance or hide the other's runaway.
 */
export const DAILY_WRITE_CEILING = 2_000;

/** The games the detector needs before it will say anything: 3 recent + 3 baseline. */
export const MINIMUM_GAMES = WEEKLY_THRESHOLDS.role.recentGames + WEEKLY_THRESHOLDS.role.minBaselineGames;

/** The season weekly stats are published for: the one being played. */
export function usageSeason(now = new Date()): string {
  const year = now.getUTCFullYear();
  // The file runs from September into February, so a January date still belongs
  // to the previous calendar year's season.
  return String(now.getUTCMonth() >= 2 ? year : year - 1);
}

export interface UsageHealth {
  source: string;
  season: string;
  lastRun: UsageSourceRun | null;
  /** How many players the store holds any usage for. */
  players: number;
  /** …and how many of those have enough games for the detector to speak. */
  playersWithEnoughGames: number;
  minimumGames: number;
  weeks: number;
  latestWeek: number | null;
  rows: number;
  summary: string;
  /**
   * The three timestamps, kept apart on purpose.
   *
   * `checkedAt` moves every morning. `sourceModifiedAt` is when the file last
   * actually changed. `ingestedAt` is when we last stored anything. A panel
   * showing only the first would say "updated 4 hours ago" about a week that
   * has not moved since Tuesday.
   */
  checkedAt: string | null;
  sourceModifiedAt: string | null;
  ingestedAt: string | null;
  lastOutcome: string | null;
  lastNote: string | null;
  /** The stored validators, verbatim — the mechanism that makes a 304 possible. */
  etag: string | null;
  lastModified: string | null;
  /** Ingests that started and did not finish, in a row. */
  consecutiveFailures: number;
  failingSince: string | null;
  caughtUpThrough: number | null;
  /** One sentence a person can act on. */
  dataHealth: string;
  writesToday: number;
  writeCeiling: number;
}

export class UsageService {
  private readonly repo: UsageRepo;
  private readonly source: UsageSourceRepo;
  private readonly players: PlayerRepo;

  constructor(
    db: Database,
    private readonly deps: { fetch?: FetchLike; now?: () => Date; log?: (line: string) => void } = {},
  ) {
    this.repo = new UsageRepo(db);
    this.source = new UsageSourceRepo(db);
    this.players = new PlayerRepo(db);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private log(line: string): void {
    (this.deps.log ?? console.log)(line);
  }

  /**
   * One tick of the daily check.
   *
   * Three frequencies, and the whole design is refusing to conflate them:
   *
   *   - **check** once a day — a conditional GET, 304 on most days, no body,
   *     one bookkeeping write;
   *   - **ingest** only when the file actually changed — parse one week;
   *   - **write** only for players whose numbers actually moved, which after a
   *     week has settled is none of them.
   *
   * Never throws. Every failure mode — network, 404, schema change, a lease
   * somebody else holds — returns a run describing what happened and leaves the
   * last-good data untouched.
   */
  async refresh(season = usageSeason(this.now())): Promise<UsageSourceRun> {
    const now = this.now();
    const fetchedAt = now.toISOString();
    const base: UsageSourceRun = {
      source: USAGE_SOURCE,
      season,
      week: null,
      latestWeek: null,
      fetchedAt,
      publishedAt: null,
      rowsReturned: 0,
      matchedById: 0,
      matchedByName: 0,
      unmatched: 0,
      rowsWritten: 0,
      outcome: 'failed',
      note: null,
    };

    const known = await this.source.get(USAGE_SOURCE, season).catch(() => null);

    let fetched;
    try {
      fetched = await fetchWeeklyUsage(season, {
        fetch: this.deps.fetch,
        fingerprint: known ? { etag: known.etag, lastModified: known.lastModified } : null,
      });
    } catch (err) {
      const note = err instanceof Error ? err.message : String(err);
      await this.source.recordCheck(USAGE_SOURCE, season, { checkedAt: fetchedAt, outcome: 'failed', note });
      await this.source.recordIngestFailure(USAGE_SOURCE, season, fetchedAt, note).catch(() => {});
      return { ...base, note };
    }

    /*
     * The common answer between game days, and the one that has to be free.
     * Nothing is downloaded, nothing is parsed, no row is touched. The only
     * write is `checked_at`, which is what keeps "the pipeline is alive"
     * answerable without pretending the data got newer.
     */
    if (fetched.outcome === 'not_modified') {
      await this.source.recordCheck(USAGE_SOURCE, season, {
        checkedAt: fetchedAt,
        etag: fetched.fingerprint.etag,
        lastModified: fetched.fingerprint.lastModified,
        outcome: 'not_modified',
        note: null,
      });
      // A 304 is the pipeline working, so it ends a run of failures. It says
      // nothing about how far the store is caught up, so that is left alone.
      await this.source.recordIngestSuccess(USAGE_SOURCE, season, null).catch(() => {});
      this.log(`usage-refresh checked=true modified=false writes=0 season=${season}`);
      return { ...base, outcome: 'ok', note: 'source unchanged', publishedAt: known?.sourceModifiedAt ?? null };
    }

    if (fetched.outcome === 'not_published' || fetched.outcome === 'failed') {
      /*
       * No file is usually not a fault. `stats_player_week_2026.csv` is a 404 in
       * August because no games have been played. Recording that as a failure
       * would put a red light on a panel for a condition that resolves itself in
       * September.
       */
      await this.source.recordCheck(USAGE_SOURCE, season, {
        checkedAt: fetchedAt,
        outcome: fetched.outcome,
        note: fetched.note,
      });
      const run: UsageSourceRun = { ...base, outcome: fetched.outcome, note: fetched.note };
      await this.repo.recordRun(run);
      return run;
    }

    /*
     * The source changed. Exactly one invocation may act on that — a compare-
     * and-swap lease that expires, so a Worker killed mid-parse cannot wedge
     * the pipeline either.
     */
    const owner = `${fetchedAt}:${season}`;
    const holds = await this.source
      .acquireLock(USAGE_SOURCE, season, owner, now, INGEST_LEASE_SECONDS)
      .catch(() => false);
    if (!holds) {
      this.log(`usage-refresh modified=true skipped=locked season=${season}`);
      return { ...base, outcome: 'ok', note: 'another ingest is already running' };
    }

    try {
      return await this.ingest(fetched.usage!, season, base, fetched.publishedAt, fetched.fingerprint);
    } finally {
      await this.source.releaseLock(USAGE_SOURCE, season, owner).catch(() => {});
    }
  }

  /**
   * Fill in a week the app was not running for.
   *
   * The steady state reads one week — the latest — which is right while the app
   * is up and wrong the moment it is not. A week nobody read is a hole, and a
   * hole is worse here than it is for injuries: the detector reads a *run* of
   * games, so one missing week quietly shortens every series that spans it and
   * the answer changes without anything looking wrong.
   *
   * So this walks the gap, one week per tick, oldest first, and is deliberately
   * quieter than `refresh`: it writes rows and nothing else, and it never
   * touches the stored validator, so a half-filled season cannot look ingested.
   *
   * Returns the week it filled, or null when there was no gap.
   */
  async catchUpOneWeek(season = usageSeason(this.now())): Promise<{ week: number; rows: number } | null> {
    const state = await this.source.get(USAGE_SOURCE, season).catch(() => null);
    const latestStored = state?.caughtUpThrough ?? null;
    if (latestStored == null) return null;

    const missing = await this.repo.missingWeekBefore(season, latestStored).catch(() => null);
    if (missing == null || missing >= latestStored) return null;

    const fetched = await fetchWeeklyUsage(season, {
      fetch: this.deps.fetch,
      // No validator: this is a deliberate download of a file we already know
      // has not changed, so a conditional request would 304 and return nothing.
      fingerprint: null,
      week: missing,
    });
    if (fetched.outcome !== 'ok' || !fetched.usage) return null;

    const { rows } = await this.rowsFor(fetched.usage.rows, season, fetched.publishedAt);
    if (rows.length === 0) return null;
    await this.repo.saveWeeks(rows);
    await this.source
      .addWrites(this.now().toISOString().slice(0, 10), rows.length, this.now().toISOString())
      .catch(() => {});

    this.log(`usage-catchup season=${season} week=${missing} rows=${rows.length}`);
    return { week: missing, rows: rows.length };
  }

  /**
   * Parse the changed file, and write only what moved.
   *
   * Runs under the lease. Split out so the lock's `finally` cannot be skipped by
   * an early return, and so the expensive path reads as one thing.
   */
  private async ingest(
    usage: NonNullable<Awaited<ReturnType<typeof fetchWeeklyUsage>>['usage']>,
    season: string,
    base: UsageSourceRun,
    publishedAt: string | null,
    fingerprint: { etag: string | null; lastModified: string | null },
  ): Promise<UsageSourceRun> {
    const fetchedAt = base.fetchedAt;
    const startedAt = Date.now();

    const { rows, matchedById, matchedByName, unmatched } = await this.rowsFor(usage.rows, season, publishedAt);
    const withRun: UsageSourceRun = {
      ...base,
      week: usage.week,
      latestWeek: usage.latestWeek,
      publishedAt,
      rowsReturned: usage.rows.length,
      matchedById,
      matchedByName,
      unmatched,
    };

    /*
     * A file that parsed to nothing recognisable is a parser or schema problem,
     * not an empty league. Overwriting good data with it is the one outcome
     * worth refusing outright.
     */
    if (rows.length === 0) {
      const note = 'no rows in the file mapped to a known player — source shape may have changed';
      await this.source.recordCheck(USAGE_SOURCE, season, { checkedAt: fetchedAt, outcome: 'failed', note });
      await this.source.recordIngestFailure(USAGE_SOURCE, season, fetchedAt, note).catch(() => {});
      const run: UsageSourceRun = { ...withRun, outcome: 'failed', note };
      await this.repo.recordRun(run);
      return run;
    }

    const fullByKey = new Map(rows.map((r) => [keyOf(r), r]));
    const comparable: ComparableUsage[] = rows.map((r) => ({
      playerId: r.playerId,
      season: r.season,
      week: r.week,
      passAttempts: r.passAttempts,
      carries: r.carries,
      targets: r.targets,
      receptions: r.receptions,
      targetShare: r.targetShare,
      wopr: r.wopr,
    }));
    const stored = await this.repo
      .comparableFor(comparable.map((r) => ({ playerId: r.playerId, week: r.week })), season)
      .catch(() => new Map<string, ComparableUsage>());
    const diff = diffUsage(comparable, stored);

    /*
     * A parser that breaks does not fail loudly — it reads every field as empty
     * and reports that every player's usage moved at once. That is
     * indistinguishable from a real mass update except by its size, which is
     * what this checks. The guard is shared with the injury pipeline because it
     * is the same failure and the same arithmetic.
     *
     * A first ingest of a *new week* legitimately changes everything it touches,
     * and would trip a naive share test every single week. So the comparison is
     * against the rows this ingest would overwrite: a week nobody has stored
     * yet has nothing to be anomalous against, and a week being rewritten
     * wholesale is exactly the thing worth refusing.
     */
    if (looksAnomalous({ changed: diff.changed, examined: diff.examined }, stored.size)) {
      const note =
        `refused: ${diff.changed.length} of ${diff.examined} players' usage changed at once, ` +
        'which looks like a source or parser change rather than a revised box score';
      await this.source.recordCheck(USAGE_SOURCE, season, { checkedAt: fetchedAt, outcome: 'anomaly', note });
      await this.source.recordIngestFailure(USAGE_SOURCE, season, fetchedAt, note).catch(() => {});
      const run: UsageSourceRun = { ...withRun, outcome: 'failed', note };
      await this.repo.recordRun(run);
      this.log(`usage-refresh modified=true anomaly=true changed=${diff.changed.length} writes=0`);
      return run;
    }

    const day = fetchedAt.slice(0, 10);
    const spent = await this.source.writesToday(day).catch(() => 0);
    if (spent + diff.changed.length > DAILY_WRITE_CEILING) {
      const note = `refused: ${spent} usage writes already today, ${diff.changed.length} more would pass the ${DAILY_WRITE_CEILING} ceiling`;
      await this.source.recordCheck(USAGE_SOURCE, season, { checkedAt: fetchedAt, outcome: 'budget', note });
      await this.source.recordIngestFailure(USAGE_SOURCE, season, fetchedAt, note).catch(() => {});
      const run: UsageSourceRun = { ...withRun, outcome: 'failed', note };
      await this.repo.recordRun(run);
      return run;
    }

    // Only the rows whose numbers moved.
    const toWrite = diff.changed.map((c) => fullByKey.get(keyOf(c))!).filter(Boolean);
    await this.repo.saveWeeks(toWrite);
    await this.source.addWrites(day, toWrite.length, fetchedAt);

    await this.source.recordCheck(USAGE_SOURCE, season, {
      checkedAt: fetchedAt,
      etag: fingerprint.etag,
      lastModified: fingerprint.lastModified,
      sourceModifiedAt: publishedAt,
      ingestedAt: fetchedAt,
      outcome: 'ok',
      note: null,
    });
    await this.source.recordIngestSuccess(USAGE_SOURCE, season, usage.latestWeek || null).catch(() => {});

    const run: UsageSourceRun = { ...withRun, rowsWritten: toWrite.length, outcome: 'ok', note: null };
    await this.repo.recordRun(run);
    this.log(
      `usage-refresh modified=true week=${usage.week} parsed=${diff.examined} unchanged=${diff.unchanged} ` +
        `changed=${diff.changed.length} writes=${toWrite.length} ms=${Date.now() - startedAt}`,
    );
    return run;
  }

  /** Map raw rows onto canonical players. Unresolved rows are dropped, not guessed. */
  private async rowsFor(
    raw: UsageRow[],
    season: string,
    publishedAt: string | null,
  ): Promise<{ rows: StoredUsageWeek[]; matchedById: number; matchedByName: number; unmatched: number }> {
    const index = await this.resolveIdentities(raw);
    const fetchedAt = this.now().toISOString();
    const rows: StoredUsageWeek[] = [];
    let matchedById = 0;
    let matchedByName = 0;
    let unmatched = 0;

    for (const row of raw) {
      const match = resolveToCanonical({ fullName: row.fullName, gsisId: row.gsisId || null }, index);
      if (!match) {
        unmatched++;
        continue;
      }
      if (match.by === 'id') matchedById++;
      else matchedByName++;
      rows.push({
        playerId: match.playerId,
        season: row.season || season,
        week: row.week,
        seasonType: row.seasonType,
        team: row.team || null,
        position: row.position || null,
        passAttempts: row.passAttempts,
        carries: row.carries,
        targets: row.targets,
        receptions: row.receptions,
        targetShare: row.targetShare,
        wopr: row.wopr,
        gsisId: row.gsisId,
        source: USAGE_SOURCE,
        publishedAt,
        fetchedAt,
      });
    }
    return { rows, matchedById, matchedByName, unmatched };
  }

  /**
   * Resolve only the players this week actually mentions.
   *
   * The same path the injury ingest uses, and deliberately the same code: one
   * canonical normalizer, one indexed column, one resolver that prefers a GSIS
   * id and declines an ambiguous name rather than guessing. Building an index
   * of the whole four-thousand-player dictionary instead cost 17ms of CPU when
   * the injury pipeline tried it — more than a Workers invocation is allowed in
   * total.
   */
  private async resolveIdentities(rows: UsageRow[]): Promise<IdentityIndex> {
    const keys = rows.map((r) => normalizeName(r.fullName));
    const candidates = await this.players.findByNormalizedNames(keys);

    const byName = new Map<string, CanonicalPlayer[]>();
    for (const player of candidates) {
      const list = byName.get(player.normalizedName);
      if (list) list.push(player);
      else byName.set(player.normalizedName, [player]);
    }
    return { byName };
  }

  /**
   * The per-game series for a set of players, ready for `assessRole`.
   *
   * Returns nothing for a player with no stored usage, which is not an error:
   * the detector's answer for an empty series is `insufficient_data`, and that
   * is exactly what the app said before this pipeline existed. It is also what
   * it says for a player with five games, because five is not six.
   */
  async roleMetricsFor(
    players: { playerId: string; position: string }[],
    season = usageSeason(this.now()),
  ): Promise<Map<string, RoleMetric[]>> {
    const out = new Map<string, RoleMetric[]>();
    if (players.length === 0) return out;

    const weeks = await this.repo
      .weeksFor(players.map((p) => p.playerId), season, ROLE_WINDOW_GAMES)
      .catch(() => new Map<string, StoredUsageWeek[]>());

    for (const player of players) {
      const stored = weeks.get(player.playerId);
      if (!stored || stored.length === 0) continue;
      const metrics = toRoleMetrics(player.position, stored);
      if (metrics.length > 0) out.set(player.playerId, metrics);
    }
    return out;
  }

  async health(season = usageSeason(this.now())): Promise<UsageHealth> {
    const day = this.now().toISOString().slice(0, 10);
    const [lastRun, coverage, state, writes, ready] = await Promise.all([
      this.repo.latestRun().catch(() => null),
      this.repo.coverage(season).catch(() => ({ players: 0, weeks: 0, latestWeek: null, rows: 0 })),
      this.source.get(USAGE_SOURCE, season).catch(() => null),
      this.source.writesToday(day).catch(() => 0),
      this.repo.playersWithGames(season, MINIMUM_GAMES).catch(() => 0),
    ]);

    return {
      source: USAGE_SOURCE,
      season,
      lastRun,
      players: coverage.players,
      playersWithEnoughGames: ready,
      minimumGames: MINIMUM_GAMES,
      weeks: coverage.weeks,
      latestWeek: coverage.latestWeek,
      rows: coverage.rows,
      summary: describeUsage(season, lastRun, coverage, ready, state),
      checkedAt: state?.checkedAt ?? null,
      sourceModifiedAt: state?.sourceModifiedAt ?? null,
      ingestedAt: state?.ingestedAt ?? null,
      lastOutcome: state?.lastOutcome ?? null,
      lastNote: state?.lastNote ?? null,
      etag: state?.etag ?? null,
      lastModified: state?.lastModified ?? null,
      consecutiveFailures: state?.consecutiveFailures ?? 0,
      failingSince: state?.failingSince ?? null,
      caughtUpThrough: state?.caughtUpThrough ?? null,
      dataHealth: describeUsageHealth(state, lastRun),
      writesToday: writes,
      writeCeiling: DAILY_WRITE_CEILING,
    };
  }
}

/**
 * What the store holds, in a sentence.
 *
 * The number that matters is not how many players have *a* row, it is how many
 * have six — below that the detector says nothing about them, and a panel
 * reporting "412 players" while every card says "insufficient data" would be
 * telling the truth in the least useful available way.
 */
export function describeUsage(
  season: string,
  run: UsageSourceRun | null,
  coverage: { players: number; weeks: number; latestWeek: number | null },
  ready: number,
  state?: { checkedAt: string | null } | null,
): string {
  if (!run) {
    const checking = state?.checkedAt ? ' The daily check is running.' : '';
    return `No per-game usage yet — the ${season} weekly stats have not been ingested.${checking}`;
  }
  if (run.outcome === 'not_published') {
    return `No per-game usage yet — nflverse has not published ${season} weekly stats, which is expected before the first game.`;
  }
  if (run.outcome === 'failed' && coverage.players === 0) {
    return `No per-game usage — the last fetch failed (${run.note ?? 'no reason given'}).`;
  }
  return (
    `Week ${coverage.latestWeek ?? run.latestWeek} of ${season}: ${coverage.players} players across ` +
    `${coverage.weeks} week(s), ${ready} of them with the ${MINIMUM_GAMES} games the role detector needs.`
  );
}

/**
 * Whether the usage data can be trusted right now.
 *
 * Failure first, because a run of failed ingests is the one state a fresh
 * `checked_at` actively disguises — the panel would otherwise read identically
 * whether the pipeline is healthy or has been dead since Tuesday.
 */
export function describeUsageHealth(
  state: { consecutiveFailures?: number; failingSince?: string | null; ingestedAt?: string | null } | null,
  lastRun: { outcome?: string } | null,
): string {
  const failures = state?.consecutiveFailures ?? 0;
  if (failures >= 2) {
    const since = state?.failingSince ? ` since ${state.failingSince.slice(0, 16).replace('T', ' ')}` : '';
    return `Checks are running, but the last ${failures} usage ingests did not complete${since}. The weeks shown are the last that landed.`;
  }
  if (failures === 1) {
    return 'The most recent usage ingest did not complete. The weeks shown are the last that landed, and the next check will retry.';
  }
  if (lastRun?.outcome === 'not_published') {
    return 'No weekly stats are published for this season yet, so role changes cannot be detected until games are played. Checked daily.';
  }
  if (!state?.ingestedAt) {
    return 'Nothing has been ingested yet, so the role detector has no series to read.';
  }
  return 'Usage is current: the file is checked daily and the last ingest completed.';
}
