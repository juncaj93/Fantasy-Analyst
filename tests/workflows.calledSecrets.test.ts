/**
 * A called workflow is given no secrets unless its caller passes them.
 *
 * ## The failure this is written from
 *
 * `Daily production sweep` failed on every scheduled run from 2026-09-03 to
 * 2026-09-22 — twenty consecutive mornings — and the app's only automated
 * check against the live site did not run once in that time. Nothing was
 * broken in production and nothing was broken in the guard. `smoke-daily.yml`
 * called `smoke.yml` with `uses:` and did not pass `CLOUDFLARE_API_TOKEN`, so
 * the budget guard inside it read an empty string, could not ask Cloudflare
 * how much of the day's D1 allowance was gone, and declined:
 *
 *     Cannot determine today's D1 usage, so the run is declined:
 *     CLOUDFLARE_API_TOKEN is not set.
 *
 * Failing closed there is correct — a wrong "proceed" costs the rest of the
 * day's allowance, which this repository has learned three times. The defect
 * is that a token which *was* set never arrived.
 *
 * ## Why it was invisible
 *
 * `secrets.CLOUDFLARE_API_TOKEN` is spelled identically in a caller and in a
 * callee and means different things in each. In a workflow triggered directly
 * it resolves against the repository. In one reached through `workflow_call`
 * it resolves against what the caller handed over, which is nothing by
 * default. Both files read as correct on their own, and the deploy path —
 * which skips the guard entirely, `if: inputs.full` — went on passing the
 * whole time, so the only signal was a red tick on a job nobody was watching.
 *
 * So this is a structural check rather than a regression test for one line: it
 * reads every local `uses:` call in the repository and refuses any that leaves
 * a declared secret behind. It would have caught the original, and it catches
 * the next reusable workflow that grows a secret without its callers noticing.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readWorkflow, type YamlValue } from './helpers/workflowYaml.ts';

const WORKFLOWS = join(import.meta.dirname, '..', '.github', 'workflows');

const asMap = (value: YamlValue | undefined): Record<string, YamlValue> =>
  (value ?? {}) as Record<string, YamlValue>;

const files = readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml'));

/** The secrets a reusable workflow declares on its `workflow_call` trigger. */
function declaredSecrets(file: string): string[] {
  const { yaml } = readWorkflow(file);
  const call = asMap(asMap(yaml['on'])['workflow_call']);
  return Object.keys(asMap(call['secrets']));
}

interface Call {
  /** The workflow doing the calling. */
  caller: string;
  /** The job in it that makes the call. */
  job: string;
  /** The called workflow's filename. */
  callee: string;
  /** Secret names the call passes by name. */
  passes: string[];
  /** True when the call says `secrets: inherit`. */
  inherits: boolean;
}

/** Every `uses: ./.github/workflows/*.yml` job call in the repository. */
function localCalls(): Call[] {
  const out: Call[] = [];
  for (const caller of files) {
    const { yaml } = readWorkflow(caller);
    for (const [job, raw] of Object.entries(asMap(yaml['jobs']))) {
      const spec = asMap(raw);
      const uses = typeof spec['uses'] === 'string' ? spec['uses'] : null;
      if (!uses || !uses.startsWith('./.github/workflows/')) continue;
      const secrets = spec['secrets'];
      out.push({
        caller,
        job,
        callee: uses.slice('./.github/workflows/'.length),
        passes: typeof secrets === 'string' ? [] : Object.keys(asMap(secrets)),
        inherits: secrets === 'inherit',
      });
    }
  }
  return out;
}

/** Secrets a workflow's own jobs actually read, ignoring the always-present one. */
function referencedSecrets(file: string): string[] {
  const { text } = readWorkflow(file);
  const names = new Set<string>();
  for (const m of text.matchAll(/secrets\.([A-Z0-9_]+)/g)) {
    const name = m[1]!;
    // `GITHUB_TOKEN` is supplied by Actions itself and is never declared.
    if (name !== 'GITHUB_TOKEN') names.add(name);
  }
  return [...names];
}

/** Whether a declared secret is `required: true`. */
function requiredSecrets(file: string): string[] {
  const { yaml } = readWorkflow(file);
  const declared = asMap(asMap(asMap(yaml['on'])['workflow_call'])['secrets']);
  return Object.entries(declared)
    .filter(([, spec]) => asMap(spec)['required'] === true)
    .map(([name]) => name);
}

const reusable = files.filter((f) => {
  const { yaml } = readWorkflow(f);
  return 'workflow_call' in asMap(yaml['on']);
});

