import { describe, expect, it } from 'vitest';
import {
  KIND_CANDIDATES,
  assertAccountIdentity,
  fetchCatalogue,
  mapRecord,
  probeKind,
} from '../src/api/catalogue.js';
import { type ApiClient, ApiError } from '../src/api/client.js';

describe('mapRecord', () => {
  it('reads a tag', () => {
    expect(mapRecord('tag', { id: 646, name: 'Bought the thing' })).toEqual({
      id: 'tag:646',
      kind: 'tag',
      name: 'Bought the thing',
      extra: {},
    });
  });

  it('lifts a tag category into extra', () => {
    expect(
      mapRecord('tag', { id: 646, name: 'Bought', category: { id: 3, name: 'Purchases' } }),
    ).toEqual({
      id: 'tag:646',
      kind: 'tag',
      name: 'Bought',
      extra: { category: 'Purchases' },
    });
  });

  it('keeps an email subject line, which is the reason to fetch emails at all', () => {
    expect(
      mapRecord('email', { id: 1200, title: 'Welcome 1', subject: 'Thanks for signing up' }),
    ).toEqual({
      id: 'email:1200',
      kind: 'email',
      name: 'Welcome 1',
      extra: { subject: 'Thanks for signing up' },
    });
  });

  it('falls back through the name-ish fields Keap uses inconsistently', () => {
    expect(mapRecord('product', { id: 7, product_name: 'Course' })?.name).toBe('Course');
    expect(mapRecord('form', { id: 3, title: 'Contact us' })?.name).toBe('Contact us');
    expect(mapRecord('user', { id: 9, given_name: 'Ada', family_name: 'Lovelace' })?.name).toBe(
      'Ada Lovelace',
    );
  });

  it('accepts a record whose name is genuinely absent rather than inventing one', () => {
    expect(mapRecord('tag', { id: 646 })).toEqual({
      id: 'tag:646',
      kind: 'tag',
      name: null,
      extra: {},
    });
  });

  it('rejects a record with no usable id', () => {
    expect(mapRecord('tag', { name: 'no id' })).toBeNull();
    expect(mapRecord('tag', null)).toBeNull();
    expect(mapRecord('tag', 'nonsense')).toBeNull();
  });

  it('strips the Java-Long suffix, as everywhere else in this codebase', () => {
    expect(mapRecord('tag', { id: '646L', name: 'x' })?.id).toBe('tag:646');
  });

  it('offers candidate paths for every kind enrichment was asked to name', () => {
    const kinds = KIND_CANDIDATES.map((c) => c.kind);
    for (const kind of ['tag', 'email', 'product', 'user', 'webform', 'landingPage', 'form']) {
      expect(kinds, kind).toContain(kind);
    }
    for (const candidate of KIND_CANDIDATES) {
      expect(candidate.paths.length, candidate.kind).toBeGreaterThan(0);
    }
  });
});

/** An ApiClient backed by a path→response table. Missing paths 404. */
function fakeClient(table: Record<string, unknown>): ApiClient {
  const lookup = async (path: string): Promise<unknown> => {
    if (!(path in table)) throw new ApiError(404, path, `GET ${path} failed with 404`);
    const value = table[path];
    if (value instanceof Error) throw value;
    return value;
  };
  return {
    get: lookup,
    getAll: async (path) => {
      const page = await lookup(path);
      return Array.isArray(page) ? page : [];
    },
  };
}

describe('assertAccountIdentity', () => {
  it('passes when the app name appears anywhere in the profile', async () => {
    const client = fakeClient({
      '/crm/rest/v1/account/profile': {
        name: 'Jordan Ltd',
        website: 'https://jordan.infusionsoft.com',
      },
    });
    await expect(assertAccountIdentity(client, 'jordan')).resolves.toBeUndefined();
  });

  it('matches case-insensitively', async () => {
    const client = fakeClient({ '/crm/rest/v1/account/profile': { name: 'JORDAN' } });
    await expect(assertAccountIdentity(client, 'jordan')).resolves.toBeUndefined();
  });

  it('refuses when the key belongs to a different account', async () => {
    const client = fakeClient({ '/crm/rest/v1/account/profile': { name: 'Someone Else Ltd' } });
    await expect(assertAccountIdentity(client, 'jordan')).rejects.toThrow(
      /does not mention "jordan"/i,
    );
  });

  it('lists the profile field NAMES on failure, never their values', async () => {
    const client = fakeClient({
      '/crm/rest/v1/account/profile': { name: 'Acme', phone: '555-0100', email: 'a@b.c' },
    });
    const error = await assertAccountIdentity(client, 'jordan').catch((e: unknown) => e);
    const message = (error as Error).message;
    expect(message).toContain('name');
    expect(message).toContain('phone');
    expect(message).not.toContain('555-0100');
    expect(message).not.toContain('a@b.c');
  });
});

