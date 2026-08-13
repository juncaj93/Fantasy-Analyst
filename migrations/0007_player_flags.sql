-- The user's own opinion, kept apart from the evidence ledger.
--
-- "My Guy" is not news and must never be mixed into the tally: a player can be
-- +8 in the ledger and unstarred, or 0 in the ledger and ★★★. Storing it in its
-- own table rather than as evidence keeps the two signals separable in the UI
-- and stops a preference from ever looking like something a newsletter said.
--
-- `level` is 1, 2 or 3 (★ / ★★ / ★★★). A cleared flag is deleted rather than
-- stored as 0, so the table only ever holds decisions the user actually made.
CREATE TABLE IF NOT EXISTS player_flags (
  player_id  TEXT PRIMARY KEY REFERENCES players (id) ON DELETE CASCADE,
  level      INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
