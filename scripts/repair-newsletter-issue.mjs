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

/**
 * What the operator reviewed and expects to happen. The guard refuses anything
 * else, so a preview that has drifted since it was read cannot be applied by
 * a run that was queued against the older shape.
 *
 * Both cases are real. A decoding repair replaces a garbage row with a clean
 * one (1 and 1). A rule correction that withdraws a false positive retires a
 * row and puts nothing back (0 and 1) — the tally moves, and it is supposed to.
 */
const EXPECT_ADD = Number(process.env.EXPECT_ADD ?? '1');
const EXPECT_RETIRE = Number(process.env.EXPECT_RETIRE ?? '1');

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
  check(
    preview.wouldAdd === EXPECT_ADD,
    `exactly ${EXPECT_ADD} row(s) would be added`,
    `wouldAdd=${preview.wouldAdd}`,
  );
  check(
    retire.length === EXPECT_RETIRE,
    `exactly ${EXPECT_RETIRE} row(s) would be retired`,
    `wouldRetire=${retire.length}`,
  );
  check(
    (preview.protectedByUser ?? []).length === 0,
    'no user-ruled row is involved',
    `protectedByUser=${(preview.protectedByUser ?? []).length}`,
  );

  // Everyone this touches: whoever loses a row, plus whoever gains one.
  const affected = [
    ...new Set([...retire.map((r) => r.playerId), ...(preview.tallyDelta ?? []).map((d) => d.playerId)]),
  ].filter(Boolean);
  check(affected.length >= 1, 'the affected player(s) are identifiable', affected.join(', ') || 'none');

  /**
   * What the tally is supposed to do, per player — computed rather than
   * assumed. A replacement nets to zero; a withdrawal nets to minus whatever
   * the retired row was contributing. Asserting the computed number is
   * stronger than asserting "unchanged", because it also catches a replacement
   * that quietly changed its own verdict.
   */
  const signedOf = (polarity, magnitude) =>
    polarity === 'positive' ? magnitude : polarity === 'negative' ? -magnitude : 0;
  const expectedDelta = new Map();
  for (const id of affected) {
    const gained = (preview.tallyDelta ?? []).find((d) => d.playerId === id)?.net ?? 0;
    const lost = retire
      .filter((r) => r.playerId === id)
      .reduce((sum, r) => sum + signedOf(r.storedPolarity, r.storedMagnitude), 0);
    expectedDelta.set(id, gained - lost);
    console.log(
      `  tally expectation ${id}: gaining ${gained >= 0 ? '+' : ''}${gained}, ` +
        `losing ${lost >= 0 ? '+' : ''}${lost} → net ${gained - lost >= 0 ? '+' : ''}${gained - lost}`,
    );
  }

  if (problems.length) {
    console.log('\n::error::the preview no longer has the reviewed shape — NOTHING WAS APPLIED');
    for (const p of problems) console.log(`  - ${p}`);
    process.exit(1);
  }

  // ------------------------------------------------------------- snapshot ---
  console.log('\n=== BEFORE ================================================');
  const before = new Map();
  for (const id of affected) {
    const body = (await api(`/api/players/${encodeURIComponent(id)}`)).body;
    before.set(id, body);
    console.log(`  player ${id}: ${body.player?.name ?? '(unknown)'}`);
    console.log(`    tally: ${tallyLine(body)}`);
    for (const e of rowsFromMessage(body.evidence, MESSAGE_ID)) console.log(`      ${describeRow(e)}`);
  }

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
  const after = new Map();
  for (const id of affected) {
    const body = (await api(`/api/players/${encodeURIComponent(id)}`)).body;
    after.set(id, body);
    console.log(`  player ${id}: ${tallyLine(body)}`);
    for (const e of rowsFromMessage(body.evidence, MESSAGE_ID)) console.log(`    ${describeRow(e)}`);
  }

  console.log('\n=== VERIFICATION ==========================================');

  let totalAdded = 0;
  let totalRetired = 0;

  for (const id of affected) {
    const beforeRows = rowsFromMessage(before.get(id).evidence, MESSAGE_ID);
    const afterRows = rowsFromMessage(after.get(id).evidence, MESSAGE_ID);
    const beforeLive = beforeRows.filter((e) => LIVE.has(e.reviewStatus));
    const afterLive = afterRows.filter((e) => LIVE.has(e.reviewStatus));
    const beforeKeys = new Set(beforeRows.map((e) => e.dedupeKey));

    // Every row the preview said would go is retired, and still in the ledger.
    for (const r of retire.filter((r) => r.playerId === id)) {
      const gone = afterRows.find((e) => e.excerpt === r.excerpt);
      check(!!gone, `the superseded row is still in the ledger, not deleted (${id})`);
      check(gone?.reviewStatus === 'ignored', `the superseded row is retired (${id})`, `status=${gone?.reviewStatus}`);
      if (gone && LIVE.has(gone.reviewStatus) === false) totalRetired++;
    }

    // Whatever is live now that was not before is what the repair added.
    const added = afterLive.filter((e) => !beforeKeys.has(e.dedupeKey));
    totalAdded += added.length;
    check(
      afterLive.length === beforeLive.length - retire.filter((r) => r.playerId === id).length + added.length,
      `the live row count moves by exactly what was promised (${id})`,
      `${beforeLive.length} → ${afterLive.length}`,
    );

    for (const clean of added) {
      console.log(`\n  added excerpt: "${clean.excerpt}"`);
      for (const [pattern, label] of DIRT) {
        check(!pattern.test(clean.excerpt), `added excerpt carries no ${label}`);
      }
      check(clean.playerId === id, 'added row resolves to the affected player', `${clean.playerId} vs ${id}`);
    }

    // A one-for-one replacement must not quietly change its own verdict.
    if (EXPECT_ADD === 1 && EXPECT_RETIRE === 1 && added.length === 1 && beforeLive.length === 1) {
      check(
        added[0].polarity === beforeLive[0].polarity && added[0].magnitude === beforeLive[0].magnitude,
        'replacement carries the same verdict as the row it replaces',
        `${added[0].polarity}/${added[0].magnitude} vs ${beforeLive[0].polarity}/${beforeLive[0].magnitude}`,
      );
    }

    // Duplicates.
    const keys = afterLive.map((e) => e.dedupeKey);
    check(new Set(keys).size === keys.length, `no duplicate dedupe key among live rows (${id})`);
    const excerpts = afterLive.map((e) => e.excerpt.replace(/\s+/g, ' ').trim().toLowerCase());
    check(new Set(excerpts).size === excerpts.length, `no two live rows say the same thing (${id})`);

    // The tally moved by exactly the computed amount, and by nothing else.
    const beforeNet = before.get(id)?.signal?.raw?.net ?? 0;
    const afterNet = after.get(id)?.signal?.raw?.net ?? 0;
    const want = expectedDelta.get(id) ?? 0;
    check(
      afterNet - beforeNet === want,
      `the derived tally moved by exactly what was promised (${id})`,
      `${beforeNet} → ${afterNet} (expected ${want >= 0 ? '+' : ''}${want})`,
    );
    if (want === 0) {
      check(
        signalOf(after.get(id)) === signalOf(before.get(id)),
        `no component of the derived signal moved (${id})`,
      );
    }

    // User decisions.
    const beforeUserRuled = (before.get(id).evidence ?? []).filter((e) => e.userOverride);
    const afterUserRuled = (after.get(id).evidence ?? []).filter((e) => e.userOverride);
    check(
      JSON.stringify(afterUserRuled) === JSON.stringify(beforeUserRuled),
      `no user-ruled evidence was modified (${id})`,
      `${beforeUserRuled.length} before, ${afterUserRuled.length} after`,
    );
  }

  check(totalAdded === EXPECT_ADD, `exactly ${EXPECT_ADD} row(s) were added`, `added=${totalAdded}`);
  check(totalRetired === EXPECT_RETIRE, `exactly ${EXPECT_RETIRE} row(s) were retired`, `retired=${totalRetired}`);

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
  const moved = [...expectedDelta.entries()]
    .map(([id, net]) => `${id} ${net >= 0 ? '+' : ''}${net}`)
    .join(', ');
  console.log(
    `Applied and verified. ${totalRetired} row(s) retired, ${totalAdded} added. Tally movement: ${moved || 'none'}.`,
  );
}

main().catch((err) => {
  console.log(`::error::${err.message}`);
  process.exit(1);
});
