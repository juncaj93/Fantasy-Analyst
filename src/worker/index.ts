/**
 * Cloudflare Worker entry point.
 *
 * Three entry surfaces:
 *   fetch()    — the API + static SPA assets
 *   scheduled() — Vegas refresh cadence + nightly Sleeper player sync
 *   email()    — inbound FF Newsletter delivery (Email Workers)
 *
 * Secrets (APP_PASSPHRASE, SESSION_SECRET, ODDS_API_KEY) live in the worker
 * environment and are never sent to the browser.
 */

import { SleeperClient } from '../core/sleeper/client.ts';
import { toEmailMessage } from '../core/newsletter/source.ts';
import { MockVegasProvider } from '../core/vegas/mockProvider.ts';
import { OddsApiProvider } from '../core/vegas/oddsApiProvider.ts';
import { SportsGameOddsProvider } from '../core/vegas/sportsGameOddsProvider.ts';
import type { VegasProvider } from '../core/vegas/types.ts';
import { createApp, refreshVegas, type AppEnv } from '../server/app.ts';
import type { Database } from '../server/db.ts';
import { NewsletterService } from '../server/services/newsletterService.ts';
import { SleeperSyncService } from '../server/services/sleeperSync.ts';
import { PlayerDetailService } from '../server/services/playerDetailService.ts';
import { InjuryService, previousSeason } from '../server/services/injuryService.ts';
import { InjuryHistoryService } from '../server/services/injuryHistoryService.ts';
import { UsageService } from '../server/services/usageService.ts';
import { LeagueRepo } from '../server/repos/league.ts';

export interface WorkerEnv {
  DB: Database;
  ASSETS?: { fetch: (request: Request) => Promise<Response> };
  APP_PASSPHRASE?: string;
  SESSION_SECRET?: string;
  ODDS_API_KEY?: string;
  SPORTSGAMEODDS_API_KEY?: string;
  /** 'mock' (default), 'sportsgameodds' or 'the-odds-api'. */
  VEGAS_PROVIDER?: string;
  /**
   * The dedicated address the FF Newsletter is subscribed to, e.g.
   * "fantasy-news@example.com". Shown in Settings so the user knows where to
   * subscribe. Can also be set in-app, which overrides this value.
   */
  NEWSLETTER_ADDRESS?: string;
}

const app = createApp();

function buildVegasProvider(env: WorkerEnv): VegasProvider {
  if (env.VEGAS_PROVIDER === 'sportsgameodds') {
    return new SportsGameOddsProvider({ apiKey: env.SPORTSGAMEODDS_API_KEY });
  }
  if (env.VEGAS_PROVIDER === 'the-odds-api') {
    return new OddsApiProvider({ apiKey: env.ODDS_API_KEY });
  }
  // Default: deterministic mock. Never calls out, never costs quota.
  return new MockVegasProvider([]);
}

