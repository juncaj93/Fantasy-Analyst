/**
 * The three things that stop a test suite taking the app down.
 *
 * On 8 September the daily D1 allowance was spent by the production browser
 * suite: two runs dispatched by hand and one scheduled read about 5.06 million
 * of the day's 5.33 million rows between them, and the app answered errors from
 * 12:30 UTC until midnight. The app's own crons spent about 24,000 rows that
 * day — half a percent. Nothing was wrong with the app; the thing checking it
 * was what could not afford to run.
 *
 * Three changes, and none of them is "run it less and hope":
 *
 *   1. the scheduled sweep runs one width rather than three;
 *   2. it stands down on a day a full pass was already dispatched by hand;
 *   3. every full pass asks how much of the allowance is left first, and
 *      declines rather than finishing the job.
 *
 * These are structural claims about workflow files, so they are asserted
 * structurally — the same reading `scheduledJobAlert` and the release tests
 * use. A regex over these files would keep passing after the shape moved.
 */

import { describe, expect, it } from 'vitest';
import { readWorkflow, type YamlValue } from './helpers/workflowYaml.ts';

const job = (yaml: Record<string, YamlValue>, name: string): Record<string, YamlValue> => {
  const jobs = yaml['jobs'] as Record<string, YamlValue> | undefined;
  const found = jobs?.[name] as Record<string, YamlValue> | undefined;
  expect(found, `workflow has no \`${name}\` job`).toBeDefined();
  return found!;
};

describe('the budget guard in front of a full pass', () => {
  it('exists, and gates the suite rather than sitting beside it', () => {
    const { yaml } = readWorkflow('smoke.yml');
    const smoke = job(yaml, 'smoke');
    expect(job(yaml, 'budget'), 'the gate itself').toBeDefined();
    expect(String(smoke['needs'] ?? '')).toContain('budget');
    expect(
      String(smoke['if'] ?? ''),
      'a full pass runs only when the guard found room',
    ).toContain("needs.budget.outputs.proceed == 'yes'");
  });

  /**
   * The deploy gate is eight checks at one width and is the last thing standing
   * between a bad release and production. It must never be declined for budget.
   */
  it('never blocks the deploy gate', () => {
    const { yaml } = readWorkflow('smoke.yml');
    expect(String(job(yaml, 'budget')['if'] ?? ''), 'the guard runs only for a full pass').toContain('inputs.full');
    expect(
      String(job(yaml, 'smoke')['if'] ?? ''),
      'and the gate runs whether or not the guard did',
    ).toContain('!inputs.full');
  });

  it('is reachable by hand with a ceiling somebody can raise', () => {
    const { text } = readWorkflow('smoke.yml');
    expect(text).toContain('ceiling_percent');
  });

  /**
   * The ceiling only protects the day if the ceiling plus one sweep stays under
   * Cloudflare's 80% alert. The most expensive sweep measured read 2.0M rows,
   * 40% of the allowance (27 September, retries re-crawling). At the old 50%
   * default, 25 September started a sweep at 41.5% and ended at 82%.
   */
  it('defaults low enough that the worst sweep measured cannot reach the 80% alert', () => {
    const WORST_SWEEP_PERCENT = 40;
    const ALERT_PERCENT = 80;
    const { yaml, text } = readWorkflow('smoke.yml');
    const on = yaml['on'] as Record<string, YamlValue>;
    for (const trigger of ['workflow_call', 'workflow_dispatch']) {
      const inputs = (on[trigger] as Record<string, YamlValue>)['inputs'] as Record<string, YamlValue>;
      const ceiling = Number((inputs['ceiling_percent'] as Record<string, YamlValue>)['default']);
      expect(ceiling + WORST_SWEEP_PERCENT, `${trigger} default`).toBeLessThan(ALERT_PERCENT);
    }
    const fallback = /inputs\.ceiling_percent \|\| '(\d+)'/.exec(text);
    expect(fallback, 'the guard step falls back to a default').not.toBeNull();
    expect(Number(fallback![1]) + WORST_SWEEP_PERCENT).toBeLessThan(ALERT_PERCENT);
  });
});

