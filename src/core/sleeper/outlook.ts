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
