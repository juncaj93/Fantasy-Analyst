/**
 * What a support snapshot is not allowed to contain, and how it is kept out.
 *
 * A snapshot exists to be *sent somewhere* — pasted into ChatGPT, attached to a
 * message, committed as a fixture. That is a completely different risk profile
 * from a log line, and it is the reason redaction is a module with tests rather
 * than a paragraph in a brief. The rule is that nothing which identifies a
 * person survives capture, and that the check runs over the finished file
 * rather than over each field on the way in — because the failure mode worth
 * catching is the field somebody adds next year without reading this.
 *
 * ## Two mechanisms, doing different jobs
 *
 * **Aliasing** replaces identifiers the engine actually needs. A Sleeper user
 * id is not decoration: the board follows slot → roster → owner to attach
 * manager history to a seat, so deleting it would change the answer. Each real
 * id is therefore mapped to a stable support-local alias, consistently
 * everywhere it appears, and the chain resolves exactly as it did. The mapping
 * is one-way and is never written into the file.
 *
 * **Scanning** is the backstop. It walks the finished snapshot looking for
 * shapes that must never be there at all — credentials, addresses, header
 * blobs — and refuses the whole file rather than emitting a redacted-ish one.
 * Capture runs it before returning and replay runs it before reading, so a
 * snapshot that acquired a secret between the two is refused at the second gate
 * as well as the first.
 */

/**
 * Keys that may never appear in a snapshot, at any depth.
 *
 * Matched case-insensitively against the key with separators removed, so
 * `api_key`, `apiKey` and `API-KEY` are one entry. These are the names the
 * things this app touches actually use: Sleeper needs no key, but the Vegas
 * providers do, the session layer has a secret and a cookie, and the newsletter
 * path handles mail.
 */
const FORBIDDEN_KEYS = [
  'cookie',
  'setcookie',
  'authorization',
  'auth',
  'headers',
  'token',
  'accesstoken',
  'refreshtoken',
  'apikey',
  'secret',
  'sessionsecret',
  'password',
  'passphrase',
  'credential',
  'email',
  'emailaddress',
  'bearer',
  /*
   * The newsletter's own words.
   *
   * The evidence ledger keeps every original excerpt, and a tally is derived
   * from it. The tally is what the draft board reads; the excerpt is somebody
   * else's copyrighted paragraph about a third party and has no business in a
   * file the user is about to paste into a chat window. Only the numbers travel.
   */
  'excerpt',
  'excerpts',
  'contextsummary',
];

/**
 * Value shapes that must never appear, whatever they are called.
 *
 * Kept deliberately short. A broad "looks like a secret" regex over a file
 * containing hundreds of player ids and hashes would fire constantly, and a
 * check that cries wolf is a check that gets deleted — so this is limited to
 * two shapes that are unambiguous and that this app genuinely handles.
 */
const FORBIDDEN_VALUE_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'email address', pattern: /[\w.+-]+@[\w-]+\.[\w.-]+/ },
  { name: 'bearer token', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/i },
];

/** One thing the scan objected to, with enough path to find it. */
export interface RedactionViolation {
  /** `decision.inputs.league.leagueSettings.apiKey` */
  path: string;
  reason: string;
}

const normaliseKey = (key: string): string => key.toLowerCase().replace(/[^a-z]/g, '');

/**
 * Walk a value and report everything that must not be in a snapshot.
 *
 * Returns every violation rather than the first, because a caller refusing a
 * capture is going to have to fix all of them and a list beats a game of
 * whack-a-mole. Depth is bounded: a snapshot is a tree of plain data, and a
 * cycle here would mean something has gone wrong far upstream of redaction.
 */
export function findRedactionViolations(value: unknown, path = ''): RedactionViolation[] {
  const found: RedactionViolation[] = [];
  const seen = new Set<object>();

  const walk = (node: unknown, at: string): void => {
    if (node == null) return;

    if (typeof node === 'string') {
      for (const { name, pattern } of FORBIDDEN_VALUE_PATTERNS) {
        if (pattern.test(node)) found.push({ path: at, reason: `looks like ${'aeiou'.includes(name[0]!) ? 'an' : 'a'} ${name}` });
      }
      return;
    }

    if (typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${at}[${i}]`));
      return;
    }

    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const here = at === '' ? key : `${at}.${key}`;
      if (FORBIDDEN_KEYS.includes(normaliseKey(key))) {
        found.push({ path: here, reason: `\`${key}\` is a forbidden field in a support snapshot` });
        // Still walk it: a forbidden key holding an object of further forbidden
        // keys should report all of them, so one pass fixes the whole branch.
      }
      walk(child, here);
    }
  };

  walk(value, path);
  return found;
}

