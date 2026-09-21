import { describe, expect, it } from 'vitest';
import { SOURCES } from '../src/content/sources/index.js';
import { KIND_ATTRIBUTES, type ContentKind } from '../src/content/types.js';

describe('SOURCES', () => {
  const entries = Object.entries(SOURCES) as [ContentKind, NonNullable<(typeof SOURCES)[ContentKind]>][];

  it('serves exactly the id spaces the spike confirmed', () => {
    expect(
      entries.flatMap(([, source]) => source.attributes.map((a) => `${source.kind}:${a}`)).sort(),
    ).toEqual([
      'email:marketingEmailId',
      'form:webformId',
      'http:httpRequestConfigId',
      'note:marketingNoteId',
      'sms:marketingAutomatedSmsId',
    ]);
  });

  it('files every source under its own kind, serving only that kind’s attributes', () => {
    for (const [kind, source] of entries) {
      expect(source.kind).toBe(kind);
      for (const attribute of source.attributes) expect(KIND_ATTRIBUTES[kind]).toContain(attribute);
    }
  });

  it('asks for the API key only for REST-backed kinds', () => {
    expect(entries.filter(([, s]) => s.needsApiKey).map(([k]) => k).sort()).toEqual(['email', 'form']);
    expect(entries.filter(([, s]) => s.needsBrowser).map(([k]) => k).sort()).toEqual(['http', 'note', 'sms']);
  });
});