describe('the daily sweep', () => {
  it('runs one width, not three', () => {
    const { yaml } = readWorkflow('smoke-daily.yml');
    const sweep = job(yaml, 'sweep');
    const wth = sweep['with'] as Record<string, YamlValue>;
    expect(wth['full'], 'still a full pass rather than the deploy gate').toBe(true);
    expect(wth['widths'], 'at one width, for a third of the rows').toBe('primary');
  });

  it('stands down on a day that already had one', () => {
    const { yaml } = readWorkflow('smoke-daily.yml');
    const sweep = job(yaml, 'sweep');
    expect(String(sweep['needs'] ?? '')).toContain('recent');
    expect(String(sweep['if'] ?? '')).toContain("ran_today == 'no'");
  });

  /**
   * A sweep that deliberately stood down is not a sweep that failed. An issue
   * opened every time the guard worked is the fastest way to teach somebody to
   * close these unread — which is how `Refresh draft order` failed silently for
   * eleven days.
   */
  it('does not raise the alarm when it stood down on purpose', () => {
    const { yaml } = readWorkflow('smoke-daily.yml');
    expect(String(job(yaml, 'alert')['if'] ?? '')).toContain("ran_today == 'no'");
  });
});

describe('the width that was given up', () => {
  /**
   * The daily sweep drops 375 and 360 *against production data*. That is only
   * affordable because those widths are still gated somewhere, on every change,
   * for free — so this asserts the somewhere still exists rather than trusting
   * a sentence in a comment.
   */
  it('is still covered by CI against a seeded local build', () => {
    const { text } = readWorkflow('ci.yml');
    for (const width of ['webkit-iphone-430', 'webkit-iphone-390', 'webkit-iphone-375', 'webkit-small-360']) {
      expect(text, `${width} must still run on every pull request`).toContain(width);
    }
  });
});

/**
 * The two mornings (30 September, 6 October) the guard stood the sweep down and
 * the day was still recorded as a pass. The run ended green because the guard
 * job succeeded and the browser job was merely skipped, the alert read that as
 * a success, and #204 closed itself with "Nothing is failing" over a day on
 * which no spec had run.
 */
describe('a stood-down sweep is never recorded as a pass', () => {
  const daily = () => readWorkflow('smoke-daily.yml').yaml;

  it('hands the guard’s answer back from the called workflow', () => {
    const { yaml } = readWorkflow('smoke.yml');
    const on = yaml['on'] as Record<string, YamlValue>;
    const outputs = (on['workflow_call'] as Record<string, YamlValue>)['outputs'] as Record<string, YamlValue>;
    for (const name of ['proceed', 'percent', 'ceiling']) {
      expect(outputs[name], `smoke.yml does not return \`${name}\``).toBeDefined();
    }
    expect(String((outputs['proceed'] as Record<string, YamlValue>)['value'])).toContain('jobs.budget.outputs.proceed');
  });

  it('has a job for the stand-down, which runs only when the sweep succeeded and said no', () => {
    const standDown = job(daily(), 'stood-down');
    const condition = String(standDown['if'] ?? '');
    expect(condition).toContain("needs.sweep.result == 'success'");
    expect(condition).toContain("needs.sweep.outputs.proceed == 'no'");
    // A guard that could not read usage also writes `no`, but it fails the job.
    // That is a failure and must not be filed as a polite stand-down.
    expect(condition, 'a failed guard must not count as a stand-down').toContain("== 'success'");
  });

  it('keeps the stand-down away from the alarm that would clear the issue', () => {
    const condition = String(job(daily(), 'alert')['if'] ?? '');
    expect(condition, 'the alert must skip a stood-down day').toContain("needs.sweep.outputs.proceed == 'no'");
    expect(condition).toContain('!(');
    // Everything that is not a stand-down still reaches the alarm, failures included.
    expect(condition).toContain('always()');
  });

  it('comments on the issue and ends the run as not-run, in that order', () => {
    const standDown = job(daily(), 'stood-down');
    const steps = standDown['steps'] as Record<string, YamlValue>[];
    const names = steps.map((step) => String(step['name'] ?? step['uses']));
    const note = names.findIndex((n) => n.includes('Say the sweep did not run'));
    const end = names.findIndex((n) => n.includes('End the run as not run'));
    expect(note).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(note);
    expect(String((standDown['permissions'] as Record<string, YamlValue>)['issues'])).toBe('write');
    expect(String((standDown['permissions'] as Record<string, YamlValue>)['actions'])).toBe('write');
    expect(JSON.stringify(steps[end])).toContain('/cancel');
  });

  it('lets a person dispatch it with a lower ceiling, and leaves the default at 30', () => {
    const { yaml } = readWorkflow('smoke-daily.yml');
    const on = yaml['on'] as Record<string, YamlValue>;
    const dispatch = on['workflow_dispatch'] as Record<string, YamlValue>;
    const input = (dispatch['inputs'] as Record<string, YamlValue>)['ceiling_percent'] as Record<string, YamlValue>;
    expect(input['default'], 'blank means the guard’s own default').toBe('');
    const wth = job(yaml, 'sweep')['with'] as Record<string, YamlValue>;
    expect(String(wth['ceiling_percent'])).toContain('inputs.ceiling_percent');
    // The guard's own default is unchanged.
    expect(readWorkflow('smoke.yml').text).toContain("inputs.ceiling_percent || '30'");
  });
});

