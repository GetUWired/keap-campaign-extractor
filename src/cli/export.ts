import { existsSync, readFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { EntityCatalog } from '../api/catalog.js';
import { normalizeAppName, normalizeFunnelId } from '../app.js';
import { assetFilePathFor, loadAssetIndex } from '../content/assets/assetStore.js';
import { campaignRefs, loadCampaignNodes } from '../content/collect.js';
import type { ItemStatus } from '../content/progress.js';
import { loadContentProgress } from '../content/progress.js';
import { type StoredItem, readStoredItem } from '../content/store.js';
import { itemKey } from '../content/types.js';
import { draftNodesOf } from '../export/campaignDoc.js';
import { type ExportCampaignInput, planExport } from '../export/plan.js';
import { writeExport } from '../export/write.js';
import type { NormalizedCampaign } from '../normalize/campaign.js';
import { tagLabels } from '../normalize/graphEdges.js';
import type { CampaignSummary } from '../parse/campaignList.js';

interface Args {
  app: string;
  funnelId: string | null;
  includeSecrets: boolean;
}

function parseArgs(argv: string[]): Args {
  const usage = 'Usage: npm run export -- --app <appName> [--funnel <funnelId>] [--include-secrets]';
  const appIndex = argv.indexOf('--app');
  const rawApp = appIndex >= 0 ? argv[appIndex + 1] : undefined;
  if (!rawApp) throw new Error(usage);
  const funnelIndex = argv.indexOf('--funnel');
  const rawFunnel = funnelIndex >= 0 ? argv[funnelIndex + 1] : undefined;
  return {
    app: normalizeAppName(rawApp),
    funnelId: rawFunnel === undefined ? null : normalizeFunnelId(rawFunnel),
    includeSecrets: argv.includes('--include-secrets'),
  };
}

function fail(message: string): void {
  console.error(`\n${message}\n`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  const normalizedDir = join('artifacts', args.app, 'normalized');
  if (!existsSync(normalizedDir)) {
    fail(`No normalised campaigns at ${normalizedDir}. Run:  npm run normalize -- --app ${args.app}`);
    return;
  }

  const summaries = new Map<string, CampaignSummary>();
  try {
    const list = JSON.parse(
      await readFile(join('artifacts', args.app, 'campaigns.json'), 'utf8'),
    ) as { campaigns?: CampaignSummary[] };
    for (const summary of list.campaigns ?? []) summaries.set(summary.funnelId, summary);
  } catch {
    console.log('  warning: no campaigns.json — live status and categories will be empty');
  }

  const funnelIds =
    args.funnelId !== null
      ? [args.funnelId]
      : (await readdir(normalizedDir))
          .map((f) => /^(\d+)\.json$/.exec(f)?.[1])
          .filter((id): id is string => id !== undefined)
          .sort((a, b) => Number(a) - Number(b));

  const campaigns: ExportCampaignInput[] = [];
  const items = new Map<string, StoredItem>();
  for (const funnelId of funnelIds) {
    const path = join(normalizedDir, `${funnelId}.json`);
    if (!existsSync(path)) {
      console.log(`  warning: ${funnelId} is not normalised — skipped`);
      continue;
    }
    const normalized = JSON.parse(await readFile(path, 'utf8')) as NormalizedCampaign;
    const publishNodes = (await loadCampaignNodes(args.app, funnelId))?.published ?? [];
    campaigns.push({ funnelId, summary: summaries.get(funnelId) ?? null, normalized, publishNodes });

    for (const { key } of campaignRefs(funnelId, draftNodesOf(normalized), publishNodes)) {
      const k = itemKey(key);
      if (items.has(k)) continue;
      const stored = await readStoredItem(args.app, key);
      if (stored) items.set(k, stored);
    }
  }

  if (campaigns.length === 0) {
    fail('No campaigns to export.');
    return;
  }

  const progress = await loadContentProgress(args.app);
  const statuses = new Map<string, ItemStatus>(
    Object.entries(progress?.entries ?? {}).map(([key, entry]) => [key, entry.status]),
  );
  const assetIndex = await loadAssetIndex(args.app);

  // Tag names come from the enrichment catalog first — it is the only source
  // that resolves every tag, not just the ones a decision happens to route on.
  // Decision-criteria labels (tagLabels) fill in tags the catalog lacks: se232
  // has no catalog at all but 464 decisions carrying _text labels.
  const tagNames = new Map<string, string>();
  const catalogPath = join('artifacts', args.app, 'entities.json');
  if (existsSync(catalogPath)) {
    try {
      const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as EntityCatalog;
      for (const entity of catalog.entities) {
        if (entity.kind === 'tag' && entity.name !== null) {
          tagNames.set(entity.id.slice('tag:'.length), entity.name);
        }
      }
    } catch {
      console.log(`  warning: ${catalogPath} is unreadable — tag names come from decision labels only`);
    }
  } else {
    console.log(
      '  note: no entities.json — tag names come from decision labels only. Run:  ' +
        `npm run enrich -- --app ${args.app}`,
    );
  }
  for (const [id, label] of tagLabels(campaigns.map((c) => c.normalized))) {
    if (!tagNames.has(id)) tagNames.set(id, label);
  }

  const plan = planExport({
    app: args.app,
    exportedAt: new Date().toISOString(),
    includeSecrets: args.includeSecrets,
    campaigns,
    items,
    statuses,
    assets: assetIndex.assets,
    assetSource: (file) => assetFilePathFor(args.app, file),
    readText: (path) => readFileSync(path, 'utf8'),
    tagNames,
  });

  // --funnel exports into its own folder, so it never replaces a full export.
  const outDir =
    args.funnelId !== null ? join('export', args.app, `_funnel-${args.funnelId}`) : join('export', args.app);
  await writeExport(plan, outDir);

  const m = plan.manifest;
  console.log(`\n[${args.app}] exported ${m.campaignCount} campaigns to ${outDir}`);
  for (const [kind, c] of Object.entries(m.content)) {
    if (c.exported + c.failed + c.notFound + c.notFetched === 0) continue;
    console.log(
      `  ${kind}: ${c.exported} exported, ${c.failed} failed, ${c.notFound} not found, ${c.notFetched} not fetched`,
    );
  }
  console.log(
    `  assets: ${m.assets.downloaded} downloaded, ${m.assets.failed} failed, ` +
      `${m.assets.tooLarge} too large, ${m.assets.skipped} skipped`,
  );
  const tagsFile = plan.files.find((f) => f.path === 'tags.json');
  const namedTags =
    tagsFile && 'data' in tagsFile
      ? (JSON.parse(tagsFile.data.toString()) as { name: string | null }[]).filter((t) => t.name !== null)
          .length
      : 0;
  console.log(`  tags: ${m.tagCount} (${namedTags} named)`);
  if (m.secretsIncluded) {
    console.log('\n  WARNING: --include-secrets was set. HTTP steps contain live credentials.');
    console.log('  Treat this export as a secret. manifest.json records secretsIncluded: true.');
  }
  console.log('');
}

await main();
