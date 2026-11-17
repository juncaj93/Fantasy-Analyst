/**
 * Round 35 (UI_REVAMP): what every screen's top bar can reach without being
 * told by its screen.
 *
 * Setup left the tab bar for a gear on the top bar of every game-day screen,
 * and Setup itself got a Back to wherever it was opened from. Both are drawn by
 * `NavBar` from this context, so no screen has to know: a screen's own bar
 * gets the gear, a pushed page (which brings its own Back) does not.
 *
 * Null with the switch off, and then `NavBar` draws exactly what it always did.
 */

import { createContext } from 'react';

export interface Shell {
  /** On a game-day screen: open Setup. */
  openSetup?: () => void;
  /** On Setup: go back to the screen it was opened from. */
  back?: { label: string; onBack: () => void };
  /** Review or a newsletter is waiting (the dot the Setup tab used to carry). */
  attention: boolean;
  /** View only: changes need the passphrase (the ring the Setup tab used to carry). */
  locked: boolean;
  /** Said once, in the gear's name, for a screen reader. */
  notes: string[];
}

export const ShellContext = createContext<Shell | null>(null);
