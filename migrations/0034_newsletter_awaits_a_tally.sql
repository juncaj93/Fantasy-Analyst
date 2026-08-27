-- A newsletter arriving is work waiting for a person, not a set of opinions.
--
-- The app used to read an inbound issue with a sentence-level classifier and
-- write the result straight into the evidence ledger: "found news on 5 players,
-- 2 applied automatically, 3 waiting for your review". That was the app forming
-- a fantasy opinion about editorial prose it cannot actually read, and it is
-- retired here. From now on a newsletter is received, stored and marked as
-- awaiting the reviewed ChatGPT tally, and nothing moves a player's score until
-- that tally has been previewed and approved.
--
-- Three things, in the order they depend on each other: the durable state that
-- says a newsletter still needs a person, the record that makes applying a
-- tally exactly-once, and a one-time provenance-scoped reconciliation of what
-- the obsolete path already wrote.
--
-- Written with line comments only, like every migration here: `wrangler d1
-- migrations apply --remote` posts the file to D1 unsplit and lets the server
-- parse it, and that parser has never been shown a block comment that worked.
-- See tests/migrations.test.ts.

-- ------------------------------------------------------- 1. pending state ---

-- Where one newsletter stands in the reviewed-tally workflow.
--
-- Durable rather than derived, so it survives reloads, devices and Worker
-- restarts, and so Setup can answer "is there work waiting?" with one indexed
-- read rather than by inferring it from the shape of the evidence ledger.
--
--   awaiting        received and readable, no approved tally yet -- this is the
--                   state that puts the attention dot on Setup
--   applied         an approved tally has been written for it
--   not_applicable  nothing a person could tally: quarantined, rejected, failed
--                   to parse, or processed before bodies were retained and so
--                   impossible to copy for ChatGPT
--
-- The default is `not_applicable` because that is the safe direction: a row the
-- backfill below cannot prove is workable never asks for attention it cannot
-- pay off.
ALTER TABLE newsletter_messages ADD COLUMN tally_state TEXT NOT NULL DEFAULT 'not_applicable';

-- When the approved tally was applied. Null while one is still awaited.
ALTER TABLE newsletter_messages ADD COLUMN tallied_at TEXT;

CREATE INDEX IF NOT EXISTS idx_newsletter_tally_state
  ON newsletter_messages (tally_state, received_at DESC);

-- Every processed newsletter whose body was kept can be copied for ChatGPT, so
-- every one of them is workable and is awaiting its tally -- including the
-- issue that already arrived under the old path.
UPDATE newsletter_messages
   SET tally_state = 'awaiting'
 WHERE status = 'processed'
   AND (body_html IS NOT NULL OR body_text IS NOT NULL);

-- ...except those a tally has already been filed against, which are done. Read
-- from the ledger by provenance: `ai-tally-import` is the rule id every row of
-- an approved ChatGPT import carries, and nothing else writes it.
UPDATE newsletter_messages
   SET tally_state = 'applied', tallied_at = processed_at
 WHERE message_id IN (
         SELECT DISTINCT source_message_id FROM evidence_items
          WHERE rule_id = 'ai-tally-import' AND source_message_id IS NOT NULL
       );

-- ------------------------------------------------- 2. exactly-once record ---

-- One row per (newsletter, exact tally text) that has been applied.
--
-- The evidence ledger is already idempotent on each row's own dedupe key, so a
-- double tap cannot double-count a score. This is the statement one level up:
-- it makes a repeated apply a no-op the server can *recognise* rather than one
-- it merely survives, so a retry after an ambiguous response returns what the
-- first call did instead of reporting that nothing was applied.
--
-- Keyed on the payload's fingerprint rather than on the newsletter alone,
-- because a corrected tally for the same issue is a legitimate second apply and
-- must still supersede its predecessor. Identical text is the thing that must
-- never land twice.
--
-- `sequence` is which application of this newsletter it was: 1 for the first,
-- 2 for a correction, 3 for a correction of the correction. It decides which
-- tally is the one currently standing, and it is a counter rather than a
-- timestamp because two applications a millisecond apart -- a double tap, or a
-- test -- would tie on a clock and leave "which is newest" undecidable.
--
-- `outcome_json` is the bounded summary the winning apply returned: counts and
-- one plain-language sentence. No newsletter text, no player prose.
CREATE TABLE IF NOT EXISTS newsletter_tally_applications (
  message_id   TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  applied_at   TEXT NOT NULL,
  sequence     INTEGER NOT NULL DEFAULT 1,
  outcome_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (message_id, payload_hash)
);

