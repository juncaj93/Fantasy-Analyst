/**
 * What actually goes down the wire to a phone.
 *
 * The board this app assembles is a *decision*, and the decision carries its
 * own workings: fifteen scored components per player, the reasons and
 * counterpoints they produce, the opportunity-cost arithmetic, the NFL-team
 * overlap, the `Next` model's per-player probabilities and the room-level
 * diagnostics behind them. All of it is real, all of it is computed either way,
 * and on a board of four hundred players it is roughly seven bytes in ten of
 * the response.
 *
 * None of it is drawn. `DraftScreen` cut the ranking rationale from the
 * expanded card three passes ago and says so where the card is written — "the
 * rationale is still not rendered anywhere here" — and the queue, the sort, the
 * grid overlay and the row itself have never read the rest. So on every cold
 * load, on a phone, mid-draft, the app was paying to transfer and parse an
 * explanation nothing on screen asks for.
 *
 * **This trims the wire, not the model.** Every field below is still computed,
 * still carried on `DraftBoardState`, and still reaches everything that reads a
 * board through the assembly rather than through HTTP — the support snapshot
 * and its replay above all, which compare every leaf by path and must keep
 * seeing the whole thing. What changes is only what a *client* is sent by
 * default.
 *
 * **Nothing is unreachable.** `?diagnostics=1` on the board route returns the
 * untrimmed state exactly as before. That is not a compatibility shim: the
 * probes in `scripts/` and the production smoke suite read these fields over
 * HTTP on purpose — the pool census, the component caps, the `Next` workings —
 * and a diagnostic that cannot be asked for is a diagnostic that stops being
 * run. The flag is how they ask.
 *
 * The one rule for this file: **a field belongs in the kept set if any client
 * code reads it.** Not if it looks useful, and not if it might be wanted later
 * — the type in `web/api.ts` is the contract, and a field the client type does
 * not name is a field no screen can read. Adding one back is a line here and a
 * line there, and until somebody needs it the phone should not carry it.
 */

import type { BoardRecommendation, DraftBoardState } from './boardBuilder.ts';

/**
 * The recommendation fields no client reads.
 *
 * Established mechanically rather than by eye: each one was renamed in
 * `web/api.ts` and `tsc` was run over the whole project, and none of them
 * produced an error. Reading a list of fields and deciding which "look used" is
 * exactly how a field that *is* used gets dropped.
 *
 * It stays true by the same mechanism, from the other side. None of these is on
 * `DraftRecommendation` in `web/api.ts` any more, so a screen that starts
 * reading one does not get `undefined` at runtime — it fails to compile, and
 * whoever adds the read has to put the field back on the client type and here
 * in the same change. `tests/draft.boardWire.test.ts` holds the other half: the
 * projection drops these and nothing else, and changes no value it keeps.
 */
const DROPPED_FROM_RECOMMENDATION = [
  /** The scored breakdown. Read by the probes; drawn nowhere. */
  'components',
  /** The bullets the breakdown produces, and their mirror image. */
  'reasons',
  'counterpoints',
  /** Whether any component fell back to a default. Never shown. */
  'degraded',
  /** `Val` against Sleeper alone. The row prints the deltas it draws itself. */
  'adpValue',
  /** How the baseline was weighted. The market-value component says it in words. */
  'marketBlend',
  /** The two shorter tally windows. Only the lifetime net is drawn. */
  'news30Net',
  'news7Net',
  'newsConflicted',
  /** Take Now / Can Probably Wait — not shown as a badge since `decisions.tsx`. */
  'wait',
  /** The automatic caution, and the reader's own rating. Neither is on this screen. */
  'avoid',
  'myGuy',
  /** The cost of passing, and offence overlap. Inputs to components, not rows. */
  'opportunity',
  'concentration',
  /** The `Next` model's per-player workings. Its own comment says nothing reads it. */
  'nextPick',
] as const satisfies readonly (keyof BoardRecommendation)[];

/** The board-level fields no client reads. */
const DROPPED_FROM_BOARD = [
  /** Diagnostics for `Next`. Read by the probe and by nothing on screen. */
  'nextPickModel',
  /** The draft header states `rosterProgress`; the open slots come with it. */
  'openStarters',
] as const satisfies readonly (keyof DraftBoardState)[];

export const TRIMMED_RECOMMENDATION_FIELDS: readonly string[] = DROPPED_FROM_RECOMMENDATION;
export const TRIMMED_BOARD_FIELDS: readonly string[] = DROPPED_FROM_BOARD;

/** A recommendation with the unread fields gone. */
export type WireRecommendation = Omit<BoardRecommendation, (typeof DROPPED_FROM_RECOMMENDATION)[number]>;

/** The board as a client receives it. */
export type WireBoardState = Omit<DraftBoardState, (typeof DROPPED_FROM_BOARD)[number] | 'recommendations'> & {
  recommendations: WireRecommendation[];
};

function withoutKeys<T extends object>(value: T, keys: readonly string[]): T {
  const out = { ...value } as Record<string, unknown>;
  for (const key of keys) delete out[key];
  return out as T;
}

/**
 * The board, trimmed for a client.
 *
 * A shallow copy per row and nothing else — no re-derivation, no reordering, no
 * rounding. Every value a client keeps is the identical value the assembly
 * produced, so a board that renders one way before this runs renders exactly
 * the same way after it.
 */
export function boardForClient(state: DraftBoardState): WireBoardState {
  return {
    ...withoutKeys(state, DROPPED_FROM_BOARD),
    recommendations: state.recommendations.map((rec) => withoutKeys(rec, DROPPED_FROM_RECOMMENDATION)),
  } as WireBoardState;
}
