/**
 * Content fingerprints for idempotent newsletter processing.
 *
 * Reprocessing the same email must never duplicate evidence, so every evidence
 * row carries a deterministic dedupe key derived from
 * (message id, player, excerpt, rule). The key is a stable hash, computed
 * without any crypto dependency so it runs identically on Workers and Node.
 */

/** FNV-1a based 128-bit-ish hex digest. Deterministic across runtimes. */
export function stableHash(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xc2b2ae35;
  let h3 = 0x27d4eb2f;
  let h4 = 0x165667b1;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
    h3 = Math.imul(h3 ^ (c ^ (i << 3)), 0xc2b2ae35) >>> 0;
    h4 = Math.imul(h4 ^ (c + (i << 5)), 0x27d4eb2f) >>> 0;
  }
  return [h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, '0')).join('');
}

/** Whitespace/case-insensitive normalization used before hashing content. */
export function canonicalText(input: string): string {
  return input.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Fingerprint for a whole newsletter body — detects re-sends of same content. */
export function contentFingerprint(body: string): string {
  return stableHash(canonicalText(body));
}

/** Dedupe key for one evidence item. */
export function evidenceKey(parts: {
  sourceMessageId: string;
  playerId: string;
  excerpt: string;
  ruleId: string | null;
}): string {
  return stableHash(
    [parts.sourceMessageId, parts.playerId, canonicalText(parts.excerpt), parts.ruleId ?? 'none'].join('|'),
  );
}
