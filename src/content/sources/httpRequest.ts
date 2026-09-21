import { type CheerioAPI, load } from 'cheerio';
import type { ContentSource, HttpContent, NameValue } from '../types.js';
import { appGet } from './appGet.js';

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
  if ($('#httpRequestType').length === 0) return null;

  const selected = $('#httpRequestType option[selected]').first();
  const method = (
    (selected.length > 0 ? selected.attr('value') : $('#httpRequestType option').first().attr('value')) ?? 'POST'
  ).toUpperCase();

  // Written as Keap stores it — not re-encoded — so merge fields stay readable
  // and the export's URL redaction sees every parameter.
  const query = rows($, 'QUERY');
  let url = ($('#targetUrl').attr('value') ?? '').trim();
  if (query.length > 0) {
    url += (url.includes('?') ? '&' : '?') + query.map((p) => `${p.name}=${p.value}`).join('&');
  }

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