/**
 * Stable, support-local names for the people in a league.
 *
 * Allocated in first-seen order over a deterministic walk of the snapshot, so
 * the same league captured twice produces the same aliases and two snapshots of
 * the same draft can be diffed against each other. `manager-1` is a valid
 * Sleeper-shaped opaque id as far as every consumer is concerned — the board
 * only ever compares owner ids for equality — so the slot → roster → owner
 * chain, the manager-history match and `isMine` all behave exactly as they did.
 *
 * The map is held by the caller for the duration of one capture and thrown
 * away. It is never serialised: a file carrying `{"manager-3": "782...041"}`
 * would be a snapshot with the PII put back in an appendix.
 */
export class ManagerAliases {
  private readonly byId = new Map<string, string>();
  /** Aliases already handed out for display names, keyed by the real name. */
  private readonly byName = new Map<string, string>();

  /**
   * The alias for one Sleeper user id.
   *
   * `null` in, `null` out — an unowned roster is a real state (an orphan team,
   * a league mid-transfer) and inventing a manager for it would replay a
   * different league.
   */
  id(userId: string | null | undefined): string | null {
    if (userId == null || userId === '') return null;
    const existing = this.byId.get(userId);
    if (existing) return existing;
    const alias = `manager-${this.byId.size + 1}`;
    this.byId.set(userId, alias);
    return alias;
  }

  /**
   * The alias for a display name.
   *
   * Numbered from the same sequence as ids where the pair is known, so
   * `manager-3` and `Manager 3` are the same person on the same board. Where a
   * name arrives without its id — which happens in the manager-history notes —
   * it gets its own entry rather than being dropped, because a note reading
   * "Manager 7 takes backs early" is still a useful sentence and an empty one
   * is not.
   */
  name(displayName: string | null | undefined, userId?: string | null): string | null {
    if (displayName == null || displayName === '') return null;
    const fromId = userId == null ? null : this.byId.get(userId);
    if (fromId) {
      const alias = `Manager ${fromId.slice('manager-'.length)}`;
      this.byName.set(displayName, alias);
      return alias;
    }
    const existing = this.byName.get(displayName);
    if (existing) return existing;
    const alias = `Manager ${this.byName.size + 1 + this.byId.size}`;
    this.byName.set(displayName, alias);
    return alias;
  }

  /** How many distinct people were aliased. Reported in the snapshot. */
  get counts(): { ids: number; names: number } {
    return { ids: this.byId.size, names: this.byName.size };
  }

  /**
   * Replace every aliased id found anywhere in a free-text string.
   *
   * For the one place an identifier reaches a sentence: manager-history notes
   * are composed upstream and can quote a display name. Applied after every id
   * and name has been allocated, so it can only ever replace, never allocate.
   */
  scrub(text: string): string {
    let out = text;
    for (const [real, alias] of this.byId) out = out.split(real).join(alias);
    for (const [real, alias] of this.byName) out = out.split(real).join(alias);
    return out;
  }
}

/**
 * The rules, in the words a reader of the file should see.
 *
 * Written out into every snapshot rather than kept here alone, because the
 * person deciding whether it is safe to paste this somewhere is holding the
 * file and not the repository.
 */
export const REDACTION_RULES: readonly string[] = [
  'Sleeper user ids and display names are replaced with stable support-local aliases (manager-1, Manager 1).',
  'Newsletter excerpts and context summaries are excluded; only the numeric tallies derived from them travel.',
  'Cookies, session tokens, request headers, provider API keys and passphrases are excluded, and a snapshot containing one is refused rather than emitted.',
  'Email addresses are excluded, including the app’s own newsletter address.',
  'Raw Sleeper pick payloads are reduced to the four player-name fields the board reads as a fallback.',
  'Players are identified by canonical player id; nothing outside the league’s own rosters is included.',
];
