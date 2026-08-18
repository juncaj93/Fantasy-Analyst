-- League strategy: transactions, market attention, and manager history.
--
-- Three tables, and each of them exists because the thing it stores cannot be
-- recomputed later from anything else.
--
-- Sleeper's transaction endpoint is indexed by week and has no all-weeks form.
-- A card that wants "what have waivers cost in this league" would otherwise
-- make eighteen requests on every page load, and the answers for finished weeks
-- never change. So finished weeks are stored once and read from here.
--
-- The trending list is worse than merely expensive: it is a snapshot of a
-- moment that is gone. Sleeper publishes counts for a rolling window and keeps
-- no history, so `add rate accelerated 6x` is unobtainable unless somebody was
-- writing the list down beforehand. That is the whole reason for the second
-- table -- one row per player per capture, and velocity is a subtraction across
-- two of them.
--
-- Manager profiles are derived and could in principle be recomputed, but only
-- from several seasons of transactions across the previous-league chain, which
-- is many requests to produce two sentences on a card. They are cached with the
-- sample size and the computation time beside them so a stale profile is
-- visibly stale rather than quietly wrong.
--
-- Written with line comments only, like every migration here: `wrangler d1
-- migrations apply --remote` posts the file to D1 unsplit and its parser is not
-- the one `--local` uses. A block comment in 0013 applied cleanly locally and
-- died on the deploy with "incomplete input".

-- One Sleeper transaction, stored as it arrived.
--
-- The payload is kept verbatim alongside the extracted columns. Sleeper's shape
-- has changed before and will again, and a stored row that can only be read
-- through today's parser is a row that has to be re-fetched to answer
-- tomorrow's question -- which for a finished week may no longer be possible.
--
-- `waiver_bid` is deliberately its own column and deliberately not called
-- `waiver_budget`: Sleeper uses that name for FAAB moved *in a trade*, which is
-- a different quantity, and conflating them is the standard way a budget
-- reconstruction goes wrong.
CREATE TABLE IF NOT EXISTS league_transactions (
  league_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  season TEXT NOT NULL,
  -- Sleeper's `leg`: the week the transaction belongs to.
  week INTEGER NOT NULL,
  -- 'waiver' | 'free_agent' | 'trade' | anything Sleeper adds later.
  txn_type TEXT NOT NULL,
  -- 'complete' | 'failed' | 'pending'. A failed waiver is the only supported
  -- window onto what somebody else was willing to pay, so failures are kept.
  status TEXT NOT NULL,
  -- Epoch milliseconds, as Sleeper sends it.
  created_at_ms INTEGER,
  -- The winning (or losing) FAAB bid on a waiver claim. NULL on every other
  -- kind of row, and NULL rather than 0 on a claim that carried no bid.
  waiver_bid INTEGER,
  -- FAAB moved between rosters as part of a trade. Not a bid.
  faab_traded INTEGER NOT NULL DEFAULT 0,
  draft_picks_moved INTEGER NOT NULL DEFAULT 0,
  -- JSON arrays/objects exactly as received.
  roster_ids_json TEXT NOT NULL DEFAULT '[]',
  adds_json TEXT,
  drops_json TEXT,
  -- The creating user id, when Sleeper says. A user id, not a roster id.
  creator TEXT,
  payload_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (league_id, transaction_id)
);

-- The read paths: one week of a league, and every trade across its history.
CREATE INDEX IF NOT EXISTS idx_league_transactions_week
  ON league_transactions (league_id, season, week);

CREATE INDEX IF NOT EXISTS idx_league_transactions_type
  ON league_transactions (league_id, txn_type, status);

