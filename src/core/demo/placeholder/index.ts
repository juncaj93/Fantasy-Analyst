/**
 * Demo Mode, as it now ships: one placeholder scenario.
 *
 * Demo Mode used to be a full rehearsal of every screen — twenty-odd scenarios,
 * each answered by the production engines over a fixture world, draft board
 * included. That cost ~164KB gzipped of engine code in `demo-*.js` and meant
 * every new screen owed the demo a matching handler. The requirement changed
 * (24 September 2026): Demo Mode only has to show *something* representative
 * of the app, and give a future round a cheap place to demo one new feature.
 *
 * So what ships is one in-season Sunday, answered from responses captured from
 * the old demo (`responses.json`), with no engine behind it. The screens are
 * still the real screens and the seam is still `request()` in `web/api.ts`;
 * only the data behind it is now a snapshot rather than a computation.
 *
 * **To demo a new feature**, add its route to `FEATURE_ROUTES` in
 * `runtime.ts`: a path and a function that answers it. Nothing else has to
 * change — the picker, the indicator, the read-only guard and the server's
 * write refusal all already apply to it. If the feature needs its own moment
 * in the season, add a second entry here and key the route on `scenario.id`.
 *
 * The old engine-driven scenarios (`../registry.ts`, `../runtime/`,
 * `../fixtures/`) still exist, but only as the fixture harness the support
 * snapshot tests and `npm run support:fixture` run against. Nothing in the
 * browser can reach them.
 */

export interface DemoShowcase {
  id: string;
  /** What the picker and the indicator call it. */
  label: string;
  description: string;
  /** The moment the captured responses describe, as an ISO instant. */
  asOf: string;
}

export const DEMO_SHOWCASES: DemoShowcase[] = [
  {
    id: 'in-season',
    label: 'Sunday, 11:40am',
    description:
      'Week 6 of a twelve-team half-PPR league, an hour before the early kickoffs. Team, Waivers, Matchup, Players and Settings show a sample roster. Draft and Trades are not part of the demo.',
    asOf: '2026-10-11T15:40:00.000Z',
  },
];

export const DEFAULT_SHOWCASE_ID = 'in-season';

export function findShowcase(id: string | null | undefined): DemoShowcase | null {
  if (!id) return null;
  return DEMO_SHOWCASES.find((s) => s.id === id) ?? null;
}
