/**
 * Does anything Sleeper returns about a player carry a draft position?
 *
 * The schema has ~240 query fields and not one is named for ADP or ranking.
 * That is suggestive but not conclusive: the number could live as a field on
 * the player type itself, reached through a query with an unrelated name. The
 * draft screen has to get its ordering from somewhere.
 *
 * So walk the types behind the queries a draft screen would plausibly call, and
 * look for a field that could be a draft position.
 *
 * Prints only; changes nothing.
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

async function gql(query) {
  const res = await fetch('https://sleeper.app/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { errors: [{ message: text.slice(0, 200) }] };
  }
}

// The schema is snake_cased throughout, introspection types included.
const FIELD_TYPES = `{__schema{query_type{fields{name type{name kind of_type{name kind of_type{name}}}}}}}`;

const CANDIDATES = [
  'get_active_players',
  'search_players',
  'trending_players',
  'league_players',
  'get_player',
  'draft_queue',
  'get_user_draft_settings',
  'my_picks_init',
  'get_draft',
  'metadata',
];

const named = (t) => t?.name ?? t?.of_type?.name ?? t?.of_type?.of_type?.name ?? null;

const schema = await gql(FIELD_TYPES);
const fields = schema?.data?.__schema?.query_type?.fields ?? [];
console.log(`=== return types of the queries a draft screen would call ===`);

const typeNames = new Set();
for (const name of CANDIDATES) {
  const f = fields.find((x) => x.name === name);
  const t = f ? named(f.type) : null;
  console.log(`  ${name.padEnd(24)} -> ${t ?? '(not in schema)'}`);
  if (t) typeNames.add(t);
}

const LOOKS_LIKE_DRAFT_POSITION = /adp|rank|draft|pick|order|position|value|tier/i;

console.log('\n=== fields on those types ===');
for (const typeName of typeNames) {
  const res = await gql(`{__type(name:"${typeName}"){name fields{name type{name kind of_type{name}}}}}`);
  const t = res?.data?.__type;
  if (!t?.fields) {
    console.log(`  ${typeName}: ${res?.errors?.[0]?.message?.slice(0, 100) ?? 'no fields'}`);
    continue;
  }
  const hits = t.fields.filter((f) => LOOKS_LIKE_DRAFT_POSITION.test(f.name));
  console.log(`\n  ${typeName} (${t.fields.length} fields)`);
  console.log(`    could be a draft position: ${hits.length ? hits.map((f) => `${f.name}: ${named(f.type)}`).join(', ') : 'none'}`);
  console.log(`    all: ${t.fields.map((f) => f.name).join(', ')}`);
}
