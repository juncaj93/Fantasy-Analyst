/**
 * Deterministic demo data for local development and e2e tests.
 *
 * Everything here is obviously synthetic. It exercises the full path —
 * players -> league -> draft -> ADP -> newsletter -> evidence -> review — so
 * browser tests can drive real flows without touching Sleeper or a sportsbook.
 */

import { importAdpSnapshot } from '../core/adp/import.ts';
import { toCanonicalPlayers } from '../core/sleeper/transform.ts';
import type { SleeperPlayer } from '../core/sleeper/types.ts';
import type { MockRoster } from '../core/vegas/mockProvider.ts';
import { toEmailMessage } from '../core/newsletter/source.ts';
import { buildConsensus } from '../core/vegas/normalize.ts';
import { MockVegasProvider } from '../core/vegas/mockProvider.ts';
import type { Database } from '../server/db.ts';
import { AdpRepo } from '../server/repos/adp.ts';
import { LeagueRepo } from '../server/repos/league.ts';
import { PlayerRepo } from '../server/repos/players.ts';
import { PropsRepo } from '../server/repos/props.ts';
import { SeasonMarketService } from '../server/services/seasonMarketService.ts';
import { SETTING_KEYS, SettingsRepo } from '../server/repos/settings.ts';
import { NewsletterService } from '../server/services/newsletterService.ts';
import { PlayerDetailRepo } from '../server/repos/playerDetail.ts';
import { buildSeasonStatLines } from '../core/sleeper/seasonStats.ts';
import { lastCompletedSeason, outlookSeason } from '../server/services/playerDetailService.ts';

