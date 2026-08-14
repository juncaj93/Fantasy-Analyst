/**
 * The season outlook Sleeper shows on a player card.
 *
 * ## What this is, and what it is not
 *
 * The user asked for the "2026 Season Outlook" they read inside Sleeper. The
 * first job was to find out whether that text is available honestly, because
 * the alternative — pulling it out of the app's own client — is off the table.
 *
 * It is. Sleeper's public GraphQL endpoint exposes `get_player_outlook`, and
 * the schema says so under introspection; the same endpoint this project
 * already queries to establish that Sleeper publishes no ADP. It takes a sport,
 * a player id and a season, needs no key and no account, and answers with the
 * provider's own title, the text, and — the part that decides how this is
 * presented — a `source`.
 *
 * That source is `rotowire`. The text is editorial writing that Sleeper serves,
 * not something Sleeper wrote, so the card attributes it and does not imply the
 * app produced it. An attribution that is stored and never shown is the same as
 * no attribution.
 *
 * ## Why it is fetched one player at a time
 *
 * There is no bulk form of this query, and there should not be a loop that
 * invents one: three hundred requests to build a board nobody has opened is
 * exactly the unbounded third-party fetching this project refuses. It is
 * fetched when a card is opened and then cached — including the misses, which
 * are most players.
 */

/** What the endpoint returns, in the shape it returns it. */
interface OutlookResponse {
  data?: {
    get_player_outlook?: {
      player_id?: string;
      source?: string | null;
      source_key?: string | null;
      metadata?: { title?: string | null; description?: string | null } | null;
    } | null;
  } | null;
  errors?: { message?: string }[];
}

export interface PlayerOutlook {
  playerId: string;
  season: string;
  /** The provider's heading, e.g. `2026 Season Outlook`. */
  title: string | null;
  /** The whole text, as received. */
  body: string;
  /** Who wrote it. `rotowire` at the time of writing. */
  source: string | null;
}

export const SLEEPER_GRAPHQL_URL = 'https://sleeper.app/graphql';

const QUERY =
  'query($sport:String!,$player_id:String!,$season:String!){' +
  'get_player_outlook(sport:$sport,player_id:$player_id,season:$season)' +
  '{player_id source source_key metadata}}';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Ask for one player's outlook. `null` means there is not one, which is the
 * ordinary answer for most of a player dictionary and is not an error.
 */
export async function fetchPlayerOutlook(
  playerId: string,
  season: string,
  opts: { fetch?: FetchLike; url?: string } = {},
): Promise<PlayerOutlook | null> {
  const doFetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const res = await doFetch(opts.url ?? SLEEPER_GRAPHQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: { sport: 'nfl', player_id: playerId, season } }),
  });
  if (!res.ok) throw new Error(`Sleeper outlook ${res.status}`);

  const json = (await res.json()) as OutlookResponse;
  // A GraphQL error is a failure of the request, not an absent outlook. Saying
  // "no outlook" here would cache a lie for a week.
  if (json.errors?.length) throw new Error(json.errors[0]?.message ?? 'Sleeper outlook query rejected');

  const node = json.data?.get_player_outlook;
  const body = node?.metadata?.description?.trim();
  if (!node || !body) return null;
  return {
    playerId,
    season,
    title: node.metadata?.title?.trim() || null,
    body,
    source: node.source?.trim() || null,
  };
}

/** How much of the outlook a draft board is willing to spend space on. */
export const OUTLOOK_SENTENCES = 3;
const OUTLOOK_MAX_CHARS = 340;

/**
 * The first two or three sentences, ending on a sentence.
 *
 * The full text runs to a thousand characters or more, and a wall of prose in
 * the middle of a live draft is not read — it is scrolled past, taking the
 * numbers underneath it off the screen. The opening is also the part worth
 * keeping: this kind of writing leads with role and situation and works
 * backwards into history.
 *
 * Cut on a sentence boundary or not at all. A paragraph clipped mid-clause and
 * given an ellipsis reads as a bug, and the reader cannot tell whether the
 * missing half reversed the point.
 */
export function summariseOutlook(body: string, maxSentences = OUTLOOK_SENTENCES): string {
  const text = body.replace(/\s+/g, ' ').trim();
  if (!text) return '';

  const sentences = splitSentences(text);
  let out = '';
  for (const sentence of sentences.slice(0, maxSentences)) {
    const next = out ? `${out} ${sentence}` : sentence;
    // One sentence longer than the whole budget still gets shown: an outlook
    // that opens with a long sentence is better than an empty section.
    if (out && next.length > OUTLOOK_MAX_CHARS) break;
    out = next;
  }
  return out || sentences[0] || text;
}

/**
 * Sentence boundaries, conservatively.
 *
 * A full stop only ends a sentence when what follows looks like the start of
 * one. That keeps `No. 1 receiver`, `Sept. 14` and the initials these writers
 * are fond of from cutting a sentence in half — the failure mode being a card
 * that shows four words and stops.
 */
function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (!'.!?'.includes(text[i]!)) continue;
    // Run past `?!` and closing quotes or brackets.
    let end = i;
    while (end + 1 < text.length && '.!?"\')]'.includes(text[end + 1]!)) end++;
    const after = text.slice(end + 1);
    if (!/^\s/.test(after)) continue;
    const rest = after.trimStart();
    if (rest && !/^[A-Z0-9“"(]/.test(rest)) continue;
    const sentence = text.slice(start, end + 1).trim();
    // An "abbreviation." is a full stop followed by a capital and is otherwise
    // indistinguishable from a sentence end. Length is the cheap discriminator.
    if (sentence && lastWord(sentence).length > 3) {
      out.push(sentence);
      start = end + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

function lastWord(sentence: string): string {
  const words = sentence.replace(/[.!?"')\]]+$/, '').split(/\s+/);
  return words[words.length - 1] ?? '';
}
