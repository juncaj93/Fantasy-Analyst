/**
 * Defences are an afterthought, and the board now says so by doing less.
 *
 * The reported symptom was a sentence: "no draft order covers DEF in this
 * ranking, so they are listed on news and roster need alone", standing above
 * the board in a league that starts a defence. It was accurate, and what it
 * described is the defect — with no published draft order for defences the only
 * live inputs left were a news tally and an empty roster slot, so a newsletter
 * sentence could move a defence up a draft board.
 *
 * A defence is now ranked on the draft market and on nothing else. Two claims,
 * and both are tested here rather than argued:
 *
 *  1. a defence's order is Sleeper ADP, and no other input can move it;
 *  2. no non-defence player's ranking changed by so much as a rounding error.
 *
 * The second is the one worth being paranoid about, so it is asserted as a deep
 * comparison of the whole recommendation object — every component, weight,
 * contribution, tier, reason and total — between a board with defences on it
 * and the same board without them.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEIGHTS,
  DEFENCE_WEIGHTS,
  rankAvailablePlayers,
  type AvailablePlayerInput,
} from '../src/core/draft/engine.ts';
import { buildRosterShape, buildScoringProfile } from '../src/core/sleeper/scoring.ts';
import { emptySignal } from '../src/core/evidence/aggregate.ts';
import { importAdpSnapshot } from '../src/core/adp/import.ts';
import { AdpRepo } from '../src/server/repos/adp.ts';
import { LeagueRepo } from '../src/server/repos/league.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { DraftBoardService } from '../src/server/services/draftBoard.ts';
import type { NodeSqliteDatabase } from '../src/server/adapters/nodeSqlite.ts';
import { createTestDb } from './helpers/db.ts';
import { player } from './helpers/players.ts';

const HALF_PPR = buildScoringProfile({ rec: 0.5, pass_td: 4 }, []);
const SHAPE = buildRosterShape(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'DEF', 'BN', 'BN']);

// ---------------------------------------------------------------- the engine

/**
 * A news tally loud enough to move anybody the board is willing to move.
 *
 * All three windows, with item counts: `newsComponent` reports "unknown" on a
 * window nobody wrote anything into, so a net with no items behind it is not a
 * quiet tally — it is no tally, and would make this test pass for the wrong
 * reason.
 */
function loudSignal() {
  const signal = emptySignal('def-0');
  return {
    ...signal,
    raw: { positive: 12, negative: 0, net: 12, items: 6 },
    last30: { positive: 8, negative: 0, net: 8, items: 4 },
    last7: { positive: 5, negative: 0, net: 5, items: 2 },
  };
}

function defenceInput(id: string, adp: number | null, extra: Partial<AvailablePlayerInput> = {}) {
  return {
    player: player({ id, fullName: `${id} Defence`, position: 'DEF', team: 'KC' }),
    adp,
    dogAdp: null,
    adpRank: null,
    signal: null,
    myGuyLevel: 0 as const,
    seasonMarkets: [],
    preseasonPoints: null,
    nextPickSurvival: null,
    ...extra,
  } as AvailablePlayerInput;
}

const CTX = {
  currentPick: 100,
  nextPick: 112,
  shape: SHAPE,
  profile: HALF_PPR,
  // An empty defence slot, which is the state that used to move one.
  rosterCounts: { QB: 1, RB: 2, WR: 2, TE: 1, DEF: 0 },
  totalPicks: 192,
  marketFormat: 'standard' as const,
};

