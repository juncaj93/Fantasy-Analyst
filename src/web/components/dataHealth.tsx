/**
 * Data health — one row in Setup, one screen behind it.
 *
 * The user-facing half of the answer to "could this recommendation simply be
 * using old data?". Support Snapshot already says exactly what the app knew;
 * this says whether what it knew was healthy and current, and it says it in the
 * five words §3 names rather than in outcome codes: **Healthy**, **Waiting on
 * source**, **Some data stale**, **Degraded**, **Refresh problem**.
 *
 * ## Deliberately not a dashboard
 *
 * One row on Setup, beside the support tools and never in the taskbar. Behind
 * it, one pushed screen in four sections, in the order somebody diagnosing
 * actually reads them:
 *
 *   1. the overall state and when anything was last refreshed;
 *   2. **needs attention**, and only when there is something in it;
 *   3. every input, one compact row each;
 *   4. what the last scheduled refresh did.
 *
 * There is no history, no chart and no retention. A reader who wants a fifth
 * thing is being offered a monitoring platform, which §22 says not to build.
 *
 * ## Nothing here decides anything
 *
 * Every state, sentence and age on this screen is computed on the server and
 * arrives in the payload. This file renders words; it does not classify. §6 is
 * explicit that no stale threshold may live in a component, and the way that is
 * kept is that there is no arithmetic here to hide one in — `describeSource`
 * and `describeAge` are the shared model's, and are the same two functions Demo
 * Mode's rows go through.
 *
 * ## Colour is never the state
 *
 * Every row carries the state as a word (`Waiting on source`, `Deferred ·
 * background`) as well as a drawn mark, so the screen reads identically in
 * monochrome, at any contrast setting, and to a screen reader.
 */

import { useCallback, useEffect, useState } from 'react';

import { api, type DataHealthView, type SourceHealth, type StartSitRefreshReport } from '../api.ts';
import { Loading, Notice } from './common.tsx';
import { AlertCircleIcon, CheckCircleIcon, EmptyCircleIcon, PulseIcon } from './icons.tsx';
import { ListGroup, ListRow, PushScreen } from './native.tsx';
import {
  OVERALL_LABELS,
  describeAge,
  describeSource,
  minutesSince,
  needsAttention,
} from '../../core/health/model.ts';

/**
 * The three marks Setup already draws, for the seven states this screen has.
 *
 * `waiting` and `deferred` take the neutral mark rather than the warning one,
 * and that is the §3 rule rendered: a source that has legitimately not
 * published, and background work that deliberately yielded its budget, are
 * facts rather than tasks. Drawing a warning beside either would train the
 * reader to ignore the warnings that mean something.
 */
function markFor(state: string): 'ok' | 'warn' | 'todo' {
  if (state === 'current' || state === 'healthy') return 'ok';
  if (state === 'waiting' || state === 'deferred' || state === 'unknown') return 'todo';
  return 'warn';
}

function StateMark({ state }: { state: string }) {
  const mark = markFor(state);
  if (mark === 'ok') {
    return (
      <span className="list-state-ok">
        <CheckCircleIcon />
      </span>
    );
  }
  if (mark === 'warn') {
    return (
      <span className="list-state-warn">
        <AlertCircleIcon />
      </span>
    );
  }
  return (
    <span className="list-state-todo">
      <EmptyCircleIcon />
    </span>
  );
}

/**
 * The Setup row: one state, one age, one tap.
 *
 * `Healthy · refreshed 18 min ago` when there is nothing to do, and
 * `2 inputs need attention` when there is — the server writes both, because the
 * same sentence has to be able to appear in a support snapshot and in a test
 * without two copies of the wording existing.
 *
 * It fetches on mount rather than being handed down from Setup's own status
 * call: they are different reads with different lifetimes, and folding health
 * into `/api/setup/status` would have made every Setup open pay for twelve
 * source reads whether or not anybody looked.
 */
