-- The draft queue is not an opinion about a player.
--
-- One stored value used to wear two faces: a ★ on the draft board and a ♥ on
-- the players list. Tapping either did the same two things — put the player in
-- the queue AND boost his ranking — which is wrong in one direction. During a
-- draft the star is how you find the man you meant to take; it is a bookmark,
-- and a bookmark should not quietly move him up the board.
--
-- So they separate here. `queued` is the bookmark, set by the star, and changes
-- nothing about the ranking. `level` stays My Guy — 1, 2 or 3 — set by the
-- heart on the players list, and keeps its bounded ranking boost.
--
-- Everything already flagged becomes a queue entry, because that is what the
-- draft board's own labels promised while it was being set ("Queued", "Queued —
-- high priority"). The ranking boost those flags were also applying is dropped:
-- it is the thing that was never asked for, and one tap of the heart puts it
-- back for anybody who did want it.

ALTER TABLE player_flags ADD COLUMN queued INTEGER NOT NULL DEFAULT 0;

UPDATE player_flags SET queued = 1 WHERE level > 0;
UPDATE player_flags SET level = 0;

CREATE INDEX IF NOT EXISTS idx_player_flags_queued ON player_flags (queued);