/** Synthetic players — real-looking names, entirely local. */
export const DEMO_PLAYERS: Record<string, SleeperPlayer> = {
  '1001': { player_id: '1001', search_rank: 1, first_name: 'Marcus', last_name: 'Vance', full_name: 'Marcus Vance', team: 'KC', position: 'RB', active: true, injury_status: null },
  '1002': { player_id: '1002', search_rank: 2, first_name: 'Devin', last_name: 'Okafor', full_name: 'Devin Okafor', team: 'CIN', position: 'WR', active: true, injury_status: null },
  '1003': { player_id: '1003', search_rank: 3, first_name: 'Trey', last_name: 'Halloran', full_name: 'Trey Halloran', team: 'SF', position: 'QB', active: true, injury_status: null },
  '1004': { player_id: '1004', search_rank: 4, first_name: 'Andre', last_name: 'Sotelo', full_name: 'Andre Sotelo', team: 'DAL', position: 'TE', active: true, injury_status: 'Questionable' },
  '1005': { player_id: '1005', search_rank: 5, first_name: 'Kai', last_name: 'Brennan', full_name: 'Kai Brennan', team: 'BUF', position: 'WR', active: true, injury_status: null },
  '1006': { player_id: '1006', search_rank: 6, first_name: 'Julian', last_name: 'Reyes', full_name: 'Julian Reyes', team: 'MIA', position: 'RB', active: true, injury_status: null },
  '1007': { player_id: '1007', search_rank: 7, first_name: 'Owen', last_name: 'Fitzgerald', full_name: 'Owen Fitzgerald', team: 'PHI', position: 'WR', active: true, injury_status: null },
  '1008': { player_id: '1008', search_rank: 8, first_name: 'Silas', last_name: 'Mbeki', full_name: 'Silas Mbeki', team: 'GB', position: 'RB', active: true, injury_status: null },
  '1009': { player_id: '1009', search_rank: 9, first_name: 'Nate', last_name: 'Kowalski', full_name: 'Nate Kowalski', team: 'DET', position: 'TE', active: true, injury_status: null },
  '1010': { player_id: '1010', search_rank: 10, first_name: 'Rhys', last_name: 'Donnelly', full_name: 'Rhys Donnelly', team: 'LAR', position: 'QB', active: true, injury_status: null },
  '1011': { player_id: '1011', search_rank: 11, first_name: 'Cal', last_name: 'Whitfield', full_name: 'Cal Whitfield', team: 'NYJ', position: 'WR', active: true, injury_status: null },
  '1012': { player_id: '1012', search_rank: 12, first_name: 'Bo', last_name: 'Ashworth', full_name: 'Bo Ashworth', team: 'SEA', position: 'RB', active: true, injury_status: null },
  /*
   * Depth at quarterback and tight end, so the board has a *shape*.
   *
   * Two players at a position cannot have a tier structure — the model refuses
   * to call a cliff in a pool that small, and rightly — so the demo board had
   * nothing for the tier layer to draw and nothing for a browser test to check.
   * These are chosen to produce exactly two structures worth seeing:
   *
   *   QB — four inside four picks of each other, then a 22-pick hole. One
   *        divider, and a top tier of four: too many to be running out.
   *   TE — two, then a 28-pick hole. The same divider, and a top tier of two,
   *        which is what `Tier cliff · 2 away` is for.
   *
   * Nothing here is tuned to a threshold: the distribution decides, and the
   * numbers below are ordinary draft spacing for the two positions.
   */
  '1013': { player_id: '1013', search_rank: 13, first_name: 'Emil', last_name: 'Draeger', full_name: 'Emil Draeger', team: 'MIN', position: 'QB', active: true, injury_status: null },
  '1014': { player_id: '1014', search_rank: 14, first_name: 'Jonah', last_name: 'Priestley', full_name: 'Jonah Priestley', team: 'TB', position: 'QB', active: true, injury_status: null },
  '1015': { player_id: '1015', search_rank: 15, first_name: 'Casey', last_name: 'Lindqvist', full_name: 'Casey Lindqvist', team: 'DEN', position: 'QB', active: true, injury_status: null },
  '1016': { player_id: '1016', search_rank: 16, first_name: 'Ruben', last_name: 'Castellanos', full_name: 'Ruben Castellanos', team: 'PIT', position: 'QB', active: true, injury_status: null },
  '1017': { player_id: '1017', search_rank: 17, first_name: 'Miles', last_name: 'Barrowman', full_name: 'Miles Barrowman', team: 'CLE', position: 'TE', active: true, injury_status: null },
  '1018': { player_id: '1018', search_rank: 18, first_name: 'Teo', last_name: 'Ferreira', full_name: 'Teo Ferreira', team: 'HOU', position: 'TE', active: true, injury_status: null },
  '1019': { player_id: '1019', search_rank: 19, first_name: 'Grant', last_name: 'Aldous', full_name: 'Grant Aldous', team: 'WAS', position: 'TE', active: true, injury_status: null },
};

export const DEMO_ADP_CSV = `name,position,team,adp,rank
Marcus Vance,RB,KC,2.4,1
Devin Okafor,WR,CIN,3.1,2
Kai Brennan,WR,BUF,7.8,3
Julian Reyes,RB,MIA,11.2,4
Owen Fitzgerald,WR,PHI,14.6,5
Silas Mbeki,RB,GB,19.3,6
Trey Halloran,QB,SF,24.8,7
Emil Draeger,QB,MIN,26.5,8
Andre Sotelo,TE,DAL,28.1,9
Jonah Priestley,QB,TB,28.9,10
Casey Lindqvist,QB,DEN,30.2,11
Nate Kowalski,TE,DET,33.7,12
Cal Whitfield,WR,NYJ,41.2,13
Rhys Donnelly,QB,LAR,52.9,14
Ruben Castellanos,QB,PIT,55.4,15
Bo Ashworth,RB,SEA,58.4,16
Miles Barrowman,TE,CLE,62.0,17
Teo Ferreira,TE,HOU,66.5,18
Grant Aldous,TE,WAS,70.1,19
`;

