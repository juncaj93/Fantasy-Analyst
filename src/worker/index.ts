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
import type { VegasProvider } from '../core/vegas/types.ts';
import { createApp, refreshVegas, type AppEnv } from '../server/app.ts';
import type { Database } from '../server/db.ts';
import { NewsletterService } from '../server/services/newsletterService.ts';
import { SleeperSyncService } from '../server/services/sleeperSync.ts';

export interface WorkerEnv {
  DB: Database;
  ASSETS?: { fetch: (request: Request) => Promise<Response> };
  APP_PASSPHRASE?: string;
  SESSION_SECRET?: string;
  ODDS_API_KEY?: string;
  /** 'mock' (default) or 'the-odds-api'. */
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
   *   Sat 23:00 UTC + Sun 15:00 UTC -> Vegas refresh
   *   Daily 09:00 UTC               -> Sleeper player dictionary sync
   */
  async scheduled(event: { cron: string }, env: WorkerEnv): Promise<void> {
    const appEnv = toAppEnv(env);
    if (event.cron.startsWith('0 9')) {
      await new SleeperSyncService(env.DB, appEnv.sleeper).syncPlayers();
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
