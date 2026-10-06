/**
 * What makes a trade-check answer look wrong, as checks a probe can run.
 *
 * Pure functions over the JSON the endpoint returns, so they can be exercised
 * against real violations in `tests/probe.tradeValueReview.test.ts`. A gate that
 * has never been seen failing is a gate nobody knows the shape of.
 *
 * These look for absurd answers. They do not, and cannot, say whether the model
 * predicts anything.
 */

/** The smallest close-call band the model may use, in points. */
export const BAND_FLOOR = 4;

/** More points than this from one trade, over a season, is not a fantasy number. */
export const ABSURD_NET = 600;

/** A single player over replacement for a season beyond this is not credible. */
export const ABSURD_PLAYER = 450;

const BANNED = /\b(propos(e|es|ed|al)|offer(s|ed)?|accept(s|ed)?|decline(s|d)?|submit(s|ted)?|send(s|ing)?|sent|add(s|ed|ing)|drop(s|ped|ping)?|claim(s|ed|ing)?|bid(s|ding)?)\b/i;

function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) strings(v, out);
  return out;
}

/** Every problem with one answer, each a sentence naming the trade it came from. */
export function reviewCheck(label, body) {
  const findings = [];
  const say = (text) => findings.push(`${label}: ${text}`);

  if (!body || body.found !== true || !body.evaluation) {
    say('no evaluation came back');
    return findings;
  }
  const ev = body.evaluation;

  for (const text of strings(body)) {
    if (BANNED.test(text)) say(`wording implies the app acts on a trade: "${text.slice(0, 80)}"`);
  }

  if (ev.status === 'insufficient') {
    if (!ev.insufficientReason) say('refused a verdict and gave no reason');
    if (ev.verdict != null) say('refused a verdict and still carried one');
    return findings;
  }
  if (ev.status !== 'ok') {
    say(`unknown status ${ev.status}`);
    return findings;
  }

  const sides = [ev.a, ev.b];
  for (const side of sides) {
    if (!side) {
      say('a side is missing');
      continue;
    }
    for (const key of ['lineupChange', 'depthChange', 'adjustmentTotal', 'net']) {
      if (!Number.isFinite(side[key])) say(`${side.label} ${key} is not a number`);
    }
    if (Math.abs(side.net) > ABSURD_NET) say(`${side.label} net ${side.net} is not a credible season total`);
    if (Math.abs(side.net - (side.lineupChange + side.depthChange + side.adjustmentTotal)) > 0.31) {
      say(`${side.label} net does not add up from its parts`);
    }
    if (!side.isMine && side.adjustments.length > 0) say(`${side.label} carries preferences and is not Alex`);
    for (const p of [...side.incoming, ...side.outgoing]) {
      if (p.rosValue != null && (p.rosValue < 0 || p.rosValue > ABSURD_PLAYER)) {
        say(`${p.name} is worth ${p.rosValue} over replacement, which is not credible`);
      }
      if (p.games > ev.weeks.count + 1e-9) say(`${p.name} plays more games than there are weeks`);
      if (p.startsWeeks > ev.weeks.count) say(`${p.name} starts more weeks than there are`);
      if (p.rate != null && (p.rate < 0 || p.rate > 45)) say(`${p.name} rate ${p.rate} a game is not credible`);
    }
  }
  if (!ev.a || !ev.b) return findings;

  const v = ev.verdict;
  if (!v) {
    say('status ok with no verdict');
    return findings;
  }
  if (v.band < BAND_FLOOR - 1e-9) say(`close-call band ${v.band} is under its floor`);
  const gap = Math.round((ev.a.net - ev.b.net) * 10) / 10;
  if (Math.abs(gap - v.gap) > 0.11) say(`verdict gap ${v.gap} is not the difference of the nets (${gap})`);
  const inside = Math.abs(v.gap) <= v.band + 1e-9;
  if (inside && v.kind !== 'close') say(`a gap of ${v.gap} is inside the ±${v.band} band and was not called a close call`);
  if (!inside && v.kind === 'close') say(`a gap of ${v.gap} is outside the ±${v.band} band and was called a close call`);
  if (!inside && !v.kind.endsWith(v.gap > 0 ? '_a' : '_b')) say(`verdict ${v.kind} points the wrong way for a gap of ${v.gap}`);
  if (!v.headline || v.headline.length < 8) say('no readable headline');
  if (!['high', 'medium', 'low'].includes(ev.confidence)) say(`unknown confidence ${ev.confidence}`);
  return findings;
}

/**
 * The same trade asked from the other team's chair must say the same thing.
 *
 * Preferences belong to Alex's roster and not to a position in the request, so
 * swapping which team is A leaves each team's net where it was.
 */
export function reviewAntisymmetry(label, forward, reverse) {
  const f = forward?.evaluation;
  const r = reverse?.evaluation;
  if (!f || !r) return [`${label}: one direction returned nothing`];
  if (f.status !== r.status) return [`${label}: the two directions disagree on whether a verdict exists`];
  if (f.status !== 'ok') return [];
  const findings = [];
  if (Math.abs(f.a.net - r.b.net) > 0.11) findings.push(`${label}: ${f.a.label} is ${f.a.net} one way and ${r.b.net} the other`);
  if (Math.abs(f.b.net - r.a.net) > 0.11) findings.push(`${label}: ${f.b.label} is ${f.b.net} one way and ${r.a.net} the other`);
  if (Math.abs(f.verdict.gap + r.verdict.gap) > 0.21) findings.push(`${label}: the gap is ${f.verdict.gap} one way and ${r.verdict.gap} the other, not its negative`);
  return findings;
}

/** Checks on a replay of past trades. */
export function reviewReplay(body) {
  const findings = [];
  if (!body || !Array.isArray(body.replays)) return ['replay: no replays came back'];
  for (const replay of body.replays) {
    const label = `replay ${replay.season} week ${replay.week} (${replay.rosters.map((r) => r.label).join(' / ')})`;
    if (replay.mode === 'roster_aware') {
      findings.push(...reviewCheck(label, { found: true, evaluation: replay.evaluation, notes: replay.notes }));
    } else {
      for (const bundle of replay.bundles ?? []) {
        if (bundle.total != null && (bundle.total < 0 || bundle.total > ABSURD_NET)) {
          findings.push(`${label}: a bundle totals ${bundle.total}, which is not credible`);
        }
      }
    }
  }
  return findings;
}
