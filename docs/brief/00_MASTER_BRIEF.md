# Fantasy Football Intelligence Tool — Master Build Brief

## Mission

Build a private, mobile-first fantasy football decision tool that combines:

1. Sleeper league + draft data
2. Underdog ADP snapshot data
3. Automatically ingested FF Newsletter intelligence
4. User-owned positive / negative player tallies and context
5. Free or free-tier Vegas player prop data
6. Deterministic, explainable draft and start/sit recommendations

The production app must not depend on paid AI APIs.

Claude Code is the implementation agent. The deployed app itself should use deterministic code, rules, scoring, parsing, caching, and user review flows.

## Product principles

- Private personal tool
- iPhone Safari first
- Fast, readable, low-friction
- Explain every recommendation
- Preserve raw source evidence
- Never hide uncertainty
- Prefer deterministic logic over opaque scoring
- No paid AI dependency
- Sleeper is the source of truth for league settings, rosters, draft state, and player IDs where available
- External data must be cached and normalized into a canonical player model
- User corrections outrank automation
- Ambiguous newsletter items should be surfaced for review rather than guessed

## Primary modes

### Draft Mode

Use Sleeper live draft state and league settings, plus a frozen Underdog ADP snapshot and the user's news intelligence.

The tool should show:

- current pick
- picks until next user selection
- roster construction
- available players
- Underdog ADP
- ADP value vs current pick
- user news tally
- recent positive / negative context
- positional scarcity
- league-specific scoring fit
- estimated chance player survives to next pick
- deterministic recommendation ranking
- explanation for every recommendation

### Season Mode

Use Sleeper roster + league scoring, latest news tallies, and Vegas player props.

The tool should support:

- start/sit comparisons
- lineup recommendations
- roster alternatives
- player prop-based expectation
- injury / role / news signal
- matchup context if available from free data
- explanation of why one player is preferred

## Key data sources

### Sleeper

Use the public Sleeper API for:

- users
- leagues
- rosters
- scoring settings
- draft metadata
- draft picks
- players

Poll draft state efficiently during active drafts.

### Underdog ADP

Do not build around a fragile live scraper.

Preferred workflow:

- import a same-day snapshot as CSV/JSON before the draft
- normalize player names
- store the snapshot timestamp
- freeze it for that draft session
- preserve original source value

### FF Newsletter

Target the user's recurring fantasy football newsletter workflow.

The desired production behavior is automatic ingestion, not manual paste.

Implement an email ingestion path that:

1. detects a qualifying FF Newsletter email
2. extracts plain text / HTML content
3. identifies known NFL player mentions
4. captures surrounding evidence
5. classifies the evidence using deterministic rules
6. proposes or applies positive / negative / neutral tallies
7. stores the original excerpt plus a deterministic summary/context string
8. routes ambiguous items to review

Do not silently guess on ambiguous statements.

### Vegas props

Use only a free or free-tier source.

Build a provider abstraction because vendor limits can change.

The initial integration should support whichever provider is most viable at implementation time, but the rest of the app must not depend on provider-specific field names.

Minimum desired prop types:

- passing yards
- passing TDs if available
- rushing yards
- receiving yards
- receptions
- anytime TD / TD probability if available

Cache aggressively.

The tool does not need real-time sportsbook refreshes. A Saturday night + Sunday morning refresh is sufficient initially.

## Production AI constraint

No paid AI in production.

The app must not call Claude, OpenAI, or another paid LLM to:

- parse newsletters
- classify news
- rank players
- make start/sit decisions
- summarize player evidence

All such behavior should be deterministic and testable.

If a case cannot be confidently handled without an LLM, classify it as uncertain and require review.

## Recommendation philosophy

Recommendations should be compositional rather than one giant magic score.

Expose components such as:

- market value
- roster need
- league fit
- positional scarcity
- news signal
- recent signal
- Vegas expectation
- uncertainty penalty
- survival-to-next-pick estimate

The user should be able to understand why Player A ranks above Player B.

## Suggested stack

Preferred lightweight stack:

- React + TypeScript + Vite
- Cloudflare Workers
- D1
- Wrangler
- GitHub Actions
- Playwright WebKit for iPhone-size smoke tests

If the existing repository uses another stack, preserve it unless there is a strong reason to migrate.

## Security

Private personal tool.

At minimum:

- passphrase or private auth
- no public write endpoints
- API keys stored server-side only
- no sportsbook API keys exposed to the browser
- validate all imported data
- rate limit manual refresh endpoints

## Development workflow

Claude Code should:

1. inspect the repo first
2. create a feature branch
3. write a brief implementation plan
4. implement autonomously
5. add tests
6. run all relevant suites
7. fix failures
8. produce a concise status report
9. do not merge without explicit user approval

## Initial milestone

Build the foundation first:

1. canonical player model
2. Sleeper connection
3. league selection
4. live draft-state ingestion
5. ADP snapshot import
6. evidence / tally model
7. newsletter ingestion architecture
8. deterministic classification engine
9. provider abstraction for Vegas props
10. basic Draft Room UI
11. basic Player Intelligence UI
12. test coverage

Do not over-polish before data correctness and explainability are solid.
