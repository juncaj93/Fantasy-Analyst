/**
 * Ask Sleeper's GraphQL endpoint what it can actually be asked.
 *
 * The draft screen in Sleeper's own app orders players by ADP, so that number
 * exists somewhere. Guessing field names found nothing — but a guess failing is
 * not evidence of absence, and the error it returned ("Did you mean
 * \"metadata\"?") showed the server is willing to describe its own schema.
 *
 * So: introspect. If introspection is switched off, fall back to reading the
 * suggestions out of the error messages, which leak field names one at a time.
 *
 * Prints only; changes nothing.
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

async function gql(query, variables) {
  const res = await fetch('https://sleeper.app/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify(variables ? { query, variables } : { query }),
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: null, text: text.slice(0, 300) };
  }
}

const INTERESTING = /adp|rank|draft|board|trend|value|projection/i;

// ------------------------------------------------------- 1. introspection ---
console.log('=== can the schema describe itself? ===');
const schema = await gql('{__schema{queryType{name fields{name description args{name type{name kind ofType{name}}}}}}}');
console.log('  status:', schema.status);

let fields = schema.body?.data?.__schema?.queryType?.fields ?? null;
if (!fields) {
  console.log('  introspection unavailable:', JSON.stringify(schema.body?.errors?.[0]?.message ?? schema.text ?? '?').slice(0, 200));
} else {
  console.log(`  ${fields.length} query fields`);
  const hits = fields.filter((f) => INTERESTING.test(f.name));
  console.log(`\n=== fields that could carry a draft order (${hits.length}) ===`);
  for (const f of hits) {
    const args = f.args.map((a) => `${a.name}: ${a.type?.name ?? a.type?.ofType?.name ?? a.type?.kind}`).join(', ');
    console.log(`  ${f.name}(${args})`);
    if (f.description) console.log(`      ${f.description}`);
  }
  console.log('\n=== every field name, for the record ===');
  console.log(' ', fields.map((f) => f.name).join(', '));
}

// ------------------------------------------- 2. what the error messages leak --
// Even with introspection off, an unknown field is answered with a suggestion,
// which is a slow but reliable way to learn the vocabulary.
if (!fields) {
  console.log('\n=== probing names, reading the suggestions ===');
  for (const guess of ['adp', 'adp_data', 'draft_rankings', 'rankings', 'players_adp', 'draft_board', 'league_draft']) {
    const r = await gql(`{${guess}{__typename}}`);
    const messages = (r.body?.errors ?? []).map((e) => e.message).filter((m) => /Did you mean|Cannot query/.test(m));
    console.log(`  ${guess}: ${messages[0] ?? 'no error — the field exists'}`);
  }
}

// --------------------------------------------- 3. what the draft screen calls --
// Paths are tried against the real draft, because an endpoint that needs a
// draft id returns 404 for a made-up one and tells you nothing.
const draftId = process.env.DRAFT_ID;
console.log('\n=== REST paths, against the live draft ===');
if (!draftId) {
  console.log('  (no draft id — skipped)');
} else {
  const paths = [
    `https://api.sleeper.app/v1/draft/${draftId}`,
    `https://api.sleeper.app/v1/draft/${draftId}/rankings`,
    `https://api.sleeper.app/v1/draft/${draftId}/adp`,
    `https://api.sleeper.app/v1/draft/${draftId}/players`,
    `https://api.sleeper.app/v1/draft/${draftId}/board`,
    'https://api.sleeper.app/v1/rankings/nfl/regular/2026',
    'https://api.sleeper.app/v1/players/nfl/rankings',
    'https://api.sleeper.app/adp/nfl/2026',
  ];
  for (const url of paths) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA } });
      const text = await res.text();
      console.log(`  ${res.status}  ${text.length}b  ${url}`);
      // A draft object may name the ranking it was built with, which is the
      // thread worth pulling even when the path itself is a dead end.
      if (res.ok && text.length > 2) {
        const head = text.slice(0, 400).replace(/\s+/g, ' ');
        console.log(`      ${head}`);
      }
    } catch (err) {
      console.log(`  failed  ${url}: ${err.message}`);
    }
  }
}
