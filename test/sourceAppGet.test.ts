import type { BrowserContext } from 'playwright';
import { describe, expect, it } from 'vitest';
import { APP_GET_TIMEOUT_MS, appGet, assertContentPath } from '../src/content/sources/appGet.js';
import { ContentNotFoundError, type FetchContext } from '../src/content/types.js';
import { isSessionExpired } from '../src/errors.js';

interface Reply {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

function fakeContext(reply: Reply) {
  const calls: { url: string; options: unknown }[] = [];
  const browser = {
    request: {
      get: async (url: string, options: unknown) => {
        calls.push({ url, options });
        return {
          status: () => reply.status,
          headers: () => reply.headers ?? {},
          text: async () => reply.body ?? '',
          url: () => url,
        };
      },
    },
  } as unknown as BrowserContext;
  const ctx: FetchContext = { app: 'se232', baseUrl: 'https://se232.infusionsoft.com', browser, api: null };
  return { ctx, calls };
}

describe('assertContentPath', () => {
  it.each([
    '/app/automatedSmsFunnel/45179',
    '/app/noteFunnel/edit?marketingNoteId=1&mayPickUser=false',
    '/app/httpRequestFunnel/requests/5',
  ])('allows %s', (path) => expect(() => assertContentPath(path)).not.toThrow());

  it.each([
    '/app/automatedSmsFunnel/sendTest',
    '/app/automatedSmsFunnel/45179/clone',
    '/app/httpFunnel/3061033',
    '/app/funnel/105',
    '/app/noteFunnel/editSomethingElse',
    '/crm/rest/v2/emails',
  ])('refuses %s', (path) => expect(() => assertContentPath(path)).toThrow(/not a content endpoint/));
});

describe('appGet', () => {
  it('returns the body of a 200, with the timeout and no redirects', async () => {
    const { ctx, calls } = fakeContext({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
    const response = await appGet(ctx, '/app/automatedSmsFunnel/45179');
    expect(response).toEqual({ status: 200, contentType: 'application/json', body: '{"a":1}' });
    expect(calls).toEqual([
      {
        url: 'https://se232.infusionsoft.com/app/automatedSmsFunnel/45179',
        options: { timeout: APP_GET_TIMEOUT_MS, maxRedirects: 0 },
      },
    ]);
  });

  it('refuses a path off the allowlist without making a request', async () => {
    const { ctx, calls } = fakeContext({ status: 200 });
    await expect(appGet(ctx, '/app/automatedSmsFunnel/sendTest')).rejects.toThrow(/not a content endpoint/);
    expect(calls).toEqual([]);
  });

  it('treats a redirect to sign-in as an expired session', async () => {
    const { ctx } = fakeContext({ status: 302, headers: { location: 'https://signin.infusionsoft.com/login' } });
    const error = await appGet(ctx, '/app/automatedSmsFunnel/1').catch((e: unknown) => e);
    expect(isSessionExpired(error)).toBe(true);
  });

  it('refuses any other redirect', async () => {
    const { ctx } = fakeContext({ status: 302, headers: { location: '/app/somewhere' } });
    await expect(appGet(ctx, '/app/automatedSmsFunnel/1')).rejects.toThrow(/redirected unexpectedly/);
  });

  it('reports a 404 as not found', async () => {
    const { ctx } = fakeContext({ status: 404 });
    await expect(appGet(ctx, '/app/automatedSmsFunnel/1')).rejects.toBeInstanceOf(ContentNotFoundError);
  });

  it('treats a 401 as an expired session', async () => {
    const { ctx } = fakeContext({ status: 401 });
    const error = await appGet(ctx, '/app/automatedSmsFunnel/1').catch((e: unknown) => e);
    expect(isSessionExpired(error)).toBe(true);
  });

  it('treats a 403 as an expired session', async () => {
    const { ctx } = fakeContext({ status: 403 });
    const error = await appGet(ctx, '/app/automatedSmsFunnel/1').catch((e: unknown) => e);
    expect(isSessionExpired(error)).toBe(true);
  });

  it('fails on other statuses', async () => {
    const { ctx } = fakeContext({ status: 500 });
    await expect(appGet(ctx, '/app/automatedSmsFunnel/1')).rejects.toThrow(/HTTP 500/);
  });

  it('needs the session', async () => {
    const { ctx } = fakeContext({ status: 200 });
    await expect(appGet({ ...ctx, browser: null }, '/app/automatedSmsFunnel/1')).rejects.toThrow(/session/);
  });
});
