-- The objective manager-history ledger, and the checkpoints that fill it.
--
-- What this replaces: `LeagueStrategyService.refreshProfiles` walked the
-- previous-league chain on every call and re-read the whole of it -- one league
-- lookup, one roster read, eighteen transaction weeks and every completed
-- draft, per season, three seasons deep. That is about sixty-six Sleeper
-- requests in one Worker invocation against a free-plan ceiling of fifty, so it
-- failed, and it would have kept re-reading history that can never change again
-- even if it had not.
--
-- The fix is not a smaller history. It is storing the facts once. Sleeper's
-- draft picks and transactions are immutable the moment their draft or week is
-- over, so a completed unit is fetched exactly once and every profile after
-- that is derived locally from these tables with no network at all. What is
-- left to bound is the *first* pass, and that is what the checkpoint table is
-- for: a batch stops before its request budget, writes where it got to, and the
-- next scheduled run resumes from there.
--
-- Raw facts here, derived profiles in `manager_intel_profiles`, and the two are
-- kept apart on purpose -- a profile can always be rebuilt from the ledger, so
-- a change to how a tendency is measured costs a recomputation rather than a
-- re-fetch.
--
-- Written with line comments only, like every migration here; see
-- tests/migrations.test.ts for what the remote D1 parser has accepted.

-- ------------------------------------------------------------ the chain ---
-- One row per season of a league's previous-league chain.
--
-- Sleeper exposes earlier seasons only as a linked list: a league carries
-- `previous_league_id` and nothing else. Walking it costs one request per
-- season, so the walk is done once and remembered -- and remembering it is what
-- lets a later batch start work on season three without re-reading seasons one
-- and two to find it.
--
-- `league_id` is this app's own league id, the anchor every row here hangs off;
-- `sleeper_league_id` is the Sleeper league for that particular season, which
-- is a *different* id every year and is what requests are actually made
-- against.
CREATE TABLE IF NOT EXISTS manager_history_seasons (
  league_id TEXT NOT NULL,
  sleeper_league_id TEXT NOT NULL,
  season TEXT NOT NULL,
  -- The next link in the chain. NULL means this is the oldest season Sleeper
  -- has, which is how the walk knows it is finished rather than interrupted.
  previous_league_id TEXT,
  -- Sleeper's own league status for that season: 'complete', 'in_season', ...
  status TEXT,
  -- 1 once this season's own link has been read, so a partial walk is visible.
  resolved INTEGER NOT NULL DEFAULT 0,
  discovered_at TEXT NOT NULL,
  PRIMARY KEY (league_id, sleeper_league_id)
);

CREATE INDEX IF NOT EXISTS idx_manager_history_seasons_season
  ON manager_history_seasons (league_id, season DESC);

-- ---------------------------------------------------------- identity map ---
-- Which Sleeper user held which roster slot, in one specific season.
--
-- This table exists because roster ids are season-local and get reused. In the
-- league this was built against, roster 4 was Anthonyberardo in 2024, Tupaz11
-- in 2025 and a manager who had never drafted here at all in 2026. A history
-- keyed on roster id would hand the newcomer a confident profile assembled from
-- two strangers.
--
-- So every roster-shaped fact Sleeper publishes -- a transaction's `roster_ids`,
-- a pick's `roster_id` -- is resolved to a Sleeper user id *through the season
-- it happened in*, and that resolution is what is stored here. A season whose
-- rosters were never read resolves to nothing, and unknown stays unknown rather
-- than inheriting whoever holds the slot now.
CREATE TABLE IF NOT EXISTS manager_history_rosters (
  league_id TEXT NOT NULL,
  sleeper_league_id TEXT NOT NULL,
  season TEXT NOT NULL,
  roster_id INTEGER NOT NULL,
  -- The identity. NULL for an orphaned roster, which Sleeper does publish.
  sleeper_user_id TEXT,
  -- Snapshots, for reading an audit. Never a matching key.
  display_name TEXT,
  team_name TEXT,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (sleeper_league_id, roster_id)
);

CREATE INDEX IF NOT EXISTS idx_manager_history_rosters_user
  ON manager_history_rosters (league_id, sleeper_user_id);

