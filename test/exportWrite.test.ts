import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExportPlan, Manifest, PlannedFile } from '../src/export/plan.js';
import { writeExport } from '../src/export/write.js';

const planOf = (files: PlannedFile[]): ExportPlan => ({ files, manifest: {} as Manifest });

describe('writeExport', () => {
  let root: string;
  let out: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'export-write-'));
    out = join(root, 'export');
    await mkdir(join(out, 'campaigns', '9-gone'), { recursive: true });
    await writeFile(join(out, 'campaigns', '9-gone', 'campaign.json'), '{}');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('removes files a previous run left behind', async () => {
    const source = join(root, 'logo.png');
    await writeFile(source, 'png');
    await writeExport(
      planOf([
        { path: 'manifest.json', data: '{"ok":true}\n' },
        { path: 'campaigns/1-new/assets/logo.png', copyFrom: source },
      ]),
      out,
    );
    expect(existsSync(join(out, 'campaigns', '9-gone'))).toBe(false);
    expect(await readFile(join(out, 'manifest.json'), 'utf8')).toBe('{"ok":true}\n');
    expect(await readFile(join(out, 'campaigns', '1-new', 'assets', 'logo.png'), 'utf8')).toBe('png');
  });

  it('refuses a path that climbs out of the export before deleting anything', async () => {
    await expect(
      writeExport(
        planOf([
          { path: 'manifest.json', data: '{}' },
          { path: 'campaigns/../../escaped.json', data: '{}' },
        ]),
        out,
      ),
    ).rejects.toThrow(/Refusing to write outside the export/);
    expect(existsSync(join(out, 'campaigns', '9-gone', 'campaign.json'))).toBe(true);
    expect(existsSync(join(root, 'escaped.json'))).toBe(false);
  });
});
