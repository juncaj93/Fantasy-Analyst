/**
 * The floating toolbar, as a contract.
 *
 * The bottom bar stopped being a full-width band welded to the edge of the
 * screen and became a compact pill floating clear of it. That is a presentation
 * change and nothing else — the same destinations, the same taps, the same
 * screens — so most of what is asserted here is that nothing moved: every
 * destination is still reachable, still named the same thing, still lights up
 * for the screen that is actually showing.
 *
 * Review is not among them, and that is the one thing here that *did* move. It
 * is maintenance and it now lives in Settings, so what this file has to say
 * about it is that it is absent from the bar, that nothing was promoted into
 * the slot it left, and that Settings stays lit while its queue is open — no
 * destination goes dark, and none lights up for a screen that is not showing.
 *
 * The rest is the set of ways a floating bar goes wrong, which is a specific
 * and short list: it covers the last row of a long page, it wraps its labels on
 * a narrow phone, it shrinks its targets below a fingertip, it hovers over the
 * keyboard, it floats on top of a modal, and its selection drifts out of step
 * with the screen. Each of those is a test.
 *
 * Where the app's own geometry is concerned this file asks the page for the
 * numbers rather than hardcoding them, so it keeps working when the design
 * changes its mind about a radius or a gap — and keeps failing when the design
 * loses one of these properties.
 */

import { expect, test, type Page } from '@playwright/test';
import { openReview } from './helpers.ts';

const DESTINATIONS = ['draft', 'team', 'trades', 'players', 'setup'] as const;

/** The screen each destination is supposed to be showing, once it is tapped. */
const SCREEN_OF: Record<(typeof DESTINATIONS)[number], string> = {
  draft: 'draft-nav',
  team: 'league-card',
  trades: 'trades-nav',
  players: 'players-nav',
  setup: 'setup-step-sleeper',
};

async function open(page: Page, tab: (typeof DESTINATIONS)[number]) {
  await page.getByTestId(`tab-${tab}`).click();
  await page.waitForTimeout(350);
}

/**
 * The pill's box, and the numbers the design derives it from.
 *
 * Waited for rather than assumed: the app shows a loading state before it knows
 * whether changes are allowed, and there is no toolbar in the document until
 * that answer arrives.
 */
async function toolbar(page: Page) {
  await page.locator('.tabbar').waitFor({ state: 'attached' });
  return page.evaluate(() => {
    const bar = document.querySelector('.tabbar')!;
    const box = bar.getBoundingClientRect();
    return {
      top: Math.round(box.top),
      bottom: Math.round(box.bottom),
      left: Math.round(box.left),
      width: Math.round(box.width),
      height: Math.round(box.height),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      radius: Number.parseFloat(getComputedStyle(bar).borderTopLeftRadius),
      keyboard: bar.getAttribute('data-keyboard'),
    };
  });
}

test.describe('the destinations', () => {
  test('all five are there, named what they were, and reach their screen', async ({ page }) => {
    await page.goto('/');
    for (const tab of DESTINATIONS) {
      await open(page, tab);
      await expect(page.getByTestId(SCREEN_OF[tab]).first(), `${tab} did not open its screen`).toBeVisible();
    }
  });

  /**
   * Read from the label's own text node, not from the button's rendered text.
   *
   * A destination is a glyph, a word, and sometimes a small mark, and the two
   * engines do not agree about what `innerText` makes of that: an absolutely
   * positioned mark lands on a line of its own in one engine and runs straight
   * on in the other. The word is a text node either way, and that is what this
   * is about.
   */
  test('the labels are still words, not glyphs alone', async ({ page }) => {
    await page.goto('/');
    await page.locator('.tabbar').waitFor({ state: 'attached' });
    const labels = await page.evaluate(() =>
      [...document.querySelectorAll('.tabbar button')].map((b) =>
        [...b.childNodes]
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent?.trim() ?? '')
          .join(''),
      ),
    );
    expect(labels).toEqual(['Draft', 'Team', 'Trades', 'Players', 'Setup']);
  });

  /**
   * One bar, not two.
   *
   * The classic way this change goes wrong is that the old navigation survives
   * underneath the new one — usually invisible on a desktop and stacked on a
   * phone. There is exactly one element carrying the destinations.
   */
  test('there is only one navigation on screen', async ({ page }) => {
    await page.goto('/');
    for (const tab of DESTINATIONS) {
      await open(page, tab);
      await expect(page.locator('.tabbar')).toHaveCount(1);
      await expect(page.getByTestId('tab-draft')).toHaveCount(1);
      await expect(page.locator('nav[aria-label="Main navigation"]')).toHaveCount(1);
    }
  });
});

/**
 * Which destination is lit, and where that fact comes from.
 *
 * The toolbar holds no selection of its own: it is handed the app's current
 * destination and draws it. That is not directly observable, so what is checked
 * is the property it buys — the highlight and the screen can never disagree,
 * including on a screen the toolbar did not open.
 */
