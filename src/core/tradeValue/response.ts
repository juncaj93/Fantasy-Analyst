/**
 * The shapes the trade check sends over the wire.
 *
 * In `core` rather than beside the service so the screen and the server read one
 * definition. Every field added after the first release is optional: this app
 * caches API responses offline, so a fresh bundle routinely renders a body an
 * older worker produced.
 */

import type { TradeEvaluation } from './evaluate.ts';

export interface TradeHorizonView {
  currentWeek: number;
  lastWeek: number;
  /** How many weeks a trade made now affects. */
  weeks: number;
  playoffWeeks: number[];
  deadlineWeek: number | null;
  deadlinePassed: boolean;
  weeksToDeadline: number | null;
}

export interface TradeTeamPlayer {
  playerId: string;
  name: string;
  position: string;
  team: string;
  status: string | null;
  /** In an injured-reserve slot. */
  reserve: boolean;
  /** Set as a starter in Sleeper right now. */
  starter: boolean;
}

export interface TradeTeam {
  rosterId: number;
  label: string;
  isMine: boolean;
  players: TradeTeamPlayer[];
}

export interface TradeTeamsResponse {
  found: boolean;
  reason?: string;
  league?: { id: string; name: string };
  horizon?: TradeHorizonView;
  teams?: TradeTeam[];
}

export interface TradeCheckResponse {
  found: boolean;
  reason?: string;
  league?: { id: string; name: string };
  horizon?: TradeHorizonView;
  sides?: { a: { rosterId: number; label: string; isMine: boolean }; b: { rosterId: number; label: string; isMine: boolean } };
  evaluation?: TradeEvaluation;
  /** Facts about this league's trades that the number does not cover. */
  notes?: string[];
  advisory?: string;
  /** What the request asked of the database. Only present when `?cost=1` was sent. */
  cost?: { statements: number; rowsReturned: number };
}

/** One past trade, replayed through the model. Diagnostics only. */
export interface TradeReplay {
  id: string;
  season: string;
  week: number;
  /** `roster_aware` when both rosters could be rebuilt; `bundles` when only the players' values could be read. */
  mode: 'roster_aware' | 'bundles';
  rosters: { rosterId: number; label: string }[];
  /** Players each roster received in the real trade. */
  received: { rosterId: number; players: string[] }[];
  picksMoved: number;
  faabMoved: number;
  evaluation: TradeEvaluation | null;
  /** For `bundles`: each side's players valued over replacement, today. */
  bundles?: { rosterId: number; players: { name: string; position: string; rosValue: number | null; basis: string }[]; total: number | null }[];
  notes: string[];
}

export interface TradeReplayResponse {
  league?: { id: string; name: string };
  horizon?: TradeHorizonView;
  considered: number;
  replays: TradeReplay[];
  notes: string[];
  cost?: { statements: number; rowsReturned: number };
}

export const TRADE_CHECK_ADVISORY =
  'A read of the numbers only. This app does not make a trade for anyone, and the call is yours.';
