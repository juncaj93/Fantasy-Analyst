-- An ADP snapshot with no season stamped on it.
--
-- `adp_snapshots` has always carried `captured_at` — when the file arrived —
-- but nothing that says which season's draft it prices. `AdpRepo.latest()`
-- reads "newest row in the table" as "the current board", and for as long as
-- exactly one season's worth of snapshots has ever existed that has been true
-- by accident. It stops being true the day last year's final import is still
-- the newest row because nobody has imported this year's yet: the app would
-- keep serving a frozen 2026 board as "current" straight through the 2027
-- draft, with nothing on screen saying the numbers are a year old.
--
-- The fix is the same shape as every other source in this app — see
-- `core/season/context.ts` — stamp the season at write time and read the app's
-- own season back, rather than trusting whichever row sorts first.
--
-- `NOT NULL DEFAULT ''` rather than a bare nullable column, because a snapshot
-- with no season is exactly the unstamped state this migration exists to
-- retire, and every future import (see `AdpRepo.save`) is required to supply
-- one. The default only matters for the instant between adding the column and
-- the backfill below running.
ALTER TABLE adp_snapshots ADD COLUMN season TEXT NOT NULL DEFAULT '';

-- Backfill: every snapshot that already exists gets a season derived from the
-- date it was captured, using the same rollover rule the rest of the app uses
-- — March (month 03) is when the league year turns over, so a January or
-- February capture prices the season that is still finishing, not the one
-- about to start. This is a guess for exactly the rows that predate this
-- migration; every row from here on states its season directly instead of
-- having one inferred from a timestamp.
UPDATE adp_snapshots
   SET season = CASE
         WHEN CAST(strftime('%m', captured_at) AS INTEGER) >= 3
           THEN strftime('%Y', captured_at)
         ELSE CAST(CAST(strftime('%Y', captured_at) AS INTEGER) - 1 AS TEXT)
       END
 WHERE season = ''
   AND captured_at IS NOT NULL
   AND strftime('%Y', captured_at) IS NOT NULL;

-- The read this column exists to serve: "the newest snapshot for *this*
-- season", not the newest snapshot of any season. Without the season leading
-- the index that query is a scan of every snapshot ever imported.
CREATE INDEX IF NOT EXISTS idx_adp_snapshots_season ON adp_snapshots (season, captured_at DESC, id DESC);
