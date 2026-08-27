/**
 * Composing an engine version out of the engines it stands on.
 *
 * `draft/version.ts` explains what an engine version is for and when to bump
 * one: a support snapshot captured on one deployment and replayed against a
 * working copy that has moved on needs to know whether the *reasoning* changed,
 * because a replay that disagrees for that reason is Tuesday and a replay that
 * disagrees for any other reason is a bug.
 *
 * Draft could carry a single hand-written string because it is one engine. The
 * in-season surfaces cannot. Every one of them is built on the start/sit engine
 * — the lineup optimiser ranks with it, the waiver scan scores the wire with
 * it, the defence planner projects with it, and a trade is priced by running it
 * over both rosters — so a calibration change in `startsit/` moves five answers
 * and would have to be remembered in five places.
 *
 * It would be remembered in four. So a surface names its own version and the
 * versions it is built on, and this composes them:
 *
 * ```ts
 * export const WAIVER_ENGINE_VERSION = composeEngineVersion('waiver@1', LINEUP_ENGINE_VERSION, DST_ENGINE_VERSION);
 * // 'waiver@1+dst@1+lineup@1+startsit@1'
 * ```
 *
 * Bumping `startsit@1` to `startsit@2` moves all five strings, and every
 * snapshot captured before it replays as `engine_version_mismatch` rather than
 * as a regression — which is exactly what happened, and exactly what a reader
 * needs to be told.
 *
 * The dependencies are sorted and de-duplicated so the string is a function of
 * the *set* of engines rather than of the order somebody listed them in. Two
 * surfaces that stand on the same engines through different paths — waivers
 * reaches start/sit through both the lineup and the defence planner — must not
 * produce two different strings for one state of the code.
 */

/**
 * `head`, then every distinct part of every dependency, sorted.
 *
 * The head is not sorted into the rest: it is what this engine *is*, and a
 * reader scanning `engine_version_mismatch` output should see the surface's own
 * name first rather than hunting for it inside an alphabetised list.
 */
export function composeEngineVersion(head: string, ...dependencies: string[]): string {
  const parts = new Set<string>();
  for (const dependency of dependencies) {
    for (const part of dependency.split('+')) {
      if (part !== '' && part !== head) parts.add(part);
    }
  }
  return [head, ...[...parts].sort()].join('+');
}