test.describe('the active destination', () => {
  test('is exactly one, and it is the screen that is showing', async ({ page }) => {
    await page.goto('/');
    for (const tab of DESTINATIONS) {
      await open(page, tab);
      const current = await page.locator('.tabbar button[aria-current="page"]').all();
      expect(current, `${tab}: exactly one destination may be current`).toHaveLength(1);
      await expect(page.getByTestId(`tab-${tab}`)).toHaveAttribute('aria-current', 'page');
      await expect(page.getByTestId(SCREEN_OF[tab]).first()).toBeVisible();
    }
  });

  /**
   * A nested screen belongs to the destination that opened it.
   *
   * Setup pushes a detail screen over itself. A toolbar keeping its own idea of
   * where it is would either light nothing here or light whatever was tapped
   * last, which is the failure this catches.
   */
  test('stays on the parent while a nested screen is open', async ({ page }) => {
    await page.goto('/');
    await open(page, 'setup');
    await page.getByTestId('setup-step-vegas').click();
    await expect(page.getByTestId('setup-detail-vegas')).toBeVisible();

    await expect(page.getByTestId('tab-setup')).toHaveAttribute('aria-current', 'page');
    expect(await page.locator('.tabbar button[aria-current="page"]').count()).toBe(1);

    await page.getByTestId('back-button').click();
    await expect(page.getByTestId('setup-step-vegas')).toBeVisible();
    await expect(page.getByTestId('tab-setup')).toHaveAttribute('aria-current', 'page');
  });

  /**
   * The destination the app chose, not the one you tapped.
   *
   * This is the test that actually pins "the toolbar holds no selection of its
   * own". Everywhere else in the app a tap and the current screen change
   * together, so a toolbar keeping a private copy would look identical — the
   * copy only drifts when something *other than a tap* moves the app, and there
   * is exactly one such path: a first-time reader with no league selected is
   * landed on Setup. The overview is answered with "no league" to reach it.
   *
   * A toolbar that remembered where it was would light Draft here, over a Setup
   * screen.
   */
  test('follows the app when the app navigates on its own', async ({ page }) => {
    await page.route('**/api/overview', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ json: { ...body, selectedLeague: null } });
    });

    await page.goto('/');
    await expect(page.getByTestId('setup-step-sleeper')).toBeVisible();
    await expect(page.getByTestId('tab-setup')).toHaveAttribute('aria-current', 'page');
    expect(await page.locator('.tabbar button[aria-current="page"]').count()).toBe(1);
    await expect(page.getByTestId('tab-draft')).not.toHaveAttribute('aria-current', 'page');
    await page.unroute('**/api/overview');
  });

  test('survives tapping the destination you are already on', async ({ page }) => {
    await page.goto('/');
    await open(page, 'players');
    await page.getByTestId('tab-players').click();
    await expect(page.getByTestId('tab-players')).toHaveAttribute('aria-current', 'page');
    expect(await page.locator('.tabbar button[aria-current="page"]').count()).toBe(1);
  });

  /**
   * The bar must not move when the selection does.
   *
   * A selected state that widens its own destination — a filled pill, a grown
   * label — reflows the other five, and a bottom bar that jiggles on every tap
   * is the loudest thing on a phone screen.
   */
  test('changes nothing about the toolbar’s geometry', async ({ page }) => {
    await page.goto('/');
    const shapes = [];
    const buttons = [];
    for (const tab of DESTINATIONS) {
      await open(page, tab);
      shapes.push(await toolbar(page));
      buttons.push(
        await page.evaluate(() =>
          [...document.querySelectorAll('.tabbar button')].map((b) => Math.round(b.getBoundingClientRect().width)),
        ),
      );
    }
    for (const shape of shapes) expect(shape).toEqual(shapes[0]);
    for (const widths of buttons) expect(widths).toEqual(buttons[0]);
  });
});

/**
 * The selected destination, which is foreground and nothing else.
 *
 * The bar shipped a diffuse lift in its own surface behind the destination that
 * was showing, and a physical-iPhone review threw it out: the capsule is
 * already a material, and a second atmospheric treatment inside it reads as
 * fuzz beside an app that is otherwise crisp. What replaced it is what a native
 * bottom bar does — the accent colour, a heavier glyph, a heavier word — and
 * what is asserted here is that it really is only that: nothing is painted
 * behind any destination, the three cues all land on the one `aria-current`
 * names, they are readable in both themes, they cost the bar no layout, and the
 * focus ring the clip used to nip is back outside the destination and visible.
 */
