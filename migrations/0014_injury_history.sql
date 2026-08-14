-- Last season's injuries, kept where they cannot be mistaken for this season's.
--
-- The separation is the whole point of this migration, so it is worth stating
-- before the tables: a player who missed nine games with a knee in 2025 and is
-- practising fully today is HEALTHY. Nothing here may ever answer "can he play
-- on Sunday" -- that is Sleeper's designation, resolved in code that never
-- reads these tables. What is stored here is context to print beside a status,
-- never a status.
--
-- The weekly rows themselves are not stored here at all. They go into
-- player_injury_reports, which is already keyed by (player_id, season, week),
-- so 2025 rows and 2026 rows cannot collide by construction and the current
-- reader -- which asks for the current season -- cannot see 2025 even by
-- accident. This file adds only the derived summary and the bookkeeping needed
-- to build it a little at a time.

-- One line per player per season, and only when there is something to say.
--
-- Most players have nothing: on the real 2025 file, 1,069 of 1,453 injured
-- players missed no games at all, and a note about a Wednesday of limited
-- practice is noise that makes the app look like it is guessing. Rows are
-- written only for a season that cleared the thresholds in
-- src/core/injury/history.ts.
CREATE TABLE IF NOT EXISTS player_injury_history (
  player_id TEXT NOT NULL,
  season TEXT NOT NULL,
  -- 'strong' | 'moderate'. 'none' is never stored -- absence is the answer.
  significance TEXT NOT NULL,
  -- Counted, not estimated: the number of weeks the report said Out.
  games_missed INTEGER NOT NULL,
  -- The one short line, generated deterministically and stored so a card does
  -- not rebuild it on every request.
  note TEXT NOT NULL,
  -- The episodes it was derived from, as JSON, so any line can be audited back
  -- to the weeks that produced it.
  episodes TEXT NOT NULL,
  source TEXT NOT NULL,
  derived_at TEXT NOT NULL,
  PRIMARY KEY (player_id, season)
);

CREATE INDEX IF NOT EXISTS idx_player_injury_history_season
  ON player_injury_history (season, significance);

-- Where the backfill has got to.
--
-- A finished season is 6,068 rows across 22 weeks, and parsing all of it costs
-- about 10.6ms -- which is the entire CPU budget of a Workers invocation on the
-- free plan, before a single row is written. So it is walked one week per tick
-- and then folded into summaries a batch of players at a time, and this table
-- is what makes that resumable: a tick that dies mid-way costs one week, not
-- the backfill.
--
-- phase is 'weeks' while the season file is being read, 'players' while the
-- summaries are being derived, and 'done' after. 'done' is terminal: the file
-- for a finished season does not change again, and the validator stored in
-- injury_source_state means later ticks get a 304 and stop.
CREATE TABLE IF NOT EXISTS injury_backfill_progress (
  source TEXT NOT NULL,
  season TEXT NOT NULL,
  phase TEXT NOT NULL,
  -- The next week to read, while phase is 'weeks'.
  next_week INTEGER NOT NULL DEFAULT 1,
  -- The last week the file actually contains, learned on the first tick.
  last_week INTEGER,
  -- The player id the derive phase should continue after, so it can page
  -- through in a stable order without holding a list across invocations.
  after_player_id TEXT,
  rows_seen INTEGER NOT NULL DEFAULT 0,
  players_written INTEGER NOT NULL DEFAULT 0,
  significant_players INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  note TEXT,
  PRIMARY KEY (source, season)
);
