/**
 * The release path, asserted where it actually lives: in the workflow files.
 *
 * A release is orchestration, so the things that can go wrong with it are
 * structural — a trigger that fires too early, a checkout that takes a branch
 * instead of a revision, a rollback that quietly falls back to main — and none
 * of them is reachable from a unit test of the app. They are reachable from
 * here, because the files say what they do.
 *
 * The invariants, in one place:
 *
 *   A. production is only deployed after authoritative CI passed for that SHA
 *   B. the SHA CI validated is the SHA that is checked out and published
 *   C. production reports that SHA at /api/health
 *   D. smoke fails if the live SHA is not the released one
 *   E. rollback deploys the revision it was given, and nothing else
 *
 * See docs/RELEASE.md.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseWorkflowYaml,
  readWorkflow,
  steps,
  triggers,
  type YamlValue,
} from './helpers/workflowYaml.ts';

const ROOT = join(import.meta.dirname, '..');

const asMap = (value: YamlValue | undefined): Record<string, YamlValue> =>
  (value ?? {}) as Record<string, YamlValue>;
const asList = (value: YamlValue | undefined): YamlValue[] => (Array.isArray(value) ? value : []);
const jobs = (yaml: Record<string, YamlValue>) => asMap(yaml['jobs']);
const job = (yaml: Record<string, YamlValue>, name: string) => asMap(jobs(yaml)[name]);

/* ------------------------------------------------------------- the reader */

/*
 * The parser these assertions are made with, checked before they are trusted.
 * A reader that had quietly stopped understanding a construct would make every
 * test below pass by finding nothing.
 */
