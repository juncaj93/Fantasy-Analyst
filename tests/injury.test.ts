/**
 * Availability now, and history worth a line.
 *
 * The risk in both halves is the same and it is invention. A status badge on
 * every row means nothing, and a "major injury history" derived from a player
 * having missed four games is a diagnosis the app made up.
 */

import { describe, expect, it } from 'vitest';
import { injuryStatusTag, majorInjuryHistory } from '../src/core/draft/injury.ts';
import { AdpRepo } from '../src/server/repos/adp.ts';
import { LeagueRepo } from '../src/server/repos/league.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { DraftBoardService } from '../src/server/services/draftBoard.ts';
import { importAdpSnapshot } from '../src/core/adp/import.ts';
import { createTestDb } from './helpers/db.ts';
import { player } from './helpers/players.ts';

describe('the current status tag', () => {
  it('tags the designations a drafter acts on', () => {
    expect(injuryStatusTag('Questionable')).toMatchObject({ code: 'Q', tone: 'caution' });
    expect(injuryStatusTag('Doubtful')).toMatchObject({ code: 'D', tone: 'serious' });
    expect(injuryStatusTag('Out')).toMatchObject({ code: 'OUT', tone: 'out' });
    expect(injuryStatusTag('IR')).toMatchObject({ code: 'IR', tone: 'out' });
    expect(injuryStatusTag('PUP')).toMatchObject({ code: 'PUP', tone: 'out' });
    expect(injuryStatusTag('Sus')).toMatchObject({ code: 'SUS', tone: 'out' });
  });

  it('carries the whole word, so the colour is never the only carrier', () => {
    expect(injuryStatusTag('Questionable')!.label).toBe('Questionable');
    expect(injuryStatusTag('IR')!.label).toBe('Injured reserve');
  });

  /**
   * The canonical status field falls back to Sleeper's *roster* status when
   * there is no injury, so `Active` arrives constantly. A board where every row
   * carries a badge is a board where the badge means nothing.
   */
  it('says nothing about a healthy player', () => {
    expect(injuryStatusTag('Active')).toBeNull();
    expect(injuryStatusTag(null)).toBeNull();
    expect(injuryStatusTag('')).toBeNull();
    expect(injuryStatusTag('Practice Squad')).toBeNull();
  });

  it('leaves an unrecognised code untagged rather than printing it raw', () => {
    expect(injuryStatusTag('COV')).toBeNull();
    expect(injuryStatusTag('DNR')).toBeNull();
  });

  it('does not care how the provider capitalises it', () => {
    expect(injuryStatusTag('  questionable ')).toMatchObject({ code: 'Q' });
    expect(injuryStatusTag('out')).toMatchObject({ code: 'OUT' });
  });
});

describe('major injury history', () => {
  it('names an injury the source text explicitly names', () => {
    const acl = majorInjuryHistory('Reyes tore his ACL in Week 11 and spent the rest of the year on IR.');
    expect(acl?.line).toBe('Major injury history: ACL');
    expect(majorInjuryHistory('He is back from a torn Achilles.')?.injuries).toEqual(['Achilles']);
    expect(majorInjuryHistory('A Lisfranc injury ended his season.')?.injuries).toEqual(['Lisfranc']);
    expect(majorInjuryHistory('He had shoulder surgery in March.')?.injuries).toEqual(['shoulder surgery']);
  });

  /**
   * The rule that keeps this honest: vague language is not a diagnosis. A
   * player who "missed time" has a gap in a game log, and calling it an ACL is
   * exactly the fabrication this project refuses.
   */
  it('invents nothing from vague language', () => {
    expect(majorInjuryHistory('He missed five games last season and was limited in camp.')).toBeNull();
    expect(majorInjuryHistory('A nagging hamstring cost him three games.')).toBeNull();
    expect(majorInjuryHistory('He did not practice on Wednesday.')).toBeNull();
    expect(majorInjuryHistory('The ankle that cost him two games was managed rather than resolved.')).toBeNull();
  });

  it('has nothing to say about no text', () => {
    expect(majorInjuryHistory(null)).toBeNull();
    expect(majorInjuryHistory('')).toBeNull();
  });

  it('names two at most, because a third is a medical history', () => {
    const many = majorInjuryHistory('He tore his ACL, then his Achilles, and later had shoulder surgery.');
    expect(many!.injuries.length).toBe(3);
    expect(many!.line.split(',').length).toBe(2);
  });

  it('does not match a word that merely contains an abbreviation', () => {
    expect(majorInjuryHistory('He signed a deal with MACLaren, apparently.')).toBeNull();
  });
});

