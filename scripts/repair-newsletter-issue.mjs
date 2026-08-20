/**
 * Apply the decoding repair to one stored newsletter, and prove nothing else moved.
 *
 * A newsletter ingested before its MIME could be decoded has evidence derived
 * from garbage. Re-reading it produces the same news spelled properly, which is
 * a different excerpt and therefore a different dedupe key — so the product's
 * reprocess path retires what it replaces rather than adding alongside it. That
 * is the whole hazard: one piece of news counted twice, permanently, in a ledger
 * that is supposed to be authoritative.
 *
 * So this does not simply POST and report success. It guards before, and proves
 * after:
 *
 *   snapshot -> guard the preview -> apply -> verify -> report
 *
 * If the preview no longer has the exact shape that was reviewed and approved,
 * nothing is applied. If the state afterwards is not what the preview promised,
 * it says so and stops rather than continuing to mutate.
 *
 * Everything it does goes through the product's own endpoints. No row is
 * patched directly and no tally is edited: tallies are derived from evidence,
 * and the only way to change one honestly is to change the evidence under it.
 *
 * Usage (see .github/workflows/repair-newsletter.yml):
 *   URL=... PASSPHRASE=... MESSAGE_ID='<...>' node scripts/repair-newsletter-issue.mjs
 */

const URL_BASE = (process.env.URL ?? 'https://fantasy-analyst.juncaj93.workers.dev').replace(/\/$/, '');
const MESSAGE_ID = process.env.MESSAGE_ID ?? '';
const PASSPHRASE = process.env.PASSPHRASE ?? '';
const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DRY_RUN ?? '');

/** Review statuses that still contribute to the ledger. `ignored` does not. */
const LIVE = new Set(['auto_applied', 'accepted', 'corrected', 'pending']);

