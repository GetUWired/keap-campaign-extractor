import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type DeletionList, parseDeletionList } from '../analyze/deletionList.js';
import { analyzeTagImpact } from '../analyze/tagImpact.js';
import { type TagList, allAccountTags, formatFor, parseTagList } from '../analyze/tagList.js';
import { normalizeAppName } from '../app.js';
import type { NormalizedCampaign } from '../normalize/campaign.js';
import type { AccountGraph } from '../normalize/graph.js';
import type { CampaignSummary } from '../parse/campaignList.js';
import { renderTagImpact } from '../render/tagImpactDoc.js';
import { renderTagImpactHtml } from '../render/tagImpactHtml.js';

function fail(message: string): void {
  console.error(`\n${message}\n`);
  process.exitCode = 1;
}

function argAfter(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const rawApp = argAfter(argv, '--app');
  const tagsPath = argAfter(argv, '--tags');
  const deletingPath = argAfter(argv, '--deleting');
  const allTags = argv.includes('--all-tags');
  if (rawApp === undefined || (tagsPath === undefined && !allTags)) {
    fail(
      'Usage: npm run tag-impact -- --app <appName> ' +
        '(--tags <list.csv|list.json> | --all-tags) ' +
        '[--deleting <campaigns.csv|campaigns.json>]',
    );
    return;
  }
  // Two different questions — which tags does this change touch, and where is
  // every tag used — and no sensible way to mean both at once.
  if (allTags && tagsPath !== undefined) {
    fail('--all-tags and --tags are alternatives; pass one or the other.');
    return;
  }

  let app: string;
  let format: 'csv' | 'json' = 'csv';
  try {
    app = normalizeAppName(rawApp);
    if (tagsPath !== undefined) format = formatFor(tagsPath);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  if (tagsPath !== undefined && !existsSync(tagsPath)) {
    fail(`No tag list at ${tagsPath}`);
    return;
  }

  const normalizedDir = join('artifacts', app, 'normalized');
  const graphPath = join('artifacts', app, 'graph.json');
  if (!existsSync(normalizedDir) || !existsSync(graphPath)) {
    fail(`No normalized data at ${normalizedDir}. Run:  npm run normalize -- --app ${app}`);
    return;
  }

  let list: TagList;
  if (allTags) {
    // The account's own inventory, from the REST API. Nothing else knows the
    // full set: campaigns only reveal the tags they happen to use.
    const catalogPath = join('artifacts', app, 'entities.json');
    if (!existsSync(catalogPath)) {
      fail(
        `--all-tags needs the account's tag inventory, which is not at ${catalogPath}.\n` +
          `Run:  KEAP_API_KEY=… npm run enrich -- --app ${app}`,
      );
      return;
    }
    const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as {
      entities: { id: string; kind: string; name: string }[];
    };
    list = allAccountTags(catalog.entities ?? []);
    if (list.tags.length === 0) {
      fail(`${catalogPath} holds no tags. Re-run:  KEAP_API_KEY=… npm run enrich -- --app ${app}`);
      return;
    }
  } else {
    try {
      list = parseTagList(await readFile(tagsPath as string, 'utf8'), format);
    } catch (error) {
      fail(
        `could not read the tag list — ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
  }

  // Campaigns the operator intends to delete. Optional: without it nothing is
  // marked, which is the same as today's behaviour.
  let deletions: DeletionList = { campaigns: [], warnings: [] };
  if (deletingPath !== undefined) {
    if (!existsSync(deletingPath)) {
      fail(`No campaign deletion list at ${deletingPath}`);
      return;
    }
    try {
      deletions = parseDeletionList(await readFile(deletingPath, 'utf8'), formatFor(deletingPath));
    } catch (error) {
      fail(
        `could not read the campaign deletion list — ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
  }

  // An empty report would read as "nothing is affected", which is a different
  // claim from "the list was empty".
  if (list.tags.length === 0) {
    fail('the tag list contains no usable rows');
    return;
  }

  const graph = JSON.parse(await readFile(graphPath, 'utf8')) as AccountGraph;
  const campaigns: NormalizedCampaign[] = [];
  for (const file of (await readdir(normalizedDir)).sort()) {
    if (!/^\d+\.json$/.test(file)) continue;
    const raw = await readFile(join(normalizedDir, file), 'utf8');
    campaigns.push(JSON.parse(raw) as NormalizedCampaign);
  }

  // The campaign list is what separates "live" from "published, then stopped".
  // Without it every status reads `unknown`, which the report says out loud
  // rather than defaulting to something reassuring.
  const listPath = join('artifacts', app, 'campaigns.json');
  let summaries: CampaignSummary[] = [];
  if (existsSync(listPath)) {
    const parsed = JSON.parse(await readFile(listPath, 'utf8')) as { campaigns: CampaignSummary[] };
    summaries = parsed.campaigns ?? [];
  } else {
    console.warn(`\n  no campaign list at ${listPath} — every status will read "unknown"`);
  }

  if (allTags) {
    // A tag a campaign uses that the account no longer has is a dangling
    // reference. Silently dropping it would make the audit look complete.
    const known = new Set(list.tags.map((t) => t.id));
    const referenced = new Set(
      graph.edges
        .filter((e) => e.to.startsWith('tag:') && e.derived !== true)
        .map((e) => e.to.slice('tag:'.length)),
    );
    const dangling = [...referenced].filter((id) => id !== '0' && !known.has(id));
    if (dangling.length > 0) {
      list.warnings.push(
        `${dangling.length} tags are referenced by campaigns but are not in the account's tag ` +
          `inventory — most likely deleted while the campaign steps that use them remain`,
      );
    }
  }

  const report = analyzeTagImpact(
    app,
    list,
    campaigns,
    graph,
    summaries,
    deletions.campaigns.map((c) => c.campaignId),
  );
  report.warnings.unshift(...deletions.warnings);
  const jsonPath = join('artifacts', app, 'tag-impact.json');
  const mdPath = join('artifacts', app, 'tag-impact.md');
  const htmlPath = join('artifacts', app, 'tag-impact.html');
  await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  await writeFile(mdPath, renderTagImpact(report), 'utf8');
  await writeFile(htmlPath, renderTagImpactHtml(report), 'utf8');

  const locations = report.campaigns.reduce((n, c) => n + c.locations.length, 0);
  const kinds = { trigger: 0, decision: 0, step: 0 };
  for (const campaign of report.campaigns) {
    for (const location of campaign.locations) kinds[location.kind]++;
  }
  const referenced = report.tags.filter((t) => t.locations.length > 0).length;

  console.log(
    `\n[${app}] ${list.tags.length} tags ${allTags ? 'in the account (audit)' : 'requested'}`,
  );
  console.log(`  referenced by a campaign: ${referenced}`);
  console.log(`  no campaign references:   ${report.noCampaignReferences.length}`);
  console.log(
    `  campaigns ${allTags ? 'using a tag: ' : 'affected:     '} ${report.campaigns.length} of ${campaigns.length}`,
  );
  const statuses = new Map<string, number>();
  for (const campaign of report.campaigns) {
    statuses.set(campaign.status, (statuses.get(campaign.status) ?? 0) + 1);
  }
  const statusLine = [...statuses.entries()].map(([s, n]) => `${n} ${s}`).join(', ');
  console.log(`    by status: ${statusLine}`);
  if (deletingPath !== undefined) {
    console.log(
      `    ${deletions.campaigns.length} campaigns on the deletion list; ` +
        `${report.plannedDeletions} of them are affected`,
    );
    console.log(
      `    still affected once those are deleted: ${report.campaigns.length - report.plannedDeletions}`,
    );
  }
  console.log(
    `  locations: ${locations} — ${kinds.trigger} trigger, ${kinds.decision} decision, ${kinds.step} step`,
  );
  for (const warning of report.warnings.slice(0, 5)) console.log(`  warning: ${warning}`);
  if (report.warnings.length > 5) {
    console.log(`  … and ${report.warnings.length - 5} more warnings`);
  }
  console.log(`  output: ${jsonPath}\n          ${mdPath}\n          ${htmlPath}\n`);
}

await main();