export function DataHealthRow({ onOpen }: { onOpen: () => void }) {
  const { health } = useDataHealth();

  return (
    <ListRow
      testId="setup-data-health"
      dataState={health?.overall.state ?? 'unknown'}
      /*
        A glyph leading and the mark trailing, because this row lives in
        Settings' Data group where every row leads with the kind of thing it is.
        The mark is the same one, in the other corner — see `ListRow`.
      */
      icon={<PulseIcon />}
      mark={<StateMark state={health?.overall.state ?? 'unknown'} />}
      label="Data health"
      detail={health?.overall.headline ?? 'Checking what the app is working from…'}
      chevron
      onClick={onOpen}
    />
  );
}

/**
 * The pushed screen.
 *
 * Consumer-friendly by default and technical only behind a disclosure, which is
 * §10: exact timestamps, canonical outcome words, the release revision and the
 * subrequest counters are all things a support agent wants and a user should
 * never have to scroll past.
 */
export function DataHealthScreen({ onBack }: { onBack: () => void }) {
  const { health, reload } = useDataHealth();
  const [technical, setTechnical] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [report, setReport] = useState<StartSitRefreshReport | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  /**
   * The control this screen did not have.
   *
   * Every source above was refreshable only by a clock. Vegas lines run on two
   * weekend crons, so a fix deployed on a Monday cannot reach a screen until
   * Saturday; the roster ran on no clock at all until this release. In between,
   * the only way to ask was a pull down the Team or Waivers screen — a gesture
   * on a different screen from the one reporting the staleness, and one an
   * earlier session told the owner was a button in Setup that has never
   * existed. This is that button, on the screen naming the stale rows.
   *
   * It calls the orchestrator the pull gesture calls and no endpoint of its own.
   * That matters more than the saving: `/api/startsit/refresh` is where the
   * dedupe, the per-source age gates and the odds budget's refusal all live, so
   * a second entry point with its own idea of any of them is exactly how a
   * screen starts disagreeing with the one next door. What is new here is the
   * caller, not the behaviour.
   *
   * It never claims more than it did. `report.sources` is the orchestrator's own
   * per-source outcome, printed verbatim — including `blocked`, which is the
   * answer a reader needs when the month's odds allowance is spent and the
   * lines on screen are the last ones this app is going to buy.
   */
  const refreshNow = useCallback(async () => {
    setRefreshing(true);
    setFailure(null);
    try {
      setReport(await api.post<StartSitRefreshReport>('/api/startsit/refresh', {}));
    } catch (err) {
      setReport(null);
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
      // The rows are re-read whatever happened: a refresh that failed half way
      // still moved the sources it reached, and leaving the old ages on screen
      // would misreport the ones that did land.
      await reload();
    }
  }, [reload]);

  return (
    <PushScreen
      title="Data health"
      subtitle={health == null ? undefined : subtitleFor(health)}
      backLabel="Setup"
      onBack={onBack}
      testId="data-health-screen"
    >
      {health == null ? (
        <Loading what="data health" />
      ) : (
        <>
          {/*
            What is wrong, before what is fine.

            Drawn only when there is something in it. A permanently-present
            "Needs attention (0)" heading is a heading that stops being read,
            and the whole value of this section is that its presence is itself
            the message.
          */}
          {health.overall.needsAttention > 0 ? (
            <ListGroup header="Needs attention">
              {health.sources.filter(needsAttention).map((source) => (
                <SourceRow key={source.id} source={source} />
              ))}
            </ListGroup>
          ) : (
            <Notice tone="ok">
              Every input behind a recommendation is current, waiting on a source that has not published yet, or
              deliberately running in the background. Nothing needs you.
            </Notice>
          )}

          {/*
            And directly under them, the way to act on them.

            Above the full list rather than at the bottom of the screen: a reader
            who has just been told two inputs are stale should not have to scroll
            past ten healthy rows to find the thing that fixes them.
          */}
          <ListGroup header="Refresh">
            <ListRow
              testId="data-health-refresh"
              label={refreshing ? 'Refreshing…' : 'Refresh now'}
              detail={
                refreshing
                  ? 'Asking Sleeper for your roster, then the injury, usage and Vegas feeds.'
                  : 'Re-reads your roster from Sleeper and asks for fresh injury, usage and Vegas lines. Games already priced this month are not bought again.'
              }
              value={refreshing ? undefined : 'Run'}
              onClick={refreshing ? undefined : () => void refreshNow()}
            />
            {failure ? (
              <ListRow
                testId="data-health-refresh-failed"
                dataState="failed"
                state={<StateMark state="failed" />}
                label="The refresh did not finish"
                detail={failure}
              />
            ) : null}
            {report?.sources.map((source) => (
              <ListRow
                key={source.source}
                testId={`data-health-refresh-${source.source}`}
                dataState={source.outcome}
                state={<StateMark state={source.outcome === 'updated' ? 'current' : source.outcome} />}
                label={REFRESH_SOURCE_LABELS[source.source] ?? source.source}
                detail={source.detail}
                value={source.outcome}
              />
            ))}
          </ListGroup>

          {/*
            Everything else, once each.

            The troubled inputs are above and are not repeated here. A phone
            screen that printed the same row twice would be asking the reader to
            work out whether it was the same row, and the heading changes to say
            which list this is rather than leaving them to notice.
          */}
          <ListGroup header={health.overall.needsAttention > 0 ? 'Other inputs' : 'Inputs'}>
            {health.sources.filter((source) => !needsAttention(source)).map((source) => (
              <SourceRow key={source.id} source={source} />
            ))}
          </ListGroup>

          <ListGroup header="Last scheduled refresh">
            {health.lastRun == null ? (
              <ListRow
                testId="data-health-run-none"
                label="No scheduled refresh recorded yet"
                detail="Nothing has been written down since this version was deployed. The five-minute injury check records itself against the injury source instead."
              />
            ) : (
              <ListRow
                testId="data-health-run"
                dataState={health.lastRun.outcome}
                state={<StateMark state={health.lastRun.outcome === 'succeeded' ? 'current' : health.lastRun.outcome} />}
                label={health.lastRun.label}
                detail={health.lastRun.summary}
                value={describeAge(minutesSince(health.lastRun.startedAt, new Date())) ?? undefined}
              />
            )}
          </ListGroup>

          {/*
            Everything a support agent asks for second, behind one tap.

            Exact instants rather than ages, the pipelines' own outcome words,
            the measured subrequest counters and the revision that ran. No
            secrets, no provider payloads and no raw exceptions: the server
            replaces a thrown error with a bounded category before it is ever
            written down, so there is nothing here that could carry one.
          */}
          <ListGroup header="For support">
            <ListRow
              testId="data-health-technical-toggle"
              label="Technical details"
              detail="Exact times, source outcome codes, refresh budget and the running revision."
              value={technical ? 'Hide' : 'Show'}
              expanded={technical}
              onClick={() => setTechnical((open) => !open)}
            />
            {technical ? <TechnicalPanel health={health} /> : null}
          </ListGroup>
        </>
      )}
    </PushScreen>
  );
}

