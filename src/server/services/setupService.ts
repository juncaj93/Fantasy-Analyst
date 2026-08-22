/**
 * Setup status for the whole app, in plain language.
 *
 * Everything here is written for someone who knows fantasy football but not
 * software: no endpoints, no bindings, no JSON. The UI renders these strings
 * more or less verbatim, so keep them short and human.
 */

import type { VegasProvider } from '../../core/vegas/types.ts';
import { SeasonMarketService } from './seasonMarketService.ts';
import {
  adpFormatForLeague,
  buildScoringProfile,
  buildRosterShape,
  leagueFitNotes,
  type AdpFormat,
} from '../../core/sleeper/scoring.ts';
import type { Database } from '../db.ts';
import { AdpRepo } from '../repos/adp.ts';
import { EvidenceRepo } from '../repos/evidence.ts';
import { LeagueRepo } from '../repos/league.ts';
import { NewsletterRepo } from '../repos/newsletter.ts';
import { PlayerRepo } from '../repos/players.ts';
import { PropsRepo } from '../repos/props.ts';
import { SETTING_KEYS, SettingsRepo } from '../repos/settings.ts';
import { VegasUsageRepo } from '../repos/vegasUsage.ts';
import { NewsletterService } from './newsletterService.ts';
import { PlayerDetailService } from './playerDetailService.ts';
import { InjuryService, type InjuryHealth } from './injuryService.ts';
import { UsageService, type UsageHealth } from './usageService.ts';
import type { SleeperUserSetting } from './sleeperSync.ts';

/** `ok` = done, `warn` = needs you, `todo` = not started, `off` = optional/not enabled. */
export type StepState = 'ok' | 'warn' | 'todo' | 'off';

export interface SetupStep {
  id: 'sleeper' | 'league' | 'adp' | 'newsletter' | 'vegas';
  title: string;
  state: StepState;
  /** One line, shown next to the status icon. */
  summary: string;
  /** What to do next, when something is needed. */
  action: string | null;
}

export interface NewsletterStatus {
  /** The address the newsletter should be subscribed to, once known. */
  address: string | null;
  /** False when the deployment has not been told its inbound address yet. */
  addressConfigured: boolean;
  /** True once the expected sender has been set (not the placeholder). */
  senderConfigured: boolean;
  expectedSenders: string[];
  subjectFilters: string[];
  enabled: boolean;
  lastReceivedAt: string | null;
  lastReceivedFrom: string | null;
  lastReceivedSubject: string | null;
  lastReceivedStatus: string | null;
  lastProcessedAt: string | null;
  lastProcessedDetail: string | null;
  lastError: string | null;
  totals: {
    emailsReceived: number;
    newslettersProcessed: number;
    quarantined: number;
    evidenceItems: number;
    autoAppliedPositive: number;
    autoAppliedNegative: number;
    needsReview: number;
  };
}