describe('DEFENCE_WEIGHTS spends nothing but the market', () => {
  it('is zero on every component except market value', () => {
    for (const [key, weight] of Object.entries(DEFENCE_WEIGHTS)) {
      if (key === 'marketValue') {
        expect(weight, 'the market is the one thing a defence is ranked on').toBe(1);
        continue;
      }
      expect(weight, `${key} may not move a defence`).toBe(0);
    }
    // ...and it is the same shape as the real weights, so a component added
    // later cannot quietly default to being applied to defences.
    expect(Object.keys(DEFENCE_WEIGHTS).sort()).toEqual(Object.keys(DEFAULT_WEIGHTS).sort());
  });

  /**
   * The reported behaviour, as a before-and-after on one call.
   *
   * The same three defences, the same ADPs, and a news tally on one of them.
   *
   * Asserted as the *composite* rather than as an order flip, which is the
   * precise claim and does not depend on choosing ADPs far enough apart to make
   * one. What the warning disclosed is that a tally was being spent on a
   * defence at all: whether that was enough to reorder a particular board is a
   * fact about the gaps on it, and the thing being removed is the spending.
   */
  it('stops a news tally moving a defence at all', () => {
    const adps = [118, 112, 106];
    const quiet = adps.map((adp, i) => defenceInput(`def-${i}`, adp));
    const loud = adps.map((adp, i) => defenceInput(`def-${i}`, adp, i === 0 ? { signal: loudSignal() } : {}));

    // What the warning was disclosing: the tally is real weight on a defence.
    const before = rankAvailablePlayers(quiet, CTX).map((r) => r.total);
    const beforeWithNews = rankAvailablePlayers(loud, CTX).map((r) => r.total);
    expect(beforeWithNews, 'the tally used to be spent on a defence').not.toEqual(before);

    // Under the defence weights it is not spent: identical order, identical
    // numbers, so nothing was merely re-sorted after the fact.
    const after = rankAvailablePlayers(quiet, CTX, DEFENCE_WEIGHTS);
    const afterWithNews = rankAvailablePlayers(loud, CTX, DEFENCE_WEIGHTS);
    expect(afterWithNews.map((r) => r.playerId)).toEqual(['def-2', 'def-1', 'def-0']);
    expect(afterWithNews.map((r) => r.total)).toEqual(after.map((r) => r.total));

    /*
     * ...and nothing but the market contributed a thing.
     *
     * The components are still *computed* and still describe themselves — a
     * zero weight silences a component, it does not delete it — so the check is
     * on what each one spent.
     *
     * Three carry weights of their own rather than reading this table.
     * `separation` and `opportunity` are measured within the defences from
     * market-derived bases, so they cannot import anything that is not the
     * market, and the order is settled by ADP rather than left to them — see
     * the sort in `boardBuilder.ts`. `team_concentration` *would* import
     * something else: your own drafted roster. The board withholds the roster
     * from the defence pass for that reason, which this call deliberately does
     * not, so that the exclusion here is the narrow one and the board's is
     * asserted where the board is.
     */
    const OWN_WEIGHT = new Set(['separation', 'opportunity', 'team_concentration']);
    for (const rec of afterWithNews) {
      for (const component of rec.components) {
        if (component.key === 'market_value' || OWN_WEIGHT.has(component.key)) continue;
        expect(component.weight, `${component.key} kept a weight`).toBe(0);
        // `+ 0` normalises the negative zero a rounded `-0.0` leaves behind:
        // it is the same nothing, and `toBe` would tell them apart.
        expect(component.contribution + 0, `${component.key} spent something on a defence`).toBe(0);
      }
    }
  });

  /** The same for every other input the board could once spend on a defence. */
  it('stops My Guy, a season market and a projection reordering them too', () => {
    const plain = rankAvailablePlayers(
      [defenceInput('def-a', 150), defenceInput('def-b', 120)],
      CTX,
      DEFENCE_WEIGHTS,
    );
    const loaded = rankAvailablePlayers(
      [
        defenceInput('def-a', 150, {
          myGuyLevel: 3,
          preseasonPoints: 400,
          seasonMarkets: [{ market: 'season_pass_yards' as const, line: 5000, bookCount: 4 }],
        }),
        defenceInput('def-b', 120),
      ],
      CTX,
      DEFENCE_WEIGHTS,
    );

    expect(loaded.map((r) => r.playerId)).toEqual(plain.map((r) => r.playerId));
    expect(loaded.map((r) => r.total)).toEqual(plain.map((r) => r.total));
  });
});

// ----------------------------------------------------------------- the board

/**
 * A league that starts a defence, with a ranking that covers both.
 *
 * `withDefences: false` builds the identical world minus the defence players,
 * which is how the "nothing else moved" comparison is taken: same league, same
 * draft, same snapshot, same field.
 */
