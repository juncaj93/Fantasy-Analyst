/**
 * Help My Scores — the names that are costing the user their own research.
 *
 * Deterministic matching refuses to guess, which is right: "JSN" could be
 * several people and inventing an answer would silently corrupt a tally. But
 * refusing has a cost, and until now that cost was invisible — the evidence sat
 * unresolved, the player's boost stayed at zero, and nothing said so.
 *
 * This module turns a pile of individually-unresolved evidence into the
 * question a person can actually answer: not "what about this one sentence
 * mentioning JSN", but "JSN appears nine times and represents +9 that nobody is
 * getting — who is it?". One answer repairs all nine.
 *
 * Pure functions only. Persistence and evidence creation live in the service.
 */

import { normalizeName } from './normalize.ts';

export interface UnresolvedReview {
  id: number;
  matchedText: string;
  excerpt: string;
  sourceDate: string;
  proposedPolarity: string | null;
  /**
   * What the item is worth once assigned. Absent on rows written before
   * magnitude was carried, which were all worth 1 by definition.
   */
  proposedMagnitude?: number;
  candidates: { playerId: string; name: string; team: string; position: string; detail: string }[];
}

export interface UnresolvedGroup {
  /** The name as the newsletter wrote it, e.g. `JSN`. */
  alias: string;
  normalizedAlias: string;
  reviewIds: number[];
  items: number;
  /** Net tally these items would contribute once assigned. */
  net: number;
  /** The part of that net from the last 30 days. */
  net30: number;
  /** One example, so the user can see what the name was doing in the text. */
  example: string;
  /** Best-first candidates, merged across every item in the group. */
  candidates: { playerId: string; name: string; team: string; position: string; detail: string }[];
}

/** Sign of a proposed polarity. Neutral news counts as nothing, by design. */
export function polaritySign(polarity: string | null): number {
  if (polarity === 'positive') return 1;
  if (polarity === 'negative') return -1;
  return 0;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Group unresolved evidence by the name it was written under.
 *
 * Grouping is on the normalized alias so `JSN`, `jsn` and `J.S.N.` arrive as one
 * question rather than three. The displayed alias is the most common raw
 * spelling, because that is what the user will recognise from the newsletter.
 */
export function groupUnresolved(reviews: UnresolvedReview[], now = new Date().toISOString()): UnresolvedGroup[] {
  const nowMs = Date.parse(now);
  const groups = new Map<string, UnresolvedGroup & { spellings: Map<string, number> }>();

  for (const review of reviews) {
    const raw = review.matchedText.trim();
    if (!raw) continue;
    const key = normalizeName(raw);
    if (!key) continue;

    let group = groups.get(key);
    if (!group) {
      group = {
        alias: raw,
        normalizedAlias: key,
        reviewIds: [],
        items: 0,
        net: 0,
        net30: 0,
        example: review.excerpt,
        candidates: [],
        spellings: new Map(),
      };
      groups.set(key, group);
    }

    // Weighted by what the item is actually worth, not by how many rows there
    // are: one imported tally row reading "JSN +11" costs the user 11, and
    // saying it costs 1 understates the only number that decides what to fix
    // first.
    const delta = polaritySign(review.proposedPolarity) * Math.abs(review.proposedMagnitude ?? 1);
    group.reviewIds.push(review.id);
    group.items++;
    group.net += delta;

    const ageDays = (nowMs - Date.parse(review.sourceDate)) / DAY_MS;
    if (Number.isFinite(ageDays) && ageDays <= 30) group.net30 += delta;

    group.spellings.set(raw, (group.spellings.get(raw) ?? 0) + 1);
    for (const candidate of review.candidates) {
      if (!group.candidates.some((c) => c.playerId === candidate.playerId)) group.candidates.push(candidate);
    }
  }

  const out: UnresolvedGroup[] = [];
  for (const group of groups.values()) {
    const { spellings, ...rest } = group;
    const alias = [...spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? rest.alias;
    out.push({ ...rest, alias });
  }

  // Loudest first: the biggest unassigned tally is the one worth fixing before
  // a draft, not the one that happens to be alphabetically first.
  return out.sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || b.items - a.items || a.alias.localeCompare(b.alias));
}

export interface ZeroBoostSuspicion {
  alias: string;
  net: number;
  items: number;
  candidate: { playerId: string; name: string };
  candidateNet: number;
}

/**
 * Names carrying real weight whose likeliest owner has nothing.
 *
 * The tell-tale shape is an alias holding a meaningful tally next to a
 * canonical player with none — which is exactly what "JSN has +11, Jaxon
 * Smith-Njigba has 0" looks like. Never auto-merged: it is a strong hint, not
 * a fact, and the whole point of this feature is that a person decides.
 */
export function suspiciousZeroBoosts(
  groups: UnresolvedGroup[],
  netByPlayerId: Map<string, number>,
  opts: { minItems?: number; minNet?: number } = {},
): ZeroBoostSuspicion[] {
  // Weight decides, not row count. Before magnitude was carried, every item was
  // worth ±1, so "at least two items" was the only way to say "more than a
  // passing mention". Now one imported tally row can be worth +11 by itself, and
  // requiring two rows would hide the single loudest case in the app — which is
  // JSN, the exact example this feature was written for. A lone ±1 sentence
  // still does not qualify, because it does not clear `minNet`.
  const minItems = opts.minItems ?? 1;
  const minNet = opts.minNet ?? 2;

  const out: ZeroBoostSuspicion[] = [];
  for (const group of groups) {
    if (group.items < minItems || Math.abs(group.net) < minNet) continue;
    const candidate = group.candidates[0];
    if (!candidate) continue;
    const candidateNet = netByPlayerId.get(candidate.playerId) ?? 0;
    if (Math.abs(candidateNet) > 0) continue;
    out.push({
      alias: group.alias,
      net: group.net,
      items: group.items,
      candidate: { playerId: candidate.playerId, name: candidate.name },
      candidateNet,
    });
  }
  return out;
}

/** Plain-language summary for Setup and the draft-day warning. */
export function repairSummary(groups: UnresolvedGroup[]): {
  names: number;
  items: number;
  net: number;
  headline: string;
} {
  const names = groups.length;
  const items = groups.reduce((a, g) => a + g.items, 0);
  const net = groups.reduce((a, g) => a + g.net, 0);
  const headline =
    names === 0
      ? 'Every player name in your newsletters is matched.'
      : `${names} player ${names === 1 ? 'name needs' : 'names need'} matching` +
        (net !== 0 ? ` — ${net > 0 ? '+' : ''}${net} net tally is not being counted` : '');
  return { names, items, net, headline };
}
