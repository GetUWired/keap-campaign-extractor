import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeAppName } from '../app.js';
import {
  CONTENT_ID_PATTERN,
  type ContentItemKey,
  type ContentRecord,
  type FetchedContent,
} from './types.js';

/**
 * File names come from sources, which parse remote responses — so a name is a
 * path segment someone else chose. Refuse anything that is not a plain name.
 */
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

export function assertSafeFileName(name: string): void {
  if (!SAFE_FILE_NAME.test(name) || name.includes('..')) {
    throw new Error(`Unsafe content file name ${JSON.stringify(name)}`);
  }
}

export function contentRootFor(app: string): string {
  return join('artifacts', normalizeAppName(app), 'content');
}

export function rawItemDirFor(app: string, key: ContentItemKey): string {
  if (!/^[A-Za-z]+$/.test(key.attribute) || !CONTENT_ID_PATTERN.test(key.id)) {
    throw new Error(`Unsafe content key ${key.kind}/${key.attribute}/${key.id}`);
  }
  return join(contentRootFor(app), 'raw', key.kind, `${key.attribute}-${key.id}`);
}

export interface StoredItem {
  key: ContentItemKey;
  fetchedAt: string;
  record: ContentRecord;
  /** Names under <dir>/files — the ones the export copies. */
  files: string[];
  /** Every asset URL this item uses, including stylesheet dependencies. */
  assetUrls: string[];
  /** Where the item lives on disk. Not persisted; derived on read. */
  dir: string;
}

/**
 * Replaces the item on disk. `item.json` is written last: its presence is what
 * marks the item complete, so a kill mid-write leaves an incomplete item that
 * the next run re-fetches rather than a partial one it trusts.
 */
export async function writeStoredItem(
  app: string,
  key: ContentItemKey,
  fetched: FetchedContent,
  assetUrls: string[],
  now: string,
  root = '.',
): Promise<StoredItem> {
  const dir = join(root, rawItemDirFor(app, key));
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, 'files'), { recursive: true });
  await mkdir(join(dir, 'evidence'), { recursive: true });

  for (const file of fetched.files) {
    assertSafeFileName(file.name);
    await writeFile(join(dir, 'files', file.name), file.body);
  }
  for (const file of fetched.evidence) {
    assertSafeFileName(file.name);
    await writeFile(join(dir, 'evidence', file.name), file.body);
  }

  const persisted = {
    key,
    fetchedAt: now,
    record: fetched.record,
    files: fetched.files.map((f) => f.name),
    assetUrls,
  };
  await writeFile(join(dir, 'item.json'), JSON.stringify(persisted, null, 2), 'utf8');
  return { ...persisted, dir };
}

export async function readStoredItem(
  app: string,
  key: ContentItemKey,
  root = '.',
): Promise<StoredItem | null> {
  const dir = join(root, rawItemDirFor(app, key));
  try {
    const persisted = JSON.parse(await readFile(join(dir, 'item.json'), 'utf8')) as Omit<
      StoredItem,
      'dir'
    >;
    return { ...persisted, dir };
  } catch {
    return null;
  }
}

export function isItemStored(app: string, key: ContentItemKey, root = '.'): boolean {
  return existsSync(join(root, rawItemDirFor(app, key), 'item.json'));
}
