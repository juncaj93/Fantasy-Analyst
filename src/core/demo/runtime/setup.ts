/**
 * The three payloads that describe the app to itself.
 *
 * Setup, the annual readiness check, and the expanded player card. None of them
 * is a recommendation — they are *reports*, and what they report is source
 * health: which provider has published for this season, how much of the board
 * it covered, when it last moved.
 *
 * That makes them the one place a fixture legitimately states the answer rather
 * than the input, because the answer *is* the input: "the injury report has not
 * published for 2027" is a fact about a provider, not a conclusion drawn from
 * one. Every such fact here is derived from the scenario's declared source
 * freshness, so a degraded scenario cannot say it is degraded on one screen and
 * healthy on another.
 */

import { injuryLine } from '../../injury/model.ts';
import type { ScenarioData } from '../fixtures/index.ts';
import { hoursBefore } from '../clock.ts';
import type { DemoSourceState } from '../types.ts';

const stateWord = (state: DemoSourceState): 'ok' | 'warn' | 'todo' | 'off' => {
  switch (state) {
    case 'fresh':
      return 'ok';
    case 'aging':
    case 'stale':
      return 'warn';
    case 'unavailable':
      return 'todo';
    default:
      return 'off';
  }
};

/** When a source last moved, given how fresh the scenario says it is. */
function lastMoved(data: ScenarioData, state: DemoSourceState, freshHours: number, staleHours: number): string | null {
  if (state === 'unavailable' || state === 'not_applicable') return null;
  return hoursBefore(data.clock, state === 'stale' ? staleHours : freshHours);
}

export function buildDemoSetupStatus(data: ScenarioData) {
  const { freshness, scenario } = data;
  const ranked = data.adpValues.size;
  const injuryAt = lastMoved(data, freshness.injuries, 6, 96);
  const usageAt = lastMoved(data, freshness.usage, 14, 120);
  const vegasAt = data.vegas.fetchedAt;

  return {
    steps: [
      {
        id: 'sleeper' as const,
        title: 'Sleeper',
        state: stateWord(freshness.sleeper),
        summary:
          freshness.sleeper === 'unavailable'
            ? 'Sleeper is unreachable. The last state received is what every screen is showing.'
            : `Connected · ${data.players.length} players · ${data.league.totalRosters}-team league`,
        action: null,
      },
      {
        id: 'league' as const,
        title: 'League',
        state: 'ok' as const,
        summary: `${data.league.name} · ${data.league.season}`,
        action: null,
      },
      {
        id: 'adp' as const,
        title: 'Draft order',
        state: stateWord(freshness.adp),
        summary: data.adpSnapshot
          ? `${data.adpSnapshot.label} · ${ranked} players matched`
          : 'No ranking has been imported for this season yet.',
        action: null,
      },
      {
        id: 'newsletter' as const,
        title: 'Newsletter',
        state: stateWord(freshness.newsletter),
        summary: `${data.signals.size} players carry a tally`,
        action: null,
      },
      {
        id: 'vegas' as const,
        title: 'Market',
        state: stateWord(freshness.vegas),
        summary:
          freshness.vegas === 'unavailable'
            ? 'The odds provider is unreachable, so weekly expectation is unknown.'
            : `${data.vegas.events} games priced`,
        action: null,
      },
    ],
    readyForDraft: freshness.adp !== 'unavailable' && freshness.sleeper !== 'unavailable',
    sleeper: {
      connected: true,
      username: 'demo',
      displayName: 'Demo',
      playersSynced: data.players.length,
    },
    league: {
      selected: true,
      id: data.league.id,
      name: data.league.name,
      season: data.league.season,
      teams: data.league.totalRosters,
      scoringLabel: scenario.format.scoringLabel,
      notes: [],
      draftId: data.draft?.id ?? null,
      rosterFound: (data.rosters.find((r) => r.isMine)?.playerIds.length ?? 0) > 0,
    },
    adp: {
      rankedPlayers: ranked,
      source: 'demo fixtures',
      imported: data.adpSnapshot != null,
      label: data.adpSnapshot?.label ?? null,
      capturedAt: data.adpSnapshot?.capturedAt ?? null,
      totalRows: ranked,
      matched: ranked,
      unresolved: 0,
    },
    newsletter: {
      address: 'fantasy-news@demo.invalid',
      addressConfigured: true,
      senderConfigured: true,
      expectedSenders: ['@demo.invalid'],
      subjectFilters: [],
      enabled: freshness.newsletter !== 'unavailable',
      lastReceivedAt: lastMoved(data, freshness.newsletter, 20, 200),
      lastReceivedFrom: 'ff-newsletter@demo.invalid',
      lastReceivedSubject: 'Week ahead',
      lastReceivedStatus: 'processed',
      lastProcessedAt: lastMoved(data, freshness.newsletter, 20, 200),
      lastProcessedDetail: `${data.signals.size} players updated`,
      lastError: null,
      // A scenario's newsletters have all been scored already: Demo Mode is a
      // settled world, not a half-finished inbox.
      pendingTally: null,
      totals: {
        emailsReceived: 24,
        newslettersProcessed: 24,
        quarantined: 1,
        evidenceItems: [...data.signals.values()].reduce((sum, s) => sum + s.raw.items, 0),
        autoAppliedPositive: 0,
        autoAppliedNegative: 0,
        needsReview: 0,
      },
    },
    vegas: {
      provider: 'demo fixtures',
      live: freshness.vegas === 'fresh',
      lastRefreshedAt: vegasAt,
      events: data.vegas.events,
      note:
        freshness.vegas === 'unavailable'
          ? 'Unreachable in this scenario.'
          : freshness.vegas === 'stale'
            ? 'The last snapshot is being served, and is marked stale.'
            : 'Fresh.',
      budget: {
        state: 'ok',
        used: 180,
        limit: 2500,
        remaining: 2320,
        month: data.clock.iso().slice(0, 7),
        source: 'demo fixtures',
        note: 'Nothing in Demo Mode spends a provider request.',
        bySource: {},
      },
      season: {
        season: data.league.season,
        players: data.seasonMarkets.size,
        quotes: [...data.seasonMarkets.values()].reduce((sum, list) => sum + list.length, 0),
        unresolved: 0,
        fetchedAt: vegasAt,
        stale: freshness.vegas === 'stale',
        reason: freshness.vegas === 'unavailable' ? 'no season market snapshot for this season yet' : 'stored',
      },
    },
    playerDetail: {
      stats: {
        season: String(Number(data.league.season) - 1),
        source: 'demo fixtures',
        players: data.players.length,
        lastRunAt: hoursBefore(data.clock, 20),
        returned: data.players.length,
        unmatched: 0,
        rankDisagreements: 0,
        scoring: scenario.format.scoringLabel,
      },
      outlook: {
        season: data.league.season,
        source: 'demo fixtures',
        stored: 12,
        noneAvailable: data.players.length - 12,
        newestAt: hoursBefore(data.clock, 48),
      },
      rosterPercent: { available: false as const, note: 'Sleeper publishes none.' },
    },
    injury: injurySection(data, injuryAt),
    usage: usageSection(data, usageAt),
  };
}

