/**
 * One place that knows a player's injury situation, for every screen that asks.
 *
 * Two responsibilities and they are kept apart:
 *
 *   - **ingest** pulls the published injury report, maps it onto canonical
 *     players, stores it, and records exactly what landed;
 *   - **read** combines the stored report with Sleeper's live designation into
 *     the one normalized state defined in `core/injury/model.ts`.
 *
 * Nothing here decides what an injury *means* — that is Start/Sit's job and
 * Trades' job, and they answer it differently on purpose. This decides what is
 * true, how old it is, and whether the sources agree.
 *
 * ## Failure is a state, not an exception
 *
 * The secondary source going away must never cost the user their screen.
 * `refresh` returns what happened rather than throwing, a preseason 404 is
 * reported as "not published yet" rather than as an error, and every read falls
 * back to Sleeper's designation on its own — which is the state the app was in
 * before this existed and is still a working one.
 */

import type { Database } from '../db.ts';
import { InjuryRepo, InjurySourceRepo, type InjurySourceRun, type StoredInjuryReport } from '../repos/injury.ts';
import { InjuryHistoryRepo } from '../repos/injuryHistory.ts';
import { PlayerRepo } from '../repos/players.ts';
import {
  NO_INJURY_INFORMATION,
  normalizeDesignation,
  resolveInjury,
  type InjuryObservation,
  type InjuryState,
} from '../../core/injury/model.ts';
import {
  RECENT_WEEKS,
  fetchInjuryReport,
  latestByPlayer,
  type FetchLike,
  type InjuryReportRow,
} from '../../core/injury/nflverse.ts';
import { normalizeName } from '../../core/identity/normalize.ts';
import type { CanonicalPlayer } from '../../core/identity/types.ts';
import { diffInjuries, keyOf, looksAnomalous } from '../../core/injury/diff.ts';

export const INJURY_SOURCE = 'nflverse';
export const STATUS_SOURCE = 'sleeper';

/**
 * How long one invocation may own the ingest.
 *
 * Comfortably longer than a parse of the whole season file and comfortably
 * shorter than the gap between ticks, so a crashed Worker costs at most one
 * skipped check rather than a wedged pipeline.
 */
export const INGEST_LEASE_SECONDS = 120;

/**
 * The most rows this pipeline may write in a UTC day before it stops.
 *
 * D1's free tier allows 100,000. A healthy day here is a few dozen — several
 * hundred on a week rollover, when every player's latest week genuinely
 * advances. Five thousand is far above any legitimate day and far below
 * anything that would threaten the rest of the app.
 */
export const DAILY_WRITE_CEILING = 5_000;

/** The season injury reports are published for: the one being played. */
export function injurySeason(now = new Date()): string {
  const year = now.getUTCFullYear();
  // Reports run from the preseason into January, so a January date still
  // belongs to the previous calendar year's season.
  return String(now.getUTCMonth() >= 2 ? year : year - 1);
}

/**
 * The season before the current one — the finished one, and the only one whose
 * file is guaranteed to be complete and to never change again.
 *
 * Derived from `injurySeason` rather than from the calendar directly, so the
 * two cannot drift apart across the February boundary where "this season" and
 * "this year" stop agreeing.
 */
export function previousSeason(now = new Date()): string {
  return String(Number(injurySeason(now)) - 1);
}

