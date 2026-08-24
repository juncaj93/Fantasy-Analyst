-- Projection v2, phase 1: the three nflverse sources the usage feed did not have.
--
-- Nothing in this migration is read by a recommendation. Every table here feeds
-- the side-by-side evaluation in `core/projection/` and the diagnostics endpoint
-- that reports it; the live Team and Matchup engines do not know these tables
-- exist. That is the phase-1 boundary and it is a property of the wiring rather
-- than of a flag, so it cannot be lost by flipping something.
--
-- Written with line comments only, like every migration here. `wrangler d1
-- migrations apply --remote` posts the file to D1 unsplit and lets the server
-- parse it, which is not the parser `--local` uses; 0013 applied cleanly locally
-- and died on the deploy with "incomplete input" while it still carried a block
-- comment. tests/migrations.test.ts keeps this file inside that set.

-- ------------------------------------------------------------- identity ---
-- The deterministic crosswalk: one row per player per season, from
-- `roster_YYYY.csv`.
--
-- This is the table that makes the rest of the phase possible. nflverse
-- publishes `gsis_id`, `sleeper_id`, `pfr_id` and `espn_id` on the same roster
-- row, which turns two joins this app could not previously make into identifier
-- lookups:
--
--   * Sleeper player id -> gsis_id, for the ~16% of skill-position players
--     whose Sleeper dictionary entry carries no GSIS id of its own. Measured on
--     the live 2026 roster: 915 skill rows, 100% with a gsis_id, 83.5% with a
--     sleeper_id.
--   * pfr_id -> gsis_id, which is what makes the PFR snap counts readable at
--     all. `core/usage/nflverse.ts` records the earlier decision to reject them
--     because `pfr_player_id` was "an id space this app has never seen"; that
--     objection is spent, and the join resolves 99.7% of the 2025 season's
--     skill-position snap rows.
--
-- No name column is joined on anywhere. `full_name` is stored for a human
-- reading an audit and is never a matching key -- the handoff is explicit that
-- fuzzy name matching is not the primary path, and this app's own identity
-- ladder sends ambiguity to review rather than committing it.
CREATE TABLE IF NOT EXISTS nflverse_identity (
  gsis_id TEXT NOT NULL,
  season TEXT NOT NULL,
  sleeper_id TEXT,
  pfr_id TEXT,
  espn_id TEXT,
  yahoo_id TEXT,
  -- The club and position as the roster spells them. Context for an audit, not
  -- a source of truth: Sleeper owns where a player plays, here as everywhere.
  team TEXT,
  position TEXT,
  full_name TEXT,
  -- 'ACT', 'RES', 'CUT', 'RET', ... A roster state, never a health state. The
  -- current-injury pipeline is unchanged and this must never be read as one.
  status TEXT,
  source TEXT NOT NULL,
  -- When the FILE was published, from Last-Modified. Not when we read it.
  as_of TEXT,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (gsis_id, season)
);

-- The two lookups the resolver actually performs, both partial so the index
-- carries only rows that can answer.
CREATE INDEX IF NOT EXISTS idx_nflverse_identity_sleeper
  ON nflverse_identity (sleeper_id, season) WHERE sleeper_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_nflverse_identity_pfr
  ON nflverse_identity (pfr_id, season) WHERE pfr_id IS NOT NULL;

-- ---------------------------------------------------------------- snaps ---
-- Offensive snaps per player per game, keyed by this app's canonical player.
--
-- Deliberately the same shape as `player_usage_weeks`: one row per player per
-- week, NULL where the source is blank, no row at all for a game he did not
-- play. A missing week is a game that did not happen and is never a zero.
--
-- One trap of its own, recorded here because it is invisible in the data: this
-- file spells the postseason 'WC' / 'DIV' / 'CON' / 'SB', where the weekly-stats
-- file spells it 'POST'. A read filtering `season_type != 'POST'` -- which is
-- what the sibling table teaches -- would admit every playoff game into a
-- regular-season baseline. Every read here tests for 'REG'.
CREATE TABLE IF NOT EXISTS player_snap_weeks (
  player_id TEXT NOT NULL,
  season TEXT NOT NULL,
  week INTEGER NOT NULL,
  -- 'REG', or one of the four playoff rounds. See the note above.
  game_type TEXT NOT NULL,
  team TEXT,
  opponent TEXT,
  position TEXT,
  offense_snaps INTEGER,
  -- His share of the club's offensive snaps, 0-1 as the source writes it.
  offense_share REAL,
  -- The source identifier and the one it was bridged through, both kept so a
  -- mapping can be audited without re-downloading anything.
  pfr_id TEXT,
  gsis_id TEXT,
  source TEXT NOT NULL,
  published_at TEXT,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (player_id, season, week)
);

