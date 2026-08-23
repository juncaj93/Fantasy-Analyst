/**
 * The real StartWho paste, all the way to stored rows.
 *
 * Against a real database and the real player dictionary shape, because the
 * things worth proving here are about identity, scoring-profile validity and
 * replacement rather than arithmetic.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { projectionScoringFrom, scoringKey, describeScoring } from '../src/core/startWho/scoring.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { NewsletterRepo } from '../src/server/repos/newsletter.ts';
import { PreseasonProjectionsRepo } from '../src/server/repos/preseasonProjections.ts';
import { PreseasonProjectionService } from '../src/server/services/preseasonProjectionService.ts';
import { createTestDb } from './helpers/db.ts';
import { player } from './helpers/players.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';

const SAMPLE = readFileSync(join(import.meta.dirname, 'fixtures', 'startwho-sample.txt'), 'utf8');

/** The league the sample was captured under: Half PPR, 6-point passing TDs. */
const HALF_PPR_6PT = buildScoringProfile({ rec: 0.5, pass_td: 6 }, []);
const FOUR_PT = buildScoringProfile({ rec: 0.5, pass_td: 4 }, []);

/*
 * The players the sample names, spelled as Sleeper spells them. Teams are
 * deliberately Sleeper's codes while the sample carries full club names — that
 * mismatch is the thing the import has to bridge.
 */
const ROSTER = [
  player({ id: 'gibbs', fullName: 'Jahmyr Gibbs', team: 'DET', position: 'RB' }),
  player({ id: 'bijan', fullName: 'Bijan Robinson', team: 'ATL', position: 'RB' }),
  player({ id: 'chase', fullName: "Ja'Marr Chase", team: 'CIN', position: 'WR' }),
  player({ id: 'nacua', fullName: 'Puka Nacua', team: 'LAR', position: 'WR' }),
  player({ id: 'cmc', fullName: 'Christian McCaffrey', team: 'SF', position: 'RB' }),
  player({ id: 'stbrown', fullName: 'Amon-Ra St. Brown', team: 'DET', position: 'WR' }),
  player({ id: 'mcbride', fullName: 'Trey McBride', team: 'ARI', position: 'TE' }),
  player({ id: 'allen', fullName: 'Josh Allen', team: 'BUF', position: 'QB' }),
  player({ id: 'ajbrown', fullName: 'A.J. Brown', team: 'NE', position: 'WR' }),
  player({ id: 'kwiii', fullName: 'Kenneth Walker III', team: 'KC', position: 'RB' }),
  player({ id: 'maye', fullName: 'Drake Maye', team: 'NE', position: 'QB' }),
  player({ id: 'pitts', fullName: 'Kyle Pitts', team: 'ATL', position: 'TE' }),
  player({ id: 'fannin', fullName: 'Harold Fannin Jr.', team: 'CLE', position: 'TE' }),
  player({ id: 'kelce', fullName: 'Travis Kelce', team: 'KC', position: 'TE' }),
  player({ id: 'lamar', fullName: 'Lamar Jackson', team: 'BAL', position: 'QB' }),
  player({ id: 'pierce', fullName: 'Alec Pierce', team: 'IND', position: 'WR' }),
  player({ id: 'godwin', fullName: 'Chris Godwin Jr.', team: 'TB', position: 'WR' }),
  player({ id: 'wandale', fullName: "Wan'Dale Robinson", team: 'TEN', position: 'WR' }),
  player({ id: 'concepcion', fullName: 'K.C. Concepcion', team: 'CLE', position: 'WR' }),
  // Deliberately absent: Jacory Croskey-Merritt, so one row is unresolved.
];

let db: NodeSqliteDatabase;
let service: PreseasonProjectionService;

beforeEach(async () => {
  db = await createTestDb();
  await new PlayerRepo(db).upsertMany(ROSTER);
  service = new PreseasonProjectionService(db);
});

const REQ = { content: SAMPLE, season: '2026', profile: HALF_PPR_6PT };

async function storedRows(): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM preseason_projections').first<{ n: number }>();
  return Number(row?.n ?? 0);
}

