/**
 * Canonical player identity resolution.
 *
 * Matching ladder (strict first, per docs/01_DATA_MODEL.md):
 *   1. exact external provider id
 *   2. exact normalized full name + team
 *   3. exact normalized full name + position
 *   4. known alias
 *   5. exact normalized full name, unique among active players
 *   6. fuzzy candidate generation
 *
 * A fuzzy candidate is NEVER auto-committed unless it clears every guard in
 * `AUTO_FUZZY`. Anything ambiguous is returned as `status: 'ambiguous'` with
 * ranked candidates so it can be routed to the review queue.
 */

import {
  editDistance,
  initialForm,
  normalizeName,
  normalizePosition,
  normalizeTeam,
  normalizedSurname,
} from './normalize.ts';
import type {
  CanonicalPlayer,
  MatchCandidate,
  MatchQuery,
  MatchResult,
} from './types.ts';

export * from './types.ts';
export * from './normalize.ts';

/** Guards that must all hold before a fuzzy match may be auto-committed. */
export const AUTO_FUZZY = {
  maxEditDistance: 1,
  requireSameTeam: true,
  requireSamePosition: true,
  /**
   * Floor for the scored confidence. A distance-1 hit that also agrees on team
   * and position scores 0.72, so this threshold admits exactly that case and
   * rejects anything weaker.
   */
  confidence: 0.7,
} as const;

const CONFIDENCE = {
  external_id: 1,
  name_team: 1,
  name_position: 0.98,
  alias: 0.95,
  name_unique: 0.9,
  anaphora: 0.88,
  fuzzy: 0.6,
} as const;

/**
 * Immutable lookup index over the canonical player table.
 *
 * Built once per request/job from the player rows; all lookups are O(1) except
 * the fuzzy stage, which is bounded to players sharing a surname or an initial
 * form.
 */
export class PlayerIndex {
  readonly players: readonly CanonicalPlayer[];
  private readonly byId = new Map<string, CanonicalPlayer>();
  private readonly byExternal = new Map<string, CanonicalPlayer[]>();
  private readonly byName = new Map<string, CanonicalPlayer[]>();
  private readonly byAlias = new Map<string, CanonicalPlayer[]>();
  private readonly bySurname = new Map<string, CanonicalPlayer[]>();
  private readonly byInitialForm = new Map<string, CanonicalPlayer[]>();
  /** Surname prefix buckets, so a misspelled surname still yields candidates. */
  private readonly bySurnamePrefix = new Map<string, CanonicalPlayer[]>();

  constructor(players: readonly CanonicalPlayer[]) {
    this.players = players;
    for (const p of players) {
      this.byId.set(p.id, p);
      push(this.byName, p.normalizedName || normalizeName(p.fullName), p);
      const surname = normalizedSurname(p.fullName);
      push(this.bySurname, surname, p);
      if (surname) push(this.bySurnamePrefix, surnamePrefix(surname), p);
      const init = initialForm(p.fullName);
      if (init) push(this.byInitialForm, init, p);
      if (p.sleeperPlayerId) push(this.byExternal, extKey('sleeper', p.sleeperPlayerId), p);
      for (const [source, value] of Object.entries(p.externalIds ?? {})) {
        if (value) push(this.byExternal, extKey(source, value), p);
      }
      for (const alias of p.aliases ?? []) {
        const norm = normalizeName(alias);
        if (norm) push(this.byAlias, norm, p);
      }
    }
  }

  get(playerId: string): CanonicalPlayer | undefined {
    return this.byId.get(playerId);
  }

  /** All players whose normalized full name equals `normalized`. */
  byNormalizedName(normalized: string): CanonicalPlayer[] {
    return this.byName.get(normalized) ?? [];
  }

  bySurnameKey(surname: string): CanonicalPlayer[] {
    return this.bySurname.get(surname) ?? [];
  }

  byExternalId(source: string, value: string): CanonicalPlayer[] {
    return this.byExternal.get(extKey(source, value)) ?? [];
  }

  byAliasKey(normalizedAlias: string): CanonicalPlayer[] {
    return this.byAlias.get(normalizedAlias) ?? [];
  }

  byInitial(form: string): CanonicalPlayer[] {
    return this.byInitialForm.get(form) ?? [];
  }

