-- What a player did last season, and what is expected of him this one.
--
-- Both come from Sleeper, which is already this project's source of truth for
-- everything about a league, and both are read from endpoints Sleeper serves
-- publicly. Nothing here is scraped out of the app's own UI.
--
-- Two tables because the two have nothing in common but a player id. Season
-- statistics are a bulk fact about a finished year: one request returns every
-- player, they stop changing once the season ends, and they are refreshed on
-- the same nightly clock as the player dictionary. An outlook is a paragraph
-- about one player, fetched only when somebody actually opens his card, and
-- kept long enough that opening it again costs nothing.

-- Last season's line, per player.
--
-- Deliberately narrow. Sleeper's stats payload carries about 260 columns and
-- the expanded card asks two questions of it — did he play, and where did he
-- finish — so the rest is not stored. `points_half_ppr` is kept because it is
-- what the rank is computed from, and a rank with no visible basis is a number
-- nobody can check.
CREATE TABLE IF NOT EXISTS player_season_stats (
  player_id TEXT NOT NULL,
  season TEXT NOT NULL,
  -- Games played, as Sleeper counts them. Null when he did not appear at all,
  -- which is not the same fact as zero and must not be flattened into it.
  games_played INTEGER,
  points_half_ppr REAL,
  -- Where that finished him among players at his position who scored at all.
  -- Computed here rather than taken from the payload: see `seasonStats.ts`.
  position_rank_half_ppr INTEGER,
  -- What Sleeper's own payload said the rank was, kept only so the two can be
  -- compared. Sleeper ranks every player on its books including ones who never
  -- played, so the two disagree in the tail by design.
  provider_position_rank INTEGER,
  position TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (player_id, season)
);

CREATE INDEX IF NOT EXISTS idx_player_season_stats_season ON player_season_stats (season);

-- One ingest of the above, so the card can say how old it is and Setup can say
-- how much of it landed.
CREATE TABLE IF NOT EXISTS player_season_stats_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  source TEXT NOT NULL,
  -- Rows the provider returned, rows that matched a player this app knows,
  -- and rows that did not. The third number is the one worth watching: a
  -- pipeline that silently drops most of its input looks identical to one that
  -- works, right up until a card is blank.
  rows_returned INTEGER NOT NULL,
  rows_matched INTEGER NOT NULL,
  rows_unmatched INTEGER NOT NULL,
  -- Players whose computed rank differs from the provider's. Expected to be
  -- large and harmless; a sudden move means one of the two changed method.
  rank_disagreements INTEGER NOT NULL DEFAULT 0,
  note TEXT
);

-- The season outlook, as written by whoever wrote it.
--
-- `source` is not decoration: this text is editorial content that Sleeper
-- serves rather than something Sleeper generated, and the card says so. An
-- attribution that is stored but never shown is the same as no attribution.
CREATE TABLE IF NOT EXISTS player_outlooks (
  player_id TEXT NOT NULL,
  season TEXT NOT NULL,
  -- The provider's own heading, e.g. '2026 Season Outlook'.
  title TEXT,
  -- The full text as received. The card shows the first few sentences; the
  -- whole thing is kept so that decision can be changed without re-fetching,
  -- and so a truncation bug is recoverable rather than lossy.
  body TEXT NOT NULL,
  source TEXT,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (player_id, season)
);

-- Misses are cached too, and for the same reason hits are.
--
-- Most players have no outlook — rookies, backups, anyone the provider did not
-- write about. Without this, every open of one of those cards is another
-- request to Sleeper for an answer that has not changed, which is exactly the
-- unbounded third-party fetching this project does not do.
CREATE TABLE IF NOT EXISTS player_outlook_misses (
  player_id TEXT NOT NULL,
  season TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  reason TEXT,
  PRIMARY KEY (player_id, season)
);
