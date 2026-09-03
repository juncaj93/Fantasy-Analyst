-- Remember that a gap scan found nothing, so the next tick does not repeat it.
--
-- `catchUpOneWeek` exists to fill a week an outage left behind. To find one it
-- asked the reports table which weeks it holds -- `SELECT DISTINCT week WHERE
-- season = ?` -- and that reads every row the season has. The answer is "no
-- gap" almost always and forever after the last one is filled, so the scan is
-- overwhelmingly a question already answered.
--
-- On the five-minute tick that is 288 scans a day against a table the backfill
-- had just filled with a whole season, which is how a single-user app reached
-- D1's 5,000,000 daily row-read limit on 2026-09-01 and began erroring on every
-- request that touched the database.
--
-- This column is the answer, kept. It records the `caught_up_through` the feed
-- was at when a scan last came back clean, and the scan is skipped while the
-- feed has not moved past it. A new week arriving advances `caught_up_through`
-- beyond the watermark and the scan runs once more -- which is right, because a
-- week that arrives while an earlier one is still missing is exactly how the
-- gap this looks for appears.
--
-- Nullable and unset, so every feed re-scans once after this ships and writes
-- its own watermark from a real answer rather than from a default.
--
-- Expand-only: three added columns, no rewrite and no drop. The release before
-- this one reads `SELECT *` and ignores what it does not know.

ALTER TABLE injury_source_state ADD COLUMN gaps_checked_through INTEGER;
ALTER TABLE usage_source_state ADD COLUMN gaps_checked_through INTEGER;
ALTER TABLE nflverse_source_state ADD COLUMN gaps_checked_through INTEGER;
