# Draft Recommendation Engine

## Objective

Rank available players during a live Sleeper draft using deterministic, explainable components.

## Inputs

- current Sleeper draft picks
- user's roster
- league scoring
- roster requirements
- pick number
- future user picks
- Underdog ADP snapshot
- player position
- user evidence signal
- optional tier data derived from ADP
- positional availability

## Core displayed metrics

For each available player:

- Underdog ADP
- current pick
- ADP value = current pick - ADP
- news raw tally
- recent news signal
- position
- roster need
- position scarcity
- league fit
- estimated survival probability to next user pick
- final recommendation score
- explanation

## Recommendation components

Keep separate scores.

### Market value

Reward players falling past ADP.

Do not overly punish reaching a few picks ahead when survival probability is low.

### Roster need

Account for:

- starting slots
- flex
- bench
- positional minimums
- roster construction

Need should matter, but should not force bad-value picks early.

### League fit

Use Sleeper scoring settings.

Examples:

- half PPR vs full PPR
- TE premium if applicable
- superflex
- bonuses

### Positional scarcity

Measure remaining quality at the position.

Possible implementation:

- cluster available players into ADP tiers
- estimate drop-off before next pick
- compare tier depth across positions

### Personal signal

Use user's evidence data.

Default behavior should be modest.

A +6 news tally should influence a close decision, not overpower a massive ADP difference unless the user later chooses stronger weighting.

### Survival to next pick

Estimate probability a player remains available.

Initial deterministic model can use:

- ADP
- current overall pick
- number of picks until next user pick
- historical approximation / logistic curve

This does not need machine learning.

Expose that it is an estimate.

## Output explanation

Example:

Recommended: Player A

Reasons:
- 8 picks of ADP value
- low chance to reach your next pick
- fills a starting need
- positive recent news signal
- stronger positional drop-off than alternatives

Counterpoint:
- Player B has slightly higher pure ADP

Never output a recommendation without component reasoning.

## Draft polling

During active draft:

- poll Sleeper efficiently
- detect newly drafted players
- update board without full page refresh
- pause aggressive polling when draft is inactive

## Safety

Never auto-draft.

The tool recommends only.