test.describe('the selected destination', () => {
  /**
   * Everything each destination paints, and the capsule's clipping, as the
   * browser resolved it.
   *
   * Both pseudo-elements as well as the button's own box, because "no surface
   * behind the selection" is a claim about anything that could draw one, and a
   * reintroduced wash is as likely to arrive on `::after` as on `::before`.
   */
  async function paint(page: Page) {
    await page.locator('.tabbar').waitFor({ state: 'attached' });
    return page.evaluate(() => {
      const surface = (s: CSSStyleDeclaration) => ({
        colour: s.backgroundColor,
        image: s.backgroundImage,
        shadow: s.boxShadow,
        content: s.content,
      });
      const bar = document.querySelector('.tabbar')!;
      return {
        clip: getComputedStyle(bar).overflow,
        tabs: [...bar.querySelectorAll('button')].map((b) => ({
          id: (b as HTMLElement).dataset.testid,
          current: b.getAttribute('aria-current') === 'page',
          own: surface(getComputedStyle(b)),
          before: surface(getComputedStyle(b, '::before')),
          after: surface(getComputedStyle(b, '::after')),
        })),
      };
    });
  }

  /** Nothing at all, on any of the three layers a destination could draw on. */
  function drawsNothing(tab: Awaited<ReturnType<typeof paint>>['tabs'][number]) {
    const blank = (s: { colour: string; image: string; shadow: string; content: string }) =>
      s.image === 'none' &&
      s.shadow === 'none' &&
      /^rgba\(0, 0, 0, 0\)$|^transparent$/.test(s.colour);
    return (
      blank(tab.own) &&
      (tab.before.content === 'none' || blank(tab.before)) &&
      (tab.after.content === 'none' || blank(tab.after))
    );
  }

  /**
   * No pill, no tray, no bloom — on the selected destination or on any other.
   *
   * This is the whole of the correction, stated as the thing that would undo
   * it. The selection is carried in front of the material, so the material
   * behind every destination is the capsule's and only the capsule's, and the
   * one that is showing paints no more of its own than the five that are not.
   */
  test('paints no surface of its own, and neither does any other', async ({ page }) => {
    await page.goto('/');
    for (const tab of DESTINATIONS) {
      await open(page, tab);
      const { tabs } = await paint(page);
      expect(tabs.filter((t) => t.current).map((t) => t.id), `${tab}: exactly one destination is current`).toEqual([
        `tab-${tab}`,
      ]);
      for (const t of tabs) {
        expect(drawsNothing(t), `${tab}: ${t.id} draws a surface of its own — ${JSON.stringify(t)}`).toBe(true);
      }
    }
  });

  /**
   * The selection is a repaint, and the selected destination is the same object
   * as an unselected one.
   *
   * Compared rather than asserted against a value: whatever the bar decides its
   * resting material is, the destination that is showing has to have exactly
   * the same one. A pill, a tray, a tint or a wash reintroduced for the
   * selected state alone fails here without this test having to know what shape
   * it arrived in.
   */
  test('has the same material as the destinations either side of it', async ({ page }) => {
    await page.goto('/');
    await open(page, 'players');
    const { tabs } = await paint(page);
    const lit = tabs.find((t) => t.current)!;
    for (const resting of tabs.filter((t) => !t.current)) {
      expect(
        { own: lit.own, before: lit.before, after: lit.after },
        `the selected destination is a different surface from ${resting.id}`,
      ).toEqual({ own: resting.own, before: resting.before, after: resting.after });
    }
  });

  /**
   * The tap lands on the destination, and the accessible name is the word.
   *
   * Both survive from the bloom's own contract and are worth keeping without
   * it: the selected state must not put anything between a thumb and the
   * button, and it must not put a stray word — "selected", a pseudo-element's
   * `content` — into the accessible name. `aria-current` is what carries the
   * sentence, which matters more now that there is one visual cue fewer.
   */
  test('takes the tap itself, and adds no words', async ({ page }) => {
    await page.goto('/');
    await open(page, 'players');

    const hit = await page.evaluate(() => {
      const box = document.querySelector('[data-testid="tab-players"]')!.getBoundingClientRect();
      const el = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return el?.closest('button')?.getAttribute('data-testid');
    });
    expect(hit).toBe('tab-players');
    await expect(page.getByTestId('tab-players')).toHaveAccessibleName('Players');
    await expect(page.getByTestId('tab-players')).toHaveAttribute('aria-current', 'page');
  });

  /**
   * Readable in both themes, and free.
   *
   * With the wash gone the whole of the selected state is foreground, so what
   * has to hold is that the foreground is legible: the selected word is a
   * different colour from the resting one, and both are readable against the
   * material they sit on. A number rather than an eye, because "clearly
   * accented" and "washed-out grey" are a tuning pass apart in Light and
   * "readable accent" and "neon" are a tuning pass apart in Dark.
   *
   * The contrast is computed against the capsule composited over the page, and
   * the two themes are checked separately because they are tuned separately.
   *
   * The same visit answers the other half of it: the bar's box is measured with
   * the selection on this destination and on its neighbour, and it is the same
   * box — a repaint can no more move a destination than the shadow under the
   * pill can.
   */
  for (const theme of ['light', 'dark'] as const) {
    test(`is legible in ${theme}, and costs the bar no layout`, async ({ page }) => {
      await page.goto('/');
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      await open(page, 'team');
      await expect(page.getByTestId('tab-team')).toHaveAttribute('aria-current', 'page');

      const read = () =>
        page.evaluate(() => {
          /** sRGB relative luminance, per WCAG. */
          const parse = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
          const lum = ([r, g, b]: number[]) => {
            const lin = [r!, g!, b!].map((v) => {
              const s = v / 255;
              return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
            });
            return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
          };
          /** `over` seen through `c`'s own alpha. */
          const flatten = (c: string, over: number[]) => {
            const [r, g, b, a = 1] = parse(c);
            return [r!, g!, b!].map((v, i) => v * a! + over[i]! * (1 - a!));
          };
          const bar = document.querySelector('.tabbar')!;
          // The page is opaque, so the capsule's own alpha is the only one that
          // has to be resolved to know what the label is actually sitting on.
          const beneath = flatten(getComputedStyle(document.body).backgroundColor, [255, 255, 255]);
          const material = flatten(getComputedStyle(bar).backgroundColor, beneath);
          const contrast = (ink: string) => {
            const a = lum(flatten(ink, material));
            const b = lum(material);
            return +(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2));
          };
          const box = bar.getBoundingClientRect();
          return {
            box: [box.width, box.height, box.x, box.y].map(Math.round),
            tabs: [...bar.querySelectorAll('button')].map((b) => ({
              id: (b as HTMLElement).dataset.testid,
              current: b.getAttribute('aria-current') === 'page',
              colour: getComputedStyle(b).color,
              contrast: contrast(getComputedStyle(b).color),
            })),
          };
        });

      const shown = await read();
      const lit = shown.tabs.find((t) => t.current)!;
      const resting = shown.tabs.find((t) => !t.current)!;

      expect(lit.colour, `${theme}: the selected destination is the same colour as the rest`).not.toBe(resting.colour);
      expect(lit.contrast, `${theme}: the selected word reads at ${lit.contrast}:1 on the bar`).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(resting.contrast, `${theme}: an unselected word reads at ${resting.contrast}:1`).toBeGreaterThanOrEqual(3);

      // …and moving the selection along the bar moved nothing.
      await open(page, 'players');
      await expect(page.getByTestId('tab-players')).toHaveAttribute('aria-current', 'page');
      expect((await read()).box, `${theme}: the selection moved the bar`).toEqual(shown.box);
      await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
    });
  }

  /**
   * The selected word is heavier, and it still fits.
   *
   * The label is asked for at 680 rather than 600 when its destination is the
   * one showing, so the selection is carried by weight as well as by colour.
   * That is the one thing in the selected state that a longer word could
   * quietly break: the destination is a fixed `--tab-w` and the label does not
   * wrap, so a word that outgrows its column does not reflow the bar — it runs
   * under the destination beside it, which no layout assertion would catch.
   *
   * Measured at whatever width the project is running, which is the point of
   * running the suite at four of them, and with every destination taking its
   * turn at being the selected one.
   */
  test('draws the selected label heavier without outgrowing its destination', async ({ page }) => {
    await page.goto('/');
    for (const tab of DESTINATIONS) {
      await open(page, tab);
      const row = await page.evaluate(() =>
        [...document.querySelectorAll('.tabbar button')].map((b) => {
          const label = [...b.childNodes].find((n) => n.nodeType === Node.TEXT_NODE)!;
          const range = document.createRange();
          range.selectNodeContents(label);
          return {
            id: (b as HTMLElement).dataset.testid,
            current: b.getAttribute('aria-current') === 'page',
            weight: Number.parseInt(getComputedStyle(b).fontWeight, 10),
            stroke: Number.parseFloat(getComputedStyle(b.querySelector('svg')!).strokeWidth),
            colour: getComputedStyle(b).color,
            slack: +(b.getBoundingClientRect().width - range.getBoundingClientRect().width).toFixed(2),
          };
        }),
      );
      const lit = row.find((r) => r.current)!;
      const resting = row.find((r) => !r.current)!;
      expect(lit.weight, `${tab}: the selected word is no heavier than the rest`).toBeGreaterThan(resting.weight);
      expect(lit.stroke, `${tab}: the selected glyph is no heavier than the rest`).toBeGreaterThan(resting.stroke);
      expect(lit.colour, `${tab}: the selected destination is the same colour as the rest`).not.toBe(resting.colour);
      for (const r of row) {
        expect(r.slack, `${r.id} has ${r.slack}px of room for its label`).toBeGreaterThan(0);
      }
    }
  });

  /**
   * Focus is visible, and it is the ring every other control draws.
   *
   * It was briefly drawn *inside* the destination, and only because the capsule
   * had to clip its descendants to bound the bloom — a clip does not know a
   * decoration from a focus ring, and outside the button an outset ring came
   * back nipped at the two ends of the bar. The bloom and the clip are both
   * gone, so this asserts the ring is back where the shared rule puts it and
   * that nothing is clipping it.
   *
   * Checked at the first and last destination, which are the two the capsule's
   * own curve runs closest to and the two that failed under the clip. The
   * capture is deliberately wider than the button: an outset ring is drawn
   * entirely outside the element's box, so a screenshot of the element alone
   * would show nothing either way.
   */
  test('draws the shared focus ring outside the destination, unclipped at either end', async ({ page }) => {
    await page.goto('/');
    await page.locator('.tabbar').waitFor({ state: 'attached' });

    expect(
      (await paint(page)).clip,
      'the capsule clips its descendants again, which is what nips the ring',
    ).toBe('visible');

    const ends = [DESTINATIONS[0]!, DESTINATIONS[DESTINATIONS.length - 1]!];
    for (const tab of ends) {
      const button = page.getByTestId(`tab-${tab}`);
      /** The button and the band around it the ring is drawn into. */
      const around = async () => {
        const box = (await button.boundingBox())!;
        const pad = 8;
        return page.screenshot({
          clip: {
            x: Math.max(0, box.x - pad),
            y: Math.max(0, box.y - pad),
            width: box.width + 2 * pad,
            height: box.height + 2 * pad,
          },
        });
      };

      const before = await around();
      /*
       * `:focus-visible` is about how focus arrived, not that it did — a button
       * focused after a tap does not draw a ring, and should not. One keystroke
       * makes the keyboard the way the reader is working; the destination is
       * then focused directly rather than tabbed to, because how many stops
       * there are between the top of the page and the bar is a fact about the
       * screen that happens to be showing.
       */
      await page.keyboard.press('Tab');
      await button.evaluate((b: HTMLElement) => b.focus());
      expect(await button.evaluate((b) => b.matches(':focus-visible')), `${tab}: the ring never came up`).toBe(true);

      const ring = await button.evaluate((b) => getComputedStyle(b).boxShadow);
      expect(ring, `${tab}: focus is not suppressed`).not.toBe('none');
      expect(ring, `${tab}: the ring is drawn outside the destination, as everywhere else`).not.toContain('inset');
      expect((await around()).equals(before), `${tab}: focus draws nothing outside the destination`).toBe(false);

      await button.evaluate((b: HTMLElement) => b.blur());
    }
  });
});