async function board(options: { withDefences: boolean; position?: string }) {
  const db: NodeSqliteDatabase = await createTestDb();
  const players = new PlayerRepo(db);

  const field = [
    player({ id: 'qb1', fullName: 'Pocket Passer', position: 'QB', team: 'GB' }),
    player({ id: 'rb1', fullName: 'Lead Back', position: 'RB', team: 'KC' }),
    player({ id: 'rb2', fullName: 'Change Up', position: 'RB', team: 'CIN' }),
    player({ id: 'wr1', fullName: 'Field Stretcher', position: 'WR', team: 'DET' }),
    player({ id: 'wr2', fullName: 'Slot Man', position: 'WR', team: 'MIA' }),
    player({ id: 'te1', fullName: 'Seam Runner', position: 'TE', team: 'BAL' }),
  ];
  /*
   * Deliberately inserted in an order that is neither their ADP order nor
   * alphabetical, so an ordering that came from the table rather than from the
   * market would not pass by luck.
   */
  const defences = [
    player({ id: 'def1', fullName: 'Denver Broncos', position: 'DEF', team: 'DEN' }),
    player({ id: 'def2', fullName: 'Baltimore Ravens', position: 'DEF', team: 'BAL' }),
    player({ id: 'def3', fullName: 'Cleveland Browns', position: 'DEF', team: 'CLE' }),
  ];
  await players.upsertMany(options.withDefences ? [...field, ...defences] : field);

  const leagues = new LeagueRepo(db);
  await leagues.upsertLeague({
    id: 'def-league',
    sleeperLeagueId: 'def-league',
    name: 'Starts A Defence',
    season: '2026',
    totalRosters: 10,
    scoringSettings: { rec: 0.5, pass_td: 4 },
    rosterPositions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'DEF', 'BN', 'BN'],
    leagueSettings: {},
    draftId: 'def-draft',
    lastSyncedAt: new Date().toISOString(),
  });
  await leagues.selectLeague('def-league');
  await leagues.upsertDraft({
    id: 'def-draft',
    sleeperDraftId: 'def-draft',
    leagueId: 'def-league',
    status: 'drafting',
    type: 'snake',
    season: '2026',
    rounds: 10,
    teams: 10,
    slotToRosterId: {},
    settings: {},
    lastSyncedAt: new Date().toISOString(),
  });

  /*
   * A ranking that covers defences.
   *
   * No published ADP this project actually imports does, which is why the
   * warning existed — but "ordered by Sleeper ADP" is only a testable claim
   * where an ADP exists, so this one covers them, out of alphabetical order and
   * out of insertion order.
   */
  const index = await players.buildIndex();
  const csv = [
    'Player,Position,Team,ADP',
    'Pocket Passer,QB,GB,20',
    'Lead Back,RB,KC,4',
    'Change Up,RB,CIN,33',
    'Field Stretcher,WR,DET,8',
    'Slot Man,WR,MIA,41',
    'Seam Runner,TE,BAL,52',
    ...(options.withDefences
      ? ['Denver Broncos,DEF,DEN,140', 'Baltimore Ravens,DEF,BAL,118', 'Cleveland Browns,DEF,CLE,129']
      : []),
  ].join('\n');
  const { snapshot } = await new AdpRepo(db).save(
    importAdpSnapshot(`${csv}\n`, index, { label: 'covers defences', source: 'test' }),
  );
  await leagues.setDraftSnapshot('def-draft', snapshot.id);

  return new DraftBoardService(db).build('def-draft', {
    limit: 50,
    ...(options.position ? { position: options.position } : {}),
  });
}

