-- Per-game usage: the input the role-change detector has never had.
--
-- `assessRole` in core/startsit/decisions.ts has been complete and tested since
-- the season brief, and it has answered "insufficient data" every single time,
-- because nothing in this app knew how many targets a player saw last Sunday.
-- Sleeper publishes a roster and a designation, not a box score.
--
-- So this stores one row per player per week from nflverse's published weekly
-- player stats -- the same kind of public GitHub release asset as the injury
-- report: no key, no account, no quota, no terms to be withdrawn.
--
-- Two things about that file shaped this table.
--
-- Its identifier is `player_id`, which is a GSIS id, the same space as the
-- injury report's `gsis_id`. That is why it was chosen over `snap_counts`,
-- which carries richer role signal (offensive snaps and snap share) but is
-- keyed only by `pfr_player_id` -- an id space this app has never seen, and a
-- second fuzzy matcher for it is exactly what every brief here has ruled out.
-- Rows that do not resolve to a canonical player are dropped and counted, never
-- guessed.
--
-- And it is one row per player per WEEK, per game actually played. A player who
-- was inactive has no row at all, which is the right shape for a per-game
-- series: his absence is a game that did not happen, not a game with zero
-- targets. Nothing here ever invents a value for a week the source is silent
-- about.

-- One row per player per week, keyed by season so two seasons cannot collide.
--
-- The same property that keeps last season's injury history out of this
-- season's status: 2025 and 2026 are different rows, a read names the season it
-- means, and no query can quietly average across the boundary.
CREATE TABLE IF NOT EXISTS player_usage_weeks (
  -- The canonical player, resolved through the existing identity layer.
  player_id TEXT NOT NULL,
  season TEXT NOT NULL,
  week INTEGER NOT NULL,
  -- 'REG' or 'POST'. Kept because they are not the same population of games:
  -- a fantasy season ends in week 17 or 18, so a January playoff week is not a
  -- baseline for anything this app is asked about. The read path uses REG only.
  season_type TEXT NOT NULL,
  team TEXT,
  position TEXT,
  -- The volume columns, stored as the source wrote them. NULL means the source
  -- left the field blank, which is not the same as zero and must not become it.
  pass_attempts INTEGER,
  carries INTEGER,
  targets INTEGER,
  receptions INTEGER,
  -- Share of the team's targets, and weighted opportunity rating. Rates rather
  -- than volumes, so a target count that only rose because the team threw forty
  -- times can be told apart from a role that actually grew.
  target_share REAL,
  wopr REAL,
  -- The source's own identifier, kept so a mapping can be audited later.
  gsis_id TEXT,
  source TEXT NOT NULL,
  -- When the FILE was published. There is no per-row timestamp in this data.
  published_at TEXT,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (player_id, season, week)
);

-- The read path asks for a handful of players and orders by week, which is
-- exactly this index; the season/week one is for coverage and gap-finding.
CREATE INDEX IF NOT EXISTS idx_player_usage_weeks_player
  ON player_usage_weeks (player_id, season, week);

CREATE INDEX IF NOT EXISTS idx_player_usage_weeks_season_week
  ON player_usage_weeks (season, week);

-- What we last saw upstream, and who is currently allowed to ingest it.
--
-- Deliberately the same shape as `injury_source_state`, column for column, so
-- one repository serves both rather than two near-identical ones drifting apart.
-- It carries the three timestamps that are routinely confused and must not be:
-- when we last looked, when the source last changed, and when we last stored
-- anything. A panel that shows only the first says "updated 2 minutes ago"
-- about a file from last Tuesday.
--
-- Written with line comments only, like every migration here. `wrangler d1
-- migrations apply --remote` posts the file to D1 unsplit and lets the server
-- parse it, which is not the parser `--local` uses; 0013 applied cleanly
-- locally and died on the deploy with "incomplete input" while it still carried
-- a block comment. tests/migrations.test.ts keeps this file inside that set.
CREATE TABLE IF NOT EXISTS usage_source_state (
  source TEXT NOT NULL,
  season TEXT NOT NULL,
  -- The HTTP validators, exactly as the server sent them. ETag is preferred:
  -- it is the strong one and it survives the release-asset redirect intact.
  etag TEXT,
  last_modified TEXT,
  -- When we last asked. Moves on every scheduled check, change or no change.
  checked_at TEXT,
  -- When the FILE last changed, from Last-Modified.
  source_modified_at TEXT,
  -- When we last actually parsed and stored something.
  ingested_at TEXT,
  last_outcome TEXT,
  last_note TEXT,
  -- The ingest lease: a compare-and-swap, because D1 has no advisory locks. It
  -- expires rather than releasing, so a Worker that dies mid-ingest cannot
  -- wedge the pipeline -- the next tick after expiry takes over.
  lock_owner TEXT,
  lock_expires_at TEXT,
  -- Ingests that started and did not finish, in a row, and when the run began.
  -- Without these a pipeline checking happily every morning while every ingest
  -- fails looks identical to a healthy one.
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  failing_since TEXT,
  -- The highest week actually stored, so a gap against the source is visible
  -- and can be filled one week at a time.
  caught_up_through INTEGER,
  PRIMARY KEY (source, season)
);

-- What happened the last time usage was ingested.
--
-- The counts are the point, exactly as they are for the injury report: a
-- pipeline that silently maps a third of its rows looks identical to one that
-- works until a card says nothing on a Sunday. Rows returned, rows matched by
-- identifier, rows matched by name and rows matched by nothing are all here.
CREATE TABLE IF NOT EXISTS usage_source_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  season TEXT NOT NULL,
  week INTEGER,
  latest_week INTEGER,
  fetched_at TEXT NOT NULL,
  published_at TEXT,
  rows_returned INTEGER NOT NULL DEFAULT 0,
  matched_by_id INTEGER NOT NULL DEFAULT 0,
  matched_by_name INTEGER NOT NULL DEFAULT 0,
  unmatched INTEGER NOT NULL DEFAULT 0,
  rows_written INTEGER NOT NULL DEFAULT 0,
  -- 'ok' | 'not_published' | 'failed'. A season that has not started is not a
  -- failure, and an alarm that cannot tell those apart gets ignored.
  outcome TEXT NOT NULL,
  note TEXT
);

CREATE INDEX IF NOT EXISTS idx_usage_source_runs_fetched ON usage_source_runs (fetched_at DESC);

-- How many rows the usage pipeline wrote today.
--
-- Its own ledger, separate from the injury one, so neither can spend the
-- other's allowance or hide the other's runaway. A healthy day here is one
-- ingest of a few hundred rows on the morning after a game day and nothing at
-- all on the days between.
CREATE TABLE IF NOT EXISTS usage_write_budget (
  day TEXT PRIMARY KEY,
  rows_written INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
