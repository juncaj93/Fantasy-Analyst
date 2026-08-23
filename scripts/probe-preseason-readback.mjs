/**
 * The imported preseason projection, read back out of production.
 *
 * Read-only. Public endpoints only — no passphrase, no writes, nothing stored.
 *
 * This exists because the import happened through the UI, which is the right
 * way for it to happen and also the way that leaves no transcript. What is
 * asserted here is the state that import produced: the snapshot is scoped to
 * the league's own scoring, the board carries the number, exactly one
 * market-derived opinion reaches the ranking per player, and the contribution
 * stays inside the weight it rides on.
 *
 * Where production cannot answer a question, this says so rather than
 * inventing a pass. Two of them it genuinely cannot: precedence over raw
 * season lines needs raw season lines to exist, and the incompatible-profile
 * case needs a second league under different scoring.
 */

const BASE = process.env.APP_URL ?? 'https://fantasy-analyst.juncaj93.workers.dev';
const WEIGHT = 0.2;

let failures = 0;

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep the text */
  }
  return { status: res.status, json, text };
}

function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

function note(line) {
  console.log(`      ${line}`);
}

console.log(`Reading back ${BASE}\n`);

// 1. The snapshot, as Setup reports it.
const status = await get('/api/preseason-projection');
check('/api/preseason-projection responds', status.status === 200, `HTTP ${status.status}`);

const current = status.json?.current ?? null;
check('a snapshot is loaded for this league’s own scoring', current != null, current?.label ?? 'none');
if (current) {
  note(`${current.rows} rows, ${current.players} players, ${current.unresolved} unresolved`);
  note(`captured ${current.capturedAt}, imported ${current.importedAt}, under ${current.scoringLabel}`);
  check(
    'every row it stored resolved to a player',
    current.unresolved === 0,
    `${current.unresolved} unresolved`,
  );
  check(
    'it is scoped to the scoring the league actually uses',
    current.scoringKey === status.json?.scoringKey,
    `${current.scoringLabel} vs league ${status.json?.scoringLabel}`,
  );
}
/*
 * A snapshot captured under other rules is kept rather than discarded, and is
 * inert rather than nearly-right. Nothing here requires one to exist; what is
 * reported is whether any does, because an invisible inert snapshot is
 * indistinguishable from an import that failed.
 */
note(`${(status.json?.others ?? []).length} other capture(s) on file, under other scoring and unused`);

// 2. The board.
const setup = await get('/api/setup/status');
const draftId = setup.json?.league?.draftId ?? null;
const board = draftId ? await get(`/api/drafts/${encodeURIComponent(draftId)}/board?limit=200`) : { json: null };
check('the draft board builds', board.status === 200, `HTTP ${board.status ?? 'n/a'}`);