describe('a reusable workflow declares every secret it reads', () => {
  /*
   * The root cause, stated as an invariant rather than as a fix.
   *
   * `smoke.yml` read `secrets.CLOUDFLARE_API_TOKEN` in its budget job and
   * declared nothing, which meant no caller *could* have passed it — the value
   * was unreachable by construction and the guard was guaranteed to decline on
   * every `workflow_call` path for as long as that held. This is the check
   * that fails on the tree as it stood on 2026-09-22 before the fix.
   */
  it('finds the reusable workflows, so this cannot pass vacuously', () => {
    expect(reusable).toContain('smoke.yml');
    expect(reusable.length).toBeGreaterThanOrEqual(2);
  });

  it.each(reusable)('%s', (file) => {
    const { yaml } = readWorkflow(file);
    const declared = Object.keys(asMap(asMap(asMap(yaml['on'])['workflow_call'])['secrets']));

    /*
     * `inherit` is the other way a secret can legitimately arrive undeclared,
     * and `release.yml` uses it: `deploy.yml` and `rollback.yml` both hand it
     * everything, which is defensible there because a release genuinely needs
     * the deploy token, the passphrase and the odds key together. So the rule
     * is reachability rather than declaration — a secret has to be able to
     * *get* there by one route or the other. It could not by either in
     * `smoke.yml`, which is why the guard declined every morning for twenty
     * days with a token that was set the whole time.
     */
    const callers = localCalls().filter((c) => c.callee === file);
    const everyCallerInherits = callers.length > 0 && callers.every((c) => c.inherits);
    if (everyCallerInherits) return;

    const unreachable = referencedSecrets(file).filter((name) => !declared.includes(name));
    expect(
      unreachable,
      `${file} reads ${unreachable.join(', ')}, does not declare it on \`workflow_call\`, and ` +
        `is called by a job that does not inherit. It would read as empty inside the callee — ` +
        `which is how the daily sweep declined for twenty mornings with a token that was set.`,
    ).toEqual([]);
  });
});

describe('a caller hands over every secret the callee requires', () => {
  const calls = localCalls();

  it('finds the calls at all, so a silent parse failure cannot pass this file', () => {
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.map((c) => c.callee)).toContain('smoke.yml');
  });

  it.each(localCalls())('$caller job "$job" calls $callee', (call) => {
    /*
     * Only the *required* ones, because optional is a real state here and not
     * an oversight: `deploy.yml` and `rollback.yml` call `smoke.yml` without
     * the token on purpose, since the guard that needs it does not run for
     * them (`if: inputs.full`, and they pass false). Demanding it of every
     * caller would fail the deploy path for holding a credential it has no
     * use for.
     */
    if (call.inherits) return;
    const needed = requiredSecrets(call.callee);
    const missing = needed.filter((name) => !call.passes.includes(name));
    expect(
      missing,
      `${call.caller} job "${call.job}" calls ${call.callee}, which requires ${needed.join(', ')}.`,
    ).toEqual([]);
  });
});

describe('the sweep that went twenty days without running', () => {
  /*
   * The specific case, pinned by name as well as by the rule above. The
   * general check is what stops this recurring somewhere else; this one is
   * what stops somebody deleting the line while tidying and getting a green
   * suite for it.
   */
  it('passes the budget guard its token', () => {
    const { yaml } = readWorkflow('smoke-daily.yml');
    const sweep = asMap(asMap(yaml['jobs'])['sweep']);
    expect(Object.keys(asMap(sweep['secrets']))).toContain('CLOUDFLARE_API_TOKEN');
  });

  it('and smoke declares it, so the call is a contract rather than a convention', () => {
    expect(declaredSecrets('smoke.yml')).toContain('CLOUDFLARE_API_TOKEN');
  });

  it('does not reach for `inherit`, which would hand over the passphrase too', () => {
    /*
     * `secrets: inherit` would also have fixed the outage, in one word, and it
     * would have given an unattended daily job against the live site the
     * deploy credential *and* the login passphrase *and* the odds key in order
     * to count database rows. The narrower fix is the point, not an accident.
     */
    const { yaml } = readWorkflow('smoke-daily.yml');
    const sweep = asMap(asMap(yaml['jobs'])['sweep']);
    expect(sweep['secrets']).not.toBe('inherit');
  });

  it('leaves the deploy gate able to call smoke without it', () => {
    /*
     * `deploy.yml` and `rollback.yml` skip the guard entirely — it is
     * `if: inputs.full` and they pass `full: false` — so the secret has to
     * stay optional or every deploy would fail validation before a job
     * started. That is not hypothetical: granting the wrong thing to the
     * deploy path is exactly how this workflow's own header says the schedule
     * came to live here.
     */
    const { yaml } = readWorkflow('smoke.yml');
    const declared = asMap(asMap(asMap(yaml['on'])['workflow_call'])['secrets']);
    const token = asMap(declared['CLOUDFLARE_API_TOKEN']);
    expect(token['required']).toBe(false);
  });
});
