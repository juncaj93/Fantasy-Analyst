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
