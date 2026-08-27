/**
 * Which decision the reader was looking at, so the support button knows.
 *
 * The whole point of the in-season support lane is that somebody who thinks an
 * answer is wrong taps one thing. Five buttons would be five things, and asking
 * "which screen were you on?" is asking the reader to translate their complaint
 * into a schema before they are allowed to report it.
 *
 * So the app remembers. Every decision screen records itself as it is opened,
 * and Setup reads the last one. `Current context: Waivers` is then a statement
 * the reader can check at a glance — and correct, with the control beside it,
 * on the rare occasion it is wrong.
 *
 * ## Why `sessionStorage` and not React state
 *
 * Two reasons, both about being *right* rather than about being convenient. A
 * reader who reloads the page on the way to Setup — or returns to a backgrounded
 * tab that iOS has discarded — still means the screen they were complaining
 * about, and state in a component tree does not survive either. And it must not
 * outlive the session: a context remembered from last Tuesday is worse than no
 * context at all, because it would be captured silently and confidently.
 *
 * Every access is guarded. Safari in a private window throws on `sessionStorage`
 * rather than returning null, and a support button that cannot be tapped because
 * the reader is browsing privately would be a poor trade for a convenience.
 */

import type { DecisionKind } from '../core/support/schema.ts';

/*
 * Re-exported so the screens do not import from `core/support`.
 *
 * `DecisionKind` is six words and a type, and it erases at build time — but the
 * rest of `core/support` is capture and replay machinery that has no business in
 * a browser chunk, and an import of the module is how that would start. There is
 * a test.
 */
export type SupportContext = DecisionKind;

const KEY = 'junculator.support.context';

/** The screens that make a decision, and what each one's decision is called. */
export const CONTEXT_BY_TAB: Record<string, SupportContext> = {
  draft: 'draft-board',
  team: 'lineup',
  matchup: 'matchup',
  waivers: 'waiver-plan',
  trades: 'trade-offer',
};

/**
 * What a reader is told each decision is called.
 *
 * The name of the screen rather than the name of the schema. Somebody reporting
 * a bad waiver plan should read `Current context: Waivers`, not
 * `Current context: waiver-plan`.
 */
export const CONTEXT_LABELS: Record<SupportContext, string> = {
  'draft-board': 'Draft',
  lineup: 'Team',
  matchup: 'Matchup',
  'waiver-plan': 'Waivers',
  'dst-plan': 'Defence',
  'trade-offer': 'Trades',
};

/**
 * The order the explicit selector offers them in.
 *
 * The seasonal order the app itself is in — draft, then the week, then the
 * things you do about the week — rather than alphabetical, which would put
 * Defence first for no reason a reader could name.
 */
export const CONTEXT_ORDER: readonly SupportContext[] = [
  'draft-board',
  'lineup',
  'matchup',
  'waiver-plan',
  'dst-plan',
  'trade-offer',
];

const isContext = (value: unknown): value is SupportContext =>
  typeof value === 'string' && value in CONTEXT_LABELS;

/**
 * Remember that the reader is looking at this decision.
 *
 * Called by the screens themselves rather than by the router, because two of the
 * six are not screens: the defence plan is one line on Team and one above the
 * Waivers board, and a reader who opened *that* means the defence rather than
 * the screen it sits on.
 */
export function rememberSupportContext(context: SupportContext): void {
  try {
    sessionStorage.setItem(KEY, context);
  } catch {
    /* A private window, or storage disabled. The selector covers it. */
  }
}

/**
 * The last decision the reader looked at, or null when there has not been one.
 *
 * Null is a real answer and is treated as one: opening Setup directly — from a
 * cold start, or a shortcut — is exactly the case where inference would be a
 * guess, and the row asks instead of guessing.
 */
export function readSupportContext(): SupportContext | null {
  try {
    const stored = sessionStorage.getItem(KEY);
    return isContext(stored) ? stored : null;
  } catch {
    return null;
  }
}