function injurySection(data: ScenarioData, injuryAt: string | null) {
  const unavailable = data.freshness.injuries === 'unavailable';
  const stale = data.freshness.injuries === 'stale';
  return {
    statusSource: 'sleeper',
    reportSource: 'nflverse injury report',
    season: data.league.season,
    players: data.injuries.size,
    latestWeek: data.scenario.week,
    summary: unavailable
      ? `No injury report has published for ${data.league.season} yet.`
      : `${data.injuries.size} players carry a designation.`,
    lastRun: injuryAt
      ? {
          source: 'nflverse injury report',
          season: data.league.season,
          latestWeek: data.scenario.week,
          fetchedAt: injuryAt,
          publishedAt: injuryAt,
          rowsReturned: data.injuries.size,
          matchedById: data.injuries.size,
          matchedByName: 0,
          unmatched: 0,
          outcome: 'ok' as const,
          note: null,
        }
      : null,
    checkedAt: hoursBefore(data.clock, 0.2),
    sourceModifiedAt: injuryAt,
    ingestedAt: injuryAt,
    lastOutcome: unavailable ? 'not_published' : 'ok',
    lastNote: unavailable ? 'the file for this season does not exist yet' : null,
    etag: unavailable ? null : 'demo-etag',
    lastModified: injuryAt,
    consecutiveFailures: 0,
    failingSince: null,
    caughtUpThrough: data.scenario.week,
    dataHealth: unavailable
      ? 'Nothing has published for this season, so availability falls back to Sleeper alone.'
      : stale
        ? 'The report has not moved in four days. Designations still stand; the practice detail behind them does not.'
        : 'Current.',
    history: {
      season: String(Number(data.league.season) - 1),
      phase: 'complete',
      weeksDone: 18,
      lastWeek: 18,
      rowsSeen: 0,
      playersSummarized: 0,
      significantPlayers: 0,
      etag: null,
      lastModified: null,
      ingestedAt: null,
      lastOutcome: 'ok',
      completedAt: null,
      note: null,
    },
    writesToday: 0,
    writeCeiling: 0,
    recentEvents: [],
  };
}

function usageSection(data: ScenarioData, usageAt: string | null) {
  const unavailable = data.freshness.usage === 'unavailable';
  const measured = data.specs.filter((s) => (s.week?.usage?.weeks.length ?? 0) >= 6).length;
  return {
    source: 'nflverse weekly usage',
    season: data.league.season,
    players: data.specs.filter((s) => s.week?.usage).length,
    playersWithEnoughGames: measured,
    minimumGames: 6,
    weeks: data.scenario.week ?? 0,
    latestWeek: data.scenario.week,
    rows: 0,
    summary: unavailable
      ? 'No weekly usage has published for this season yet, so every role reads "insufficient data".'
      : `${measured} players have enough games for a role trend.`,
    lastRun: null,
    checkedAt: hoursBefore(data.clock, 1),
    sourceModifiedAt: usageAt,
    ingestedAt: usageAt,
    lastOutcome: unavailable ? 'not_published' : 'ok',
    lastNote: null,
    etag: null,
    lastModified: usageAt,
    consecutiveFailures: 0,
    failingSince: null,
    caughtUpThrough: data.scenario.week,
    dataHealth: unavailable
      ? 'Nothing published for this season yet.'
      : data.freshness.usage === 'stale'
        ? 'The file has not published since Wednesday, so the newest game is missing from every trend.'
        : 'Current.',
    writesToday: 0,
    writeCeiling: 0,
  };
}