/** Exercises positive, negative, negation, mixed, and ambiguity paths. */
export const DEMO_NEWSLETTER = `<html><body>
<div>View this email in your browser</div>
<h2>Camp Report</h2>
<p>Marcus Vance has been named the starter and is taking first-team reps in Kansas City.</p>
<p>Devin Okafor did not practice on Wednesday and is dealing with a hamstring injury.</p>
<p>Trey Halloran is not expected to miss time after leaving early; the team is not concerned.</p>
<p>Julian Reyes returned to practice but is expected to split work in a committee.</p>
<p>Kai Brennan could see an expanded role if the offense stays healthy.</p>
<p>Silas Mbeki is no longer limited and will handle goal-line work.</p>
<div>Unsubscribe | Privacy Policy</div>
<div>&copy; 2026 FF Newsletter, All rights reserved</div>
</body></html>`;

export const MOCK_GAMES: MockRoster[] = [
  {
    eventId: 'demo-game-1',
    startTime: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    homeTeam: 'Kansas City',
    awayTeam: 'Cincinnati',
    players: [
      { name: 'Marcus Vance', position: 'RB', team: 'KC' },
      { name: 'Devin Okafor', position: 'WR', team: 'CIN' },
      { name: 'Andre Sotelo', position: 'TE', team: 'DAL' },
      { name: 'Kai Brennan', position: 'WR', team: 'BUF' },
      { name: 'Trey Halloran', position: 'QB', team: 'SF' },
    ],
  },
];

export interface SeedSummary {
  players: number;
  leagues: number;
  drafts: number;
  adpMatched: number;
  evidence: number;
  props: number;
  seasonMarkets: number;
}

