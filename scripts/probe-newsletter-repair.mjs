/**
 * What does the live app make of the newsletter that failed to parse?
 *
 * The MIME repair is proven by tests against fixtures in the repository, but
 * the thing that matters is the real issue sitting in production: the one that
 * was received, read, and turned 209 player sentences into a single signal.
 * This asks the deployed site directly.
 *
 * Reads only, and only public endpoints — no passphrase, no writes. In
 * particular `/preview` is the exact endpoint behind **Check what would
 * change**: it computes a difference and stores nothing, so running this can
 * never mutate evidence, tallies or review state. Every request below is a GET
 * and the script refuses to make any other kind.
 *
 * Run it from the Probe workflow (Actions -> Probe -> probe-newsletter-repair.mjs),
 * because the development sandbox cannot reach Cloudflare.
 */

const URL_BASE = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';

/**
 * Shapes that are never a player's name.
 *
 * These are the exact artefacts the broken parser offered the user under
 * "Names not in the player list": quoted-printable escapes read as words, and
 * base64 out of a Substack redirect target. Any of them still present after the
 * repair means the fix did not reach production.
 */
const ARTEFACT = [
  { id: 'quoted-printable', re: /=[0-9A-Fa-f]{2}/ },
  { id: 'url', re: /https?:|www\.|substack|redirect/i },
  { id: 'mime-header', re: /content-(type|transfer-encoding)|charset|boundary|mimepart/i },
  { id: 'markup', re: /[<>"/\\]/ },
  { id: 'non-name-character', re: /[^A-Za-z'’.\- ]/ },
];

/** Punctuation that should never survive decoding into a stored excerpt. */
const GARBAGE_IN_TEXT = [
  { id: 'quoted-printable', re: /=[0-9A-F]{2}/ },
  { id: 'mime-boundary', re: /^--|mimepart/im },
  { id: 'mime-header', re: /content-(type|transfer-encoding):/i },
  { id: 'tracking-url', re: /https?:\/\/\S*substack\S*redirect/i },
  { id: 'mojibake', re: /[Â-Åâã][-¿]/ },
];

async function get(path) {
  const res = await fetch(`${URL_BASE}${path}`, { method: 'GET', headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
  return res.json();
}

function classifyArtefacts(names) {
  const bad = [];
  for (const name of names ?? []) {
    const hit = ARTEFACT.find((a) => a.re.test(name));
    if (hit) bad.push({ name, why: hit.id });
  }
  return bad;
}

function scanText(text) {
  return GARBAGE_IN_TEXT.filter((g) => g.re.test(text ?? '')).map((g) => g.id);
}

function heading(title) {
  console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`);
}

async function main() {
  console.log(`Site: ${URL_BASE}`);
  console.log(`Read-only: every request is a GET; /preview computes and stores nothing.`);

  const { messages = [] } = await get('/api/newsletter/messages');
  console.log(`\n${messages.length} message(s) in the log.`);

  const processed = messages.filter((m) => m.status === 'processed');
  if (processed.length === 0) {
    console.log('No processed newsletters to inspect. Nothing further to report.');
    return;
  }

  heading('EVERY PROCESSED NEWSLETTER, AS THE LIVE PARSER CURRENTLY READS IT');
  for (const m of processed) {
    const c = m.coverage ?? {};
    console.log(
      [
        `${m.receivedAt?.slice(0, 10)}  "${m.subject || '(no subject)'}"`,
        `  id                 : ${m.messageId}`,
        `  body retained      : ${m.bodyRetained ? 'yes' : 'NO — cannot be re-read'}`,
        `  evidence           : ${m.evidenceCount} (auto ${m.autoAppliedCount}, pending ${m.pendingCount})`,
        `  identity reviews   : ${m.identityReviewCount}`,
        // `sentences` and `repairs` only exist once the repaired build is live;
        // their absence is itself a fact worth printing.
        `  sentences found    : ${c.sentences ?? '(not reported by this build)'}`,
        `  repairs needed     : ${c.repairs ? (c.repairs.length ? c.repairs.join(', ') : 'none') : '(not reported by this build)'}`,
        `  with players       : ${c.sentencesWithPlayers ?? 0}`,
        `  became a signal    : ${c.classifiedSentences ?? 0}`,
        `  no rule matched    : ${c.unclassifiedSentences ?? 0}`,
        `  unclear which player: ${c.ambiguousIdentitySentences ?? 0}`,
      ].join('\n'),
    );

    const bad = classifyArtefacts(c.unknownNames);
    console.log(`  unknown names      : ${(c.unknownNames ?? []).length} total, ${bad.length} artefact(s)`);
    for (const b of bad) console.log(`      ARTEFACT [${b.why}]: ${JSON.stringify(b.name)}`);
    for (const n of (c.unknownNames ?? []).filter((n) => !bad.some((b) => b.name === n))) {
      console.log(`      genuine unknown : ${JSON.stringify(n)}`);
    }

    for (const s of c.samples ?? []) {
      const g = scanText(s.excerpt);
      console.log(`      no-rule sample  : ${JSON.stringify(s.excerpt)}`);
      console.log(`                        players: ${(s.players ?? []).join(', ')}`);
      if (g.length) console.log(`                        *** UNDECODED TEXT: ${g.join(', ')} ***`);
    }
  }

  // The affected issue is whichever one the parser struggled with most: many
  // player sentences, almost none of them classified.
  const affected = [...processed].sort((a, b) => {
    const miss = (m) => (m.coverage?.unclassifiedSentences ?? 0) + (m.coverage?.ambiguousIdentitySentences ?? 0);
    return miss(b) - miss(a);
  });

  heading('CHECK WHAT WOULD CHANGE — the repair preview, per newsletter');
  for (const m of affected) {
    if (!m.bodyRetained) {
      console.log(`\n"${m.subject}" (${m.messageId}): body not retained, cannot be re-read.`);
      continue;
    }
    console.log(`\n--- "${m.subject || '(no subject)'}"  [${m.messageId}] ---`);
    let preview;
    try {
      preview = await get(`/api/newsletter/messages/${encodeURIComponent(m.messageId)}/preview`);
    } catch (err) {
      console.log(`  preview failed: ${err.message}`);
      continue;
    }

    const c = preview.coverage ?? {};
    console.log(`  detail            : ${preview.detail}`);
    console.log(`  repairs detected  : ${preview.repairs ? (preview.repairs.length ? preview.repairs.join(', ') : 'none') : '(not reported by this build)'}`);
    console.log(`  rows to ADD       : ${preview.wouldAdd}`);
    console.log(`  rows already there: ${preview.alreadyStored}`);
    console.log(`  rows to RETIRE    : ${preview.wouldRetire ? preview.wouldRetire.length : '(not reported by this build)'}`);
    console.log(`  user-ruled rows   : ${preview.protectedByUser.length}  <-- must be untouched`);
    console.log(`  rules now disagree: ${preview.stale.length} (left as they are)`);
    console.log(`  players affected  : ${preview.playersAffected}`);

    for (const r of preview.wouldRetire ?? []) {
      console.log(`      RETIRE  ${r.playerId}  ${r.storedPolarity}/${r.storedMagnitude}  ${JSON.stringify(r.excerpt.slice(0, 120))}`);
    }
    for (const p of preview.protectedByUser) {
      console.log(`      PROTECTED (user ruled)  ${p.playerId}  ${JSON.stringify(p.excerpt.slice(0, 120))}`);
    }
    for (const d of preview.tallyDelta ?? []) {
      console.log(`      tally delta  ${d.playerId}: ${d.net > 0 ? '+' : ''}${d.net}`);
    }

    console.log(`  --- coverage the repaired parse reports ---`);
    console.log(`  sentences found    : ${c.sentences ?? '(not reported)'}`);
    console.log(`  with players       : ${c.sentencesWithPlayers ?? 0}`);
    console.log(`  became a signal    : ${c.classifiedSentences ?? 0}`);
    console.log(`  no rule matched    : ${c.unclassifiedSentences ?? 0}`);
    console.log(`  unclear which player: ${c.ambiguousIdentitySentences ?? 0}`);

    const bad = classifyArtefacts(c.unknownNames);
    console.log(`  unknown names      : ${(c.unknownNames ?? []).length} total, ${bad.length} artefact(s)`);
    for (const b of bad) console.log(`      ARTEFACT [${b.why}]: ${JSON.stringify(b.name)}`);
    for (const n of (c.unknownNames ?? []).filter((n) => !bad.some((b) => b.name === n))) {
      console.log(`      genuine unknown : ${JSON.stringify(n)}`);
    }

    // Sentences that mention a player and match no rule are the only place a
    // genuinely missing rule can be discovered. Print them all, undecoded or not.
    console.log(`  --- every sentence with a player that matched no rule ---`);
    for (const s of c.samples ?? []) {
      const g = scanText(s.excerpt);
      console.log(`      ${JSON.stringify(s.excerpt)}`);
      console.log(`        players: ${(s.players ?? []).join(', ')}${g.length ? `   *** UNDECODED: ${g.join(', ')} ***` : ''}`);
    }
  }

  heading('VERDICT');
  let artefacts = 0;
  let undecoded = 0;
  let userRuled = 0;
  for (const m of processed) {
    artefacts += classifyArtefacts(m.coverage?.unknownNames).length;
    for (const s of m.coverage?.samples ?? []) undecoded += scanText(s.excerpt).length ? 1 : 0;
  }
  for (const m of affected) {
    if (!m.bodyRetained) continue;
    try {
      const p = await get(`/api/newsletter/messages/${encodeURIComponent(m.messageId)}/preview`);
      userRuled += p.protectedByUser.length;
    } catch {
      // Already reported above.
    }
  }
  console.log(`stored coverage still showing name artefacts : ${artefacts}`);
  console.log(`stored coverage still showing undecoded text : ${undecoded}`);
  console.log(`user-ruled rows a repair would touch         : must be 0 -> ${userRuled} reported as protected`);
}

main().catch((err) => {
  console.error(`probe failed: ${err.stack ?? err.message}`);
  process.exitCode = 1;
});
