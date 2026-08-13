import { describe, expect, it } from 'vitest';
import { formatFor, parseTagList } from '../src/analyze/tagList.js';

describe('formatFor', () => {
  it('chooses by extension, case-insensitively', () => {
    expect(formatFor('list.csv')).toBe('csv');
    expect(formatFor('/tmp/list.JSON')).toBe('json');
  });

  it('refuses anything else rather than guessing', () => {
    expect(() => formatFor('list.txt')).toThrow(/\.csv.*\.json/i);
  });
});

describe('parseTagList — CSV', () => {
  it('reads id, name and group', () => {
    const csv = 'id,name,group\n13269,Nurture Emails,\n14799,Old Newsletter,newsletter\n';
    expect(parseTagList(csv, 'csv').tags).toEqual([
      { id: '13269', name: 'Nurture Emails', group: null },
      { id: '14799', name: 'Old Newsletter', group: 'newsletter' },
    ]);
  });

  it('treats a file with no group column as all deletions', () => {
    // A plain delete list should not need an empty column.
    const csv = 'id,name\n13269,Nurture Emails\n';
    expect(parseTagList(csv, 'csv').tags).toEqual([
      { id: '13269', name: 'Nurture Emails', group: null },
    ]);
  });

  it('handles quoted fields containing commas', () => {
    // A real tag name: List: Minus TSP, Essence, 2024 trip purchased
    const csv = 'id,name,group\n1,"List: Minus TSP, Essence",\n';
    expect(parseTagList(csv, 'csv').tags[0]?.name).toBe('List: Minus TSP, Essence');
  });

  it('handles an escaped quote inside a quoted field', () => {
    const csv = 'id,name,group\n1,"She said ""yes""",\n';
    expect(parseTagList(csv, 'csv').tags[0]?.name).toBe('She said "yes"');
  });

  it('is case-insensitive about column names', () => {
    const csv = 'ID,Name,Group\n1,A,\n';
    expect(parseTagList(csv, 'csv').tags[0]?.id).toBe('1');
  });

  it('warns and skips a row with no id rather than failing the run', () => {
    const csv = 'id,name,group\n,No Id,\n2,Fine,\n';
    const list = parseTagList(csv, 'csv');
    expect(list.tags.map((t) => t.id)).toEqual(['2']);
    expect(list.warnings.some((w) => /no id/i.test(w))).toBe(true);
  });

  it('warns and skips a duplicate id, keeping the first', () => {
    const csv = 'id,name,group\n1,First,\n1,Second,\n';
    const list = parseTagList(csv, 'csv');
    expect(list.tags).toHaveLength(1);
    expect(list.tags[0]?.name).toBe('First');
    expect(list.warnings.some((w) => /duplicate/i.test(w))).toBe(true);
  });

  it('throws when there is no id column at all, because every row is unusable', () => {
    expect(() => parseTagList('name,group\nA,\n', 'csv')).toThrow(/id column/i);
  });

  it('ignores a trailing blank line', () => {
    expect(parseTagList('id,name\n1,A\n\n', 'csv').tags).toHaveLength(1);
  });
});

describe('parseTagList — JSON', () => {
  it('reads delete and combine into one list', () => {
    const json = JSON.stringify({
      delete: [{ id: '13269', name: 'Nurture Emails' }],
      combine: [{ group: 'newsletter', tags: [{ id: '14799', name: 'Old Newsletter' }] }],
    });
    expect(parseTagList(json, 'json').tags).toEqual([
      { id: '13269', name: 'Nurture Emails', group: null },
      { id: '14799', name: 'Old Newsletter', group: 'newsletter' },
    ]);
  });

  it('accepts either key being absent', () => {
    expect(parseTagList('{"delete":[{"id":"1","name":"A"}]}', 'json').tags).toHaveLength(1);
    expect(parseTagList('{"combine":[]}', 'json').tags).toEqual([]);
  });

  it('warns when the same id is both deleted and combined, treating it as combined', () => {
    // Contradictory: the operator should see it rather than have one silently win.
    const json = JSON.stringify({
      delete: [{ id: '1', name: 'A' }],
      combine: [{ group: 'g', tags: [{ id: '1', name: 'A' }] }],
    });
    const list = parseTagList(json, 'json');
    expect(list.tags).toEqual([{ id: '1', name: 'A', group: 'g' }]);
    expect(list.warnings.some((w) => /both/i.test(w))).toBe(true);
  });

  it('throws on malformed JSON rather than returning an empty list', () => {
    expect(() => parseTagList('{oops', 'json')).toThrow();
  });
});