/** Populate a fresh database with the demo dataset. */
export async function seedDemoData(db: Database): Promise<SeedSummary> {
  const now = new Date().toISOString();

  // --- players ---
  const players = toCanonicalPlayers(DEMO_PLAYERS);
  const playerRepo = new PlayerRepo(db);
  await playerRepo.upsertMany(players);

  // Demo data represents a fully connected deployment.
  await new SettingsRepo(db).set(SETTING_KEYS.sleeperUser, {
    userId: 'demo-user',
    username: 'demo',
    displayName: 'Demo Manager',
  });

  // --- league + roster ---
  const leagueRepo = new LeagueRepo(db);
  await leagueRepo.upsertLeague({
    id: 'demo-league',
    sleeperLeagueId: 'demo-league',
    name: 'Demo Dynasty',
    season: '2026',
    totalRosters: 12,
    scoringSettings: { rec: 0.5, pass_td: 4, rush_yd: 0.1, rec_yd: 0.1, pass_yd: 0.04, rush_td: 6, rec_td: 6 },
    rosterPositions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN', 'BN', 'BN', 'BN'],
    leagueSettings: {},
    draftId: 'demo-draft',
    lastSyncedAt: now,
  });
  await leagueRepo.selectLeague('demo-league');
  await leagueRepo.replaceRosters('demo-league', [
    {
      leagueId: 'demo-league',
      rosterId: 1,
      ownerId: 'demo-user',
      ownerName: 'You',
      playerIds: ['1001', '1004', '1009', '1011'],
      starterIds: ['1001', '1004'],
      reserveIds: [],
      isMine: true,
    },
    {
      leagueId: 'demo-league',
      rosterId: 2,
      ownerId: 'rival',
      ownerName: 'Rival',
      playerIds: ['1002'],
      starterIds: ['1002'],
      reserveIds: [],
      isMine: false,
    },
  ]);

  // --- draft with a few picks already made ---
  await leagueRepo.upsertDraft({
    id: 'demo-draft',
    sleeperDraftId: 'demo-draft',
    leagueId: 'demo-league',
    status: 'drafting',
    type: 'snake',
    season: '2026',
    rounds: 12,
    teams: 12,
    slotToRosterId: { '1': 1, '2': 2 },
    settings: { rounds: 12, teams: 12 },
    lastSyncedAt: now,
  });
  await leagueRepo.upsertPicks([
    { draftId: 'demo-draft', pickNo: 1, round: 1, pickInRound: 1, draftSlot: 1, sleeperPlayerId: '1001', playerId: '1001', rosterId: 1, pickedBy: 'demo-user', raw: '{}' },
    { draftId: 'demo-draft', pickNo: 2, round: 1, pickInRound: 2, draftSlot: 2, sleeperPlayerId: '1002', playerId: '1002', rosterId: 2, pickedBy: 'rival', raw: '{}' },
  ]);

  // --- ADP snapshot ---
  const index = await playerRepo.buildIndex();
  const adpResult = importAdpSnapshot(DEMO_ADP_CSV, index, { label: 'Demo Sleeper ADP', source: 'demo' });
  const adpRepo = new AdpRepo(db);
  const { snapshot } = await adpRepo.save(adpResult);
  await leagueRepo.setDraftSnapshot('demo-draft', snapshot.id);

  // --- newsletter ingestion ---
  const newsletter = new NewsletterService(db);
  await new SettingsRepo(db).set(SETTING_KEYS.inboundAddress, 'fantasy-news@demo.example');
  await newsletter.setSources([
    {
      id: 'demo',
      label: 'Demo FF Newsletter',
      fromPatterns: ['@demo.newsletter'],
      subjectPatterns: ['camp', 'week', 'report'],
      enabled: true,
    },
  ]);
  const outcome = await newsletter.ingest(
    toEmailMessage({
      messageId: 'demo-message-1',
      from: 'editor@demo.newsletter',
      subject: 'Camp Report: Week 1',
      date: now,
      html: DEMO_NEWSLETTER,
    }),
  );

  // --- vegas props (mock provider, cached like the real path) ---
  const provider = new MockVegasProvider(MOCK_GAMES);
  const propsRepo = new PropsRepo(db);
  let propCount = 0;
  for (const game of MOCK_GAMES) {
    const raw = await provider.getPlayerProps(game.eventId);
    await propsRepo.put({
      provider: provider.name,
      eventId: game.eventId,
      gameStart: game.startTime,
      fetchedAt: raw.fetchedAt,
      raw,
    });
    const snapshotId = await propsRepo.snapshotId(provider.name, game.eventId, raw.fetchedAt);
    if (snapshotId != null) {
      const consensus = buildConsensus(raw.quotes, index);
      await propsRepo.saveConsensus(snapshotId, consensus);
      propCount += consensus.length;
    }
  }

  // --- season-long markets, through the same path the real provider uses ---
  // The draft reads these; seeding them means the demo exercises the whole
  // pipeline — provider, identity resolution, snapshot, baseline — rather than
  // only the weekly half of it.
  const seasonMarkets = await new SeasonMarketService(db, provider).refresh({ force: true });

  await seedPlayerDetail(db);

  return {
    players: players.length,
    leagues: 1,
    drafts: 1,
    adpMatched: adpResult.matchedCount,
    evidence: outcome.evidenceInserted,
    props: propCount,
    seasonMarkets: seasonMarkets.quotes,
  };
}

/**
 * Last season and this season's outlook, for the demo board.
 *
 * Seeded rather than fetched, for two reasons. The obvious one is that these
 * players do not exist, so nobody has written an outlook about them. The one
 * that matters more: the browser suite shares one dev server, and a card that
 * reaches Sleeper when it finds no cached outlook would turn every test run
 * into a burst of live requests to a third party for player ids that are not
 * theirs.
 *
 * So the misses are seeded too. A recorded miss is how the app remembers "there
 * is no outlook for him" without asking again, and seeding one for every demo
 * player who has no outlook is what keeps the suite entirely local.
 */
