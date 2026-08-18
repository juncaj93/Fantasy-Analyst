-- Three things this release needs to remember.
--
-- 1. WHERE AN ADP SNAPSHOT CAME FROM, AND HOW OLD IT IS
--
-- `adp_snapshots` already had a `source` and a `captured_at`, which was enough
-- while there was one market. There are two now, and the second one — raw
-- Underdog ADP, shown as `DOG` — can only be trusted if these questions have
-- answers stored beside the numbers:
--
--   * which provider actually served it (the Best Ball Team Builder board, or
--     4for4 as the fallback);
--   * what kind of number it is. This is the important one. Underdog publishes
--     staff rankings and aggregators publish projections, and every one of
--     those sorts roughly like ADP and would look completely plausible in a
--     column labelled DOG. Only `raw_adp` may ever be shown as DOG;
--   * when the source says its numbers are effective, as against when we
--     fetched them. An aggregator that regenerates overnight serves a file at
--     14:00 whose numbers are from 03:00, and a successful fetch is not
--     evidence of freshness;
--   * whether anything about the snapshot was degraded when it landed.
--
-- All nullable, all defaulted, so every snapshot already imported stays exactly
-- what it was: a Sleeper snapshot with no Underdog provenance to state.
ALTER TABLE adp_snapshots ADD COLUMN provider TEXT;
ALTER TABLE adp_snapshots ADD COLUMN source_type TEXT NOT NULL DEFAULT 'raw_adp';
ALTER TABLE adp_snapshots ADD COLUMN snapshot_at TEXT;
ALTER TABLE adp_snapshots ADD COLUMN fetched_at TEXT;
ALTER TABLE adp_snapshots ADD COLUMN degraded_reason TEXT;

-- The board asks one question of this table on every build: "the newest
-- snapshot for this source". Without the index that is a scan of every ADP
-- snapshot ever imported, twice per board, during a live draft.
CREATE INDEX IF NOT EXISTS idx_adp_snapshots_source ON adp_snapshots (source, captured_at DESC, id DESC);

-- 2. THE ORDER THE USER PUT THEIR QUEUE IN
--
-- The ★ list is the one place in this app where the reader outranks the model,
-- and until now it had no order of its own — it came back in board order, so
-- the ranking silently re-sorted the reader's own shortlist on every refresh.
--
-- Sparse rather than dense (1000, 2000, 3000) on purpose: dropping a player
-- between two others takes the midpoint of their ranks, so a drag persists one
-- row instead of renumbering the list. See core/draft/queueOrder.ts.
--
-- NULL means "queued before this existed, or from a screen that does not set
-- one". Those append after everything that has a rank, which is where a player
-- the user has not placed belongs.
ALTER TABLE player_flags ADD COLUMN queue_order INTEGER;

CREATE INDEX IF NOT EXISTS idx_player_flags_queue_order ON player_flags (queued, queue_order);

-- Everything already queued gets a starting order, so the first drag has a
-- ladder to move within rather than an empty column. `rowid` is an arbitrary
-- but stable starting sequence — the point is that it is *an* order and that it
-- does not change under the reader, not that it is a good one. One drag fixes
-- anything they disagree with, and that drag is what this column exists for.
UPDATE player_flags
   SET queue_order = (
     SELECT COUNT(*) * 1000
       FROM player_flags AS earlier
      WHERE earlier.queued = 1
        AND earlier.rowid <= player_flags.rowid
   )
 WHERE queued = 1;

-- 3. WHICH NFL TEAMS A LEAGUE'S ROOM DRAFTS EARLY
--
-- A Detroit-area league takes Lions before the national market does. That is a
-- fact about twelve people rather than about the Lions, so it is stored on the
-- league and it reaches exactly one model: opponent demand, which is what
-- `Next%` is computed from. Nothing here can move a Score, a tier or a `Val`.
--
-- A comma-separated list of upper-case team codes, empty by default — so every
-- league behaves precisely as it did until somebody says otherwise.
ALTER TABLE leagues ADD COLUMN local_teams TEXT NOT NULL DEFAULT '';

-- 4. THE NUMBER ON THE SHIRT
--
-- During a draft the interesting fact about a player on your roster is which
-- pick he was — `1.04`, in the unit the room actually used. Afterwards that
-- stops being the headline (everybody has fifteen of them) and the number that
-- identifies a player on a team sheet is the one he wears.
--
-- Sleeper publishes it on the player dump. Nullable, because plenty of players
-- do not have one recorded and a made-up jersey number is worse than none:
-- `#0` is a real number that real players wear.
ALTER TABLE players ADD COLUMN jersey_number INTEGER;
