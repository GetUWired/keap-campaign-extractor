import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { analyzeTagImpact } from '../analyze/tagImpact.js';
import { type TagList, formatFor, parseTagList } from '../analyze/tagList.js';
import { normalizeAppName } from '../app.js';
import type { NormalizedCampaign } from '../normalize/campaign.js';
import type { AccountGraph } from '../normalize/graph.js';
import type { CampaignSummary } from '../parse/campaignList.js';
import { renderTagImpact } from '../render/tagImpactDoc.js';

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
  if (rawApp === undefined || tagsPath === undefined) {
    fail('Usage: npm run tag-impact -- --app <appName> --tags <list.csv|list.json>');
    return;
  }

  let app: string;
  let format: 'csv' | 'json';
  try {
    app = normalizeAppName(rawApp);
    format = formatFor(tagsPath);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  if (!existsSync(tagsPath)) {
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
  try {
    list = parseTagList(await readFile(tagsPath, 'utf8'), format);
  } catch (error) {
    fail(`could not read the tag list — ${error instanceof Error ? error.message : String(error)}`);
    return;
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

  const report = analyzeTagImpact(app, list, campaigns, graph, summaries);
  const jsonPath = join('artifacts', app, 'tag-impact.json');
  const mdPath = join('artifacts', app, 'tag-impact.md');
  await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  await writeFile(mdPath, renderTagImpact(report), 'utf8');

  const locations = report.campaigns.reduce((n, c) => n + c.locations.length, 0);
  const kinds = { trigger: 0, decision: 0, step: 0 };
  for (const campaign of report.campaigns) {
    for (const location of campaign.locations) kinds[location.kind]++;
  }
  const referenced = report.tags.filter((t) => t.locations.length > 0).length;

  console.log(`\n[${app}] ${list.tags.length} tags requested`);
  console.log(`  referenced by a campaign: ${referenced}`);
  console.log(`  no campaign references:   ${report.noCampaignReferences.length}`);
  console.log(`  campaigns affected:       ${report.campaigns.length} of ${campaigns.length}`);
  const statuses = new Map<string, number>();
  for (const campaign of report.campaigns) {
    statuses.set(campaign.status, (statuses.get(campaign.status) ?? 0) + 1);
  }
  const statusLine = [...statuses.entries()].map(([s, n]) => `${n} ${s}`).join(', ');
  console.log(`    by status: ${statusLine}`);
  console.log(
    `  locations: ${locations} — ${kinds.trigger} trigger, ${kinds.decision} decision, ${kinds.step} step`,
  );
  for (const warning of report.warnings.slice(0, 5)) console.log(`  warning: ${warning}`);
  if (report.warnings.length > 5) {
    console.log(`  … and ${report.warnings.length - 5} more warnings`);
  }
  console.log(`  output: ${jsonPath}\n          ${mdPath}\n`);
}

await main();
