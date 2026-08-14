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
import { NewsletterService } from './newsletterService.ts';
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
}

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
    const [playerCount, rankedPlayers, league, snapshot, newsletter, vegasFreshness] = await Promise.all([
      this.players.count(),
      this.players.countRanked(),
      this.leagues.getSelectedLeague(),
      this.adp.latest(),
      this.newsletterStatus(),
      this.props.freshness(),
    ]);

    const user = await this.settings.get<SleeperUserSetting | null>(SETTING_KEYS.sleeperUser, null);
    const rosters = league ? await this.leagues.listRosters(league.id) : [];
    const rosterFound = rosters.some((r) => r.isMine);

    const profile = league ? buildScoringProfile(league.scoringSettings, league.rosterPositions) : null;
    const shape = league ? buildRosterShape(league.rosterPositions) : null;

    const unresolved = snapshot ? snapshot.rowCount - snapshot.matchedCount : 0;

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
        state: 'off',
        summary:
          this.vegas.name === 'mock'
            ? 'Using practice data — real betting lines are not connected yet'
            : `Live provider: ${this.vegas.name}`,
        action: null,
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
        note:
          this.vegas.name === 'mock'
            ? 'Practice data only. Start/sit advice will say when a real line is missing rather than guessing.'
            : 'Live betting lines are connected.',
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
