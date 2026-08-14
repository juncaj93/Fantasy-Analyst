-- What the app has spent at the odds provider, and on what.
--
-- The free plan is 2,500 "entities" a month, where one entity is one event
-- returned. That was measured against the live account rather than read off a
-- docs page (see docs/VEGAS.md), and it is small enough that an unattended
-- loop could spend it in a weekend — so spending is recorded before it is
-- allowed, not after it is noticed.
--
-- Two tables rather than a counter. `vegas_usage` is the month's running
-- total, which is what the budget gate reads on every call. `vegas_usage_log`
-- is the audit trail: one row per fetch, with what asked for it, so "where did
-- the month go" has an answer that is not a guess.
--
-- The provider reports its own count for free, and that number is
-- authoritative — it also sees spending from probes and from any other
-- deployment sharing the key. It is stored beside ours rather than instead of
-- it, because ours is the only one that knows *what* the spending was for.

CREATE TABLE IF NOT EXISTS vegas_usage (
  month TEXT PRIMARY KEY,              -- 'YYYY-MM', UTC
  entities INTEGER NOT NULL DEFAULT 0, -- what this app believes it spent
  requests INTEGER NOT NULL DEFAULT 0,
  provider_entities INTEGER,           -- the provider's own count, when read
  provider_limit INTEGER,              -- and the ceiling it reported with it
  provider_read_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vegas_usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  month TEXT NOT NULL,
  at TEXT NOT NULL,
  -- 'weekly', 'season', 'manual', 'schedule' — what asked for this fetch.
  source TEXT NOT NULL,
  event_id TEXT,
  entities INTEGER NOT NULL,
  requests INTEGER NOT NULL,
  outcome TEXT NOT NULL,               -- 'fetched' | 'blocked' | 'failed'
  reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_vegas_usage_log_month ON vegas_usage_log (month, at DESC);

-- Which game a team is playing, and when.
--
-- The provider has no "schedule only" request: every event answer carries its
-- odds board, and the bill is one entity per event either way. So discovery and
-- fetching are the same call, and its result is kept here so that the second,
-- third and fourth refresh of the week can go straight to the events the
-- roster actually needs instead of paying to find them again.
CREATE TABLE IF NOT EXISTS vegas_events (
  event_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  kickoff TEXT,
  home_team TEXT,
  away_team TEXT,
  seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vegas_events_kickoff ON vegas_events (kickoff);
