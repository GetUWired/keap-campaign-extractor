import { describe, expect, it } from 'vitest';
import { KIND_CANDIDATES, mapRecord } from '../src/api/catalogue.js';

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