describe('preview writes nothing', () => {
  it('reports what would happen and stores none of it', async () => {
    const out = await service.preview(REQ);
    expect(out.committed).toBe(false);
    expect(out.counts.accepted).toBe(20);
    expect(await storedRows()).toBe(0);
  });

  it('files no Review items', async () => {
    await service.preview(REQ);
    expect(await new NewsletterRepo(db).pendingIdentityCount()).toBe(0);
  });
});

describe('the real paste, applied', () => {
  it('imports every row and matches all but the player we do not have', async () => {
    const out = await service.apply(REQ);
    expect(out.counts.parsed).toBe(20);
    expect(out.counts.accepted).toBe(20);
    expect(out.counts.rejected).toBe(0);
    expect(out.counts.matched).toBe(19);
    expect(out.counts.unmatched).toBe(1);
    expect(out.needsReview[0]?.name).toBe('Jacory Croskey-Merritt');
  });

  it('bridges full club names onto this app\'s codes', async () => {
    await service.apply(REQ);
    const row = await db
      .prepare("SELECT source_team, team_code FROM preseason_projections WHERE source_player_name = 'Jahmyr Gibbs'")
      .first<Record<string, unknown>>();
    expect(String(row?.['source_team'])).toBe('Detroit Lions');
    expect(String(row?.['team_code'])).toBe('DET');
  });

  it('takes the capture date from the page rather than from a person', async () => {
    const out = await service.apply(REQ);
    expect(out.lastUpdated).toBe('Aug 22 at 9:01 AM');
    expect(out.capturedAt).toBe('2026-08-22');
    expect(out.capturedFrom).toBe('paste');
  });

  it('stores the scoring profile as part of the snapshot\'s identity', async () => {
    const out = await service.apply(REQ);
    expect(out.scoringKey).toBe(scoringKey(projectionScoringFrom(HALF_PPR_6PT)));
    expect(out.scoringLabel).toBe('Half PPR · 6pt pass TD');
    expect(out.scoringKey).toContain('ppr0.5');
    expect(out.scoringKey).toContain('passtd6');
  });

  it('keeps the points exactly as the source published them', async () => {
    await service.apply(REQ);
    const rows = await db
      .prepare('SELECT source_player_name, points FROM preseason_projections ORDER BY points DESC')
      .all<Record<string, unknown>>();
    const byName = new Map(rows.results.map((r) => [String(r['source_player_name']), Number(r['points'])]));
    expect(byName.get('Josh Allen')).toBe(386.1);
    expect(byName.get('Jahmyr Gibbs')).toBe(292.0);
    expect(byName.get('Puka Nacua')).toBe(234.8);
    expect(byName.get('Travis Kelce')).toBe(127.7);
  });

  it('stores the source ordinal and agreement count without using them', async () => {
    await service.apply(REQ);
    const row = await db
      .prepare("SELECT source_rank, source_count FROM preseason_projections WHERE source_player_name = 'Josh Allen'")
      .first<Record<string, unknown>>();
    // Kept for audit. Nothing reads either as a ranking input.
    expect(Number(row?.['source_rank'])).toBe(14);
    expect(String(row?.['source_count'])).toBe('4/5');
  });

  it('stores an unresolved player with no id, and queues it', async () => {
    const out = await service.apply(REQ);
    expect(out.reviewsFiled).toBe(1);
    expect(await new NewsletterRepo(db).pendingIdentityCount()).toBe(1);
    const row = await db
      .prepare('SELECT COUNT(*) AS n FROM preseason_projections WHERE player_id IS NULL')
      .first<{ n: number }>();
    expect(Number(row?.n)).toBe(1);
  });
});

