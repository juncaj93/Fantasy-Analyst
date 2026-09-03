-- The "what did this feed last do?" reads stop scanning the whole ledger.
--
-- `latestRun()` on the injury and usage repositories both ask the same shape:
--
--   SELECT * FROM injury_source_runs ORDER BY fetched_at DESC, id DESC LIMIT 1
--
-- and both tables already carried an index -- on `(fetched_at DESC)` alone.
-- That covers only a prefix of the ORDER BY, and SQLite will not use a partial
-- index ordering to satisfy a two-key sort: it scans the table, builds a temp
-- B-tree over every row to resolve the `id DESC` tie-break, and only then takes
-- the one row the LIMIT asked for.
--
--   with (fetched_at DESC):              SCAN injury_source_runs
--                                        USE TEMP B-TREE FOR ORDER BY
--   with (fetched_at DESC, id DESC):     SCAN ... USING INDEX
--
-- Measured, not assumed: `d1 insights` attributes 876,966 rows to that injury
-- query across 79 calls -- 11,101 rows each, 17.5% of the daily allowance, to
-- return a single row. The usage twin is the same defect at 418 rows a call.
-- Both tables grow by one row per ingest and are read on any screen that asks
-- how fresh a feed is, so the cost climbs with the app's own history.
--
-- This is also the query #239 was named after. It was expensive then and it is
-- expensive now; what changed is how often it is called. That is the whole
-- lesson of this incident: a query's cost and a query's call count are two
-- different facts, and only their product is a bill.
--
-- Indexes only. No column changes, no data movement, no behaviour change --
-- the rows returned are identical, which is asserted in the test suite.

CREATE INDEX IF NOT EXISTS idx_injury_source_runs_latest
  ON injury_source_runs (fetched_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_usage_source_runs_latest
  ON usage_source_runs (fetched_at DESC, id DESC);
