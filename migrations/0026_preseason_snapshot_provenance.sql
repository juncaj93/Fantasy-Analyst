-- Preseason season-long snapshots, imported by hand.
--
-- The provider publishes no season-long markets, so this half of the draft's
-- market signal comes from a person copying a table once or twice a preseason.
-- It lands in the same two tables as everything else under scope = 'season';
-- what it needs beyond that is provenance, because a hand-imported number that
-- cannot say where it came from is exactly the kind of number this app refuses
-- to show.
--
-- `capture_source` and `captured_at` are separate from `provider` and
-- `fetched_at` on purpose. `provider` says which pipeline wrote the row and
-- `fetched_at` says when it was written; these two say which book published the
-- line and when it was read off the page. For a fetched snapshot they coincide;
-- for a pasted one they do not, and the difference is the whole audit trail —
-- an August capture imported in September is an August number.
ALTER TABLE prop_snapshots ADD COLUMN capture_source TEXT;
ALTER TABLE prop_snapshots ADD COLUMN captured_at TEXT;

-- A short label for the card: "Win With Odds · Aug 27". Stored rather than
-- rebuilt so the wording a snapshot was imported under stays stable, and so
-- reading it costs no JSON parse on a screen that draws a hundred rows.
ALTER TABLE prop_snapshots ADD COLUMN capture_label TEXT;

-- The idempotence key for a hand import: one snapshot per season, per source,
-- per capture date. Re-importing a corrected copy of the same capture revises
-- that snapshot in place; a later capture is a new one and both survive.
--
-- Partial, so it constrains only the imported season rows and leaves every
-- fetched weekly snapshot exactly as it was.
CREATE UNIQUE INDEX IF NOT EXISTS idx_prop_snapshots_capture
  ON prop_snapshots (season, capture_source, captured_at)
  WHERE scope = 'season' AND capture_source IS NOT NULL;

-- Reading the latest capture per source is the query the board runs, and the
-- gap-fill runs it once per source.
CREATE INDEX IF NOT EXISTS idx_prop_snapshots_season_capture
  ON prop_snapshots (season, capture_source, captured_at DESC)
  WHERE scope = 'season';
