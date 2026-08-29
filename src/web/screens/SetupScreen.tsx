/**
 * Setup — the whole configuration experience in plain language.
 *
 * Deliberately free of developer vocabulary: no endpoints, no JSON, no
 * bindings. Anything that genuinely needs a terminal lives in the docs, not
 * here; this screen only shows what the user can do from their phone.
 */

import { Fragment, Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  type LeagueSummary,
  type NewsletterMessage,
  type NewsletterStatus,
  type RepairStatus,
  type AiTallyApplyOutcome,
  type AiTallyPreview,
  type ProjectionImportResult,
  type ProjectionStatus,
  type SetupStatus,
  type SignalBalance,
} from '../api.ts';
import { SIGNAL_BALANCE_ORDER } from '../../core/draft/signalBalance.ts';
import { Badge, Empty, Loading, Notice, formatAge, formatDate } from '../components/common.tsx';
import { AlertCircleIcon, CheckCircleIcon, EmptyCircleIcon } from '../components/icons.tsx';
import { ListGroup, ListRow, NavBar, PushScreen, SegmentedControl, Sheet } from '../components/native.tsx';
import { InstallPanel } from '../components/install.tsx';
import { DataHealthRow, DataHealthScreen } from '../components/dataHealth.tsx';
import { FeedbackRows, FlaggedScreen } from '../components/feedbackQueue.tsx';

import { PlayerPicker, ReviewScreen } from './ReviewScreen.tsx';
import { UnlockCard } from '../App.tsx';
import { unwindOne } from '../tabReset.ts';
import {
  CONTEXT_LABELS,
  CONTEXT_ORDER,
  readSupportContext,
  rememberSupportContext,
  type SupportContext,
} from '../supportContext.ts';
import {
  APPEARANCES,
  APPEARANCE_LABELS,
  applyAppearance,
  readAppearance,
  storeAppearance,
  watchSystemAppearance,
  type Appearance,
} from '../theme.ts';

/*
 * The scenario picker, fetched when somebody opens Setup and not before.
 *
 * It is the only part of Demo Mode that needs the whole scenario registry, and
 * a reader who never opens Settings should not download twenty-five
 * descriptions to find that out (§17).
 */
const DemoPanel = lazy(() => import('../demo/DemoPanel.tsx'));

type Panel =
  | 'sleeper'
  | 'league'
  | 'adp'
  | 'newsletter'
  | 'vegas'
  | 'repair'
  | 'review'
  | 'data-health'
  | 'flagged'
  | null;

/**
 * The state of a step, drawn rather than typed.
 *
 * These were `✅` and `⚠️`, which iOS renders as full-colour emoji: two
 * saturated stickers in a column of grey rows, at whatever size the emoji font
 * felt like. A drawn mark takes the semantic colour the theme gives it and is
 * the same weight as everything beside it.
 */
