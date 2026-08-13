# Paste This Into Claude Code

You are implementing the first production foundation for a private fantasy-football intelligence web app.

Read every Markdown file in this package before changing code.

## Your job

Work autonomously.

1. Inspect the existing repository and document the current stack.
2. Preserve the existing stack where reasonable.
3. Create a feature branch.
4. Produce a concise implementation plan.
5. Implement the strongest coherent first milestone you can complete safely.
6. Add tests.
7. Run all relevant tests and browser checks.
8. Fix failures before stopping.
9. Give me a status report with:
   - what changed
   - files changed
   - architecture decisions
   - tests run
   - known limitations
   - exact manual setup required
   - what you recommend building next
10. Do not merge. Leave the branch ready for review.

## Non-negotiables

- No paid AI dependency in production.
- Sleeper is source of truth for league/draft/roster facts.
- Canonical player identity must be solved before layering recommendations.
- Preserve every news evidence item; do not store only aggregate tallies.
- Ambiguous newsletter classifications must go to review rather than being guessed.
- User corrections outrank automated rules.
- Vegas integration must use a provider abstraction.
- Cache Vegas data aggressively.
- Never auto-draft or auto-change a fantasy lineup.
- Recommendations must be explainable.
- iPhone Safari is the primary interface.

## First milestone priority

Prioritize in this order:

1. canonical player model
2. Sleeper player/league sync
3. league selection
4. draft state model
5. ADP snapshot import
6. evidence/tally schema
7. deterministic newsletter classification engine
8. newsletter review data model/UI
9. Vegas provider interface + mocked adapter
10. initial Draft Room
11. tests

If live email ingestion requires account credentials or infrastructure not available in the environment, implement the provider interface and fixture-driven ingestion pipeline now, document the exact hookup steps, and do not weaken the architecture by substituting a manual-only design.

Do not invent undocumented API behavior. Verify public API contracts where necessary.

Keep the implementation simple, typed, testable, and production-oriented.