test.describe('shape and reach', () => {
  test('is a compact floating pill, not a full-width band', async ({ page }) => {
    await page.goto('/');
    const bar = await toolbar(page);
    // Narrower than the screen, with real margin either side — 20px is the
    // least that reads as floating rather than as a band with a gutter.
    expect(bar.width, `the bar is ${bar.width}px on a ${bar.viewportWidth}px screen`).toBeLessThanOrEqual(
      bar.viewportWidth - 40,
    );

    /*
     * And it is that width because of what is in it, not because something set
     * one. A bar stretched to the screen and then inset by a margin looks
     * similar and is not the same thing: its destinations drift apart as the
     * phone gets wider, and it stops being sized by its own contents.
     */
    const packed = await page.evaluate(() => {
      const bar = document.querySelector('.tabbar')!;
      const style = getComputedStyle(bar);
      const chrome =
        Number.parseFloat(style.paddingLeft) +
        Number.parseFloat(style.paddingRight) +
        Number.parseFloat(style.borderLeftWidth) +
        Number.parseFloat(style.borderRightWidth);
      const buttons = [...bar.querySelectorAll('button')].reduce((sum, b) => sum + b.getBoundingClientRect().width, 0);
      return Math.round(bar.getBoundingClientRect().width - (buttons + chrome));
    });
    expect(packed, 'the pill has slack in it, so it is stretched rather than packed').toBeLessThanOrEqual(2);
    // Clear of the bottom edge, and only just.
    expect(bar.bottom).toBeLessThan(bar.viewportHeight);
    expect(bar.viewportHeight - bar.bottom).toBeLessThanOrEqual(20);
    // Icon plus label, and nothing spent on chrome around them.
    expect(bar.height).toBeGreaterThanOrEqual(54);
    expect(bar.height).toBeLessThanOrEqual(64);
    expect(bar.radius, 'a floating control is rounded').toBeGreaterThanOrEqual(16);
  });

  test('every destination is a full target and none of them wraps', async ({ page }) => {
    await page.goto('/');
    for (const tab of DESTINATIONS) {
      const box = (await page.getByTestId(`tab-${tab}`).boundingBox())!;
      expect(box.height, `${tab} is ${box.height}px tall`).toBeGreaterThanOrEqual(44);
      expect(box.width, `${tab} is ${box.width}px wide`).toBeGreaterThanOrEqual(44);
    }
    // A wrapped label doubles the line count, which is the observable symptom.
    const lines = await page.evaluate(() =>
      [...document.querySelectorAll('.tabbar button')].map((b) => {
        const label = [...b.childNodes].find((n) => n.nodeType === Node.TEXT_NODE);
        const range = document.createRange();
        range.selectNodeContents(label!);
        return range.getClientRects().length;
      }),
    );
    for (const count of lines) expect(count, 'a label wrapped onto a second line').toBe(1);
  });

  test('leaves nothing of the page hidden behind it', async ({ page }) => {
    await page.goto('/');
    for (const tab of ['draft', 'players', 'trades', 'setup'] as const) {
      await open(page, tab);
      // Scroll until the page stops moving: the reservation changes the
      // document height, so one scroll to a height measured before it lands
      // stops short of the real bottom.
      for (let i = 0; i < 6; i++) {
        const moved = await page.evaluate(() => {
          const before = window.scrollY;
          window.scrollTo(0, document.documentElement.scrollHeight);
          return window.scrollY !== before;
        });
        if (!moved) break;
        await page.waitForTimeout(150);
      }
      const clear = await page.evaluate(() => {
        const bar = document.querySelector('.tabbar')!.getBoundingClientRect();
        const main = document.querySelector('.app-main')!;
        const last = main.lastElementChild?.getBoundingClientRect() ?? null;
        return { barTop: Math.round(bar.top), lastBottom: last ? Math.round(last.bottom) : null };
      });
      if (clear.lastBottom !== null) {
        expect(clear.lastBottom, `${tab}: the last thing on the page sits under the toolbar`).toBeLessThanOrEqual(
          clear.barTop,
        );
      }
    }
  });
});