export interface SetupStatus {
  steps: SetupStep[];
  readyForDraft: boolean;
  sleeper: {
    connected: boolean;
    username: string | null;
    displayName: string | null;
    playersSynced: number;
  };
  league: {
    selected: boolean;
    id: string | null;
    name: string | null;
    season: string | null;
    teams: number;
    scoringLabel: string | null;
    notes: string[];
    draftId: string | null;
    rosterFound: boolean;
    /** Which published ADP describes this league. Null until one is chosen. */
    adpFormat: AdpFormat | null;
  };
  adp: {
    /** How many players Sleeper ranks — the default draft order. */
    rankedPlayers: number;
    /** 'Sleeper' unless an imported file is overriding it. */
    source: string;
    imported: boolean;
    label: string | null;
    capturedAt: string | null;
    totalRows: number;
    matched: number;
    unresolved: number;
  };
  newsletter: NewsletterStatus;
  vegas: {
    provider: string;
    live: boolean;
    lastRefreshedAt: string | null;
    events: number;
    note: string;
    /**
     * The month's spending, so a quota problem is visible before it is an
     * outage. Read from the ledger — this makes no provider call of its own.
     */
    budget: {
      state: string;
      used: number;
      limit: number;
      remaining: number;
      month: string;
      source: string;
      note: string;
      bySource: Record<string, number>;
    };
    /** Season-long market coverage, for the draft. */
    season: {
      season: string;
      players: number;
      quotes: number;
      unresolved: number;
      fetchedAt: string | null;
      stale: boolean;
      reason: string;
    };
  };
  /**
   * The two Sleeper feeds behind the expanded player card, and the one thing
   * Sleeper does not publish.
   *
   * Stated here because a half-loaded pipeline is invisible from the card: a
   * player with no statistics row looks exactly like a player who did not play,
   * and the only place the difference shows is a count of what landed.
   */
  playerDetail: PlayerDetailDiagnostics;
  /**
   * Where a player's availability comes from, and how much of it landed.
   *
   * Two sources with different jobs: Sleeper is the designation and is always
   * present, the published injury report adds the body part and the practice
   * week. The counts matter because a report that mapped a third of its rows
   * looks exactly like one that worked, until a card is blank on a Sunday.
   */
  injury: InjuryHealth;
  /**
   * Per-game opportunity, and how much of it has accumulated.
   *
   * Separate from the injury panel because it answers a different question and
   * fails differently. The count that matters is not how many players have a
   * row — it is how many have the six games the role detector needs before it
   * will say anything, because below that every card correctly says "not
   * enough data" and a panel boasting about row counts would be no help at all
   * in working out why.
   */
  usage: UsageHealth;
}

export type PlayerDetailDiagnostics = Awaited<ReturnType<PlayerDetailService['diagnostics']>>;

export class SetupService {
  private readonly players: PlayerRepo;
  private readonly leagues: LeagueRepo;
  private readonly adp: AdpRepo;
  private readonly evidence: EvidenceRepo;
  private readonly messages: NewsletterRepo;
  private readonly props: PropsRepo;
  private readonly settings: SettingsRepo;
  private readonly newsletter: NewsletterService;
  private readonly seasonMarkets: SeasonMarketService;

  constructor(
    private readonly db: Database,
    private readonly vegas: VegasProvider,
    /** Inbound address from the deployment config, if any. */
    private readonly configuredInboundAddress: string | null,
  ) {
    this.seasonMarkets = new SeasonMarketService(db, vegas);
    this.players = new PlayerRepo(db);
    this.leagues = new LeagueRepo(db);
    this.adp = new AdpRepo(db);
    this.evidence = new EvidenceRepo(db);
    this.messages = new NewsletterRepo(db);
    this.props = new PropsRepo(db);
    this.settings = new SettingsRepo(db);
    this.newsletter = new NewsletterService(db);
  }

  /** The address to show the user: an in-app override wins over the deploy config. */
  async inboundAddress(): Promise<string | null> {
    const override = await this.settings.get<string | null>(SETTING_KEYS.inboundAddress, null);
    return (override && override.trim()) || this.configuredInboundAddress || null;
  }

