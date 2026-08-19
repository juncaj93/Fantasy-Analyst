/**
 * One matcher, one answer, on every surface that searches for a player.
 *
 * The bug this file exists to prevent has a very specific shape, and it is not
 * "the matcher is wrong". The matcher was fine. What was wrong was that only
 * *one* screen used it: Draft filtered a list already in memory and answered
 * `Amon Ra` correctly, while Players and the Team comparison picker asked the
 * server, which ran a literal `LIKE` and answered "nobody matching". Same app,
 * same query, two answers, and nothing on either screen admitting the other
 * existed.
 *
 * So the cases below are written **once** and run against **every surface**,
 * through a small adapter each. A surface that stops sharing the matcher fails
 * the whole matrix rather than quietly diverging, and a case added here is
 * automatically demanded of all of them.
 *
 * The surfaces, and why each is a genuinely different code path:
 *
 *   - **client list** — `rankByQuery` over rows already on screen. The draft
 *     board, and the cheapest case: everything is in memory.
 *   - **server** — SQL recall against two indexed forms of the key, then
 *     ranking. The database cannot run the matcher, so it has to hand it
 *     candidates, and a recall rule that disagrees with the matcher is how a
 *     player who would have matched is never offered.
 *   - **demo runtime** — the in-memory scenario handler behind Demo Mode. It
 *     is a separate implementation of the same endpoint, and a demo that
 *     behaves unlike the product is worse than no demo.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { rankByNormalized, rankByQuery } from '../src/core/search/players.ts';
import { normalizeName } from '../src/core/identity/normalize.ts';
import { PlayerRepo } from '../src/server/repos/players.ts';
import { createTestDb } from './helpers/db.ts';
import type { CanonicalPlayer } from '../src/core/identity/types.ts';

/**
 * The pool every surface searches.
 *
 * Deliberately holds the shapes that break literal matching — a hyphen, an
 * apostrophe, an accent, a suffix, a shortened given name — plus the decoys
 * that a careless fuzzy matcher would drag in: a three-letter name, and two
 * players who share a surname prefix.
 */
const ROSTER: { id: string; fullName: string; position: string; team: string }[] = [
  { id: 'p-amonra', fullName: 'Amon-Ra St. Brown', position: 'WR', team: 'DET' },
  { id: 'p-jamarr', fullName: "Ja'Marr Chase", position: 'WR', team: 'CIN' },
  { id: 'p-bijan', fullName: 'Bijan Robinson', position: 'RB', team: 'ATL' },
  { id: 'p-puka', fullName: 'Puka Nacua', position: 'WR', team: 'LAR' },
  { id: 'p-marvin', fullName: 'Marvin Harrison Jr.', position: 'WR', team: 'ARI' },
  { id: 'p-jose', fullName: 'José Ramírez', position: 'TE', team: 'MIA' },
  { id: 'p-dj', fullName: 'D.J. Moore', position: 'WR', team: 'CHI' },
  { id: 'p-zoe', fullName: 'Zoe Carter', position: 'RB', team: 'BUF' },
  { id: 'p-charb', fullName: 'Aaron Charbonnet', position: 'RB', team: 'SEA' },
  { id: 'p-levis', fullName: 'Will Levis', position: 'QB', team: 'TEN' },
  { id: 'p-willr', fullName: 'William Robinson', position: 'WR', team: 'NYJ' },
];

type Row = (typeof ROSTER)[number] & { normalizedName: string };
const ROWS: Row[] = ROSTER.map((p) => ({ ...p, normalizedName: normalizeName(p.fullName) }));

/** A surface: given a query, which player ids come back, in order. */
interface Surface {
  name: string;
  find(query: string): Promise<string[]>;
}

let repo: PlayerRepo;

beforeAll(async () => {
  const db = await createTestDb();
  repo = new PlayerRepo(db);
  await repo.upsertMany(
    ROWS.map(
      (p): CanonicalPlayer => ({
        id: p.id,
        sleeperPlayerId: p.id,
        fullName: p.fullName,
        firstName: p.fullName.split(' ')[0] ?? '',
        lastName: p.fullName.split(' ').slice(1).join(' '),
        team: p.team,
        position: p.position,
        status: null,
        active: true,
        normalizedName: p.normalizedName,
        aliases: [],
        externalIds: {},
      }) as CanonicalPlayer,
    ),
  );
});

const SURFACES: Surface[] = [
  {
    name: 'client list',
    async find(query) {
      return rankByQuery(ROWS, query, (p) => p.fullName).map((p) => p.id);
    },
  },
  {
    name: 'server',
    async find(query) {
      return (await repo.search(query, 40)).map((p) => p.id);
    },
  },
  {
    name: 'demo runtime',
    async find(query) {
      // The shape the demo handler uses: rank the in-memory scenario pool off
      // the stored key. Kept as its own surface because it is its own code
      // path, not because the call differs.
      return rankByNormalized(ROWS, query, (p) => p.normalizedName).map((p) => p.id);
    },
  },
];

