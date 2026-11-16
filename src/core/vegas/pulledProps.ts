/**
 * Which players' props were pulled: every line he had in his game is a "gone"
 * marker at the newest look (Round 33). Feeds `core/startsit/checkStatus.ts`.
 *
 * Kept apart from that file because the server and the backtest need this and
 * the page does not, and the page's own file is on every load.
 */

/**
 * Which players' lines are all gone at the newest look of their game.
 *
 * Pure, so the repository and the backtest share it. `rows` are the newest row
 * per player, game and market (gone markers included) with the time of the look
 * that wrote it. `looks` are the game's looks with how many lines each carried
 * (`null` when the look predates that count): a look that came back with less
 * than half the lines of the busiest earlier look is a feed problem, not a
 * scratch, and pulls nobody.
 */
export function pulledPlayers(
  rows: readonly { playerId: string; eventId: string; gone: boolean; fetchedAt: string }[],
  looks: ReadonlyMap<string, readonly { fetchedAt: string; lines: number | null }[]>,
): Map<string, string> {
  const byPlayerGame = new Map<string, { playerId: string; eventId: string; anyLive: boolean; pulledAt: string | null }>();
  for (const r of rows) {
    const k = `${r.playerId}|${r.eventId}`;
    const held = byPlayerGame.get(k) ?? { playerId: r.playerId, eventId: r.eventId, anyLive: false, pulledAt: null };
    if (!r.gone) held.anyLive = true;
    else if (held.pulledAt == null || Date.parse(r.fetchedAt) > Date.parse(held.pulledAt)) held.pulledAt = r.fetchedAt;
    byPlayerGame.set(k, held);
  }
  const out = new Map<string, string>();
  for (const g of byPlayerGame.values()) {
    if (g.anyLive || g.pulledAt == null) continue;
    if (!lookWasWhole(g.pulledAt, looks.get(g.eventId) ?? [])) continue;
    const held = out.get(g.playerId);
    if (!held || Date.parse(g.pulledAt) > Date.parse(held)) out.set(g.playerId, g.pulledAt);
  }
  return out;
}

function lookWasWhole(at: string, looks: readonly { fetchedAt: string; lines: number | null }[]): boolean {
  const t = Date.parse(at);
  const look = looks.find((l) => Date.parse(l.fetchedAt) === t);
  if (!look || look.lines == null) return true;
  if (look.lines === 0) return false;
  const busiest = Math.max(0, ...looks.filter((l) => Date.parse(l.fetchedAt) < t && l.lines != null).map((l) => l.lines!));
  return look.lines * 2 >= busiest;
}
