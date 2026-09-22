import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { analyzeBrokenReferences } from '../analyze/brokenRefs.js';
import { normalizeAppName } from '../app.js';
import type { NormalizedCampaign } from '../normalize/campaign.js';
import type { AccountGraph } from '../normalize/graph.js';
import type { CampaignSummary } from '../parse/campaignList.js';
import { renderBrokenRefs } from '../render/brokenRefsDoc.js';
import { renderBrokenRefsHtml } from '../render/brokenRefsHtml.js';

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
  if (rawApp === undefined) {
    fail('Usage: npm run broken-refs -- --app <appName>');
    return;
  }

  let app: string;
  try {
    app = normalizeAppName(rawApp);
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
  const campaigns: NormalizedCampaign[] = [];
  for (const file of (await readdir(normalizedDir)).sort()) {
    if (!/^\d+\.json$/.test(file)) continue;
    campaigns.push(JSON.parse(await readFile(join(normalizedDir, file), 'utf8')) as NormalizedCampaign);
  }

  const listPath = join('artifacts', app, 'campaigns.json');
  let summaries: CampaignSummary[] = [];
  if (existsSync(listPath)) {
    const parsed = JSON.parse(await readFile(listPath, 'utf8')) as { campaigns: CampaignSummary[] };
    summaries = parsed.campaigns ?? [];
  }

  const report = analyzeBrokenReferences(app, campaigns, graph, summaries);
  const jsonPath = join('artifacts', app, 'broken-refs.json');
  const mdPath = join('artifacts', app, 'broken-refs.md');
  const htmlPath = join('artifacts', app, 'broken-refs.html');
  await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  await writeFile(mdPath, renderBrokenRefs(report), 'utf8');
  await writeFile(htmlPath, renderBrokenRefsHtml(report), 'utf8');

  const { counts } = report;
  console.log(`\n[${app}] references to entities the account no longer has`);
  if (!report.catalogPresent) {
    // An empty result here would otherwise read as a clean bill of health.
    console.log('  no catalog comparison in the graph — nothing could be checked.');
    console.log(`  Run:  KEAP_API_KEY=… npm run enrich -- --app ${app}`);
    console.log(`  then: npm run normalize -- --app ${app}\n`);
    return;
  }
  console.log(`  missing entities:  ${counts.references}`);
  console.log(
    `    ${counts.readyReferences} referenced by a ready step, ${counts.neverBuiltReferences} only by unfinished ones`,
  );
  const kinds = Object.entries(counts.byKind)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => `${n} ${kind}`)
    .join(', ');
  console.log(`    by kind: ${kinds}`);
  console.log(`  broken locations:  ${counts.locations}`);
  const places = Object.entries(counts.byLocationKind)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => `${n} ${kind}`)
    .join(', ');
  console.log(`    ${places}`);
  console.log(`  campaigns:         ${counts.campaigns}, of which ${counts.liveCampaigns} live`);
  const dead = report.campaigns.filter((c) => c.allTriggersBroken);
  console.log(
    `  no working way in: ${dead.length} campaigns, ${dead.filter((c) => c.status === 'live').length} of them live`,
  );
  for (const warning of report.warnings) console.log(`  warning: ${warning}`);
  console.log(`  output: ${jsonPath}\n          ${mdPath}\n          ${htmlPath}\n`);
}

await main();
