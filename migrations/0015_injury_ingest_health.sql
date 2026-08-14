-- A recent check must never make stale data look current.
--
-- The five-minute tick writes `checked_at` whether or not anything was
-- ingested, which is what makes "the pipeline is alive" answerable. It is also
-- the most dangerous number in the system: a panel that shows only that reads
-- "checked 2 minutes ago" while the newest report it actually holds is from
-- last Wednesday, and an ingest that has been failing since Thursday looks
-- exactly like one that had nothing to do.
--
-- Two columns close that gap. One counts ingests that started and did not
-- finish; the other remembers when the run of failures began, so the panel can
-- say how long it has been wrong rather than only that it is.

-- Consecutive failed or abandoned ingests. Reset to zero by any ingest that
-- completes, including one that completes with nothing to write -- an unchanged
-- source is a healthy answer, not a failure.
ALTER TABLE injury_source_state ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;

-- When the current run of failures started. Null whenever the count is zero.
ALTER TABLE injury_source_state ADD COLUMN failing_since TEXT;

-- The highest week this app has actually stored for the season.
--
-- Kept beside the source state rather than recomputed, because the question it
-- answers is about the gap: the file says week 9 and the store has week 6, so
-- three weeks were missed while the app was down and should be filled in one at
-- a time rather than in one invocation. A recomputed MAX(week) would answer the
-- same thing more slowly and only for players who happen to have rows.
ALTER TABLE injury_source_state ADD COLUMN caught_up_through INTEGER;
