-- Drop the odds provider's raw answer from weekly snapshots stored before #305.
--
-- Until 29 September 2026 every stored game kept the provider's whole response
-- next to the lines taken out of it: 1.24-1.37 MB a game, 99% of the row,
-- against about 9 KB of quotes. Measured the same day, 213 weekly snapshots
-- held 148 MB, most of the database. Nothing has ever read it back: the quotes
-- and the game lines are extracted at fetch time, the consensus rows in
-- player_props are what every screen reads, and PropsRepo.get already has
-- SQLite drop it. #305 stopped storing it; this clears what was stored before.
--
-- Only the provider payload goes. Each row keeps its quotes, game lines,
-- provider, event and timestamps, and `raw` becomes JSON null, exactly the
-- shape a snapshot written since #305 has. No player_props row is touched.
--
-- Weekly snapshots only. Season-long and preseason rows share this table under
-- another scope and are left exactly as they are. Rows that no longer carry a
-- payload are skipped, so running this twice changes nothing the second time.
UPDATE prop_snapshots
SET raw_json = json_set(raw_json, '$.raw', json('null'))
WHERE scope = 'week'
  AND json_valid(raw_json)
  AND json_type(raw_json, '$.raw') = 'object';
