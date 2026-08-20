/**
 * App shell: bottom tab navigation and shared overview state.
 *
 * There is no login wall — reading is public. Only changing settings needs the
 * passphrase, and that prompt lives inside Setup.
 */

import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react';
import { api, type LeagueSummary, type Overview } from './api.ts';
import { Loading, Notice } from './components/common.tsx';
import {
  BoardIcon,
  GearIcon,
  MatchupIcon,
  ReviewIcon,
  RosterIcon,
  SearchIcon,
  TradeIcon,
  WaiverIcon,
} from './components/icons.tsx';
import { InstallPrompt } from './components/install.tsx';
import { DemoIndicator, useDemoWorld } from './demo/DemoIndicator.tsx';
import { useKeyboardOpen } from './viewport.ts';
import { DraftScreen } from './screens/DraftScreen.tsx';
import { MatchupScreen } from './screens/MatchupScreen.tsx';
import { PlayersScreen } from './screens/PlayersScreen.tsx';
import { ReviewScreen } from './screens/ReviewScreen.tsx';
import { SetupScreen } from './screens/SetupScreen.tsx';
import { TradesScreen } from './screens/TradesScreen.tsx';
import { TeamScreen } from './screens/TeamScreen.tsx';
import { WaiversScreen } from './screens/WaiversScreen.tsx';

type Tab = 'draft' | 'team' | 'matchup' | 'waivers' | 'trades' | 'players' | 'review' | 'setup';

/*
 * The destinations.
 *
 * The glyphs are drawn rather than typed — see components/icons.tsx. Two of the
 * six characters this used to print were being resolved to colour emoji on a
 * phone, which put a blue gear and a green tick in a row of grey marks at a
 * size and weight no stylesheet could reach.
 *
 * Two of these are seasonal, and they are the same slot.
 *
 * Draft is the most useful thing in the app for two weeks a year and a museum
 * for the other fifty: once the regular season is under way it leaves the bar,
 * because a sixth of the most valuable strip of glass in the app is too much to
 * spend on a board about picks made in August. Waivers is its opposite — it
 * cannot say anything before a draft has finished, and it is where the season's
 * decisions actually get made — so it arrives at the moment Draft leaves, in
 * the position immediately after Team, which is the screen it belongs beside.
 *
 * Both are dropped from the list rather than disabled or blanked, so the bar
 * repacks and nothing is left holding an empty slot. Neither *screen* is
 * touched: Draft still renders when the app is on it, which is what keeps the
 * route reachable. See core/sleeper/phase.ts for when "under way" begins, and
 * why a completed draft is emphatically not the answer.
 *
 * Matchup is the third seasonal destination and it arrives at a different
 * moment from the other two: the day the draft *finishes*, which is before the
 * season starts and therefore before Draft leaves. For that stretch the bar
 * carries seven, which is the most it ever carries and is why the stylesheet
 * has a rule for exactly that count at narrow widths — see `.tabbar[data-count]`.
 * A head-to-head before a draft is finished would be a projection of a team
 * that does not exist yet, which is why it is not simply always there.
 */
const TABS: { id: Tab; label: string; Icon: ComponentType<{ size?: number }> }[] = [
  { id: 'draft', label: 'Draft', Icon: BoardIcon },
  { id: 'team', label: 'Team', Icon: RosterIcon },
  { id: 'matchup', label: 'Matchup', Icon: MatchupIcon },
  { id: 'waivers', label: 'Waivers', Icon: WaiverIcon },
  { id: 'trades', label: 'Trades', Icon: TradeIcon },
  { id: 'players', label: 'Players', Icon: SearchIcon },
  { id: 'review', label: 'Review', Icon: ReviewIcon },
  { id: 'setup', label: 'Setup', Icon: GearIcon },
];

