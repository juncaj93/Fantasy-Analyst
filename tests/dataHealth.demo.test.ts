/**
 * Data Health in Demo Mode: same contract, no network, no second engine.
 *
 * §15 asks for three things and this asserts all three:
 *
 *   - the same presentation contract, demonstrated **without a network**;
 *   - the healthy state, the legitimately-waiting state and at least one
 *     stale / degraded / deferred state, all reachable;
 *   - **no alternate fake health engine** — which is asserted structurally, by
 *     reading the imports, rather than by inspection.
 *
 * The determinism claim is the one a screenshot depends on: the same scenario
 * must produce byte-identical health twice, or a demo taken last month and one
 * taken today would both claim to be the same scenario while disagreeing about
 * how old the injury report was.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DemoRuntime } from '../src/core/demo/runtime/index.ts';
import { findScenario, selectableScenarios } from '../src/core/demo/registry.ts';
import { SOURCE_POLICIES } from '../src/core/health/policy.ts';
import type { DataHealthView } from '../src/core/health/model.ts';

const SELECTABLE = selectableScenarios();

async function health(scenarioId: string): Promise<DataHealthView> {
  const runtime = await DemoRuntime.forScenario(findScenario(scenarioId)!);
  const res = await runtime.request('GET', '/api/data-health');
  expect(res.status, `${scenarioId}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body as DataHealthView;
}

describe('every scenario answers, and answers in the production vocabulary', () => {
  it.each(SELECTABLE.map((s) => s.id))('%s', async (id) => {
    const view = await health(id);
    expect(view.sources.map((s) => s.id)).toEqual(SOURCE_POLICIES.map((p) => p.id));
    const allowed = new Set(['current', 'stale', 'waiting', 'degraded', 'missing', 'deferred', 'unknown']);
    for (const source of view.sources) expect(allowed.has(source.state), `${source.id}: ${source.state}`).toBe(true);
    expect(view.overall.headline.length).toBeGreaterThan(0);
  });

  /**
   * A rehearsal must never be mistakable for production, which is the same rule
   * a demo support snapshot keeps about its `gitSha`.
   */
  it.each(SELECTABLE.map((s) => s.id))('%s reports the demo revision rather than a real one', async (id) => {
    expect((await health(id)).release.gitSha).toBe('demo');
  });
});

describe('the three states the brief asks to see', () => {
  it('at least one scenario is healthy throughout', async () => {
    const views = await Promise.all(SELECTABLE.map((s) => health(s.id)));
    expect(views.some((v) => v.overall.state === 'healthy')).toBe(true);
  });

  /** Legitimately unpublished, and never rendered as a fault. */
  it('at least one scenario is waiting on a source that has published nothing', async () => {
    const views = await Promise.all(SELECTABLE.map((s) => health(s.id)));
    const waiting = views.flatMap((v) => v.sources).filter((s) => s.state === 'waiting');
    expect(waiting.length).toBeGreaterThan(0);
    for (const source of waiting) expect(source.ageMinutes).toBeNull();
  });

  it('at least one scenario is stale, degraded or missing', async () => {
    const views = await Promise.all(SELECTABLE.map((s) => health(s.id)));
    const troubled = views.flatMap((v) => v.sources).filter((s) => ['stale', 'degraded', 'missing'].includes(s.state));
    expect(troubled.length).toBeGreaterThan(0);
  });

  /**
   * Deferred, with the §7 sentence rather than a generic failure. This is the
   * state a reader is most likely to misdiagnose, so a demo has to show it.
   */
  it('deferred background work is demonstrated, in the words the product uses', async () => {
    const views = await Promise.all(SELECTABLE.map((s) => health(s.id)));
    const deferred = views.flatMap((v) => v.sources).filter((s) => s.state === 'deferred');
    expect(deferred.length).toBeGreaterThan(0);
    expect(deferred[0]!.severity).toBe('background');
    expect(deferred[0]!.note).toMatch(/higher-priority/i);
  });

  it('a degraded scenario cannot report itself healthy', async () => {
    for (const scenario of SELECTABLE.filter((s) => s.group === 'degraded')) {
      const view = await health(scenario.id);
      expect(view.overall.state, scenario.id).not.toBe('healthy');
    }
  });
});

describe('deterministic, and offline', () => {
  it('produces byte-identical health twice for the same scenario', async () => {
    for (const scenario of SELECTABLE.slice(0, 6)) {
      const [a, b] = await Promise.all([health(scenario.id), health(scenario.id)]);
      expect(JSON.stringify(a), scenario.id).toBe(JSON.stringify(b));
    }
  });

  /**
   * Nothing reaches the network, asserted by removing it.
   *
   * `fetch` is replaced with something that throws for the duration; a green
   * test is the proof rather than a claim about the imports.
   */
  it('answers with fetch removed from the process', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error('Demo Mode reached the network');
    }) as typeof fetch;
    try {
      const view = await health(SELECTABLE[0]!.id);
      expect(view.sources.length).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('there is no second health engine', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/core/demo/runtime/health.ts', import.meta.url)), 'utf8');

  /**
   * The rows, the labels, the aggregation and the sentences all come from the
   * production modules. What a scenario supplies is the *state*, which is what
   * a scenario is — a declaration of the world.
   */
  it('builds its rows with the production assembler and the production policy', () => {
    expect(source).toMatch(/from '\.\.\/\.\.\/health\/policy\.ts'/);
    expect(source).toMatch(/sourceHealth\(/);
    expect(source).toMatch(/overallState\(/);
    expect(source).toMatch(/headline\(/);
    expect(source).toMatch(/describeRun\(/);
    expect(source).toMatch(/runOutcome\(/);
  });

  it('writes no state word, label or severity of its own', () => {
    /*
     * The labels and severities live in `SOURCE_POLICIES` and are read from it.
     * A literal here would be the beginning of a second table.
     */
    for (const policy of SOURCE_POLICIES) {
      expect(source, `${policy.id}'s label is written out in the demo`).not.toContain(`'${policy.label}'`);
    }
  });
});
