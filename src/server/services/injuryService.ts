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
import { InjuryRepo, type InjurySourceRun, type StoredInjuryReport } from '../repos/injury.ts';
import { PlayerRepo } from '../repos/players.ts';
import {
  NO_INJURY_INFORMATION,
  normalizeDesignation,
  resolveInjury,
  type InjuryObservation,
  type InjuryState,
} from '../../core/injury/model.ts';
import {
  fetchInjuryReport,
  latestByPlayer,
  normalizeForMatch,
  type FetchLike,
  type InjuryReportRow,
} from '../../core/injury/nflverse.ts';

export const INJURY_SOURCE = 'nflverse';
export const STATUS_SOURCE = 'sleeper';

/** The season injury reports are published for: the one being played. */
export function injurySeason(now = new Date()): string {
  const year = now.getUTCFullYear();
  // Reports run from the preseason into January, so a January date still
  // belongs to the previous calendar year's season.
  return String(now.getUTCMonth() >= 2 ? year : year - 1);
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
}

export class InjuryService {
  private readonly repo: InjuryRepo;
  private readonly players: PlayerRepo;

  constructor(
    db: Database,
    private readonly deps: { fetch?: FetchLike; now?: () => Date } = {},
  ) {
    this.repo = new InjuryRepo(db);
    this.players = new PlayerRepo(db);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /**
   * Pull the season's injury report and store what maps.
   *
   * Ingested in bulk, once, rather than per card: the file is one request for
   * the whole league and mapping it locally is what keeps a Sunday-morning
   * refresh from becoming a thousand of them.
   */
  async refresh(season = injurySeason(this.now())): Promise<InjurySourceRun> {
    const fetchedAt = this.now().toISOString();
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

    let fetched;
    try {
      fetched = await fetchInjuryReport(season, { fetch: this.deps.fetch });
    } catch (err) {
      const run = { ...base, note: err instanceof Error ? err.message : String(err) };
      await this.repo.recordRun(run);
      return run;
    }

    if (!fetched.report) {
      /*
       * No file is usually not a fault.
       *
       * In August `injuries_2026.csv` is a 404 because the NFL has not filed an
       * injury report yet. Recording that as a failure would put a red light on
       * a panel for a condition that resolves itself in September, and an alarm
       * that cries wolf every preseason is an alarm nobody reads in November.
       */
      const notPublished = (fetched.note ?? '').includes('not published');
      const run: InjurySourceRun = {
        ...base,
        outcome: notPublished ? 'not_published' : 'failed',
        note: fetched.note,
      };
      await this.repo.recordRun(run);
      return run;
    }

    const report = fetched.report;
    const index = await this.buildIdentityIndex();
    const latest = latestByPlayer(report);

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

    await this.repo.saveReports(rows);
    const run: InjurySourceRun = {
      ...base,
      latestWeek: report.latestWeek,
      publishedAt: fetched.publishedAt,
      rowsReturned: latest.size,
      matchedById,
      matchedByName,
      unmatched,
      outcome: 'ok',
      note: null,
    };
    await this.repo.recordRun(run);
    return run;
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
    const [lastRun, coverage] = await Promise.all([this.repo.latestRun(), this.repo.coverage(season)]);
    return {
      statusSource: STATUS_SOURCE,
      reportSource: INJURY_SOURCE,
      season,
      lastRun,
      players: coverage.players,
      latestWeek: coverage.latestWeek,
      summary: describeHealth(season, lastRun, coverage),
    };
  }

  /**
   * GSIS first, normalized name second.
   *
   * Measured against the real file: of the players at positions this app
   * carries, 27.5% match on a trimmed identifier and 71.4% on a name, for 98.9%
   * overall with five unmatched. The identifier is preferred wherever it exists
   * because a name is a guess that happens to be usually right — and Sleeper
   * publishes one for only about a third of its dictionary, which is why the
   * name path carries most of the load.
   *
   * The five that miss are all names that are ambiguous in Sleeper's own data,
   * and `resolveToCanonical` declines them on purpose.
   */
  private async buildIdentityIndex(): Promise<IdentityIndex> {
    const all = await this.players.listAll();
    const byGsis = new Map<string, string>();
    const byName = new Map<string, string[]>();
    for (const player of all) {
      const gsis = player.externalIds?.['gsis']?.trim();
      if (gsis) byGsis.set(gsis, player.id);
      const key = normalizeForMatch(player.fullName);
      const list = byName.get(key);
      if (list) list.push(player.id);
      else byName.set(key, [player.id]);
    }
    return { byGsis, byName };
  }
}

interface IdentityIndex {
  byGsis: Map<string, string>;
  byName: Map<string, string[]>;
}

/**
 * Map one report row onto a canonical player, or decline.
 *
 * Declining is a real outcome and is counted. An ambiguous name — two players
 * this app knows sharing one normalized name — is not resolved by picking one:
 * an injury attached to the wrong player is worse than an injury attached to
 * nobody, and the count is what makes the gap visible in Setup.
 */
export function resolveToCanonical(
  row: InjuryReportRow,
  index: IdentityIndex,
): { playerId: string; by: 'id' | 'name' } | null {
  if (row.gsisId) {
    const byId = index.byGsis.get(row.gsisId);
    if (byId) return { playerId: byId, by: 'id' };
  }
  const candidates = index.byName.get(normalizeForMatch(row.fullName)) ?? [];
  if (candidates.length === 1) return { playerId: candidates[0]!, by: 'name' };
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
): string {
  if (!run) return `Sleeper designations only — the ${season} injury report has not been ingested yet.`;
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