-- --------------------------------------------- 3. retire the obsolete path ---

-- What the sentence-level classifier wrote for newsletters still awaiting a
-- tally stops counting.
--
-- This is the reconciliation the corrective lane turns on. The issue in
-- production arrived under the old path and produced automatic signals; when
-- its ChatGPT tally is pasted, the final tallies must be the approved result
-- once, not the approved result stacked on top of what the classifier guessed.
-- Retiring the classifier's rows here is what makes that true before the paste
-- rather than hoping the apply catches every one of them.
--
-- Scoped by provenance, and narrowly:
--
--   * only rows filed against a newsletter that is awaiting its tally -- a
--     newsletter already tallied had its reconciliation at apply time, and one
--     that is `not_applicable` is history nobody is about to restate;
--   * only rows the classifier wrote. `ai-tally-import` (an approved ChatGPT
--     tally) and `tally-backfill` (the hand-maintained running tally imported
--     once, which is where a lifetime `+11` lives) are somebody's decisions and
--     are never touched;
--   * only rows still counting or still queued. `accepted` and `corrected` mean
--     a person ruled on them, and a person outranks this;
--   * never a row carrying an override, and never one with any history in
--     `user_reviews`. Either is proof somebody decided something about it.
--
-- Nothing is deleted. `ignored` stops a row contributing while it stays in the
-- ledger, readable, with a note saying exactly why -- and reversible from
-- Review like any other item. Idempotent by construction: a second run finds
-- nothing left at `auto_applied` or `pending`, so re-applying this migration
-- changes nothing.
UPDATE evidence_items
   SET review_status = 'ignored',
       notes_json = json_insert(
         CASE WHEN json_valid(notes_json) THEN notes_json ELSE '[]' END,
         '$[#]',
         'retired-legacy-newsletter-classifier'
       ),
       updated_at = updated_at
 WHERE review_status IN ('auto_applied', 'pending')
   AND user_override_json IS NULL
   AND (rule_id IS NULL OR rule_id NOT IN ('ai-tally-import', 'tally-backfill'))
   AND source_message_id IN (
         SELECT message_id FROM newsletter_messages WHERE tally_state = 'awaiting'
       )
   AND NOT EXISTS (
         SELECT 1 FROM user_reviews WHERE user_reviews.evidence_item_id = evidence_items.id
       );

-- The same sweep for the names the classifier could not pin to one player.
--
-- An identity review carrying an awaiting newsletter's message id can only have
-- come from the classifier, because a tally import files them only when a tally
-- has been pasted -- and this newsletter has not had one. So these are the
-- "Wrong player?" queue of the obsolete workflow, and leaving them pending
-- would hold the Setup attention dot on for work that no longer exists.
--
-- `obsolete` rather than `dismissed`: a person dismissing a name is a decision
-- and this is not one, and keeping them apart is what lets the difference still
-- be read a year from now.
UPDATE identity_reviews
   SET status = 'obsolete'
 WHERE status = 'pending'
   AND source_message_id IN (
         SELECT message_id FROM newsletter_messages WHERE tally_state = 'awaiting'
       );

-- The signal cache is derived and is rebuilt from the ledger on the next write
-- to any player it covers. It is deliberately not recomputed here: a migration
-- has no business running the aggregation, and every read path that matters
-- recomputes the recency windows from the ledger on the way out anyway. The
-- lifetime columns correct themselves the next time each player is touched, and
-- `POST /api/maintenance/refresh-signals` forces it immediately.
