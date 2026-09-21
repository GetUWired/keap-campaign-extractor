import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertSafeFileName, contentRootFor } from '../store.js';
import type { AssetRecord } from './download.js';

/** Every asset URL ever seen, keyed by URL, with how it went. */
export interface AssetIndex {
  updatedAt: string;
  assets: Record<string, AssetRecord>;
}

export interface AssetLedger {
  get(url: string): AssetRecord | undefined;
  put(record: AssetRecord, bytes: Buffer | null): Promise<void>;
  read(record: AssetRecord): Promise<Buffer | null>;
}

export function assetDirFor(app: string, root = '.'): string {
  return join(root, contentRootFor(app), 'assets');
}

export function assetFilePathFor(app: string, file: string, root = '.'): string {
  assertSafeFileName(file);
  return join(assetDirFor(app, root), file);
}

function indexPathFor(app: string, root: string): string {
  return join(assetDirFor(app, root), 'index.json');
}

export async function loadAssetIndex(app: string, root = '.'): Promise<AssetIndex> {
  try {
    return JSON.parse(await readFile(indexPathFor(app, root), 'utf8')) as AssetIndex;
  } catch {
    return { updatedAt: '', assets: {} };
  }
}

export async function saveAssetIndex(app: string, index: AssetIndex, root = '.'): Promise<void> {
  await mkdir(assetDirFor(app, root), { recursive: true });
  const path = indexPathFor(app, root);
  await writeFile(`${path}.tmp`, JSON.stringify(index, null, 2), 'utf8');
  await rename(`${path}.tmp`, path);
}

async function hasSize(path: string, size: number): Promise<boolean> {
  try {
    return (await stat(path)).size === size;
  } catch {
    return false;
  }
}

/** Files are content-addressed, so the same image used by forty emails is stored once. */
export function createAssetLedger(
  app: string,
  initial: AssetIndex,
  root = '.',
): AssetLedger & { index(): AssetIndex } {
  const assets: Record<string, AssetRecord> = { ...initial.assets };
  let updatedAt = initial.updatedAt;

  return {
    get: (url) => assets[url],
    async put(record, bytes) {
      if (record.status === 'downloaded') {
        if (!record.file || bytes === null) {
          // A downloaded entry with no file behind it would export as missing forever.
          throw new Error(`asset ledger: ${record.url} recorded as downloaded without its bytes`);
        }
        const path = assetFilePathFor(app, record.file, root);
        // Content-addressed, so a file of the right size is this file. Anything
        // else is a leftover from an interrupted write and is replaced.
        if (!(await hasSize(path, bytes.length))) {
          await mkdir(assetDirFor(app, root), { recursive: true });
          const temp = `${path}.${process.pid}.tmp`;
          await writeFile(temp, bytes);
          await rename(temp, path);
        }
      }
      assets[record.url] = record;
      updatedAt = new Date().toISOString();
    },
    async read(record) {
      if (record.status !== 'downloaded' || !record.file) return null;
      try {
        return await readFile(assetFilePathFor(app, record.file, root));
      } catch {
        return null;
      }
    },
    index: () => ({ updatedAt, assets: { ...assets } }),
  };
}
