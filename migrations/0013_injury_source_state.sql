-- Checking every five minutes without paying for it every five minutes.
--
-- The injury report is the one feed where being an hour stale is a real cost: a
-- player is ruled out ninety minutes before kickoff, and kickoff is 9:30am for a
-- London game, or Thursday night, or Friday on a holiday. Fixed windows cannot
-- cover that, so the check runs on a flat five-minute cadence instead.
--
-- What makes that affordable is that a check is not an ingest. The source is a
-- GitHub release asset and it answers conditional requests properly — this was
-- measured, not assumed (`scripts/probe-nflverse-conditional.mjs`): a GET
-- carrying `If-None-Match` comes back 304 with no body, a stale validator comes
-- back 200 with the whole file, and the validators are stable across calls even
-- though the signed CDN URL behind the redirect changes every time.
--
-- So: 288 checks a day, almost all of them 304 and zero writes; a parse only
-- when the file actually changed; and a row written only for a player whose
-- normalized state actually moved.

-- What we last saw upstream, and who is currently allowed to ingest it.
--
-- One row per (source, season). It carries three timestamps that are routinely
-- confused and must not be: when we last *looked*, when the source last
-- *changed*, and when we last *stored* anything. A card that says "updated 2
-- minutes ago" because we checked two minutes ago — while the newest report is
-- from Wednesday — is lying in the most expensive possible way.
CREATE TABLE IF NOT EXISTS injury_source_state (
  source TEXT NOT NULL,
  season TEXT NOT NULL,

  -- The validators, exactly as the server sent them. ETag is preferred: it is
  -- the strong validator and it survives the release-asset redirect intact.
  etag TEXT,
  last_modified TEXT,

  -- When we last asked. Moves every five minutes even when nothing changed,
  -- which is what makes "the pipeline is alive" checkable.
  checked_at TEXT,
  -- When the FILE last changed, parsed from Last-Modified. This is the number
  -- that belongs on a card next to a designation.
  source_modified_at TEXT,
  -- When we last actually parsed and stored something.
  ingested_at TEXT,

  -- Last outcome and reason, so a panel can say what is wrong without a log.
  last_outcome TEXT,
  last_note TEXT,

  /*
   * The ingest lease.
   *
   * D1 has no advisory locks, so this is a compare-and-swap: the UPDATE that
   * claims the lease carries `WHERE lock_expires_at IS NULL OR lock_expires_at
   * < ?`, and SQLite reports how many rows it changed. One row changed means
   * you own it; zero means somebody else does.
   *
   * It expires rather than releasing, so a Worker that dies mid-ingest cannot
   * deadlock the pipeline — the next tick after the lease runs out takes over.
   */
  lock_owner TEXT,
  lock_expires_at TEXT,

  PRIMARY KEY (source, season)
);

-- Meaningful transitions, appended and never rewritten.
--
-- The week rows in `player_injury_reports` are the source's own grain: one per
-- player per week, overwritten as that week's report is revised. This is the
-- other half — the moments a decision would have changed. `Q → Out` on a Sunday
-- morning is the single most valuable fact this pipeline produces, and it is
-- invisible in a table that only ever holds the current answer.
--
-- `event_key` is deterministic and unique, which is what makes re-ingesting the
-- same file a no-op rather than a duplicate. It is derived from the player, the
-- week, and the transition itself — never from a timestamp.
CREATE TABLE IF NOT EXISTS injury_events (
  event_key TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  season TEXT NOT NULL,
  week INTEGER NOT NULL,
  -- 'designation' | 'practice' | 'body_part'
  kind TEXT NOT NULL,
  -- Normalized values, so a reader does not re-parse source vocabulary.
  from_value TEXT,
  to_value TEXT,
  source TEXT NOT NULL,
  -- When the SOURCE changed, not when we noticed.
  source_modified_at TEXT,
  detected_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_injury_events_player ON injury_events (player_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_injury_events_detected ON injury_events (detected_at DESC);

-- How many rows the injury pipeline wrote today.
--
-- A guard rather than a metric. The free-tier D1 budget is 100,000 writes a day
-- and this pipeline is designed to use a few dozen; a bug that starts rewriting
-- every player on every tick would burn the whole allowance in an afternoon and
-- take the rest of the app down with it. When the day's count crosses the
-- ceiling the expensive path stops and the last-good data stays exactly where
-- it is.
CREATE TABLE IF NOT EXISTS injury_write_budget (
  day TEXT PRIMARY KEY,
  rows_written INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
