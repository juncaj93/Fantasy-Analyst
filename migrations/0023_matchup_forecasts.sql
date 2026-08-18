-- Matchup forecasts, kept so the win probability can eventually be graded.
--
-- The point of this table is a sentence nobody can say yet: "when Fantasy
-- Analyst says 70%, that happens about 70% of the time". Calibration is the one
-- claim a probability model has to earn, it can only be earned over a season or
-- more of samples, and a sample that was not recorded at the time is gone --
-- the state that produced a Sunday-afternoon forecast is not reconstructable
-- afterwards from anything Sleeper still publishes.
--
-- So one row per roster per week, written as the week runs and completed when
-- it finishes. Deliberately *not* a trace: no per-simulation output, no
-- per-player distribution, nothing that grows with the model. Four thousand
-- simulated afternoons produce one row of about twenty numbers.
--
-- The two forecasts kept per row answer two different questions. The first one
-- is the honest calibration sample -- it was made before anything was known,
-- and it is written once and never updated. The latest one is what the app most
-- recently believed, which is what a "how did it move" view would read. A model
-- graded on its latest forecast would grade itself at kickoff-minus-one-minute
-- and score suspiciously well.
--
-- Season and week are in the key, so week 16 of one season can never collide
-- with week 16 of another. That is not a hypothetical: this whole table is only
-- useful across several seasons, which is exactly when a season-less key starts
-- silently overwriting history.
--
-- Written with line comments only, like every migration here -- see 0013.

CREATE TABLE IF NOT EXISTS matchup_forecasts (
  league_id TEXT NOT NULL,
  season TEXT NOT NULL,
  week INTEGER NOT NULL,
  roster_id INTEGER NOT NULL,
  -- Sleeper's own pairing id for the week. NULL for a roster on a bye.
  matchup_id INTEGER,
  opponent_roster_id INTEGER,
  -- Which model produced this. Without it a calibration bucket silently mixes
  -- two models and reports the average of two different questions.
  model_version TEXT NOT NULL,

  -- The first forecast of the week, written once. The calibration sample.
  first_forecast_at TEXT NOT NULL,
  -- 'pregame' | 'live' | 'final' at the moment the first forecast was made. A
  -- row whose first sighting was already live is not a pregame sample and must
  -- not be graded as one.
  first_phase TEXT NOT NULL,
  first_win_probability REAL,
  first_projected_final REAL,
  -- The actual score at the moment of that forecast, so a live-first sighting
  -- can still be interpreted.
  first_actual REAL,

  -- What the app most recently believed. Overwritten on every material change.
  latest_forecast_at TEXT NOT NULL,
  latest_phase TEXT NOT NULL,
  latest_win_probability REAL,
  latest_projected_final REAL,
  latest_actual REAL,
  -- 'high' | 'medium' | 'low', from the model's own source-freshness read.
  latest_confidence TEXT,
  -- The matchup-state fingerprint the latest forecast was computed from.
  latest_fingerprint TEXT,

  -- Filled in once the week is over. NULL means not yet settled, which is a
  -- different thing from a score of zero.
  final_score REAL,
  opponent_final_score REAL,
  -- 1 won, 0 lost, NULL not settled. A tie is stored as NULL with both scores
  -- present, because a league's tie rule is the league's business.
  won INTEGER,
  settled_at TEXT,

  PRIMARY KEY (league_id, season, week, roster_id)
);

-- The two reads: one week of one league, and every settled row for a model.
CREATE INDEX IF NOT EXISTS idx_matchup_forecasts_week
  ON matchup_forecasts (league_id, season, week);

CREATE INDEX IF NOT EXISTS idx_matchup_forecasts_calibration
  ON matchup_forecasts (model_version, won);