export interface InjuryHealth {
  /** Sleeper — the authority on designation, and never not present. */
  statusSource: string;
  /** The published report, and how it went. */
  reportSource: string;
  season: string;
  lastRun: InjurySourceRun | null;
  /** How many players the store currently holds a report for. */
  players: number;
  latestWeek: number | null;
  /** Plain sentence for the panel, so the state is readable without arithmetic. */
  summary: string;
  /**
   * The three timestamps, kept apart on purpose.
   *
   * `checkedAt` moves every five minutes. `sourceModifiedAt` is when the NFL's
   * report last actually changed. `ingestedAt` is when we last stored anything.
   * A panel that showed only the first would say "updated 2 minutes ago" about
   * a report from Wednesday, which is the most expensive kind of wrong.
   */
  checkedAt: string | null;
  sourceModifiedAt: string | null;
  ingestedAt: string | null;
  /** How the last check went — including `not_modified`, the usual answer. */
  lastOutcome: string | null;
  lastNote: string | null;
  /**
   * The stored validators, verbatim.
   *
   * These are the whole mechanism: a check sends one of them back and the
   * server answers 304. Exposing them makes the difference between the two
   * ways a tick can write nothing directly observable rather than inferred --
   * a validator present means "asked, and the file had not changed", and a
   * validator absent means there was nothing to ask about, which is what a
   * season whose file has not been published yet looks like.
   *
   * Both are public HTTP validators for a public file. Neither identifies
   * anyone or authorizes anything.
   */
  etag: string | null;
  lastModified: string | null;
  /**
   * Ingests that started and did not finish, in a row.
   *
   * The field that stops a fresh `checkedAt` from vouching for stale data. A
   * pipeline checking happily every five minutes while four consecutive ingests
   * died looks identical to a healthy one from every other number here.
   */
  consecutiveFailures: number;
  failingSince: string | null;
  /** The highest week the store has, so a gap against the source is visible. */
  caughtUpThrough: number | null;
  /**
   * One sentence a person can act on, derived from the numbers above rather
   * than from any single one of them.
   */
  dataHealth: string;
  /**
   * Last season, which is a different question from this one.
   *
   * Present so the panel can distinguish two states that both look like "no
   * injury data": the current season's file has not been published, and the
   * previous season's has been read in full. The second is what proves the
   * published-file path works at all while the first is still a 404.
   */
  history: {
    season: string;
    /** 'weeks' | 'players' | 'done', or null before the walk starts. */
    phase: string | null;
    weeksDone: number;
    lastWeek: number | null;
    rowsSeen: number;
    playersSummarized: number;
    /** Players whose season cleared the thresholds and carries a note. */
    significantPlayers: number;
    /** The validator stored for the finished season, which makes a 304 possible. */
    etag: string | null;
    lastModified: string | null;
    ingestedAt: string | null;
    lastOutcome: string | null;
    completedAt: string | null;
    note: string | null;
  };
  /** Rows this pipeline has written today, against its own ceiling. */
  writesToday: number;
  writeCeiling: number;
  /** The most recent transitions, newest first. */
  recentEvents: {
    playerId: string;
    week: number;
    kind: string;
    from: string | null;
    to: string | null;
    detectedAt: string;
  }[];
}

export class InjuryService {
  private readonly repo: InjuryRepo;
  private readonly source: InjurySourceRepo;
  private readonly players: PlayerRepo;