function StateMark({ state }: { state: string }) {
  if (state === 'ok') {
    return (
      <span className="list-state-ok">
        <CheckCircleIcon />
      </span>
    );
  }
  if (state === 'warn') {
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

/** What each pushed panel calls itself once it is the whole screen. */
const PANEL_TITLES: Record<Exclude<Panel, null>, string> = {
  sleeper: 'Connect Sleeper',
  league: 'Choose your league',
  adp: 'Draft order',
  newsletter: 'Newsletter',
  vegas: 'Vegas lines',
  repair: 'Help my scores',
  review: 'Review',
  'data-health': 'Data health',
  flagged: 'Feedback',
};

export function SetupScreen({
  leagues,
  onChanged,
  unlocked,
  canUnlock,
  onUnlocked,
  resetNonce,
  reviewPending,
}: {
  leagues: LeagueSummary[];
  onChanged: () => void;
  unlocked: boolean;
  canUnlock: boolean;
  onUnlocked: () => void;
  /** Bumped when Setup is tapped while already on Setup — see `App`. */
  resetNonce: number;
  /**
   * How many items are waiting in Review, counted by `App` from the overview.
   *
   * Passed in rather than read here so that the number on the row and the mark
   * on the Setup destination are the same number from the same read — two
   * places asking the same question separately is how a bar says 3 and a row
   * says 2.
   */
  reviewPending: number;
}) {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [open, setOpen] = useState<Panel>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * What scoring the last newsletter did, kept here rather than in the controls.
   *
   * The controls are drawn only while an issue is waiting, so they are gone the
   * instant one stops waiting — and a confirmation rendered inside them would
   * disappear in the same frame as the thing it was confirming. This outlives
   * that, and is cleared when the reader leaves Setup or another issue arrives.
   */
  const [scored, setScored] = useState<string | null>(null);

  /*
   * Tapping Setup while already on Setup.
   *
   * Back to the root of Settings, which is what the tab means, and to the top
   * of it. An open panel is a place the reader navigated to and this is the
   * gesture for coming back out of it — the same thing Back does, reachable
   * without hunting for a control in the corner of the screen.
   */
  useEffect(() => {
    if (resetNonce === 0) return;
    unwindOne([
      { when: open != null, undo: () => setOpen(null) },
      { when: error != null, undo: () => setError(null) },
      { when: scored != null, undo: () => setScored(null) },
    ]);
  }, [resetNonce]);

  const load = useCallback(async () => {
    try {
      setStatus(await api.get<SetupStatus>('/api/setup/status'));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshAll = () => {
    void load();
    onChanged();
  };

  /*
   * The bar stays up while the status is being read, and a failed read is
   * recoverable from where it happened.
   *
   * This returned the spinner — or, when the read failed, a bare line of error
   * text — *in place of the whole screen*: no title, no navigation bar, and
   * nothing to press. Every other screen keeps its chrome while it loads and
   * swaps only the content under it (`DraftScreen`, `TradesScreen`,
   * `ReviewScreen` and `DataHealthScreen` all do), and Setup was the one
   * exception.
   *
   * Production smoke reads that difference as "setup has no navigation bar":
   * a cold Worker still answering `/api/setup/status` leaves the reader on a
   * screen with no bar on it, which is the same defect whether a test or a
   * person is looking at it. The failed case was the worse half — `load` runs
   * once, on mount, so a single failed read left Settings dead for the rest of
   * the session with no way back but the destination it was already on. That is
   * the case `App` already answers with a retry, and it is answered here now
   * too.
   */
  if (!status) {
    return (
      <>
        <NavBar title="Setup" subtitle={error ? 'Could not read your setup' : 'Reading your setup…'} />
        {error ? (
          <Notice tone="error" data-testid="setup-error">
            <div>{error}</div>
            <div className="btn-row" style={{ marginTop: 8 }}>
              <button
                type="button"
                className="btn btn-sm"
                data-testid="setup-error-retry"
                onClick={() => {
                  setError(null);
                  void load();
                }}
              >
                Try again
              </button>
            </div>
          </Notice>
        ) : (
          <Loading what="your setup" />
        )}
      </>
    );
  }

  /*
   * A settings row leads to a screen, and that screen is pushed.
   *
   * The panels used to unfold underneath their row, which meant a long one —
   * Newsletter is a page and a half — pushed the rest of the list off the
   * bottom of the phone and left the reader scrolling to find where they were.
   * Pushed, each panel is the whole screen with its own title and a Back
   * control, exactly like every settings app on the platform. Nothing about
   * what any panel does has changed; only where it is drawn.
   */
  if (open === 'repair') {
    return <HelpMyScores open onOpen={() => setOpen('repair')} onClose={() => setOpen(null)} onChanged={refreshAll} />;
  }

  /*
   * Review is a pushed panel like any other, and it draws its own.
   *
   * It has a subtitle that counts what is waiting and an action in the bar, so
   * it owns its `PushScreen` rather than being wrapped in the generic one
   * below — the same arrangement `HelpMyScores` uses, and for the same reason.
   * `refreshAll` is what re-reads the overview after a decision, which is what
   * moves the count on the row this was opened from.
   */
  if (open === 'review') {
    return <ReviewScreen onChanged={refreshAll} onBack={() => setOpen(null)} />;
  }

  /*
   * Data health draws its own pushed screen, for the reason Review does.
   *
   * It has a subtitle that states the overall word and when anything was last
   * refreshed, and it reads from an endpoint of its own rather than from the
   * setup status this screen already holds — so wrapping it in the generic
   * `PushScreen` below would mean passing a subtitle up through a component
   * that has no business knowing what data health is.
   */
  if (open === 'data-health') {
    return <DataHealthScreen onBack={() => setOpen(null)} />;
  }

  /*
   * The feedback queue draws its own pushed screen, for the reason the two
   * above do: its subtitle counts what is in it, and the count changes
   * underneath as entries are deleted — so the generic `PushScreen` below would
   * mean passing a live number up through a component with no business knowing
   * about it.
   */
  if (open === 'flagged') {
    return <FlaggedScreen onBack={() => setOpen(null)} />;
  }

  if (open) {
    return (
      <PushScreen title={PANEL_TITLES[open]} backLabel="Setup" onBack={() => setOpen(null)} testId={`setup-detail-${open}`}>
        {open === 'sleeper' ? <SleeperPanel status={status} onDone={refreshAll} /> : null}
        {open === 'league' ? <LeaguePanel leagues={leagues} onDone={refreshAll} /> : null}
        {open === 'adp' ? <AdpPanel status={status} onDone={refreshAll} /> : null}
        {open === 'newsletter' ? <NewsletterPanel onDone={refreshAll} /> : null}
        {open === 'vegas' ? <VegasPanel status={status} /> : null}
      </PushScreen>
    );
  }

  return (
    <>
      <NavBar
        title="Setup"
        subtitle={
          status.readyForDraft
            ? 'Everything needed for draft day is ready'
            : 'Work through anything marked below'
        }
      />

      {error ? <Notice tone="error">{error}</Notice> : null}

      {unlocked ? null : canUnlock ? (
        <UnlockCard onUnlocked={onUnlocked} />
      ) : (
        <Notice>
          This site is view-only: no passphrase has been set up, so settings cannot be changed here.
        </Notice>
      )}

      <AppearanceCard />

      <ListGroup header="Your league">
        {status.steps.map((step) => (
          <Fragment key={step.id}>
            <ListRow
              testId={`setup-step-${step.id}`}
              dataState={step.state}
              state={<StateMark state={step.state} />}
              label={step.title}
              detail={
                <>
                  {step.summary}
                  {step.action ? <div>{step.action}</div> : null}
                </>
              }
              chevron
              onClick={() => setOpen(step.id as Panel)}
            />
            {/*
              The week's one job, where the week's one job is announced.

              Copying an issue for ChatGPT and pasting the tally back used to be
              four taps in — Setup, Newsletter, the issue, Copy — which is a lot
              of navigation for the only thing anybody does with a newsletter.
              So while an issue is waiting, the two controls are drawn directly
              under the row that says it is waiting, and the Newsletter panel
              stays exactly where it is for everything else.

              They are workflow, not furniture: they exist only while there is
              an unscored issue and they are gone the moment it is scored. If
              this ever becomes a permanent pair of buttons on Setup, something
              has gone wrong with the state behind it rather than with the
              layout. Never in the taskbar — §16.
            */}
            {step.id === 'newsletter' && status.newsletter.pendingTally ? (
              <PendingTallyRow
                pending={status.newsletter.pendingTally}
                unlocked={unlocked}
                onDone={(detail) => {
                  setScored(detail);
                  refreshAll();
                }}
              />
            ) : null}
            {step.id === 'newsletter' && scored ? (
              <div className="list-row-actions" data-testid="setup-tally-applied">
                <Notice tone="ok">{scored}</Notice>
              </div>
            ) : null}
          </Fragment>
        ))}
      </ListGroup>

      <ListGroup header="This app">
        <InstallPanel />
        {/*
          Below the five steps, deliberately, and inside this group.

          Settings' first screen belongs to the checklist — `shell.spec.ts`
          measures that every step is reachable without a scroll, on the
          shortest phone this app supports — and a preference is not a step. It
          sits with the other two rows that open in place rather than standing
          alone above them, because a preference nobody is looking for should
          read as one row among the rest until it is asked for.
        */}
        <DraftBalanceCard current={status.draftBalance ?? 'balanced'} unlocked={unlocked} />
        <PlayerDetailPanel status={status} unlocked={unlocked} onDone={refreshAll} />
        <PreseasonProjectionPanel unlocked={unlocked} onDone={refreshAll} />
        {/*
          Review, and how much of it is waiting.

          One row, always present, saying the one thing somebody standing here
          needs to know: whether there is anything to do. The count is in the
          row's own words rather than in a badge beside it, because a row that
          reads "3 items need attention" is already the whole announcement — a
          numeral in a red circle next to it would be the same fact twice, once
          silently. Nothing is drawn at zero beyond the row saying so.

          This is not a Review dashboard and must not become one: what is in the
          queue, and what to do about it, is the screen behind this row.
        */}
        <ListRow
          testId="setup-review"
          dataState={reviewPending > 0 ? 'warn' : 'ok'}
          state={<StateMark state={reviewPending > 0 ? 'warn' : 'ok'} />}
          label="Review"
          detail={
            reviewPending > 0
              ? `${reviewPending} ${reviewPending === 1 ? 'item needs' : 'items need'} attention`
              : 'Nothing waiting for you'
          }
          chevron
          onClick={() => setOpen('review')}
        />
        <HelpMyScores open={false} onOpen={() => setOpen('repair')} onClose={() => setOpen(null)} onChanged={refreshAll} />
        {/*
          Data health, immediately above the support tools it exists beside.

          The pair is the support loop: this row says whether what the app knew
          was healthy and current, and the row under it captures exactly what it
          knew. Somebody diagnosing a questionable recommendation reads them in
          that order, so they are drawn in it. Never in the taskbar — §9.
        */}
        <DataHealthRow onOpen={() => setOpen('data-health')} />
        <SupportSnapshotRow leagues={leagues} />
        {/*
          Writing something down, and the list of what has been written.

          The support loop reads downwards and ends here: whether the data was
          healthy, the state behind one recommendation, and then the plain words
          for everything those two cannot express. Last because it is the only
          part of the loop that holds something from before the reader arrived,
          and because it is the one they will use without a complaint in hand.

          The action is a row on this screen and nowhere else — no per-screen
          trigger, nothing floating over the app, and never in the taskbar (§9,
          §16). Feedback is a thing the owner sits down to write, in the place
          the app keeps its tools, next to the list it goes into.
        */}
        <FeedbackRows onOpen={() => setOpen('flagged')} />
      </ListGroup>

      {/*
        Demo Mode lives here rather than in the toolbar.

        Six destinations is already the most that strip of glass can carry, and
        a seventh spent on a preview tool used once a month would be a poor
        trade. It is last on this screen for the same reason: it is the least
        often wanted thing on it.
      */}
      <Suspense fallback={null}>
        <DemoPanel />
      </Suspense>
    </>
  );
}

/**
 * One row, one action: the state behind a recommendation, in a file.
 *
 * The whole user-facing surface of Support Snapshot, and it is deliberately this
 * small. Somebody who thinks a recommendation is wrong should be able to send
 * the exact state that produced it to whoever can look at it, and that is a tap
 * — not a diagnostics console, not a dashboard, not an upload. Nothing here
 * transmits anything: the snapshot reaches the clipboard or the Files app, and
 * where it goes next is the reader's decision.
 *
 * ## One action, six decisions
 *
 * The app makes six recommendations and this is one button, not six. What it
 * captures is **the decision the reader was last looking at** — recorded by the
 * screens themselves, read here, and stated in words above the action so it can
 * be checked at a glance rather than trusted.
 *
 * `Change` is beside it for the two cases inference cannot cover: Setup opened
 * directly, from a cold start or a shortcut, where there is no last screen and
 * guessing would be worse than asking; and a reader who has moved on since the
 * thing they want to report. It is a control rather than the default because
 * asking everybody to classify their own complaint before making it is the
 * thing this row exists not to do.
 *
 * ## Why it says something different when there is nothing to capture
 *
 * A snapshot of no draft, or of a league that is not loaded, is a file that
 * looks like a bug report and contains nothing — the worst possible outcome,
 * because somebody would send it and wait. So the row says so before it is
 * tapped, and the tap is disabled.
 *
 * ## Copy, or download
 *
 * A real decision's state runs to a couple of hundred kilobytes, which most
 * clipboards take and some refuse — and iOS will refuse `navigator.clipboard`
 * outright outside a secure context. Rather than guess, it tries the clipboard
 * and falls back to a download, and the row says which happened. A reader who
 * has just tapped "copy" and received a file needs to be told, or they will
 * paste nothing into a chat window and conclude the button is broken.
 */
function SupportSnapshotRow({ leagues }: { leagues: LeagueSummary[] }) {
  const [state, setState] = useState<'idle' | 'working' | 'copied' | 'downloaded' | 'failed'>('idle');
  const [detail, setDetail] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  /*
   * Read once, on mount, and then owned here.
   *
   * The value cannot change while this screen is open — the screens that write
   * it are not on screen — so re-reading it would be a subscription to something
   * that never fires. An explicit choice replaces it, which is the only way it
   * moves from here.
   */
  const [chosen, setChosen] = useState<SupportContext | null>(() => readSupportContext());

  const league = leagues.find((l) => l.isSelected) ?? null;
  const draftId = league?.draftId ?? null;

  /** Why this context cannot be captured right now, or null when it can. */
  const blocker = (context: SupportContext | null): string | null => {
    if (context == null) return 'Choose which recommendation looks wrong, and this will capture the state behind it.';
    if (context === 'draft-board') {
      return draftId ? null : 'No draft is loaded, so there is nothing to explain yet.';
    }
    return league ? null : 'No league is loaded, so there is nothing to explain yet.';
  };

  const reason = blocker(chosen);

  const capture = async () => {
    if (chosen == null || reason != null) return;
    setState('working');
    setDetail(null);
    try {
      /*
       * Around the session cache in both directions.
       *
       * `fresh` because a snapshot is a claim about a moment, and answering it
       * from a cache would date the claim by however long the reader had been on
       * another screen. `store: false` because it is a one-shot artifact of a
       * couple of hundred kilobytes: keeping it would take one of the forty-eight
       * slots, and stringify it a second time to do so, for an answer nothing
       * will ever ask for again.
       */
      const path =
        chosen === 'draft-board'
          ? `/api/drafts/${encodeURIComponent(draftId!)}/support-snapshot`
          : `/api/leagues/${encodeURIComponent(league!.id)}/support-snapshot?context=${chosen}`;
      const snapshot = await api.get<{ capturedAt: string }>(path, { fresh: true, store: false });
      const text = JSON.stringify(snapshot, null, 2);
      const size = `${Math.round(text.length / 1024)} KB`;

      try {
        await navigator.clipboard.writeText(text);
        setState('copied');
        setDetail(`${size}. Paste it to your AI assistant and ask why ${CONTEXT_LABELS[chosen]} says what it says.`);
      } catch {
        downloadJson(`junculator-${chosen}-${stamp(snapshot.capturedAt)}.json`, text);
        setState('downloaded');
        /*
         * What happened, not why.
         *
         * A clipboard write is refused for several reasons this code cannot tell
         * apart — an insecure context, a payload the browser thinks is too big,
         * or iOS deciding the write was not close enough to the tap — so naming
         * one of them would be a guess presented as a diagnosis. What the reader
         * needs is that the file exists and where it went.
         */
        setDetail(`${size}. This browser would not take it on the clipboard, so it was saved as a file instead.`);
      }
    } catch (err) {
      setState('failed');
      setDetail(err instanceof Error ? err.message : String(err));
    }
  };

  const detailFor = (): string => {
    if (detail) return detail;
    if (reason) return reason;
    return 'The exact state behind that recommendation, to send to an AI assistant. Nothing is uploaded.';
  };

  return (
    <>
      {/*
        What is about to be captured, said before it is.

        A row that copied "whatever you were last looking at" without naming it
        would be asking the reader to trust an inference they cannot see. This is
        the inference, in the words the app uses for its own screens.
      */}
      <ListRow
        testId="setup-support-context"
        label="Current context"
        detail={
          chosen == null
            ? 'Not known — Setup was opened directly rather than from a recommendation.'
            : `The last recommendation you looked at.`
        }
        value={chosen == null ? 'Choose' : CONTEXT_LABELS[chosen]}
        onClick={() => setPicking((open) => !open)}
        expanded={picking}
      />
      {picking ? (
        <div className="list-row list-row-static">
          <SegmentedControl
            compact
            label="Which recommendation looks wrong"
            testId="support-context-picker"
            segments={CONTEXT_ORDER.map((context) => ({
              id: context,
              label: CONTEXT_LABELS[context],
              testId: `support-context-${context}`,
            }))}
            value={chosen ?? 'lineup'}
            onChange={(context) => {
              setChosen(context);
              /*
               * Remembered, not just used.
               *
               * A reader who corrects the context and then goes to look at the
               * screen again should not have to correct it twice.
               */
              rememberSupportContext(context);
              setPicking(false);
              setState('idle');
              setDetail(null);
            }}
          />
        </div>
      ) : null}
      <ListRow
        testId="setup-support-snapshot"
        dataState={state}
        state={<StateMark state={state === 'failed' ? 'warn' : reason == null ? 'ok' : 'todo'} />}
        label="Copy support snapshot"
        detail={detailFor()}
        value={
          state === 'working' ? 'Copying…' : state === 'copied' ? 'Copied' : state === 'downloaded' ? 'Saved' : undefined
        }
        {...(reason == null ? { onClick: () => void capture() } : {})}
      />
    </>
  );
}

/**
 * `2026-08-31T00:51:00.000Z` → `20260831-005100`.
 *
 * Sortable, filename-safe on every platform, and readable at a glance — which
 * matters because somebody may be sitting on three of these while working out
 * which draft they were complaining about. The instant is the snapshot's own
 * `capturedAt`, not the moment of the download, so the file names the board
 * rather than the tap.
 */
function stamp(capturedAt: string): string {
  const [date = '', time = ''] = capturedAt.slice(0, 19).split('T');
  return `${date.replace(/-/g, '')}-${time.replace(/:/g, '')}`;
}

/**
 * Hand the reader a file, without a server round trip to fetch it back.
 *
 * A blob URL and a synthetic click: the only way a browser saves something it
 * already has in memory. Revoked on the next frame rather than immediately,
 * because Safari has not finished reading the URL when `click()` returns.
 */
function downloadJson(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Appearance: System, Light or Dark.
 *
 * A preference of this phone rather than of the account, so it is kept on the
 * device: it works for a view-only reader, needs no passphrase, and costs no
 * request. Choosing one applies immediately — no reload, and nothing else on
 * screen changes state.
 */
function AppearanceCard() {
  const [mode, setMode] = useState<Appearance>(() => readAppearance());

  useEffect(() => {
    applyAppearance(mode);
    // While System is selected the stylesheet follows the phone on its own;
    // this only keeps the Safari toolbar tint in step when iOS flips.
    return watchSystemAppearance(() => applyAppearance(mode));
  }, [mode]);

  return (
    <div data-testid="appearance">
      <div className="section-title">Appearance</div>
      {/*
        The same control the board filters use, rather than a second opinion
        about what a segmented control looks like. It was drawn by hand here,
        which is how one of the two ended up 42px tall and the other 44.
      */}
      <SegmentedControl
        label="Appearance"
        value={mode}
        onChange={(option) => {
          storeAppearance(option);
          setMode(option);
        }}
        segments={APPEARANCES.map((option) => ({
          id: option,
          label: APPEARANCE_LABELS[option],
          testId: `appearance-${option}`,
        }))}
      />
      <div className="faint" style={{ margin: '-2px 4px 14px' }}>
        System follows your phone, and keeps following it when your phone changes at sunset. Light and
        Dark stay exactly as you set them here, on this phone.
      </div>
    </div>
  );
}

/* ------------------------------------------- market vs the owner's own reads */

/**
 * What each position of the control is called, in the reader's words.
 *
 * The stored values are `market` … `personal`; nothing on screen says either.
 */
const BALANCE_LABELS: Record<SignalBalance, string> = {
  market: 'Market first',
  'lean-market': 'Leaning market',
  balanced: 'Balanced',
  'lean-personal': 'Leaning my research',
  personal: 'My research first',
};

/** What each position actually does to the board, in one sentence. */
const BALANCE_NOTES: Record<SignalBalance, string> = {
  market:
    'Your ♥, your AVOIDs and the newsletter tally count half as much as usual. They can still separate two ' +
    'players the market rates alike; they cannot move anybody far.',
  'lean-market': 'Your own research counts three-quarters of what it usually does.',
  balanced:
    'How this board has always ranked: the market prices a player and your own research argues with the price. ' +
    'Leave it here unless you have a reason not to.',
  'lean-personal': 'Your own research counts a quarter more than it usually does.',
  personal:
    'Your own research counts half again as much as usual — ♥♥♥ is worth about fifteen picks of draft position ' +
    'rather than ten. The market still sets the price it is arguing with.',
};

/**
 * How loudly your own research argues with the draft market.
 *
 * The one thing this control must not do is change anything by existing.
 * `Balanced` is the position every account starts in and it hands the ranking
 * the same weight table it has always used, so a board built here is the board
 * built before this shipped — see `core/draft/signalBalance.ts`, which returns
 * the default table by identity rather than by arithmetic.
 *
 * A slider rather than a row of chips because five named positions in a row do
 * not fit a 360px phone, and because the thing being set is genuinely a
 * quantity with a middle. The numbers behind it are never shown: "half again as
 * much" is the truthful description a person can act on, and `1.25` is a
 * number that invites a precision this model does not have.
 *
 * Saved against the account rather than this phone — unlike Appearance — because
 * the board it changes is built on the server. It is a write, so it is behind
 * the passphrase like every other write in here.
 */
function DraftBalanceCard({ current, unlocked }: { current: SignalBalance; unlocked: boolean }) {
  const [balance, setBalance] = useState<SignalBalance>(current);
  const [error, setError] = useState<string | null>(null);
  /** The position the server last confirmed, to fall back to when a save fails. */
  const saved = useRef<SignalBalance>(current);
  /**
   * Which write is the current one.
   *
   * A drag across the control fires a change per position it crosses, so
   * several writes can be in the air at once and they need not come back in
   * order. The last one asked for is the one the reader chose, and an older
   * reply may not be allowed to overwrite it — on screen or in this ref.
   */
  const latest = useRef(0);

  // A re-read of the status wins: it is what the server actually has.
  useEffect(() => {
    setBalance(current);
    saved.current = current;
  }, [current]);

  /*
   * Saved on the change itself, rather than a moment after the thumb settles.
   *
   * A debounce would be fewer writes and one real defect: leaving Settings
   * inside the delay unmounts this and takes the pending save with it, so the
   * reader would have moved a control that silently did not move. Five
   * positions means a drag across the whole range is at most four writes of one
   * short word, which is a cheaper thing to spend than a lost setting.
   */
  const choose = (next: SignalBalance) => {
    setBalance(next);
    const ticket = ++latest.current;
    void (async () => {
      try {
        const result = await api.post<{ balance: SignalBalance }>('/api/setup/draft-balance', { balance: next });
        if (ticket !== latest.current) return;
        saved.current = result.balance;
        setBalance(result.balance);
        setError(null);
      } catch (err) {
        if (ticket !== latest.current) return;
        // Back to what the server holds: a control showing a position that was
        // not saved is worse than one that visibly did not move.
        setBalance(saved.current);
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  };

  const index = Math.max(0, SIGNAL_BALANCE_ORDER.indexOf(balance));
  const position = `${BALANCE_LABELS[balance]}${balance === 'balanced' ? ' (default)' : ''}`;

  return (
    <details className="list-details" data-testid="draft-balance">
      {/*
        The row says where the control is pointing, so opening it is a choice.

        Closed, this is one line: the name of the setting and the position it is
        in. That is the whole of what somebody scrolling Settings needs from it,
        and the slider, the two ends and the sentence explaining them are three
        more things to read for a control most readers will never move. The same
        disclosure the two panels below it use, and the same one Demo Mode uses
        at the foot of this screen — a `<details>`, so the open state needs no
        React state of its own and the keyboard and screen reader get it free.
      */}
      <summary data-testid="draft-balance-summary">
        Draft board weighting
        <span className="faint" style={{ marginLeft: 'auto' }} data-testid="draft-balance-label">
          {position}
        </span>
      </summary>
      <div className="list-details-body" data-testid="draft-balance-body">
        <input
          className="slider"
          type="range"
          min={0}
          max={SIGNAL_BALANCE_ORDER.length - 1}
          step={1}
          value={index}
          disabled={!unlocked}
          aria-label="How much your own research counts against the draft market"
          aria-valuetext={position}
          data-testid="draft-balance-slider"
          onChange={(e) => choose(SIGNAL_BALANCE_ORDER[Number(e.target.value)] ?? 'balanced')}
        />
        <div className="slider-ends">
          <span>Market consensus</span>
          <span>My own research</span>
        </div>
        <div className="faint" style={{ marginTop: 10 }}>
          {BALANCE_NOTES[balance]}
          {unlocked ? null : ' Unlock with your passphrase to change this.'}
        </div>
        {error ? <Notice tone="error">{error}</Notice> : null}
      </div>
    </details>
  );
}

/**
 * Preseason market projection: paste, preview, apply.
 *
 * The last mile of a path that was otherwise complete — parser, identity
 * ladder, scoring-profile identity and storage all existed and none of them
 * could be reached from a phone.
 *
 * Deliberately not filed under Vegas lines, and deliberately named for what it
 * is. A StartWho number is a season points estimate somebody derived *from*
 * betting markets under a stated set of rules; it is not a line a book is
 * taking bets on. Putting the two behind one heading would make them look
 * interchangeable in the one place a reader goes to find out whether they are.
 *
 * One row, one sheet, no data-engineering screen: what is loaded, a box to
 * paste into, the counts before anything is written, and Apply.
 */
function PreseasonProjectionPanel({ unlocked, onDone }: { unlocked: boolean; onDone: () => void }) {
  const [status, setStatus] = useState<ProjectionStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [pasted, setPasted] = useState('');
  /*
   * The fallback capture date.
   *
   * StartWho prints a "Last updated" line on the page but not always into the
   * clipboard, and a snapshot with no date has no identity — it is what makes
   * re-importing a correction replace the old capture instead of stacking
   * beside it. So the paste's own date wins whenever it carries one, and this
   * only fills the gap when it does not.
   *
   * Defaulted rather than demanded: a projection copied today was captured
   * today, and making somebody type that is a worse answer than assuming it and
   * saying so, which the preview does.
   */
  const [capturedAt, setCapturedAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [preview, setPreview] = useState<ProjectionImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api.get<ProjectionStatus>('/api/preseason-projection'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (what: 'preview' | 'apply') => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<ProjectionImportResult>(`/api/preseason-projection/${what}`, {
        content: pasted,
        capturedAt,
      });
      if (what === 'preview') {
        setPreview(result);
      } else {
        setDone(`${result.label} imported — ${result.counts.matched} of ${result.counts.parsed} players matched.`);
        setPreview(null);
        setPasted('');
        setOpen(false);
        await load();
        onDone();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const forget = async (id: number) => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/preseason-projection/remove', { id });
      await load();
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const current = status?.current ?? null;

  return (
    <details className="list-details" data-testid="panel-preseason-projection">
      <summary>Preseason market projection</summary>
      <div className="list-details-body">
        {done ? <Notice tone="ok">{done}</Notice> : null}
        {error ? <Notice tone="error">{error}</Notice> : null}

        <div className="faint" data-testid="projection-status">
          {current ? (
            <>
              <strong>{current.label}</strong> — {current.players} players from {current.rows} rows, captured{' '}
              {formatDate(current.capturedAt)} under {current.scoringLabel}.
              {current.unresolved > 0
                ? ` ${current.unresolved} name${current.unresolved === 1 ? '' : 's'} could not be matched and ${
                    current.unresolved === 1 ? 'is' : 'are'
                  } waiting in Review.`
                : ''}
            </>
          ) : status?.scoringLabel ? (
            <>
              Nothing imported for {status.scoringLabel}. The Draft board shows <code>PTS —</code> until a snapshot
              is pasted here, rather than a number it would have to invent.
            </>
          ) : (
            <>Choose your league first — a projection only means anything under the scoring it was captured for.</>
          )}
        </div>

        {/*
          Captures on file under other rules.

          Kept rather than discarded, and said out loud rather than hidden: a
          snapshot imported against the wrong profile is inert, and an invisible
          inert snapshot looks exactly like an import that failed.
        */}
        {(status?.others.length ?? 0) > 0 ? (
          <div className="faint" style={{ marginTop: 6 }} data-testid="projection-others">
            Also on file, under other scoring and so not used: {status!.others.map((s) => s.label).join(', ')}.
          </div>
        ) : null}

        {unlocked ? (
          <>
            <div className="btn-row" style={{ marginTop: 8 }}>
              <button
                className="btn btn-sm"
                type="button"
                onClick={() => setOpen(true)}
                data-testid="open-projection-paste"
                disabled={!status?.scoringKey}
              >
                {current ? 'Replace snapshot' : 'Paste snapshot'}
              </button>
              {current ? (
                <button
                  className="btn btn-sm"
                  type="button"
                  disabled={busy}
                  onClick={() => void forget(current.id)}
                  data-testid="forget-projection"
                >
                  Forget it
                </button>
              ) : null}
            </div>
            <div className="faint" style={{ marginTop: 4 }}>
              Copy the whole StartWho table and paste it below. Nothing is fetched or scraped; this is the only way
              a projection gets in.
            </div>
          </>
        ) : null}

        {open ? (
          <Sheet
            title="Paste preseason projection"
            onClose={() => setOpen(false)}
            testId="projection-paste-sheet"
          >
            <textarea
              style={{ display: 'block', minHeight: 76, maxHeight: '28vh' }}
              rows={4}
              value={pasted}
              placeholder={'▸ Josh Allen\nQB1 · Buffalo Bills\n386.1'}
              onChange={(e) => {
                setPasted(e.target.value);
                // A stale preview beside edited text is worse than none.
                setPreview(null);
              }}
              data-testid="projection-paste-input"
            />
            {/*
              Only consulted when the paste carries no date of its own, which
              the preview then says out loud rather than letting an assumed date
              read as a captured one.
            */}
            <label className="faint" style={{ display: 'block', marginTop: 8 }}>
              Captured
              <input
                type="date"
                value={capturedAt}
                onChange={(e) => {
                  setCapturedAt(e.target.value);
                  setPreview(null);
                }}
                style={{ marginLeft: 8 }}
                data-testid="projection-captured-at"
              />
              <div>Used only if the paste carries no date of its own.</div>
            </label>
            <div className="btn-row" style={{ marginTop: 8 }}>
              <button
                className="btn btn-sm"
                type="button"
                onClick={() => void run('preview')}
                disabled={busy || !pasted.trim()}
                data-testid="projection-preview"
              >
                {busy ? 'Reading…' : 'Preview'}
              </button>
            </div>

            {preview ? (
              <div className="explain" style={{ marginTop: 8 }} data-testid="projection-preview-panel">
                <div className="muted">
                  {preview.source} · captured {formatDate(preview.capturedAt)}
                  {preview.capturedFrom === 'declared' ? ' (no date in the paste — today assumed)' : ''} ·{' '}
                  {preview.scoringLabel}
                </div>

                {/*
                  The whole count, not just the good half. "218 matched" cannot
                  answer "is this the right table"; "218 of 224" can.
                */}
                <div className="faint" style={{ marginTop: 6 }} data-testid="projection-counts">
                  {preview.counts.parsed} rows parsed · {preview.counts.matched} matched ·{' '}
                  {preview.counts.ambiguous + preview.counts.unmatched} unresolved · {preview.counts.rejected}{' '}
                  rejected
                </div>

                {preview.scoringKey !== status?.scoringKey ? (
                  <Notice tone="error">
                    This was captured under {preview.scoringLabel}, which is not your league&rsquo;s scoring. It can
                    be stored, but the board will not read it.
                  </Notice>
                ) : null}

                {preview.warnings.map((w) => (
                  <Notice key={w}>{w}</Notice>
                ))}

                {preview.replaces ? (
                  <div className="faint" style={{ marginTop: 6 }}>
                    Replaces {preview.replaces.label}, which was imported {formatAge(preview.replaces.importedAt)}.
                  </div>
                ) : null}

                {preview.sample.length > 0 ? (
                  <>
                    <div className="section-title">Reads as</div>
                    <ul style={{ paddingLeft: 16, margin: 0 }} data-testid="projection-sample">
                      {preview.sample.map((s) => (
                        <li key={s.name}>
                          {s.name} {s.position ? `(${s.position})` : ''} — {s.points}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}

                {preview.needsReview.length > 0 ? (
                  <div className="faint" style={{ marginTop: 6 }} data-testid="projection-unresolved">
                    {preview.needsReview.length} name{preview.needsReview.length === 1 ? '' : 's'} could not be
                    matched — {preview.needsReview.slice(0, 4).map((r) => r.name).join(', ')}
                    {preview.needsReview.length > 4 ? ' and others' : ''}. Applying files{' '}
                    {preview.needsReview.length === 1 ? 'it' : 'them'} in Review; the rest import regardless.
                  </div>
                ) : null}

                <div className="btn-row" style={{ marginTop: 8 }}>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => void run('apply')}
                    disabled={busy || preview.counts.matched === 0}
                    data-testid="projection-apply"
                  >
                    {busy ? 'Importing…' : 'Apply'}
                  </button>
                </div>
              </div>
            ) : null}
          </Sheet>
        ) : null}
      </div>
    </details>
  );
}

/**
 * Help My Scores.
 *
 * Names the matcher would not guess at, and what they are costing. Deliberately
 * placed at the bottom of Setup and self-hiding when there is nothing to fix:
 * it should be impossible to miss when it matters and invisible when it does
 * not.
 */
function HelpMyScores({
  open,
  onOpen,
  onClose,
  onChanged,
}: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [status, setStatus] = useState<RepairStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api.get<RepairStatus>('/api/repair'));
    } catch {
      // Nothing to show is the same as nothing to fix, as far as this card goes.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const assign = async (alias: string, playerId: string) => {
    const result = await api.post<{ alias: string; resolved: number; net: number }>('/api/repair/assign', {
      alias,
      playerId,
    });
    setMessage(
      `${result.alias} matched — ${result.resolved} ${result.resolved === 1 ? 'item' : 'items'} now count, ` +
        `lifetime tally ${result.net > 0 ? '+' : ''}${result.net}.`,
    );
    await load();
    onChanged();
  };

  // Nothing to fix is the common case, and it says so by not being here at all.
  if (!open && (!status || status.summary.names === 0)) return null;

  if (!open) {
    return (
      <ListRow
        testId="help-my-scores"
        state={<StateMark state="warn" />}
        label="Help my scores"
        detail={status!.summary.headline}
        chevron
        onClick={onOpen}
      />
    );
  }

  return (
    <PushScreen title="Help my scores" backLabel="Setup" onBack={onClose} testId="setup-detail-repair">
      {message ? <Notice tone="ok">{message}</Notice> : null}
      <div className="faint" style={{ margin: '0 4px 10px' }}>
        These names appeared in your newsletters but could not be matched to a Sleeper player, so their news is
        not counting for anyone. Pick who each one is.
      </div>

      {!status ? (
        <Loading what="the names that need matching" />
      ) : status.summary.names === 0 ? (
        <Empty>Every name in your newsletters is matched to a player.</Empty>
      ) : (
        status.groups.map((group) => (
          <div key={group.normalizedAlias} className="card" data-testid={`repair-${group.normalizedAlias}`}>
            <div className="header-row">
              <strong>{group.alias}</strong>
              <span className="faint">
                {group.items} {group.items === 1 ? 'item' : 'items'} ·{' '}
                {group.net > 0 ? '+' : ''}
                {group.net} net
                {group.net30 !== 0 ? ` (${group.net30 > 0 ? '+' : ''}${group.net30} in 30d)` : ''}
              </span>
            </div>
            <div className="faint" style={{ margin: '4px 0 8px' }}>
              “{group.example}”
            </div>

            {status.suspicions.some((sus) => sus.alias === group.alias) ? (
              <Notice>
                Likely {status.suspicions.find((sus) => sus.alias === group.alias)!.candidate.name}, who currently
                has no tally at all.
              </Notice>
            ) : null}

            <div className="btn-row">
              {group.candidates.slice(0, 3).map((candidate) => (
                <button
                  key={candidate.playerId}
                  className="btn btn-sm"
                  onClick={() => void assign(group.alias, candidate.playerId)}
                >
                  {candidate.name} · {candidate.position} {candidate.team}
                </button>
              ))}
            </div>

            <PlayerPicker
              fieldId={`repair-${group.normalizedAlias}`}
              label="Or search for the right player"
              onPick={(playerId) => assign(group.alias, playerId)}
            />
          </div>
        ))
      )}
    </PushScreen>
  );
}

/** Shared busy/message handling for the panels. */
function usePanelAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const run = async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    setMessage(null);
    try {
      setMessage({ tone: 'ok', text: await fn() });
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const banner = message ? (
    <Notice tone={message.tone === 'ok' ? 'ok' : 'error'}>{message.text}</Notice>
  ) : null;

  return { busy, run, banner };
}

function SleeperPanel({ status, onDone }: { status: SetupStatus; onDone: () => void }) {
  const { busy, run, banner } = usePanelAction();
  const [username, setUsername] = useState(status.sleeper.username ?? '');
  const [season, setSeason] = useState(String(new Date().getFullYear()));

  return (
    <div className="card" data-testid="panel-sleeper">
      <div className="faint" style={{ marginBottom: 8 }}>
        Fantasy Analyst reads your league from Sleeper. It never makes picks or changes your lineup.
      </div>
      {banner}

      <div className="field">
        <label htmlFor="setup-username">Your Sleeper username</label>
        <input
          id="setup-username"
          value={username}
          autoCapitalize="none"
          autoCorrect="off"
          onChange={(e) => setUsername(e.target.value)}
          placeholder="e.g. alexfootball"
        />
      </div>
      <div className="field">
        <label htmlFor="setup-season">Season</label>
        <input id="setup-season" value={season} inputMode="numeric" onChange={(e) => setSeason(e.target.value)} />
      </div>

      <div className="btn-row">
        <button
          className="btn btn-primary"
          disabled={!username || busy != null}
          onClick={() =>
            run('connect', async () => {
              const res = await api.post<{ leaguesImported: number }>('/api/sleeper/connect', { username, season });
              onDone();
              return res.leaguesImported > 0
                ? `Connected. Found ${res.leaguesImported} league${res.leaguesImported === 1 ? '' : 's'} for ${season}.`
                : `Connected, but no leagues were found for ${season}. Try a different season.`;
            })
          }
        >
          {status.sleeper.connected ? 'Reconnect' : 'Connect'}
        </button>
        <button
          className="btn"
          disabled={busy != null}
          onClick={() =>
            run('players', async () => {
              const res = await api.post<{ total: number }>('/api/sleeper/sync-players');
              onDone();
              return `Player list updated — ${res.total} players available.`;
            })
          }
        >
          {busy === 'players' ? 'Updating…' : 'Update player list'}
        </button>
      </div>
      <div className="faint" style={{ marginTop: 6 }}>
        The player list is how Fantasy Analyst recognises names in your newsletter. Update it once
        before your draft, and occasionally during the season.
        {status.sleeper.playersSynced > 0 ? ` Currently ${status.sleeper.playersSynced} players.` : ''}
      </div>
    </div>
  );
}

function LeaguePanel({ leagues, onDone }: { leagues: LeagueSummary[]; onDone: () => void }) {
  const { busy, run, banner } = usePanelAction();

  return (
    <div className="card" data-testid="panel-league">
      {banner}
      {leagues.length === 0 ? (
        <Empty>Connect Sleeper first, then your leagues appear here.</Empty>
      ) : (
        leagues.map((l) => (
          <div className="card card-tight" key={l.id} data-testid="setup-league-card">
            <div className="header-row">
              <div>
                <strong>{l.name}</strong>
                <div className="faint">
                  {l.season} · {l.teams} teams · {l.scoringLabel}
                </div>
              </div>
              <button
                className={l.isSelected ? 'btn btn-sm' : 'btn btn-sm btn-primary'}
                disabled={l.isSelected || busy != null}
                onClick={() =>
                  run(`select-${l.id}`, async () => {
                    await api.post(`/api/leagues/${l.id}/select`);
                    onDone();
                    return `Using ${l.name}.`;
                  })
                }
              >
                {l.isSelected ? '✓ In use' : 'Use this'}
              </button>
            </div>
            {/*
              Which teams this room drafts early — asked only of the league
              actually in use, because it is a question about the people in it
              and nobody wants to answer it four times.
            */}
            {l.isSelected ? <LocalTeamsField league={l} busy={busy != null} run={run} onDone={onDone} /> : null}
          </div>
        ))
      )}
    </div>
  );
}

/**
 * The teams this room takes ahead of the market.
 *
 * A Detroit-area league drafts Lions early. That is a fact about twelve people
 * rather than about the Lions, and it has exactly one consequence in this app:
 * `Next%` — the chance a player is still there when you pick again — drops for
 * those players, because the model now expects somebody else to take them. It
 * does not make them better, and the copy says so, because a control that
 * silently improved a team's players would be the single most misread setting
 * on this screen.
 *
 * Sleeper does not publish this and never will, so it is typed. Codes are
 * validated against the real team list on the server: an unknown code would
 * sit here looking effective and match nobody.
 *
 * The prior itself is a starting assumption, not a conclusion. As soon as the
 * draft has enough of this room's own picks to measure, the measurement takes
 * over and the assumption fades out entirely — see teamPrior.ts.
 */
function LocalTeamsField({
  league,
  busy,
  run,
  onDone,
}: {
  league: LeagueSummary;
  busy: boolean;
  run: (key: string, fn: () => Promise<string>) => Promise<void>;
  onDone: () => void;
}) {
  const stored = (league.localTeams ?? []).join(', ');
  const [value, setValue] = useState(stored);
  const dirty = value.trim().toUpperCase() !== stored;

  return (
    <div className="local-teams" data-testid="local-teams">
      <label className="field-label" htmlFor={`local-teams-${league.id}`}>
        Teams this room drafts early
      </label>
      <div className="field-row">
        <input
          id={`local-teams-${league.id}`}
          value={value}
          placeholder="DET"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          data-testid="local-teams-input"
        />
        <button
          className="btn btn-sm btn-primary"
          disabled={busy || !dirty}
          data-testid="local-teams-save"
          onClick={() =>
            run(`local-teams-${league.id}`, async () => {
              const teams = value
                .split(',')
                .map((t) => t.trim().toUpperCase())
                .filter(Boolean);
              const res = await api.post<{ localTeams: string[] }>(`/api/leagues/${league.id}/local-teams`, {
                teams,
              });
              onDone();
              return res.localTeams.length === 0
                ? 'No local-team prior for this league.'
                : `Next% now expects this room to reach for ${res.localTeams.join(', ')}.`;
            })
          }
        >
          Save
        </button>
      </div>
      <div className="faint">
        Comma-separated NFL codes. This lowers <strong>Next%</strong> for those players — the room is likelier to
        take them — and changes nothing about Score, Val or tiers.
      </div>
    </div>
  );
}

function AdpPanel({ status, onDone }: { status: SetupStatus; onDone: () => void }) {
  const { busy, run, banner } = usePanelAction();
  const [content, setContent] = useState('');
  const [label, setLabel] = useState('');
  const [result, setResult] = useState<{
    created: boolean;
    matched: number;
    ambiguous: number;
    unmatched: number;
    skipped: { rowNumber: number; reason: string }[];
  } | null>(null);

  const importNow = () =>
    run('adp', async () => {
      const res = await api.post<{
        created: boolean;
        matched: number;
        ambiguous: number;
        unmatched: number;
        skipped: { rowNumber: number; reason: string }[];
      }>('/api/adp/import', { content, label: label || undefined });
      setResult(res);
      setContent('');
      onDone();
      return res.created
        ? `Imported ${res.matched} players.`
        : 'That exact file was already imported, so nothing changed.';
    });

  return (
    <div className="card" data-testid="panel-adp">
      <div className="card card-tight" data-testid="adp-source">
        <strong>{status.adp.imported ? `Using ${status.adp.label}` : 'No rankings imported yet'}</strong>
        <div className="faint">
          Sleeper does not publish average draft position, so the draft order has to come from a
          rankings file you import here.
        </div>
        <div className="faint" style={{ marginTop: 4 }}>
          Without one, the draft board still ranks by news and roster need — it just cannot tell you
          whether a player is likely to last until your next pick.
        </div>
      </div>
      {banner}

      {status.adp.imported ? (
        <div className="card card-tight">
          <strong>In use: {status.adp.label}</strong>
          <div className="faint">
            Captured {formatDate(status.adp.capturedAt)} · {status.adp.matched} of {status.adp.totalRows} players
            matched
            {status.adp.unresolved > 0 ? ` · ${status.adp.unresolved} not recognised` : ''}
          </div>
        </div>
      ) : null}

      <details style={{ marginTop: 10 }} open={!status.adp.imported}>
        <summary className="muted">Import rankings</summary>
        <div className="faint" style={{ margin: '6px 0' }}>
          A CSV with player names and a rank or ADP column. The newest import is the one used.
        </div>

      <div className="field">
        <label htmlFor="adp-file">Choose a file</label>
        <input
          id="adp-file"
          type="file"
          accept=".csv,.json,text/csv,application/json,text/plain"
          data-testid="adp-file"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setContent(await file.text());
            if (!label) setLabel(file.name.replace(/\.[a-z]+$/i, ''));
          }}
        />
      </div>

      <div className="field">
        <label htmlFor="adp-label">Name this snapshot (optional)</label>
        <input id="adp-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="My rankings — today" />
      </div>

      <div className="field">
        <label htmlFor="adp-content">…or paste the file contents</label>
        <textarea
          id="adp-content"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={"name,position,team,adp\nJa'Marr Chase,WR,CIN,1.4"}
        />
      </div>

      <button className="btn btn-primary" disabled={!content || busy != null} onClick={importNow}>
        {busy === 'adp' ? 'Importing…' : status.adp.imported ? 'Replace rankings' : 'Import rankings'}
      </button>

      {result ? (
        <div className="card card-tight" data-testid="adp-result" style={{ marginTop: 8 }}>
          <table className="compact">
            <tbody>
              <tr>
                <td>Matched to a player</td>
                <td>{result.matched}</td>
              </tr>
              <tr>
                <td>Needs a decision (more than one match)</td>
                <td>{result.ambiguous}</td>
              </tr>
              <tr>
                <td>Not recognised</td>
                <td>{result.unmatched}</td>
              </tr>
              <tr>
                <td>Rows skipped</td>
                <td>{result.skipped.length}</td>
              </tr>
            </tbody>
          </table>
          {result.skipped.length > 0 ? (
            <div className="faint" style={{ marginTop: 6 }}>
              Skipped rows: {result.skipped.slice(0, 5).map((s) => `row ${s.rowNumber} (${s.reason})`).join(', ')}
              {result.skipped.length > 5 ? '…' : ''}
            </div>
          ) : null}
          <div className="faint" style={{ marginTop: 6 }}>
            Unrecognised players are kept, not thrown away — they simply have no ranking until you
            match them.
          </div>
        </div>
      ) : null}
      </details>
    </div>
  );
}

function NewsletterPanel({ onDone }: { onDone: () => void }) {
  const { busy, run, banner } = usePanelAction();
  const [status, setStatus] = useState<NewsletterStatus | null>(null);
  const [sender, setSender] = useState('');
  /** True when the saved rule is the wildcard rather than a specific sender. */
  const acceptsAll = (status?.expectedSenders ?? []).includes('*');
  const [subject, setSubject] = useState('');
  const [address, setAddress] = useState('');
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const next = await api.get<NewsletterStatus>('/api/setup/newsletter');
    setStatus(next);
    setSender(next.expectedSenders.find((s) => s !== '*' && !s.includes('example')) ?? '');
    setSubject(next.subjectFilters[0] ?? '');
    setAddress(next.address ?? '');
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!status) return <Loading what="newsletter status" />;

  const copy = async () => {
    if (!status.address) return;
    try {
      await navigator.clipboard.writeText(status.address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="card" data-testid="panel-newsletter">
      {banner}

      {/* --- the address ------------------------------------------------ */}
      {status.addressConfigured ? (
        <div className="card card-tight">
          <div className="faint">Your Fantasy Analyst email address</div>
          <div className="address" style={{ fontSize: '1rem', fontWeight: 650 }} data-testid="newsletter-address">
            {status.address}
          </div>
          <div className="btn-row" style={{ marginTop: 6 }}>
            <button className="btn btn-sm" onClick={() => void copy()}>
              {copied ? '✓ Copied' : 'Copy address'}
            </button>
          </div>
          <div className="faint" style={{ marginTop: 6 }}>
            Subscribe your FF Newsletter to this address. Every future issue is read automatically —
            you never need to forward anything.
          </div>
        </div>
      ) : (
        <Notice>
          <strong>Email address not ready yet.</strong>
          <div style={{ marginTop: 4 }}>
            This needs a one-time email setup on your domain (about 10 minutes, done once). The
            written steps are in the project's SETUP guide under “Turn on the newsletter address”.
            Once it is done, the address appears here.
          </div>
        </Notice>
      )}

      {/* --- which sender to trust -------------------------------------- */}
      <div className="section-title">Which newsletter to accept</div>
      <div className="faint" style={{ marginBottom: 6 }}>
        Only mail from this sender is read. Anything else that arrives is ignored and never affects
        your players.
      </div>
      {/* Subscribing is easier than looking up a sender address: the first
          issue arrives, is ignored because no sender is expected yet, and its
          real address is right there to accept in one tap. */}
      {ignoredSender(status) ? (
        <div className="card card-tight" data-testid="offer-sender">
          <div>
            Mail arrived from <strong className="address">{ignoredSender(status)}</strong> and was ignored,
            because you have not said it is expected.
          </div>
          <button
            className="btn btn-primary btn-sm"
            style={{ marginTop: 6 }}
            disabled={busy != null}
            data-testid="accept-sender"
            onClick={() =>
              run('accept-sender', async () => {
                const from = ignoredSender(status)!;
                const next = await api.post<NewsletterStatus>('/api/setup/newsletter', { senderEmail: from });
                setStatus(next);
                setSender(from);
                onDone();
                return `Saved. Mail from ${from} will be read from now on.`;
              })
            }
          >
            Accept mail from this sender
          </button>
          <div className="faint" style={{ marginTop: 4 }}>
            Only do this if you recognise it as your newsletter. The issue that was ignored is not
            read retrospectively; the next one will be.
          </div>
        </div>
      ) : null}

      {/*
        Offered first, and recommended: this address is dedicated and
        unpublished, so taking whatever arrives is both true and safer than a
        filter that can drop a week of evidence without saying anything.
      */}
      <div className="faint" style={{ marginBottom: 6 }}>
        Nothing else uses this address, so anything arriving here is your newsletter. A sender filter can miss
        issues silently — Substack sends from a different address for every subscriber.
      </div>
      <button
        className="btn btn-primary"
        style={{ marginBottom: 12 }}
        disabled={busy != null || acceptsAll}
        data-testid="accept-any-sender"
        onClick={() =>
          run('sender', async () => {
            const next = await api.post<NewsletterStatus>('/api/setup/newsletter', { senderEmail: '*' });
            setStatus(next);
            onDone();
            return 'Every email sent to this address will now be read.';
          })
        }
      >
        {acceptsAll ? 'Accepting every sender' : 'Accept every email sent here'}
      </button>

      <div className="field">
        <label htmlFor="nl-sender">Or only accept one sender (address or domain)</label>
        <input
          id="nl-sender"
          value={sender}
          autoCapitalize="none"
          autoCorrect="off"
          inputMode="email"
          onChange={(e) => setSender(e.target.value)}
          placeholder="e.g. newsletter@theirsite.com"
        />
      </div>
      <div className="field">
        <label htmlFor="nl-subject">Only if the subject contains (optional)</label>
        <input id="nl-subject" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="leave blank to accept every issue" />
      </div>
      <button
        className="btn btn-primary"
        disabled={!sender || busy != null}
        onClick={() =>
          run('sender', async () => {
            const next = await api.post<NewsletterStatus>('/api/setup/newsletter', {
              senderEmail: sender,
              subjectContains: subject,
            });
            setStatus(next);
            onDone();
            return 'Saved. Mail from that sender will now be read.';
          })
        }
      >
        Save sender
      </button>

      {/* --- manual address override ------------------------------------ */}
      <details style={{ marginTop: 10 }}>
        <summary className="muted">Set the address manually</summary>
        <div className="faint" style={{ margin: '6px 0' }}>
          Only needed if you finished the email setup with a different address than the one shown.
        </div>
        <div className="field">
          <label htmlFor="nl-address">Fantasy Analyst email address</label>
          <input
            id="nl-address"
            value={address}
            autoCapitalize="none"
            autoCorrect="off"
            inputMode="email"
            onChange={(e) => setAddress(e.target.value)}
            placeholder="fantasy-news@yourdomain.com"
          />
        </div>
        <button
          className="btn btn-sm"
          disabled={busy != null}
          onClick={() =>
            run('address', async () => {
              const next = await api.post<NewsletterStatus>('/api/setup/newsletter', { inboundAddress: address });
              setStatus(next);
              onDone();
              return address ? `Address set to ${address}.` : 'Address cleared.';
            })
          }
        >
          Save address
        </button>
      </details>

      {/* --- activity ---------------------------------------------------- */}
      <div className="section-title">Activity</div>
      <table className="compact" data-testid="newsletter-activity">
        <tbody>
          <tr>
            <td>Last email received</td>
            <td>
              {status.lastReceivedAt ? (
                <>
                  {formatAge(status.lastReceivedAt)}
                  <div className="faint address">
                    {status.lastReceivedFrom} · {status.lastReceivedStatus}
                  </div>
                </>
              ) : (
                'nothing yet'
              )}
            </td>
          </tr>
          <tr>
            <td>Last newsletter received</td>
            <td>{status.lastProcessedAt ? formatAge(status.lastProcessedAt) : 'none yet'}</td>
          </tr>
          {/*
            The one row that is work rather than history.

            Drawn only when there is some, so the table does not spend a line
            saying nothing is waiting — the Newsletter row on Setup already says
            that, in the place somebody is standing when they need to know.
          */}
          {status.pendingTally ? (
            <tr>
              <td>Waiting to be scored</td>
              <td data-testid="newsletter-waiting-count">{status.pendingTally.waiting}</td>
            </tr>
          ) : null}
          <tr>
            <td>News items found</td>
            <td>{status.totals.evidenceItems}</td>
          </tr>
          <tr>
            <td>Good news applied</td>
            <td>{status.totals.autoAppliedPositive}</td>
          </tr>
          <tr>
            <td>Bad news applied</td>
            <td>{status.totals.autoAppliedNegative}</td>
          </tr>
          <tr>
            <td>Waiting for your review</td>
            <td>{status.totals.needsReview}</td>
          </tr>
          <tr>
            <td>Ignored (unexpected sender)</td>
            <td>{status.totals.quarantined}</td>
          </tr>
        </tbody>
      </table>

      {status.lastProcessedDetail ? (
        <div className="faint" style={{ marginTop: 6 }}>
          Last issue: {status.lastProcessedDetail}
        </div>
      ) : null}
      {status.lastError ? (
        <Notice tone="error">Last problem: {status.lastError}</Notice>
      ) : null}

      <NewsletterHistory />
    </div>
  );
}

/**
 * Recent emails plus how much of each one the parser understood.
 *
 * Unread sentences are not failures — they are usually ordinary prose. Showing
 * them is how the rule list gets better over time.
 */
function NewsletterHistory() {
  const [messages, setMessages] = useState<NewsletterMessage[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api.get<{ messages: NewsletterMessage[] }>('/api/newsletter/messages', { fresh: true });
    setMessages(res.messages);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Scoring an issue from here changes what this list says about it, so the
  // list re-reads rather than keeping a row that still calls itself unscored.
  const onScored = () => void load();

  if (!messages) return null;

  return (
    <>
      <div className="section-title">Recent emails</div>
      {messages.length === 0 ? (
        <div className="faint">Nothing has arrived at this address yet.</div>
      ) : (
        messages.map((m) => {
          const c = m.coverage ?? {};
          return (
            // The row header is the button; the detail is a sibling, because a
            // button may not contain the buttons the reprocess panel needs.
            <div
              key={m.messageId}
              data-testid="newsletter-message"
              data-message-id={m.messageId}
              data-status={m.status}
              data-tally-state={m.tallyState ?? 'unknown'}
            >
              <button
                className="player-row"
                data-testid="newsletter-message-toggle"
                aria-expanded={open === m.messageId}
                onClick={() => setOpen(open === m.messageId ? null : m.messageId)}
              >
                <div className="player-row-top">
                  <span className="player-name">{m.subject || '(no subject)'}</span>
                  <span className="row-action">{formatDate(m.receivedAt)}</span>
                </div>
                {/*
                  What happened to this issue, in the vocabulary of the workflow
                  that now owns it.

                  It used to print "N news item(s)" and "N to review", which were
                  the classifier's own counts: how many sentences it scored by
                  itself and how many it wanted a verdict on. Neither is a thing
                  that happens on arrival any more, and leaving them would have
                  the history describe a pipeline the app no longer runs.
                */}
                <div className="player-row-metrics">
                  <Badge tone={m.status === 'processed' ? 'pos' : m.status === 'quarantined' ? 'warn' : 'neg'}>
                    {m.status === 'processed' ? 'received' : m.status === 'quarantined' ? 'ignored' : m.status}
                  </Badge>
                  {m.tallyState === 'awaiting' ? (
                    <span className="metric" data-testid="newsletter-awaiting">
                      waiting to be scored
                    </span>
                  ) : m.tallyState === 'applied' ? (
                    <span className="metric">scored</span>
                  ) : null}
                </div>
              </button>
              {open === m.messageId ? (
                <div className="explain">
                  {m.detail ? <div className="muted">{m.detail}</div> : null}
                  {m.rejectReason ? <div className="muted">{m.rejectReason}</div> : null}
                  {m.status === 'processed' ? (
                    <>
                      {(c.repairs ?? []).length > 0 ? (
                        <Notice tone="warn">
                          This email arrived with its text encoded oddly and had to be repaired
                          before it could be read. That repair is done every time it is copied, so
                          Copy for ChatGPT still hands over clean readable text — nothing here
                          needs fixing.
                        </Notice>
                      ) : null}
                      {/*
                        How much text came out of the email, and nothing about
                        what it means.

                        This table used to be the classifier's report card —
                        "turned into a signal", "read but no rule matched",
                        "unclear which player" — which was a set of claims about
                        the football in the issue, made by a path that has been
                        retired. What is left is the one thing arrival can
                        honestly answer: whether the email decoded into readable
                        text, and how much of it there is to hand to ChatGPT.
                      */}
                      <table className="compact" style={{ marginTop: 6 }}>
                        <tbody>
                          <tr>
                            <td>Readable sentences</td>
                            <td>{c.sentences ?? 0}</td>
                          </tr>
                          <tr>
                            <td>Sentences naming a player you have</td>
                            <td>{c.sentencesWithPlayers ?? 0}</td>
                          </tr>
                        </tbody>
                      </table>
                      {(c.unknownNames ?? []).length > 0 ? (
                        <>
                          <div className="section-title">Names not in the player list</div>
                          <div className="faint">{(c.unknownNames ?? []).join(', ')}</div>
                          <div className="faint" style={{ marginTop: 4 }}>
                            Mostly coaches and reporters. If a real player is listed here, update the
                            player list on the Sleeper step.
                          </div>
                        </>
                      ) : null}
                      {m.bodyRetained ? <ChatTallyPanel messageId={m.messageId} onApplied={onScored} /> : null}
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })
      )}
    </>
  );
}

/**
 * The two workflow controls, directly under the Newsletter row on Setup.
 *
 * Drawn only while an issue is waiting to be scored, and gone the moment one
 * is. That is the whole contract: this is the week's outstanding job made
 * visible where the job is announced, not a permanent pair of buttons on a
 * settings screen. It names the issue it acts on, because the reader should
 * never be asked to pick a newsletter when there is only one thing to do — and
 * says how many are behind it when there are, since the app works them one at
 * a time, oldest first.
 */
function PendingTallyRow({
  pending,
  unlocked,
  onDone,
}: {
  pending: NonNullable<NewsletterStatus['pendingTally']>;
  unlocked: boolean;
  onDone: (detail: string) => void;
}) {
  const behind = pending.waiting - 1;
  return (
    <div className="list-row-actions" data-testid="setup-pending-tally">
      <div className="list-row-detail" data-testid="setup-pending-tally-subject">
        {pending.subject || 'Latest issue'} · {formatDate(pending.receivedAt)}
        {behind > 0 ? ` · ${behind} more after this one` : ''}
      </div>
      {unlocked ? (
        <ChatTallyPanel messageId={pending.messageId} heading={null} onApplied={onDone} />
      ) : (
        // Applying a tally is a change, and changes need the passphrase. Saying
        // so here beats a button that fails at the last step.
        <div className="faint">Unlock above to score this issue.</div>
      )}
    </div>
  );
}

/**
 * The weekly one-minute import.
 *
 * The app cannot judge what a paragraph of analysis means for a player, and is
 * not going to pretend to. What it can do is remove every other step: hand the
 * cleaned article over in one tap, read a strict answer back, resolve the names,
 * and show exactly what would change before anything is written.
 *
 * Two controls, in the order they are used. Nothing applies on paste — the
 * preview is the point, because the app is importing somebody else's judgment
 * and the reader is the only one who can check it.
 *
 * Drawn in two places from one component, so the pair cannot drift: under the
 * Newsletter row on Setup while an issue is waiting, and inside the newsletter
 * history for any stored issue. `heading` is what differs — on Setup the row
 * above has already said what this is.
 */
function ChatTallyPanel({
  messageId,
  heading = 'Score this issue with ChatGPT',
  onApplied,
}: {
  messageId: string;
  heading?: string | null;
  /**
   * Called after a successful apply, with what it did.
   *
   * The detail is handed over rather than only shown here because on Setup this
   * whole component disappears the moment the issue is scored — which is the
   * point of it, and would take the confirmation with it. The caller outlives
   * the work and is where the sentence belongs.
   */
  onApplied?: (detail: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const [pasted, setPasted] = useState('');
  const [preview, setPreview] = useState<AiTallyPreview | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const path = `/api/newsletter/messages/${encodeURIComponent(messageId)}`;

  const copy = async () => {
    setBusy(true);
    setError(null);
    try {
      const { source } = await api.get<{ source: string }>(`${path}/chat-source`, { fresh: true });
      /*
       * The clipboard API is unavailable outside a secure context and can be
       * refused even inside one, so a failure falls back to a selectable
       * textarea rather than leaving the reader with a button that did nothing.
       */
      await navigator.clipboard.writeText(source);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not reach the clipboard. Open Paste AI Tally and copy the text from there.');
    } finally {
      setBusy(false);
    }
  };

  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await api.post<AiTallyPreview>(`${path}/ai-tally/preview`, { text: pasted }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<AiTallyApplyOutcome>(`${path}/ai-tally/apply`, { text: pasted });
      setDone(result.detail);
      setPreview(null);
      setPasted('');
      setOpen(false);
      // Setup re-reads and this whole area disappears, which is the visible
      // half of "the issue is done". Called after the sheet closes so the
      // reader sees the outcome rather than a component vanishing under them.
      if (result.completed) onApplied?.(result.detail);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const ready = preview?.ready ?? [];
  const reinstated = preview?.reinstated ?? [];
  /*
   * Whether applying would do anything, by the same five-way count the preview
   * uses to decide whether to say "Nothing would change".
   *
   * Enabling on matched rows alone got this wrong in the direction that matters:
   * a paste whose only effect is to stop this app's own reading of the issue
   * from counting does change the ledger, and the button would have said there
   * was nothing to apply.
   */
  const changes =
    ready.length > 0 ||
    reinstated.length > 0 ||
    (preview?.wouldRetire.length ?? 0) > 0 ||
    (preview?.parserSuperseded.length ?? 0) > 0 ||
    (preview?.parserNeedsReview.length ?? 0) > 0;
  /*
   * What the primary action does, and why "nothing changes" is still a thing
   * to press.
   *
   * A tally that scores nobody is a real answer — the commonest one for a quiet
   * week — and approving it is what finishes the issue. If the button needed a
   * ledger change to be pressable, that answer would leave the newsletter
   * asking for attention nobody could ever clear.
   *
   * The one state that is genuinely inert is a replay: this exact tally has
   * been applied already, the server would recognise it and write nothing, and
   * saying so is more use than a button that reports doing nothing.
   */
  const replay = preview?.alreadyAppliedAt != null;
  const canApply = preview != null && preview.protocolOk && !replay;
  const applyLabel = !preview?.protocolOk
    ? 'Not a tally'
    : replay
      ? 'Already applied'
      : changes
        ? `Process tally${ready.length > 0 ? ` (${ready.length})` : ''}`
        : 'Nothing to add — mark this issue done';
  const needsReview =
    (preview?.pending.length ?? 0) + (preview?.ambiguous.length ?? 0) + (preview?.unmatched.length ?? 0);

  return (
    <div style={{ marginTop: heading ? 8 : 0 }} data-testid="chat-tally-panel">
      {heading ? <div className="section-title">{heading}</div> : null}
      {done ? <Notice tone="ok">{done}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      <div className="btn-row btn-row-workflow">
        <button className="btn" onClick={copy} disabled={busy} data-testid="copy-for-chatgpt">
          {copied ? 'Copied for ChatGPT' : 'Copy for ChatGPT'}
        </button>
        <button className="btn" onClick={() => setOpen(true)} data-testid="open-paste-tally">
          Paste AI tally
        </button>
      </div>
      <div className="faint" style={{ marginTop: 4 }}>
        Paste the issue into your weekly ChatGPT thread, then bring its tally back here.
      </div>

      {open ? (
        <Sheet title="Paste AI Tally" onClose={() => setOpen(false)} testId="paste-tally-sheet">
          {/*
            Capped, not free-running.

            The base `textarea` rule sets a 110px floor that `rows` cannot
            undercut, and a sheet is sized to its own content — so a tall paste
            box pushed Parse / Preview past the bottom of a 390pt phone, where
            it was drawn but could not be reached or tapped. This box is for
            confirming you pasted the right thing, not for reading a week of
            analysis in.
          */}
          <textarea
            style={{ display: 'block', minHeight: 76, maxHeight: '28vh' }}
            rows={4}
            value={pasted}
            placeholder={'NEWSLETTER_TALLY_V1\nChris Olave | +2 | Elite target share\nEND_NEWSLETTER_TALLY'}
            onChange={(e) => {
              setPasted(e.target.value);
              // A stale preview beside edited text is worse than none.
              setPreview(null);
            }}
            data-testid="paste-tally-input"
          />
          <div className="btn-row" style={{ marginTop: 8 }}>
            <button
              className="btn btn-sm"
              onClick={check}
              disabled={busy || !pasted.trim()}
              data-testid="paste-tally-check"
            >
              {busy ? 'Checking…' : 'Parse / Preview'}
            </button>
          </div>

          {preview ? (
            <div className="explain" style={{ marginTop: 8 }} data-testid="paste-tally-preview">
              {preview.error ? <Notice tone="error">{preview.error}</Notice> : null}
              {preview.alreadyAppliedAt ? (
                <Notice tone="ok">
                  This exact tally was already applied on {formatDate(preview.alreadyAppliedAt)}. Nothing
                  would be added a second time.
                </Notice>
              ) : null}
              <div className="muted">{preview.detail}</div>

              {ready.length > 0 ? (
                <>
                  <div className="section-title">Ready to apply</div>
                  <ul style={{ paddingLeft: 16, margin: 0 }}>
                    {ready.map((row) => (
                      <li key={row.dedupeKey} style={{ marginBottom: 6 }}>
                        <strong>{row.playerName}</strong> {row.score > 0 ? `+${row.score}` : row.score}
                        <div className="faint">{row.reason}</div>
                        {row.parserRows.map((p) => (
                          <div key={p.id} className="faint">
                            {p.disposition === 'superseded'
                              ? `This app's own reading of the same issue — “${p.excerpt}” — stops counting, so the newsletter counts once.`
                              : p.disposition === 'needs_review'
                                ? `This app read the opposite from the same issue — “${p.excerpt}”. It stops counting and waits for your decision.`
                                : `You corrected this app's reading of the same issue — “${p.excerpt}” — and it stays exactly as you set it.`}
                          </div>
                        ))}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}

              {reinstated.length > 0 ? (
                <>
                  <div className="section-title">Would count again</div>
                  <ul style={{ paddingLeft: 16, margin: 0 }}>
                    {reinstated.map((row) => (
                      <li key={row.dedupeKey} style={{ marginBottom: 6 }}>
                        <strong>{row.playerName}</strong> {row.score > 0 ? `+${row.score}` : row.score}
                        <div className="faint">
                          Already on the record, retired when a later tally replaced it. This one asks for
                          it again, so it counts again.
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}

              {preview.wouldRetire.length > 0 ? (
                <div className="faint" style={{ marginTop: 4 }}>
                  {preview.wouldRetire.length} earlier row(s) from this newsletter would be replaced.
                </div>
              ) : null}

              {preview.tallyDelta.length > 0 ? (
                <>
                  <div className="section-title">Net change to each score</div>
                  <ul style={{ paddingLeft: 16, margin: 0 }}>
                    {preview.tallyDelta.map((row) => (
                      <li key={row.playerId} className="faint">
                        {row.playerName} {row.net > 0 ? `+${row.net}` : row.net}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}

              {needsReview > 0 ? (
                <>
                  <div className="section-title">Needs review</div>
                  <ul style={{ paddingLeft: 16, margin: 0 }}>
                    {preview.ambiguous.map((row) => (
                      <li key={`a-${row.name}`} className="faint">
                        {row.name} — more than one player has this name
                      </li>
                    ))}
                    {preview.unmatched.map((row) => (
                      <li key={`u-${row.name}`} className="faint">
                        {row.name} — not in the player list
                      </li>
                    ))}
                    {preview.pending.map((row) => (
                      <li key={row.dedupeKey} className="faint">
                        {row.playerName} — scored twice in one block
                      </li>
                    ))}
                  </ul>
                  <div className="faint" style={{ marginTop: 4 }}>
                    These wait in Review. The matched rows above can still be applied.
                  </div>
                </>
              ) : null}

              {preview.rejected.length > 0 ? (
                <>
                  <div className="section-title">Lines that could not be read</div>
                  <ul style={{ paddingLeft: 16, margin: 0 }}>
                    {preview.rejected.map((row) => (
                      <li key={row.lineNumber} className="faint">
                        “{row.line}” — {row.why}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}

              {/*
                The gate, and the way back out of it.

                Primary says what pressing it does in the app's own words —
                process this tally — rather than naming the machinery behind it.
                Cancel is beside it because a reader who has just read the list
                and does not like it needs an action that plainly changes
                nothing, not a close control in the corner of a sheet.
              */}
              <div className="btn-row" style={{ marginTop: 8 }}>
                <button
                  className="btn btn-primary"
                  onClick={apply}
                  disabled={busy || !canApply}
                  data-testid="paste-tally-apply"
                >
                  {applyLabel}
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    setPreview(null);
                    setPasted('');
                    setOpen(false);
                  }}
                  disabled={busy}
                  data-testid="paste-tally-cancel"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
        </Sheet>
      ) : null}
    </div>
  );
}

/**
 * The address of mail that arrived and was ignored, when it is worth offering
 * to accept.
 *
 * Only offered when the sender is genuinely not covered yet. `senderConfigured`
 * is the authority on whether the expected-sender list is the user's or still
 * the placeholder the app ships with — guessing that from the text of an
 * address would misjudge any domain that happened to contain the wrong word.
 */
function ignoredSender(status: NewsletterStatus): string | null {
  const from = status.lastReceivedFrom?.trim();
  if (!from) return null;
  if (status.lastReceivedStatus !== 'quarantined') return null;
  if (!status.senderConfigured) return from;

  const covered = status.expectedSenders.some((pattern) => {
    const p = pattern.trim().toLowerCase();
    const f = from.toLowerCase();
    return p.startsWith('@') ? f.endsWith(p) : f === p;
  });
  return covered ? null : from;
}

/**
 * Where the expanded player card's two extra sections come from, and how much
 * of each actually landed.
 *
 * Not a setup step — there is nothing to do here — but not hidden either. A
 * pipeline that quietly covers a third of the league looks identical from a
 * player card to one that covers all of it: both show numbers, and the missing
 * two thirds simply say nothing. The counts are the only place the difference
 * is visible, so they are stated, folded away, in plain words.
 *
 * The last line answers a question the user asked directly, and answers it with
 * a no.
 */
function PlayerDetailPanel({
  status,
  unlocked,
  onDone,
}: {
  status: SetupStatus;
  unlocked: boolean;
  onDone: () => void;
}) {
  const detail = status.playerDetail;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  /*
   * A way out of a bad night.
   *
   * The nightly sync is the real path and this is not a second one — it calls
   * the same code. It exists because a count of zero on this panel would
   * otherwise be a dead end: the user could see that last season had not
   * loaded and had nothing to do about it until 09:00 UTC.
   */
  const reload = async () => {
    setBusy(true);
    setNote(null);
    try {
      const result = await api.post<{ season: string; matched: number; unmatched: number }>(
        '/api/players/season-stats/refresh',
      );
      setNote(`${result.season}: ${result.matched} players loaded, ${result.unmatched} rows were not players.`);
      onDone();
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="list-details" data-testid="panel-player-detail">
      <summary>Player card data</summary>
      <div className="list-details-body">

      <div className="section-title" style={{ marginTop: 8 }}>
        {detail.stats.season} statistics
      </div>
      <div className="faint" data-testid="stats-health">
        {detail.stats.players > 0 ? (
          <>
            {detail.stats.players} player{detail.stats.players === 1 ? '' : 's'} covered, from{' '}
            {detail.stats.returned ?? 0} rows. Updated {formatAge(detail.stats.lastRunAt)}.
            {detail.stats.unmatched
              ? ` ${detail.stats.unmatched} rows were not players this app knows — team totals and the like.`
              : ''}
          </>
        ) : (
          <>Nothing stored yet. The nightly Sleeper sync fills this in; cards say nothing until it does.</>
        )}
      </div>
      <div className="faint" style={{ marginTop: 6 }}>
        Source: {detail.stats.source}. The positional finish is half-PPR — {detail.stats.scoring} — and it is that
        rather than your league&rsquo;s own scoring, which is what you asked for and is a different number in a
        league with custom rules. It is worked out here from the points, over the players who actually scored, so
        somebody who never played has no finish rather than a place in the twelve hundreds.
        {detail.stats.rankDisagreements
          ? ` ${detail.stats.rankDisagreements} players sit differently in Sleeper's own ordering, which counts everybody on its books.`
          : ''}
      </div>
      {unlocked ? (
        <>
          <button
            className="btn"
            type="button"
            data-testid="reload-season-stats"
            disabled={busy}
            onClick={() => void reload()}
            style={{ marginTop: 8 }}
          >
            {busy ? 'Loading…' : 'Load them again'}
          </button>
          {note ? (
            <div className="faint" style={{ marginTop: 6 }}>
              {note}
            </div>
          ) : null}
        </>
      ) : null}

      <div className="section-title" style={{ marginTop: 10 }}>
        {detail.outlook.season} season outlook
      </div>
      <div className="faint" data-testid="outlook-health">
        {detail.outlook.stored} stored, {detail.outlook.noneAvailable} players confirmed to have none.
        {detail.outlook.newestAt ? ` Newest fetched ${formatAge(detail.outlook.newestAt)}.` : ''}
      </div>
      <div className="faint" style={{ marginTop: 6 }}>
        Source: {detail.outlook.source}. Fetched one player at a time, only when you open his card, and then kept —
        including the players who have none, so opening those cards asks nobody anything.
      </div>

      <div className="section-title" style={{ marginTop: 10 }}>
        Roster percentage
      </div>
      <div className="faint" data-testid="roster-percent-health">
        {detail.rosterPercent.note}
      </div>

        <InjurySourceHealth status={status} unlocked={unlocked} onDone={onDone} />
        <UsageSourceHealth status={status} unlocked={unlocked} onDone={onDone} />
      </div>
    </details>
  );
}

/**
 * Per-game usage: whether the role detector has anything to read.
 *
 * The panel is built around the one number that decides whether this feature
 * says anything at all — how many players have six games stored. Every other
 * count here can look healthy while every card still reads "insufficient data",
 * because the detector needs three recent games and three baseline games before
 * it will call anything a trend, and it is right to.
 */
function UsageSourceHealth({
  status,
  unlocked,
  onDone,
}: {
  status: SetupStatus;
  unlocked: boolean;
  onDone: () => void;
}) {
  const usage = status.usage;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const run = usage.lastRun;

  const refresh = async () => {
    setBusy(true);
    setNote(null);
    try {
      const result = await api.post<SetupStatus['usage']['lastRun']>('/api/usage/refresh');
      setNote(
        result?.outcome === 'ok'
          ? `Week ${result.week ?? result.latestWeek}: ${result.matchedById + result.matchedByName} players mapped, ` +
            `${result.unmatched} not recognised, ${result.rowsWritten} row(s) written.`
          : (result?.note ?? 'Nothing came back.'),
      );
      onDone();
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="section-title" style={{ marginTop: 10 }}>
        Per-game usage
      </div>
      <div className="faint" data-testid="usage-health">
        {usage.summary}
      </div>
      <div className="faint" style={{ marginTop: 6 }}>
        Targets, carries, receptions and target share come from <strong>{usage.source}</strong>&rsquo;s published weekly
        player stats — a free public file, no account and no key. It is what lets Start/Sit say whether a player&rsquo;s
        role is actually changing instead of only how the market prices him.
        {run?.outcome === 'ok' ? (
          <>
            {' '}Last read {formatAge(run.fetchedAt)}
            {run.publishedAt ? `, from a file published ${formatAge(run.publishedAt)}` : ''}: {run.rowsReturned} players
            in the week, {run.matchedById} matched on identifier and {run.matchedByName} on name
            {run.unmatched > 0 ? `, ${run.unmatched} declined rather than guessed` : ''}.
          </>
        ) : null}
      </div>
      {/*
        The three timestamps, kept apart for the same reason the injury panel
        keeps them apart: "checked" moves every morning whether or not anything
        arrived, and on its own it would describe a healthy pipeline and a dead
        one in identical words.
      */}
      <div className="faint" style={{ marginTop: 6 }} data-testid="usage-freshness">
        Checked {usage.checkedAt ? formatAge(usage.checkedAt) : 'not yet'} · the file itself last changed{' '}
        {usage.sourceModifiedAt ? formatAge(usage.sourceModifiedAt) : 'unknown'}
        {usage.ingestedAt ? ` · last stored ${formatAge(usage.ingestedAt)}` : ''}.
      </div>
      <div
        className="faint"
        style={{ marginTop: 6, fontWeight: usage.consecutiveFailures > 0 ? 600 : undefined }}
        data-testid="usage-data-health"
      >
        {usage.dataHealth}
      </div>
      {/*
        The threshold, stated plainly. Six games is not a limitation to
        apologise for — it is the difference between naming a trend and naming
        a coincidence — but a user looking at "insufficient data" in October
        deserves to know it is arithmetic rather than a broken feed.
      */}
      <div className="faint" style={{ marginTop: 6 }} data-testid="usage-readiness">
        A role change is only reported once a player has {usage.minimumGames} games — three recent against three of
        baseline. {usage.playersWithEnoughGames} player{usage.playersWithEnoughGames === 1 ? ' has' : 's have'} that
        much so far, out of {usage.players} with any usage at all. Below it the card says so rather than guessing from
        a short run.
      </div>
      <div className="faint" style={{ marginTop: 6 }}>
        It is checked <strong>once a day</strong>, not every five minutes like the injury report. A game&rsquo;s target
        count is settled the moment the game ends, so checking more often would learn nothing and write a bookkeeping
        row each time to prove it.
        {usage.writesToday > 0 ? ` ${usage.writesToday} of ${usage.writeCeiling} daily writes used.` : ''}
      </div>
      {unlocked ? (
        <>
          <button
            className="btn"
            type="button"
            data-testid="reload-usage"
            disabled={busy}
            onClick={() => void refresh()}
            style={{ marginTop: 8 }}
          >
            {busy ? 'Reading…' : 'Read the usage file again'}
          </button>
          {note ? (
            <div className="faint" style={{ marginTop: 6 }}>
              {note}
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}

/**
 * Where a player's availability comes from, and how much of it arrived.
 *
 * Two sources doing two jobs, and the panel says which is which: Sleeper owns
 * the designation and is always there, the published report adds the body part
 * and the practice week and is sometimes not. The counts are the point — a
 * report that mapped a third of its rows looks identical to one that worked
 * until a card is blank on a Sunday morning.
 */
function InjurySourceHealth({
  status,
  unlocked,
  onDone,
}: {
  status: SetupStatus;
  unlocked: boolean;
  onDone: () => void;
}) {
  const injury = status.injury;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const run = injury.lastRun;

  const refresh = async () => {
    setBusy(true);
    setNote(null);
    try {
      const result = await api.post<SetupStatus['injury']['lastRun']>('/api/injuries/refresh');
      setNote(
        result?.outcome === 'ok'
          ? `Week ${result.latestWeek}: ${result.matchedById + result.matchedByName} players mapped, ${result.unmatched} not recognised.`
          : (result?.note ?? 'Nothing came back.'),
      );
      onDone();
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="section-title" style={{ marginTop: 10 }}>
        Injury information
      </div>
      <div className="faint" data-testid="injury-health">
        {injury.summary}
      </div>
      <div className="faint" style={{ marginTop: 6 }}>
        Designation comes from <strong>{injury.statusSource}</strong>, which is the league host and the authority on
        whether a player is Questionable. The body part and the practice week come from{' '}
        <strong>{injury.reportSource}</strong>&rsquo;s published injury report — a free public file, no account and no
        key. Where they disagree the card says so rather than picking one quietly.
        {run?.outcome === 'ok' ? (
          <>
            {' '}Last read {formatAge(run.fetchedAt)}
            {run.publishedAt ? `, from a file published ${formatAge(run.publishedAt)}` : ''}: {run.rowsReturned} players
            in the file, {run.matchedById} matched on identifier and {run.matchedByName} on name.
          </>
        ) : null}
      </div>
      {/*
        The three timestamps, which are routinely confused and must not be.
        "Checked" moves every five minutes; "the report itself" is when the NFL
        last changed anything. Showing only the first would say "updated 2
        minutes ago" about a report from Wednesday.
      */}
      <div className="faint" style={{ marginTop: 6 }} data-testid="injury-freshness">
        Checked {injury.checkedAt ? formatAge(injury.checkedAt) : 'not yet'} · the report itself last changed{' '}
        {injury.sourceModifiedAt ? formatAge(injury.sourceModifiedAt) : 'unknown'}
        {injury.ingestedAt ? ` · last stored ${formatAge(injury.ingestedAt)}` : ''}.
      </div>
      {/*
        Whether the data can be trusted, which is not the same question as
        whether it was checked. `checkedAt` moves every five minutes either way,
        so on its own it reads identically when the pipeline is healthy and when
        every ingest has failed since Thursday.
      */}
      <div
        className="faint"
        style={{ marginTop: 6, fontWeight: injury.consecutiveFailures > 0 ? 600 : undefined }}
        data-testid="injury-data-health"
      >
        {injury.dataHealth}
      </div>
      {/*
        Last season, kept visibly apart from everything above it.

        It answers a question the rest of this panel cannot while the current
        season is still a 404: whether the published-file path works at all.
        A finished season that has been read in full, and whose stored validator
        now earns a 304, is that proof.
      */}
      <div className="faint" style={{ marginTop: 6 }} data-testid="injury-history-health">
        {injury.history.phase === 'done' ? (
          <>
            {injury.history.season} history: read in full ({injury.history.rowsSeen} rows across{' '}
            {injury.history.lastWeek ?? '?'} weeks), {injury.history.significantPlayers} players with an injury worth
            noting. The file&rsquo;s validator is stored, so it is now checked without downloading it.
          </>
        ) : injury.history.phase ? (
          <>
            {injury.history.season} history: reading it in the background — {injury.history.phase === 'weeks'
              ? `week ${injury.history.weeksDone} of ${injury.history.lastWeek ?? '?'}`
              : `${injury.history.playersSummarized} players summarized`}
            . It is used as context on a card and never as a current status.
          </>
        ) : (
          <>{injury.history.season} history: not read yet.</>
        )}
      </div>
      <div className="faint" style={{ marginTop: 6 }}>
        It is checked <strong>every five minutes, all day</strong>, because a player is ruled out ninety minutes before
        kickoff and kickoff is 9:30am for a London game, Thursday night, or Friday on a holiday. The check is a
        conditional request: when nothing has changed the answer carries no data and nothing is written, so the cost
        of asking constantly is close to nothing.
        {injury.writesToday > 0 ? ` ${injury.writesToday} of ${injury.writeCeiling} daily writes used.` : ''}
      </div>
      <div className="faint" style={{ marginTop: 6 }}>
        The report carries one practice status per <em>week</em>, not one per practice day, so the app compares weeks
        and does not claim a Wednesday-to-Friday sequence it cannot see.
      </div>
      {/*
        What actually moved, most recent first. This is the payoff of storing
        transitions rather than only the current answer: "Q → Out" is the single
        most valuable thing the pipeline produces and it is invisible in a table
        that only ever holds the latest state.
      */}
      {injury.recentEvents.length > 0 ? (
        <div className="faint" style={{ marginTop: 6 }} data-testid="injury-events">
          Recent changes:{' '}
          {injury.recentEvents
            .map((e) => `${e.kind === 'practice' ? 'practice ' : ''}${e.from ?? '—'} → ${e.to ?? '—'}`)
            .join(' · ')}
        </div>
      ) : null}
      {unlocked ? (
        <>
          <button
            className="btn"
            type="button"
            data-testid="reload-injuries"
            disabled={busy}
            onClick={() => void refresh()}
            style={{ marginTop: 8 }}
          >
            {busy ? 'Reading…' : 'Read the report again'}
          </button>
          {note ? (
            <div className="faint" style={{ marginTop: 6 }}>
              {note}
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}

function VegasPanel({ status }: { status: SetupStatus }) {
  return (
    <div className="card" data-testid="panel-vegas">
      <div className="badge-row" style={{ marginTop: 0 }}>
        <Badge tone={status.vegas.live ? 'pos' : 'warn'}>
          {status.vegas.live ? 'Live lines connected' : 'Not connected yet'}
        </Badge>
        <Badge>source: {status.vegas.provider}</Badge>
      </div>
      <div className="faint" style={{ marginTop: 8 }}>
        {status.vegas.note}
      </div>
      <div className="faint" style={{ marginTop: 6 }}>
        Nothing to do here yet. Real betting lines are switched on later, once a free source has been
        confirmed. Until then, start/sit advice uses your news signal and clearly says when a line is
        missing rather than guessing.
      </div>
      {status.vegas.lastRefreshedAt ? (
        <div className="faint" style={{ marginTop: 6 }}>
          Practice data last updated {formatAge(status.vegas.lastRefreshedAt)} across {status.vegas.events} game(s).
        </div>
      ) : null}

      {/*
        Season-long markets are what the draft would use. They are reported
        separately from the weekly game lines because they are a different
        question with a different answer — and today, for this provider, the
        answer is that it does not publish them.
      */}
      <div className="section-title">Season outlook ({status.vegas.season.season})</div>
      <div className="faint" data-testid="season-market-health">
        {status.vegas.season.quotes > 0 ? (
          <>
            {status.vegas.season.quotes} market line{status.vegas.season.quotes === 1 ? '' : 's'} across{' '}
            {status.vegas.season.players} player{status.vegas.season.players === 1 ? '' : 's'}
            {status.vegas.season.unresolved > 0
              ? `, ${status.vegas.season.unresolved} on names that could not be matched to a player`
              : ''}
            . Updated {formatAge(status.vegas.season.fetchedAt)}
            {status.vegas.season.stale ? ' — out of date, so the draft is not using it' : ''}.
          </>
        ) : (
          <>Nothing stored. {status.vegas.season.reason}</>
        )}
      </div>
      <div className="faint" style={{ marginTop: 6 }}>
        When a season line exists for a player, the draft shows it on his card and lets it nudge the ranking
        a little. When it does not, the card says nothing rather than guessing.
      </div>

      {/*
        The month's allowance.

        Not something the user has to act on — it is here so that a quota
        problem is visible while it is still a number and not yet an outage.
      */}
      <div className="section-title">This month&rsquo;s allowance</div>
      <div className="faint" data-testid="vegas-budget">
        <strong>
          {status.vegas.budget.used} of {status.vegas.budget.limit}
        </strong>{' '}
        used in {status.vegas.budget.month} ({BUDGET_LABEL[status.vegas.budget.state] ?? status.vegas.budget.state})
        {status.vegas.budget.source === 'provider' ? ', counted by the provider' : ''}.{' '}
        {status.vegas.budget.note}.
      </div>
      {Object.keys(status.vegas.budget.bySource).length > 0 ? (
        <div className="faint" style={{ marginTop: 6 }} data-testid="vegas-budget-sources">
          Spent on:{' '}
          {Object.entries(status.vegas.budget.bySource)
            .sort((a, b) => b[1] - a[1])
            .map(([source, entities]) => `${source} ${entities}`)
            .join(' · ')}
          .
        </div>
      ) : null}
      <div className="faint" style={{ marginTop: 6 }}>
        A refresh asks only about the games your own players are in, and stops entirely before the free
        allowance runs out — at which point the last lines it fetched stay on screen, marked as old.
      </div>
    </div>
  );
}

/** Plain words for the four budget states. Nobody should have to read code. */
const BUDGET_LABEL: Record<string, string> = {
  healthy: 'plenty left',
  caution: 'over half used, so low-priority refreshes have stopped',
  conservation: 'running low, so only close decisions are refreshed',
  hard_stop: 'into the reserve, kept for close game-day decisions',
};
