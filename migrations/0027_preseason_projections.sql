-- Market-derived preseason projections, imported by hand.
--
-- Deliberately NOT prop_snapshots/player_props. Those tables hold lines a
-- sportsbook is taking bets on, at two horizons separated by `scope`. What
-- lands here is a season fantasy-points estimate somebody's model produced from
-- market inputs — a different claim, and the app only gets to keep both if it
-- never lets one wear the other's name. A `scope = 'projection'` bolted onto
-- the market tables would have been the cheap version of that, and the first
-- query that forgot to filter on it would have put a projection on the board
-- labelled as Vegas.
--
-- Every column here answers a question somebody will ask about a number on a
-- draft card: where did it come from, when was it taken, and under whose rules.
CREATE TABLE IF NOT EXISTS preseason_projection_snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  season        TEXT NOT NULL,
  source        TEXT NOT NULL,
  -- The date the numbers describe, which is the source's own "last updated"
  -- stamp where it publishes one -- not the date somebody pasted them.
  captured_at   TEXT NOT NULL,
  -- A stable key built from the scoring values themselves, so two leagues that
  -- score identically share a snapshot and two that do not never can. See
  -- core/startWho/scoring.ts for why this is identity rather than metadata: a
  -- six-point-pass-TD projection read by a four-point league is fifty points
  -- wrong on every quarterback and right on everybody else.
  scoring_key   TEXT NOT NULL,
  scoring_json  TEXT NOT NULL,
  scoring_label TEXT NOT NULL,
  imported_at   TEXT NOT NULL,
  capture_label TEXT NOT NULL,
  -- The source's own wording, kept verbatim: "Aug 22 at 9:01 AM".
  last_updated  TEXT,
  raw_input     TEXT NOT NULL
);

-- One snapshot per season, per source, per capture date, per scoring profile.
-- Re-importing the same capture revises it; a later capture is a new one and
-- both survive, so preseason history is preserved rather than overwritten.
CREATE UNIQUE INDEX IF NOT EXISTS idx_preseason_projection_identity
  ON preseason_projection_snapshots (season, source, captured_at, scoring_key);

CREATE INDEX IF NOT EXISTS idx_preseason_projection_lookup
  ON preseason_projection_snapshots (season, scoring_key, captured_at DESC);

CREATE TABLE IF NOT EXISTS preseason_projections (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id        INTEGER NOT NULL REFERENCES preseason_projection_snapshots (id) ON DELETE CASCADE,
  -- Null when the name did not resolve. The row is still stored so it can be
  -- repaired from the Review queue, and it contributes to nothing until it is.
  player_id          TEXT REFERENCES players (id),
  source_player_name TEXT NOT NULL,
  source_team        TEXT,
  team_code          TEXT,
  position           TEXT,
  points             REAL NOT NULL,
  -- The source's own ordinal and its agreement fraction. Stored for audit and
  -- for explaining an import; neither is a ranking input and neither is shown.
  -- StartWho's rank is not a points order -- Gibbs is 1st at 292.0 while Josh
  -- Allen is 14th at 386.1 -- so it is their draft-value opinion, not a fact.
  source_rank        INTEGER,
  position_rank      INTEGER,
  source_count       TEXT,
  raw_json           TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_preseason_projections_snapshot
  ON preseason_projections (snapshot_id);
CREATE INDEX IF NOT EXISTS idx_preseason_projections_player
  ON preseason_projections (player_id);
