import { ApiError } from '../../api/client.js';
import { cleanName } from '../../parse/cells.js';
import {
  type ContentFile,
  ContentNotFoundError,
  type ContentSource,
  type EmailContent,
  type FetchedContent,
} from '../types.js';

/**
 * Keap's text part for an HTML-only email is a pointer to the hosted copy
 * (`~HostedEmail.Url~`), not content. Dropped, so the export derives a readable
 * text part from the HTML instead.
 */
const HTML_ONLY_PLACEHOLDER = /^This email was sent as HTML-only\./;

interface TemplateResponse {
  id?: unknown;
  piece_title?: unknown;
  from_address?: unknown;
  to_address?: unknown;
  cc_address?: unknown;
  bcc_address?: unknown;
  subject?: unknown;
  text_body?: unknown;
  html_body?: unknown;
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;

export function templatePath(id: string): string {
  return `/crm/rest/v2/emails/templates/${encodeURIComponent(id)}`;
}

/**
 * One email template, from `GET /crm/rest/v2/emails/templates/{id}` — confirmed
 * for the legacy, beta (`bardEmail`) and Unlayer builders (spike-findings §18).
 * The API has no attachments, reply-to or preview text; those stay empty.
 */
export function mapTemplate(raw: unknown): FetchedContent {
  const t = (raw ?? {}) as TemplateResponse;
  const record: EmailContent = {
    kind: 'email',
    name: cleanName(typeof t.piece_title === 'string' ? t.piece_title : null),
    from: text(t.from_address),
    replyTo: null,
    to: text(t.to_address),
    cc: text(t.cc_address),
    bcc: text(t.bcc_address),
    subject: text(t.subject),
    previewText: null,
    attachments: [],
  };

  const files: ContentFile[] = [];
  const html = text(t.html_body);
  if (html !== null) files.push({ name: 'body.html', body: html });
  const plain = text(t.text_body);
  if (plain !== null && !HTML_ONLY_PLACEHOLDER.test(plain.trim())) {
    files.push({ name: 'body.txt', body: plain });
  }

  return {
    record,
    files,
    evidence: [{ name: 'response.json', body: JSON.stringify(raw, null, 2) }],
    assetUrls: [],
  };
}

export const emailSource: ContentSource = {
  kind: 'email',
  attributes: ['marketingEmailId'],
  needsApiKey: true,
  needsBrowser: false,

  async fetch(key, ctx) {
    if (ctx.api === null) throw new Error('emails are read through the REST API — set KEAP_API_KEY');
    let raw: unknown;
    try {
      raw = await ctx.api.get(templatePath(key.id));
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        throw new ContentNotFoundError(`email template ${key.id} does not exist`);
      }
      throw error;
    }
    const id = (raw as TemplateResponse | null)?.id;
    if (String(id) !== key.id) {
      throw new Error(`asked for template ${key.id}, got ${String(id)}`);
    }
    return mapTemplate(raw);
  },

  validate(content) {
    const evidence = content.evidence.find((file) => file.name === 'response.json');
    try {
      const parsed = JSON.parse(String(evidence?.body ?? '')) as TemplateResponse;
      if (typeof parsed.id === 'number' || typeof parsed.id === 'string') return null;
    } catch {
      // fall through
    }
    return 'response is not an email template';
  },
};
