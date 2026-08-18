-- The decision feed, and the prior decompositions that let a rank movement be
-- explained rather than narrated.
--
-- Deliberately two small tables. The league's transaction history, its manager
-- profiles and its bid prices already have canonical homes in
-- `0020_league_strategy.sql`; nothing here duplicates them. What is missing from
-- that set is memory of what the app *said* last time, which is the only thing
-- either of these features can be built from.

-- What changed since you last looked.
--
-- One table rather than more permanent UI, and the materiality rule lives in
-- code beside the arithmetic that produced the change. A row here is a claim
-- that a decision moved -- never that a refresh happened.
CREATE TABLE IF NOT EXISTS decision_feed_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id TEXT,
  -- The identity of the underlying situation, not of this observation. Three
  -- sources describing one injury share a dedupe key and collapse into one
  -- event; the newest wording wins and the older row is superseded rather than
  -- deleted, so the feed can be audited.
  dedupe_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject_player_id TEXT,
  headline TEXT NOT NULL,
  detail TEXT,
  -- How big the change was, normalized to 0-1 by whatever emitted it. Used for
  -- ordering and for the threshold, and for nothing else.
  magnitude REAL NOT NULL,
  occurred_at TEXT NOT NULL,
  superseded_at TEXT,
  seen_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_decision_feed_open
  ON decision_feed_events (league_id, dedupe_key, superseded_at);

CREATE INDEX IF NOT EXISTS idx_decision_feed_recent
  ON decision_feed_events (occurred_at);

-- Prior scoring decompositions, so "why did his rank move" can be answered.
--
-- The requirement that shapes this table is the negative one: a refresh that
-- changes no input must produce no movement. So every snapshot carries a hash
-- of the inputs that produced it, and a new snapshot is written only when that
-- hash differs from the last one stored. Without it the feed would report
-- movement every time the page was opened.
CREATE TABLE IF NOT EXISTS rank_decompositions (
  -- Which board this ranking belongs to: 'draft', 'startsit', 'waiver'.
  context TEXT NOT NULL,
  -- The board's own identity -- a draft id, or a league-and-week key. Two
  -- contexts must never compare against each other's numbers.
  scope TEXT NOT NULL,
  player_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  rank INTEGER,
  total REAL NOT NULL,
  -- [{ key, label, value }], the same components the card already shows, so a
  -- movement explanation can never name a component the score did not use.
  components_json TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  PRIMARY KEY (context, scope, player_id, captured_at)
);

CREATE INDEX IF NOT EXISTS idx_rank_decompositions_latest
  ON rank_decompositions (context, scope, player_id, captured_at);
