import { describe, expect, it } from 'vitest';
import { allAccountTags, formatFor, parseTagList } from '../src/analyze/tagList.js';

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
      { id: '13269', name: 'Nurture Emails', group: null, change: 'delete' },
      { id: '14799', name: 'Old Newsletter', group: 'newsletter', change: 'merge' },
    ]);
  });

  it('treats a file with no group column as all deletions', () => {
    // A plain delete list should not need an empty column.
    const csv = 'id,name\n13269,Nurture Emails\n';
    expect(parseTagList(csv, 'csv').tags).toEqual([
      { id: '13269', name: 'Nurture Emails', group: null, change: 'delete' },
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

describe('parseTagList — a tag export with Delete/Merge columns', () => {
  // The real export lists the whole account and flags a subset: 6,227 rows,
  // 2,008 deletes, 1,510 merges. Reading every row would request 2,709 tags
  // nobody intends to touch.
  const csv =
    'id,Delete,Keep,Merge,tag_name\n' +
    '1,TRUE,FALSE,FALSE,Bin me\n' +
    '2,FALSE,TRUE,FALSE,Keep me\n' +
    '3,FALSE,FALSE,TRUE,Fold me in\n';

  it('takes only the flagged rows', () => {
    expect(parseTagList(csv, 'csv').tags.map((t) => t.id)).toEqual(['1', '3']);
  });

  it('reads Delete as a deletion and Merge as a combine', () => {
    const tags = parseTagList(csv, 'csv').tags;
    expect(tags.find((t) => t.id === '1')?.group).toBeNull();
    expect(tags.find((t) => t.id === '3')?.group).not.toBeNull();
  });

  it('reads the name from tag_name', () => {
    expect(parseTagList(csv, 'csv').tags[0]?.name).toBe('Bin me');
  });

  it('says the merge targets are unknown, since duplicates cannot be found without them', () => {
    const list = parseTagList(csv, 'csv');
    expect(list.warnings.some((w) => /no group column/i.test(w))).toBe(true);
  });

  it('prefers a real group column when the export has one', () => {
    const withGroup = 'id,Delete,Merge,tag_name,group\n3,FALSE,TRUE,Fold me in,newsletter\n';
    expect(parseTagList(withGroup, 'csv').tags[0]?.group).toBe('newsletter');
  });

  it('treats a row flagged for both as a combine, and says so', () => {
    const both = 'id,Delete,Merge,tag_name\n1,TRUE,TRUE,Confused\n';
    const list = parseTagList(both, 'csv');
    expect(list.tags[0]?.group).not.toBeNull();
  });

  it('says so when the columns exist but nothing is flagged', () => {
    const none = 'id,Delete,Merge,tag_name\n1,FALSE,FALSE,Untouched\n';
    const list = parseTagList(none, 'csv');
    expect(list.tags).toEqual([]);
    expect(list.warnings.some((w) => /no row is marked/i.test(w))).toBe(true);
  });

  it('leaves a plain id/name/group list alone', () => {
    const plain = 'id,name,group\n1,A,\n2,B,newsletter\n';
    expect(parseTagList(plain, 'csv').tags).toEqual([
      { id: '1', name: 'A', group: null, change: 'delete' },
      { id: '2', name: 'B', group: 'newsletter', change: 'merge' },
    ]);
  });
});

describe('allAccountTags', () => {
  const catalog = [
    { id: 'tag:320', kind: 'tag', name: 'Submitted Widget Form' },
    { id: 'tag:321', kind: 'tag', name: 'Bought' },
    { id: 'product:9', kind: 'product', name: 'Not a tag' },
  ];

  it('takes every tag and nothing else', () => {
    expect(allAccountTags(catalog).tags).toEqual([
      { id: '320', name: 'Submitted Widget Form', group: null, change: 'none' },
      { id: '321', name: 'Bought', group: null, change: 'none' },
    ]);
  });

  it('plans no change, because an audit is not a plan', () => {
    // Otherwise every tag in the account renders with a DELETE badge.
    expect(allAccountTags(catalog).tags.every((t) => t.change === 'none')).toBe(true);
  });

  it('accepts a bare id as well as a prefixed one', () => {
    expect(allAccountTags([{ id: '77', kind: 'tag', name: 'X' }]).tags[0]?.id).toBe('77');
  });

  it('keeps the first of a duplicate id', () => {
    const dupes = [
      { id: 'tag:1', kind: 'tag', name: 'First' },
      { id: 'tag:1', kind: 'tag', name: 'Second' },
    ];
    expect(allAccountTags(dupes).tags).toHaveLength(1);
  });
});

describe('parseTagList — JSON', () => {
  it('reads delete and combine into one list', () => {
    const json = JSON.stringify({
      delete: [{ id: '13269', name: 'Nurture Emails' }],
      combine: [{ group: 'newsletter', tags: [{ id: '14799', name: 'Old Newsletter' }] }],
    });
    expect(parseTagList(json, 'json').tags).toEqual([
      { id: '13269', name: 'Nurture Emails', group: null, change: 'delete' },
      { id: '14799', name: 'Old Newsletter', group: 'newsletter', change: 'merge' },
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
    expect(list.tags).toEqual([{ id: '1', name: 'A', group: 'g', change: 'merge' }]);
    expect(list.warnings.some((w) => /both/i.test(w))).toBe(true);
  });

  it('throws on malformed JSON rather than returning an empty list', () => {
    expect(() => parseTagList('{oops', 'json')).toThrow();
  });
});
