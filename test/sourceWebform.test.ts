import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ApiClient } from '../src/api/client.js';
import { WEBFORMS_PATH, createWebformSource } from '../src/content/sources/webform.js';
import { ContentNotFoundError, type ContentItemKey, type FetchContext } from '../src/content/types.js';

const list = (JSON.parse(readFileSync('test/fixtures/content/webforms-list.json', 'utf8')) as {
  webforms: unknown[];
}).webforms;

function ctxWith(getAll: ApiClient['getAll']) {
  const api: ApiClient = {
    get: async () => {
      throw new Error('not used');
    },
    getAll,
  };
  const ctx: FetchContext = { app: 'jordan', baseUrl: 'https://jordan.infusionsoft.com', browser: null, api };
  return ctx;
}

const key = (id: string): ContentItemKey => ({ kind: 'form', attribute: 'webformId', id });

describe('createWebformSource', () => {
  it('declares what it needs', () => {
    expect(createWebformSource()).toMatchObject({
      kind: 'form',
      attributes: ['webformId'],
      needsApiKey: true,
      needsBrowser: false,
    });
  });

  it('maps a list entry and says fields were not available', async () => {
    const source = createWebformSource();
    const fetched = await source.fetch(key('5'), ctxWith(async () => list));
    expect(fetched.record).toEqual({
      kind: 'form',
      name: 'Test Form',
      fields: [],
      fieldsAvailable: false,
      thankYou: { type: 'redirect', value: 'https://example.com/thanks' },
      publicUrl: 'https://example.infusionsoft.com/app/form/933be0bce44888029d76a647dbd42673',
      formType: 'LEGACY',
    });
    expect(fetched.files).toEqual([]);
    expect(fetched.assetUrls).toEqual([]);
    expect(fetched.evidence.map((f) => f.name)).toEqual(['webform.json']);
    expect(source.validate(fetched)).toBeNull();
  });

  it('maps a message exit with no thank-you URL', async () => {
    const fetched = await createWebformSource().fetch(key('3'), ctxWith(async () => list));
    expect(fetched.record).toMatchObject({ thankYou: { type: 'message', value: null } });
  });

  it('reads the list once per run', async () => {
    let calls = 0;
    const paths: string[] = [];
    const source = createWebformSource();
    const ctx = ctxWith(async (path) => {
      calls++;
      paths.push(path);
      return list;
    });
    await source.fetch(key('3'), ctx);
    await source.fetch(key('5'), ctx);
    expect(calls).toBe(1);
    expect(paths).toEqual([WEBFORMS_PATH]);
  });

  it('retries the list after a failed read', async () => {
    let calls = 0;
    const source = createWebformSource();
    const ctx = ctxWith(async () => {
      calls++;
      if (calls === 1) throw new Error('rate limited');
      return list;
    });
    await expect(source.fetch(key('3'), ctx)).rejects.toThrow(/rate limited/);
    await expect(source.fetch(key('3'), ctx)).resolves.toMatchObject({ record: { name: 'E-mail Opt-Out Form' } });
  });

  it('reports a form missing from the list as a plain failure, not confirmed deleted', async () => {
    const source = createWebformSource();
    const error: unknown = await source.fetch(key('999'), ctxWith(async () => list)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ContentNotFoundError);
    expect((error as Error).message).toBe(
      'web form 999 is not listed by /crm/rest/v2/webforms — it may be deleted, archived, or a form type the API does not list',
    );
  });
});
