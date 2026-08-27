-- What the scheduler actually did, one row per clock.
--
-- The one question this app could not answer about itself. Every feed already
-- records its own state -- `injury_source_state`, `usage_source_state`,
-- `nflverse_source_state`, the write budgets beside them -- so "is the injury
-- report current" has had an answer for a long time. "Did the 09:00 tick run,
-- and did the manager backfill yield because the feeds above it spent the
-- budget" has not: `scheduled()` wrote that to `console.log`, which lives in
-- Cloudflare's tail for as long as somebody is watching it and nowhere
-- afterwards. Somebody holding a questionable Sunday recommendation could not
-- tell a pipeline that had stopped from one that had nothing to say.
--
-- Metadata about the run, and never a byte of what the run fetched. No provider
-- payloads, no logs, no secrets, no identifiers.
--
-- Written with line comments only, like every migration here: `wrangler d1
-- migrations apply --remote` posts the file to D1 unsplit and lets the server
-- parse it, and that parser has never been shown a block comment that worked.
-- See tests/migrations.test.ts.

-- One row per cron expression, overwritten in place. Three rows, for ever.
--
-- Not an append-only ledger, and that is the whole sizing decision. §14 asks
-- for a current view, a last attempt, a last success and the most recent run --
-- which is exactly one row per clock -- and an append-only table would instead
-- be a monitoring history nobody asked for, growing by three rows a day and
-- needing a pruning job to stay small.
--
-- The five-minute injury tick is deliberately NOT written here, and that is
-- reuse rather than an omission. Its liveness is already recorded, every tick,
-- change or no change, by `injury_source_state.checked_at` -- which is the
-- column that exists for precisely this question. Writing it a second time
-- would add 288 writes a day to say what one already says, and would create the
-- first place in this app where two rows could disagree about whether the
-- injury check ran.
--
-- `outcome` is derived from the steps rather than declared by the caller -- see
-- `runOutcome` in `core/health/model.ts` -- and stored so a read does not have
-- to re-derive it. The vocabulary is the canonical one: succeeded, partial,
-- deferred, failed.
--
-- `last_success_at` advances only on a run that was not a total failure, so a
-- clock that has been failing since Tuesday keeps saying when it last worked.
-- Last attempt and last success, kept apart, for the same reason every source
-- state in this database keeps them apart.
--
-- `steps_json` is a bounded array of {id, label, outcome, items, note}. Notes
-- are truncated at capture (`boundedNote`), so this column cannot become a log
-- sink: eleven steps of a short clause each, and nothing that came off a wire.
--
-- The budget columns are nullable because only the daily tick has a ceiling to
-- defend. The two weekend clocks make four external calls between them and pass
-- the unmetered transport, so writing three zeroes for them would read as
-- "spent nothing" rather than as "this clock does not have a budget". Where
-- they are present they are the transport's own counters from
-- `RequestBudget.snapshot()`, which counts retries and redirect hops -- so they
-- are what actually went out on the wire rather than what was expected to.
CREATE TABLE IF NOT EXISTS cron_run_state (
  cron TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  trigger TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT NOT NULL,
  last_success_at TEXT,
  budget_limit INTEGER,
  budget_used INTEGER,
  budget_remaining INTEGER,
  steps_json TEXT NOT NULL,
  release_sha TEXT
);