async function seedPlayerDetail(db: Database): Promise<void> {
  const now = new Date();
  const at = now.toISOString();
  const statsSeason = lastCompletedSeason(now);
  const season = outlookSeason(now);
  const repo = new PlayerDetailRepo(db);

  /*
   * A spread that exercises every state the card has: a full season, a
   * partial one, and a player who did not appear at all — whose line must come
   * back as a dash rather than as a rank in the twelve hundreds.
   */
  const lines: { id: string; position: string; gp: number | null; points: number | null }[] = [
    { id: '1001', position: 'RB', gp: 17, points: 291.4 },
    { id: '1002', position: 'WR', gp: 16, points: 268.9 },
    { id: '1003', position: 'QB', gp: 17, points: 334.2 },
    { id: '1004', position: 'TE', gp: 12, points: 148.6 },
    { id: '1005', position: 'WR', gp: 17, points: 254.1 },
    { id: '1006', position: 'RB', gp: 14, points: 212.8 },
    { id: '1007', position: 'WR', gp: 15, points: 201.5 },
    { id: '1008', position: 'RB', gp: 9, points: 118.3 },
    { id: '1009', position: 'TE', gp: 17, points: 161.2 },
    { id: '1010', position: 'QB', gp: 13, points: 233.7 },
    { id: '1011', position: 'WR', gp: 17, points: 176.4 },
    // Never played: no games, no points, and therefore no finish.
    { id: '1012', position: 'RB', gp: null, points: null },
    { id: '1013', position: 'QB', gp: 16, points: 289.5 },
    { id: '1014', position: 'QB', gp: 15, points: 271.3 },
    { id: '1015', position: 'QB', gp: 17, points: 262.9 },
    { id: '1016', position: 'QB', gp: 11, points: 168.4 },
    { id: '1017', position: 'TE', gp: 16, points: 139.8 },
    { id: '1018', position: 'TE', gp: 14, points: 121.5 },
    { id: '1019', position: 'TE', gp: null, points: null },
  ];

  // Ranked by the same function production uses, so the demo cannot show a
  // finish the real pipeline would not have produced.
  const payload: Record<string, { gp: number | null; pts_half_ppr: number | null }> = {};
  const positions = new Map(lines.map((l) => [l.id, l.position]));
  for (const line of lines) payload[line.id] = { gp: line.gp, pts_half_ppr: line.points };
  const { lines: ranked, diagnostics } = buildSeasonStatLines(payload, (id) => positions.get(id) ?? null);

  await repo.saveSeasonStats(statsSeason, ranked, at);
  await repo.recordStatsRun({
    season: statsSeason,
    fetchedAt: at,
    source: 'demo seed',
    rowsReturned: diagnostics.returned,
    rowsMatched: diagnostics.matched,
    rowsUnmatched: diagnostics.unmatched,
    rankDisagreements: diagnostics.rankDisagreements,
    note: 'synthetic demo data',
  });

  /** Two written outlooks; everyone else is honestly recorded as having none. */
  const written: Record<string, string> = {
    '1005':
      'Brennan enters his third year as the clear number one in Buffalo after a target share that climbed every ' +
      'month of last season. The arrival of a second inside receiver should cost him volume on early downs but not ' +
      'in the red zone, where he was targeted more than anyone at the position. Health is the only real question: ' +
      'the ankle that cost him two games in November was managed rather than resolved.',
    '1004':
      'Sotelo is being used as a move tight end rather than in line, which is what makes him interesting in a ' +
      'half-PPR league. Dallas lost both slot receivers and has not replaced either. He is listed as questionable ' +
      'into camp with a hamstring, and the staff have been unusually candid that they will not rush him.',
  };

  for (const line of lines) {
    const body = written[line.id];
    if (body) {
      await repo.saveOutlook(
        { playerId: line.id, season, title: `${season} Season Outlook`, body, source: 'demo' },
        at,
      );
    } else {
      await repo.recordOutlookMiss(line.id, season, at, 'no outlook published for this player');
    }
  }
}