if (board.json) {
  const recs = board.json.recommendations ?? [];
  const withPoints = recs.filter((r) => r.preseasonPoints != null);
  check(
    'the board carries the projection on the players it covers',
    withPoints.length > 0,
    `${withPoints.length} of ${recs.length} rows`,
  );
  /*
   * Missing is not zero. A player the snapshot omits must carry null, because
   * zero on this scale is a real claim — that he is projected to score nothing.
   */
  check(
    'a player the snapshot omits carries nothing, not zero',
    recs.every((r) => r.preseasonPoints == null || r.preseasonPoints > 0),
    `${recs.length - withPoints.length} row(s) carry no projection`,
  );

  const market = (r) => (r.components ?? []).filter((c) => c.key === 'market_expectation');
  check(
    'exactly one market-derived opinion reaches the ranking, per player',
    recs.every((r) => market(r).length === 1),
    `across ${recs.length} rows`,
  );
  check(
    'and no second component appeared for the projection',
    recs.every((r) => !(r.components ?? []).some((c) => /preseason|projection/i.test(c.key))),
    'no preseason component on any row',
  );

  const contributions = recs.flatMap((r) => market(r).map((c) => c.contribution));
  const worst = Math.max(...contributions.map((c) => Math.abs(c)));
  check(
    'the contribution stays inside the weight it rides on',
    worst <= WEIGHT + 1e-9,
    `largest |contribution| ${worst.toFixed(3)} against a ceiling of ${WEIGHT}`,
  );

  /*
   * Bounded, not inert. A component that never moves anybody is not a signal,
   * so the other half is worth reporting: it must actually vary.
   */
  const distinct = new Set(contributions.map((c) => c.toFixed(3)));
  check(
    'and it distinguishes players rather than reading the same for everybody',
    distinct.size > 3,
    `${distinct.size} distinct contributions`,
  );

  const fromProjection = recs.filter((r) => market(r).some((c) => /preseason/i.test(c.display ?? '')));
  const fromRawLines = recs.filter((r) => market(r).some((c) => /pts implied/i.test(c.display ?? '')));
  note(`${fromProjection.length} row(s) scored from the projection, ${fromRawLines.length} from raw season lines`);
  if (fromRawLines.length === 0) {
    note('no raw season lines are stored, so precedence cannot be observed here — it is proven in the suite');
  } else {
    check(
      'a player with raw lines is scored from them, never from the projection',
      fromRawLines.every((r) => !market(r).some((c) => /preseason/i.test(c.display ?? ''))),
      `${fromRawLines.length} row(s) with raw lines`,
    );
  }

  // Sorting by PTS is the client's job; what the server owes it is coverage.
  check(
    'there is enough coverage for the PTS sort to order by',
    withPoints.length >= 2,
    `${withPoints.length} rows carry a projection`,
  );

  // 3. The clamp distribution, on the real board.
  const byPos = {};
  for (const r of recs) {
    if (r.preseasonPoints == null) continue;
    (byPos[r.position] ??= []).push(r);
  }
  console.log('\n--- standing, per position (contribution / weight) ---');
  for (const [pos, list] of Object.entries(byPos).sort()) {
    const standings = list
      .map((r) => market(r)[0]?.contribution)
      .filter((c) => c != null)
      .map((c) => c / WEIGHT);
    const hi = standings.filter((s) => s >= 1 - 1e-9).length;
    const lo = standings.filter((s) => s <= -1 + 1e-9).length;
    console.log(`      ${pos}: n=${list.length}  at +1: ${hi}  at -1: ${lo}`);
  }
  console.log('');

  // 4. The shared player sheet, which Players, Trades and the cards all render.
  const covered = withPoints[0];
  if (covered) {
    const detail = await get(`/api/players/${covered.playerId}/detail`);
    check(`the player sheet answers for ${covered.name}`, detail.status === 200, `HTTP ${detail.status}`);
    const proj = detail.json?.preseasonProjection ?? null;
    check('and carries the preseason projection as context', proj != null, proj ? `${proj.points} pts` : 'absent');
    if (proj) {
      /*
       * Context, not a current expectation. After week one the number is
       * history, and a bare figure would read as a live forecast — so it is
       * shown with the capture date and the scoring it was taken under.
       */
      check('it is dated, so it cannot read as a current expectation', Boolean(proj.capturedAt), proj.capturedAt ?? '');
      check('and says which rules produced it', Boolean(proj.scoringLabel), proj.scoringLabel ?? '');
      check('and cites its source', Boolean(proj.label), proj.label ?? '');
      check(
        'the sheet and the board report the same number',
        proj.points === covered.preseasonPoints,
        `sheet ${proj.points} vs board ${covered.preseasonPoints}`,
      );
    }
  }
}

// 5. The surfaces that must not have moved.
const leagueId = setup.json?.league?.id ?? setup.json?.selectedLeague?.id ?? null;
if (leagueId) {
  const trades = await get(`/api/leagues/${encodeURIComponent(leagueId)}/trade-fit`);
  check('trade fit still answers', trades.status === 200, `HTTP ${trades.status}`);
  /*
   * The projection is context on the shared sheet and nothing else. If it had
   * leaked into the trade formulas it would show up as a field on the offers
   * themselves, which is what this looks for.
   */
  const offers = trades.json?.offers ?? trades.json?.trades ?? [];
  check(
    'and no trade carries a projection as a term of the deal',
    JSON.stringify(offers).match(/preseasonP/i) == null,
    `${Array.isArray(offers) ? offers.length : 0} offer(s) inspected`,
  );
}

const players = await get('/api/players?limit=50');
check('the players list still answers', players.status === 200, `HTTP ${players.status}`);
/*
 * Players ranking was explicitly out of scope. The projection must not appear
 * as a ranking input there — on that screen it is history shown on the sheet,
 * reached by tapping a player, not a number that reorders the list.
 */
const list = players.json?.players ?? players.json ?? [];
check(
  'and the projection is not a field on the players ranking',
  JSON.stringify(Array.isArray(list) ? list.slice(0, 50) : list).match(/preseason/i) == null,
  'no preseason field on the list rows',
);

console.log('');
if (failures > 0) {
  console.log(`${failures} check(s) failed.`);
  process.exit(1);
}
console.log('All checks passed.');