/**
 * The keyboard.
 *
 * iOS shrinks the *visual* viewport for the keyboard and leaves the layout one
 * alone, so a bar correctly pinned to the bottom of the page ends up floating
 * over the field being typed into. Playwright cannot raise a soft keyboard, so
 * the signal the app actually reads is stood in for: a visual viewport that
 * reports itself several hundred pixels shorter than the page. Everything
 * downstream of that signal is real.
 */
test.describe('the keyboard', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      /*
       * Stands in for `window.visualViewport`, which cannot be resized from
       * outside the browser. It reports the page's own height until a test says
       * otherwise, so a page with no keyboard reads exactly as it really does.
       */
      let hidden = 0;
      const fake = new EventTarget();
      Object.defineProperties(fake, {
        height: { get: () => window.innerHeight - hidden },
        offsetTop: { get: () => 0 },
      });
      Object.defineProperty(window, 'visualViewport', { value: fake, configurable: true });
      Object.defineProperty(window, '__keyboard', {
        configurable: true,
        value: (px: number) => {
          hidden = px;
          fake.dispatchEvent(new Event('resize'));
        },
      });
    });
  });

  test('the toolbar leaves while it is up, and comes back when it goes', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.tabbar')).toHaveAttribute('data-keyboard', 'closed');
    await expect(page.getByTestId('tab-draft')).toBeVisible();

    await page.evaluate(() => (window as unknown as { __keyboard: (px: number) => void }).__keyboard(336));
    await expect(page.locator('.tabbar')).toHaveAttribute('data-keyboard', 'open');
    // Gone from the screen and gone from the tab order, not merely faded.
    await expect(page.getByTestId('tab-draft')).toBeHidden();

    await page.evaluate(() => (window as unknown as { __keyboard: (px: number) => void }).__keyboard(0));
    await expect(page.locator('.tabbar')).toHaveAttribute('data-keyboard', 'closed');
    await expect(page.getByTestId('tab-draft')).toBeVisible();
  });

  /*
   * Safari's own chrome collapsing as the page scrolls moves the two viewports
   * relative to each other by a few tens of pixels. A bar that hid for that
   * would flicker on every scroll, which is worse than one that never moves.
   */
  test('ignores the browser’s own chrome coming and going', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('tab-draft')).toBeVisible();
    await page.evaluate(() => (window as unknown as { __keyboard: (px: number) => void }).__keyboard(60));
    await page.waitForTimeout(200);
    await expect(page.locator('.tabbar')).toHaveAttribute('data-keyboard', 'closed');
    await expect(page.getByTestId('tab-draft')).toBeVisible();
  });

  test('the Draft search still opens and still filters with it up', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('board-list')).toBeVisible();
    await page.getByTestId('draft-search-open').click();
    await page.evaluate(() => (window as unknown as { __keyboard: (px: number) => void }).__keyboard(336));

    const field = page.getByTestId('draft-search');
    await expect(field).toBeVisible();
    await field.fill('sotelo');
    await expect(page.getByTestId('recommendation-row')).toHaveCount(1);
    // …and the toolbar is not sitting on top of the field.
    await expect(page.locator('.tabbar')).toHaveAttribute('data-keyboard', 'open');
  });
});

/**
 * A sheet is in front, and nothing behind it is tappable.
 *
 * A floating bar with a shadow is exactly the kind of element that ends up on
 * top of a modal, because it looks like it should be. It must not be, and its
 * destinations must not be reachable through the backdrop.
 */
test.describe('modal layering', () => {
  test('the toolbar is behind the sheet and takes no taps through it', async ({ page }) => {
    await page.goto('/');
    await openReview(page);
    await page.getByTestId('scoring-key-open').click();
    await expect(page.getByTestId('scoring-key')).toBeVisible();

    const order = await page.evaluate(() => ({
      bar: Number.parseInt(getComputedStyle(document.querySelector('.tabbar')!).zIndex, 10),
      backdrop: Number.parseInt(getComputedStyle(document.querySelector('.sheet-backdrop')!).zIndex, 10),
      sheet: Number.parseInt(getComputedStyle(document.querySelector('.sheet')!).zIndex, 10),
    }));
    expect(order.bar).toBeLessThan(order.backdrop);
    expect(order.backdrop).toBeLessThan(order.sheet);

    /*
     * And the arithmetic is not the claim — what is on top at the pixel is.
     * A destination is picked and the document asked what is actually there.
     */
    const covered = await page.evaluate(() => {
      const box = document.querySelector('[data-testid="tab-draft"]')!.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return hit?.closest('.tabbar') === null;
    });
    expect(covered, 'a tap where a destination is would reach the toolbar').toBe(true);

    // The sheet is still the thing on screen, and Settings — which is where
    // Review is — is still the current destination.
    await expect(page.getByTestId('scoring-key')).toBeVisible();
    await expect(page.getByTestId('tab-setup')).toHaveAttribute('aria-current', 'page');
    await page.getByTestId('sheet-close').click();
  });

  test('no navigation is duplicated inside the sheet', async ({ page }) => {
    await page.goto('/');
    await openReview(page);
    await page.getByTestId('scoring-key-open').click();
    await expect(page.getByTestId('scoring-key')).toBeVisible();
    await expect(page.getByTestId('scoring-key').locator('.tabbar')).toHaveCount(0);
    await page.getByTestId('sheet-close').click();
  });
});