describe('the board ranks defences on Sleeper ADP alone', () => {
  it('orders them by ADP, ascending', async () => {
    const only = await board({ withDefences: true, position: 'DEF' });
    expect(only.recommendations.map((r) => r.name)).toEqual([
      'Baltimore Ravens', // 118
      'Cleveland Browns', // 129
      'Denver Broncos', // 140
    ]);
    // The order really is the market's, not the composite's: read the ADPs back
    // off the rows and check they ascend.
    const adps = only.recommendations.map((r) => r.adp);
    expect(adps).toEqual([...adps].sort((a, b) => (a ?? 0) - (b ?? 0)));
  });

  /** No DOG column and no projection on a defence, because neither is used. */
  it('carries no second market and no projection on a defence row', async () => {
    const only = await board({ withDefences: true, position: 'DEF' });
    for (const rec of only.recommendations) {
      expect(rec.dogAdp, `${rec.name} carried a DOG value`).toBeNull();
      expect(rec.preseasonPoints, `${rec.name} carried a projection`).toBeNull();
      expect(rec.myGuy.level).toBe(0);
    }
  });

  /**
   * Nothing but the market contributed to a defence's composite, on the board
   * rather than in a hand-built call.
   *
   * The two components that carry weights of their own are the ones worth
   * naming. `team_concentration` is silenced by withholding the roster, because
   * it is a roster-derived adjustment and those are exactly what a defence must
   * not get. `separation` and `opportunity` are measured within the defences
   * from market-derived bases and cannot import anything else — and the order
   * is Sleeper ADP regardless of what they say, which the test above checks.
   */
  it('spends nothing but the market on a defence row', async () => {
    const only = await board({ withDefences: true, position: 'DEF' });
    const measured = new Set<string>();
    for (const rec of only.recommendations) {
      for (const component of rec.components) {
        measured.add(component.key);
        if (component.key === 'market_value') continue;
        if (component.key === 'separation' || component.key === 'opportunity') continue;
        expect(component.contribution + 0, `${component.key} moved ${rec.name}`).toBe(0);
      }
    }
    // The loop above proves nothing if the row carries two components, so this
    // says the board really did compute the whole set for a defence.
    expect(measured.has('team_concentration')).toBe(true);
    expect(measured.has('news_lifetime')).toBe(true);
    expect(measured.size).toBeGreaterThan(8);
  });

  it('no longer apologises for them above the board', async () => {
    const full = await board({ withDefences: true });
    expect(full.warnings.join(' ')).not.toContain('no draft order covers');
    expect(full.warnings.join(' ')).not.toContain('news and roster need alone');
  });

  /** An afterthought sits after the thought: defences follow the field. */
  it('lists them after every non-defence player', async () => {
    const full = await board({ withDefences: true });
    const positions = full.recommendations.map((r) => r.position);
    const firstDefence = positions.indexOf('DEF');
    expect(firstDefence, 'the defences are missing from the board entirely').toBeGreaterThan(-1);
    expect(positions.slice(firstDefence).every((p) => p === 'DEF')).toBe(true);
  });
});

describe('nothing that is not a defence moved', () => {
  /**
   * The paranoid one: the whole recommendation object, deep-compared.
   *
   * Not the order, not the totals — every component, its weight, its
   * contribution, the tier, the reasons, the survival, the lot. If ranking
   * defences apart had disturbed so much as a rounding step in a scarcity pool
   * or a tier ladder, this is where it would show.
   */
  it('produces byte-for-byte identical rows with the defences present and absent', async () => {
    const [withThem, withoutThem] = await Promise.all([
      board({ withDefences: true }),
      board({ withDefences: false }),
    ]);

    const field = (b: Awaited<ReturnType<typeof board>>) =>
      b.recommendations.filter((r) => r.position !== 'DEF');

    expect(field(withThem).length, 'the field is empty, so this proves nothing').toBeGreaterThan(4);
    expect(JSON.stringify(field(withThem))).toEqual(JSON.stringify(field(withoutThem)));
  });

  /** ...and the same holds one position at a time, where a chip narrows it. */
  it('is unchanged under a position filter too', async () => {
    for (const position of ['QB', 'RB', 'WR', 'TE']) {
      const [withThem, withoutThem] = await Promise.all([
        board({ withDefences: true, position }),
        board({ withDefences: false, position }),
      ]);
      expect(JSON.stringify(withThem.recommendations), `${position} moved`).toEqual(
        JSON.stringify(withoutThem.recommendations),
      );
    }
  });
});
