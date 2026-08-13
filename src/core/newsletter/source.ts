/**
 * Email ingestion source abstraction.
 *
 * The production goal is automatic ingestion. Nothing in the pipeline assumes
 * manual paste: every delivery path implements this same interface.
 *
 * Implementations:
 *   - `FixtureEmailSource`      (this file)      — tests + local development
 *   - `ManualEmailSource`       (this file)      — operator paste, escape hatch
 *   - Cloudflare Email Workers  (see docs/EMAIL_INGESTION.md) — push delivery
 *   - Gmail API poller          (see docs/EMAIL_INGESTION.md) — pull delivery
 *
 * Push sources call `ingestMessage` directly; pull sources are driven by the
 * scheduled worker calling `fetchNew`.
 */

import type { EmailMessage, NewsletterSourceConfig } from './pipeline.ts';

export interface EmailFetchOptions {
  /** Only return messages received strictly after this ISO timestamp. */
  since?: string | null;
  limit?: number;
}

export interface EmailSource {
  readonly id: string;
  readonly kind: 'push' | 'pull';
  /**
   * Pull new candidate messages. Push sources return an empty array — their
   * messages arrive through the inbound webhook instead.
   */
  fetchNew(opts?: EmailFetchOptions): Promise<EmailMessage[]>;
  /** Whether this source is fully configured (credentials present). */
  isConfigured(): boolean;
  /** Human-readable status for the settings screen. */
  describe(): { id: string; kind: 'push' | 'pull'; configured: boolean; detail: string };
}

/** Reads messages from an in-memory fixture list. Used by tests and dev. */
export class FixtureEmailSource implements EmailSource {
  readonly id = 'fixtures';
  readonly kind = 'pull' as const;

  constructor(private readonly messages: EmailMessage[]) {}

  async fetchNew(opts: EmailFetchOptions = {}): Promise<EmailMessage[]> {
    const since = opts.since ? Date.parse(opts.since) : null;
    const list = this.messages
      .filter((m) => (since == null ? true : Date.parse(m.receivedAt) > since))
      .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
    return opts.limit ? list.slice(0, opts.limit) : list;
  }

  isConfigured(): boolean {
    return true;
  }

  describe() {
    return {
      id: this.id,
      kind: this.kind,
      configured: true,
      detail: `${this.messages.length} fixture message(s)`,
    };
  }
}

/**
 * Operator-supplied message (paste or file upload).
 *
 * Present as a deliberate fallback for a newsletter that arrives outside the
 * automated path — it is NOT the primary design.
 */
export class ManualEmailSource implements EmailSource {
  readonly id = 'manual';
  readonly kind = 'push' as const;

  async fetchNew(): Promise<EmailMessage[]> {
    return [];
  }

  isConfigured(): boolean {
    return true;
  }

  describe() {
    return { id: this.id, kind: this.kind, configured: true, detail: 'operator upload endpoint' };
  }
}

/**
 * Default qualification config for the FF newsletter.
 * Stored in the database (`settings` table) so it is editable without a deploy;
 * this constant is only the seed value.
 */
export const DEFAULT_NEWSLETTER_SOURCES: NewsletterSourceConfig[] = [
  {
    id: 'ff-newsletter',
    label: 'FF Newsletter',
    // Replace with the real sender during setup — see docs/EMAIL_INGESTION.md.
    fromPatterns: ['@ffnewsletter.example'],
    subjectPatterns: ['fantasy', 'week \\d+', 'training camp', 'waiver'],
    enabled: true,
  },
];

/**
 * Normalize a raw inbound MIME-ish payload into an `EmailMessage`.
 * Kept transport-agnostic so Cloudflare Email Workers, SendGrid inbound parse
 * and Gmail all funnel through one shape.
 */
export function toEmailMessage(input: {
  messageId?: string | null;
  from?: string | null;
  subject?: string | null;
  date?: string | null;
  html?: string | null;
  text?: string | null;
  headers?: Record<string, string>;
}): EmailMessage {
  const receivedAt = input.date && !Number.isNaN(Date.parse(input.date))
    ? new Date(input.date).toISOString()
    : new Date().toISOString();
  return {
    messageId: (input.messageId ?? '').trim() || `synthetic-${receivedAt}`,
    from: (input.from ?? '').trim(),
    subject: (input.subject ?? '').trim(),
    receivedAt,
    html: input.html ?? null,
    text: input.text ?? null,
    headers: input.headers ?? {},
  };
}
