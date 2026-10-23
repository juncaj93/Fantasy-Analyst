/**
 * What version of the waiver reasoning produced a claim plan.
 *
 * The most composed of the six, and honestly so: a claim plan is the lineup
 * optimiser (what the roster is worth now), the wire scan on top of it (what
 * each add would be worth), the defence planner beside it (which owns the DEF
 * row outright), and the pricing and ordering passes over the result. A
 * calibration change in any of them moves a bid, a drop or the order the claims
 * are entered in.
 *
 * `composeEngineVersion` de-duplicates, so the two paths this reaches
 * `startsit@1` by — through the lineup and through the defence planner — say it
 * once.
 *
 * Bump the head — `waiver@N` — when a change to `core/waivers/`,
 * `core/startsit/waivers.ts` or `core/faab/` could move a claim, a bid, a drop
 * or the claim order for unchanged inputs: the gain threshold, the pricing
 * model, the competition read, the contingency rules, the protection rules.
 *
 * Not for a comment, a rename or a new diagnostic field. See
 * `core/draft/version.ts` for the full argument.
 */

import { composeEngineVersion } from '../engineVersion.ts';
import { LINEUP_ENGINE_VERSION } from '../startsit/version.ts';
import { DST_ENGINE_VERSION } from '../dst/version.ts';

/*
 * `waiver@2`: the board answers three questions rather than one.
 *
 * A bench-value tier and an unscorable tier both reach the claim planner, and
 * the planner's own `minNetGain` is now actually reachable — so a league whose
 * inputs have not changed at all can get different claims, in a different
 * order, at different prices. That is exactly what the head of this string is
 * for.
 */
/*
 * `waiver@3`: positions have a depth policy, and attention is a tie-break.
 *
 * A slot position already at its cap (QB, TE, K, DEF) is measured against its
 * own weakest player at the upgrade bar, with one such add per position; a
 * running back leans ahead of a close receiver; Sleeper's trending adds lift a
 * borderline call and break a near-tie; and a player at the top of the adds
 * list is not offered as a cut. See `core/waivers/depthPolicy.ts`.
 */
/*
 * `waiver@4`: the two cut protections are one market hold, and its draft
 * condition is the league's starter pool rather than a fixed pick 80.
 */
/*
 * `waiver@5`: a value add is measured against somebody the plan would cut —
 * the market hold now reaches the bar as well as the cut list.
 */
/*
 * `waiver@6`: one yardstick per comparison, and one cut for the card and the
 * plan. Market against market only when both are fully priced (any-TD line),
 * Sleeper's published projection for both otherwise; handcuffs protected; the
 * top ten of Sleeper's drops kept out of the plan; bench adds priced; claims
 * grouped by drop, up to two drops a week. See `core/waivers/yardstick.ts`.
 */
/*
 * `waiver@7`: a free agent outside the waiver window is an instant add with no
 * bid, and a claim under the same drop below him is not planned; a fresh drop
 * the room rated is priced as contested. See `core/waivers/clearWindow.ts`.
 */
/*
 * `waiver@8`: a rival needs a position when a starter there projects under the
 * owner's bar (QB 14, RB/WR/TE 8, DEF 6), not only when a slot is empty. That
 * count prices bids, so bids move.
 */
/*
 * `waiver@9`: a rival whose flex starter projects under 8 points needs every
 * position that flex takes. More rivals count as needy, so bids move.
 */
/*
 * `waiver@10`: the tiers. Every scanned free agent is scored by what he adds to
 * the best lineup over three weeks (the trade-value solver), paired with his
 * best drop; "Do this", "Worth considering" and the watch list replace the fixed
 * bars; the claim card is the "Do this" move; bids come from the league's own
 * bidding behaviour. See `core/waivers/tiers.ts` and `core/waivers/bidModel.ts`.
 *
 * `waiver@11`: each later week of the window has its own number: a complete
 * Vegas week for that game, else Sleeper's projection for that week in this
 * league's scoring, else this week's figure. This week's number is unchanged.
 * See `core/waivers/aheadWeeks.ts`.
 *
 * `waiver@12`: a later week's Vegas rung is gone; later weeks are Sleeper's
 * projection or this week's figure. Each bid carries its own trace (the
 * signals, the rivals, the advice before the value ceiling) for the support
 * snapshot; nothing drawn changes.
 *
 * `waiver@13`: round 2. Rival bids read each manager's roster need, FAAB left
 * and bidding history across seasons; the bid tries by tier (a hole, an
 * upgrade, a stash); drops follow a drop score and protect the Sleeper lineup
 * and elite backs' handcuffs; a season-ending or late stash is never offered;
 * every starting hole gets its own "Do this" and every move its own drop.
 *
 * `waiver@14`: from the first live run of round 2 (14 October). A protected
 * player (a high pick kept as a market hold, an elite back's handcuff) is
 * never cut: when no honest drop is left, the move is Worth considering with
 * "you need a spot first" and the cheapest few candidates. An injured player
 * the league's IR slots take moves there instead of being cut. A drop must
 * pass both cut rules (over replacement and drop score). A rival's hole the
 * week after next counts about half as much as one this week.
 *
 * `waiver@15`: Alex's live screen (14 October). A recent pickup with nothing
 * to show and no real role is a dead spot: no weeks-held credit, no lineup
 * protection, and the first drop offered, ahead of elite backs' handcuffs and
 * high picks. A move that costs somebody lists its best three drops. "In
 * your lineup" is the app's best week lineup, not Sleeper's leftover slots.
 *
 * `waiver@16`, 23 October 2026: availability is Team's rule
 * (`core/injury/weekAvailability.ts`). This week a Questionable player is a
 * whole game and a Doubtful one is his rate less six points, in the tiers and
 * on the yardstick, which no longer charges half a point for Questionable.
 */
export const WAIVER_ENGINE_VERSION = composeEngineVersion('waiver@16', LINEUP_ENGINE_VERSION, DST_ENGINE_VERSION);
