# Automated FF Newsletter Ingestion

## Objective

Automatically process the recurring FF Newsletter without paid AI.

The production app should ingest qualifying emails, identify player-related news, classify obvious positive / negative signals, retain context, and route uncertain cases to review.

## Email acquisition

Preferred architecture:

- server-side Gmail integration if available
- otherwise a dedicated forwarding/inbound-email mechanism supported by the chosen hosting stack

Do not expose mailbox credentials to the frontend.

A qualifying newsletter should be detected by stable characteristics such as:

- sender
- subject patterns
- newsletter headers
- known publication identifiers

Avoid processing unrelated mail.

## Processing pipeline

1. retrieve email
2. sanitize HTML
3. derive normalized text blocks
4. remove boilerplate:
   - subscription footer
   - social links
   - navigation
   - repeated title metadata
5. segment content into paragraphs / bullets / headings
6. detect player names from the canonical player dictionary
7. attach nearby text window to each mention
8. deduplicate repeated mentions
9. classify evidence
10. persist evidence item
11. update derived signal cache
12. present ambiguous cases in review UI

## Deterministic classification

Do not attempt general natural-language understanding.

Build a transparent rule system.

Example positive phrase families:

- promoted
- starting
- earned first-team reps
- expected to lead
- increased workload
- cleared
- returned to practice
- healthy
- extension
- featured
- goal-line work
- receiving work
- praised by coach
- standout camp
- breakout
- added role

Example negative phrase families:

- injured
- limited
- missed practice
- out
- suspended
- demoted
- backup
- lost reps
- committee
- snap reduction
- struggling
- setback
- surgery
- questionable role
- competition increasing

These are examples only. Implement the engine so rule dictionaries are editable.

## Negation

Negation handling is essential.

Examples:

- "not expected to miss time" should not be negative
- "no longer limited" should lean positive
- "did not practice" should be negative
- "not concerned" should not inherit the negative word "concerned"

Implement token-window negation rules and tests.

## Mixed statements

Example:

"Player returned to practice but is expected to split work."

This should be `mixed`, not forced into positive or negative.

## Confidence

Suggested:

- high: clear phrase, one player, simple sentence
- medium: multiple signals but consistent
- low: contradictory language, multiple players, unclear target

Only high-confidence cases may be auto-applied.

Medium/low should be reviewable.

## Context summary without AI

Use deterministic templates from extracted facts.

Examples:

- "Returned to full practice after missing time."
- "Receiving increased first-team reps."
- "Role may be limited by committee usage."

Do not fabricate prose beyond evidence captured by matched rules.

If no safe template exists, store a shortened excerpt instead of a fake summary.

## Review UI

Show:

- player
- source issue/date
- excerpt
- proposed polarity
- matched rule(s)
- category
- confidence

Actions:

- accept
- change to +
- change to -
- neutral
- mixed
- ignore
- correct player

Support batch accept for high-confidence items.

## Idempotency

Use message ID + content fingerprint.

Reprocessing the same newsletter must not duplicate evidence.

## Testing

Fixture-driven tests should include:

- clear positive
- clear negative
- negation
- two players in one paragraph
- mixed news
- player surname collision
- repeated player mention
- newsletter boilerplate
- malformed HTML
- no recognized players
- duplicate email
