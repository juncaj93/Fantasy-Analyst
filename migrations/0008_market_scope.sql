-- Season-long markets share the weekly tables, separated by scope.
--
-- The draft asks "what does the market expect of this player this season" and
-- start/sit asks "what does it expect on Sunday". They are the same question at
-- two horizons, so they get one pipeline, one cache policy and one set of
-- tables — with a scope column that makes it impossible to read a season total
-- as a game line.
--
-- Everything already stored is a weekly game line, which is what the default
-- says. Snapshots stay append-only, so a season market's history is a series of
-- rows rather than an overwrite, and line movement stays available.

ALTER TABLE prop_snapshots ADD COLUMN scope TEXT NOT NULL DEFAULT 'week';
ALTER TABLE player_props ADD COLUMN scope TEXT NOT NULL DEFAULT 'week';

-- The season a season-scoped snapshot settles on, e.g. "2026". Null for weekly
-- rows, whose horizon is already identified by the event and its kickoff.
ALTER TABLE prop_snapshots ADD COLUMN season TEXT;

CREATE INDEX IF NOT EXISTS idx_prop_snapshots_scope ON prop_snapshots (scope, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_player_props_scope ON player_props (scope, player_id, market);
