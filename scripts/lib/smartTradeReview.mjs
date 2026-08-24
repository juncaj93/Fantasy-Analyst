/**
 * What must be true of a Smart Bilateral Trades board, as pure predicates.
 *
 * Extracted from `probe-smart-trades.mjs` for the reason `boardInvariants.mjs`
 * was extracted from the smoke probe: a gate nobody has ever seen fail is a gate
 * nobody knows the shape of. Every check here is exercised twice in
 * `tests/probe.smartTradeReview.test.ts` — once on a board that satisfies it and
 * once on a board that breaks it in the specific way the product would break it.
 *
 * The list is §24's, one function per failure it names:
 *
 *   - stars for piles of junk;
 *   - opponent-harming offers;
 *   - bench-for-bench noise;
 *   - repeated near-duplicates;
 *   - manager history overpowering value;
 *   - new managers treated as inactive;
 *   - illegal packages.
 *
 * Nothing here fetches anything. The probe supplies the board and prints the
 * results; this decides only what "wrong" means.
 */

/** The documented cap on what a manager's history may contribute. */
export const MANAGER_FIT_CAP = 0.08;

/** The objective gap past which an offer is outside the recommendation range. */
export const MAX_FAIR_GAP = 0.25;

/** Lineup points of loss to the partner past which the offer harms them. */
export const MATERIAL_HARM = 0.75;

function names(players) {
  return (players ?? []).map((p) => p?.name ?? '?').join(' + ');
}

function label(offer) {
  return `${names(offer?.give)} → ${names(offer?.get)}`;
}

/**
 * Every §24 finding against one board.
 *
 * Returns a list of complaints; empty is the good case. Deliberately a list of
 * strings rather than a boolean: "the board is fine" and "the board is fine
 * except that Dermot is described as inactive on two unread seasons" are
 * different reports, and only one of them is actionable.
 */
export function reviewFindings(board) {
  const offers = board?.offers ?? [];
  const findings = [];

  for (const offer of offers) {
    findings.push(...offerFindings(offer));
  }
  findings.push(...duplicateFindings(offers));
  return findings;
}

/** The checks that look at one offer in isolation. */
export function offerFindings(offer) {
  const out = [];
  const where = label(offer);

  // --- stars for piles of junk ---------------------------------------------
  if (offer?.fairness?.band === 'outside_range') {
    out.push(`value gap outside the recommendation range reached a screen: ${where}`);
  }
  const gap = Math.abs(offer?.fairness?.gap ?? 0);
  if (gap > MAX_FAIR_GAP) out.push(`objective gap of ${Math.round(gap * 100)}% surfaced: ${where}`);

  // --- offers that harm the opponent ---------------------------------------
  const theirGain = offer?.counterparty?.starterGain ?? 0;
  if (theirGain < -MATERIAL_HARM) {
    out.push(`opponent loses ${Math.abs(theirGain).toFixed(1)} pts: ${where}`);
  }

  /*
   * A deal that is even on value and does nothing for them.
   *
   * §13's central requirement, checked on the output rather than trusted from
   * the engine: no lineup gain *and* no roster-shaped reason is a deal nobody
   * would act on, and surfacing it is how an assistant becomes a calculator.
   */
  if (theirGain <= 0 && (offer?.counterparty?.rationales ?? []).length === 0) {
    out.push(`no counterparty logic and no counterparty gain: ${where}`);
  }

  // --- bench-for-bench noise -----------------------------------------------
  if ((offer?.user?.entersLineup ?? []).length === 0 && (offer?.counterparty?.entersLineup ?? []).length === 0) {
    out.push(`nothing enters either lineup: ${where}`);
  }

  // --- unknown treated as inactive -----------------------------------------
  const fit = offer?.managerFit ?? {};
  const evidence = fit.evidence ?? {};
  if (fit.activity === 'effectively_inactive' && !evidence.historyComplete) {
    out.push(`manager called inactive on incomplete history: ${fit.displayName ?? offer?.partner?.displayName}`);
  }
  if (fit.activity && fit.activity !== 'unknown' && (evidence.seasonsObserved ?? 0) === 0) {
    out.push(`manager classified with zero observed seasons: ${fit.displayName ?? offer?.partner?.displayName}`);
  }

  // --- history overpowering value ------------------------------------------
  if (Math.abs(fit.contribution ?? 0) > MANAGER_FIT_CAP + 1e-9) {
    out.push(`manager fit of ${fit.contribution} exceeds the documented cap: ${where}`);
  }

  // --- illegal packages ----------------------------------------------------
  if (offer?.user?.opensSlot) out.push(`offer leaves one of your slots empty: ${where}`);
  if (offer?.counterparty?.opensSlot) out.push(`offer leaves one of their slots empty: ${where}`);
  if ((offer?.give ?? []).length === 0 || (offer?.get ?? []).length === 0) {
    out.push(`one side of the package is empty: ${where}`);
  }

  /*
   * A stale roster player: somebody priced at nothing.
   *
   * A player the engine could not value should never have reached a package —
   * the generator filters him out — so a zero-valued name on a surfaced offer
   * means a roster the app is reading differently from the one it is pricing.
   */
  for (const player of [...(offer?.give ?? []), ...(offer?.get ?? [])]) {
    if (player?.value == null || !Number.isFinite(player.value)) {
      out.push(`${player?.name ?? 'a player'} has no objective value: ${where}`);
    }
  }

  return out;
}

/**
 * Repeated near-duplicates, across the whole board.
 *
 * One player in two offers is ordinary — the best available running back is
 * worth asking two managers about. Three is a board that has run out of ideas
 * and is rephrasing one, which is the failure §24 names.
 */
export function duplicateFindings(offers) {
  const seen = new Map();
  const out = [];
  for (const offer of offers ?? []) {
    for (const player of [...(offer?.give ?? []), ...(offer?.get ?? [])]) {
      if (!player?.playerId) continue;
      const count = (seen.get(player.playerId) ?? 0) + 1;
      seen.set(player.playerId, count);
      if (count === 3) out.push(`${player.name} appears in three or more surfaced offers`);
    }
  }
  return out;
}

/**
 * Whether history changed the order the objective gates would have produced.
 *
 * The question §23 ends on, answerable from the payload alone: re-rank by the
 * composite with the manager term subtracted, and compare. A difference is not a
 * fault — settling near ties is exactly what behaviour is permitted to do — but
 * it is the number that says whether the feature is doing anything, and whether
 * it is doing more than it should.
 */
export function orderingEffect(offers) {
  const list = offers ?? [];
  const withFit = list.map((o) => o.id);
  const withoutFit = [...list]
    .sort((a, b) => {
      const av = (a.breakdown?.total ?? 0) - (a.breakdown?.managerFit ?? 0);
      const bv = (b.breakdown?.total ?? 0) - (b.breakdown?.managerFit ?? 0);
      return bv - av || String(a.id).localeCompare(String(b.id));
    })
    .map((o) => o.id);

  return { moved: withFit.filter((id, i) => withoutFit[i] !== id).length, withFit, withoutFit };
}