-- ---------------------------------------------------------- draft ledger ---
-- One row per historical draft, and one per pick in it.
--
-- Drafts come first in every batch because they are cheap -- two requests per
-- season buys a whole draft -- and because draft tendencies are the one
-- consumer that must not wait for the transaction backfill.
CREATE TABLE IF NOT EXISTS manager_history_drafts (
  draft_id TEXT PRIMARY KEY,
  league_id TEXT NOT NULL,
  sleeper_league_id TEXT NOT NULL,
  season TEXT NOT NULL,
  -- Sleeper's own: 'pre_draft' | 'drafting' | 'paused' | 'complete'.
  status TEXT NOT NULL,
  draft_type TEXT,
  rounds INTEGER,
  teams INTEGER,
  picks_ingested INTEGER NOT NULL DEFAULT 0,
  -- 1 only for a completed draft whose picks are stored. A one-way door: a
  -- finished draft never reopens, so a complete row is never re-fetched during
  -- ordinary maintenance.
  complete INTEGER NOT NULL DEFAULT 0,
  -- A cheap digest of what was stored, so a re-ingest that changes nothing is
  -- visible as such rather than looking like a fresh write.
  source_hash TEXT,
  ingested_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_manager_history_drafts_league
  ON manager_history_drafts (league_id, season DESC);

-- The picks themselves, as objective facts.
--
-- `sleeper_user_id` is resolved at ingest from `picked_by`, falling back to
-- that season's own roster map, and is NULL when neither answers. A NULL is a
-- pick that describes nobody's habits and is skipped by every derivation --
-- which is the correct outcome and is deliberately not a guess.
--
-- No market rank column, and its absence is a finding rather than an oversight:
-- `GET /draft/<id>/picks` returns a player snapshot and no price of any kind,
-- verified against 320 real historical picks by
-- `scripts/probe-sleeper-draft-history.mjs`. Reach-vs-ADP is therefore not
-- computable from Sleeper history, and today's ADP must never be substituted --
-- a 2024 pick measured against a 2026 ranking reports two years of player
-- movement as a manager's habit.
CREATE TABLE IF NOT EXISTS manager_draft_picks (
  draft_id TEXT NOT NULL,
  pick_no INTEGER NOT NULL,
  league_id TEXT NOT NULL,
  sleeper_league_id TEXT NOT NULL,
  season TEXT NOT NULL,
  round INTEGER NOT NULL,
  draft_slot INTEGER,
  -- That season's roster id. A label, never an identity. See the header above.
  roster_id INTEGER,
  sleeper_user_id TEXT,
  player_id TEXT,
  position TEXT,
  -- Years of NFL experience at draft time, from the pick's own metadata. 0 is a
  -- rookie, and this is the only trustworthy rookie signal in the payload.
  years_exp INTEGER,
  -- 1 when Sleeper marks the pick a keeper. Kept only because a keeper is not a
  -- draft decision and a derivation may want to exclude it.
  is_keeper INTEGER NOT NULL DEFAULT 0,
  -- Sleeper does not timestamp individual picks; this is the draft's own start
  -- time where it published one, and NULL otherwise.
  picked_at_ms INTEGER,
  ingested_at TEXT NOT NULL,
  PRIMARY KEY (draft_id, pick_no)
);

CREATE INDEX IF NOT EXISTS idx_manager_draft_picks_user
  ON manager_draft_picks (league_id, sleeper_user_id);

CREATE INDEX IF NOT EXISTS idx_manager_draft_picks_season
  ON manager_draft_picks (league_id, season DESC);

-- ----------------------------------------------------------- checkpoints ---
-- Where the backfill got to, per league, per dataset, per season.
--
-- The whole resumability story is this table. A batch reads it to know what to
-- do next, does one unit of work, writes the unit, and only then advances the
-- cursor -- so a crash between the write and the advance re-does one unit
-- idempotently rather than losing or duplicating it.
--
-- `cursor` means "the next thing to fetch" and its unit depends on the dataset:
-- for `transactions` it is the next week number to read, counting down from the
-- last week of the season toward week 1, because newest-first is what makes a
-- partial backfill useful. For `drafts` it is the number of drafts already
-- ingested for that season.
CREATE TABLE IF NOT EXISTS manager_history_checkpoints (
  league_id TEXT NOT NULL,
  -- 'drafts' | 'transactions'.
  dataset TEXT NOT NULL,
  sleeper_league_id TEXT NOT NULL,
  season TEXT NOT NULL,
  cursor INTEGER,
  -- 1 when this season's dataset can never yield anything new. Set only after a
  -- unit actually completed -- never optimistically, because a dataset marked
  -- complete early is a permanent silent hole.
  completed INTEGER NOT NULL DEFAULT 0,
  last_success_at TEXT,
  last_attempt_at TEXT,
  last_error TEXT,
  -- Sleeper requests spent against this unit, cumulative. The number the
  -- free-plan budget proof is made of.
  requests_used INTEGER NOT NULL DEFAULT 0,
  -- The ingest contract this row was written under. A bump forces a re-read of
  -- what it covers; unchanged, it is what lets completed work stay untouched.
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (league_id, dataset, sleeper_league_id)
);

CREATE INDEX IF NOT EXISTS idx_manager_history_checkpoints_pending
  ON manager_history_checkpoints (league_id, completed, season DESC);

-- ------------------------------------------------------- derived profiles ---
-- What the ledger adds up to, per manager, keyed by the only stable identity.
--
-- Separate from `manager_profiles`, which is keyed by roster id and files a
-- profile against the current league table for the screens that render one.
-- This is keyed by Sleeper user id and is the source of truth: a manager who
-- changes roster slots keeps his history, and a slot that changes hands does
-- not pass one along.
--
-- Everything needed to decide whether to trust a row is a column rather than
-- buried in the JSON -- the sample, the seasons, the coverage, the version --
-- so a consumer can shrink or ignore a profile without parsing it.
CREATE TABLE IF NOT EXISTS manager_intel_profiles (
  league_id TEXT NOT NULL,
  sleeper_user_id TEXT NOT NULL,
  -- 'draft' | 'trade' | 'transaction'. Three independent samples.
  kind TEXT NOT NULL,
  display_name TEXT,
  -- Observations behind it: picks, trades, or transactions.
  sample INTEGER NOT NULL DEFAULT 0,
  -- 1 only when the sample cleared the deriving module's own threshold.
  usable INTEGER NOT NULL DEFAULT 0,
  seasons_json TEXT NOT NULL DEFAULT '[]',
  -- How much of the history this rests on: seasons discovered against seasons
  -- complete, weeks read against weeks expected. Partial history must reduce
  -- influence rather than masquerade as complete, and this is what a consumer
  -- reads to do that.
  coverage_json TEXT NOT NULL DEFAULT '{}',
  profile_json TEXT NOT NULL,
  profile_version INTEGER NOT NULL DEFAULT 1,
  derived_at TEXT NOT NULL,
  PRIMARY KEY (league_id, sleeper_user_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_manager_intel_profiles_kind
  ON manager_intel_profiles (league_id, kind);

-- The room's own baselines, which belong to a league rather than to a manager.
--
-- A manager is described relative to his room wherever it is possible, because
-- an aggressive league would otherwise make every one of its members look
-- individually extreme -- and because "spends more than this room does" is the
-- claim the evidence actually supports.
CREATE TABLE IF NOT EXISTS league_intel_baselines (
  league_id TEXT NOT NULL,
  -- 'transaction' | 'trade'. Draft room priors already live in
  -- `league_draft_profiles` and are not duplicated here.
  kind TEXT NOT NULL,
  sample INTEGER NOT NULL DEFAULT 0,
  seasons_json TEXT NOT NULL DEFAULT '[]',
  baseline_json TEXT NOT NULL,
  profile_version INTEGER NOT NULL DEFAULT 1,
  derived_at TEXT NOT NULL,
  PRIMARY KEY (league_id, kind)
);

-- ----------------------------------------------------- transaction ledger ---
-- The transaction store already exists (migration 0020) and is reused verbatim
-- rather than duplicated: `league_transactions` keeps the whole payload beside
-- extracted columns, upserts on `transaction_id` so a pending claim that later
-- completes corrects itself, and `league_transaction_weeks` already records
-- which weeks have been read and which can never change again.
--
-- Two things it did not carry, both needed once history spans seasons:
--
--   * which Sleeper league the row came from. The app's own `league_id` is the
--     current season's league, so without this a 2024 row and a 2026 row are
--     indistinguishable in provenance even though they were fetched from
--     different endpoints;
--   * whether the week was read as part of a bounded historical backfill, which
--     is what lets diagnostics separate "this week is missing" from "this week
--     has not come up in the queue yet".
--
-- Both nullable, because every row stored before this migration predates them
-- and an unknown source is read as unknown rather than as the current league.
ALTER TABLE league_transactions ADD COLUMN sleeper_league_id TEXT;

ALTER TABLE league_transaction_weeks ADD COLUMN sleeper_league_id TEXT;
