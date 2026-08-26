/**
 * The six words a replay can end on, and the order they are checked in.
 *
 * An agent triaging a report branches on the outcome, so a wrong word costs
 * more than a wrong number: it sends somebody to the ranking code for a problem
 * that is not there, or lets a real regression read as Tuesday's calibration
 * commit. The precedence is the whole design and it is deliberate —
 *
 *   schema_unsupported → data_mismatch → engine_version_mismatch
 *   → freshness_difference → output_difference → reproduced
 *
 * — because each earlier word *explains* every later one. A file this build
 * cannot read is not a malformed file. A malformed file is not an output
 * difference. And a difference on a moved engine version is expected, so
 * reporting it as an output difference would make a legitimate weight change
 * indistinguishable from a bug.
 *
 * Every case here is built by taking a snapshot that genuinely reproduces and
 * changing exactly one thing about it, so the word under test is the only
 * variable.
 */

import { describe, expect, it } from 'vitest';
import { buildDraftScenario } from '../src/core/demo/fixtures/draft.ts';
import { draftBoardSourcesFrom } from '../src/core/demo/runtime/sources.ts';
import { findScenario } from '../src/core/demo/registry.ts';
import { captureDraftSnapshot } from '../src/core/support/draftSnapshot.ts';
import { readSnapshot, replayDraftSnapshot, SnapshotRejected } from '../src/core/support/replay.ts';
import { DRAFT_ENGINE_VERSION } from '../src/core/draft/version.ts';
import type { DraftBoardPayload, SupportSnapshot } from '../src/core/support/schema.ts';

async function goodSnapshot(): Promise<SupportSnapshot<DraftBoardPayload>> {
  const data = buildDraftScenario(findScenario('draft-mid')!);
  const snapshot = await captureDraftSnapshot(draftBoardSourcesFrom(data), {
    draftId: data.draft!.id,
    gitSha: 'abcdef0',
  });
  return JSON.parse(JSON.stringify(snapshot)) as SupportSnapshot<DraftBoardPayload>;
}

/** Deep-clone, mutate, re-read. Every case starts from a snapshot that works. */
async function mutated(change: (s: SupportSnapshot<DraftBoardPayload>) => void) {
  const snapshot = await goodSnapshot();
  change(snapshot);
  return snapshot;
}

describe('a file this build cannot read is refused, not diagnosed', () => {
  it('rejects an unknown schema as schema_unsupported, not as malformed', async () => {
    const snapshot = await mutated((s) => {
      (s as { schema: string }).schema = 'junculator/support-snapshot@2';
    });
    try {
      readSnapshot(snapshot);
      expect.unreachable('an unknown schema must be refused');
    } catch (err) {
      expect(err).toBeInstanceOf(SnapshotRejected);
      expect((err as SnapshotRejected).outcome).toBe('schema_unsupported');
    }
  });

  it('rejects a decision kind it cannot replay as schema_unsupported', async () => {
    const snapshot = await mutated((s) => {
      (s.decision as { kind: string }).kind = 'waiver-plan';
    });
    try {
      readSnapshot(snapshot);
      expect.unreachable('an unimplemented kind must be refused');
    } catch (err) {
      expect((err as SnapshotRejected).outcome).toBe('schema_unsupported');
      expect((err as Error).message).toContain('waiver-plan');
    }
  });

  it('rejects a missing section as data_mismatch', async () => {
    const snapshot = await mutated((s) => {
      delete (s.decision as Partial<DraftBoardPayload>).inputs;
    });
    expect(() => readSnapshot(snapshot)).toThrow(/inputs is missing/);
  });

  it('rejects a clock it cannot pin to as data_mismatch', async () => {
    const snapshot = await mutated((s) => {
      (s as { capturedAt: string }).capturedAt = 'last Tuesday';
    });
    try {
      readSnapshot(snapshot);
      expect.unreachable('an unparseable clock must be refused');
    } catch (err) {
      expect((err as SnapshotRejected).outcome).toBe('data_mismatch');
      expect((err as Error).message).toContain('clock cannot be fixed');
    }
  });

  it('rejects an empty player table rather than replaying an empty board', async () => {
    const snapshot = await mutated((s) => {
      s.decision.inputs.players = [];
    });
    expect(() => readSnapshot(snapshot)).toThrow(/no board to rebuild/);
  });
});

