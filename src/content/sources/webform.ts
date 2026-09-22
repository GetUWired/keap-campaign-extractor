import { load as loadHtml } from 'cheerio';
import { cleanName } from '../../parse/cells.js';
import { decodeEntities } from '../../render/text.js';
import { anonymousFetcher } from '../assets/download.js';
import { classifyUrl } from '../assets/discover.js';
import type { ContentSource, FetchContext, FetchedContent, FormContent, FormField } from '../types.js';

export const WEBFORMS_PATH = '/crm/rest/v2/webforms';

/** Keap's own fields; everything else on the page (plumbing, anti-spam) is excluded. */
const FIELD_NAME = /^inf_(field|custom|option|other)_/;

/** At most this many redirect hops are followed before giving up on the public page. */
const MAX_PAGE_REDIRECTS = 5;

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
  const isMessage = exit === 'MESSAGE' || exit === 'AUTHORING_MESSAGE';
  const record: FormContent = {
    kind: 'form',
    name: cleanName(text(entry.name)),
    fields: [],
    fieldsAvailable: false,
    thankYou: {
      type: isMessage ? 'message' : exit === 'REDIRECT' ? 'redirect' : 'unknown',
      // MESSAGE and AUTHORING_MESSAGE: for message exits, the thank-you text is
      // designed in the campaign builder, not carried in the API response. The
      // thank_you_page_url field is stale (Keap leaves it behind) and must not be
      // used. For REDIRECT and unknown exits, thank_you_page_url is the actual target.
      value: isMessage ? null : text(entry.thank_you_page_url),
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

interface FieldBuilder {
  name: string;
  type: string;
  hidden: boolean;
  requiredAttr: boolean;
  defaultValue: string | null;
  labelId: string | null;
  options?: string[];
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The text of the first `<label for="id">` found, entity-decoded and trimmed; null if none. */
function labelFor($: ReturnType<typeof loadHtml>, id: string): string | null {
  let found: string | null = null;
  $('label').each((_, element) => {
    if (found !== null) return;
    if ($(element).attr('for') === id) found = decodeEntities($(element).text()).trim();
  });
  return found;
}

/**
 * Parses a form's hosted page: the first `<form>` on it, or null when the page
 * carries no form at all — Keap serves an error page (e.g. "Error 640") the
 * same way it serves a real form, with a 200 status, so absence of a `<form>`
 * is the only reliable signal.
 */
export function parseWebformPage(html: string): { fields: FormField[] } | null {
  const $ = loadHtml(html);
  const form = $('form').first();
  if (form.length === 0) return null;

  const order: string[] = [];
  const builders = new Map<string, FieldBuilder>();

  form.find('input, select, textarea').each((_, element) => {
    const $el = $(element);
    const name = $el.attr('name');
    if (name === undefined || !FIELD_NAME.test(name)) return;

    const tagName = element.tagName.toLowerCase();
    const inputType = tagName === 'input' ? ($el.attr('type') ?? 'text').toLowerCase() : tagName;
    // Radio buttons are the one input type Keap's forms use as a same-name group;
    // a single field with every option, not one field per button.
    const groupable = tagName === 'input' && inputType === 'radio';

    let builder = builders.get(name);
    if (builder === undefined) {
      builder = {
        name,
        type: inputType,
        hidden: inputType === 'hidden',
        requiredAttr: false,
        defaultValue: inputType === 'hidden' ? ($el.attr('value') ?? null) : null,
        labelId: $el.attr('id') ?? null,
      };
      if (groupable) builder.options = [];
      builders.set(name, builder);
      order.push(name);
    }

    if ($el.attr('required') !== undefined) builder.requiredAttr = true;

    if (groupable) {
      const value = $el.attr('value');
      if (value !== undefined && value !== '' && !builder.options?.includes(value)) {
        builder.options?.push(value);
      }
    }

    if (tagName === 'select') {
      builder.options = $el
        .find('option')
        .toArray()
        .map((option) => ($(option).attr('value') ?? $(option).text()).trim())
        .filter((value) => value !== '');
    }
  });

  const fields: FormField[] = order.map((name) => {
    const builder = builders.get(name) as FieldBuilder;
    const rawLabel = builder.labelId !== null ? labelFor($, builder.labelId) : null;
    const endsWithStar = rawLabel !== null && rawLabel.endsWith('*');
    const label = rawLabel === null ? null : rawLabel.replace(/\*$/, '').trim();
    const field: FormField = {
      name: builder.name,
      label,
      type: builder.type,
      required: endsWithStar || builder.requiredAttr,
      hidden: builder.hidden,
      defaultValue: builder.defaultValue,
    };
    if (builder.options !== undefined) field.options = builder.options;
    return field;
  });

  return { fields };
}

export interface FetchedPage {
  status: number;
  body: string;
  finalUrl: string;
}

export interface WebformSourceDeps {
  fetchPage?: (url: string) => Promise<FetchedPage>;
}

/**
 * The default page fetcher: anonymous (no Keap session ever reaches the
 * form's public page), following redirects itself — re-running `classifyUrl`
 * on every `Location` so a redirect to a private address is refused — at most
 * `MAX_PAGE_REDIRECTS` hops.
 */
function defaultFetchPage(): (url: string) => Promise<FetchedPage> {
  const fetcher = anonymousFetcher();
  return async (url) => {
    let currentUrl = url;
    let redirects = 0;
    for (;;) {
      const response = await fetcher(currentUrl);
      if (response.status >= 300 && response.status < 400) {
        if (!response.location) throw new Error(`HTTP ${response.status}`);
        redirects++;
        if (redirects > MAX_PAGE_REDIRECTS) throw new Error('too many redirects');
        const classified = classifyUrl(response.location, currentUrl);
        if ('reason' in classified) throw new Error(`redirect to ${classified.reason}`);
        currentUrl = classified.url;
        continue;
      }
      if (response.status >= 200 && response.status < 300) {
        const bytes = await response.body();
        return { status: response.status, body: bytes.toString('utf8'), finalUrl: currentUrl };
      }
      throw new Error(`HTTP ${response.status}`);
    }
  };
}

/**
 * Web forms, from the v2 list — the only form resource the API has
 * (spike-findings §18) — plus, once a form is found, its public hosted page:
 * the API's list carries no field list, but the page Keap serves visitors
 * does. The list is read once per run and shared by every form item; a
 * failed read is not cached, so the next item tries again.
 *
 * Fetching the page never carries the Keap session and never fails the item:
 * a form found in the list is real regardless of whether its page could be
 * read, so a fetch failure or a pageless response is recorded as
 * `pageError`, not thrown.
 */
export function createWebformSource(deps: WebformSourceDeps = {}): ContentSource {
  let listing: Promise<Map<string, WebformEntry>> | null = null;
  const fetchPage = deps.fetchPage ?? defaultFetchPage();

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
        // Not ContentNotFoundError: a form built inside a campaign enters the v2 list
        // only once its campaign is published with the form goal ready (confirmed
        // live on se232 — docs/spike-findings.md §18), so an absent id is usually a
        // draft, not a deleted form. A plain Error records `failed` with that reason
        // and is retried on the next run.
        throw new Error(
          `web form ${key.id} is not listed by ${WEBFORMS_PATH} — campaign forms appear there ` +
            'only once their campaign is published with the form goal ready; otherwise it may ' +
            'have been deleted. Rebuild it by hand from Keap if it is needed.',
        );
      }
      const mapped = mapWebform(entry);
      const record = mapped.record as FormContent;

      if (record.publicUrl === null || record.publicUrl === undefined) {
        record.pageError = 'no public URL';
        return mapped;
      }

      let page: FetchedPage;
      try {
        page = await fetchPage(record.publicUrl);
      } catch (error) {
        record.pageError = messageOf(error);
        return mapped;
      }

      mapped.evidence = [...mapped.evidence, { name: 'page.html', body: page.body }];
      const parsed = parseWebformPage(page.body);
      if (parsed === null) {
        record.pageError = 'no form on the public page';
        return mapped;
      }

      record.fields = parsed.fields;
      record.fieldsAvailable = true;
      mapped.files = [...mapped.files, { name: 'form.html', body: page.body }];
      return mapped;
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
