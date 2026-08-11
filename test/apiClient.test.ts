import { describe, expect, it, vi } from 'vitest';
import { ApiError, createClient } from '../src/api/client.js';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** A fetch stub that replays a queue of responses and records every call. */
function stubFetch(responses: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('stubFetch: no response queued');
    return next;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const client = (responses: Response[]) => {
  const { impl, calls } = stubFetch(responses);
  return {
    calls,
    api: createClient('secret-key', {
      baseUrl: 'https://api.test',
      fetchImpl: impl,
      throttleMs: 0,
      retryDelayMs: 0,
    }),
  };
};

describe('createClient', () => {
  it('sends the key as X-Keap-API-Key and asks for JSON', async () => {
    const { api, calls } = client([json({ tags: [] })]);
    await api.get('/crm/rest/v1/tags');
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get('X-Keap-API-Key')).toBe('secret-key');
    expect(headers.get('Accept')).toBe('application/json');
    expect(calls[0]?.init.method ?? 'GET').toBe('GET');
  });

  it('builds the URL from base, path and query', async () => {
    const { api, calls } = client([json({})]);
    await api.get('/crm/rest/v1/tags', { limit: '1' });
    expect(calls[0]?.url).toBe('https://api.test/crm/rest/v1/tags?limit=1');
  });

  it('refuses a path outside the allowlist without sending anything', async () => {
    const { api, calls } = client([]);
    await expect(api.get('/crm/rest/v1/contacts')).rejects.toThrow(/allowlist/i);
    expect(calls).toHaveLength(0);
  });

  it('never puts the key in an error message', async () => {
    const { api } = client([json({ message: 'nope' }, 401)]);
    const error = await api.get('/crm/rest/v1/tags').catch((e: unknown) => e);
    expect((error as Error).message).not.toContain('secret-key');
  });

  it('reports 401 as a credential problem', async () => {
    const { api } = client([json({}, 401), json({}, 401)]);
    await expect(api.get('/crm/rest/v1/tags')).rejects.toMatchObject({ status: 401 });
    await expect(api.get('/crm/rest/v1/tags')).rejects.toThrow(/revoked|admin scope/i);
  });

  it('surfaces 404 as an ApiError so the probe can read it as "unavailable"', async () => {
    const { api } = client([json({}, 404)]);
    const error = await api.get('/crm/rest/v1/forms').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
  });

  it('retries a 429 and succeeds', async () => {
    const { api, calls } = client([json({}, 429), json({ tags: [{ id: 1 }] })]);
    await expect(api.get('/crm/rest/v1/tags')).resolves.toEqual({ tags: [{ id: 1 }] });
    expect(calls).toHaveLength(2);
  });

  it('gives up after the retry cap and says how many attempts it made', async () => {
    const { api } = client([json({}, 429), json({}, 429), json({}, 429)]);
    await expect(api.get('/crm/rest/v1/tags')).rejects.toThrow(/rate limit.*2 retries/i);
  });

  it('pages v2 style, following next_page_token until it stops', async () => {
    const { api, calls } = client([
      json({ tags: [{ id: 1 }], next_page_token: 'abc' }),
      json({ tags: [{ id: 2 }] }),
    ]);
    await expect(api.getAll('/crm/rest/v1/tags')).resolves.toEqual([{ id: 1 }, { id: 2 }]);
    expect(calls[1]?.url).toContain('page_token=abc');
  });

  it('pages v1 style, advancing offset until a short page arrives', async () => {
    const full = Array.from({ length: 1000 }, (_, i) => ({ id: i }));
    const { api, calls } = client([json({ tags: full }), json({ tags: [{ id: 1000 }] })]);
    await expect(api.getAll('/crm/rest/v1/tags')).resolves.toHaveLength(1001);
    expect(calls[0]?.url).toContain('limit=1000');
    expect(calls[1]?.url).toContain('offset=1000');
  });

  it('stops after one page when the response is already short', async () => {
    const { api, calls } = client([json({ tags: [{ id: 1 }] })]);
    await api.getAll('/crm/rest/v1/tags');
    expect(calls).toHaveLength(1);
  });

  it('finds the item array whatever the response names it', async () => {
    const { api } = client([json({ products: [{ id: 7 }] })]);
    await expect(api.getAll('/crm/rest/v1/products')).resolves.toEqual([{ id: 7 }]);
  });

  it('treats a bare array response as the page itself', async () => {
    const { api } = client([json([{ id: 7 }])]);
    await expect(api.getAll('/crm/rest/v1/users')).resolves.toEqual([{ id: 7 }]);
  });
});
