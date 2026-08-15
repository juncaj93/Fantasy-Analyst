-- Nine more columns from a file this app already downloads and parses.
--
-- 0016 stored volume: attempts, carries, targets, receptions, target share and
-- WOPR. That is everything the role-change detector needs and nothing else, and
-- three later features each turned out to need one more column from the same
-- row:
--
--   * touchdown dependency cannot be told from volume alone. A back with four
--     carries a game and three touchdowns in four weeks and a back with fifteen
--     carries and three touchdowns look identical in the stored columns, and
--     they are opposite lineup decisions.
--   * role classification -- deep threat against possession receiver -- needs
--     the depth of the targets, which is what receiving air yards and air-yards
--     share carry. Alignment (slot against outside) is NOT in this file and is
--     not invented from these; see core/startsit/roleProfile.ts.
--   * defensive tendency by role needs to know who the opponent was. Without
--     `opponent_team` there is no way to ask what a defence has allowed, and
--     that is the largest single piece of matchup intelligence available for
--     free.
--
-- All nine are already inside the row the parser reads: the deepest column read
-- today is `wopr` at index 64, and every column added here sits at or before
-- it, so the ingest scans exactly as far into each line as it did before. The
-- cost is nine more string-to-number conversions on roughly 350 rows a week.
--
-- Nullable with no default, exactly like the 0016 columns and for the same
-- reason: a blank in the source means the source was silent, and a DEFAULT 0
-- would turn that silence into the strongest possible evidence of a player
-- doing nothing. Rows written before this migration keep NULL in the new
-- columns, and the read path treats them as unknown rather than as zero.

-- Who they played. The half of a matchup nothing in this app has ever stored.
ALTER TABLE player_usage_weeks ADD COLUMN opponent TEXT;

-- Production, so a fantasy total can be reconstructed for a stored game
-- without a second source. Yards are REAL because the source publishes them
-- that way for aggregated rows; touchdowns are whole.
ALTER TABLE player_usage_weeks ADD COLUMN pass_yards REAL;
ALTER TABLE player_usage_weeks ADD COLUMN pass_tds INTEGER;
ALTER TABLE player_usage_weeks ADD COLUMN rush_yards REAL;
ALTER TABLE player_usage_weeks ADD COLUMN rush_tds INTEGER;
ALTER TABLE player_usage_weeks ADD COLUMN rec_yards REAL;
ALTER TABLE player_usage_weeks ADD COLUMN rec_tds INTEGER;

-- Depth of target. `receiving_air_yards` divided by targets is average depth of
-- target, which separates a deep threat from a possession receiver; the share
-- says how much of the team's downfield attention he holds.
ALTER TABLE player_usage_weeks ADD COLUMN receiving_air_yards REAL;
ALTER TABLE player_usage_weeks ADD COLUMN air_yards_share REAL;

-- The defensive read groups by opponent and week. Without this it is a scan of
-- the season for every defence asked about, and Team asks about eight of them.
CREATE INDEX IF NOT EXISTS idx_player_usage_weeks_opponent
  ON player_usage_weeks (season, opponent, position, week);