  constructor(
    private readonly db: Database,
    private readonly deps: { fetch?: FetchLike; now?: () => Date; log?: (line: string) => void } = {},
  ) {
    this.repo = new InjuryRepo(db);
    this.source = new InjurySourceRepo(db);
    this.players = new PlayerRepo(db);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /**
   * One tick of the five-minute check.
   *
   * Three frequencies, and the whole design is refusing to conflate them:
   *
   *   - **check** every five minutes — a conditional GET, usually 304, no body,
   *     one bookkeeping write;
   *   - **ingest** only when the file actually changed — parse once;
   *   - **write** only for players whose normalized state actually moved.
   *
   * A file republished with three revised players arrives as four hundred rows,
   * three hundred and ninety-seven of them identical to what is stored. Writing
   * all four hundred every five minutes would cost more than the entire daily
   * D1 free-tier budget to record three facts.
   *
   * Never throws. Every failure mode — network, 404, schema change, a lease
   * somebody else holds — returns a run describing what happened and leaves the
   * last-good data untouched.
   */
  async refresh(season = injurySeason(this.now())): Promise<InjurySourceRun> {
    const now = this.now();
    const fetchedAt = now.toISOString();
    const base: InjurySourceRun = {
      source: INJURY_SOURCE,
      season,
      latestWeek: null,
      fetchedAt,
      publishedAt: null,
      rowsReturned: 0,
      matchedById: 0,
      matchedByName: 0,
      unmatched: 0,
      outcome: 'failed',
      note: null,
    };

    const known = await this.source.get(INJURY_SOURCE, season).catch(() => null);

    let fetched;
    try {
      fetched = await fetchInjuryReport(season, {
        fetch: this.deps.fetch,
        fingerprint: known ? { etag: known.etag, lastModified: known.lastModified } : null,
        /*
         * Bounded on purpose. Parsing a whole season costs about 160ms of CPU
         * and a Workers invocation is allowed 10ms; narrowing to the recent
         * weeks first brings the whole ingest in under the ceiling. Nothing is
         * lost — a player whose latest report is older already has that row
         * stored, because the ingest that saw it wrote it.
         */
        recentWeeks: RECENT_WEEKS,
      });
    } catch (err) {
      const note = err instanceof Error ? err.message : String(err);
      await this.source.recordCheck(INJURY_SOURCE, season, {
        checkedAt: fetchedAt,
        outcome: 'failed',
        note,
      });
      await this.source.recordIngestFailure(INJURY_SOURCE, season, fetchedAt, note).catch(() => {});
      return { ...base, note };
    }

    /*
     * The common answer, and the one that has to be nearly free.
     *
     * Nothing is downloaded, nothing is parsed, no player row is touched, no
     * event is appended and nothing downstream recomputes. The only write is
     * `checked_at` on a one-row table, which is what keeps "the pipeline is
     * alive" answerable without pretending the data got newer.
     */
    if (fetched.outcome === 'not_modified') {
      await this.source.recordCheck(INJURY_SOURCE, season, {
        checkedAt: fetchedAt,
        etag: fetched.fingerprint.etag,
        lastModified: fetched.fingerprint.lastModified,
        outcome: 'not_modified',
        note: null,
      });
      /*
       * A 304 is the pipeline working, so it ends a run of failures. It says
       * nothing about how far the store is caught up, so that is left alone.
       */
      await this.source.recordIngestSuccess(INJURY_SOURCE, season, null).catch(() => {});
      this.log(`injury-refresh checked=true modified=false writes=0 season=${season}`);
      return { ...base, outcome: 'ok', note: 'source unchanged', publishedAt: known?.sourceModifiedAt ?? null };
    }

    if (fetched.outcome === 'not_published' || fetched.outcome === 'failed') {
      /*
       * No file is usually not a fault.
       *
       * `injuries_2026.csv` is a 404 in August because the NFL has not filed an
       * injury report yet. Recording that as a failure would put a red light on
       * a panel for a condition that resolves itself in September, and an alarm
       * that cries wolf every preseason is an alarm nobody reads in November.
       */
      await this.source.recordCheck(INJURY_SOURCE, season, {
        checkedAt: fetchedAt,
        outcome: fetched.outcome,
        note: fetched.note,
      });
      const run: InjurySourceRun = { ...base, outcome: fetched.outcome, note: fetched.note };
      await this.repo.recordRun(run);
      return run;
    }

    /*
     * The source changed. Exactly one invocation may act on that.
     *
     * At a five-minute cadence a slow ingest could still be running when the
     * next tick fires; both would download the same file and race to write the
     * same rows. The lease is a compare-and-swap that expires, so a Worker
     * killed mid-parse cannot wedge the pipeline either.
     */
    const owner = `${fetchedAt}:${season}`;
    const holds = await this.source
      .acquireLock(INJURY_SOURCE, season, owner, now, INGEST_LEASE_SECONDS)
      .catch(() => false);
    if (!holds) {
      this.log(`injury-refresh modified=true skipped=locked season=${season}`);
      return { ...base, outcome: 'ok', note: 'another ingest is already running' };
    }

    try {
      return await this.ingest(fetched, season, base);
    } finally {
      await this.source.releaseLock(INJURY_SOURCE, season, owner).catch(() => {});
    }
  }

  /**
   * Fill in a week the app was not running for.
   *
   * The steady-state window is one week, which is right while the app is up and
   * wrong the moment it is not: an app that misses a fortnight comes back, reads
   * the latest week, and leaves a hole where two weeks of practice history
   * should be. The hole is invisible in current state -- the latest week is
   * still the latest week -- and shows up later as a practice trend computed
   * across a gap.
   *
   * So this walks the gap, one week per tick, oldest first. It is deliberately
   * separate from `refresh` and deliberately quieter:
   *
   *   - it writes rows and nothing else. No diff, no events, no downstream
   *     recomputation, because a week from a fortnight ago cannot change whether
   *     anybody plays on Sunday;
   *   - it never touches the stored validator, so it cannot make a half-filled
   *     season look ingested;
   *   - it costs one bounded week, so it fits the same budget as a normal tick.
   *
   * Returns the week it filled, or null when there was no gap to fill.
   */
  async catchUpOneWeek(season = injurySeason(this.now())): Promise<{ week: number; rows: number } | null> {
    const state = await this.source.get(INJURY_SOURCE, season).catch(() => null);
    const latestStored = state?.caughtUpThrough ?? null;
    if (latestStored == null) return null;

    const coverage = await this.repo.coverage(season).catch(() => ({ players: 0, latestWeek: null }));
    const haveThrough = coverage.latestWeek ?? 0;
    /*
     * The gap is between the oldest week the store is missing and the newest it
     * has. `caught_up_through` is the file's latest week at the last successful
     * ingest; anything below it that is absent is a week nobody read.
     */
    const missing = await this.repo.missingWeekBefore(season, latestStored).catch(() => null);
    if (missing == null || missing >= latestStored) return null;
    void haveThrough;

    const fetched = await fetchInjuryReport(season, {
      fetch: this.deps.fetch,
      fingerprint: null,
      weeks: { from: missing, to: missing },
    });
    if (fetched.outcome !== 'ok' || !fetched.report) return null;

    const rows = await this.rowsFor(fetched.report.rows, season, fetched.publishedAt);
    await this.repo.saveReports(rows);
    await this.source
      .addWrites(this.now().toISOString().slice(0, 10), rows.length, this.now().toISOString())
      .catch(() => {});

    this.log(`injury-catchup season=${season} week=${missing} rows=${rows.length}`);
    return { week: missing, rows: rows.length };
  }

  /** Map raw rows onto canonical players. Unresolved rows are dropped, not guessed. */
  private async rowsFor(
    raw: InjuryReportRow[],
    season: string,
    publishedAt: string | null,
  ): Promise<StoredInjuryReport[]> {
    const index = await this.resolveIdentities(raw);
    const fetchedAt = this.now().toISOString();
    const out: StoredInjuryReport[] = [];
    for (const row of raw) {
      const match = resolveToCanonical(row, index);
      if (!match) continue;
      out.push({
        playerId: match.playerId,
        season: row.season || season,
        week: row.week,
        team: row.team || null,
        reportStatus: row.reportStatus,
        primaryInjury: row.primaryInjury,
        secondaryInjury: row.secondaryInjury,
        practiceStatus: row.practiceStatus,
        practiceRaw: row.practiceRaw,
        gsisId: row.gsisId,
        source: INJURY_SOURCE,
        publishedAt,
        fetchedAt,
      });
    }
    return out;
  }

  /**
   * Parse the changed file, and write only what moved.
   *
   * Runs under the lease. Split out so the lock's `finally` cannot be skipped by
   * an early return, and so the expensive path reads as one thing.
   */
  private async ingest(
    fetched: Awaited<ReturnType<typeof fetchInjuryReport>>,
    season: string,
    base: InjurySourceRun,
  ): Promise<InjurySourceRun> {
    const report = fetched.report!;
    const fetchedAt = base.fetchedAt;
    /*
     * Timed, because the CPU ceiling is the binding constraint here and the
     * only honest way to know the real number is to measure the real runtime.
     * Local measurement against the 2025 file puts a mid-season ingest at
     * roughly 5ms of parsing against a 10ms allowance — but that box is not a
     * Workers isolate, and D1 calls that count as CPU there do not here. This
     * lands in the log line so production answers the question itself.
     */
    const startedAt = Date.now();
    const latest = latestByPlayer(report);
    const index = await this.resolveIdentities([...latest.values()].map((v) => v.latest));

    const rows: StoredInjuryReport[] = [];
    let matchedById = 0;
    let matchedByName = 0;
    let unmatched = 0;

    for (const { latest: row } of latest.values()) {
      const match = resolveToCanonical(row, index);
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
        team: row.team || null,
        reportStatus: row.reportStatus,
        primaryInjury: row.primaryInjury,
        secondaryInjury: row.secondaryInjury,
        practiceStatus: row.practiceStatus,
        practiceRaw: row.practiceRaw,
        gsisId: row.gsisId,
        source: INJURY_SOURCE,
        publishedAt: fetched.publishedAt,
        fetchedAt,
      });
    }

