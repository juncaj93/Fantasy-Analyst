# `Next` — will he still be there when I pick again?

`Next 18%` on a draft card means one thing:

> Given the board exactly as it stands, and given that this player is still on
> it, Fantasy Analyst estimates about an 18% chance that every manager picking
> between now and your next selection passes on him.

It is a probability, not a score. It is produced by playing out the intervening
picks five thousand times and counting how often he survived.

Code lives in `src/core/draft/nextpick/`. The market distribution it is built on
lives in `src/core/draft/survival.ts`, shared with the older ADP-only estimate
that remains the fallback.

---

## What it is measured to

The **target pick** is the user's next *future* owned selection — strictly after
the pick on the clock.

| Situation | Target |
| --- | --- |
| Waiting for your turn at 68, pick 61 on the clock | 68 |
| On the clock at 53, next selection 68 | **68**, never 53 |
| You own 53 and 54, standing on 53 | 54 |
| Your last selection of the draft | none — `Next —` |

On the clock the distinction is the whole feature. Asking whether a player
available now is available now is true of everybody, so the board reads 100% at
the one moment the number is used to choose between players.

Ownership is resolved through `ownership.ts`, which reads Sleeper's traded picks
when the draft exposes them. A traded pick belongs to the manager who will make
it, not to the seat it sits in — otherwise the model reads the wrong roster and
invents demand a team filled two rounds ago.

## The model

### Conditional, always

A player with ADP 45 still on the board at pick 60 has been passed over fifteen
times. The unconditional distribution answers a question about pick 30 and
returns about 5%, which is both wrong and useless with a clock running. Every
number here is `P(lasts to target | lasted to now)`.

### The market, as a hazard

One distribution, defined once in `survival.ts`: a logistic centred on ADP whose
spread grows with draft position (`3 + 0.22 × ADP`, floored at 4), because a
player ranked 120th routinely goes twenty picks either side and the first pick
does not.

The simulator uses its **hazard** — how ready the market is to take a player at
one exact pick. It is 0.5 at his ADP, small before it, and **saturates** after
it. That ceiling is why there is no separate falling-player term: a player fifty
picks past his ADP already carries roughly twice the weight of one going at his
own price, and can never carry more. Conditional survival handles the rest, so
nothing is counted twice.

### One manager's decision

At each simulated pick, the manager who owns it is a mix of two motives:

- **Best available** — weight every player by that market hazard.
- **Need** — weight every *position* by what this manager's starting slots still
  want, then split that weight among the players available at it.

The mix ramps from 15% need in round one to 55% by the middle of the draft.
Round one is a market; a starting hole in round eight is a real reason to take a
position over a better player somewhere you are full.

That split is where **alternative supply** lives. A best-available manager takes
*this player*, and seven similar receivers behind him do not protect him. A
manager who needs a receiver takes *a receiver*, and seven alternatives mean it
is him one time in eight. So depth damps the need-driven share of the risk and
leaves the market-driven share alone — which bounds the effect without a cap.

### Roster need

Read from the league's own starting slots, never assumed:

- **Positions the league starts one of** (usually QB, TE) collapse to ~0.3× once
  the starter is in place. One is enough.
- **Positions the league starts two or more of** (usually RB, WR) settle at
  ~0.85× and gain appetite late. Managers keep taking backs and receivers all
  draft, for the flex, the bench and the injury list; a model that stopped would
  have the room stop drafting them in round eight, which is when the room drafts
  most of them.
- **Flex slots** are counted from the league's own slot definitions. An open
  flex is the only reason a tight end is still in play once the TE slot is full.
- **Superflex** is folded into the quarterback requirement rather than treated
  as a shared flex, because that is what a `SUPER_FLEX` slot is for. A superflex
  manager with one quarterback is hungry for a second; the same roster in a
  one-quarterback league has finished with the position.

The entire need signal is scaled to a quarter of its strength at pick one and
ramps to full by the middle of the draft. Every roster is empty in round one, and
an undamped model has twelve managers all desperate for a quarterback.

A manager with two picks in a row sees his own first pick before making his
second.

### Tier scarcity

Consumed from the existing tier engine (`tiers.ts`), never redefined. Most of the
effect is already there for free — when a tier empties, the players past the
cliff have distant ADPs and low weight, so the position's need-driven share
concentrates on the few left. A bounded premium (up to +30%) is added for the
last one or two players in a tier that ends at a real cliff. If tier data is
missing the model loses a nudge and keeps working.

### What the room has been doing

Four bounded reads, all from picks already made in **this** draft, all silent
below a minimum sample:

| Signal | Window | Cap | Minimum |
| --- | --- | --- | --- |
| Position runs | last 12 picks | ×0.85–1.30 | 8 picks |
| Positional bias | whole draft | ×0.85–1.20 | 6 at the position |
| Market adherence | whole draft | spread ×0.75–1.35 | 12 priced picks |
| Manager tendency | per manager | ×0.90–1.15 | 4 picks, shrunk |

