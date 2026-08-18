-- Make the stable identifier as cheap to look up as the name.
--
-- Both published-file pipelines -- injury reports and weekly usage -- carry a
-- GSIS id per row, and both were matching on the *name* first and using that
-- identifier only to break a tie between two players who already shared a
-- lookup key. That is the wrong way round, and it was the wrong way round for
-- a reason worth recording: `external_ids_json` is an unindexed JSON blob, so
-- the only way to find a player by GSIS id was to scan the whole dictionary,
-- and building an in-memory index of four thousand players measured 17ms of
-- CPU -- more than a Cloudflare Worker gets for an entire invocation.
--
-- The cost of the compromise is not theoretical. A player the two sources
-- spell differently -- "Cam Ward" in Sleeper against "Cameron Ward" in the
-- file, a suffix present on one side and absent on the other, a hyphen
-- somebody dropped -- does not merely resolve ambiguously. He does not resolve
-- at all, because the name lookup returns no candidates and the identifier
-- never gets consulted. His injury is silently missing and his usage is
-- silently missing, and nothing in the counts distinguishes that from the
-- source not mentioning him.
--
-- A generated column removes the trade. `gsis_id` is derived from the same
-- JSON that was always there, so it cannot drift from it and needs no
-- maintenance in the upsert path. Lookup by identifier becomes the same shape
-- as lookup by name -- one indexed `IN (...)` -- and the resolver can put the
-- identifier where it belongs, which is first.
--
-- VIRTUAL rather than STORED, and that is not a preference. SQLite refuses to
-- add a STORED generated column to a table that already has rows: `ALTER TABLE
-- ... ADD COLUMN ... STORED` fails with "cannot add a STORED column". The first
-- draft of this migration was STORED and passed every local test, because the
-- test database applies migrations to an empty `players` table -- and it would
-- then have failed at the `d1 migrations apply --remote` step of the deploy,
-- against the four thousand rows that are actually there. See
-- tests/migrations.test.ts, which now applies every migration to a populated
-- table for exactly this reason.
--
-- Nothing is lost. An index on a VIRTUAL generated column materialises the
-- value inside the index, so the lookup below is a plain B-tree search
-- (`SEARCH players USING INDEX idx_players_gsis`) and only a write pays the
-- `json_extract`.
--
-- Nothing about scoring, ranking or any football output changes. This decides
-- only whether a row from an external file finds the player it names.

ALTER TABLE players
  ADD COLUMN gsis_id TEXT
  GENERATED ALWAYS AS (json_extract(external_ids_json, '$.gsis')) VIRTUAL;

-- Not unique: two rows with a null id are not a conflict, and a genuine
-- duplicate id is a data problem the identity review queue should surface
-- rather than one an insert should fail on mid-ingest.
CREATE INDEX IF NOT EXISTS idx_players_gsis ON players (gsis_id)
  WHERE gsis_id IS NOT NULL;
