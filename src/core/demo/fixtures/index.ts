/**
 * Fixtures, fetched only when a scenario is actually chosen.
 *
 * §17 asks that the fixtures not ride in the initial production bundle, and a
 * dynamic import is how that is enforced rather than intended: the bundler can
 * see that nothing reaches these modules except through the `import()` below,
 * so it emits them as separate chunks and a reader who never opens Demo Mode
 * never downloads one.
 *
 * The registry is the other half of that. It carries every scenario's name,
 * description and lifecycle — everything the picker needs — and no data, so the
 * list is complete before a single byte of fixture has been fetched.
 */

import type { DemoBundleId, DemoScenario } from '../types.ts';
import type { ScenarioData } from './build.ts';

export type { ScenarioData } from './build.ts';

const LOADERS: Record<DemoBundleId, () => Promise<(scenario: DemoScenario) => ScenarioData>> = {
  draft: async () => (await import('./draft.ts')).buildDraftScenario,
  season: async () => (await import('./season.ts')).buildSeasonScenario,
  degraded: async () => (await import('./degraded.ts')).buildDegradedScenario,
};

/**
 * Built once per scenario and kept.
 *
 * Stepping back and forth through a progression must show the same board both
 * times, and rebuilding would be both slower and — if anything in the chain
 * ever stopped being pure — a way for the two visits to differ. The cache is
 * cleared on exit along with everything else.
 */
const built = new Map<string, ScenarioData>();

export async function loadScenarioData(scenario: DemoScenario): Promise<ScenarioData> {
  const cached = built.get(scenario.id);
  if (cached) return cached;
  const build = await LOADERS[scenario.bundle]();
  const data = build(scenario);
  built.set(scenario.id, data);
  return data;
}

/** Forget everything. Called when Demo Mode is left. */
export function clearScenarioCache(): void {
  built.clear();
}
