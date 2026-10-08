-- The betting-line reads behind every lineup read this week's games, not the season's.
--
-- Finding D5 of the October 2026 audit, approved by the owner as an additive
-- index only: nothing here changes, moves or deletes a row.
--
-- `latestForPlayers`, `previousForPlayers` and `kickoffsForPlayers` all ask
-- for a handful of players inside one slate window. With no index on
-- `game_start`, SQLite reached the window through `(scope, fetched_at)`: it
-- walked every weekly snapshot the season has stored and checked each one's
-- kickoff, then read every quote in each snapshot that passed and kept the few
-- for the players asked about. On production on 8 October that was 321
-- snapshots walked to find the 50 in the window, and 1,112 to 2,623 rows read
-- a call to return 30 to 307 rows, at roughly 640,000 rows a day.
--
-- `(scope, game_start)` lets the window be a range: the walk starts and stops
-- at this slate's kickoffs. `(snapshot_id, player_id)` lets each snapshot hand
-- back only the asked-for players' quotes instead of all of them. The kickoff
-- read also needs a one-character hint in `PropsRepo.kickoffsForPlayers`,
-- because its sort would otherwise keep the planner on the fetched_at index.
--
-- Cost: building these reads and writes each stored row once (about 17,000 on
-- 8 October), and every quote written after this costs one more index row
-- (about 1,000 a day). `idx_player_props_snapshot (snapshot_id)` is now a
-- prefix of the second index and could go, but dropping it is not additive,
-- so it stays.
CREATE INDEX IF NOT EXISTS idx_prop_snapshots_window
  ON prop_snapshots (scope, game_start);

CREATE INDEX IF NOT EXISTS idx_player_props_snapshot_player
  ON player_props (snapshot_id, player_id);
