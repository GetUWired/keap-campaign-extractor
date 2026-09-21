import { cleanName } from '../../parse/cells.js';
import type { ContentSource, FetchContext, FetchedContent, FormContent } from '../types.js';

export const WEBFORMS_PATH = '/crm/rest/v2/webforms';

interface WebformEntry {
  id?: unknown;
  name?: unknown;
  webform_url?: unknown;
  thank_you_page_url?: unknown;
  exit_option?: unknown;
  webform_type?: unknown;
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;

export function mapWebform(entry: WebformEntry): FetchedContent {
  const exit = entry.exit_option;
  const record: FormContent = {
    kind: 'form',
    name: cleanName(text(entry.name)),
    fields: [],
    fieldsAvailable: false,
    thankYou: {
      type: exit === 'REDIRECT' ? 'redirect' : exit === 'MESSAGE' ? 'message' : 'unknown',
      // MESSAGE: the API carries no message text for this exit type, so `value` is
      // the thank-you URL field, which is normally null for a MESSAGE exit — not
      // the message shown to the contact.
      value: text(entry.thank_you_page_url),
    },
    publicUrl: text(entry.webform_url),
    formType: text(entry.webform_type),
  };
  return {
    record,
    files: [],
    evidence: [{ name: 'webform.json', body: JSON.stringify(entry, null, 2) }],
    assetUrls: [],
  };
}

/**
 * Web forms, from the v2 list — the only form resource the API has
 * (spike-findings §18). The list is read once per run and shared by every form
 * item; a failed read is not cached, so the next item tries again.
 */
export function createWebformSource(): ContentSource {
  let listing: Promise<Map<string, WebformEntry>> | null = null;

  const load = (ctx: FetchContext): Promise<Map<string, WebformEntry>> => {
    if (ctx.api === null) {
      return Promise.reject(new Error('web forms are read through the REST API — set KEAP_API_KEY'));
    }
    if (listing === null) {
      listing = ctx.api.getAll(WEBFORMS_PATH).then(
        (items) =>
          new Map(
            items
              .filter((item): item is WebformEntry => item !== null && typeof item === 'object')
              .map((item) => [String(item.id), item] as const),
          ),
        (error: unknown) => {
          listing = null;
          throw error;
        },
      );
    }
    return listing;
  };

  return {
    kind: 'form',
    attributes: ['webformId'],
    needsApiKey: true,
    needsBrowser: false,

    async fetch(key, ctx) {
      const entry = (await load(ctx)).get(key.id);
      if (entry === undefined) {
        // Not ContentNotFoundError: the v2 list matched only 63 of 113 referenced
        // webformIds in the enrichment spike (docs/spike-findings.md ~line 655), so
        // an id absent from it is not proven deleted — it may be a form type the
        // list does not cover. A plain Error records `failed` and is retried on
        // the next run, rather than being asserted as a finding.
        throw new Error(
          `web form ${key.id} is not listed by ${WEBFORMS_PATH} — it may be deleted, archived, or a form type the API does not list`,
        );
      }
      return mapWebform(entry);
    },

    validate(content) {
      if (content.record.kind !== 'form') return 'not a web form';
      const evidence = content.evidence.find((file) => file.name === 'webform.json');
      try {
        const parsed = JSON.parse(String(evidence?.body ?? '')) as WebformEntry;
        if (parsed.id !== undefined && parsed.id !== null) return null;
      } catch {
        // fall through
      }
      return 'response is not a web form';
    },
  };
}