/**
 * What the refresh calls each source, in the words the rows above already use.
 *
 * `sleeper` is the one that has to be renamed rather than title-cased: the
 * orchestrator names it for the provider it talks to, and every other surface in
 * this app names it for the thing it fetched.
 */
const REFRESH_SOURCE_LABELS: Record<string, string> = {
  sleeper: 'Your roster',
  injury: 'Injuries',
  usage: 'Usage',
  vegas: 'Vegas lines',
  weather: 'Weather',
};

function subtitleFor(health: DataHealthView): string {
  const age = describeAge(minutesSince(health.overall.refreshedAt, new Date()));
  return age == null ? OVERALL_LABELS[health.overall.state] : `${OVERALL_LABELS[health.overall.state]} · refreshed ${age}`;
}

/**
 * One input.
 *
 * `Injuries — Waiting on source`, `Usage — Current · 2h ago`,
 * `Manager tendencies — Deferred · background`. The state word and the age come
 * from `describeSource`, which is the shared model's, so the row cannot start
 * describing a state differently from the snapshot that carries it.
 *
 * The sentence underneath appears only when the state is not current, and it is
 * the server's — either the pipeline's own note, or the policy's sentence about
 * what being stale actually costs a recommendation. That is what makes the row
 * actionable rather than merely coloured.
 */
