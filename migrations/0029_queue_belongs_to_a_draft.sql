-- A queue belongs to the draft it was made for.
--
-- Reported: a user queued players during a completed best-ball draft, switched
-- to another league, and the old queue was sitting in the new draft's ★ list.
--
-- The cause is in the schema rather than in any screen. `player_flags` is keyed
-- by `player_id` alone, so `queued` and `queue_order` were global: one queue for
-- the whole installation, shown by whichever draft happened to be open. Nothing
-- in the app was choosing to carry it across — there was only ever one, and
-- every draft was reading it.
--
-- That is right for the other column in that table. `level` is My Guy, which is
-- an opinion about a *player* — he is still your guy in next year's league — and
-- it stays exactly where it is, global and untouched. A queue is the opposite
-- kind of fact: "remind me about him **in this draft**", which stops meaning
-- anything the moment the draft it was written for is not the one on screen.
--
-- Keyed on the Sleeper draft id rather than the league id, deliberately. A
-- league runs a draft every season and keeps its id across all of them, so a
-- league-scoped queue would still leak last August's shortlist into this
-- August's draft — the same bug one season later, and far harder to notice.

-- Both foreign keys cascade, which is the whole of this table's cleanup story.
-- A queue outlives its draft in no useful sense, and `draft_picks` — the other
-- table keyed on a draft — already says exactly this. Nothing in the app deletes
-- a draft today; a league removal that took its drafts with it would take their
-- queues too, rather than leaving rows keyed to a draft no board can name.
--
-- `queue_order` is NOT NULL on purpose. In `player_flags` the membership and the
-- rank were two nullable columns that could disagree, and every read had to
-- reconcile them on the way past. Here the row *is* the membership, so that
-- disagreement is not a state this schema can hold.
CREATE TABLE IF NOT EXISTS draft_queue (
  draft_id    TEXT    NOT NULL REFERENCES drafts (id) ON DELETE CASCADE,
  player_id   TEXT    NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  -- Sparse (1000, 2000, 3000), so a drag persists one row rather than
  -- renumbering the list. See core/draft/queueOrder.ts.
  queue_order INTEGER NOT NULL,
  updated_at  TEXT    NOT NULL,
  PRIMARY KEY (draft_id, player_id)
);

-- The only question this table is ever asked: "this draft's queue, in order".
CREATE INDEX IF NOT EXISTS idx_draft_queue_order ON draft_queue (draft_id, queue_order);

-- THE OLD GLOBAL QUEUE, WHICH BELONGS TO NO DRAFT
--
-- There is no correct migration for these rows and that is the finding, not a
-- gap. A legacy entry records that somebody starred a player; it does not
-- record which draft they were looking at, and nothing else in the database
-- does either. Assigning them to the currently selected draft would be
-- inventing the one fact the whole repair is about, and would reproduce the
-- reported bug exactly once more — on purpose, in a migration, where it would
-- look like data rather than like a defect.
--
-- So they are retired rather than migrated: copied verbatim into a table
-- nothing reads, and cleared from the live one. The user loses a queue that was
-- never attached to anything; they do not get somebody else's shortlist in
-- their draft. Re-starring a player is one tap, and it is a tap in a draft,
-- which is what makes the new entry meaningful.
--
-- CLEANUP. `retired_global_queue` is write-once and read-never: no repository
-- opens it, no endpoint serves it, and no future queue may be seeded from it.
-- It exists so that a support question a week after the deploy — "where did my
-- stars go?" — has an answer with the player ids in it. It is safe to drop in
-- any later migration once nobody is asking, and dropping it is the expected
-- end state rather than a loose end.
CREATE TABLE IF NOT EXISTS retired_global_queue (
  player_id   TEXT PRIMARY KEY,
  queue_order INTEGER,
  retired_at  TEXT NOT NULL
);

INSERT OR IGNORE INTO retired_global_queue (player_id, queue_order, retired_at)
SELECT player_id, queue_order, updated_at FROM player_flags WHERE queued = 1;

UPDATE player_flags SET queued = 0, queue_order = NULL;

-- `player_flags` holds decisions the user actually made, and "unflagged" has
-- exactly one representation: no row. Clearing the stars leaves rows that hold
-- nothing but a zero, so they go, and the table is back to being what 0007
-- created it as — My Guy, and nothing else.
DELETE FROM player_flags WHERE level <= 0;
