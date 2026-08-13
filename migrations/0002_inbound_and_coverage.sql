-- Inbound-mail visibility and parser coverage.
--
-- `newsletter_messages` becomes the log of every email the dedicated address
-- receives, not only the ones that were processed. That is what powers the
-- "last received / last processed / needs review" panel in Settings, and it
-- keeps an unexpected sender out of the evidence ledger while still being
-- visible to the user.
--
-- Additive only: no column is dropped or retyped, so applying this to an
-- existing database cannot lose data.

ALTER TABLE newsletter_messages ADD COLUMN auto_applied_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE newsletter_messages ADD COLUMN identity_review_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE newsletter_messages ADD COLUMN coverage_json TEXT NOT NULL DEFAULT '{}';
-- Why a message was not processed (unexpected sender, oversized, parse failure).
ALTER TABLE newsletter_messages ADD COLUMN reject_reason TEXT;
-- `status` now takes: processed | quarantined | rejected | error | ignored
ALTER TABLE newsletter_messages ADD COLUMN detail TEXT;

CREATE INDEX IF NOT EXISTS idx_newsletter_status ON newsletter_messages (status, received_at DESC);
