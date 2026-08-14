-- The NFL injury report, and a record of every time we went and looked.
--
-- Sleeper already tells this app whether a player is Questionable, and that
-- stays the authority on designation: it is the league host, and it is what
-- governs the user's own lineup. What it does not say is what is wrong with him
-- or whether he practised, and those are the two facts that decide what
-- "Questionable" is worth at 12:45 on a Sunday.
--
-- So this stores the published injury report alongside it. The source is
-- nflverse's public release asset: no key, no account, no quota, and no terms
-- that can be withdrawn out from under the project — which is why it was chosen
-- over two richer APIs whose free tiers exclude injuries or expire.

-- One row per player per week, because that is the shape the source publishes.
--
-- Worth stating plainly, since it bounds what can be built on top: this is one
-- practice status per WEEK, not the three days of a week's practice report. A
-- within-week `DNP → LP → FP` sequence is not derivable from this data, and the
-- app does not pretend otherwise — what it derives is a week-over-week
-- comparison, and it says so.
CREATE TABLE IF NOT EXISTS player_injury_reports (
  -- The canonical player, resolved through the existing identity layer. Rows
  -- that could not be resolved are not stored: an injury attached to the wrong
  -- player is worse than no injury.
  player_id TEXT NOT NULL,
  season TEXT NOT NULL,
  week INTEGER NOT NULL,
  team TEXT,
  -- 'Questionable' | 'Out' | 'Doubtful' | NULL for a practice-only report.
  -- Stored as the source wrote it; normalization happens in one place in code,
  -- so a future change of vocabulary is a code change and not a migration.
  report_status TEXT,
  -- 'Knee', 'Hamstring'. Printed as written, never expanded into a sentence.
  primary_injury TEXT,
  secondary_injury TEXT,
  -- Normalized to dnp | limited | full | unknown on the way in, because every
  -- reader wants the same four and none of them should be re-parsing
  -- 'Limited Participation in Practice'.
  practice_status TEXT,
  practice_raw TEXT,
  -- The source's own identifier, kept so a mapping can be audited later.
  gsis_id TEXT,
  source TEXT NOT NULL,
  -- When the FILE was published. There is no per-row timestamp in this data, so
  -- this is the only freshness it has and it belongs to the whole ingest.
  published_at TEXT,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (player_id, season, week)
);

CREATE INDEX IF NOT EXISTS idx_player_injury_reports_season_week
  ON player_injury_reports (season, week);

-- What happened the last time the report was ingested.
--
-- The counts are the point. A pipeline that silently maps a third of its input
-- looks exactly like one that works, until a card is blank on a Sunday — so
-- rows returned, rows matched by identifier, rows matched by name and rows
-- matched by nothing are all recorded, and Setup prints them.
CREATE TABLE IF NOT EXISTS injury_source_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  season TEXT NOT NULL,
  -- The latest week the file contained, which is what 'current' means here.
  latest_week INTEGER,
  fetched_at TEXT NOT NULL,
  published_at TEXT,
  rows_returned INTEGER NOT NULL DEFAULT 0,
  matched_by_id INTEGER NOT NULL DEFAULT 0,
  matched_by_name INTEGER NOT NULL DEFAULT 0,
  unmatched INTEGER NOT NULL DEFAULT 0,
  -- 'ok' | 'not_published' | 'failed'. A season that has not started is not a
  -- failure, and an alarm that cannot tell those apart gets ignored.
  outcome TEXT NOT NULL,
  note TEXT
);

CREATE INDEX IF NOT EXISTS idx_injury_source_runs_fetched ON injury_source_runs (fetched_at DESC);