/**
 * The guarantee behind showing status at all.
 *
 * Injury is already accounted for wherever the recommendation logic accounts
 * for it. This pass surfaces the designation visually and must not become a
 * second penalty — a board that quietly reorders when a tag appears would be
 * counting the same fact twice, and nobody would see it happen.
 */
describe('surfacing status changes no ranking', () => {
  async function boardWith(statuses: Record<string, string | null>) {
    const db = await createTestDb();
    const players = new PlayerRepo(db);
    await players.upsertMany(
      NAMES.map((fullName, i) =>
        player({
          id: `p${i + 1}`,
          fullName,
          position: ['QB', 'RB', 'WR', 'TE'][i % 4]!,
          team: 'KC',
          status: statuses[`p${i + 1}`] ?? null,
        }),
      ),
    );
    const leagues = new LeagueRepo(db);
    await leagues.upsertLeague({
      id: 'lg',
      sleeperLeagueId: 'lg',
      name: 'L',
      season: '2026',
      totalRosters: 12,
      scoringSettings: { rec: 0.5 },
      rosterPositions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN'],
      leagueSettings: {},
      draftId: 'dr',
      lastSyncedAt: new Date().toISOString(),
    });
    await leagues.selectLeague('lg');
    await leagues.upsertDraft({
      id: 'dr',
      sleeperDraftId: 'dr',
      leagueId: 'lg',
      status: 'drafting',
      type: 'snake',
      season: '2026',
      rounds: 4,
      teams: 12,
      slotToRosterId: { '3': 7 },
      settings: {},
      lastSyncedAt: new Date().toISOString(),
    });
    await leagues.replaceRosters('lg', [
      { leagueId: 'lg', rosterId: 7, ownerId: 'me', ownerName: 'Me', playerIds: [], starterIds: [], reserveIds: [], isMine: true },
    ]);
    const index = await players.buildIndex();
    const csv = ['Player,Position,Team,ADP']
      .concat(NAMES.map((n, i) => `${n},${['QB', 'RB', 'WR', 'TE'][i % 4]},KC,${i + 1}`))
      .join('\n');
    const { snapshot } = await new AdpRepo(db).save(
      importAdpSnapshot(`${csv}\n`, index, { label: 't', source: 't' }),
    );
    await leagues.setDraftSnapshot('dr', snapshot.id);
    return new DraftBoardService(db).build('dr', { limit: 20 });
  }

  const NAMES = Array.from({ length: 20 }, (_, i) => `Player ${String(i + 1).padStart(2, '0')}`);

  it('returns the same order and the same totals either way', async () => {
    const healthy = await boardWith({});
    const hurt = await boardWith({ p1: 'Out', p2: 'Questionable', p5: 'IR', p9: 'Doubtful' });

    expect(hurt.recommendations.map((r) => r.playerId)).toEqual(healthy.recommendations.map((r) => r.playerId));
    expect(hurt.recommendations.map((r) => r.total)).toEqual(healthy.recommendations.map((r) => r.total));

    // …and the tag is genuinely on the board, so this is not passing by
    // accident because nothing was set.
    expect(hurt.recommendations.find((r) => r.playerId === 'p1')?.status).toBe('Out');
    expect(injuryStatusTag(hurt.recommendations.find((r) => r.playerId === 'p1')!.status)).toMatchObject({
      code: 'OUT',
    });
    expect(healthy.recommendations.find((r) => r.playerId === 'p1')?.status).toBeNull();
  });
});
