import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeAppName } from '../app.js';
import { type ContentItemKey, itemKey } from './types.js';

export type ItemStatus = 'done' | 'failed' | 'notFound';

export interface AssetCounts {
  downloaded: number;
  failed: number;
  tooLarge: number;
  skipped: number;
}

export interface ItemEntry {
  status: ItemStatus;
  at: string;
  error?: string;
  assets?: AssetCounts;
}

/** Keyed by itemKey — `kind:attribute:id`. */
export interface ContentProgress {
  app: string;
  startedAt: string;
  updatedAt: string;
  entries: Record<string, ItemEntry>;
}

export function emptyAssetCounts(): AssetCounts {
  return { downloaded: 0, failed: 0, tooLarge: 0, skipped: 0 };
}

export function emptyContentProgress(app: string, now: string): ContentProgress {
  return { app, startedAt: now, updatedAt: now, entries: {} };
}

/**
 * `failed` is pending again — usually transient. `notFound` is not: a deleted
 * template stays deleted, and asking again every run would only slow the run.
 * `--force` retries both.
 */
export function pendingItems<T extends ContentItemKey>(
  progress: ContentProgress,
  items: T[],
  force: boolean,
): T[] {
  if (force) return [...items];
  return items.filter((item) => {
    const status = progress.entries[itemKey(item)]?.status;
    return status !== 'done' && status !== 'notFound';
  });
}

export function recordItem(
  progress: ContentProgress,
  key: string,
  entry: ItemEntry,
  now: string,
): ContentProgress {
  return { ...progress, updatedAt: now, entries: { ...progress.entries, [key]: entry } };
}

/** Disk gets the final say over the progress file — the same rule as src/progress.ts. */
export function reconcileContent(
  progress: ContentProgress,
  isStored: (key: string) => boolean,
  now: string,
): { progress: ContentProgress; demoted: string[] } {
  const demoted: string[] = [];
  const entries: Record<string, ItemEntry> = {};
  for (const [key, entry] of Object.entries(progress.entries)) {
    if (entry.status === 'done' && !isStored(key)) {
      demoted.push(key);
      continue;
    }
    entries[key] = entry;
  }
  if (demoted.length === 0) return { progress, demoted };
  return { progress: { ...progress, updatedAt: now, entries }, demoted };
}

export function contentProgressPathFor(app: string): string {
  return join('artifacts', normalizeAppName(app), 'content-progress.json');
}

/** Null when absent or unreadable; the store on disk is unaffected either way. */
export async function loadContentProgress(app: string): Promise<ContentProgress | null> {
  try {
    return JSON.parse(await readFile(contentProgressPathFor(app), 'utf8')) as ContentProgress;
  } catch {
    return null;
  }
}

export async function saveContentProgress(app: string, progress: ContentProgress): Promise<void> {
  const path = contentProgressPathFor(app);
  const temp = `${path}.tmp`;
  await writeFile(temp, JSON.stringify(progress, null, 2), 'utf8');
  await rename(temp, path);
}