    const withRun = {
      ...base,
      latestWeek: report.latestWeek,
      publishedAt: fetched.publishedAt,
      rowsReturned: latest.size,
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
      await this.source.recordCheck(INJURY_SOURCE, season, {
        checkedAt: fetchedAt,
        outcome: 'failed',
        note,
      });
      const run: InjurySourceRun = { ...withRun, outcome: 'failed', note };
      await this.repo.recordRun(run);
      return run;
    }

    /*
     * The diff works on the narrow shape — the fields that change a decision —
     * but what gets written is the whole row, so the full record is kept beside
     * it and recovered by key rather than reconstructed.
     */
    const fullByKey = new Map(rows.map((r) => [keyOf(r), r]));
    const comparable = rows.map((r) => ({
      playerId: r.playerId,
      season: r.season,
      week: r.week,
      reportStatus: r.reportStatus,
      primaryInjury: r.primaryInjury,
      practiceStatus: r.practiceStatus,
    }));
    const stored = await this.source
      .comparableFor(comparable.map((r) => ({ playerId: r.playerId, week: r.week })), season)
      .catch(() => new Map());
    const storedCount = await this.source.storedCount(season).catch(() => 0);
    const diff = diffInjuries(comparable, stored);

    /*
     * A parser that breaks does not fail loudly — it reads every field as empty
     * and reports that all four hundred players simultaneously became healthy.
     * That is indistinguishable from a real mass update except by its size.
     */
    if (looksAnomalous(diff, storedCount)) {
      const note =
        `refused: ${diff.changed.length} of ${diff.examined} players changed at once, ` +
        'which looks like a source or parser change rather than news';
      await this.source.recordCheck(INJURY_SOURCE, season, {
        checkedAt: fetchedAt,
        outcome: 'anomaly',
        note,
      });
      await this.source.recordIngestFailure(INJURY_SOURCE, season, fetchedAt, note).catch(() => {});
      const run: InjurySourceRun = { ...withRun, outcome: 'failed', note };
      await this.repo.recordRun(run);
      this.log(`injury-refresh modified=true anomaly=true changed=${diff.changed.length} writes=0`);
      return run;
    }