Runs are measured against what the market expected over the same stretch, not
against a flat share — round three is *supposed* to be mostly backs and
receivers. Adherence narrows the distribution for a room tracking ADP tightly
and widens it for one full of reaches. In the first two rounds all four are
exactly 1: there is nothing to read yet.

## What is deliberately excluded

| Input | Why not |
| --- | --- |
| **My Guy** | Your preference. It says nothing about what eleven other managers will do. Toggling it must leave every `Next` on the board untouched — pinned in `nextpick.board.test.ts`. |
| **Newsletter tally** | This app's private evidence. The room has not read it. |
| **Vegas / season markets** | Excellent at "is he good", unevidenced at "will somebody else draft him". Pinned as no effect. |
| **Score** | `Next` feeds `Score`; if `Score` fed back it would be circular. |

Public injury designations are the one judgement call the room can also see, and
are already carried in the candidate pool.

## Determinism, cost and caching

- **Seeded.** The generator is seeded from the draft state — draft id, current
  pick, target pick, rosters, board, ADP. `Math.random` is never called. Refresh
  a board that has not moved and the numbers are identical; land a pick and they
  change because the situation did.
- **5,000 simulations**, which puts the sampling error at 0.7 points worst case —
  inside the whole number the card shows. Measured in
  `tests/nextpick.simulate.test.ts` rather than assumed, both by comparing
  1,000 / 2,500 / 5,000 and by re-running the shipped count under a different
  seed.
- **~50ms** for 300 candidates over 14 intervening picks. The cost is per *board
  state*, not per player: one simulation of the interval decides every player's
  fate at once.
- **Cached** by a hash of everything that can move the answer, four states deep.
  A draft polled every three seconds computes once per pick that actually lands.

## Missing data

| Missing | Behaviour |
| --- | --- |
| Target player has no ADP | `Next —`. He is still simulated so the board around him is realistic, but no percentage is invented from a made-up draft position. |
| Other candidates have no ADP | Ordered behind the deepest priced player by search rank, with weight damped by half. Never treated as ADP. |
| A manager's roster unreadable | Falls back to the market; no need is invented. Confidence drops. |
| Pick ownership unpublished | Simulated on the market baseline. Confidence drops. |
| **Fewer than three candidates per intervening pick** | The whole board falls back to the conditional ADP estimate, flagged and at low confidence. A simulation takes one player off the board per pick, so a pool barely larger than the interval empties and every player reads 0% — arithmetic about *this pool*, not about the draft. A pool that shallow means the app is missing players, not that twenty-one managers are about to take these exact seventeen. Never reached on a live board; reached on the demo seed and on a league whose player table failed to sync. |
| Too few picks to read the room | Not a defect — the market alone is the right model of an early board. Confidence stays high. |

## The simulated board is not the drawn board

The pool handed to the simulator is every available, startable player, capped at
300 by ADP — built independently of the position chip, the queue filter and the
display limit.

That separation is load-bearing. `candidates` is what gets drawn, so filtering
to QB makes it quarterbacks; handing *that* to the simulator would give every
simulated manager nothing but quarterbacks to take, twelve picks in a row, and
collapse every quarterback on screen toward zero. The numbers would stay
entirely plausible and would simply answer a question nobody asked. The room
drafts from the room's board; what the reader has chosen to see is not part of
it. Pinned in `nextpick.board.test.ts`.

## Explanations

Drivers are generated from the simulation's own diagnostics and each has a
threshold below which it stays silent. **A driver is only printed when it
actually moved the model**: "3 of the 7 teams ahead still need TE" is a claim
that the simulator counted three managers with an empty tight-end slot, and if it
counted two the sentence says two or does not appear.

They reach the card through the existing survival component's text — no new UI.
The full set, with confidence and the ADP-only baseline for comparison, is on
each recommendation as `nextPick`, and the model's own workings are on the board
response as `nextPickModel`.

## Looking at it

```bash
node scripts/probe-next-pick-survival.mjs        # the live board, with reasoning
DRAFT_ID=1234 TOP=20 node scripts/probe-next-pick-survival.mjs
npx vitest run tests/nextpick.model.test.ts      # market, demand, room, ownership
npx vitest run tests/nextpick.simulate.test.ts   # directional invariants, cost
npx vitest run tests/nextpick.board.test.ts      # which pick, and what it may see
```

## Calibration assumptions

Every constant that is not read from the league or the market is an assumption,
collected in `DEMAND`, `ROOM` and `SIMULATION` and bounded. No public dataset
this project can use says how much likelier a manager is to take a tight end when
his tight-end slot is empty, so the values are the smallest that reproduce
behaviour a drafter would recognise, and the tests pin the *direction* rather
than the number. Anything tuned from a real season of draft data should replace
them constant by constant; the tests will still hold.
