/**
 * What the trade builder sends over the wire.
 *
 * Types only, so the Trades screen can read them without pulling the engine
 * into the chunk every page load fetches (see `category.ts` for why that
 * matters). Every field added after the first release must be optional: this
 * app caches API responses offline, so a fresh bundle can render a body an
 * older worker produced.
 */

/** How likely the other manager is to say yes, in words. Never a percentage. */
export type PackageStatus = 'likely' | 'maybe' | 'long_shot';

export const PACKAGE_STATUS_LABEL: Record<PackageStatus, string> = {
  likely: 'Likely',
  maybe: 'Maybe',
  long_shot: 'Long shot',
};

export interface PackagePlayer {
  playerId: string;
  name: string;
  position: string;
  team: string;
  /** The muted stat after the name: `RB · 14.2 a game`. */
  stat: string;
}

/** A forced roster move on Alex's side, with the waiver planner's reason. */
export interface PackageMove extends PackagePlayer {
  /** `lowest season points on your bench (17.3), held 2 weeks`. */
  reason: string;
}

/** Completed trades on record for one manager, from Sleeper's transactions. */
export interface TradeActivity {
  thisSeason: number;
  /** Earlier seasons this app has read. Null when none have been read. */
  earlier: number | null;
  /** `Has made 4 trades this season`. */
  line: string;
}

export interface BuiltPackage {
  id: string;
  partner: { rosterId: number; label: string; activity: TradeActivity };
  give: PackagePlayer[];
  get: PackagePlayer[];
  /** Players Alex would cut to stay at the roster limit. Empty for most deals. */
  drops: PackageMove[];
  /** Players moved to an open IR slot instead of cut. */
  irMoves: PackageMove[];
  /** Alex's lineup change, in points: the week a trade first affects, the next three weeks, the playoff weeks. */
  alex: {
    thisWeek: number;
    next3: number;
    playoffs: number;
    restOfSeason: number;
    /** The ranking number: next week counted most, playoffs weighted up. Never shown. */
    weighted: number;
    /** Alex's stated preferences, as labeled lines (from Check a trade). */
    adjustments: { label: string; points: number }[];
  };
  them: { next3: number; restOfSeason: number; weighted: number };
  /** Their need this package fills, in plain words: `their RB2 is Out`. Null when none was found. */
  need: string | null;
  /** One line for the card: why it works for them. */
  why: string;
  status: PackageStatus;
  /** One plain sentence on the status. */
  statusReason: string;
  /** Rest-of-season value over a free agent, each side, from Check a trade. */
  balance: { give: number; get: number; label: string };
  confidence: 'high' | 'medium' | 'low';
  /** Every reason, for the detail sheet. */
  reasons: string[];
  caveats: string[];
  /** A short, friendly message Alex can paste into Sleeper. The app never sends it. */
  pitch: string;
}

export interface BuilderWeeks {
  /** The week a trade made now first affects. */
  thisWeek: number;
  next3: number[];
  playoffs: number[];
  last: number;
}

export interface BuilderDeadline {
  week: number | null;
  passed: boolean;
  weeksLeft: number | null;
  /** Null when there is nothing to say. */
  line: string | null;
}

export interface BuilderTeamResult {
  rosterId: number;
  label: string;
  activity: TradeActivity;
  /** This team's needs, strongest first, in plain words. */
  needs: string[];
  /** The players suggested when Alex marked none on this team. */
  suggested: string[];
  packages: BuiltPackage[];
}

export interface BuilderResult {
  status: 'ok' | 'closed' | 'no_sells' | 'no_team' | 'not_found';
  /** Why there are no packages, when there are none. */
  message: string | null;
  weeks: BuilderWeeks | null;
  deadline: BuilderDeadline | null;
  /** The ranked packages: top 3 for one team, top 5 across all teams. */
  packages: BuiltPackage[];
  teams: BuilderTeamResult[];
  /** Packages built and checked, and why each one that is not shown was hidden. */
  audit: { generated: number; evaluated: number; shown: number; hidden: Record<string, number> };
  notes: string[];
  /** Said on every result: what this app cannot know. */
  willingness: string;
  advisory: string;
}

export interface BuilderResponse extends BuilderResult {
  league?: { id: string; name: string };
  cost?: { statements: number; rowsReturned: number; top?: { sql: string; calls: number; rows: number }[] };
}

export const BUILDER_WILLINGNESS =
  'Sleeper does not show offers that were turned down or ignored, so whether this manager would say yes is unknown.';

export const BUILDER_ADVISORY = 'Suggestions only. This app never sends, proposes or accepts a trade for you.';
