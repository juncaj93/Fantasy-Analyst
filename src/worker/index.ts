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
   * Inbound email (Cloudflare Email Routing -> Email Worker).
   * The message is qualified and processed through the same pipeline as every
   * other source; unqualified mail is ignored without being stored.
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
    const raw = await new Response(message.raw).text();
    const parsed = parseRawEmail(raw);
    const email = toEmailMessage({
      messageId: message.headers.get('message-id') ?? parsed.messageId,
      from: message.from,
      subject: message.headers.get('subject') ?? parsed.subject,
      date: message.headers.get('date'),
      html: parsed.html,
      text: parsed.text,
    });
    const outcome = await new NewsletterService(env.DB).ingest(email);
    if (outcome.status === 'not_qualified') {
      // Do not reject: rejecting bounces mail. Just ignore it.
      return;
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

  return { messageId: header('message-id'), subject: header('subject'), html, text };
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