describe('a difference is attributed to the thing that explains it', () => {
  it('reports a moved engine version ahead of the difference it caused', async () => {
    const snapshot = await mutated((s) => {
      s.release.engineVersion = 'draft-engine@0';
      // A real difference as well, so the precedence is doing the work rather
      // than the absence of one.
      s.decision.output.rows[0]!.total += 1;
    });
    const report = await replayDraftSnapshot(readSnapshot(snapshot));

    expect(report.outcome).toBe('engine_version_mismatch');
    expect(report.engine).toEqual({ captured: 'draft-engine@0', current: DRAFT_ENGINE_VERSION, matches: false });
    // The differences are still reported in full — the word explains them, it
    // does not excuse looking at them.
    expect(report.differences.length).toBeGreaterThan(0);
    expect(report.summary).toContain('draft-engine@0');
  });

  it('calls it a freshness difference when only the market’s age moved', async () => {
    const snapshot = await mutated((s) => {
      s.decision.freshness.dog.ageHours = (s.decision.freshness.dog.ageHours ?? 0) + 99;
    });
    const report = await replayDraftSnapshot(readSnapshot(snapshot));

    /*
     * A board whose *only* disagreements are about how old the market is has a
     * specific, checkable cause — a clock that did not get pinned — and calling
     * that an output difference sends the reader to the ranking code for a
     * problem that is not in it.
     */
    expect(report.outcome).toBe('freshness_difference');
    expect(report.differences.every((d) => d.term.startsWith('freshness.'))).toBe(true);
    expect(report.summary).toContain(snapshot.capturedAt);
  });

  it('calls a reordered board an output difference, and names the first one', async () => {
    const snapshot = await mutated((s) => {
      const order = s.decision.output.order;
      [order[0], order[1]] = [order[1]!, order[0]!];
    });
    const report = await replayDraftSnapshot(readSnapshot(snapshot));

    expect(report.outcome).toBe('output_difference');
    expect(report.differences[0]!.term).toBe('order');
    expect(report.differences[0]!.at).toBe('rank 1');
    expect(report.summary).toContain('order at rank 1');
  });

  it('notices a component that changed by the smallest amount it can express', async () => {
    const snapshot = await mutated((s) => {
      const component = s.decision.output.rows[0]!.components.find((c) => c.key === 'my_guy')!;
      component.contribution = 0.001;
    });
    const report = await replayDraftSnapshot(readSnapshot(snapshot));

    /*
     * No tolerance, anywhere. A thousandth is the smallest number the engine
     * rounds to, and a comparison that forgave it would be a comparison with a
     * place for real drift to hide.
     */
    expect(report.outcome).toBe('output_difference');
    expect(report.differences.some((d) => d.term === 'component.my_guy.contribution')).toBe(true);
  });

  it('notices a reason sentence that changed one word', async () => {
    const snapshot = await mutated((s) => {
      const row = s.decision.output.rows.find((r) => r.reasons.length > 0)!;
      row.reasons[0] = row.reasons[0]!.replace(/\ba\b/, 'the');
    });
    const report = await replayDraftSnapshot(readSnapshot(snapshot));

    expect(report.outcome).toBe('output_difference');
    expect(report.differences.some((d) => d.term.startsWith('reasons ·'))).toBe(true);
  });

  it('stops listing reordered ranks after ten, and says that it did', async () => {
    const snapshot = await mutated((s) => {
      // Reverse the whole board: every rank disagrees, which is the case that
      // would otherwise print three hundred lines saying one thing.
      s.decision.output.order.reverse();
    });
    const report = await replayDraftSnapshot(readSnapshot(snapshot));

    const order = report.differences.filter((d) => d.term === 'order');
    expect(order.length).toBeLessThanOrEqual(11);
    expect(order[order.length - 1]!.at).toBe('further ranks');
  });
});

describe('reproduced means every term held', () => {
  it('says so, with the size of what it compared', async () => {
    const report = await replayDraftSnapshot(readSnapshot(await goodSnapshot()));

    expect(report.outcome).toBe('reproduced');
    expect(report.differences).toEqual([]);
    expect(report.compared.order).toBe(report.board!.recommendations.length);
    expect(report.compared.detailRows).toBeGreaterThan(0);
    expect(report.summary).toMatch(/^Reproduced: \d+ ranked players/);
  });
});