    /*
     * The budget guard. Free-tier D1 allows 100,000 writes a day and this
     * pipeline is built to use a few dozen; a bug that starts rewriting
     * everything on every tick would burn the allowance in an afternoon and
     * take the rest of the app down with it.
     */
    const day = fetchedAt.slice(0, 10);
    const spent = await this.source.writesToday(day).catch(() => 0);
    const wanted = diff.changed.length + diff.events.length;
    if (spent + wanted > DAILY_WRITE_CEILING) {
      const note = `refused: ${spent} injury writes already today, ${wanted} more would pass the ${DAILY_WRITE_CEILING} ceiling`;
      await this.source.recordCheck(INJURY_SOURCE, season, {
        checkedAt: fetchedAt,
        outcome: 'budget',
        note,
      });
      await this.source.recordIngestFailure(INJURY_SOURCE, season, fetchedAt, note).catch(() => {});
      const run: InjurySourceRun = { ...withRun, outcome: 'failed', note };
      await this.repo.recordRun(run);
      return run;
    }

    // Only the rows whose normalized state moved.
    const toWrite = diff.changed.map((c) => fullByKey.get(keyOf(c))!).filter(Boolean);
    await this.repo.saveReports(toWrite);
    const eventsWritten = await this.source.recordEvents(diff.events, {
      source: INJURY_SOURCE,
      sourceModifiedAt: fetched.publishedAt,
      detectedAt: fetchedAt,
    });
    await this.source.addWrites(day, diff.changed.length + eventsWritten, fetchedAt);

    await this.source.recordCheck(INJURY_SOURCE, season, {
      checkedAt: fetchedAt,
      etag: fetched.fingerprint.etag,
      lastModified: fetched.fingerprint.lastModified,
      sourceModifiedAt: fetched.publishedAt,
      ingestedAt: fetchedAt,
      outcome: 'ok',
      note: null,
    });