  async status(): Promise<SetupStatus> {
    const seasonStatus = await this.seasonMarkets.status();
    const usage = new VegasUsageRepo(this.db);
    const [budget, budgetBySource] = await Promise.all([usage.view(), usage.bySource()]);
    const [playerCount, rankedPlayers, league, snapshot, newsletter, vegasFreshness] = await Promise.all([
      this.players.count(),
      this.players.countRanked(),
      this.leagues.getSelectedLeague(),
      // The platform snapshot: Setup reports the draft order the board actually
      // uses, and that is never the Underdog one.
      this.adp.latestPlatformSnapshot(),
      this.newsletterStatus(),
      this.props.freshness(),
    ]);

    const user = await this.settings.get<SleeperUserSetting | null>(SETTING_KEYS.sleeperUser, null);
    const rosters = league ? await this.leagues.listRosters(league.id) : [];
    const rosterFound = rosters.some((r) => r.isMine);

    const profile = league ? buildScoringProfile(league.scoringSettings, league.rosterPositions) : null;
    const shape = league ? buildRosterShape(league.rosterPositions) : null;

    const unresolved = snapshot ? snapshot.rowCount - snapshot.matchedCount : 0;

    const vegasState = describeVegas({
      provider: this.vegas.name,
      configured: this.vegas.isConfigured(),
      events: vegasFreshness.events,
      fetchedAt: vegasFreshness.fetchedAt,
      budgetState: budget.state,
    });

    const steps: SetupStep[] = [
      {
        id: 'sleeper',
        title: 'Sleeper',
        state: user && playerCount > 0 ? 'ok' : user ? 'warn' : 'todo',
        summary: !user
          ? 'Not connected yet'
          : playerCount === 0
            ? `Connected as ${user.displayName ?? user.username}, but the player list has not been downloaded`
            : `Connected as ${user.displayName ?? user.username}`,
        action: !user
          ? 'Enter your Sleeper username to connect.'
          : playerCount === 0
            ? 'Tap "Update player list" to finish.'
            : null,
      },
      {
        id: 'league',
        title: 'League',
        state: league ? (rosterFound ? 'ok' : 'warn') : 'todo',
        summary: !league
          ? 'No league chosen yet'
          : rosterFound
            ? `${league.name} (${profile?.label ?? 'custom scoring'})`
            : `${league.name} — your team could not be found in it`,
        action: !league
          ? 'Choose which league to use.'
          : rosterFound
            ? null
            : 'Check that the Sleeper username you connected owns a team in this league.',
      },
      {
        id: 'adp',
        title: 'Draft order',
        // Sleeper publishes no ADP, so a ranking has to be imported.
        state: snapshot ? 'ok' : 'warn',
        summary: snapshot
          ? `${snapshot.label} — ${snapshot.matchedCount} of ${snapshot.rowCount} players matched`
          : 'No rankings imported yet',
        action: snapshot
          ? null
          : 'Sleeper ADP for this league refreshes each morning. Import a ranking file if you need one sooner.',
      },
      {
        id: 'newsletter',
        title: 'Newsletter',
        state: newsletterState(newsletter),
        summary: newsletterSummary(newsletter),
        action: newsletterAction(newsletter),
      },
      {
        id: 'vegas',
        title: 'Vegas lines',
        state: vegasState.state,
        summary: vegasState.summary,
        action: vegasState.action,
      },
    ];

    return {
      steps,
      readyForDraft: !!league && rosterFound && !!snapshot && playerCount > 0,
      sleeper: {
        connected: !!user,
        username: user?.username ?? null,
        displayName: user?.displayName ?? null,
        playersSynced: playerCount,
      },
      league: {
        selected: !!league,
        id: league?.id ?? null,
        name: league?.name ?? null,
        season: league?.season ?? null,
        teams: league?.totalRosters ?? 0,
        scoringLabel: profile?.label ?? null,
        notes: profile && shape ? leagueFitNotes(profile, shape) : [],
        draftId: league?.draftId ?? null,
        rosterFound,
        adpFormat: profile && shape ? adpFormatForLeague(profile, shape, league?.leagueSettings ?? {}) : null,
      },
      adp: {
        rankedPlayers,
        source: snapshot ? 'imported file' : 'none',
        imported: !!snapshot,
        label: snapshot?.label ?? null,
        capturedAt: snapshot?.capturedAt ?? null,
        totalRows: snapshot?.rowCount ?? 0,
        matched: snapshot?.matchedCount ?? 0,
        unresolved,
      },
      newsletter,
      vegas: {
        provider: this.vegas.name,
        live: this.vegas.name !== 'mock' && this.vegas.isConfigured(),
        lastRefreshedAt: vegasFreshness.fetchedAt,
        events: vegasFreshness.events,
        note: vegasState.note,
        budget: {
          state: budget.state,
          used: budget.used,
          limit: budget.limit,
          remaining: budget.remaining,
          month: budget.month,
          source: budget.source,
          note: budget.note,
          bySource: budgetBySource,
        },
        season: {
          season: seasonStatus.season,
          players: seasonStatus.players,
          quotes: seasonStatus.quotes,
          unresolved: seasonStatus.unresolved,
          fetchedAt: seasonStatus.fetchedAt,
          stale: seasonStatus.stale,
          reason: seasonStatus.reason,
        },
      },
      playerDetail: await new PlayerDetailService(this.db).diagnostics(),
      injury: await new InjuryService(this.db).health(),
      usage: await new UsageService(this.db).health(),
    };
  }

