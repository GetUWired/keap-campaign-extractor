import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeAppName, normalizeFunnelId } from '../app.js';
import type { EntityCatalog } from '../api/catalog.js';
import type { NormalizedCampaign } from '../normalize/campaign.js';
import type { AccountGraph } from '../normalize/graph.js';
import { renderCampaign } from '../render/campaignDoc.js';
import { renderIndex } from '../render/indexDoc.js';

function fail(message: string): void {
  console.error(`\n${message}\n`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const appIndex = argv.indexOf('--app');
  const rawApp = appIndex >= 0 ? argv[appIndex + 1] : undefined;
  if (!rawApp) {
    fail('Usage: npm run render -- --app <appName> [--funnel <funnelId>]');
    return;
  }

  let app: string;
  let only: string | null = null;
  try {
    app = normalizeAppName(rawApp);
    const funnelIndex = argv.indexOf('--funnel');
    const rawFunnel = funnelIndex >= 0 ? argv[funnelIndex + 1] : undefined;
    if (rawFunnel !== undefined) only = normalizeFunnelId(rawFunnel);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  const normalizedDir = join('artifacts', app, 'normalized');
  const graphPath = join('artifacts', app, 'graph.json');
  if (!existsSync(normalizedDir) || !existsSync(graphPath)) {
    fail(`No normalized data at ${normalizedDir}. Run:  npm run normalize -- --app ${app}`);
    return;
  }

  const graph = JSON.parse(await readFile(graphPath, 'utf8')) as AccountGraph;

  // Names are optional; without them pages show ids and say so once.
  let catalog: EntityCatalog | undefined;
  const catalogPath = join('artifacts', app, 'entities.json');
  if (existsSync(catalogPath)) {
    try {
      catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as EntityCatalog;
    } catch {
      console.log(`  warning: ${catalogPath} is unreadable — rendering with ids`);
    }
  }

  const outDir = join('artifacts', app, 'rendered');
  await mkdir(outDir, { recursive: true });

  const campaigns: NormalizedCampaign[] = [];
  let written = 0;
  let skipped = 0;

  for (const file of (await readdir(normalizedDir)).sort()) {
    const match = /^(\d+)\.json$/.exec(file);
    if (!match?.[1]) continue;
    if (only !== null && match[1] !== only) continue;

    try {
      const campaign = JSON.parse(
        await readFile(join(normalizedDir, file), 'utf8'),
      ) as NormalizedCampaign;
      await writeFile(
        join(outDir, `${match[1]}.md`),
        renderCampaign(campaign, graph, catalog),
        'utf8',
      );
      campaigns.push(campaign);
      written++;
    } catch (error) {
      // One bad campaign must not cost the other 169.
      skipped++;
      console.log(`  warning: ${file} — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (written === 0) {
    fail('no campaigns rendered — a silent empty result is worse than an error');
    return;
  }

  // --funnel renders one page for iteration; an index built from it would list
  // one campaign and overwrite the account's.
  if (only === null) {
    await writeFile(join(outDir, 'index.md'), renderIndex(campaigns, graph), 'utf8');
  }

  console.log(`\n[${app}] rendered ${written} campaigns, skipped ${skipped}`);
  console.log(`  names: ${catalog === undefined ? 'ids only (no catalog)' : 'from catalog'}`);
  console.log(`  output: ${outDir}\n`);
}

await main();