    /*
     * The ingest finished, so any run of failures is over and the store is now
     * current through this file's latest week. Recorded together because they
     * are the same fact: the pipeline did the thing it exists to do.
     */
    await this.source
      .recordIngestSuccess(INJURY_SOURCE, season, report.latestWeek || null)
      .catch(() => {});

    const run: InjurySourceRun = { ...withRun, outcome: 'ok', note: null };
    await this.repo.recordRun(run);
    this.log(
      `injury-refresh modified=true parsed=${diff.examined} unchanged=${diff.unchanged} ` +
        `changed=${diff.changed.length} events=${eventsWritten} writes=${diff.changed.length + eventsWritten} ` +
        `ms=${Date.now() - startedAt}`,
    );
    return { ...run, changedPlayerIds: diff.changedPlayerIds };
  }

  private log(line: string): void {
    // Structured, short, and never carrying a payload or a secret.
    (this.deps.log ?? console.log)(line);
  }

  /**
   * The normalized state for a set of players.
   *
   * Sleeper's designation is passed in rather than re-read, because every
   * caller already holds the canonical player it came from and a second query
   * for a field already in hand is a second chance for the two to disagree.
   */
  async statesFor(
    players: { playerId: string; status: string | null }[],
    opts: { season?: string; statusObservedAt?: string | null } = {},
  ): Promise<Map<string, InjuryState>> {
    const season = opts.season ?? injurySeason(this.now());
    const now = this.now();
    const ids = players.map((p) => p.playerId);
    const reports = await this.repo.latestFor(ids, season).catch(() => new Map<string, StoredInjuryReport>());

    const out = new Map<string, InjuryState>();
    for (const player of players) {
      const observations: InjuryObservation[] = [];

      const sleeper = normalizeDesignation(player.status);
      if (sleeper.designation !== 'unknown') {
        observations.push({
          source: STATUS_SOURCE,
          designation: sleeper.designation,
          raw: sleeper.raw,
          // The player dictionary's own freshness. Sleeper does not stamp a
          // status, so this is the sync time or nothing — and nothing is
          // honest rather than optimistic.
          observedAt: opts.statusObservedAt ?? null,
        });
      }

      const report = reports.get(player.playerId);
      if (report) {
        const reported = normalizeDesignation(report.reportStatus);
        observations.push({
          source: INJURY_SOURCE,
          designation: reported.designation,
          raw: reported.raw,
          observedAt: report.publishedAt ?? report.fetchedAt,
          practice: [report.practiceStatus],
          bodyPart: report.primaryInjury,
        });
      }

      out.set(player.playerId, observations.length === 0 ? NO_INJURY_INFORMATION : resolveInjury(observations, now));
    }
    return out;
  }

  /**
   * One player, with the weeks behind him.
   *
   * The only read that looks at more than the latest week, and deliberately so:
   * a direction is worth computing on an opened card and not on forty rows.
   */
  async stateFor(
    playerId: string,
    status: string | null,
    opts: { season?: string; statusObservedAt?: string | null } = {},
  ): Promise<InjuryState> {
    const season = opts.season ?? injurySeason(this.now());
    const weeks = await this.repo.weeksFor(playerId, season).catch(() => [] as StoredInjuryReport[]);
    const observations: InjuryObservation[] = [];

    const sleeper = normalizeDesignation(status);
    if (sleeper.designation !== 'unknown') {
      observations.push({
        source: STATUS_SOURCE,
        designation: sleeper.designation,
        raw: sleeper.raw,
        observedAt: opts.statusObservedAt ?? null,
      });
    }

    const newest = weeks.at(-1);
    if (newest) {
      const reported = normalizeDesignation(newest.reportStatus);
      observations.push({
        source: INJURY_SOURCE,
        designation: reported.designation,
        raw: reported.raw,
        observedAt: newest.publishedAt ?? newest.fetchedAt,
        // Consecutive weeks only — `weeksFor` returns them in order, and a gap
        // would be a shape nobody observed.
        practice: consecutiveTail(weeks).map((w) => w.practiceStatus),
        bodyPart: newest.primaryInjury,
      });
    }

    if (observations.length === 0) return NO_INJURY_INFORMATION;
    return resolveInjury(observations, this.now());
  }

  async health(season = injurySeason(this.now())): Promise<InjuryHealth> {
    const day = this.now().toISOString().slice(0, 10);
    const previous = previousSeason(this.now());
    const historyRepo = new InjuryHistoryRepo(this.db);
    const [lastRun, coverage, state, writes, events, progress, counts, historyState] = await Promise.all([
      this.repo.latestRun(),
      this.repo.coverage(season),
      this.source.get(INJURY_SOURCE, season).catch(() => null),
      this.source.writesToday(day).catch(() => 0),
      this.source.recentEvents(6).catch(() => []),
      historyRepo.progress(INJURY_SOURCE, previous).catch(() => null),
      historyRepo.countBySignificance(previous).catch(() => ({ strong: 0, moderate: 0 })),
      this.source.get(INJURY_SOURCE, previous).catch(() => null),
    ]);
    return {
      statusSource: STATUS_SOURCE,
      reportSource: INJURY_SOURCE,
      season,
      lastRun,
      players: coverage.players,
      latestWeek: coverage.latestWeek,
      summary: describeHealth(season, lastRun, coverage, state),
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
      dataHealth: describeDataHealth(state, lastRun),
      history: {
        season: previous,
        phase: progress?.phase ?? null,
        // The cursor is the next week to read, so the count done is one behind.
        weeksDone: progress ? Math.max(0, progress.nextWeek - 1) : 0,
        lastWeek: progress?.lastWeek ?? null,
        rowsSeen: progress?.rowsSeen ?? 0,
        playersSummarized: progress?.playersWritten ?? 0,
        significantPlayers: counts.strong + counts.moderate,
        etag: historyState?.etag ?? null,
        lastModified: historyState?.lastModified ?? null,
        ingestedAt: historyState?.ingestedAt ?? null,
        lastOutcome: historyState?.lastOutcome ?? null,
        completedAt: progress?.completedAt ?? null,
        note: progress?.note ?? null,
      },
      writesToday: writes,
      writeCeiling: DAILY_WRITE_CEILING,
      recentEvents: events.map((e) => ({
        playerId: e.playerId,
        week: e.week,
        kind: e.kind,
        from: e.from,
        to: e.to,
        detectedAt: e.detectedAt,
      })),
    };
  }

  /**
   * Resolve only the players this file actually mentions.
   *
   * The first version of this built an in-memory index of the entire player
   * dictionary — four thousand names, each through a chain of regexes — and it
   * cost **17ms of CPU**, more than a Workers invocation is allowed in total.
   * The file names a couple of hundred players, so it asks for those.
   *
   * It also stops keeping a private notion of what a name normalizes to. The
   * app has one canonical normalizer and an indexed column populated from it;
   * a second one living here was a matching stack of its own, which is exactly
   * what the identity layer exists to prevent.
   *
   * GSIS is still preferred where it decides anything. It is no longer the
   * first lookup — the name is, because that is what is indexed — but when a
   * key is ambiguous the identifier breaks the tie, which is strictly better
   * than the previous behaviour of declining every ambiguous name outright.
   */
  private async resolveIdentities(rows: InjuryReportRow[]): Promise<IdentityIndex> {
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
}

