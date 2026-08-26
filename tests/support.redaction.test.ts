/**
 * What must never leave the phone in a support snapshot.
 *
 * A snapshot is built to be sent somewhere — pasted into a chat window,
 * attached to a message, committed as a fixture — which makes it a completely
 * different object from a log line. The rules are written down in
 * `core/support/redaction.ts`; this is where they stop being a comment.
 *
 * Two halves, and both matter. The first proves that a capture of a league full
 * of real-looking identities emits none of them, while still producing a board
 * that replays exactly — because a redaction that broke the slot → roster →
 * owner chain would be safe and useless. The second proves the scanner refuses
 * the shapes it is meant to refuse, at capture *and* at replay, since the copy
 * being replayed is not necessarily the copy that was emitted.
 */

import { describe, expect, it } from 'vitest';
import { buildDraftScenario } from '../src/core/demo/fixtures/draft.ts';
import { draftBoardSourcesFrom } from '../src/core/demo/runtime/sources.ts';
import { findScenario } from '../src/core/demo/registry.ts';
import { captureDraftSnapshot, SnapshotRedactionError } from '../src/core/support/draftSnapshot.ts';
import { readSnapshot, replayDraftSnapshot, SnapshotRejected } from '../src/core/support/replay.ts';
import { ManagerAliases, findRedactionViolations } from '../src/core/support/redaction.ts';
import type { DraftBoardSources } from '../src/core/draft/boardBuilder.ts';

/**
 * A league whose managers look like real Sleeper managers.
 *
 * Sleeper user ids are long numeric strings and display names are whatever
 * somebody typed, so the fixture's tidy `owner-3` / `Alex` pair would let a
 * redaction bug pass unnoticed — `owner-3` looks enough like an alias that a
 * test searching the file for it proves nothing. These are the shapes the real
 * thing has.
 */
const MANAGERS = [
  { id: '467803924117221376', name: 'juncaj93' },
  { id: '331590301295116288', name: 'Dave (commish)' },
  { id: '862224113355821056', name: 'TheRealMikeT' },
];

async function realisticSources(): Promise<{ sources: DraftBoardSources; draftId: string }> {
  const scenario = findScenario('draft-mid')!;
  const data = buildDraftScenario(scenario);
  const inner = draftBoardSourcesFrom(data);
  const rosters = await inner.leagues.listRosters(data.league.id);

  /*
   * The first three seats get real-looking identities; the rest keep the
   * fixture's own. A league where every manager was rewritten would not
   * exercise the case that actually happens, which is a mixture.
   */
  const rewritten = rosters.map((roster, i) => {
    const manager = MANAGERS[i];
    return manager ? { ...roster, ownerId: manager.id, ownerName: manager.name } : roster;
  });

  return {
    draftId: data.draft!.id,
    sources: {
      ...inner,
      leagues: { ...inner.leagues, listRosters: async () => rewritten },
    },
  };
}

describe('a snapshot carries no identity a person could be found by', () => {
  it('emits no Sleeper user id and no display name from the league it captured', async () => {
    const { sources, draftId } = await realisticSources();
    const snapshot = await captureDraftSnapshot(sources, { draftId, gitSha: 'deadbeef' });
    const text = JSON.stringify(snapshot);

    for (const manager of MANAGERS) {
      expect(text, `user id ${manager.id} must not survive capture`).not.toContain(manager.id);
      expect(text, `display name ${manager.name} must not survive capture`).not.toContain(manager.name);
    }
  });

  it('replaces them consistently, so the board still resolves who owns which seat', async () => {
    const { sources, draftId } = await realisticSources();
    const snapshot = await captureDraftSnapshot(sources, { draftId, gitSha: 'deadbeef' });
    const rosters = snapshot.decision.inputs.rosters;

    // Aliases, and the same alias each time the same person appears.
    for (const roster of rosters.slice(0, MANAGERS.length)) {
      expect(roster.ownerId).toMatch(/^manager-\d+$/);
      expect(roster.ownerName).toMatch(/^Manager \d+$/);
      expect(roster.ownerName!.split(' ')[1]).toBe(roster.ownerId!.split('-')[1]);
    }
    // Distinct people stay distinct — a redaction that collapsed them would
    // hand every seat to one manager and quietly change the board.
    const ids = new Set(rosters.map((r) => r.ownerId).filter(Boolean));
    expect(ids.size).toBe(new Set(rosters.map((r) => r.rosterId)).size);

    // And exactly one of them is still the user's own, which is what roster
    // need, the live roster and every "your pick" number depend on.
    expect(rosters.filter((r) => r.isMine)).toHaveLength(1);
  });

  it('still replays to the same board after everything has been renamed', async () => {
    const { sources, draftId } = await realisticSources();
    const snapshot = await captureDraftSnapshot(sources, { draftId, gitSha: 'deadbeef' });
    const report = await replayDraftSnapshot(readSnapshot(JSON.parse(JSON.stringify(snapshot))));
    expect(report.differences).toEqual([]);
    expect(report.outcome).toBe('reproduced');
  });

  it('reduces the raw Sleeper pick payload to the four fields the board reads', async () => {
    const { sources, draftId } = await realisticSources();
    const snapshot = await captureDraftSnapshot(sources, { draftId, gitSha: 'deadbeef' });

    for (const pick of snapshot.decision.inputs.picks) {
      if (pick.raw === '') continue;
      const parsed = JSON.parse(pick.raw) as Record<string, unknown>;
      expect(Object.keys(parsed)).toEqual(['metadata']);
      const meta = parsed['metadata'] as Record<string, unknown>;
      for (const key of Object.keys(meta)) {
        expect(['first_name', 'last_name', 'position', 'team']).toContain(key);
      }
    }
  });

  it('says what it redacted, without saying what it redacted it from', async () => {
    const { sources, draftId } = await realisticSources();
    const snapshot = await captureDraftSnapshot(sources, { draftId, gitSha: 'deadbeef' });

    expect(snapshot.redaction.replaced['manager id']).toBeGreaterThan(0);
    expect(snapshot.redaction.rules.length).toBeGreaterThan(0);
    /*
     * Counts, never a mapping.
     *
     * A file that listed `{"manager-3": "467803924117221376"}` would be a
     * redacted snapshot with the identities put back in an appendix, which is
     * worse than not redacting at all — because it looks safe.
     */
    expect(JSON.stringify(snapshot.redaction)).not.toContain(MANAGERS[0]!.id);
    expect(JSON.stringify(snapshot.redaction)).not.toContain(MANAGERS[0]!.name);
  });
});

