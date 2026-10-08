/**
 * What the waiver screens say when there is no move to make.
 *
 * Found in the October 2026 audit, on the live week-5 board: the Waivers page
 * drew a `Recommended move` heading with nothing under it, then a note saying
 * every option below "beats someone on your bench on paper" above three rows
 * that were not scored at all. The one useful fact, that 42 free agents were
 * compared and none came close, was only ever printed when the board was
 * completely empty.
 *
 * So the empty answer is built here, once, for both Waivers and Team:
 *
 *  - **`headline`**: `No move this week`. A decision, said as one.
 *  - **`detail`**: how many free agents were compared, so a thin week reads
 *    differently from a screen that could not read the wire.
 *  - **`nearest`**: who came closest and by how much, from the engine's own
 *    comparison. Never a recommendation: he did not clear the bar, and the
 *    sentence says what the bar was.
 *
 * And the unscored rows get one shared note per reason (`unscoredNotes`), so
 * `Proj. Not scored` always has a why on the same screen.
 *
 * Pure wording over data the engine already produced. Nothing here moves a
 * score, a bar or a claim.
 */

import type { WaiverNearMiss, WaiverUnscoredReason } from '../startsit/waivers.ts';
import type { WaiverBoardRow } from './board.ts';

export interface NoMoveSummary {
  headline: string;
  detail: string | null;
  nearest: string | null;
}

export function noMoveSummary(advice: {
  considered?: number;
  skipped?: number;
  nearestMiss?: WaiverNearMiss | null;
}): NoMoveSummary {
  const considered = advice.considered ?? 0;
  const compared = advice.skipped == null ? null : Math.max(0, considered - advice.skipped);
  let detail: string | null = null;
  if (compared != null && compared > 0) {
    detail = `None of the ${compared} free agent${compared === 1 ? '' : 's'} this app could compare beats your roster by enough to be worth a roster spot.`;
  } else if (compared === 0 && considered > 0) {
    detail = 'No free agent has a betting line or a projection to compare yet.';
  }
  return { headline: 'No move this week', detail, nearest: nearestLine(advice.nearestMiss ?? null) };
}

/**
 * How much more a comparison on Sleeper's projection has to show than one on
 * betting lines. The engine adds it to both bars: the starter bar
 * (`MEANINGFUL_UPGRADE_GAIN` 2.5, 3.0 on Sleeper's) and the bench bar
 * (`MARKET_BAR` 0.5, `SLEEPER_BAR` 1.0). Written here rather than imported so
 * this render-path module pulls in none of the engine.
 */
const BORROWED_EXTRA = 0.5;

/**
 * `Closest: KC Concepcion, 0.3 pts more than Kendre Miller on your bench, on
 * Sleeper's projection. Replacing a bench player needs 1.0 on Sleeper's
 * projection, 0.5 on betting lines.`
 *
 * Names which bar applies (bench or starter) and both yardsticks, because "a
 * claim needs 1.0" read as the whole rule when the starter bar is 2.5
 * (October 2026, question from Alex).
 */
export function nearestLine(miss: WaiverNearMiss | null): string | null {
  if (!miss || !(miss.gap > 0) || !(miss.bar > miss.gap)) return null;
  const onSleeper = miss.basis !== 'market';
  const yardstick = onSleeper ? 'Sleeper’s projection' : 'betting lines';
  const gap = miss.gap.toFixed(1);
  const sleeperBar = (onSleeper ? miss.bar : miss.bar + BORROWED_EXTRA).toFixed(1);
  const marketBar = (onSleeper ? miss.bar - BORROWED_EXTRA : miss.bar).toFixed(1);
  const bars = `${sleeperBar} on Sleeper’s projection, ${marketBar} on betting lines`;
  if (miss.kind === 'starter') {
    return `Closest: ${miss.name}, ${gap} pts more than ${miss.overName}${miss.slot ? ` at ${miss.slot}` : ''}, on ${yardstick}. Replacing a starter needs ${bars}.`;
  }
  return `Closest: ${miss.name}, ${gap} pts more than ${miss.overName} on your bench, on ${yardstick}. Replacing a bench player needs ${bars}.`;
}

const ORDER: WaiverUnscoredReason[] = ['scoring', 'no_team', 'partial_market', 'no_data'];

/**
 * One sentence per reason the unscored rows on screen share, in a fixed order.
 *
 * Rows from an older payload carry no reason and are said together as the
 * general case, so the note never claims a cause it was not given.
 */
export function unscoredNotes(rows: readonly Pick<WaiverBoardRow, 'name' | 'unscored' | 'position'>[]): string[] {
  const groups = new Map<WaiverUnscoredReason, string[]>();
  const positions = new Map<WaiverUnscoredReason, Set<string>>();
  for (const row of rows) {
    const why = row.unscored ?? 'no_data';
    groups.set(why, [...(groups.get(why) ?? []), row.name]);
    positions.set(why, (positions.get(why) ?? new Set()).add(row.position));
  }
  const notes: string[] = [];
  for (const why of ORDER) {
    const names = groups.get(why);
    if (!names || names.length === 0) continue;
    const who = listNames(names);
    const one = names.length === 1;
    switch (why) {
      case 'scoring': {
        /* Quarterbacks are the case in Tony's league, and the one worth naming plainly. */
        const allQuarterbacks = [...(positions.get(why) ?? [])].every((p) => p === 'QB');
        notes.push(
          allQuarterbacks
            ? `${who}: Sleeper’s quarterback projection assumes different passing scoring from this league’s, so it is not used, and no full betting line is posted for ${one ? 'him' : 'them'} yet.`
            : `${who}: Sleeper’s projection assumes different scoring from this league’s for ${one ? 'his' : 'their'} position, so it is not used, and no full betting line is posted for ${one ? 'him' : 'them'} yet.`,
        );
        break;
      }
      case 'no_team':
        notes.push(`${who}: not on an NFL team, so there is no game to project.`);
        break;
      case 'partial_market':
        notes.push(`${who}: only part of ${one ? 'his' : 'their'} betting lines are posted, and nothing else covers ${one ? 'him' : 'them'} yet.`);
        break;
      case 'no_data':
        notes.push(`${who}: no betting line and no projection yet.`);
        break;
    }
  }
  return notes;
}

function listNames(names: string[]): string {
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}