/**
 * Every candidate for a lookup key, ambiguity included.
 *
 * Exported because the usage pipeline resolves the same identifiers against the
 * same dictionary and must not grow a second way of doing it: one canonical
 * normalizer, one indexed column, one resolver that declines rather than
 * guesses.
 */
export interface IdentityIndex {
  byName: Map<string, CanonicalPlayer[]>;
}

/**
 * Map one report row onto a canonical player, or decline.
 *
 * Declining is a real outcome and is counted. Two players this app knows
 * sharing one lookup key is not resolved by picking one — an injury attached to
 * the wrong player is worse than an injury attached to nobody — unless the
 * report carries a GSIS id that matches exactly one of them, which is the
 * whole reason the identifier is worth having.
 */
export function resolveToCanonical(
  /*
   * Structural on purpose: the injury report and the weekly stats file carry
   * their identity in fields with different names, and the resolution is the
   * same either way. Two resolvers is how two id spaces start.
   */
  row: { fullName: string; gsisId: string | null },
  index: IdentityIndex,
): { playerId: string; by: 'id' | 'name' } | null {
  const candidates = index.byName.get(normalizeName(row.fullName)) ?? [];
  if (candidates.length === 0) return null;

  if (candidates.length === 1) {
    // A matching identifier on an unambiguous name is still worth reporting as
    // an identifier match: it is the stronger evidence, and the counts in Setup
    // are how the mapping's health is judged.
    const only = candidates[0]!;
    const by = row.gsisId && only.externalIds?.['gsis']?.trim() === row.gsisId ? 'id' : 'name';
    return { playerId: only.id, by };
  }

  if (row.gsisId) {
    const exact = candidates.filter((c) => c.externalIds?.['gsis']?.trim() === row.gsisId);
    if (exact.length === 1) return { playerId: exact[0]!.id, by: 'id' };
  }
  return null;
}