export function App() {
  /** Whether changes are allowed. Reading never requires this. */
  const [unlocked, setUnlocked] = useState(false);
  const [canUnlock, setCanUnlock] = useState(true);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>('draft');
  /*
   * Tapping the tab you are already on.
   *
   * It is the one control on screen with nothing left to do, and iOS gives it a
   * job: it takes you back to the top of the screen and clears whatever you had
   * narrowed it down to. Here that means the search field on Draft and on
   * Players — and only the search field. Nothing that is stored is touched: not
   * a heart, not the queue, not a filter, not a tally.
   *
   * A counter rather than a boolean, because the interesting event is "it
   * happened again" and a screen has to be able to notice the second tap.
   */
  const [resetNonce, setResetNonce] = useState(0);
  /** First load only: land on Setup when there is nothing to show yet. */
  const [, setLanded] = useState(false);
  /**
   * Whether the reader has chosen a destination themselves.
   *
   * The app opens on Draft, which is a default rather than a decision. When the
   * season has moved on and Draft is no longer in the bar, that default has to
   * move too — otherwise the app opens on a screen with no lit destination. A
   * screen the reader *asked* for is a different matter and is never taken away
   * from under them, which is what keeps the route reachable.
   */
  const chosen = useRef(false);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [leagues, setLeagues] = useState<LeagueSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  /*
   * Which world the app is looking at: `'live'`, or a demo scenario's id.
   *
   * Read here rather than inside each screen, because no screen should have to
   * know a demo exists. It does two things and nothing else — see the effect
   * and the `key` below.
   */
  const world = useDemoWorld();

  const refresh = useCallback(async () => {
    try {
      const [ov, lg] = await Promise.all([
        api.get<Overview>('/api/overview'),
        api.get<{ leagues: LeagueSummary[] }>('/api/leagues'),
      ]);
      setOverview(ov);
      setLeagues(lg.leagues);
      setError(null);
      setLanded((already) => {
        if (!already && !ov.selectedLeague) setTab('setup');
        return true;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const checkLock = useCallback(async () => {
    try {
      const status = await api.get<{ unlocked: boolean; canUnlock: boolean }>('/api/auth/status');
      setUnlocked(status.unlocked);
      setCanUnlock(status.canUnlock);
    } catch {
      setUnlocked(false);
    } finally {
      setReady(true);
    }
  }, []);

  /*
   * Re-read everything when the world changes underneath.
   *
   * Entering, changing or leaving a demo swaps the data source for the whole
   * app, so the overview, the league list and the lock state are all read again
   * against whichever source is now in force. That is what makes leaving a demo
   * restore live mode without a page reload, and what redraws the toolbar when
   * a scenario's lifecycle moves the seasonal tab.
   */
  useEffect(() => {
    void checkLock();
    void refresh();
  }, [checkLock, refresh, world]);

  /*
   * Which destinations the bar carries right now.
   *
   * Unknown keeps Draft: the overview says nothing about the season on an older
   * deployment, and losing the board because a field was absent would be the
   * worst possible failure mode for a seasonal tab.
   */
  const draftVisible = overview?.season?.draftVisible ?? true;
  /*
   * Whether the draft has finished, which is when a head-to-head starts to mean
   * anything. Absent on a deployment older than Matchup, and absent is read as
   * "no" — a tab leading to an endpoint that does not exist is worse than a tab
   * that arrives a deploy later.
   */
  const matchupVisible = overview?.lifecycle?.matchupVisible ?? false;
  /*
   * The seasonal slots, decided in one place.
   *
   * Written as a single filter rather than three, because "Draft is showing",
   * "Waivers is showing" and "Matchup is showing" are one fact about where the
   * season is and must never be able to disagree. Draft and Waivers share a
   * slot exactly as they always did; Matchup adds one, and only from the moment
   * a draft is complete.
   */
  const tabs = TABS.filter((t) =>
    t.id === 'draft' ? draftVisible : t.id === 'waivers' ? !draftVisible : t.id === 'matchup' ? matchupVisible : true,
  );

  /*
   * In season, the app opens on Team instead.
   *
   * Only when the reader has not chosen for themselves. Draft is still a real
   * screen and still renders — this moves a *default*, so the app never opens on
   * a destination the bar no longer shows, and never navigates out from under
   * somebody who went there deliberately.
   */
  useEffect(() => {
    if (draftVisible || chosen.current) return;
    setTab((current) => (current === 'draft' ? 'team' : current));
  }, [draftVisible]);

  if (!ready) return <Loading what="Fantasy Analyst" />;

  /*
   * No banner.
   *
   * A two-line header saying "Fantasy Analyst" and the league name sat above
   * every page, and both halves were already somewhere better: the product name
   * is the app the user opened, and the league name is printed by the one screen
   * that is actually talking about a league. On a phone it cost ~40px of every
   * screen to repeat what the screen underneath was about to say.
   *
   * The one thing it carried that nothing else did is whether changes are
   * possible at all, and that has moved to the Setup tab — where unlocking
   * happens — as a mark rather than a sentence.
   */
  const viewOnly = !unlocked && canUnlock;

  return (
    <div className="app">
      {/*
        Unmistakable, on every screen, for as long as a scenario is running.
        Above the content rather than inside it, so no screen can forget it and
        no screen has to know about it.
      */}
      <DemoIndicator />
      {/*
        The screens are remounted when the world changes, and that is the
        simplest correct answer rather than a shortcut.

        Two scenarios share a league id — it is the same fixture league at two
        different moments — so a screen that refetches when "the selected league
        changes" would keep Tuesday's wire on screen under an indicator naming
        Wednesday. Nothing about a screen has to change for this to work, which
        is the point: no screen knows a demo exists.
      */}
      <main className="app-main" key={world}>
        {error ? <Notice tone="error">{error}</Notice> : null}
        {/* Once, on an iPhone, in a Safari tab. Silent everywhere else. */}
        <InstallPrompt />
        {tab === 'draft' ? <DraftScreen leagues={leagues} unlocked={unlocked} resetNonce={resetNonce} /> : null}
        {tab === 'team' ? (
          <TeamScreen leagues={leagues} onLeaguesChanged={() => void refresh()} resetNonce={resetNonce} />
        ) : null}
        {tab === 'matchup' ? <MatchupScreen leagues={leagues} resetNonce={resetNonce} /> : null}
        {tab === 'waivers' ? <WaiversScreen leagues={leagues} resetNonce={resetNonce} /> : null}
        {tab === 'trades' ? <TradesScreen resetNonce={resetNonce} /> : null}
        {tab === 'players' ? <PlayersScreen leagues={leagues} resetNonce={resetNonce} /> : null}
        {tab === 'review' ? <ReviewScreen onChanged={() => void refresh()} resetNonce={resetNonce} /> : null}
        {tab === 'setup' ? (
          <SetupScreen
            leagues={leagues}
            resetNonce={resetNonce}
            onChanged={() => void refresh()}
            unlocked={unlocked}
            canUnlock={canUnlock}
            onUnlocked={() => {
              setUnlocked(true);
              void refresh();
            }}
          />
        ) : null}
      </main>

      <FloatingToolbar
        tabs={tabs}
        active={tab}
        /*
         * Tapping the destination you are already on.
         *
         * iOS gives the current tab the one job it has nothing else to do:
         * take the screen back towards its resting state. Every screen reads
         * this counter and unwinds whatever it is holding — an open sheet, a
         * pushed page, a typed query, an expanded row — and then returns to the
         * top. What none of them touch is anything the user owns: a heart, a
         * queue, a filter they set deliberately and a tally are not view state,
         * and a tab tap has no business changing them.
         *
         * A counter rather than a boolean, because two retaps in a row are two
         * separate requests and a boolean's second one would be a no-op.
         */
        onSelect={(id) => {
          chosen.current = true;
          if (tab === id) setResetNonce((n) => n + 1);
          else setTab(id);
        }}
        reviewBadge={overview ? overview.pendingEvidence + overview.pendingIdentity : 0}
        viewOnly={viewOnly}
      />
    </div>
  );
}

/**
 * The destinations, in one compact floating control.
 *
 * **It holds no state, and that is the point.** Which destination is current is
 * a fact about the app, passed in; the toolbar renders it and reports taps
 * back. A bar that remembered its own selection would be a second answer to
 * "where am I" — and second answers diverge, which is what makes a nested
 * screen light the wrong tab or a programmatic move light none at all. The app
 * lands a first-time reader on Setup without anybody having touched this
 * control, and the toolbar has to be right about that too.
 *
 * Which destinations there *are* is passed in for the same reason. The bar is
 * sized by its contents — `width: max-content` over a column grid — so handing
 * it five instead of six repacks it and re-centres it with no gap, no stretch
 * and no arithmetic here: the one destination that comes and goes costs this
 * component nothing but a prop.
 */
function FloatingToolbar({
  tabs,
  active,
  onSelect,
  reviewBadge,
  viewOnly,
}: {
  tabs: typeof TABS;
  active: Tab;
  onSelect: (id: Tab) => void;
  reviewBadge: number;
  viewOnly: boolean;
}) {
  const measure = useToolbarHeight();
  const keyboardOpen = useKeyboardOpen();

  return (
    <nav
      className="tabbar"
      aria-label="Main navigation"
      ref={measure}
      /*
       * How many destinations there are, for the stylesheet.
       *
       * The one thing CSS cannot count. Seven labels at 360px need a narrower
       * destination than six do, and the rule that provides it has to be able to
       * ask how many there are.
       */
      data-count={tabs.length}
      /*
       * Out of the way while the keyboard is up — see the stylesheet. The
       * attribute rather than a class so the state is legible in the inspector
       * and in a test, which is how the one behaviour nobody can see in a
       * screenshot gets checked at all.
       */
      data-keyboard={keyboardOpen ? 'open' : 'closed'}
    >
      {tabs.map((t) => {
        const badge = t.id === 'review' ? reviewBadge : 0;
        // Where unlocking happens is where "you cannot change anything yet"
        // belongs. A dot, not a word, because it is a state and not a task.
        const locked = t.id === 'setup' && viewOnly;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onSelect(t.id)}
            aria-current={active === t.id ? 'page' : undefined}
            aria-label={locked ? `${t.label} — view only, unlock to make changes` : undefined}
            data-testid={`tab-${t.id}`}
          >
            <span className="tab-glyph" aria-hidden="true">
              <t.Icon />
            </span>
            {t.label}
            {badge > 0 ? <span className="tab-badge">{badge}</span> : null}
            {locked ? <span className="tab-lock" data-testid="view-only" aria-hidden="true" /> : null}
          </button>
        );
      })}
    </nav>
  );
}

/**
 * Reserve exactly the space the toolbar occupies — no more, no less.
 *
 * The page used to reserve a guessed constant plus the home-indicator inset.
 * A guess is wrong in both directions: too small and the last row hides behind
 * the bar, too large and there is a strip of empty page above it that reads as
 * a black bar at the bottom of the screen. The bar knows its own height, so it
 * is asked — on mount, and again whenever it changes, which is what happens
 * when the text size changes under it.
 *
 * What is written is the pill's height *only*. The distance it floats off the
 * bottom edge is `--toolbar-gap`, a pure CSS token, and the two are added
 * together in exactly one place — `--content-inset`. Measuring the whole reach
 * instead would be measuring a transform: the bar translates itself off screen
 * when the keyboard opens, and the reservation would collapse with it.
 *
 * **A callback ref, not an effect over a ref object, and that is the whole
 * point.** This was written as `useEffect(..., [ref])`, which runs once after
 * the first render — and on the first render the app is still showing its
 * loading state, so there is no bar in the document and `ref.current` is null.
 * The effect bailed, its dependency never changed, and it never ran again: the
 * measurement had simply never happened. The page spent every session
 * reserving the 50px fallback for a bar that is 45px without a home indicator
 * and 62px with one — over-reserving on a desktop, and hiding the last row
 * behind the bar on a phone.
 *
 * A callback ref runs when the node actually arrives, which is the event this
 * cares about.
 */
function useToolbarHeight(): (node: HTMLElement | null) => void {
  const dispose = useRef<(() => void) | null>(null);

  return useCallback((node: HTMLElement | null) => {
    dispose.current?.();
    dispose.current = null;
    if (!node) return;

    /*
     * Written only when it actually changes.
     *
     * A custom property on the root element is inherited by everything, so
     * setting it invalidates the whole document's style — and the property it
     * sets changes the page's height, which is the kind of thing that makes a
     * resize observer fire again. Writing unconditionally turns that into a
     * loop that costs a repaint of every card for no change at all.
     */
    let last = -1;
    const apply = () => {
      const height = Math.round(node.getBoundingClientRect().height);
      if (height <= 0 || height === last) return;
      last = height;
      document.documentElement.style.setProperty('--toolbar-height', `${height}px`);
    };

    apply();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', apply);
      dispose.current = () => window.removeEventListener('resize', apply);
      return;
    }
    /*
     * Observed as a border box, which is the difference between working and
     * not.
     *
     * A ResizeObserver watches the *content* box unless told otherwise, and
     * what this element adds around its content is exactly what has to be
     * measured: the pill's own padding and its hairline border. The content box
     * — a row of 44px buttons — never moves, so a default observer would sit
     * there correctly reporting that nothing had changed through every event
     * this exists to catch.
     */
    const observer = new ResizeObserver(apply);
    observer.observe(node, { box: 'border-box' });
    dispose.current = () => observer.disconnect();
  }, []);
}

/** Inline unlock, shown in Setup. Nothing is hidden behind it — only changes. */
export function UnlockCard({ onUnlocked }: { onUnlocked: () => void }) {
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/login', { passphrase });
      setPassphrase('');
      onUnlocked();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" data-testid="unlock-card">
      <div className="section-title" style={{ margin: '0 0 6px' }}>
        Unlock to make changes
      </div>
      <div className="faint" style={{ marginBottom: 8 }}>
        Anyone can look at this page. Changing settings needs your passphrase — that stops a
        stranger from editing your data. You only need to do this once on this phone.
      </div>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="passphrase">Passphrase</label>
          <input
            id="passphrase"
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            autoComplete="current-password"
          />
        </div>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <button className="btn btn-primary" type="submit" disabled={busy || !passphrase} style={{ width: '100%' }}>
          {busy ? 'Checking…' : 'Unlock'}
        </button>
      </form>
    </div>
  );
}