/** Signatures of text that never survived decoding properly. */
const DIRT = [
  [/=[0-9A-F]{2}/, 'quoted-printable escape'],
  [/<\/?[a-z][^>]*>/i, 'raw markup'],
  [/https?:\/\//i, 'tracking or redirect URL'],
  [/^--|mimepart|Content-(Type|Transfer-Encoding):/i, 'MIME scaffolding'],
  [/[‘’“”–—•]/, 'unnormalized typographic punctuation'],
];

const problems = [];
function check(ok, label, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) problems.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

let cookie = '';

async function api(path, init = {}) {
  const res = await fetch(`${URL_BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 400) };
  }
  return { status: res.status, body, res };
}

async function login() {
  const { status, res, body } = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ passphrase: PASSPHRASE }),
  });
  if (status !== 200) throw new Error(`could not unlock (${status}): ${JSON.stringify(body)}`);
  const jar = res.headers.getSetCookie?.() ?? [];
  cookie = jar.map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('login succeeded but returned no session cookie');
}

/** Evidence rows for one player that came from one newsletter. */
function rowsFromMessage(evidence, messageId) {
  return (evidence ?? []).filter((e) => e.sourceMessageId === messageId);
}

function describeRow(e) {
  return `${e.reviewStatus.padEnd(12)} ${e.polarity}/${e.magnitude}  key=${e.dedupeKey.slice(0, 12)}  "${e.excerpt.slice(0, 72)}"`;
}

/**
 * The parts of a derived signal that must not move.
 *
 * Compared as a block so a change in any component is caught rather than only
 * the headline number — but `updatedAt` is excluded deliberately: it is stamped
 * when the signal is recomputed, so including it would report a difference on
 * every single run and prove nothing.
 */
function signalOf(player) {
  const s = player?.signal ?? {};
  return JSON.stringify({
    raw: s.raw,
    last7: s.last7,
    last30: s.last30,
    seasonToDate: s.seasonToDate,
    categoryBreakdown: s.categoryBreakdown,
    pendingCount: s.pendingCount,
    mixedCount: s.mixedCount,
    lastEvidenceAt: s.lastEvidenceAt,
  });
}

/** The headline tally, for the log. */
function tallyLine(player) {
  const r = player?.signal?.raw ?? {};
  return `net ${r.net} (+${r.positive}/-${r.negative}) across ${r.items} item(s)`;
}

async function main() {
  if (!MESSAGE_ID) throw new Error('MESSAGE_ID is required');
  console.log(`Site      : ${URL_BASE}`);
  console.log(`Newsletter: ${MESSAGE_ID}`);
  console.log(DRY_RUN ? 'Mode      : DRY RUN — guard only, nothing is applied\n' : 'Mode      : apply\n');

  await login();

  // ---------------------------------------------------------------- guard ---
  console.log('=== PRE-APPLY GUARD =======================================');
  const { status: pStatus, body: preview } = await api(
    `/api/newsletter/messages/${encodeURIComponent(MESSAGE_ID)}/preview`,
  );
  if (pStatus !== 200) throw new Error(`preview failed (${pStatus}): ${JSON.stringify(preview)}`);

  console.log(`  detail: ${preview.detail}`);
  const retire = preview.wouldRetire ?? [];
  const repairs = preview.repairs ?? [];
  console.log(`  repairs: ${repairs.join(', ') || '(none)'}`);

  check(repairs.length > 0, 'the stored body needs a decoding repair', repairs.join(', '));
  check(preview.wouldAdd === 1, 'exactly one row would be added', `wouldAdd=${preview.wouldAdd}`);
  check(retire.length === 1, 'exactly one row would be retired', `wouldRetire=${retire.length}`);
  check(
    (preview.protectedByUser ?? []).length === 0,
    'no user-ruled row is involved',
    `protectedByUser=${(preview.protectedByUser ?? []).length}`,
  );
  check(preview.playersAffected === 1, 'exactly one player is affected', `playersAffected=${preview.playersAffected}`);

  const playerId = retire[0]?.playerId ?? preview.tallyDelta?.[0]?.playerId;
  check(!!playerId, 'the affected player is identifiable', playerId ?? 'none');
  const addDelta = preview.tallyDelta?.find((d) => d.playerId === playerId)?.net ?? 0;
  const retiredContribution =
    retire[0]?.storedPolarity === 'positive'
      ? retire[0].storedMagnitude
      : retire[0]?.storedPolarity === 'negative'
        ? -retire[0].storedMagnitude
        : 0;
  check(
    addDelta === retiredContribution,
    'the added row carries exactly what the retired one did',
    `added ${addDelta >= 0 ? '+' : ''}${addDelta}, retiring ${retiredContribution >= 0 ? '+' : ''}${retiredContribution} → net ${addDelta - retiredContribution}`,
  );

  if (problems.length) {
    console.log('\n::error::the preview no longer has the reviewed shape — NOTHING WAS APPLIED');
    for (const p of problems) console.log(`  - ${p}`);
    process.exit(1);
  }

  // ------------------------------------------------------------- snapshot ---
  console.log('\n=== BEFORE ================================================');
  const before = (await api(`/api/players/${encodeURIComponent(playerId)}`)).body;
  const beforeRows = rowsFromMessage(before.evidence, MESSAGE_ID);
  const beforeLive = beforeRows.filter((e) => LIVE.has(e.reviewStatus));
  const beforeSignal = signalOf(before);
  const beforeUserRuled = (before.evidence ?? []).filter((e) => e.userOverride);

  console.log(`  player ${playerId}: ${before.player?.name ?? '(unknown)'}`);
  console.log(`  tally  : ${tallyLine(before)}`);
  for (const e of beforeRows) console.log(`    ${describeRow(e)}`);

  // Everything that must NOT move.
  const otherMessages = ((await api('/api/newsletter/messages')).body.messages ?? []).filter(
    (m) => m.messageId !== MESSAGE_ID,
  );
  const otherBefore = new Map();
  for (const m of otherMessages) {
    if (!m.bodyRetained) continue;
    const p = (await api(`/api/newsletter/messages/${encodeURIComponent(m.messageId)}/preview`)).body;
    otherBefore.set(m.messageId, `${p.wouldAdd}/${(p.wouldRetire ?? []).length}/${p.alreadyStored}`);
  }
  const reviewBefore = (await api('/api/review/queue')).body;
  const pendingBefore = (reviewBefore.evidence ?? []).length;
  const identityBefore = (reviewBefore.identity ?? []).length;
  console.log(`  review queue: ${pendingBefore} pending item(s), ${identityBefore} identity question(s)`);
  console.log(`  other newsletters watched: ${otherBefore.size}`);

  if (DRY_RUN) {
    console.log('\nDRY RUN — the guard passed and nothing was applied.');
    return;
  }

  // ---------------------------------------------------------------- apply ---
  console.log('\n=== APPLY =================================================');
  const { status: aStatus, body: applied } = await api(
    `/api/newsletter/messages/${encodeURIComponent(MESSAGE_ID)}/reprocess`,
    { method: 'POST' },
  );
  if (aStatus !== 200) throw new Error(`reprocess failed (${aStatus}): ${JSON.stringify(applied)}`);
  console.log(`  ${applied.detail}`);
  console.log(`  inserted: ${applied.evidenceInserted}, players touched: ${applied.playersTouched}`);

  // --------------------------------------------------------------- verify ---
  console.log('\n=== AFTER =================================================');
  const after = (await api(`/api/players/${encodeURIComponent(playerId)}`)).body;
  const afterRows = rowsFromMessage(after.evidence, MESSAGE_ID);
  const afterLive = afterRows.filter((e) => LIVE.has(e.reviewStatus));
  console.log(`  tally  : ${tallyLine(after)}`);
  for (const e of afterRows) console.log(`    ${describeRow(e)}`);

  console.log('\n=== VERIFICATION ==========================================');

  // Evidence state.
  const retiredKey = beforeLive[0]?.dedupeKey;
  const retiredNow = afterRows.find((e) => e.dedupeKey === retiredKey);
  check(!!retiredNow, 'the malformed row still exists in the ledger (retired, not deleted)');
  check(
    retiredNow?.reviewStatus === 'ignored',
    'the malformed row is retired',
    `status=${retiredNow?.reviewStatus}`,
  );

  const replacement = afterLive.filter((e) => e.dedupeKey !== retiredKey);
  check(afterLive.length === 1, 'exactly one row from this newsletter is live', `live=${afterLive.length}`);
  check(replacement.length === 1, 'that live row is the clean replacement', `new=${replacement.length}`);
  check(
    afterRows.length === beforeRows.length + 1,
    'exactly one row was added',
    `${beforeRows.length} → ${afterRows.length}`,
  );

  const clean = replacement[0];
  if (clean) {
    console.log(`\n  replacement excerpt: "${clean.excerpt}"`);
    for (const [pattern, label] of DIRT) {
      check(!pattern.test(clean.excerpt), `replacement excerpt carries no ${label}`);
    }
    check(clean.playerId === playerId, 'replacement resolves to the same player', `${clean.playerId} vs ${playerId}`);
    check(
      clean.polarity === beforeLive[0]?.polarity && clean.magnitude === beforeLive[0]?.magnitude,
      'replacement carries the same verdict as the row it replaces',
      `${clean.polarity}/${clean.magnitude} vs ${beforeLive[0]?.polarity}/${beforeLive[0]?.magnitude}`,
    );
  }

  // Duplicates.
  const keys = afterLive.map((e) => e.dedupeKey);
  check(new Set(keys).size === keys.length, 'no duplicate dedupe key among live rows');
  const excerpts = afterLive.map((e) => e.excerpt.replace(/\s+/g, ' ').trim().toLowerCase());
  check(new Set(excerpts).size === excerpts.length, 'no two live rows say the same thing');

  // Tally.
  check(signalOf(after) === beforeSignal, 'the derived tally is unchanged', `${tallyLine(before)} → ${tallyLine(after)}`);

  // User decisions.
  const afterUserRuled = (after.evidence ?? []).filter((e) => e.userOverride);
  check(
    JSON.stringify(afterUserRuled) === JSON.stringify(beforeUserRuled),
    'no user-ruled evidence was modified',
    `${beforeUserRuled.length} before, ${afterUserRuled.length} after`,
  );

  // Review state.
  const reviewAfter = (await api('/api/review/queue')).body;
  check(
    (reviewAfter.evidence ?? []).length === pendingBefore,
    'the review queue gained nothing',
    `${pendingBefore} → ${(reviewAfter.evidence ?? []).length}`,
  );
  check(
    (reviewAfter.identity ?? []).length === identityBefore,
    'no identity question was invented',
    `${identityBefore} → ${(reviewAfter.identity ?? []).length}`,
  );

  // Nothing else moved.
  for (const [id, shape] of otherBefore) {
    const p = (await api(`/api/newsletter/messages/${encodeURIComponent(id)}/preview`)).body;
    const now = `${p.wouldAdd}/${(p.wouldRetire ?? []).length}/${p.alreadyStored}`;
    check(now === shape, `unrelated newsletter unchanged (${id.slice(0, 32)})`, `${shape} → ${now}`);
  }

  // Idempotence: running it again must be a no-op.
  const again = (await api(`/api/newsletter/messages/${encodeURIComponent(MESSAGE_ID)}/preview`)).body;
  check(again.wouldAdd === 0, 're-reading it again would add nothing', `wouldAdd=${again.wouldAdd}`);
  check(
    (again.wouldRetire ?? []).length === 0,
    're-reading it again would retire nothing',
    `wouldRetire=${(again.wouldRetire ?? []).length}`,
  );

  // The repaired parse, as the diagnostics now compute it.
  const cov = again.coverage ?? {};
  console.log('\n  --- coverage the repaired parse reports ---');
  console.log(`  sentences ${cov.sentences}, with players ${cov.sentencesWithPlayers}, ` +
    `signals ${cov.classifiedSentences}, no rule ${cov.unclassifiedSentences}, ambiguous ${cov.ambiguousIdentitySentences}`);
  const artefacts = (cov.unknownNames ?? []).filter((n) => !/^[A-Za-z'’.\- ]+$/.test(n));
  check(artefacts.length === 0, 'no parser artefact is offered as a missing player name', artefacts.join(', '));

  console.log('\n=== RESULT ================================================');
  if (problems.length) {
    console.log('::error::the repair applied but verification found problems; no further changes were made');
    for (const p of problems) console.log(`  - ${p}`);
    process.exit(1);
  }
  console.log('Repair applied and verified. One malformed row retired, one clean row live, tally unchanged.');
}

main().catch((err) => {
  console.log(`::error::${err.message}`);
  process.exit(1);
});