/** The run of weeks ending at the newest one, with no gaps. */
function consecutiveTail(weeks: StoredInjuryReport[]): StoredInjuryReport[] {
  if (weeks.length === 0) return [];
  const out = [weeks.at(-1)!];
  for (let i = weeks.length - 2; i >= 0; i--) {
    if (weeks[i]!.week !== out[0]!.week - 1) break;
    out.unshift(weeks[i]!);
  }
  return out;
}

function describeHealth(
  season: string,
  run: InjurySourceRun | null,
  coverage: { players: number; latestWeek: number | null },
  state?: { checkedAt: string | null; lastOutcome: string | null } | null,
): string {
  /*
   * A season that has not started still has a live pipeline behind it, and
   * saying "never ingested" without saying "checked four minutes ago" reads as
   * a broken feature rather than an empty calendar.
   */
  if (!run) {
    const checking = state?.checkedAt ? ' The five-minute check is running.' : '';
    return `Sleeper designations only — the ${season} injury report has not been ingested yet.${checking}`;
  }
  if (run.outcome === 'not_published') {
    return `Sleeper designations only — nflverse has not published ${season} injury reports yet, which is expected before the season starts.`;
  }
  if (run.outcome === 'failed') {
    return `Sleeper designations only — the last nflverse fetch failed (${run.note ?? 'no reason given'}). Anything already stored is still being used.`;
  }
  const mapped = run.matchedById + run.matchedByName;
  const share = run.rowsReturned > 0 ? Math.round((100 * mapped) / run.rowsReturned) : 0;
  return `Week ${coverage.latestWeek ?? run.latestWeek} of ${season}: ${coverage.players} players carry a report, ${share}% of the source mapped (${run.unmatched} unmatched).`;
}

/**
 * One sentence about whether the injury data can be trusted right now.
 *
 * Written because `checkedAt` is the most dangerous number in this system. It
 * moves every five minutes whether or not anything was ingested, so a panel
 * that reports only "checked 2 minutes ago" says exactly the same thing when
 * the pipeline is healthy and when it has been failing since Thursday. The
 * order below is deliberate: failure first, because a run of failed ingests is
 * the one state that a fresh check actively disguises.
 */
export function describeDataHealth(
  state: { consecutiveFailures?: number; failingSince?: string | null; ingestedAt?: string | null } | null,
  lastRun: { outcome?: string } | null,
): string {
  const failures = state?.consecutiveFailures ?? 0;
  if (failures >= 2) {
    const since = state?.failingSince ? ` since ${state.failingSince.slice(0, 16).replace('T', ' ')}` : '';
    return `Checks are running, but the last ${failures} injury ingests did not complete${since}. The report shown is the last one that landed.`;
  }
  if (failures === 1) {
    return 'The most recent injury ingest did not complete. The report shown is the last one that landed, and the next check will retry.';
  }
  if (lastRun?.outcome === 'not_published') {
    return 'No injury report is published for this season yet, so availability comes from Sleeper alone. Checked every five minutes.';
  }
  if (!state?.ingestedAt) {
    return 'Nothing has been ingested yet. Availability comes from Sleeper alone.';
  }
  return 'Injury data is current: the source is being checked every five minutes and the last ingest completed.';
}
