-- League-specific intelligence: the transaction history this app has never read.
--
-- Everything the app knows about the league today is a snapshot -- who is on
-- which roster right now. What it has never had is the record of how those
-- rosters came to look like that: who bid what, who lost the bid, who trades
-- and who never does, and how much FAAB each manager has left. That record is
-- published by Sleeper on a documented endpoint the app simply never called:
--
--   GET https://api.sleeper.app/v1/league/<league_id>/transactions/<week>
--
-- Verified against a real 10-team league before this table was written
-- (scripts/probe-sleeper-transactions.mjs): 113 transactions in week 1 alone,
-- of which 16 were FAILED waiver claims. Those failures are the point. A
-- winning bid says what one manager paid; the failures say what the rest of the
-- league was willing to pay, which is the only honest input to "what will this
-- player cost me".
--
-- Read-only, and permanently so. Nothing in this app submits a transaction.

-- One row per Sleeper transaction, stored as Sleeper reported it.
--
-- Keyed by the SLEEPER league id rather than by this app's internal league row,
-- because history spans seasons and a previous season's league is not a row in
-- `leagues` -- the user never selected it, and inventing a league record for a
-- season they cannot play would put a season they have finished into every
-- league picker.
CREATE TABLE IF NOT EXISTS league_transactions (
  sleeper_league_id TEXT NOT NULL,
  -- Sleeper's own id. Stable, and the reason this table can be re-synced
  -- without duplicating: a re-read of week 3 writes the same primary keys.
  transaction_id TEXT NOT NULL,
  season TEXT NOT NULL,
  -- Sleeper calls it `leg`; it is the league week the transaction belongs to.
  week INTEGER NOT NULL,
  -- waiver | free_agent | trade | commissioner
  type TEXT NOT NULL,
  -- complete | failed. A failed row is kept deliberately: a losing bid is
  -- evidence about the bidder and about the price of the player, and dropping
  -- it would leave only the winners, which is how a FAAB model learns that
  -- every player costs exactly what the winner paid.
  status TEXT NOT NULL,
  -- Epoch milliseconds, as Sleeper sends them. Kept raw so recency weighting
  -- never depends on a timezone this app guessed.
  created_ms INTEGER,
  creator_user_id TEXT,
  -- The rosters party to the transaction, as JSON. A waiver has one; a trade
  -- has two or more.
  roster_ids_json TEXT NOT NULL,
  -- { sleeper_player_id: roster_id }, exactly as Sleeper reports it. Player ids
  -- are resolved on read rather than on write, so a player the dictionary has
  -- not seen yet does not cost us the transaction.
  adds_json TEXT NOT NULL,
  drops_json TEXT NOT NULL,
  -- The FAAB bid, in dollars. NULL rather than 0 when the transaction carried
  -- no bid at all: a free-agent add and a $0 waiver claim are different events,
  -- and averaging the first into the second drags every expected cost down.
  waiver_bid INTEGER,
  -- FAAB moved directly between teams inside a trade, as JSON. It changes what
  -- a manager has left to spend, which is an input to competition pressure.
  budget_moves_json TEXT NOT NULL,
  -- Draft picks moved in a trade, as JSON. Not valued anywhere -- this app has
  -- no pick-value model and will not invent one -- but a trade whose entire
  -- content is picks must not be read as a trade of nobody.
  draft_picks_json TEXT NOT NULL,
  -- Sleeper's own note ("This player was claimed by another owner."), which is
  -- the difference between losing a bid and having a claim voided.
  note TEXT,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (sleeper_league_id, transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_league_transactions_week
  ON league_transactions (sleeper_league_id, week);

CREATE INDEX IF NOT EXISTS idx_league_transactions_season
  ON league_transactions (season, type, status);

-- The chain of seasons behind one league.
--
-- Sleeper links a league to the season before it through `previous_league_id`,
-- so a league that has run for four years is four ids. This records the walk,
-- so a profile built from "multiple seasons" can say which seasons, and a
-- league in its first year can say that instead of looking like a league whose
-- history failed to load.
CREATE TABLE IF NOT EXISTS league_lineage (
  -- The league the user actually selected, which anchors the chain.
  root_sleeper_league_id TEXT NOT NULL,
  sleeper_league_id TEXT NOT NULL,
  season TEXT NOT NULL,
  name TEXT,
  -- 0 for the selected league, 1 for last season, and so on.
  depth INTEGER NOT NULL,
  -- That season's FAAB budget. Stored per season because a league that moved
  -- from $100 to $200 makes every historical bid mean something different, and
  -- a bid is only comparable across seasons as a percentage of its own budget.
  waiver_budget INTEGER,
  total_rosters INTEGER,
  discovered_at TEXT NOT NULL,
  PRIMARY KEY (root_sleeper_league_id, sleeper_league_id)
);

-- What has actually been read, per league-season and week.
--
-- Without this a thin answer is indistinguishable from a quiet league: no rows
-- for week 9 could mean nobody moved, or could mean week 9 was never fetched.
CREATE TABLE IF NOT EXISTS league_transaction_sync (
  sleeper_league_id TEXT NOT NULL,
  week INTEGER NOT NULL,
  transactions INTEGER NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (sleeper_league_id, week)
);

-- Who each roster belongs to, per season.
--
-- A manager is a Sleeper user id; a roster id is only that user's seat in one
-- season, and the seats are reshuffled between seasons. Joining last season's
-- bids to this season's managers through roster_id alone would attribute one
-- manager's record to another, which is worse than having no history at all.
CREATE TABLE IF NOT EXISTS league_managers (
  root_sleeper_league_id TEXT NOT NULL,
  sleeper_league_id TEXT NOT NULL,
  season TEXT NOT NULL,
  roster_id INTEGER NOT NULL,
  user_id TEXT,
  display_name TEXT,
  -- Sleeper reports FAAB spent, not FAAB left. Remaining is derived against
  -- that season's budget, and stays NULL when either number is missing rather
  -- than defaulting to a full wallet.
  waiver_budget_used INTEGER,
  -- The season record, which is the only evidence available for "is this team
  -- plausibly going to the playoffs" -- the gate that keeps December schedules
  -- out of an August ranking. Nullable: a season that has not started has no
  -- record, and 0-0 is a record.
  wins INTEGER,
  losses INTEGER,
  is_mine INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (sleeper_league_id, roster_id)
);

CREATE INDEX IF NOT EXISTS idx_league_managers_user
  ON league_managers (root_sleeper_league_id, user_id);

-- The decision feed: what changed since you last looked.
--
-- One table rather than more permanent UI, and the materiality rule lives in
-- code beside the arithmetic that produced the change. A row here is a claim
-- that a decision moved -- never that a refresh happened.
CREATE TABLE IF NOT EXISTS decision_feed_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sleeper_league_id TEXT,
  -- The identity of the underlying situation, not of this observation. Three
  -- sources describing one injury share a dedupe key and collapse into one
  -- event; the newest wording wins and the older row is superseded rather than
  -- deleted, so the feed can be audited.
  dedupe_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject_player_id TEXT,
  headline TEXT NOT NULL,
  detail TEXT,
  -- How big the change was in the units of whatever produced it, normalized to
  -- a 0-1 scale by the emitter. Only used for ordering and for the threshold.
  magnitude REAL NOT NULL,
  occurred_at TEXT NOT NULL,
  superseded_at TEXT,
  seen_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_decision_feed_open
  ON decision_feed_events (sleeper_league_id, dedupe_key, superseded_at);

CREATE INDEX IF NOT EXISTS idx_decision_feed_recent
  ON decision_feed_events (occurred_at);

-- Prior scoring decompositions, so "why did his rank move" can be answered
-- instead of narrated.
--
-- The requirement that shapes this table is the negative one: a refresh that
-- changes no input must produce no movement. So every snapshot carries a hash
-- of the inputs that produced it, and a new snapshot is only written when that
-- hash differs from the last one stored. Without it, the feed would report
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