  /** Players whose surname shares a short prefix with `surname`. */
  bySurnameNeighbourhood(surname: string): CanonicalPlayer[] {
    return this.bySurnamePrefix.get(surnamePrefix(surname)) ?? [];
  }
}

/** Bucket key for near-miss surnames: first three characters. */
function surnamePrefix(surname: string): string {
  return surname.slice(0, 3);
}

function extKey(source: string, value: string): string {
  return `${source.toLowerCase()}::${value}`;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  if (!key) return;
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

/** Active players sort ahead of inactive ones; otherwise stable by id. */
function preferActive(a: CanonicalPlayer, b: CanonicalPlayer): number {
  if (a.active !== b.active) return a.active ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function candidate(
  player: CanonicalPlayer,
  method: MatchCandidate['method'],
  detail: string,
  confidence = CONFIDENCE[method],
): MatchCandidate {
  return { playerId: player.id, player, method, confidence, detail };
}

function matched(c: MatchCandidate, reason: string): MatchResult {
  return {
    status: 'matched',
    playerId: c.playerId,
    method: c.method,
    confidence: c.confidence,
    candidates: [c],
    reason,
  };
}

function ambiguous(candidates: MatchCandidate[], reason: string): MatchResult {
  return {
    status: 'ambiguous',
    playerId: null,
    method: null,
    confidence: 0,
    candidates,
    reason,
  };
}

function unmatched(reason: string, candidates: MatchCandidate[] = []): MatchResult {
  return { status: 'unmatched', playerId: null, method: null, confidence: 0, candidates, reason };
}

/**
 * Resolve a raw player reference to a canonical player.
 *
 * Never throws. Never silently guesses: an under-determined reference comes back
 * as `ambiguous` with the candidate list attached.
 */
export function resolvePlayer(query: MatchQuery, index: PlayerIndex): MatchResult {
  const name = normalizeName(query.name ?? '');
  const team = normalizeTeam(query.team);
  const position = normalizePosition(query.position);

  // 1. exact external provider id --------------------------------------------
  for (const [source, value] of Object.entries(query.externalIds ?? {})) {
    if (!value) continue;
    const hits = index.byExternalId(source, String(value));
    if (hits.length === 1) {
      return matched(
        candidate(hits[0]!, 'external_id', `exact ${source} id ${value}`),
        `matched on ${source} id`,
      );
    }
    if (hits.length > 1) {
      return ambiguous(
        hits.map((p) => candidate(p, 'external_id', `${source} id ${value}`)),
        `external id ${source}:${value} maps to ${hits.length} players`,
      );
    }
  }

  if (!name) return unmatched('empty name and no external id');

  const nameHits = index.byNormalizedName(name);

  // 2. exact normalized full name + team --------------------------------------
  if (team) {
    const hits = nameHits.filter((p) => p.team === team);
    if (hits.length === 1) {
      return matched(
        candidate(hits[0]!, 'name_team', `name + team ${team}`),
        `matched on normalized name + team`,
      );
    }
    if (hits.length > 1) {
      return ambiguous(
        hits.map((p) => candidate(p, 'name_team', `name + team ${team}`)),
        `${hits.length} players share name "${name}" on ${team}`,
      );
    }
  }

  // 3. exact normalized full name + position ----------------------------------
  if (position) {
    const hits = nameHits.filter((p) => p.position === position);
    if (hits.length === 1) {
      return matched(
        candidate(hits[0]!, 'name_position', `name + position ${position}`),
        `matched on normalized name + position`,
      );
    }
    if (hits.length > 1) {
      return ambiguous(
        hits.map((p) => candidate(p, 'name_position', `name + position ${position}`)),
        `${hits.length} players share name "${name}" at ${position}`,
      );
    }
  }

  // 4. known alias -------------------------------------------------------------
  const aliasHits = filterByHints(index.byAliasKey(name), team, position);
  if (aliasHits.length === 1) {
    return matched(candidate(aliasHits[0]!, 'alias', `known alias "${query.name}"`), `matched on alias`);
  }
  if (aliasHits.length > 1) {
    return ambiguous(
      aliasHits.map((p) => candidate(p, 'alias', `known alias "${query.name}"`)),
      `alias "${name}" maps to ${aliasHits.length} players`,
    );
  }

  // 5. exact normalized full name, unique among active players -----------------
  if (nameHits.length > 0) {
    const active = nameHits.filter((p) => p.active);
    const pool = active.length > 0 ? active : nameHits;
    if (pool.length === 1) {
      return matched(
        candidate(pool[0]!, 'name_unique', `unique exact name match`),
        `matched on unique normalized name`,
      );
    }
    // Same name, several active players, and no team/position hint to separate
    // them: this must be reviewed, not guessed.
    return ambiguous(
      pool.sort(preferActive).map((p) => candidate(p, 'name_unique', `exact name, ${p.team || 'FA'} ${p.position}`)),
      `${pool.length} active players named "${name}"`,
    );
  }

  // 6. fuzzy candidate generation ---------------------------------------------
  const fuzzy = fuzzyCandidates(name, team, position, index);
  if (fuzzy.length === 0) return unmatched(`no candidate for "${query.name}"`);

  const best = fuzzy[0]!;
  if (canAutoCommitFuzzy(best, fuzzy, team, position)) {
    return matched(best, `auto-committed high-confidence fuzzy match (${best.detail})`);
  }
  return ambiguous(fuzzy, `fuzzy match for "${query.name}" needs review`);
}

function filterByHints(
  players: CanonicalPlayer[],
  team: string,
  position: string,
): CanonicalPlayer[] {
  if (players.length <= 1) return players;
  let pool = players;
  if (team) {
    const byTeam = pool.filter((p) => p.team === team);
    if (byTeam.length > 0) pool = byTeam;
  }
  if (pool.length > 1 && position) {
    const byPos = pool.filter((p) => p.position === position);
    if (byPos.length > 0) pool = byPos;
  }
  if (pool.length > 1) {
    const active = pool.filter((p) => p.active);
    if (active.length > 0) pool = active;
  }
  return pool;
}

/**
 * Bounded fuzzy candidate generation: only players sharing the surname or the
 * "F. Last" initial form are considered, then ranked by edit distance.
 */
function fuzzyCandidates(
  name: string,
  team: string,
  position: string,
  index: PlayerIndex,
): MatchCandidate[] {
  const surname = normalizedSurname(name);
  const pool = new Map<string, CanonicalPlayer>();
  for (const p of index.bySurnameKey(surname)) pool.set(p.id, p);
  // Misspelled surnames ("Nacau" for "Nacua") never hit the exact bucket, so
  // widen to the surname-prefix neighbourhood before giving up.
  for (const p of index.bySurnameNeighbourhood(surname)) pool.set(p.id, p);
  const init = initialForm(name);
  if (init) for (const p of index.byInitial(init)) pool.set(p.id, p);

  const scored: MatchCandidate[] = [];
  for (const p of pool.values()) {
    const dist = editDistance(name, p.normalizedName || normalizeName(p.fullName), 3);
    if (dist > 3) continue;
    const sameTeam = !!team && p.team === team;
    const samePos = !!position && p.position === position;
    let confidence = CONFIDENCE.fuzzy - dist * 0.1;
    if (sameTeam) confidence += 0.15;
    if (samePos) confidence += 0.07;
    if (!p.active) confidence -= 0.2;
    scored.push({
      playerId: p.id,
      player: p,
      method: 'fuzzy',
      confidence: Math.max(0, Math.min(0.95, Number(confidence.toFixed(3)))),
      detail: `edit distance ${dist}${sameTeam ? ', same team' : ''}${samePos ? ', same position' : ''}`,
      editDistance: dist,
    });
  }
  scored.sort((a, b) => b.confidence - a.confidence || preferActive(a.player, b.player));
  return scored.slice(0, 5);
}

function canAutoCommitFuzzy(
  best: MatchCandidate,
  all: MatchCandidate[],
  team: string,
  position: string,
): boolean {
  if (AUTO_FUZZY.requireSameTeam && (!team || best.player.team !== team)) return false;
  if (AUTO_FUZZY.requireSamePosition && (!position || best.player.position !== position)) return false;
  if (!best.player.active) return false;
  if ((best.editDistance ?? Number.POSITIVE_INFINITY) > AUTO_FUZZY.maxEditDistance) return false;
  // No conflicting active player may look equally plausible.
  const rivals = all.filter(
    (c) => c.playerId !== best.playerId && c.player.active && c.confidence >= best.confidence - 0.05,
  );
  if (rivals.length > 0) return false;
  return best.confidence >= AUTO_FUZZY.confidence;
}