describe('scoring profile is identity, not metadata', () => {
  it('keeps two profiles as separate snapshots', async () => {
    await service.apply(REQ);
    await service.apply({ ...REQ, profile: FOUR_PT });
    const all = await new PreseasonProjectionsRepo(db).list('2026');
    expect(all).toHaveLength(2);
    expect(new Set(all.map((s) => s.scoringKey)).size).toBe(2);
  });

  it('serves a league only the snapshot its own rules produced', async () => {
    await service.apply(REQ);
    const mine = await service.latestFor('2026', HALF_PPR_6PT);
    const theirs = await service.latestFor('2026', FOUR_PT);
    expect(mine?.scoringLabel).toBe('Half PPR · 6pt pass TD');
    // A four-point league gets nothing rather than a number that is fifty
    // points wrong on every quarterback.
    expect(theirs).toBeNull();
  });

  it('warns when the declared profile cannot be right', async () => {
    // The sample's best QB leads its best skill player by ~94 points, which is
    // six-point territory. Declaring four-point should say so.
    const out = await service.preview({ ...REQ, profile: FOUR_PT });
    expect(out.warnings.join(' ')).toMatch(/six-point passing/i);
  });

  it('says nothing when the declared profile fits', async () => {
    const out = await service.preview(REQ);
    expect(out.warnings.filter((w) => /passing touchdown/i.test(w))).toEqual([]);
  });

  it('never overrules what it was told', async () => {
    // The warning is advice. The snapshot still stores the declared profile,
    // because a model this app does not own may legitimately differ from its
    // own arithmetic.
    const out = await service.apply({ ...REQ, profile: FOUR_PT });
    expect(out.committed).toBe(true);
    expect(out.scoringLabel).toBe('Half PPR · 4pt pass TD');
  });
});

describe('idempotence and history', () => {
  it('revises rather than stacks on a second import of the same capture', async () => {
    await service.apply(REQ);
    await service.apply(REQ);
    expect(await new PreseasonProjectionsRepo(db).list('2026')).toHaveLength(1);
    expect(await storedRows()).toBe(20);
  });

  it('keeps a later capture beside the earlier one', async () => {
    await service.apply(REQ);
    const later = SAMPLE.replace('Last updated: Aug 22 at 9:01 AM', 'Last updated: Aug 29 at 9:01 AM');
    await service.apply({ ...REQ, content: later });
    const all = await new PreseasonProjectionsRepo(db).list('2026');
    expect(all.map((s) => s.capturedAt)).toEqual(['2026-08-29', '2026-08-22']);
  });

  it('tells a preview it would revise an existing capture', async () => {
    await service.apply(REQ);
    const out = await service.preview(REQ);
    expect(out.replaces?.capturedAt).toBe('2026-08-22');
  });

  it('does not file the same review question twice', async () => {
    await service.apply(REQ);
    await service.apply(REQ);
    expect(await new NewsletterRepo(db).pendingIdentityCount()).toBe(1);
  });
});

describe('what it does not do', () => {
  it('writes nothing into the market tables', async () => {
    await service.apply(REQ);
    // A projection is not a line. It must not appear anywhere a market query
    // could find it.
    const props = await db
      .prepare('SELECT COUNT(*) AS n FROM player_props')
      .first<{ n: number }>();
    const snaps = await db
      .prepare('SELECT COUNT(*) AS n FROM prop_snapshots')
      .first<{ n: number }>();
    expect(Number(props?.n)).toBe(0);
    expect(Number(snaps?.n)).toBe(0);
  });

  it('carries no polarity or magnitude into the review queue', async () => {
    await service.apply(REQ);
    const row = await db
      .prepare('SELECT proposed_polarity, proposed_magnitude FROM identity_reviews LIMIT 1')
      .first<Record<string, unknown>>();
    expect(String(row?.['proposed_polarity'])).toBe('neutral');
    expect(Number(row?.['proposed_magnitude'])).toBe(0);
  });
});

describe('the scoring label a person reads', () => {
  it('says the two things that actually matter', () => {
    expect(describeScoring(projectionScoringFrom(HALF_PPR_6PT))).toBe('Half PPR · 6pt pass TD');
    expect(describeScoring(projectionScoringFrom(buildScoringProfile({ rec: 1, pass_td: 4 }, [])))).toBe(
      'Full PPR · 4pt pass TD',
    );
    expect(describeScoring(projectionScoringFrom(buildScoringProfile({ pass_td: 6 }, [])))).toBe(
      'Standard · 6pt pass TD',
    );
  });
});
