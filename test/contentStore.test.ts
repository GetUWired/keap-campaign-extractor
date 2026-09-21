import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertSafeFileName,
  isItemStored,
  rawItemDirFor,
  readStoredItem,
  writeStoredItem,
} from '../src/content/store.js';
import type { ContentItemKey, FetchedContent } from '../src/content/types.js';

const KEY: ContentItemKey = { kind: 'sms', attribute: 'marketingAutomatedSmsId', id: '5' };
const FETCHED: FetchedContent = {
  record: { kind: 'sms', name: 'Reminder', text: 'Hi ~Contact.FirstName~', sender: null },
  files: [],
  evidence: [{ name: 'response.json', body: '{"id":5}' }],
  assetUrls: [],
};

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'content-store-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('assertSafeFileName', () => {
  it.each(['body.html', 'page.html', 'response-1.json'])('accepts %s', (name) => {
    expect(() => assertSafeFileName(name)).not.toThrow();
  });

  it.each(['../x', '.hidden', 'a/b', '', 'x..y'])('refuses %s', (name) => {
    expect(() => assertSafeFileName(name)).toThrow(/Unsafe/);
  });
});

describe('the raw store', () => {
  it('files an item by kind and id space', () => {
    expect(rawItemDirFor('jordan', KEY)).toBe(
      'artifacts/jordan/content/raw/sms/marketingAutomatedSmsId-5',
    );
  });

  it('round-trips an item and marks it stored', async () => {
    expect(isItemStored('jordan', KEY, root)).toBe(false);
    await writeStoredItem('jordan', KEY, FETCHED, ['https://x/a.png'], '2026-09-21T00:00:00Z', root);

    expect(isItemStored('jordan', KEY, root)).toBe(true);
    const stored = await readStoredItem('jordan', KEY, root);
    expect(stored?.record).toEqual(FETCHED.record);
    expect(stored?.assetUrls).toEqual(['https://x/a.png']);
    const evidence = await readFile(join(stored?.dir ?? '', 'evidence', 'response.json'), 'utf8');
    expect(evidence).toBe('{"id":5}');
  });

  it('replaces a previous fetch entirely', async () => {
    await writeStoredItem('jordan', KEY, FETCHED, [], 'a', root);
    await writeStoredItem('jordan', KEY, { ...FETCHED, evidence: [] }, [], 'b', root);
    const stored = await readStoredItem('jordan', KEY, root);
    await expect(
      readFile(join(stored?.dir ?? '', 'evidence', 'response.json'), 'utf8'),
    ).rejects.toThrow();
  });

  it('returns null for an item never stored', async () => {
    expect(await readStoredItem('jordan', KEY, root)).toBeNull();
  });
});