/**
 * The annual readiness check, built from the scenario's own source freshness.
 *
 * The rollover scenarios are the reason it exists here: "is this app ready for
 * 2027" is exactly the question a March demo has to be able to answer honestly,
 * and the honest answer in March is a list of providers that have not published
 * yet.
 */
export function buildDemoRollover(data: ScenarioData) {
  /* The season being *asked* for. In March that is next season, not the stored league's. */
  const season = data.scenario.season;
  const checks = (
    [
      ['Sleeper league', data.freshness.sleeper, `a ${season} league`],
      ['Draft order', data.freshness.adp, `a ${season} ADP snapshot`],
      ['Injury report', data.freshness.injuries, `${season} injury rows`],
      ['Weekly usage', data.freshness.usage, `${season} usage rows`],
      ['Season market', data.freshness.vegas, `${season} season-long lines`],
      ['Newsletter', data.freshness.newsletter, 'evidence for this season'],
    ] as const
  ).map(([name, state, wanted]) => ({
    name,
    status:
      state === 'fresh'
        ? ('ready' as const)
        : state === 'stale'
          ? ('stale' as const)
          : state === 'unavailable'
            ? ('waiting' as const)
            : ('skipped' as const),
    wanted,
    found: state === 'unavailable' ? null : season,
    detail:
      state === 'unavailable'
        ? 'The provider has not published for this season yet. Nothing older is accepted in its place.'
        : state === 'stale'
          ? 'Present, and older than it should be.'
          : 'Present and current.',
    blocking: state === 'unavailable' && (name === 'Sleeper league' || name === 'Draft order'),
  }));

  const waiting = checks.filter((c) => c.status === 'waiting');
  return {
    season,
    ready: waiting.length === 0,
    waitingOn: waiting[0]?.name ?? null,
    checks,
    policy: [
      {
        category: 'Draft order',
        disposition: 'refuse last season',
        reason: 'A board full of last season’s ADP renders perfectly and is wrong everywhere.',
      },
      {
        category: 'Evidence ledger',
        disposition: 'keep',
        reason: 'Lifetime tallies are the point of the ledger; the season windows reset on their own.',
      },
    ],
    summary:
      waiting.length === 0
        ? 'Every source has published for this season.'
        : `Waiting on ${waiting.length} source(s): ${waiting.map((c) => c.name).join(', ')}.`,
    league: {
      selected: { id: data.league.id, name: data.league.name, season: data.league.season },
      succession: null,
    },
  };
}

/**
 * The expanded card's extra sections.
 *
 * Everything here is either a fact the fixture stated or a line the production
 * formatter produced from one — `injuryLine` is the same function the live card
 * calls, so a demo cannot phrase an availability differently from the app.
 *
 * `scoreDelta` is 0 on both the takeaway and the profile, exactly as it is in
 * production, because both explain numbers the tally has already counted.
 */
export function buildDemoPlayerDetail(data: ScenarioData, playerId: string) {
  const player = data.players.find((p) => p.id === playerId);
  if (!player) return null;
  const spec = data.specs.find((s) => s.id === playerId);
  const injury = data.injuries.get(playerId) ?? null;
  const signal = data.signals.get(playerId) ?? null;

  return {
    playerId,
    lastSeason: null,
    outlook: null,
    outlookNote: 'No outlook is published for this player in Demo Mode.',
    injuryContext: null,
    availability: null,
    injury: injury
      ? {
          designation: injury.designation,
          label: injury.designation,
          line: injuryLine(injury),
          bodyPart: injury.bodyPart,
          practice: injury.practice.label,
          provenance: injury.designationSource,
          freshness: injury.freshness,
          confidence: injury.confidence,
          conflict: injury.conflictNote,
        }
      : null,
    /*
     * A takeaway only where the ledger has enough to have one.
     *
     * The live feature selects a sentence from evidence it already holds and
     * never composes one. A demo has no publisher text to select from, so it
     * says nothing rather than writing a sentence and attributing it to
     * somebody — which is exactly what the `derivation: 'templated'` path is
     * for and exactly what it must not be used to disguise.
     */
    newsletterTakeaway: null,
    profile: {
      flags:
        spec?.position === 'RB' && (signal?.raw.net ?? 0) < 0
          ? [
              {
                key: 'workload',
                text: 'Heavy usage last season for a back this size.',
                kind: 'physical' as const,
                weight: 'context' as const,
              },
            ]
          : [],
      showMeasurements: false,
      scoreDelta: 0 as const,
      heightInches: null,
      weightPounds: null,
    },
  };
}
