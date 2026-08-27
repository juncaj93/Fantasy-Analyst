/**
 * Replacing every aliased identity that reached a *sentence* or a *key*.
 *
 * Aliasing the inputs is the easy half. The half that has already caught this
 * app twice is the output: an engine composes an identity into a string, the
 * capture copies the output verbatim, and the file is a redaction that removed
 * nothing. The Draft lane found it in `nextPickModel.managerHistory`, which
 * writes `slot 4 (juncaj93): RB demand x1.2` into a reason. The Matchup lane
 * found it again in `MatchupForecast.fingerprint`, which hashes the league id
 * into the string that seeds the simulation — so a snapshot that aliased the
 * league and copied the forecast carried the real id in the one field nobody
 * would think to look at.
 *
 * It has a second job, which is why it walks keys as well as values: two of the
 * in-season payloads are keyed by identity — a manager's trade tendencies, a
 * roster's transaction profile — and a map whose *keys* are Sleeper user ids is
 * the same leak one level down.
 *
 * It replaces **identifiers only** — user ids, league and draft ids, and the
 * league's own name. Display names are not scrubbed and must not be: a manager
 * called `You` turns `You are sending Ike Sandoval` into `Manager 9 are sending
 * Ike Sandoval`, and no boundary rule fixes that, because the collision is the
 * word itself. The in-season adapters alias the rosters *before* the assembly
 * runs instead, so the engine composes `Manager 3` into its sentences in the
 * first place and there is nothing left here to replace.
 *
 * Run **after** every alias has been allocated, so it can only ever replace and
 * never invent one. A string containing no identity comes back unchanged, which
 * is almost every string in the file.
 */

import type { SnapshotAliases } from './redaction.ts';

/**
 * Replace every aliased identity anywhere in a finished value.
 *
 * A deep copy with `SnapshotAliases.scrub` applied to every string, which is the
 * one operation that can reach an identity composed into a *sentence*. It only
 * replaces — the allocator has already handed out every alias by the time this
 * runs — so it can never invent one, and a string containing no identity is
 * returned unchanged.
 */
export function scrubAliases(value: unknown, aliases: SnapshotAliases): unknown {
  const replace = (text: string): string => aliases.scrubIdentifiers(text);
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return replace(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node == null || typeof node !== 'object') return node;
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>).map(([key, child]) => [replace(key), walk(child)]),
    );
  };
  return walk(value);
}
