-- Fantasy Analyst — initial schema.
--
-- Design notes:
--  * The evidence ledger is the source of truth for news. `player_signal_cache`
--    is derived and may be rebuilt from the ledger at any time.
--  * User corrections live in `evidence_items.user_override` + `user_reviews`
--    and are never overwritten by reprocessing.
--  * ADP snapshots are immutable once imported ("frozen for the draft").

-- ---------------------------------------------------------------- players ---
CREATE TABLE IF NOT EXISTS players (
  id                TEXT PRIMARY KEY,
  sleeper_player_id TEXT UNIQUE,
  full_name         TEXT NOT NULL,
  first_name        TEXT NOT NULL DEFAULT '',
  last_name         TEXT NOT NULL DEFAULT '',
  team              TEXT NOT NULL DEFAULT '',
  position          TEXT NOT NULL DEFAULT '',
  status            TEXT,
  active            INTEGER NOT NULL DEFAULT 1,
  normalized_name   TEXT NOT NULL,
  aliases_json      TEXT NOT NULL DEFAULT '[]',
  external_ids_json TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_players_normalized ON players (normalized_name);
CREATE INDEX IF NOT EXISTS idx_players_position ON players (position, active);
CREATE INDEX IF NOT EXISTS idx_players_team ON players (team);

CREATE TABLE IF NOT EXISTS player_aliases (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id        TEXT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  alias            TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  source           TEXT NOT NULL,
  confidence       REAL NOT NULL DEFAULT 1.0,
  created_at       TEXT NOT NULL,
  UNIQUE (player_id, normalized_alias)
);
CREATE INDEX IF NOT EXISTS idx_aliases_normalized ON player_aliases (normalized_alias);

-- ---------------------------------------------------------------- leagues ---
CREATE TABLE IF NOT EXISTS leagues (
  id                    TEXT PRIMARY KEY,
  sleeper_league_id     TEXT NOT NULL UNIQUE,
  name                  TEXT NOT NULL,
  season                TEXT NOT NULL,
  total_rosters         INTEGER NOT NULL DEFAULT 0,
  scoring_settings_json TEXT NOT NULL DEFAULT '{}',
  roster_positions_json TEXT NOT NULL DEFAULT '[]',
  league_settings_json  TEXT NOT NULL DEFAULT '{}',
  draft_id              TEXT,
  is_selected           INTEGER NOT NULL DEFAULT 0,
  last_synced_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rosters (
  league_id    TEXT NOT NULL REFERENCES leagues (id) ON DELETE CASCADE,
  roster_id    INTEGER NOT NULL,
  owner_id     TEXT,
  owner_name   TEXT,
  players_json TEXT NOT NULL DEFAULT '[]',
  starters_json TEXT NOT NULL DEFAULT '[]',
  reserve_json TEXT NOT NULL DEFAULT '[]',
  is_mine      INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (league_id, roster_id)
);

-- ----------------------------------------------------------------- drafts ---
CREATE TABLE IF NOT EXISTS drafts (
  id                 TEXT PRIMARY KEY,
  sleeper_draft_id   TEXT NOT NULL UNIQUE,
  league_id          TEXT NOT NULL REFERENCES leagues (id) ON DELETE CASCADE,
  status             TEXT NOT NULL,
  type               TEXT NOT NULL,
  season             TEXT NOT NULL,
  rounds             INTEGER NOT NULL DEFAULT 0,
  teams              INTEGER NOT NULL DEFAULT 0,
  slot_to_roster_json TEXT NOT NULL DEFAULT '{}',
  settings_json      TEXT NOT NULL DEFAULT '{}',
  adp_snapshot_id    INTEGER REFERENCES adp_snapshots (id),
  last_synced_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS draft_picks (
  draft_id     TEXT NOT NULL REFERENCES drafts (id) ON DELETE CASCADE,
  pick_no      INTEGER NOT NULL,
  round        INTEGER NOT NULL,
  pick_in_round INTEGER NOT NULL,
  draft_slot   INTEGER NOT NULL,
  player_id    TEXT,
  roster_id    INTEGER,
  picked_by    TEXT,
  raw_json     TEXT NOT NULL DEFAULT '{}',
  picked_at    TEXT,
  PRIMARY KEY (draft_id, pick_no)
);
CREATE INDEX IF NOT EXISTS idx_draft_picks_player ON draft_picks (draft_id, player_id);

-- -------------------------------------------------------------------- ADP ---
CREATE TABLE IF NOT EXISTS adp_snapshots (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  source         TEXT NOT NULL,
  label          TEXT NOT NULL,
  captured_at    TEXT NOT NULL,
  imported_at    TEXT NOT NULL,
  raw_file_hash  TEXT NOT NULL,
  row_count      INTEGER NOT NULL DEFAULT 0,
  matched_count  INTEGER NOT NULL DEFAULT 0,
  unmatched_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (source, raw_file_hash)
);

CREATE TABLE IF NOT EXISTS adp_rows (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id        INTEGER NOT NULL REFERENCES adp_snapshots (id) ON DELETE CASCADE,
  player_id          TEXT REFERENCES players (id),
  source_name        TEXT NOT NULL,
  source_player_name TEXT NOT NULL,
  source_team        TEXT,
  source_position    TEXT,
  adp                REAL,
  rank               INTEGER,
  match_status       TEXT NOT NULL DEFAULT 'unmatched',
  match_method       TEXT,
  match_reason       TEXT,
  raw_json           TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_adp_rows_snapshot ON adp_rows (snapshot_id);
CREATE INDEX IF NOT EXISTS idx_adp_rows_player ON adp_rows (snapshot_id, player_id);

-- --------------------------------------------------------------- evidence ---
CREATE TABLE IF NOT EXISTS evidence_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key        TEXT NOT NULL UNIQUE,
  player_id         TEXT NOT NULL REFERENCES players (id),
  source_type       TEXT NOT NULL,
  source_name       TEXT NOT NULL,
  source_message_id TEXT,
  source_date       TEXT NOT NULL,
  excerpt           TEXT NOT NULL,
  context_summary   TEXT,
  category          TEXT,
  polarity          TEXT NOT NULL,
  magnitude         INTEGER NOT NULL DEFAULT 1,
  confidence        TEXT NOT NULL,
  confidence_score  REAL NOT NULL DEFAULT 0,
  rule_id           TEXT,
  review_status     TEXT NOT NULL DEFAULT 'pending',
  user_override_json TEXT,
  notes_json        TEXT NOT NULL DEFAULT '[]',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_player ON evidence_items (player_id, source_date DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_review ON evidence_items (review_status, confidence_score DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_message ON evidence_items (source_message_id);

-- Identity ambiguity queue: a real signal we could not attribute to one player.
CREATE TABLE IF NOT EXISTS identity_reviews (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key        TEXT NOT NULL UNIQUE,
  source_message_id TEXT NOT NULL,
  source_date       TEXT NOT NULL,
  excerpt           TEXT NOT NULL,
  matched_text      TEXT NOT NULL,
  reason            TEXT NOT NULL,
  candidates_json   TEXT NOT NULL DEFAULT '[]',
  proposed_polarity TEXT,
  proposed_category TEXT,
  status            TEXT NOT NULL DEFAULT 'pending',
  resolved_player_id TEXT REFERENCES players (id),
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_identity_reviews_status ON identity_reviews (status, created_at DESC);

CREATE TABLE IF NOT EXISTS user_reviews (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  evidence_item_id    INTEGER REFERENCES evidence_items (id) ON DELETE CASCADE,
  identity_review_id  INTEGER REFERENCES identity_reviews (id) ON DELETE CASCADE,
  action              TEXT NOT NULL,
  previous_value_json TEXT NOT NULL DEFAULT '{}',
  new_value_json      TEXT NOT NULL DEFAULT '{}',
  changed_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_reviews_evidence ON user_reviews (evidence_item_id);

CREATE TABLE IF NOT EXISTS player_signal_cache (
  player_id            TEXT PRIMARY KEY REFERENCES players (id) ON DELETE CASCADE,
  raw_positive         REAL NOT NULL DEFAULT 0,
  raw_negative         REAL NOT NULL DEFAULT 0,
  raw_net              REAL NOT NULL DEFAULT 0,
  raw_items            INTEGER NOT NULL DEFAULT 0,
  recent7_net          REAL NOT NULL DEFAULT 0,
  recent21_net         REAL NOT NULL DEFAULT 0,
  recent21_items       INTEGER NOT NULL DEFAULT 0,
  season_net           REAL NOT NULL DEFAULT 0,
  pending_count        INTEGER NOT NULL DEFAULT 0,
  mixed_count          INTEGER NOT NULL DEFAULT 0,
  category_breakdown_json TEXT NOT NULL DEFAULT '{}',
  last_evidence_at     TEXT,
  updated_at           TEXT NOT NULL
);

-- Processed newsletters, for idempotency.
CREATE TABLE IF NOT EXISTS newsletter_messages (
  message_id     TEXT PRIMARY KEY,
  source_id      TEXT NOT NULL,
  from_address   TEXT NOT NULL,
  subject        TEXT NOT NULL,
  received_at    TEXT NOT NULL,
  fingerprint    TEXT NOT NULL,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  pending_count  INTEGER NOT NULL DEFAULT 0,
  processed_at   TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'processed'
);
CREATE INDEX IF NOT EXISTS idx_newsletter_fingerprint ON newsletter_messages (fingerprint);

-- ------------------------------------------------------------------ vegas ---
CREATE TABLE IF NOT EXISTS prop_snapshots (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  provider   TEXT NOT NULL,
  event_id   TEXT NOT NULL,
  game_start TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  raw_json   TEXT NOT NULL,
  UNIQUE (provider, event_id, fetched_at)
);
CREATE INDEX IF NOT EXISTS idx_prop_snapshots_event ON prop_snapshots (event_id, fetched_at DESC);

CREATE TABLE IF NOT EXISTS player_props (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id        INTEGER NOT NULL REFERENCES prop_snapshots (id) ON DELETE CASCADE,
  player_id          TEXT REFERENCES players (id),
  source_player_name TEXT NOT NULL,
  market             TEXT NOT NULL,
  line               REAL,
  over_price         INTEGER,
  under_price        INTEGER,
  book_count         INTEGER NOT NULL DEFAULT 0,
  books_json         TEXT NOT NULL DEFAULT '[]',
  consensus_method   TEXT NOT NULL DEFAULT 'none',
  implied_probability REAL,
  raw_json           TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_player_props_snapshot ON player_props (snapshot_id);
CREATE INDEX IF NOT EXISTS idx_player_props_player ON player_props (player_id, market);

-- --------------------------------------------------------------- settings ---
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  status     TEXT NOT NULL,
  detail     TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_log_kind ON sync_log (kind, started_at DESC);