CREATE INDEX IF NOT EXISTS idx_player_snap_weeks_player
  ON player_snap_weeks (player_id, season, week);

CREATE INDEX IF NOT EXISTS idx_player_snap_weeks_season_week
  ON player_snap_weeks (season, week);

-- ---------------------------------------------------------- depth charts ---
-- The current chart and the one before it. Two, and no more.
--
-- The published file is 44MiB and holds every daily capture of a whole season --
-- 554,216 rows for 2025. Storing that would be the giant warehouse the handoff
-- rules out in section 12, and it would buy nothing: change detection compares
-- now against the last capture, and a chart from October is not evidence about
-- this week. The ingest keeps the two newest `captured_at` values per season and
-- deletes the rest, which is about 2,000 rows.
--
-- `schema_version` versions the semantics rather than the columns. Before 2025
-- the file carried a weekly `depth_team` rank; from 2025 it carries a timestamped
-- `pos_rank` that runs across the whole position on the club rather than
-- restarting per slot. A rank from one read as a rank from the other would put a
-- third receiver at third-string. Nothing compares across this column.
CREATE TABLE IF NOT EXISTS depth_chart_entries (
  season TEXT NOT NULL,
  -- The capture time. On the pre-2025 schema there is none, and the file's
  -- Last-Modified is substituted so the column is never null and the two
  -- schemas still sort against each other.
  captured_at TEXT NOT NULL,
  gsis_id TEXT NOT NULL,
  team TEXT NOT NULL,
  player_name TEXT,
  position TEXT NOT NULL,
  -- The personnel grouping ('3WR 1TE') or, on the legacy schema, the formation.
  pos_group TEXT,
  -- Which spot in the grouping. NULL on the legacy schema, which has no slots.
  pos_slot INTEGER,
  pos_rank INTEGER NOT NULL,
  -- Spots the club fields at his position in this grouping, counted from the
  -- chart itself rather than from an assumed formation.
  starter_slots INTEGER,
  -- 'timestamped' or 'weekly'. See the note above.
  schema_version TEXT NOT NULL,
  source TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (season, captured_at, gsis_id)
);

CREATE INDEX IF NOT EXISTS idx_depth_chart_entries_season
  ON depth_chart_entries (season, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_depth_chart_entries_player
  ON depth_chart_entries (gsis_id, season, captured_at DESC);

-- --------------------------------------------------------- source health ---
-- Its own state and its own write ledger, for the same reason the usage
-- pipeline has its own rather than sharing the injury feed's: neither pipeline
-- can spend the other's allowance or hide the other's runaway. Column for
-- column what `usage_source_state` is, so `SourceStateRepo` serves all three
-- rather than three near-identical repositories drifting apart.
--
-- `source` here is one of 'nflverse_roster', 'nflverse_depth', 'nflverse_snaps',
-- so the three feeds keep separate fingerprints, leases and catch-up positions
-- inside one table.
CREATE TABLE IF NOT EXISTS nflverse_source_state (
  source TEXT NOT NULL,
  season TEXT NOT NULL,
  etag TEXT,
  last_modified TEXT,
  checked_at TEXT,
  source_modified_at TEXT,
  ingested_at TEXT,
  last_outcome TEXT,
  last_note TEXT,
  lock_owner TEXT,
  lock_expires_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  failing_since TEXT,
  caught_up_through INTEGER,
  PRIMARY KEY (source, season)
);

CREATE TABLE IF NOT EXISTS nflverse_write_budget (
  day TEXT PRIMARY KEY,
  rows_written INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- What happened on each ingest, per feed.
--
-- The counts are the point, exactly as they are for the injury and usage
-- pipelines: a feed that silently maps a third of its rows looks identical to a
-- working one until a projection says nothing on a Sunday.
CREATE TABLE IF NOT EXISTS nflverse_source_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  season TEXT NOT NULL,
  week INTEGER,
  fetched_at TEXT NOT NULL,
  published_at TEXT,
  rows_returned INTEGER NOT NULL DEFAULT 0,
  matched INTEGER NOT NULL DEFAULT 0,
  unmatched INTEGER NOT NULL DEFAULT 0,
  rows_written INTEGER NOT NULL DEFAULT 0,
  -- 'ok' | 'not_modified' | 'not_published' | 'failed'. A season that has not
  -- started is not a failure, and an alarm that cannot tell those apart gets
  -- ignored.
  outcome TEXT NOT NULL,
  note TEXT
);

CREATE INDEX IF NOT EXISTS idx_nflverse_source_runs_fetched
  ON nflverse_source_runs (source, fetched_at DESC);