  async newsletterStatus(): Promise<NewsletterStatus> {
    const [address, sources, senderConfigured, lastReceived, lastProcessed, lastFailure, counts, evidenceSummary] =
      await Promise.all([
        this.inboundAddress(),
        this.newsletter.getSources(),
        this.newsletter.isSenderConfigured(),
        this.messages.lastReceived(),
        this.messages.lastProcessed(),
        this.messages.lastFailure(),
        this.messageCounts(),
        this.evidence.summary(),
      ]);

    const active = sources.filter((s) => s.enabled !== false);
    return {
      address,
      addressConfigured: !!address,
      senderConfigured,
      expectedSenders: active.flatMap((s) => s.fromPatterns),
      subjectFilters: active.flatMap((s) => s.subjectPatterns ?? []),
      enabled: active.length > 0,
      lastReceivedAt: lastReceived?.receivedAt ?? null,
      lastReceivedFrom: lastReceived?.fromAddress ?? null,
      lastReceivedSubject: lastReceived?.subject ?? null,
      lastReceivedStatus: lastReceived?.status ?? null,
      lastProcessedAt: lastProcessed?.receivedAt ?? null,
      lastProcessedDetail: lastProcessed?.detail ?? null,
      lastError: lastFailure?.rejectReason ?? null,
      totals: {
        emailsReceived: counts.total,
        newslettersProcessed: counts.processed,
        quarantined: counts.quarantined,
        evidenceItems: evidenceSummary.total,
        autoAppliedPositive: evidenceSummary.autoAppliedPositive,
        autoAppliedNegative: evidenceSummary.autoAppliedNegative,
        needsReview: evidenceSummary.pending,
      },
    };
  }

  private async messageCounts(): Promise<{ total: number; processed: number; quarantined: number }> {
    const rows = await this.db
      .prepare('SELECT status, COUNT(*) AS n FROM newsletter_messages GROUP BY status')
      .all<{ status: string; n: number }>();
    let total = 0;
    let processed = 0;
    let quarantined = 0;
    for (const row of rows.results) {
      const n = Number(row.n ?? 0);
      total += n;
      if (row.status === 'processed') processed += n;
      if (row.status === 'quarantined') quarantined += n;
    }
    return { total, processed, quarantined };
  }
}

/** How stale a stored snapshot has to be before Setup stops calling it current. */
const VEGAS_STALE_HOURS = 36;

/**
 * What Setup says about the odds provider, in the six states it can be in.
 *
 * Previously two: mock, and "Live betting lines are connected" for everything
 * else. The second was asserted from the provider's *name* alone, so a
 * deployment configured for a real provider but missing its key — the exact
 * state a bad rollout produces — reported that live lines were connected while
 * `live` was false and nothing had ever been fetched. A status screen exists to
 * be believed, and that is the one failure it has to be able to name.
 *
 * Pure, and separate from `status()`, so each state can be asserted directly
 * rather than by assembling a whole SetupStatus around it.
 */