function toAppEnv(env: WorkerEnv): AppEnv {
  return {
    db: env.DB,
    sleeper: new SleeperClient(),
    vegas: buildVegasProvider(env),
    APP_PASSPHRASE: env.APP_PASSPHRASE,
    SESSION_SECRET: env.SESSION_SECRET,
    inboundAddress: env.NEWSLETTER_ADDRESS ?? null,
  };
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return app(request, toAppEnv(env));
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('static assets are not configured', { status: 404 });
  },

  /**
   * Cron cadence (see wrangler.toml):
   *   Every 5 minutes  -> injury check (conditional; usually a 304 and no work)
   *                       plus, until it finishes, one step of last season's
   *                       history backfill
   *   Sat 23:00 UTC    -> Vegas refresh
   *   Sun 15:00 UTC    -> Vegas refresh
   *   Daily 09:00 UTC  -> Sleeper player dictionary, last season's statistics,
   *                       one injury check, and per-game usage (weekly stats
   *                       settle when a game ends, so a daily check learns
   *                       everything 288 of them would)
   *
   * The injury check is deliberately the odd one out. Everything else here is a
   * job that costs real work every time it runs, so it runs on a schedule
   * chosen to be as infrequent as the data allows. The injury check costs a
   * conditional request that is almost always answered 304 with no body, so it
   * can run constantly — and it has to, because a player is ruled out ninety
   * minutes before kickoff and kickoff is 9:30am for a London game, Thursday
   * night, Friday on a holiday, or Saturday in December. No fixed window covers
   * that set; a flat cadence does.
   */
  async scheduled(event: { cron: string }, env: WorkerEnv): Promise<void> {
    const appEnv = toAppEnv(env);

    /*
     * The five-minute tick. Checked first and returned from immediately,
     * because it is by far the most frequent path and it must stay cheap.
     */
    if (event.cron.startsWith('*/5')) {
      try {
        const injuries = new InjuryService(env.DB);
        const run = await injuries.refresh();
        await recomputeForChangedPlayers(env, run.changedPlayerIds ?? []);
        /*
         * And one week of any gap an outage left behind.
         *
         * Only when the check itself found nothing to do, so a tick never pays
         * for both a real ingest and a catch-up week. The gap is filled oldest
         * first, one week per tick, and writes rows without touching current
         * state -- a week from a fortnight ago cannot change who plays today.
         */
        if ((run.changedPlayerIds ?? []).length === 0) await injuries.catchUpOneWeek();
      } catch (err) {
        console.error('injury check failed', err);
      }

      /*
       * And, while there is anything left of it, one step of last season's
       * backfill.
       *
       * It rides this tick rather than getting a cron of its own for two
       * reasons. The account has five cron triggers and this needs none of
       * them; and the work is finite — 2025 is a finished season, so the walk
       * converges in a couple of hours and then `isComplete` is one indexed
       * read that answers "nothing to do" forever after.
       *
       * Separately caught. The backfill is history, and history failing must
       * never take down the check that decides whether somebody plays today.
       */
      try {
        const history = new InjuryHistoryService(env.DB);
        const season = previousSeason();
        if (!(await history.isComplete(season))) await history.step(season);
      } catch (err) {
        console.error('injury history backfill failed', err);
      }
      return;
    }

    if (event.cron.startsWith('0 9')) {
      await new SleeperSyncService(env.DB, appEnv.sleeper).syncPlayers();
      /*
       * Last season's line, on the same clock and deliberately after the
       * dictionary: the statistics are matched against the players this app
       * knows, so syncing them in the other order would report every new player
       * as unmatched for a day.
       *
       * A finished season does not change, so a failure here is not worth
       * taking the player sync down with it — the cards fall back to saying
       * nothing, which is what they said before this existed.
       */
      try {
        await new PlayerDetailService(env.DB, { sleeper: appEnv.sleeper }).refreshSeasonStats();
      } catch (err) {
        console.error('season stats refresh failed', err);
      }
      /*
       * One injury check on this clock too, after the dictionary.
       *
       * Not for freshness — the five-minute tick has that covered — and not, as
       * an earlier version of this comment claimed, to re-resolve players who
       * were unmatched yesterday: this is the same conditional path, so if the
       * file has not changed it answers 304 and returns without re-reading
       * anything. Re-mapping only happens when the source itself moves.
       *
       * It stays because it costs one conditional request and it is the one
       * injury check that does not depend on the five-minute cron still being
       * scheduled — a floor under the freshest thing this app has.
       */
      try {
        await new InjuryService(env.DB).refresh();
      } catch (err) {
        console.error('injury report refresh failed', err);
      }
      /*
       * Per-game usage, and this is the honest home for it.
       *
       * It was tempting to hang it off the five-minute tick beside the injury
       * check, since a conditional GET that 304s is nearly free. But cheap is
       * not the same as warranted: a game's target count is settled the moment
       * the game ends and never changes again, so 288 checks a day would learn
       * exactly what one check learns and cost 288 bookkeeping writes to do it.
       * The two feeds are different kinds of fact — one is news that arrives
       * ninety minutes before kickoff, the other is a box score — and putting
       * them on the same clock would be treating them as the same thing.
       *
       * 09:00 UTC is about 5am Eastern: after Sunday's late window and Monday
       * night have finished and after nflverse's own pipeline has run. A game
       * that lands too late for one morning's tick is picked up by the next,
       * six days before it could matter to a lineup.
       *
       * After the dictionary, like everything else here, because rows are
       * matched against the players this app knows. Separately caught: usage is
       * a nudge in a close call, and it must never take down the player sync.
       */
      try {
        const usage = new UsageService(env.DB);
        const run = await usage.refresh();
        // And one week of any gap an outage left behind, but never on the same
        // tick as a real ingest — a catch-up week is history and can wait a day.
        if (run.rowsWritten === 0) await usage.catchUpOneWeek();
      } catch (err) {
        console.error('usage refresh failed', err);
      }
      return;
    }

    await refreshVegas(appEnv);
  },

  /**
   * Inbound email — the production newsletter path.
   *
   * Cloudflare Email Routing delivers to the dedicated Fantasy Analyst address,
   * which routes here. Every message is logged so Settings can show "last
   * received"; only mail from the configured sender is parsed into evidence.
   *
   * Mail is never rejected at the SMTP level: rejecting bounces the message back
   * to the sender, which would look like a broken subscription. Unexpected mail
   * is quarantined instead — recorded, visible, and never turned into evidence.
   */
  async email(
    message: {
      from: string;
      to: string;
      headers: Headers;
      raw: ReadableStream;
      setReject: (reason: string) => void;
    },
    env: WorkerEnv,
  ): Promise<void> {
    try {
      const raw = await new Response(message.raw).text();
      const parsed = parseRawEmail(raw);
      // `message.from` is the SMTP envelope sender. Bulk senders put a
      // per-message bounce address there (Substack sends
      // `bounce+<token>-you=your.domain@mg-dN.substack.com`), so a subscription
      // matched against it would work once and then silently stop. The visible
      // `From:` header is the stable identity; the envelope is kept alongside
      // it for the record.
      const email = toEmailMessage({
        messageId: message.headers.get('message-id') ?? parsed.messageId,
        from: message.headers.get('from') ?? parsed.from ?? message.from,
        envelopeFrom: message.from,
        subject: message.headers.get('subject') ?? parsed.subject,
        date: message.headers.get('date'),
        html: parsed.html,
        text: parsed.text,
      });
      await new NewsletterService(env.DB).ingest(email);
    } catch (err) {
      // Never throw out of email(): an exception would retry or bounce the
      // message. The failure is recorded by the service where it can be.
      console.error('inbound email failed', err);
    }
  },
};