describe('the workflow reader', () => {
  it('reads nesting, sequences, flow sequences and block scalars', () => {
    const yaml = parseWorkflowYaml(`
name: Example
on:
  workflow_run:
    workflows: [CI]
    types: [completed]
  workflow_dispatch:
    inputs:
      ref:
        required: true
jobs:
  one:
    runs-on: ubuntu-latest   # a trailing comment
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ inputs.ref }}
      - name: Say something
        run: |
          echo "hello  # not a comment"
          echo done
`);
    expect(yaml['name']).toBe('Example');
    expect(asList(asMap(triggers(yaml)['workflow_run'])['workflows'])).toEqual(['CI']);
    expect(triggers(yaml)['workflow_dispatch']).toEqual({ inputs: { ref: { required: true } } });
    const [checkout, said] = steps(yaml, 'one');
    expect(checkout!['uses']).toBe('actions/checkout@v4');
    expect(asMap(checkout!['with'])['ref']).toBe('${{ inputs.ref }}');
    expect(said!['name']).toBe('Say something');
    expect(said!['run']).toContain('# not a comment');
    expect(said!['run']).toContain('echo done');
  });

  /*
   * Every workflow in the repository, not just the five this file asserts on:
   * a construct the reader cannot handle is a construct it would silently
   * return nothing for, and the release files are edited by the same hands as
   * the other fourteen.
   */
  it.each(readdirSync(join(ROOT, '.github', 'workflows')))('reads %s', (name) => {
    const { yaml } = readWorkflow(name);
    expect(Object.keys(triggers(yaml)).length, `${name} should declare triggers`).toBeGreaterThan(0);
    expect(Object.keys(jobs(yaml)).length, `${name} should declare jobs`).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------ A — CI gates the deploy */

describe('Deploy waits for authoritative CI', () => {
  const { yaml, text } = readWorkflow('deploy.yml');

  /*
   * The regression this exists to prevent, precisely: `push: main` started the
   * deploy and the browser gate at the same moment, so production could be
   * serving a commit the strongest gate for that commit had not finished
   * judging. The window was the length of the browser suite.
   */
  it('is not triggered by a push', () => {
    expect(Object.keys(triggers(yaml))).not.toContain('push');
    expect(triggers(yaml)['push']).toBeUndefined();
  });

  it('is triggered by CI completing on main', () => {
    const run = asMap(triggers(yaml)['workflow_run']);
    expect(asList(run['workflows'])).toEqual(['CI']);
    expect(asList(run['types'])).toEqual(['completed']);
    // Pull-request CI runs carry the PR's branch and are filtered out here.
    expect(asList(run['branches'])).toEqual(['main']);
  });

  /*
   * The gate used to be a job-level `if` on the conclusion. It now lives inside
   * the decide step, for the reason in "every CI outcome leaves a record"
   * below — a job-level `if` refuses silently, and silence was the bug. What
   * must not change is the rule: only a revision whose own CI *succeeded* is
   * ever released.
   */
  it('deploys nothing unless that CI run succeeded', () => {
    const check = steps(yaml, 'decide').find((step) => step['id'] === 'check');
    const script = String(check?.['run']);
    // Anything other than `success` falls into an arm that stands down.
    expect(script).toMatch(/case "\$CI_CONCLUSION" in/);
    expect(script).toMatch(/success\)/);
    // And only `proceed=yes` reaches the release.
    expect(String(job(yaml, 'release')['if'])).toContain("needs.decide.outputs.proceed == 'yes'");
    expect(script).not.toMatch(/proceed=yes[\s\S]*case "\$CI_CONCLUSION"/);
  });

  it('cannot be started by hand — an explicit revision is Rollback’s job', () => {
    expect(Object.keys(triggers(yaml))).not.toContain('workflow_dispatch');
    expect(text).not.toContain('workflow_dispatch');
  });
});

/* ------------------------------------------- B — the exact SHA is preserved */

describe('the validated revision is the one that ships', () => {
  const deploy = readWorkflow('deploy.yml');
  const release = readWorkflow('release.yml');

  it('Deploy hands CI’s own head_sha to the release', () => {
    const check = steps(deploy.yaml, 'decide').find((step) => step['id'] === 'check');
    // The candidate is CI's own report of what it validated — not `github.sha`,
    // which for a `workflow_run` event is main's head at the moment this starts.
    expect(asMap(check?.['env'])['CANDIDATE']).toBe('${{ github.event.workflow_run.head_sha }}');
    expect(String(check?.['run'])).toContain('sha=$CANDIDATE');
    const withArgs = asMap(job(deploy.yaml, 'release')['with']);
    expect(job(deploy.yaml, 'release')['uses']).toBe('./.github/workflows/release.yml');
    expect(withArgs['sha']).toBe('${{ needs.decide.outputs.sha }}');
  });

  it('Deploy stands down rather than overwrite a newer revision', () => {
    const check = steps(deploy.yaml, 'decide').find((step) => step['id'] === 'check');
    expect(String(check?.['run'])).toContain('git rev-parse origin/main');
    expect(String(check?.['run'])).toContain('proceed=no');
    expect(String(job(deploy.yaml, 'release')['if'])).toContain("needs.decide.outputs.proceed == 'yes'");
  });

  it('Release is callable only, so nothing can start it on a branch', () => {
    expect(Object.keys(triggers(release.yaml))).toEqual(['workflow_call']);
    const inputs = asMap(asMap(triggers(release.yaml)['workflow_call'])['inputs']);
    expect(asMap(inputs['sha'])['required']).toBe(true);
  });

  it('Release checks out the revision it was given, not a branch', () => {
    const checkout = steps(release.yaml, 'release').find((step) => String(step['uses']).startsWith('actions/checkout'));
    expect(asMap(checkout?.['with'])['ref']).toBe('${{ inputs.sha }}');
  });

  /*
   * Belt and braces on the one link that cannot be checked from outside: if the
   * checkout ever produced something other than what was asked for, everything
   * downstream — the stamp, the health response, the smoke comparison — would
   * agree with each other about the wrong revision.
   */
  it('Release proves the working tree is that revision before building', () => {
    const proof = steps(release.yaml, 'release').find((step) =>
      String(step['name']).includes('Prove the working tree'),
    );
    expect(String(proof?.['run'])).toContain('git rev-parse HEAD');
    expect(String(proof?.['run'])).toContain('Refusing to deploy');
  });

  it('Release insists on a full commit id rather than a name', () => {
    const proof = steps(release.yaml, 'release').find((step) =>
      String(step['name']).includes('Prove the working tree'),
    );
    expect(String(proof?.['run'])).toContain('full 40-character commit id');
  });
});

/* ------------------------------- C — production is stamped with that SHA */

describe('the revision reaches the running Worker', () => {
  const { yaml } = readWorkflow('release.yml');
  const stepNames = steps(yaml, 'release').map((step) => String(step['name'] ?? step['uses']));
  const at = (fragment: string) => stepNames.findIndex((name) => name.includes(fragment));

  it('stamps wrangler.toml before the build, so the value is compiled in', () => {
    expect(at('Stamp the revision')).toBeGreaterThan(-1);
    expect(at('Stamp the revision')).toBeLessThan(at('Build the site'));
    expect(at('Build the site')).toBeLessThan(at('Deploy'));
  });

  it('fails rather than ships an unstamped Worker', () => {
    const stamp = steps(yaml, 'release').find((step) => String(step['name']).includes('Stamp the revision'));
    expect(String(stamp?.['run'])).toContain('no RELEASE_SHA line to stamp');
    expect(String(stamp?.['run'])).toContain('process.exit(1)');
  });

  /*
   * The stamp is a text replacement, so the line it replaces has to exist and
   * has to match. This is the same regex the workflow uses; if the committed
   * `wrangler.toml` ever stops matching it, every release ships `unknown` and
   * production loses the ability to say what it is.
   */
  it('wrangler.toml carries a line for the stamp to replace', () => {
    const toml = readFileSync(join(ROOT, 'wrangler.toml'), 'utf8');
    expect(toml).toMatch(/^RELEASE_SHA = "[^"]*"$/m);
    // Committed as `unknown`: a hand-run deploy has no release behind it.
    expect(toml).toMatch(/^RELEASE_SHA = "unknown"$/m);
  });

  it('asks production what it is running before calling the deploy done', () => {
    const verify = steps(yaml, 'release').find((step) =>
      String(step['name']).includes('production is answering as this revision'),
    );
    expect(String(verify?.['run'])).toContain('scripts/check-release-sha.mjs');
    expect(at('production is answering as this revision')).toBeGreaterThan(at('Deploy'));
  });

  it('prints the revision where an operator will see it', () => {
    const { text } = readWorkflow('release.yml');
    expect(text).toContain('::notice::Releasing');
    expect(text).toContain('**Revision:**');
  });
});

/* ------------------------------------------- D — smoke verifies the revision */

describe('Smoke reports on the revision it was told about', () => {
  const { yaml, text } = readWorkflow('smoke.yml');
  const call = asMap(triggers(yaml)['workflow_call']);
  const inputs = asMap(call['inputs']);

  it('is called with the revision the release published', () => {
    /*
     * `full` joined `expected_sha` and `url` when the deploy gate was split
     * from the daily sweep. It is deliberately absent from what the callers
     * pass: a deploy wants the gate, and the gate is the default. Asserting
     * the exact set still catches an input added and never wired up.
     */
    expect(Object.keys(inputs).sort()).toEqual(['expected_sha', 'full', 'url']);
    for (const caller of ['deploy.yml', 'rollback.yml']) {
      const { yaml: callerYaml } = readWorkflow(caller);
      const smoke = job(callerYaml, 'smoke');
      expect(smoke['uses'], `${caller} should call smoke`).toBe('./.github/workflows/smoke.yml');
      expect(asMap(smoke['with'])['expected_sha']).toBe('${{ needs.release.outputs.sha }}');
      expect(asMap(smoke['with'])['url']).toBe('${{ needs.release.outputs.url }}');
      expect(
        asMap(smoke['with'])['full'],
        `${caller} must not ask for the full sweep: 150 test executions against the live database on every deploy is what exhausted the D1 row quota`,
      ).toBeUndefined();
    }
  });

  /**
   * The depth that left the deploy path has to still happen somewhere.
   *
   * Moving the full sweep off every deploy is only defensible because it runs
   * daily instead. If that schedule is ever dropped, the widths and the
   * screenshots stop running at all and nothing else would say so.
   */
  it('still runs the full sweep daily, now that deploys only run the gate', () => {
    expect(Object.keys(triggers(yaml))).toContain('schedule');
    expect(text, 'the deploy gate selects the @critical specs').toContain('--grep @critical');
  });

  /*
   * `workflow_run` only says that *a* deploy finished; the run then checks
   * whatever is live when it gets a runner, which a second release or a
   * rollback can have changed. Being called means the revision comes with the
   * request.
   */
  it('is no longer triggered by "a deploy finished"', () => {
    expect(Object.keys(triggers(yaml))).not.toContain('workflow_run');
  });

  it('compares revisions first, before twenty minutes of browser checks', () => {
    const names = steps(yaml, 'smoke').map((step) => String(step['name'] ?? step['uses']));
    const compare = names.findIndex((name) => name.includes('production is the revision'));
    const browser = names.findIndex((name) => name.includes('Check the live site'));
    expect(compare).toBeGreaterThan(-1);
    expect(compare).toBeLessThan(browser);
    expect(text).toContain('check-release-sha.mjs');
  });

  it('hands the expected revision to the browser suite as well', () => {
    expect(asMap(job(yaml, 'smoke')['env'])['EXPECTED_RELEASE_SHA']).toBe('${{ inputs.expected_sha }}');
  });

  /*
   * A rollback puts an older UI live on purpose, and main's assertions describe
   * the newer one. The suite that shipped with the code is the suite that
   * describes it.
   */
  it('runs the released revision’s own suite', () => {
    const checkout = steps(yaml, 'smoke').find((step) => String(step['uses']).startsWith('actions/checkout'));
    expect(asMap(checkout?.['with'])['ref']).toBe('${{ inputs.expected_sha }}');
  });

  it('still runs every width it ran before', () => {
    expect(text).toContain('--project=webkit-iphone-390');
    expect(text).toContain('--project=webkit-iphone-375');
    expect(text).toContain('--project=webkit-small-360');
  });
});

/* --------------------------------------------------- E — rollback is explicit */

describe('Rollback deploys what it is told to', () => {
  const { yaml, text } = readWorkflow('rollback.yml');
  const inputs = asMap(asMap(triggers(yaml)['workflow_dispatch'])['inputs']);

  it('requires a revision, with no default to fall back to', () => {
    expect(asMap(inputs['ref'])['required']).toBe(true);
    expect(asMap(inputs['ref'])['default']).toBeUndefined();
  });

  it('resolves that revision to a commit, or fails', () => {
    const resolve = steps(yaml, 'resolve').find((step) => step['id'] === 'resolve');
    expect(String(resolve?.['run'])).toContain('git rev-parse --verify');
    expect(String(resolve?.['run'])).toContain('is not a commit in this repository');
  });

  /*
   * A rollback target has to be code production has run before. A commit that
   * never reached main has never been through the release path, and a rollback
   * is the worst moment to be shipping something for the first time.
   */
  it('refuses a revision that was never on main', () => {
    const resolve = steps(yaml, 'resolve').find((step) => step['id'] === 'resolve');
    expect(String(resolve?.['run'])).toContain('git merge-base --is-ancestor');
    expect(String(resolve?.['run'])).toContain("not in main's history");
  });

  /*
   * `${{ inputs.ref }}` inside a `run:` block is pasted into the script before
   * the shell sees it, so whatever was typed into the Actions form becomes
   * shell source. Read as environment variables instead — the form needs write
   * access to reach, which is not the same as being a trusted keyboard.
   */
  it('never pastes an operator’s typing into a shell', () => {
    const resolve = steps(yaml, 'resolve').find((step) => step['id'] === 'resolve');
    expect(asMap(resolve?.['env'])['REF']).toBe('${{ inputs.ref }}');
    expect(asMap(resolve?.['env'])['REASON']).toBe('${{ inputs.reason }}');
    expect(String(resolve?.['run'])).not.toContain('inputs.ref');
    expect(String(resolve?.['run'])).not.toContain('inputs.reason');
  });

  it('deploys exactly what it resolved', () => {
    expect(job(yaml, 'release')['uses']).toBe('./.github/workflows/release.yml');
    expect(asMap(job(yaml, 'release')['with'])['sha']).toBe('${{ needs.resolve.outputs.sha }}');
  });

  /*
   * Rolling back is deploying a revision that already exists. Reverting the
   * commit on main is a separate, later, reviewable change — so nothing here
   * writes to the repository at all, and what it does is checked on the lines
   * that run rather than on the comments, which are allowed to say the word.
   */
  it('never rewrites history to get there', () => {
    const executable = text
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    for (const forbidden of ['--force-with-lease', 'push --force', 'force-push', 'git push', 'git revert', 'git reset']) {
      expect(executable, forbidden).not.toContain(forbidden);
    }
  });

  it('says plainly that the database does not roll back with the code', () => {
    expect(text).toContain('Migrations already applied stay applied');
  });
});

/* ------------------------------------------------------------- concurrency */

describe('two things never write to production at once', () => {
  it('Deploy and Rollback share one group, and neither cancels the other', () => {
    for (const name of ['deploy.yml', 'rollback.yml']) {
      const { yaml } = readWorkflow(name);
      const concurrency = asMap(yaml['concurrency']);
      expect(concurrency['group'], `${name} concurrency group`).toBe('release');
      expect(concurrency['cancel-in-progress'], `${name} cancel-in-progress`).toBe(false);
    }
  });

  /*
   * CI has its own group, keyed by ref. That is what keeps an ordinary push
   * from cancelling a rollback that is in flight.
   */
  it('CI cancels only its own runs', () => {
    const { yaml } = readWorkflow('ci.yml');
    expect(String(asMap(yaml['concurrency'])['group'])).toContain('github.ref');
    expect(String(asMap(yaml['concurrency'])['group'])).not.toBe('release');
  });

  it('Smoke is keyed by the revision it is checking', () => {
    const { yaml } = readWorkflow('smoke.yml');
    expect(String(asMap(yaml['concurrency'])['group'])).toContain('inputs.expected_sha');
  });
});

/* ------------------------------------------- the gate itself is not weakened */

describe('authoritative CI keeps its teeth', () => {
  const { yaml, text } = readWorkflow('ci.yml');

  it('still runs every check the release now depends on', () => {
    for (const command of ['npm run typecheck', 'npm test', 'npm run build', 'npm run perf:budget']) {
      expect(text).toContain(command);
    }
    expect(text).toContain('wrangler deploy --dry-run');
  });

  it('still verifies four widths across three shards', () => {
    const matrix = asMap(asMap(job(yaml, 'e2e')['strategy'])['matrix']);
    expect(asList(matrix['project'])).toEqual([
      'webkit-iphone-430',
      'webkit-iphone-390',
      'webkit-iphone-375',
      'webkit-small-360',
    ]);
    expect(asList(matrix['shard'])).toEqual([1, 2, 3]);
    expect(text).toContain('--shard=${{ matrix.shard }}/3');
  });

  /*
   * The browser timeouts were argued down to these numbers by sharding rather
   * than raised again, and this lane changes release orchestration rather than
   * confidence. A raise here would be a change of subject.
   */
  it('has not bought time by raising a browser ceiling', () => {
    expect(job(yaml, 'e2e')['timeout-minutes']).toBe(32);
    const test = steps(yaml, 'e2e').find((step) => String(step['run']).includes('playwright test'));
    expect(test?.['timeout-minutes']).toBe(18);
  });

  /*
   * A Playwright run piped into anything reports the exit status of the last
   * command in the pipe, which is how a suite full of failures becomes a green
   * tick. Checked across every workflow that runs one.
   */
  it('never pipes a browser run through something that would eat its exit code', () => {
    for (const name of ['ci.yml', 'smoke.yml']) {
      const workflow = readWorkflow(name).text;
      for (const line of workflow.split('\n')) {
        if (!line.includes('playwright test')) continue;
        expect(line, `${name}: ${line.trim()}`).not.toMatch(/\|\s*(tail|grep|head|cat)\b/);
      }
    }
  });
});

/* ------------------------------------- what a caller asks of a called workflow */

/*
 * The contract between a caller and the reusable workflow it calls.
 *
 * GitHub validates this when the run *starts*, not when the job runs, and a
 * mismatch does not fail a job — it fails the whole run with `startup_failure`
 * and no logs worth reading. There is no local signal at all: the files parse,
 * every editor is happy, and the first thing anybody learns is a grey tick on
 * main after a merge.
 *
 * Three ways to get it wrong, all of them one typo:
 *   - pass an input the callee does not declare
 *   - omit one it declares as required
 *   - read `needs.<job>.outputs.<name>` that the callee never declares
 *
 * So the contract is checked here, from the files, before any of it is pushed.
 */
describe('reusable workflows are called the way they are declared', () => {
  const workflowCall = (yaml: Record<string, YamlValue>) =>
    asMap(triggers(yaml)['workflow_call']);

  /** Every `uses: ./.github/workflows/x.yml` in the repository. */
  const calls = readdirSync(join(ROOT, '.github', 'workflows')).flatMap((name) => {
    const { yaml } = readWorkflow(name);
    return Object.entries(jobs(yaml))
      .map(([jobName, one]) => ({ jobName, job: asMap(one) }))
      .filter(({ job }) => String(job['uses'] ?? '').startsWith('./.github/workflows/'))
      .map(({ jobName, job }) => ({
        caller: name,
        jobName,
        callee: String(job['uses']).split('/').pop()!,
        with: asMap(job['with']),
      }));
  });

  it('finds the calls to check', () => {
    // deploy.yml and rollback.yml each call release.yml and smoke.yml.
    expect(calls.length).toBeGreaterThanOrEqual(4);
  });

  it.each(calls)('$caller → $jobName calls $callee with inputs it declares', (call) => {
    const { yaml: calleeYaml } = readWorkflow(call.callee);
    const declared = asMap(workflowCall(calleeYaml)['inputs']);

    expect(
      Object.keys(declared).length,
      `${call.callee} is called by ${call.caller} but declares no workflow_call inputs`,
    ).toBeGreaterThan(0);

    for (const given of Object.keys(call.with)) {
      expect(
        Object.keys(declared),
        `${call.caller} → ${call.jobName} passes "${given}", which ${call.callee} does not declare. ` +
          'GitHub rejects this at run start with startup_failure.',
      ).toContain(given);
    }

    const required = Object.entries(declared)
      .filter(([, spec]) => asMap(spec)['required'] === true)
      .map(([key]) => key);
    for (const key of required) {
      expect(
        Object.keys(call.with),
        `${call.caller} → ${call.jobName} omits "${key}", which ${call.callee} requires.`,
      ).toContain(key);
    }
  });

  /*
   * The other half: a caller reading an output the callee never publishes gets
   * an empty string, silently, which is how a smoke run ends up checking the
   * wrong site or an empty revision rather than failing.
   */
  it.each(calls)('$caller → $jobName reads only outputs $callee publishes', (call) => {
    const { yaml: callerYaml } = readWorkflow(call.caller);
    const referenced = new Set<string>();
    for (const value of Object.values(call.with)) {
      for (const [, job, output] of String(value).matchAll(/needs\.([\w-]+)\.outputs\.([\w-]+)/g)) {
        referenced.add(`${job}.${output}`);
      }
    }

    for (const reference of referenced) {
      const [jobName, output] = reference.split('.') as [string, string];
      const producer = asMap(jobs(callerYaml)[jobName]);
      const producerUses = String(producer['uses'] ?? '');
      const published = producerUses.startsWith('./.github/workflows/')
        ? Object.keys(asMap(workflowCall(readWorkflow(producerUses.split('/').pop()!).yaml)['outputs']))
        : Object.keys(asMap(producer['outputs']));
      expect(
        published,
        `${call.caller} → ${call.jobName} reads needs.${reference}, which job "${jobName}" does not publish.`,
      ).toContain(output);
    }
  });
});

/* --------------------------------------- a CI outcome that is not a verdict */

/*
 * `startup_failure` is not "the code is bad".
 *
 * It happened on `a56e366`: GitHub failed to start the CI run, Deploy's job
 * guard evaluated false, the entire run came out `skipped` in three seconds,
 * and main sat undeployed with nothing anywhere saying so. Re-running CI to
 * green did not help either — measured, no second Deploy run was created.
 *
 * The gate is not what changed. An unvalidated revision still never reaches
 * production. What changed is that refusing now leaves a record.
 */
describe('every CI outcome leaves a record', () => {
  const { yaml } = readWorkflow('deploy.yml');
  const decide = job(yaml, 'decide');
  const check = steps(yaml, 'decide').find((step) => step['id'] === 'check');
  const script = String(check?.['run'] ?? '');

  it('does not gate the whole job on the conclusion, which would make it silent', () => {
    expect(
      decide['if'],
      'a job-level `if` on the conclusion produces a skipped run with no summary',
    ).toBeUndefined();
  });

  it('still deploys only what CI actually passed', () => {
    expect(script).toContain('CI_CONCLUSION');
    expect(script).toMatch(/case "\$CI_CONCLUSION" in/);
    expect(script).toContain('success)');
    expect(String(job(yaml, 'release')['if'])).toContain("needs.decide.outputs.proceed == 'yes'");
  });

  it('separates a red verdict from no verdict at all', () => {
    expect(script).toMatch(/failure \| timed_out/);
    // The catch-all arm: cancelled, startup_failure, neutral, action_required…
    expect(script).toContain('*)');
    expect(script).toContain('::warning::');
    expect(script).toContain('not a verdict on the code');
  });

  it('says that re-running CI will not re-trigger the deploy', () => {
    expect(script).toContain('does not re-trigger this deploy');
    // …and names the path that does work.
    expect(script).toContain('Rollback');
  });

  it('writes a summary on every stand-down, not just some', () => {
    expect(script).toContain('stand_down()');
    expect(script).toContain('GITHUB_STEP_SUMMARY');
    // Every arm that declines to deploy goes through the one helper.
    const declines = [...script.matchAll(/proceed=no/g)];
    expect(declines.length, 'proceed=no should only be written by stand_down').toBe(1);
  });
});

/* ------------------------------------------------- the shell inside a container */

/*
 * A job that runs in a container gets `sh -e {0}`, not bash.
 *
 * This is not a style rule, it is a defect that has already happened. The first
 * release through the new path deployed perfectly and then went red in smoke,
 * in zero seconds, on:
 *
 *     /__w/_temp/….sh: 1: set: Illegal option -o pipefail
 *
 * `pipefail` is a bashism, dash rejects it before the first command runs, and
 * the step that carried it was the one asserting the deployed revision — so a
 * good release reported as a bad one. The identical script passed in the deploy
 * job moments earlier, because that job has no container and therefore has bash.
 *
 * The trap is that it is invisible in review: the same three words are correct
 * one file away. So it is checked here, across every containerised job in the
 * repository, rather than remembered.
 */
describe('steps inside a container stay POSIX', () => {
  const BASHISMS: Array<{ pattern: RegExp; what: string }> = [
    { pattern: /\bset\s+-[a-z]*o\s+pipefail/, what: 'set -o pipefail' },
    { pattern: /\bPIPESTATUS\b/, what: '$PIPESTATUS' },
    { pattern: /\[\[/, what: '[[ ]]' },
    // Process substitution: `--data-binary @<(printf …)`, which the deploy job
    // uses freely and legally, because it has bash.
    { pattern: /<\(/, what: 'process substitution' },
    { pattern: /\bsource\s+\S/, what: 'source' },
  ];

  const containerJobs = readdirSync(join(ROOT, '.github', 'workflows')).flatMap((name) => {
    const { yaml } = readWorkflow(name);
    return Object.entries(jobs(yaml))
      .filter(([, one]) => asMap(one)['container'] !== undefined)
      .map(([jobName]) => ({ workflow: name, job: jobName }));
  });

  it('finds the containerised jobs to check', () => {
    // ci.yml's `e2e` and smoke.yml's `smoke`, at least. A refactor that lost
    // them would leave every assertion below passing over an empty list.
    expect(containerJobs.length).toBeGreaterThanOrEqual(2);
  });

  it.each(containerJobs)('$workflow → $job uses no bashism', ({ workflow, job: jobName }) => {
    const { yaml } = readWorkflow(workflow);
    for (const step of steps(yaml, jobName)) {
      const script = String(step['run'] ?? '');
      if (script === '') continue;
      // A step may opt into bash explicitly; then the bashisms are legal.
      if (String(step['shell'] ?? '').includes('bash')) continue;
      for (const { pattern, what } of BASHISMS) {
        expect(
          pattern.test(script),
          `${workflow} → ${jobName} → "${step['name'] ?? 'unnamed step'}" uses ${what}, ` +
            'which dash rejects. Container jobs run under `sh`: use POSIX, or set `shell: bash` on the step.',
        ).toBe(false);
      }
    }
  });
});
