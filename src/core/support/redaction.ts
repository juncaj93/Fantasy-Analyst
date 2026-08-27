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
 * Stable, support-local names for everything in a snapshot that points at a
 * real person — directly, or by being something anybody can look up.
 *
 * Allocated in first-seen order over a deterministic walk of the snapshot, so
 * the same league captured twice produces the same aliases and two snapshots of
 * the same draft can be diffed against each other. Every alias is a valid
 * opaque id as far as every consumer is concerned — the board only ever
 * compares these for equality — so the slot → roster → owner chain, the
 * manager-history match, `isMine` and the draft-to-league link all behave
 * exactly as they did.
 *
 * ## The league and draft ids are aliased too, and that is the important part
 *
 * A Sleeper user id is obviously an identity. A Sleeper *league* id does not
 * look like one, and it is worse: `GET /v1/league/<id>/users` is public, needs
 * no key, and returns every manager's username and display name. So a snapshot
 * that carefully replaced eleven user ids with `manager-N` and then printed the
 * league id would have handed all eleven of them back to anybody who typed one
 * URL. The draft id is the same story through `/v1/draft/<id>/picks`, which
 * carries `picked_by`.
 *
 * `LeagueRecord.id` *is* the Sleeper league id in this app — see
 * `toLeagueRecord` — so there is no internal identifier to fall back on and the
 * alias has to be the whole answer. Nothing is lost: the board compares these
 * ids against each other and never against the outside world, and the person
 * who captured the file already knows which league they were in.
 *
 * The map is held by the caller for the duration of one capture and thrown
 * away. It is never serialised: a file carrying `{"manager-3": "782...041"}`
 * would be a snapshot with the PII put back in an appendix.
 */
export class SnapshotAliases {
  private readonly byId = new Map<string, string>();
  /** Aliases already handed out for display names, keyed by the real name. */
  private readonly byName = new Map<string, string>();
  /** Aliases for league and draft ids, keyed by the real Sleeper id. */
  private readonly byScope = new Map<string, string>();
  /**
   * Other strings that must become an alias already handed out.
   *
   * The league's own *name* is the one that matters: it is replaced wholesale in
   * the inputs, and it is also echoed back in several outputs — a matchup
   * response prints it in its header block — so a capture that aliased the id
   * and copied the name would have published the commissioner's own words
   * anyway. Kept in its own map so registering one does not perturb the `league-N`
   * / `draft-N` numbering, which is allocated by counting `byScope`.
   */
  private readonly byLabel = new Map<string, string>();

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

  /**
   * The alias for a Sleeper league id, or for a draft id.
   *
   * One counter per kind so the aliases read as what they are — `league-1`,
   * `draft-1` — and one map, because a league id and a draft id are never the
   * same string and collapsing them would only make the code longer.
   */
  scope(kind: 'league' | 'draft', id: string | null | undefined): string | null {
    if (id == null || id === '') return null;
    const existing = this.byScope.get(id);
    if (existing) return existing;
    const seen = [...this.byScope.values()].filter((alias) => alias.startsWith(`${kind}-`)).length;
    const alias = `${kind}-${seen + 1}`;
    this.byScope.set(id, alias);
    return alias;
  }

  /**
   * Record a further string that must be replaced with an alias already given.
   *
   * For a value that is not itself an identifier the engine follows, but that
   * names the same thing — a league's display name beside its id.
   */
  label(real: string | null | undefined, alias: string): void {
    if (real == null || real === '' || real === alias) return;
    this.byLabel.set(real, alias);
  }

  /** How many distinct identifiers were aliased. Reported in the snapshot. */
  get counts(): { ids: number; names: number; scopes: number; labels: number } {
    return { ids: this.byId.size, names: this.byName.size, scopes: this.byScope.size, labels: this.byLabel.size };
  }

  /**
   * Replace every aliased id found anywhere in a free-text string.
   *
   * For the places an identifier reaches a sentence: manager-history notes are
   * composed upstream and quote a display name, a matchup fingerprint hashes the
   * league id into the string that seeds its simulation, and a trade's fit
   * reasons name the manager they are about. Applied after every id and name has
   * been allocated, so it can only ever replace, never allocate.
   *
   * **Matched on word boundaries, not as a bare substring.** A display name is
   * whatever the manager typed, and short common words are ordinary: this app's
   * own seeded league has a manager called `You`, and a substring replace turned
   * every `Your roster is 22.1 pts better` into `Manager 1r roster is 22.1 pts
   * better` — a redaction that corrupted the sentences it was protecting. The
   * boundary is asserted only on a side where the identifier itself ends in a
   * word character, so a name wrapped in punctuation is still replaced.
   */
  scrub(text: string): string {
    let out = text;
    for (const source of [this.byId, this.byName, this.byScope, this.byLabel]) {
      for (const [real, alias] of source) out = out.replace(boundedPattern(real), alias);
    }
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
  'The Sleeper league id, the draft id and the league’s name are replaced too (league-1, draft-1) — the league id is enough on its own to look every manager’s username up through Sleeper’s public API.',
  'Newsletter excerpts and context summaries are excluded; only the numeric tallies derived from them travel.',
  'Cookies, session tokens, request headers, provider API keys and passphrases are excluded, and a snapshot containing one is refused rather than emitted.',
  'Email addresses are excluded, including the app’s own newsletter address.',
  'Raw Sleeper pick payloads are reduced to the four player-name fields the board reads as a fallback.',
  'Players are identified by canonical player id; nothing outside the league’s own rosters is included.',
];

/** Raised when a capture would have emitted something it must not. */
export class SnapshotRedactionError extends Error {
  /*
   * A plain field rather than a constructor parameter property.
   *
   * Parameter properties are a TypeScript *transform*, not a type annotation,
   * and Node's `--experimental-strip-types` refuses them. The replay CLI runs
   * the shipped modules through exactly that loader — see
   * `scripts/support-fixture.ts` — so anything on this path stays inside what
   * type-stripping alone can erase.
   */
  readonly violations: { path: string; reason: string }[];

  constructor(violations: { path: string; reason: string }[]) {
    super(
      `refusing to emit a support snapshot: ${violations.length} field${violations.length === 1 ? '' : 's'} must not be in one — ` +
        violations.map((v) => `${v.path} (${v.reason})`).join('; '),
    );
    this.name = 'SnapshotRedactionError';
    this.violations = violations;
  }
}

/**
 * One identifier, as a global pattern that will not match inside a longer word.
 *
 * The assertions are conditional because an identifier is not always a word: a
 * name of `(commish)` has no word character at either end, and demanding a
 * boundary there would mean never replacing it. Lookbehind is supported
 * everywhere this runs — Workers, Node 22 and every browser the app targets.
 */
function boundedPattern(literal: string): RegExp {
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const before = /^[\p{L}\p{N}_]/u.test(literal) ? '(?<![\\p{L}\\p{N}_])' : '';
  const after = /[\p{L}\p{N}_]$/u.test(literal) ? '(?![\\p{L}\\p{N}_])' : '';
  return new RegExp(`${before}${escaped}${after}`, 'gu');
}