describe('the scanner refuses what must not be in one', () => {
  const FORBIDDEN: { what: string; graft: (into: Record<string, unknown>) => void }[] = [
    { what: 'a provider API key', graft: (o) => ((o['apiKey'] as unknown) = 'sgo_live_1234567890') },
    { what: 'a session cookie', graft: (o) => ((o['cookie'] as unknown) = 'fa_session=abc; Path=/') },
    { what: 'a request header block', graft: (o) => ((o['headers'] as unknown) = { accept: 'application/json' }) },
    { what: 'the app passphrase', graft: (o) => ((o['passphrase'] as unknown) = 'devpass') },
    { what: 'a newsletter excerpt', graft: (o) => ((o['excerpt'] as unknown) = 'Beat writers love him.') },
    { what: 'an email address', graft: (o) => ((o['note'] as unknown) = 'ask fantasy-news@example.com') },
    { what: 'a bearer token', graft: (o) => ((o['note'] as unknown) = 'Authorization: Bearer eyJhbGciOi') },
  ];

  for (const { what, graft } of FORBIDDEN) {
    it(`finds ${what}, however deep it is buried`, () => {
      const value = { decision: { inputs: { league: { leagueSettings: {} as Record<string, unknown> } } } };
      graft(value.decision.inputs.league.leagueSettings);
      const violations = findRedactionViolations(value);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.path).toContain('decision.inputs.league.leagueSettings');
    });
  }

  it('refuses to emit a capture whose league settings carry one', async () => {
    const scenario = findScenario('draft-mid')!;
    const data = buildDraftScenario(scenario);
    const inner = draftBoardSourcesFrom(data);
    const poisoned: DraftBoardSources = {
      ...inner,
      leagues: {
        ...inner.leagues,
        getLeague: async (id) => {
          const league = await inner.leagues.getLeague(id);
          return league && { ...league, leagueSettings: { ...league.leagueSettings, apiKey: 'sgo_live_9' } };
        },
      },
    };

    await expect(captureDraftSnapshot(poisoned, { draftId: data.draft!.id, gitSha: 'x' })).rejects.toBeInstanceOf(
      SnapshotRedactionError,
    );
  });

  it('refuses to replay a snapshot that acquired one after it was written', async () => {
    const { sources, draftId } = await realisticSources();
    const snapshot = JSON.parse(
      JSON.stringify(await captureDraftSnapshot(sources, { draftId, gitSha: 'deadbeef' })),
    ) as Record<string, unknown>;

    // Somebody pasted a token into the file between capture and replay.
    ((snapshot['decision'] as Record<string, unknown>)['inputs'] as Record<string, unknown>)['authorization'] =
      'Bearer eyJhbGciOiJIUzI1NiJ9';

    expect(() => readSnapshot(snapshot)).toThrow(SnapshotRejected);
    try {
      readSnapshot(snapshot);
    } catch (err) {
      expect((err as SnapshotRejected).outcome).toBe('data_mismatch');
    }
  });

  it('does not fire on the ordinary contents of a real snapshot', async () => {
    const { sources, draftId } = await realisticSources();
    const snapshot = await captureDraftSnapshot(sources, { draftId, gitSha: 'deadbeef' });
    /*
     * The check that keeps the check honest.
     *
     * A scanner broad enough to fire on player ids, hashes and reason
     * sentences is a scanner somebody switches off. This asserts it stays
     * quiet on several hundred kilobytes of genuine board data.
     */
    expect(findRedactionViolations(snapshot)).toEqual([]);
  });
});

describe('aliases are stable and one-way', () => {
  it('gives the same person the same name every time, and different people different ones', () => {
    const aliases = new ManagerAliases();
    expect(aliases.id('467803924117221376')).toBe('manager-1');
    expect(aliases.id('331590301295116288')).toBe('manager-2');
    expect(aliases.id('467803924117221376')).toBe('manager-1');
    expect(aliases.name('juncaj93', '467803924117221376')).toBe('Manager 1');
    expect(aliases.name('Dave (commish)', '331590301295116288')).toBe('Manager 2');
  });

  it('leaves an unowned roster unowned rather than inventing a manager for it', () => {
    const aliases = new ManagerAliases();
    expect(aliases.id(null)).toBeNull();
    expect(aliases.id('')).toBeNull();
    expect(aliases.name(null)).toBeNull();
  });

  it('scrubs an identity that reached a free-text note', () => {
    const aliases = new ManagerAliases();
    aliases.id('467803924117221376');
    aliases.name('juncaj93', '467803924117221376');
    expect(aliases.scrub('juncaj93 takes backs early (467803924117221376)')).toBe(
      'Manager 1 takes backs early (manager-1)',
    );
  });
});
