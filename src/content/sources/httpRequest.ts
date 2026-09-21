import { type CheerioAPI, load } from 'cheerio';
import { SessionExpiredError } from '../../errors.js';
import type { ContentSource, HttpContent, NameValue } from '../types.js';
import { appGet, looksLikeSignInPage } from './appGet.js';

export function httpRequestPath(id: string): string {
  return `/app/httpRequestFunnel/requests/${encodeURIComponent(id)}`;
}

/**
 * Name/value rows of one parameter table (QUERY or HEADER). The editor's blank
 * row template lives in a <template> outside the tables, so it never matches.
 */
function rows($: CheerioAPI, table: 'QUERY' | 'HEADER'): NameValue[] {
  return $(`#paramTable-${table} tr.parameter-table-line-item`)
    .toArray()
    .map((row) => ({
      name: ($(row).find('.http-request-param-name input').attr('value') ?? '').trim(),
      value: $(row).find('.http-request-param-value input').attr('value') ?? '',
    }))
    .filter((pair) => pair.name !== '');
}

/** The HTTP Request editor form, or null when the page is anything else. */
export function parseHttpRequestEditor(
  html: string,
): { configId: string | null; record: HttpContent } | null {
  const $ = load(html);
  // All four must be present — not just #httpRequestType — so a page that resembles
  // the editor but is missing a table (a Keap markup change, a partial render) fails
  // loudly instead of silently reading as an empty request. The populated-row markup
  // itself is unconfirmed against a live account (see test/fixtures/content/README.md);
  // Task 8 in the plan confirms it.
  if (
    $('#httpRequestType').length === 0 ||
    $('#paramTable-QUERY').length === 0 ||
    $('#paramTable-HEADER').length === 0 ||
    $('#http-request-body').length === 0
  ) {
    return null;
  }

  const selected = $('#httpRequestType option[selected]').first();
  const method = (
    (selected.length > 0 ? selected.attr('value') : $('#httpRequestType option').first().attr('value')) ?? 'POST'
  ).toUpperCase();

  // Percent-encode each parameter pair so redactEncodedPairs sees whole pairs, not
  // partial pieces if a value contains unencoded `&` or `=`. encodeURIComponent
  // encodes `&` and `=` but not `~`, so merge fields like ~Contact.Id~ stay readable.
  const query = rows($, 'QUERY');
  const rawUrl = ($('#targetUrl').attr('value') ?? '').trim();
  // Append before the fragment, not after: `…?a=1#frag` has `#frag` as a fragment,
  // which redactUrl does not scan, so parameters landing there would ship un-redacted.
  const fragAt = rawUrl.indexOf('#');
  let base = fragAt < 0 ? rawUrl : rawUrl.slice(0, fragAt);
  const fragment = fragAt < 0 ? '' : rawUrl.slice(fragAt);
  if (query.length > 0) {
    base += (base.includes('?') ? '&' : '?') + query.map((p) => `${encodeURIComponent(p.name)}=${encodeURIComponent(p.value)}`).join('&');
  }
  const url = base + fragment;

  const body = $('#http-request-body').text();
  return {
    configId: $('#httpRequestConfigId').attr('value') ?? null,
    record: {
      kind: 'http',
      name: null,
      method,
      url,
      headers: rows($, 'HEADER'),
      fields: [],
      body: body.trim() === '' ? null : body,
    },
  };
}

export const httpRequestSource: ContentSource = {
  kind: 'http',
  attributes: ['httpRequestConfigId'],
  needsApiKey: false,
  needsBrowser: true,

  async fetch(key, ctx) {
    const response = await appGet(ctx, httpRequestPath(key.id));
    const parsed = parseHttpRequestEditor(response.body);
    if (parsed === null) {
      if (looksLikeSignInPage(response.body)) {
        throw new SessionExpiredError(
          `Session expired — ${httpRequestPath(key.id)} returned a sign-in page. Re-run:  npm run login -- --app ${ctx.app}`,
        );
      }
      throw new Error(`${httpRequestPath(key.id)} returned something that is not the HTTP request editor`);
    }
    if (parsed.configId !== key.id) {
      throw new Error(`asked for HTTP request ${key.id}, got ${parsed.configId ?? 'none'}`);
    }
    return { record: parsed.record, files: [], evidence: [{ name: 'editor.html', body: response.body }], assetUrls: [] };
  },

  validate(content) {
    const evidence = content.evidence.find((file) => file.name === 'editor.html');
    return parseHttpRequestEditor(String(evidence?.body ?? '')) === null
      ? 'response is not the HTTP request editor'
      : null;
  },
};