-- Which weeks have been read, and whether they can still change.
--
-- The distinction this table exists for: a week that is over will never produce
-- another transaction, and a week in progress will. Without it, "no rows for
-- week 6" is ambiguous between "nobody did anything" and "we have not looked",
-- and a bid history built on the second is silently short.
CREATE TABLE IF NOT EXISTS league_transaction_weeks (
  league_id TEXT NOT NULL,
  season TEXT NOT NULL,
  week INTEGER NOT NULL,
  fetched_at TEXT NOT NULL,
  transactions_seen INTEGER NOT NULL DEFAULT 0,
  -- 1 once the week is over and the rows can never change again.
  settled INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (league_id, season, week)
);

-- One capture of Sleeper's global trending list.
--
-- Append-only, and small: fifty rows per capture, a handful of captures a day.
-- `lookback_hours` is stored per capture rather than assumed, because counts
-- from different windows are not comparable and the velocity code refuses to
-- compare them -- it needs the window to know that.
CREATE TABLE IF NOT EXISTS trending_snapshots (
  captured_at TEXT NOT NULL,
  -- 'add' | 'drop'.
  trend_type TEXT NOT NULL,
  lookback_hours INTEGER NOT NULL,
  -- The Sleeper player id, which is this app's canonical id for rostered NFL
  -- players. An id with no matching player row is kept: the trending list
  -- includes players the dictionary may not have synced yet, and dropping them
  -- would make the ranks lie.
  player_id TEXT NOT NULL,
  -- Position in the published list, 1-based, in Sleeper's own order.
  rank INTEGER NOT NULL,
  -- Adds (or drops) counted across all of Sleeper in the window.
  count INTEGER NOT NULL,
  PRIMARY KEY (captured_at, trend_type, player_id)
);

-- "The most recent capture" and "this player's history" are the only two reads.
CREATE INDEX IF NOT EXISTS idx_trending_snapshots_captured
  ON trending_snapshots (trend_type, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_trending_snapshots_player
  ON trending_snapshots (player_id, captured_at DESC);

-- A derived manager profile, cached with the evidence that produced it.
--
-- `sample` and `seasons_json` are not decoration: every consumer is required to
-- check the sample before quoting a tendency, and a cached profile that lost its
-- sample size on the way into storage is a profile that will be quoted
-- confidently off two trades.
CREATE TABLE IF NOT EXISTS manager_profiles (
  league_id TEXT NOT NULL,
  roster_id INTEGER NOT NULL,
  -- 'trade' | 'draft'. Two independent profiles, two independent samples.
  kind TEXT NOT NULL,
  owner_name TEXT,
  -- Observations behind it: trades for 'trade', picks for 'draft'.
  sample INTEGER NOT NULL DEFAULT 0,
  -- 1 only when the sample cleared the module's own threshold.
  confident INTEGER NOT NULL DEFAULT 0,
  seasons_json TEXT NOT NULL DEFAULT '[]',
  profile_json TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (league_id, roster_id, kind)
);

-- The room's own draft prior, which belongs to a league rather than a manager.
CREATE TABLE IF NOT EXISTS league_draft_profiles (
  league_id TEXT PRIMARY KEY,
  drafts_observed INTEGER NOT NULL DEFAULT 0,
  picks_observed INTEGER NOT NULL DEFAULT 0,
  confident INTEGER NOT NULL DEFAULT 0,
  seasons_json TEXT NOT NULL DEFAULT '[]',
  profile_json TEXT NOT NULL,
  computed_at TEXT NOT NULL
);

-- The roster settings blob, which is where the FAAB spend actually lives.
--
-- Sleeper keeps a running `waiver_budget_used` on each roster's `settings`, and
-- it is the authoritative figure -- better than any reconstruction from
-- transactions, because it already accounts for FAAB that moved in a trade.
-- The sync had been discarding the whole blob, so the one number the budget
-- layer needs was being fetched every league sync and thrown away.
--
-- Stored whole rather than as one column: `settings` also carries the record,
-- the points and the waiver position, and a second migration to add each of
-- them one at a time is a worse trade than keeping the JSON Sleeper sent.
ALTER TABLE rosters ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}';