/**
 * Minimal MIME extraction: enough to pull the HTML or plain-text part out of a
 * newsletter. Anything more exotic is handled by storing the raw body as text —
 * the sanitizer is tolerant of malformed input by design.
 */
export function parseRawEmail(raw: string): {
  messageId: string | null;
  subject: string | null;
  from: string | null;
  html: string | null;
  text: string | null;
} {
  const headerEnd = raw.search(/\r?\n\r?\n/);
  const headerBlock = headerEnd === -1 ? raw : raw.slice(0, headerEnd);
  const body = headerEnd === -1 ? '' : raw.slice(headerEnd).trimStart();

  const header = (name: string): string | null => {
    const re = new RegExp(`^${name}:\\s*(.*)$`, 'im');
    const m = re.exec(headerBlock);
    return m?.[1]?.trim() ?? null;
  };

  const contentType = header('content-type') ?? '';
  const boundaryMatch = /boundary="?([^";\s]+)"?/i.exec(contentType);

  let html: string | null = null;
  let text: string | null = null;

  if (boundaryMatch) {
    const boundary = `--${boundaryMatch[1]}`;
    for (const part of body.split(boundary)) {
      const partHeaderEnd = part.search(/\r?\n\r?\n/);
      if (partHeaderEnd === -1) continue;
      const partHeaders = part.slice(0, partHeaderEnd).toLowerCase();
      const partBody = part.slice(partHeaderEnd).trim();
      if (partHeaders.includes('text/html') && !html) html = decodeBody(partBody, partHeaders);
      else if (partHeaders.includes('text/plain') && !text) text = decodeBody(partBody, partHeaders);
    }
  } else if (contentType.toLowerCase().includes('text/html')) {
    html = body;
  } else {
    text = body;
  }

  return {
    messageId: header('message-id'),
    subject: header('subject'),
    from: header('from'),
    html,
    text,
  };
}

function decodeBody(body: string, headers: string): string {
  if (headers.includes('quoted-printable')) {
    return body
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  }
  if (headers.includes('base64')) {
    try {
      return atob(body.replace(/\s+/g, ''));
    } catch {
      return body;
    }
  }
  return body;
}


/**
 * Recompute only what a changed player actually touches.
 *
 * The point of the diff is wasted if a three-player update triggers a rebuild of
 * everything, so this asks the narrow question: is any changed player on the
 * user's roster? Nobody else's injury changes what this app would tell *this*
 * user to do — a receiver on a team they have no interest in is news the board
 * will pick up whenever it is next drawn, not a reason to do work now.
 *
 * Start/Sit and Trades both read the normalized injury state at request time
 * rather than from a cache, so "recompute" here means invalidating nothing and
 * warming nothing: the work is in deciding whether anything downstream *could*
 * have changed, and saying so in the log. This is the hook the brief asks for,
 * and it is honest about the fact that the read path is already live.
 */
async function recomputeForChangedPlayers(env: WorkerEnv, changedPlayerIds: string[]): Promise<void> {
  if (changedPlayerIds.length === 0) return;

  const leagues = new LeagueRepo(env.DB);
  const league = await leagues.getSelectedLeague().catch(() => null);
  if (!league) return;

  const rosters = await leagues.listRosters(league.id).catch(() => []);
  const mine = new Set(rosters.find((r) => r.isMine)?.playerIds ?? []);
  const owned = new Set(rosters.flatMap((r) => r.playerIds));

  const onMyRoster = changedPlayerIds.filter((id) => mine.has(id));
  const rosteredElsewhere = changedPlayerIds.filter((id) => !mine.has(id) && owned.has(id));

  if (onMyRoster.length === 0 && rosteredElsewhere.length === 0) return;

  /*
   * Logged rather than acted on, deliberately.
   *
   * Start/Sit and Trades compute from the stored injury state on every request,
   * so the next time either screen is opened it already reflects this change —
   * there is no stale cache to bust. Writing one here to "invalidate" would be
   * inventing a cache in order to clear it. What is worth recording is that the
   * change reached players the user actually cares about, which is what makes a
   * missed propagation visible later.
   */
  console.log(
    `injury-propagate roster=${onMyRoster.length} league=${rosteredElsewhere.length} ` +
      `startSit=${onMyRoster.length} trades=${onMyRoster.length + rosteredElsewhere.length}`,
  );
}
