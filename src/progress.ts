import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeAppName } from './app.js';

export type CampaignStatus = 'done' | 'failed';

export interface ProgressEntry {
  status: CampaignStatus;
  at: string;
  cells?: number;
  decisions?: number;
  error?: string;
}

export interface Progress {
  app: string;
  enumeratedAt: string | null;
  startedAt: string;
  updatedAt: string;
  total: number;
  entries: Record<string, ProgressEntry>;
}

export function emptyProgress(
  app: string,
  total: number,
  enumeratedAt: string | null,
  now: string,
): Progress {
  return { app, enumeratedAt, startedAt: now, updatedAt: now, total, entries: {} };
}

/**
 * The work queue, in the order the caller supplied.
 *
 * A `failed` entry is pending again: failures are usually transient — a slow
 * editor, a timeout — and a retry costs under two seconds.
 */
export function pendingFunnelIds(
  progress: Progress,
  allFunnelIds: string[],
  force: boolean,
): string[] {
  if (force) return [...allFunnelIds];
  return allFunnelIds.filter((id) => progress.entries[id]?.status !== 'done');
}

export function recordOutcome(
  progress: Progress,
  funnelId: string,
  entry: ProgressEntry,
  now: string,
): Progress {
  return {
    ...progress,
    updatedAt: now,
    entries: { ...progress.entries, [funnelId]: entry },
  };
}

/**
 * Drops `done` entries whose artifacts are not actually on disk.
 *
 * This is the mitigation for keeping the progress record in a file separate
 * from the artifacts it describes: the file is the record, but disk gets the
 * final say. A deleted campaign directory re-extracts instead of being skipped
 * forever on the strength of a stale claim.
 *
 * Takes a predicate rather than reading the filesystem, so the logic stays
 * testable offline.
 */
export function reconcile(
  progress: Progress,
  isComplete: (funnelId: string) => boolean,
  now: string,
): { progress: Progress; demoted: string[] } {
  const demoted: string[] = [];
  const entries: Record<string, ProgressEntry> = {};

  for (const [funnelId, entry] of Object.entries(progress.entries)) {
    if (entry.status === 'done' && !isComplete(funnelId)) {
      demoted.push(funnelId);
      continue;
    }
    entries[funnelId] = entry;
  }

  if (demoted.length === 0) return { progress, demoted };
  return { progress: { ...progress, updatedAt: now, entries }, demoted };
}

export function progressPathFor(app: string): string {
  return join('artifacts', normalizeAppName(app), 'progress.json');
}

/**
 * Returns null when absent or unreadable.
 *
 * A corrupt record must not stop a run: the artifacts on disk are unaffected,
 * and reconciliation rebuilds the completed set on the next pass.
 */
export async function loadProgress(app: string): Promise<Progress | null> {
  try {
    return JSON.parse(await readFile(progressPathFor(app), 'utf8')) as Progress;
  } catch {
    return null;
  }
}

/** Written to a temp file and renamed, so a kill mid-write cannot corrupt it. */
export async function saveProgress(app: string, progress: Progress): Promise<void> {
  const path = progressPathFor(app);
  const temp = `${path}.tmp`;
  await writeFile(temp, JSON.stringify(progress, null, 2), 'utf8');
  await rename(temp, path);
}