/**
 * Draft is seasonal, and it is the only destination that is.
 *
 * The regular season is stood in for at the one place the app reads it — the
 * overview's `season` block — which is exactly how the real transition arrives:
 * Sleeper's `/state/nfl` flips, the server resolves it, and the client is told.
 * Everything downstream of that answer is real.
 *
 * Both directions are asserted, because the expensive failure is not "the tab
 * stayed too long" — it is a user losing their board in the middle of August.
 */
test.describe('Draft, once the regular season starts', () => {
  /** Answer the overview as if week one had kicked off. */
  async function inRegularSeason(page: Page) {
    await page.route('**/api/overview', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        json: {
          ...body,
          season: { phase: 'regular', draftVisible: false, reason: 'week 1', assumed: false },
        },
      });
    });
  }

  test('is in the bar before the season starts', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('tab-draft')).toBeVisible();
    expect(await page.locator('.tabbar button').count()).toBe(5);
  });

  /**
   * Draft leaves and Waivers arrives in the same slot.
   *
   * The count is unchanged at five, deliberately: the seasonal slot is one slot,
   * and a bar that briefly carried both would be six destinations on a 360px
   * phone. Where Waivers sits is asserted in `waivers.spec.ts`.
   */
  test('leaves the bar once the season is under way', async ({ page }) => {
    await inRegularSeason(page);
    await page.goto('/');
    await expect(page.getByTestId('tab-team')).toBeVisible();
    await expect(page.getByTestId('tab-draft')).toHaveCount(0);
    await expect(page.getByTestId('tab-waivers')).toBeVisible();
    expect(await page.locator('.tabbar button').count()).toBe(5);
    // The other four are all still there, named what they were.
    for (const tab of ['team', 'trades', 'players', 'setup'] as const) {
      await expect(page.getByTestId(`tab-${tab}`)).toBeVisible();
    }
  });

  /**
   * The bar repacks; it does not leave a hole where Draft was.
   *
   * Measured the same way the five-destination bar is: the pill is as wide as
   * what is in it, with no slack, and it is still centred and still clear of
   * the edges. A bar that kept an empty slot would be wider than its contents.
   */
  test('rebalances with no gap and stays a centred floating pill', async ({ page }) => {
    await inRegularSeason(page);
    await page.goto('/');
    await expect(page.getByTestId('tab-team')).toBeVisible();

    const bar = await toolbar(page);
    expect(bar.width).toBeLessThanOrEqual(bar.viewportWidth - 40);
    expect(bar.bottom).toBeLessThan(bar.viewportHeight);
    expect(bar.height).toBeGreaterThanOrEqual(54);
    expect(bar.height).toBeLessThanOrEqual(64);

    const geometry = await page.evaluate(() => {
      const el = document.querySelector('.tabbar')!;
      const style = getComputedStyle(el);
      const chrome =
        Number.parseFloat(style.paddingLeft) +
        Number.parseFloat(style.paddingRight) +
        Number.parseFloat(style.borderLeftWidth) +
        Number.parseFloat(style.borderRightWidth);
      const box = el.getBoundingClientRect();
      const buttons = [...el.querySelectorAll('button')].map((b) => b.getBoundingClientRect());
      return {
        slack: Math.round(box.width - (buttons.reduce((sum, b) => sum + b.width, 0) + chrome)),
        centreOffset: Math.round(Math.abs(box.left + box.width / 2 - window.innerWidth / 2)),
        // The largest horizontal gap between neighbouring destinations.
        biggestGap: Math.round(
          Math.max(...buttons.slice(1).map((b, i) => b.left - buttons[i]!.right)),
        ),
        minWidth: Math.round(Math.min(...buttons.map((b) => b.width))),
        minHeight: Math.round(Math.min(...buttons.map((b) => b.height))),
      };
    });
    expect(geometry.slack, 'the pill is stretched rather than packed').toBeLessThanOrEqual(2);
    expect(geometry.centreOffset, 'the bar is no longer centred').toBeLessThanOrEqual(1);
    expect(geometry.biggestGap, 'an empty Draft slot was left behind').toBeLessThanOrEqual(2);
    // Still a fingertip each.
    expect(geometry.minWidth).toBeGreaterThanOrEqual(44);
    expect(geometry.minHeight).toBeGreaterThanOrEqual(44);
  });

  /** The app opens somewhere that is in the bar, and lights it. */
  test('opens on Team instead, with exactly one destination current', async ({ page }) => {
    await inRegularSeason(page);
    await page.goto('/');
    await expect(page.getByTestId('tab-team')).toHaveAttribute('aria-current', 'page');
    expect(await page.locator('.tabbar button[aria-current="page"]').count()).toBe(1);
    await expect(page.getByTestId('league-card').first()).toBeVisible();
  });

  /**
   * Hiding the destination did not delete the screen.
   *
   * The board is still rendered when the app is on it — the tab is a way in,
   * not the only thing keeping the route alive — and the browser's own
   * navigation behaves exactly as it always did, because the app still pushes
   * no history of its own.
   */
  test('keeps the Draft screen itself reachable', async ({ page }) => {
    await inRegularSeason(page);
    await page.goto('/');
    await expect(page.getByTestId('tab-team')).toBeVisible();

    // The board is still built and still served: hiding a destination is a
    // navigation change, and it deleted no route and no historical draft data.
    const board = await (await page.request.get('/api/drafts/demo-draft/board?limit=5')).json();
    expect(board.recommendations.length).toBeGreaterThan(0);

    const before = await page.evaluate(() => window.history.length);
    await page.getByTestId('tab-players').click();
    await expect(page.getByTestId('tab-players')).toHaveAttribute('aria-current', 'page');
    expect(await page.evaluate(() => window.history.length), 'a tab is not a page').toBe(before);
    expect(new URL(page.url()).pathname).toBe('/');
  });

  test('comes back when the season answer does', async ({ page }) => {
    await inRegularSeason(page);
    await page.goto('/');
    await expect(page.getByTestId('tab-draft')).toHaveCount(0);

    await page.unroute('**/api/overview');
    await page.reload();
    await expect(page.getByTestId('tab-draft')).toBeVisible();
  });
});

