/**
 * One name per number, and the name follows the arithmetic.
 *
 * Players and Trades print the same two readings of the research tally — the
 * recent window and the lifetime total — and for a long time they printed them
 * under different names. Trades said `30d`; Players and the player page said
 * `21d`, which was not a second opinion but a stale one: `RECENCY_WINDOWS.last30`
 * was widened from twenty-one days to thirty and the labels never followed. The
 * screen was telling the reader a number covered three weeks when it covered
 * four, which is the worst kind of wrong copy because it is checkable.
 *
 * That is a failure mode a rendering test cannot catch — a browser sees `21d`
 * and has no opinion about whether twenty-one is true — so the invariant is
 * asserted here, against the constant itself:
 *
 * 1. **The label is derived from the window.** The expected text is
 *    `${RECENCY_WINDOWS.last30}d`, so moving the window to fourteen days fails
 *    this file until every surface that prints it has been changed to match.
 * 2. **Every surface prints the same one.** Read structurally — the label
 *    beside the field it labels — so a file that renamed the label but pointed
 *    it at a different window would fail rather than pass.
 * 3. **The lifetime total is `Life` everywhere**, including in the window grid
 *    that used to spell it `Lifetime` a few hundred pixels under a band already
 *    calling it `Life`.
 *
 * Nothing about what the window *counts* is tested here; `tests/evidence.test.ts`
 * owns that, and this lane changed none of it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RECENCY_WINDOWS } from '../src/core/evidence/aggregate.ts';

const ROOT = join(import.meta.dirname, '..');

function source(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

/** `30d` — the word the screens must use, spelled by the constant they mean. */
const RECENT = `${RECENCY_WINDOWS.last30}d`;

/** The lifetime tally's one name. Short, because a metric cell is short. */
const LIFETIME = 'Life';

describe('the recent-window label says what the window is', () => {
  it('is thirty days, which is what the label has to spell', () => {
    expect(RECENCY_WINDOWS.last30).toBe(30);
    expect(RECENT).toBe('30d');
  });

  /**
   * The Players row: the label, and the field it is the label of, on one line.
   *
   * Matched together on purpose. A test that only asked whether the file
   * contains `30d` would pass on a row that had been relabelled and left
   * pointing at `last7`.
   */
  it('labels the Players row from last30', () => {
    const row = source('src/web/screens/PlayersScreen.tsx');
    expect(row).toContain(`{ label: '${RECENT}', value: <SignedValue net={player.signal?.last30.net ?? 0} /> }`);
    expect(row, 'the stale twenty-one-day label is back on Players').not.toContain("label: '21d'");
  });

  /** The Trades row, which has always had this right and must keep it. */
  it('labels the Trades row from last30, and the lifetime one Life', () => {
    const row = source('src/web/screens/TradesScreen.tsx');
    expect(row).toContain(`{ label: '${RECENT}', value: <SignedValue net={w.last30} /> }`);
    expect(row).toContain(`{ label: '${LIFETIME}', value: <SignedValue net={w.lifetime} /> }`);
  });

  /**
   * The player page, which prints both readings twice — once in the band at the
   * top and once in the window grid further down. Two places on one page is
   * exactly where two names for one number came from last time.
   */
  it('labels both bands on the player page the same way', () => {
    const page = source('src/web/components/playerPage.tsx');

    // The metric band: `label="30d"` over `signal.last30`.
    expect(page).toMatch(
      new RegExp(`label="${RECENT}"\\s*\\n\\s*value=\\{signal \\? <SignedValue net=\\{signal\\.last30\\.net\\}`),
    );
    expect(page).toMatch(
      new RegExp(`label="${LIFETIME}"\\s*\\n\\s*value=\\{signal \\? <SignedValue net=\\{signal\\.raw\\.net\\}`),
    );

    // The `News by window` grid, which is the same four windows in a row.
    expect(page).toContain(`['${RECENT}', signal.last30]`);
    expect(page).toContain(`['${LIFETIME}', signal.raw]`);
    expect(page, 'the window grid spells the lifetime tally a second way').not.toContain("['Lifetime', signal.raw]");
  });

  /**
   * And the hints and spoken names say the same number in words.
   *
   * A tooltip reading "over the last 21 days" beside a cell labelled `30d` is
   * the same defect the label had, moved somewhere a screenshot does not show
   * it — and it is the version a reader using a screen reader gets exclusively.
   */
  it('says the same number in the tooltips and the accessible names', () => {
    const page = source('src/web/components/playerPage.tsx');
    const spoken = page.match(/Research tally over the last \d+ days/g) ?? [];
    expect(spoken.length).toBeGreaterThan(0);
    for (const line of spoken) {
      expect(line).toMatch(/last (7|30) days/);
    }
    expect(page, 'a tooltip still claims twenty-one days').not.toContain('last 21 days');
  });
});