describe('probeKind', () => {
  it('returns the first path that answers', async () => {
    const client = fakeClient({ '/crm/rest/v1/tags': [] });
    await expect(
      probeKind(client, 'tag', ['/crm/rest/v2/tags', '/crm/rest/v1/tags']),
    ).resolves.toEqual({ endpoint: '/crm/rest/v1/tags' });
  });

  it('reports unavailable, naming every path it tried, when none answer', async () => {
    const result = await probeKind(fakeClient({}), 'landingPage', ['/crm/rest/v2/landingPages']);
    expect(result).toEqual({
      unavailable: 'no candidate endpoint answered: /crm/rest/v2/landingPages (404)',
    });
  });

  it('lets a credential failure through rather than reporting it as unavailable', async () => {
    // A 401 means the key is wrong, not that the resource does not exist.
    // Reporting it as "unavailable" would hide a broken run behind a shrug.
    const client = fakeClient({
      '/crm/rest/v1/tags': new ApiError(401, '/crm/rest/v1/tags', 'rejected (401)'),
    });
    await expect(probeKind(client, 'tag', ['/crm/rest/v1/tags'])).rejects.toThrow(/401/);
  });
});

describe('fetchCatalogue', () => {
  const profile = { '/crm/rest/v1/account/profile': { name: 'jordan' } };

  it('collects every available kind and records the ones that are not', async () => {
    const client = fakeClient({
      ...profile,
      '/crm/rest/v1/tags': [{ id: 646, name: 'Bought' }],
      '/crm/rest/v1/products': [{ id: 7, product_name: 'Course' }],
    });
    const catalogue = await fetchCatalogue(client, 'jordan');

    expect(catalogue.appName).toBe('jordan');
    expect(catalogue.entities).toContainEqual({
      id: 'tag:646',
      kind: 'tag',
      name: 'Bought',
      extra: {},
    });
    expect(catalogue.sources.tag).toEqual({ endpoint: '/crm/rest/v1/tags', count: 1 });
    expect(catalogue.sources.landingPage).toMatchObject({
      unavailable: expect.stringContaining('no candidate endpoint answered'),
    });
  });

  it('stamps fetchedAt as an ISO timestamp', async () => {
    const client = fakeClient({ ...profile, '/crm/rest/v1/tags': [{ id: 1, name: 'x' }] });
    const catalogue = await fetchCatalogue(client, 'jordan');
    expect(catalogue.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('warns on a record it had to drop', async () => {
    const client = fakeClient({ ...profile, '/crm/rest/v1/tags': [{ name: 'no id' }] });
    const catalogue = await fetchCatalogue(client, 'jordan').catch(() => null);
    expect(catalogue).toBeNull(); // nothing usable was fetched at all
  });

  it('warns about dropped records while still keeping the usable ones', async () => {
    const client = fakeClient({
      ...profile,
      '/crm/rest/v1/tags': [{ name: 'no id' }, { id: 5, name: 'fine' }],
    });
    const catalogue = await fetchCatalogue(client, 'jordan');
    expect(catalogue.warnings.some((w) => /1 tag record\(s\) had no usable id/i.test(w))).toBe(true);
    expect(catalogue.entities).toHaveLength(1);
  });

  it('never mints a second entity from an endpoint another kind already claimed', async () => {
    // webform and form both name /forms. Fetching it twice would turn every
    // webform into an identically-numbered internal form that may not exist.
    const client = fakeClient({ ...profile, '/crm/rest/v1/forms': [{ id: 3, title: 'Contact' }] });
    const catalogue = await fetchCatalogue(client, 'jordan');

    expect(catalogue.entities.filter((e) => e.id.endsWith(':3'))).toHaveLength(1);
    expect(catalogue.entities[0]?.id).toBe('webform:3');
    expect(catalogue.sources.form).toEqual({
      unavailable: '/crm/rest/v1/forms is already served as "webform" — not separately resolvable',
    });
  });

  it('fails when no kind at all could be fetched', async () => {
    await expect(fetchCatalogue(fakeClient(profile), 'jordan')).rejects.toThrow(/no entities/i);
  });

  it('checks identity before fetching anything', async () => {
    const client = fakeClient({
      '/crm/rest/v1/account/profile': { name: 'other' },
      '/crm/rest/v1/tags': [{ id: 1, name: 'x' }],
    });
    await expect(fetchCatalogue(client, 'jordan')).rejects.toThrow(/does not mention/i);
  });
});