describe('when the daily sweep is scheduled to start', () => {
  /**
   * GitHub starts a scheduled run late. Between 8 September and 6 October the
   * 07:30 run began between 11:39 and 16:14 UTC, up to 8h44 late. The schedule
   * has to sit just after the 00:00 UTC reset and leave room for a start that
   * late to still land before the morning's reads.
   */
  const WORST_OBSERVED_LATENESS_MINUTES = 8 * 60 + 44;
  const cron = (): string[] => {
    const { text } = readWorkflow('smoke-daily.yml');
    const match = /- cron: '([^']+)'/.exec(text);
    expect(match, 'the sweep has a cron').not.toBeNull();
    return match![1]!.split(' ');
  };

  it('runs once a day, after the D1 reset and before anything else wakes', () => {
    const [minute, hour, dom, month, dow] = cron();
    expect([dom, month, dow]).toEqual(['*', '*', '*']);
    const startMinutes = Number(hour) * 60 + Number(minute);
    expect(startMinutes, 'later than the 00:00 UTC reset plus analytics lag').toBeGreaterThanOrEqual(15);
    expect(startMinutes, 'early enough to be well clear of the day’s use').toBeLessThanOrEqual(120);
  });

  it('still starts before the 09:00 UTC tick when GitHub is as late as it has ever been', () => {
    const [minute, hour] = cron();
    const startMinutes = Number(hour) * 60 + Number(minute);
    expect(startMinutes + WORST_OBSERVED_LATENESS_MINUTES).toBeLessThan(10 * 60);
  });

  it('is not on the hour or the half hour, where GitHub starts runs latest', () => {
    const [minute] = cron();
    expect(['0', '30']).not.toContain(minute);
  });
});

describe('how the production suite is split', () => {
  const smoke = () => readWorkflow('smoke.yml').yaml;
  const matrixShards = () => {
    const strategy = job(smoke(), 'smoke')['strategy'] as Record<string, YamlValue>;
    return String((strategy['matrix'] as Record<string, YamlValue>)['shard']);
  };

  /**
   * A shard is a whole spec file per project. The suite is one file, so one
   * width is one unit of work: `--shard=2/3` and `3/3` started a runner each and
   * ran nothing. Only an all-width pass has three units to hand out.
   */
  it('gives one width one runner, and only an all-width pass three', () => {
    const expression = matrixShards();
    expect(expression, 'primary must not fan out').toContain("inputs.widths != 'primary' && '[1, 2, 3]'");
    expect(expression, 'the deploy gate stays on one runner').toContain("|| '[1]'");
  });

  it('never asks Playwright for a shard count the matrix did not create', () => {
    const { text } = readWorkflow('smoke.yml');
    expect(text, 'a hard-coded /3 would leave empty shards').not.toMatch(/--shard=\$\{\{ matrix\.shard \}\}\/3/);
    expect(text).toContain("--shard=${{ matrix.shard }}/${{ strategy['job-total'] }}");
  });

  it('does not shard the single-width run at all', () => {
    const { text } = readWorkflow('smoke.yml');
    const primary = /if \[ "\$FULL" = "true" \] && \[ "\$WIDTHS" = "primary" \]; then([\s\S]*?)elif/.exec(text);
    expect(primary, 'found the single-width branch').not.toBeNull();
    expect(primary![1]).not.toContain('--shard');
  });
});
