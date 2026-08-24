-- The NFL fixture list, one row per team per week.
--
-- The one schedule fact this app kept re-deriving from something else. Until
-- now "who does Denver play" was answered from `vegas_events`, which is the
-- right answer for the week in play — a game and its spread come off the same
-- row, so they cannot disagree — and no answer at all for the two questions the
-- DST streaming and playoff work is about: which week is a bye, and who a
-- defence plays in December. Neither has ever been priced by a book in October,
-- and neither is worth a paid entity to find out.
--
-- Written with line comments only, like every migration here. `wrangler d1
-- migrations apply --remote` posts the file to D1 unsplit and lets the server
-- parse it, which is not the parser `--local` uses; 0013 applied cleanly locally
-- and died on the deploy with "incomplete input" while it still carried a block
-- comment. tests/migrations.test.ts keeps this file inside that set.

-- Two rows per game, home and away, which is a deliberate denormalisation.
--
-- Every question a schedule is asked is asked from one team's point of view,
-- and the alternative is every reader writing the same `home_team = ? OR
-- away_team = ?` disjunction and half of them getting the `home` flag backwards.
-- The primary key then makes the ingest idempotent for nothing: re-reading an
-- unchanged file rewrites the same rows over the same keys.
--
-- `opponent` is nullable because a bye is the absence of a fixture, and this
-- table stores what the source published rather than an inferred rest week — a
-- stored absence has to be stored correctly for every team in every season, and
-- one missed ingest would give a team thirteen byes. `core/nfl/schedule.ts`
-- derives byes from what is here instead, which cannot drift from what is here.
--
-- `roof` is a property of a stadium, published months ahead and never revised:
-- the difference between a January game in Buffalo and one in Detroit. The same
-- source rows also carry `temp` and `wind` and those are deliberately NOT here
-- — they are post-game observations, blank for every unplayed game, and reading
-- one as a forecast would give this app a weather model that is perfectly
-- accurate about the past and silent about the future. This app has no weather
-- source and does not pretend to.
CREATE TABLE IF NOT EXISTS nfl_schedule (
  season TEXT NOT NULL,
  week INTEGER NOT NULL,
  team TEXT NOT NULL,
  opponent TEXT,
  home INTEGER NOT NULL,
  kickoff TEXT,
  roof TEXT,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (season, week, team)
);

-- The read this table exists to serve: one team's whole season, in week order.
--
-- Byes, future opponents and a playoff run are all "walk one team forward from
-- here", and the primary key leads on season rather than team — so without this
-- every one of them is a scan of the season. Sixteen rows against a few
-- thousand, on a table read on a planning screen rather than a hot path, but
-- the index is a few kilobytes and the scan is the kind that stops being free
-- the moment more than one season is stored.
CREATE INDEX IF NOT EXISTS idx_nfl_schedule_team ON nfl_schedule (season, team, week);
