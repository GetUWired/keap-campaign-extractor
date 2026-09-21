import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import type { ExportPlan } from './plan.js';

/** A planned path is relative and stays inside the export. */
function assertInside(path: string): void {
  const normalized = normalize(path);
  if (normalized.startsWith('..') || normalized.startsWith(sep) || normalized.includes(`..${sep}`)) {
    throw new Error(`Refusing to write outside the export: ${path}`);
  }
}

/**
 * Replaces the export directory wholesale, so a campaign or asset that has
 * gone away does not linger from a previous run.
 */
export async function writeExport(plan: ExportPlan, outDir: string): Promise<void> {
  for (const file of plan.files) assertInside(file.path);
  await rm(outDir, { recursive: true, force: true });
  for (const file of plan.files) {
    const target = join(outDir, file.path);
    await mkdir(dirname(target), { recursive: true });
    if ('copyFrom' in file) await copyFile(file.copyFrom, target);
    else await writeFile(target, file.data);
  }
}
