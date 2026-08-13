-- Sleeper's own draft-order ranking, carried on the player record.
--
-- The draft board previously needed a best-ball ADP file imported by hand.
-- Sleeper's public player dump — already synced nightly — ranks roughly 2,500
-- players in draft order, so the same question ("is this player likely to be
-- gone by my next pick?") can be answered with no file, no export and no
-- second source to keep in step.
--
-- Named `draft_rank`, not `adp`, on purpose: it is Sleeper's ranking, not an
-- average of observed drafts, and calling it ADP would overstate it.

ALTER TABLE players ADD COLUMN draft_rank INTEGER;

CREATE INDEX IF NOT EXISTS idx_players_draft_rank ON players (draft_rank);