function SourceRow({ source }: { source: SourceHealth }) {
  return (
    <ListRow
      testId={`data-health-source-${source.id}`}
      dataState={source.state}
      state={<StateMark state={source.state} />}
      label={source.label}
      detail={
        <>
          {describeSource(source)}
          {source.note ? <div>{source.note}</div> : null}
        </>
      }
    />
  );
}

function TechnicalPanel({ health }: { health: DataHealthView }) {
  return (
    <div className="list-row list-row-static" data-testid="data-health-technical">
      <span className="list-row-body">
        <span className="list-row-detail">
          <div>
            Running revision <code>{health.release.gitSha}</code>, read at {health.generatedAt}.
          </div>
          {health.lastRun == null ? null : (
            <div>
              {health.lastRun.cron} · started {health.lastRun.startedAt} · outcome {health.lastRun.outcome}
              {health.lastRun.budget
                ? ` · ${health.lastRun.budget.used}/${health.lastRun.budget.limit} subrequests, ${health.lastRun.budget.remaining} unspent`
                : ' · no subrequest budget on this clock'}
              {health.lastRun.releaseSha ? ` · ran on ${health.lastRun.releaseSha}` : ''}
            </div>
          )}
          {health.lastRun?.steps.map((step) => (
            <div key={step.id}>
              {step.label}: {step.outcome}
              {step.items == null ? '' : ` (${step.items})`}
              {step.note ? ` — ${step.note}` : ''}
            </div>
          ))}
          {health.sources.map((source) => (
            <div key={source.id}>
              {source.label}: {source.state} · last success {source.lastSuccessAt ?? 'never'} · last attempt{' '}
              {source.lastAttemptAt ?? 'never'} · measured by {source.measure}
              {source.freshWithinMinutes == null ? '' : ` · current within ${source.freshWithinMinutes} min`}
              {source.technical.lastOutcome ? ` · ${source.technical.lastOutcome}` : ''}
              {source.technical.consecutiveFailures > 0
                ? ` · ${source.technical.consecutiveFailures} consecutive failure(s) since ${source.technical.failingSince ?? 'unknown'}`
                : ''}
            </div>
          ))}
        </span>
      </span>
    </div>
  );
}

/**
 * The read, once per mount.
 *
 * `fresh` because a health claim answered from a cache would be dated by
 * however long the reader had been on another screen, which is the one thing
 * this screen cannot afford to be wrong about. A failure leaves the row saying
 * it is still checking rather than replacing it with an error: the row is a
 * convenience beside the support tools, and a red banner in Setup because a
 * diagnostic read failed would be the tail wagging the dog.
 */
function useDataHealth(): { health: DataHealthView | null; reload: () => Promise<void> } {
  const [health, setHealth] = useState<DataHealthView | null>(null);

  const reload = useCallback(async () => {
    try {
      setHealth(await api.get<DataHealthView>('/api/data-health', { fresh: true }));
    } catch {
      /* Left as it was; the row keeps saying whatever it last knew. */
    }
  }, []);

  useEffect(() => {
    let live = true;
    api
      .get<DataHealthView>('/api/data-health', { fresh: true })
      .then((view) => {
        if (live) setHealth(view);
      })
      .catch(() => {
        /* Left as null; the row keeps saying it is checking. */
      });
    return () => {
      live = false;
    };
  }, []);

  return { health, reload };
}
