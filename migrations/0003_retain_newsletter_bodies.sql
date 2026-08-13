-- Retain newsletter bodies so rules can be re-run against them.
--
-- Without this, `reprocess` had nothing to reprocess: the message log recorded
-- that an email arrived and what came of it, but not the email. Improving a
-- classification rule could therefore only ever affect newsletters that had not
-- arrived yet, which is the wrong way round — the whole point of tuning rules is
-- to apply them to the issues already sitting in the ledger.
--
-- Only bodies of messages that were actually processed are stored. Quarantined
-- mail is still recorded but deliberately never retained: it is unsolicited
-- content from an unexpected sender, and keeping it would mean storing whatever
-- a stranger chose to send.

ALTER TABLE newsletter_messages ADD COLUMN body_html TEXT;
ALTER TABLE newsletter_messages ADD COLUMN body_text TEXT;
