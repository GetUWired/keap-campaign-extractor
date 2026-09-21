import { readFileSync } from 'node:fs';
import type { BrowserContext } from 'playwright';
import { describe, expect, it } from 'vitest';
import { redactHttp } from '../src/content/redact.js';
import { httpRequestSource, parseHttpRequestEditor } from '../src/content/sources/httpRequest.js';
import type { ContentItemKey, FetchContext, HttpContent } from '../src/content/types.js';
import { isSessionExpired } from '../src/errors.js';

const SIGN_IN_PAGE = '<form><input id="username"><input type="password"></form><h1>Sign in</h1>';

const empty = readFileSync('test/fixtures/content/http-request-empty.html', 'utf8');
const configured = readFileSync('test/fixtures/content/http-request-configured.html', 'utf8');

function ctxServing(body: string) {
  const urls: string[] = [];
  const browser = {
    request: {
      get: async (url: string) => {
        urls.push(url);
        return {
          status: () => 200,
          headers: () => ({ 'content-type': 'text/html;charset=UTF-8' }),
          text: async () => body,
          url: () => url,
        };
      },
    },
  } as unknown as BrowserContext;
  const ctx: FetchContext = { app: 'se232', baseUrl: 'https://se232.infusionsoft.com', browser, api: null };
  return { ctx, urls };
}

const key = (id: string): ContentItemKey => ({ kind: 'http', attribute: 'httpRequestConfigId', id });

describe('parseHttpRequestEditor', () => {
  it('reads an unconfigured request as an empty POST', () => {
    expect(parseHttpRequestEditor(empty)).toEqual({
      configId: '5',
      record: { kind: 'http', name: null, method: 'POST', url: '', headers: [], fields: [], body: null },
    });
  });

  it('reads method, URL with query parameters, headers and body', () => {
    expect(parseHttpRequestEditor(configured)?.record).toEqual({
      kind: 'http',
      name: null,
      method: 'PUT',
      url: 'https://hooks.example.com/contacts/~Contact.Id~?source=keap&api_key=EXAMPLE_KEY_123',
      headers: [
        { name: 'Authorization', value: 'Bearer EXAMPLE_TOKEN' },
        { name: 'Content-Type', value: 'application/json' },
      ],
      fields: [],
      body: '{"email":"~Contact.Email~"}',
    });
  });

  it('produces a record the export redaction fully covers', () => {
    const record = parseHttpRequestEditor(configured)?.record as HttpContent;
    const { content, redacted } = redactHttp(record);
    expect(content.url).toBe('https://hooks.example.com/contacts/~Contact.Id~?source=keap&api_key=«redacted»');
    expect(content.headers[0]?.value).toBe('«redacted»');
    expect(redacted).toEqual(
      expect.arrayContaining([
        { location: 'query', name: 'api_key' },
        { location: 'header', name: 'Authorization' },
      ]),
    );
  });

  it('percent-encodes query values containing & and = so redaction sees whole pairs', () => {
    // Replace api_key value with one containing & and = (HTML-encoded for the fixture)
    const withInjection = configured.replace(
      'value="EXAMPLE_KEY_123"',
      'value="EXAMPLE&amp;injected=leaked"',
    );
    const record = parseHttpRequestEditor(withInjection)?.record as HttpContent;
    // Value decoded by cheerio: EXAMPLE&injected=leaked, then encoded: EXAMPLE%26injected%3Dleaked
    expect(record.url).toBe(
      'https://hooks.example.com/contacts/~Contact.Id~?source=keap&api_key=EXAMPLE%26injected%3Dleaked',
    );
    // After redaction, neither EXAMPLE nor leaked should appear
    const { content, redacted } = redactHttp(record);
    expect(content.url).not.toContain('EXAMPLE');
    expect(content.url).not.toContain('leaked');
    expect(redacted).toContainEqual({ location: 'query', name: 'api_key' });
  });

  it('preserves merge fields (~) in query parameters without encoding them', () => {
    const withMergeField = configured.replace('value="keap"', 'value="~Contact.Id~"');
    const record = parseHttpRequestEditor(withMergeField)?.record as HttpContent;
    // Merge field stays literal, not encoded
    expect(record.url).toBe(
      'https://hooks.example.com/contacts/~Contact.Id~?source=~Contact.Id~&api_key=EXAMPLE_KEY_123',
    );
  });

  it('appends query parameters before the fragment, not inside it', () => {
    const withFragment = configured.replace(
      'value="https://hooks.example.com/contacts/~Contact.Id~"',
      'value="https://h.example.com/x?a=1#frag"',
    );
    const record = parseHttpRequestEditor(withFragment)?.record as HttpContent;
    expect(record.url).toBe('https://h.example.com/x?a=1&source=keap&api_key=EXAMPLE_KEY_123#frag');

    const { content } = redactHttp(record);
    expect(content.url).not.toContain('EXAMPLE_KEY_123');
  });

  it('returns null for anything that is not the request editor', () => {
    expect(parseHttpRequestEditor('<div id="wrapper_httpRequest"></div>')).toBeNull();
  });

  it('returns null when a required element is missing, even if #httpRequestType is present', () => {
    const renamed = configured.replace('id="paramTable-HEADER"', 'id="paramTable-HEADER-renamed"');
    expect(parseHttpRequestEditor(renamed)).toBeNull();
  });
});

describe('httpRequestSource', () => {
  it('declares what it needs', () => {
    expect(httpRequestSource).toMatchObject({
      kind: 'http',
      attributes: ['httpRequestConfigId'],
      needsApiKey: false,
      needsBrowser: true,
    });
  });

  it('fetches the editor for its config id', async () => {
    const { ctx, urls } = ctxServing(configured);
    const fetched = await httpRequestSource.fetch(key('5'), ctx);
    expect(urls).toEqual(['https://se232.infusionsoft.com/app/httpRequestFunnel/requests/5']);
    expect(fetched.record).toMatchObject({ kind: 'http', method: 'PUT' });
    expect(fetched.evidence.map((f) => f.name)).toEqual(['editor.html']);
    expect(httpRequestSource.validate(fetched)).toBeNull();
  });

  it('refuses an editor for a different config', async () => {
    const { ctx } = ctxServing(configured);
    await expect(httpRequestSource.fetch(key('6'), ctx)).rejects.toThrow(/asked for HTTP request 6/);
  });

  it('refuses an empty shell', async () => {
    const { ctx } = ctxServing('<div id="wrapper_httpRequest"></div>');
    await expect(httpRequestSource.fetch(key('5'), ctx)).rejects.toThrow(/not the HTTP request editor/);
  });

  it('treats a sign-in page served in place of the editor as an expired session', async () => {
    const { ctx } = ctxServing(SIGN_IN_PAGE);
    const error = await httpRequestSource.fetch(key('5'), ctx).catch((e: unknown) => e);
    expect(isSessionExpired(error)).toBe(true);
  });
});