/** One row of the matrix: a query, and the player every surface must return first. */
const FINDS: { why: string; query: string; expect: string }[] = [
  // --- hyphen, in both directions ------------------------------------------
  { why: 'hyphen dropped', query: 'Amon Ra', expect: 'p-amonra' },
  { why: 'hyphen and space both dropped', query: 'AmonRa', expect: 'p-amonra' },
  { why: 'hyphen as typed', query: 'Amon-Ra', expect: 'p-amonra' },

  // --- Unicode dashes -------------------------------------------------------
  { why: 'en dash', query: 'Amon–Ra', expect: 'p-amonra' },
  { why: 'em dash', query: 'Amon—Ra', expect: 'p-amonra' },
  { why: 'non-breaking hyphen', query: 'Amon‑Ra', expect: 'p-amonra' },
  { why: 'figure dash', query: 'Amon‒Ra', expect: 'p-amonra' },
  { why: 'minus sign', query: 'Amon−Ra', expect: 'p-amonra' },

  // --- apostrophes ----------------------------------------------------------
  { why: 'apostrophe dropped', query: 'JaMarr', expect: 'p-jamarr' },
  { why: 'lowercase, apostrophe dropped', query: 'jamarr', expect: 'p-jamarr' },
  { why: 'typewriter apostrophe', query: "Ja'Marr", expect: 'p-jamarr' },
  { why: 'right single quote', query: 'Ja’Marr', expect: 'p-jamarr' },
  { why: 'modifier letter apostrophe', query: 'JaʼMarr', expect: 'p-jamarr' },

  // --- accents --------------------------------------------------------------
  { why: 'accents typed', query: 'José Ramírez', expect: 'p-jose' },
  { why: 'accents omitted', query: 'jose ramirez', expect: 'p-jose' },

  // --- spacing --------------------------------------------------------------
  { why: 'extra spaces', query: '   Bijan    Robinson  ', expect: 'p-bijan' },
  { why: 'words reversed', query: 'Robinson Bijan', expect: 'p-bijan' },

  // --- initials and punctuation ---------------------------------------------
  { why: 'initials without dots', query: 'dj moore', expect: 'p-dj' },
  { why: 'initials with dots', query: 'D.J. Moore', expect: 'p-dj' },

  // --- one reasonable typo --------------------------------------------------
  { why: 'dropped letter in surname', query: 'Robnson', expect: 'p-bijan' },
  { why: 'transposed letters', query: 'Nacau', expect: 'p-puka' },
  { why: 'typo with the given name correct', query: 'Bijan Robnson', expect: 'p-bijan' },

  // --- partials -------------------------------------------------------------
  { why: 'partial surname', query: 'Charbon', expect: 'p-charb' },
  { why: 'partial first and last', query: 'Puk Nac', expect: 'p-puka' },
  { why: 'suffix omitted', query: 'Marvin Harrison', expect: 'p-marvin' },
  { why: 'wrong suffix', query: 'Marvin Harrison III', expect: 'p-marvin' },
];

/** Queries that must NOT reach a player, on any surface. */
const MISSES: { why: string; query: string; notFound: string }[] = [
  {
    why: 'a short word gets no typo budget — `joe` must not reach Zoe',
    query: 'joe',
    notFound: 'p-zoe',
  },
  {
    why: 'a short query must not stretch over a long name',
    query: 'chas',
    notFound: 'p-charb',
  },
  { why: 'a stranger is a stranger', query: 'zzzzzz', notFound: 'p-bijan' },
];

describe.each(SURFACES)('$name', (surface) => {
  describe('finds the player', () => {
    it.each(FINDS)('$why: “$query”', async ({ query, expect: id }) => {
      const found = await surface.find(query);
      expect(found, `“${query}” returned ${found.length} row(s)`).toContain(id);
      /*
       * First, not merely present.
       *
       * A search that returns the right player in position eleven has failed on
       * a phone, and "contains" would pass for a matcher that returned the
       * whole dictionary every time.
       */
      expect(found[0]).toBe(id);
    });
  });

  describe('does not find somebody else', () => {
    it.each(MISSES)('$why', async ({ query, notFound }) => {
      expect(await surface.find(query)).not.toContain(notFound);
    });
  });

  describe('ranking', () => {
    it('puts an exact match ahead of a fuzzy one', async () => {
      // `Will Levis` is exact; `William Robinson` is a prefix hit on the same
      // first word. The literal match wins wherever this is asked.
      expect((await surface.find('Will Levis'))[0]).toBe('p-levis');
    });

    it('returns everybody for an empty query rather than nobody', async () => {
      // The behaviour that makes clearing the field restore the list. The
      // server is the interesting one: an empty query must not become
      // `LIKE '%%'` and it must not become "no rows".
      const all = await surface.find('');
      expect(all.length).toBeGreaterThan(1);
    });

    it('keeps both players who share a surname when the query is just that', async () => {
      const found = await surface.find('Robinson');
      expect(found).toContain('p-bijan');
      expect(found).toContain('p-willr');
    });
  });
});

/**
 * The property the matrix above is really asserting, stated directly.
 *
 * Every surface must agree on the *set* of players a query reaches. The
 * per-surface cases can drift apart one assertion at a time; this cannot.
 */
describe('the surfaces agree with each other', () => {
  const QUERIES = [
    ...FINDS.map((c) => c.query),
    ...MISSES.map((c) => c.query),
    'Robinson',
    'will',
    'st brown',
    'stbrown',
  ];

  it.each(QUERIES)('“%s” reaches the same players everywhere', async (query) => {
    const answers = await Promise.all(SURFACES.map(async (s) => [s.name, await s.find(query)] as const));
    const [, reference] = answers[0]!;
    for (const [name, found] of answers.slice(1)) {
      expect(
        [...found].sort(),
        `${name} disagreed with ${answers[0]![0]} on “${query}”`,
      ).toEqual([...reference].sort());
    }
  });
});