export function describeVegas(input: {
  provider: string;
  configured: boolean;
  events: number;
  fetchedAt: string | null;
  budgetState: string;
}): { state: StepState; summary: string; action: string | null; note: string } {
  if (input.provider === 'mock') {
    return {
      state: 'off',
      summary: 'Using practice data — real betting lines are not connected yet',
      action: null,
      note: 'Practice data only. Start/sit advice will say when a real line is missing rather than guessing.',
    };
  }

  if (!input.configured) {
    return {
      state: 'warn',
      summary: `${input.provider} is selected, but its API key is missing — no lines are being fetched`,
      action: `Add the ${input.provider} key to the deployment, then redeploy.`,
      note: 'No betting lines are being fetched. Nothing is shown as a line until a real one arrives.',
    };
  }

  if (input.budgetState === 'exhausted') {
    return {
      state: 'warn',
      summary: `${input.provider} connected — this month's request allowance is used up`,
      action: 'Nothing to do; the allowance resets at the start of next month.',
      note: 'The stored lines keep being shown and are marked stale. No new ones are fetched until the allowance resets.',
    };
  }

  const ageHours = input.fetchedAt ? (Date.now() - Date.parse(input.fetchedAt)) / 3_600_000 : null;

  // Connected and asking, but the answer so far is nothing. Said plainly: it is
  // a normal state out of season and a real fault in it, and either way it is
  // not the same thing as being connected and fed.
  if (input.events === 0 || ageHours == null || !Number.isFinite(ageHours)) {
    return {
      state: 'warn',
      summary: `${input.provider} connected — no lines stored yet`,
      action: 'Lines arrive on the scheduled refresh, or from "Refresh Vegas lines".',
      note: 'Connected, but nothing has been stored yet. Anything without a line is shown as unknown rather than as a zero.',
    };
  }

  if (ageHours > VEGAS_STALE_HOURS) {
    return {
      state: 'warn',
      summary: `${input.provider} connected — ${input.events} game(s) stored, last updated ${describeAge(ageHours)}`,
      action: 'The next scheduled refresh will update them.',
      note: 'These lines are old enough to be treated as stale, and start/sit lowers its confidence accordingly.',
    };
  }

  return {
    state: 'ok',
    summary: `${input.provider} connected — ${input.events} game(s) stored, updated ${describeAge(ageHours)}`,
    action: null,
    note: 'Live betting lines are connected. A player with no market is shown as unknown, never as a zero.',
  };
}

function describeAge(hours: number): string {
  if (hours < 1) return 'in the last hour';
  if (hours < 24) return `${Math.round(hours)} hour(s) ago`;
  return `${Math.round(hours / 24)} day(s) ago`;
}

function newsletterState(status: NewsletterStatus): StepState {
  if (!status.addressConfigured) return 'todo';
  if (!status.senderConfigured) return 'warn';
  if (status.totals.newslettersProcessed > 0) return 'ok';
  return 'warn';
}

function newsletterSummary(status: NewsletterStatus): string {
  if (!status.addressConfigured) return 'Email address not set up yet';
  if (!status.senderConfigured) return `Address ready (${status.address}) — sender not set yet`;
  if (status.totals.newslettersProcessed > 0) {
    return `${status.totals.newslettersProcessed} newsletter${status.totals.newslettersProcessed === 1 ? '' : 's'} processed`;
  }
  if (status.totals.emailsReceived > 0) {
    return `${status.totals.emailsReceived} email(s) arrived, none matched your newsletter sender yet`;
  }
  return 'Waiting for the first newsletter';
}

function newsletterAction(status: NewsletterStatus): string | null {
  if (!status.addressConfigured) return 'Finish the one-time email setup, then this address appears here.';
  if (!status.senderConfigured) return 'Tell Fantasy Analyst which sender your newsletter comes from.';
  if (status.totals.newslettersProcessed === 0) {
    return `Subscribe your FF Newsletter to ${status.address}. The next issue will process automatically.`;
  }
  return null;
}
