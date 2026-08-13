# In-Season Start / Sit Engine

## Objective

Produce explainable weekly lineup recommendations using Sleeper league scoring, roster alternatives, user news evidence, and Vegas player props.

## Inputs

- league scoring
- roster
- current lineup
- player status
- evidence signal
- recent evidence
- Vegas props
- opponent / game
- game time
- optional free injury/status data if available

## Vegas-derived expectation

Convert market lines into a fantasy-relevant baseline.

Examples:

### WR / TE

Potential components:

- receptions line
- receiving yards line
- anytime TD price

### RB

Potential components:

- rushing yards
- receiving yards
- receptions
- anytime TD price

### QB

Potential components:

- passing yards
- passing TDs
- rushing yards

Do not pretend sportsbook lines equal exact fantasy projections.

Use them as market expectations.

## Consensus

If multiple books are available:

- remove obvious stale/missing lines
- use median line
- preserve number of books
- show source freshness

## Recommendation components

- Vegas expectation
- user news signal
- recency
- role/injury penalties
- league scoring fit
- uncertainty penalty

Optional later:

- weather
- implied team total
- spread
- offensive line injuries

## Recency

Preserve the user's raw lifetime tally, but derive a recent signal.

Suggested starting windows:

- last 7 days
- last 21 days
- season-to-date

Do not erase old evidence.

## UI

Start/Sit comparison card:

Player A vs Player B

Show:

- key prop lines
- user tally
- recent signal
- availability/injury note
- recommendation
- confidence
- reasons
- data freshness

## Missing data

Unknown is acceptable.

If prop data is missing:

- say so
- do not fabricate
- fall back to other components
- reduce confidence

## Automation

Suggested refresh cadence:

- Saturday evening
- Sunday morning
- optional manual refresh

Do not waste free-tier quota on constant polling.
