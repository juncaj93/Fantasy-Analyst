/**
 * The five in-season contexts, as something a request can be validated against.
 *
 * Draft is not one of them, and that is not an oversight: a draft snapshot is
 * keyed by a draft rather than by a league and has its own route, shipped and
 * unchanged. The five here are the leagues' own decisions.
 *
 * Derived from `IMPLEMENTED_KINDS` rather than written out a second time, so a
 * seventh decision cannot become capturable without becoming requestable — the
 * mismatch would be a support button that names a context the server refuses,
 * which is the one failure this row must not have.
 *
 * In `core` rather than beside the route because Demo Mode serves the same
 * endpoint and must accept exactly the same words.
 */

import { IMPLEMENTED_KINDS, type DecisionKind } from './schema.ts';

export type InSeasonKind = Exclude<DecisionKind, 'draft-board'>;

export const IN_SEASON_KINDS: readonly InSeasonKind[] = IMPLEMENTED_KINDS.filter(
  (kind): kind is InSeasonKind => kind !== 'draft-board',
);

export function isInSeasonKind(value: string | null): value is InSeasonKind {
  return value != null && (IN_SEASON_KINDS as readonly string[]).includes(value);
}