test.describe('reduced motion', () => {
  test('the toolbar still arrives and leaves, without animating', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await expect(page.getByTestId('tab-draft')).toBeVisible();
    const seconds = await page.evaluate(() =>
      Number.parseFloat(getComputedStyle(document.querySelector('.tabbar')!).transitionDuration),
    );
    expect(seconds, 'nothing should be animating under reduced motion').toBeLessThanOrEqual(0.001);

    // …and it is still a working navigation.
    await page.getByTestId('tab-team').click();
    await expect(page.getByTestId('tab-team')).toHaveAttribute('aria-current', 'page');
  });
});

/**
 * Matchup, once the draft is finished.
 *
 * The third seasonal destination, and the one that takes the bar to its widest.
 *
 * All three seasonal slots settle on the same event. Draft leaves at the final
 * pick — the board exists to help make picks and the picks are made — Waivers
 * takes the slot it shares with it, and Matchup arrives because there is at
 * last a team to project. Five becomes six and stays there.
 *
 * Six is the most this bar ever carries, so the two things asserted here are
 * the ones that would break: no label goes to a second line, and no destination
 * shrinks below a fingertip. Both are checked at whichever width the project is
 * running, which is the point of running the suite at four of them.
 */
test.describe('Matchup, once the draft is finished', () => {
  /**
   * Answer the overview as if the draft were complete and week one pending.
   *
   * Both halves are overridden, and they have to be: the toolbar reads
   * `season.draftVisible` for the Draft/Waivers slot and `lifecycle` for
   * Matchup, so a fixture that moved only one of them would describe a bar the
   * server can no longer produce. They agree by construction in
   * `core/sleeper/phase.ts`; this keeps the fixture honest about that.
   */
  async function postDraft(page: Page) {
    await page.route('**/api/overview', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        json: {
          ...body,
          season: {
            ...(body.season ?? {}),
            phase: 'preseason',
            draftVisible: false,
            reason: 'your draft is finished — the board has nothing left to decide',
          },
          lifecycle: {
            ...(body.lifecycle ?? {}),
            lifecycle: 'post_draft',
            draftVisible: false,
            matchupVisible: true,
          },
        },
      });
    });
  }

  test('is absent while the draft is still running', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('tab-draft')).toBeVisible();
    await expect(page.getByTestId('tab-matchup')).toHaveCount(0);
  });

  test('arrives beside Team once the draft is complete, and Draft leaves with it', async ({ page }) => {
    await postDraft(page);
    await page.goto('/');
    await expect(page.getByTestId('tab-matchup')).toBeVisible();
    expect(await page.locator('.tabbar button').count()).toBe(6);

    const labels = await page.evaluate(() =>
      [...document.querySelectorAll('.tabbar button')].map((b) =>
        [...b.childNodes]
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent?.trim() ?? '')
          .join(''),
      ),
    );
    /*
     * Three things happen on the final pick and this is all of them: Draft
     * leaves, Waivers takes its slot, and Matchup arrives. The bar carries six,
     * which is the most it ever carries and why the layout assertions below are
     * the widest case there is.
     */
    expect(labels).toEqual(['Team', 'Matchup', 'Waivers', 'Trades', 'Players', 'Setup']);
    await expect(page.getByTestId('tab-draft')).toHaveCount(0);
  });

  test('carries six without wrapping a label or shrinking a target', async ({ page }) => {
    await postDraft(page);
    await page.goto('/');
    await expect(page.getByTestId('tab-matchup')).toBeVisible();

    for (const tab of ['team', 'matchup', 'waivers', 'trades', 'players', 'setup'] as const) {
      const box = (await page.getByTestId(`tab-${tab}`).boundingBox())!;
      expect(box.height, `${tab} is ${box.height}px tall`).toBeGreaterThanOrEqual(44);
      expect(box.width, `${tab} is ${box.width}px wide`).toBeGreaterThanOrEqual(44);
    }

    const lines = await page.evaluate(() =>
      [...document.querySelectorAll('.tabbar button')].map((b) => {
        const label = [...b.childNodes].find((n) => n.nodeType === Node.TEXT_NODE);
        const range = document.createRange();
        range.selectNodeContents(label!);
        return range.getClientRects().length;
      }),
    );
    for (const count of lines) expect(count, 'a label wrapped onto a second line').toBe(1);

    const bar = await toolbar(page);
    expect(bar.width, 'the bar has outgrown the screen').toBeLessThanOrEqual(bar.viewportWidth - 16);
    expect(bar.left, 'the bar is no longer centred').toBeGreaterThan(0);
  });

  /**
   * …and the widest bar costs nothing, at any supported width.
   *
   * This used to assert the opposite. A seventh destination did not fit at
   * 374px and under, so the stylesheet took two points off the pill's own
   * padding to make the last of it fit and the bar came out 52 rather than 56 —
   * a deliberate trade, written at the rule, that nothing local was watching
   * until the live league grew its seventh destination and only the production
   * smoke suite noticed.
   *
   * Review moving into Settings gave that slot back. Six is now the widest the
   * bar ever gets and six fit at their full width on the narrowest phone this
   * app supports, so there is no trade left to make: the pill is the same height
   * everywhere, out of the same padding, with the targets untouched. That is a
   * number worth failing on for exactly the reason the old one was.
   */
  test('is the same height at every width, having nothing left to trade', async ({ page }) => {
    await postDraft(page);
    await page.goto('/');
    await expect(page.getByTestId('tab-matchup')).toBeVisible();

    const bar = await toolbar(page);
    const count = await page.locator('.tabbar button').count();
    expect(count).toBe(6);

    expect(bar.height, `a six-destination bar is ${bar.height}px at ${bar.viewportWidth}px`).toBe(56);

    // Sampled at both ends of the bar and in the middle, which is where a
    // destination being paid for out of the targets would show up.
    for (const tab of ['team', 'matchup', 'setup'] as const) {
      const box = (await page.getByTestId(`tab-${tab}`).boundingBox())!;
      expect(box.height, `${tab} gave up a fingertip`).toBeGreaterThanOrEqual(44);
    }
  });

  /**
   * The glyph is a drawing, not a word in a ring.
   *
   * Matchup used to be `VS` inside a circle, and it was the only mark in the
   * bar that was either of those things: the other five are open outlines, and
   * a coin with a wordmark stamped on it reads as a badge dropped into the row.
   * It is now two brackets facing each other across a centre line.
   *
   * What is asserted is what would bring the coin back — text of any kind, a
   * closed ring, a fill — plus the name, because a glyph swap is exactly the
   * change that quietly takes an accessible name with it.
   */
  test('carries no letters and no ring, and is still called Matchup', async ({ page }) => {
    await postDraft(page);
    await page.goto('/');
    await expect(page.getByTestId('tab-matchup')).toBeVisible();

    const glyph = await page.getByTestId('tab-matchup').evaluate((tab) => {
      const svg = tab.querySelector('svg')!;
      const marks = [...svg.querySelectorAll('*')];
      return {
        tags: marks.map((m) => m.tagName.toLowerCase()),
        text: (svg.textContent ?? '').trim(),
        fills: marks.map((m) => getComputedStyle(m).fill),
        caps: marks.map((m) => getComputedStyle(m).strokeLinecap),
        joins: marks.map((m) => getComputedStyle(m).strokeLinejoin),
        hidden: tab.querySelector('.tab-glyph')!.getAttribute('aria-hidden'),
      };
    });
    expect(glyph.tags, 'the Matchup glyph is three open strokes').toEqual(['path', 'path', 'path']);
    expect(glyph.text, 'no wordmark survives in the glyph').toBe('');
    for (const fill of glyph.fills) expect(fill, 'the family is drawn, never filled').toBe('none');
    for (const cap of glyph.caps) expect(cap).toBe('round');
    for (const join of glyph.joins) expect(join).toBe('round');
    expect(glyph.hidden, 'the glyph is decoration; the word beside it is the name').toBe('true');

    // …and no `VS` anywhere in the bar, glyph or otherwise.
    const bar = await page.locator('.tabbar').innerText();
    expect(bar).not.toContain('VS');
    await expect(page.getByTestId('tab-matchup')).toHaveAccessibleName(/Matchup/);
  });

  /**
   * It belongs beside its neighbours, at both weights.
   *
   * The failure this catches is a glyph that is correct in a design file and
   * wrong in the row: a mark that is visibly smaller than the ones either side
   * of it looks like a mistake, and one that is visibly larger looks like an
   * advertisement. So the footprint is measured against the family rather than
   * against a number — the rendered ink of Matchup, against the rendered ink of
   * Team and Waivers, at whatever width the project is running.
   *
   * Both weights, because selecting a tab redraws every glyph in the bar at
   * `stroke-width: 2.15`, and the heavier drawing is the one that can close a
   * gap the resting one had. Here that gap is the air either side of the centre
   * line, which is what stops three vertical strokes reading as one blot.
   */
  test('sits in the family’s box, and keeps its centre clear when selected', async ({ page }) => {
    await postDraft(page);
    await page.goto('/');
    await expect(page.getByTestId('tab-matchup')).toBeVisible();

    /** The glyph's ink: its geometry, grown by half a stroke on every side. */
    const ink = (tab: string) =>
      page.getByTestId(`tab-${tab}`).evaluate((el) => {
        const svg = el.querySelector('svg')!;
        const stroke = Number.parseFloat(getComputedStyle(svg).strokeWidth) * svg.getScreenCTM()!.a;
        const box = svg.getBBox();
        const scale = svg.getScreenCTM()!.a;
        return { width: box.width * scale + stroke, height: box.height * scale + stroke, stroke };
      });

    const rest = await ink('matchup');
    const team = await ink('team');
    const waivers = await ink('waivers');
    const family = [team, waivers];
    const widest = Math.max(...family.map((f) => f.width));
    const tallest = Math.max(...family.map((f) => f.height));
    expect(rest.width, `Matchup is ${rest.width.toFixed(1)}px wide against a family of ${widest.toFixed(1)}`).
      toBeLessThanOrEqual(widest + 0.5);
    expect(rest.width).toBeGreaterThan(widest * 0.8);
    expect(rest.height, 'Matchup is taller than anything beside it').toBeLessThanOrEqual(tallest + 0.5);

    /*
     * The air around the centre line, read off the rendered boxes rather than
     * the path data: what matters is where the ink lands after the viewBox and
     * the bar's 22px have been applied, and neither is mentioned in the file.
     */
    const clearance = () =>
      page.getByTestId('tab-matchup').evaluate((el) => {
        const svg = el.querySelector('svg')!;
        const [left, right, divider] = [...svg.querySelectorAll('path')];
        const stroke = Number.parseFloat(getComputedStyle(svg).strokeWidth) * svg.getScreenCTM()!.a;
        const gap = (a: Element, b: Element) =>
          +(b.getBoundingClientRect().left - a.getBoundingClientRect().right - stroke).toFixed(2);
        return { stroke: +stroke.toFixed(2), before: gap(left!, divider!), after: gap(divider!, right!) };
      });

    const resting = await clearance();
    expect(resting.before, `the divider is ${resting.before}px clear of the left bracket`).toBeGreaterThan(0.5);
    expect(resting.after, `the divider is ${resting.after}px clear of the right bracket`).toBeGreaterThan(0.5);

    await page.getByTestId('tab-matchup').click();
    await expect(page.getByTestId('tab-matchup')).toHaveAttribute('aria-current', 'page');
    const selected = await clearance();
    // The selected glyph really is the heavier one — otherwise the check above
    // would be passing twice on the same drawing.
    expect(selected.stroke, 'selecting a tab draws it heavier').toBeGreaterThan(resting.stroke);
    expect(selected.before, `the selected divider clears the left bracket by ${selected.before}px`).toBeGreaterThan(0.3);
    expect(selected.after, `the selected divider clears the right bracket by ${selected.after}px`).toBeGreaterThan(0.3);
  });
});
