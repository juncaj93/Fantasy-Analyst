/**
 * What the new Trades screens receive (Round 19). In `core` so the server and
 * the screens read one definition; types only, so nothing here reaches the
 * page's JavaScript.
 */

import type { FinderResult, FoundOffer } from './finder.ts';
import type { CheckSummary } from './verdict.ts';

export interface ScreensOffers {
  league: { id: string; name: string } | null;
  status: FinderResult['status'];
  note: string | null;
  offers: FoundOffer[];
  deadline: { week: number | null; weeksLeft: number | null } | null;
}

export interface ScreensTeams {
  league: { id: string; name: string } | null;
  teams: { rosterId: number; label: string; isMine: boolean; players: { playerId: string; name: string; position: string; team: string }[] }[];
  reason?: string;
}

export interface ScreensPlayerLine {
  playerId: string;
  name: string;
  position: string;
  /** Rest-of-season value over a free agent. */
  value: number | null;
  /** Weeks he would start for his new team. */
  starts: number;
}

export interface ScreensVerdict {
  found: boolean;
  reason?: string;
  partner?: { rosterId: number; label: string };
  summary?: CheckSummary | null;
  give?: ScreensPlayerLine[];
  get?: ScreensPlayerLine[];
  weeks?: number;
  drop?: string | null;
  /** Why there is no verdict, when there is not one. */
  insufficient?: string | null;
}

export type { FoundOffer, CheckSummary };
