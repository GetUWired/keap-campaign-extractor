import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeAppName, normalizeFunnelId } from '../app.js';
import { normalizeCampaign } from '../normalize/campaign.js';
import type { DecisionCriteria } from '../parse/decisionHtml.js';

interface Args {
  app: string;
  funnelId: string | null;
}

function parseArgs(argv: string[]): Args {
  const usage = 'Usage: npm run normalize -- --app <appName> [--funnel <funnelId>]';
  const appIndex = argv.indexOf('--app');
  const rawApp = appIndex >= 0 ? argv[appIndex + 1] : undefined;
  if (!rawApp) throw new Error(usage);

  const funnelIndex = argv.indexOf('--funnel');
  const rawFunnel = funnelIndex >= 0 ? argv[funnelIndex + 1] : undefined;

  return {
    app: normalizeAppName(rawApp),
    funnelId: rawFunnel === undefined ? null : normalizeFunnelId(rawFunnel),
  };
}

function fail(message: string): void {
  console.error(`\n${message}\n`);
  process.exitCode = 1;
}

/** Loads every decisions/<cellId>.json for one campaign, keyed by cell id. */
async function loadCriteria(dir: string): Promise<Record<string, DecisionCriteria>> {
  const decisionsDir = join(dir, 'decisions');
  if (!existsSync(decisionsDir)) return {};

  const out: Record<string, DecisionCriteria> = {};
  for (const file of await readdir(decisionsDir)) {
    const match = /^(\d+)\.json$/.exec(file);
    if (!match?.[1]) continue;
    try {
      out[match[1]] = JSON.parse(
        await readFile(join(decisionsDir, file), 'utf8'),
      ) as DecisionCriteria;
    } catch {
      // A malformed criteria file leaves that branch's rules null rather than
      // failing the campaign; the routing is still known from the XML.
    }
  }
  return out;
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  const campaignsDir = join('artifacts', args.app, 'campaigns');
  if (!existsSync(campaignsDir)) {
    fail(`No campaigns at ${campaignsDir}. Run:  npm run extract-all -- --app ${args.app}`);
    return;
  }

  const outDir = join('artifacts', args.app, 'normalized');
  await mkdir(outDir, { recursive: true });

  const ids = args.funnelId !== null ? [args.funnelId] : (await readdir(campaignsDir)).sort();
  const allWarnings: string[] = [];
  const unverifiedSequences: string[] = [];
  let written = 0;
  let skipped = 0;

  for (const funnelId of ids) {
    const dir = join(campaignsDir, funnelId);
    const draftPath = join(dir, 'draft.xml');
    if (!existsSync(draftPath)) {
      skipped++;
      allWarnings.push(`${funnelId}: no draft.xml`);
      continue;
    }

    try {
      const draftXml = await readFile(draftPath, 'utf8');
      const publishPath = join(dir, 'publish.xml');
      const publishXml = existsSync(publishPath) ? await readFile(publishPath, 'utf8') : '';

      // The display name is not in draftXml — it comes from the #editor data
      // attribute, which the extractor stored in meta.json.
      let funnelName: string | null = null;
      const metaPath = join(dir, 'meta.json');
      if (existsSync(metaPath)) {
        try {
          const meta = JSON.parse(await readFile(metaPath, 'utf8')) as {
            funnelName?: string | null;
          };
          funnelName = meta.funnelName ?? null;
        } catch {
          allWarnings.push(`${funnelId}: meta.json unreadable; name left null`);
        }
      }

      const campaign = normalizeCampaign(
        draftXml,
        publishXml,
        await loadCriteria(dir),
        funnelName,
        funnelId,
      );
      await writeFile(join(outDir, `${funnelId}.json`), JSON.stringify(campaign, null, 2), 'utf8');
      written++;

      for (const warning of campaign.warnings) allWarnings.push(`${funnelId}: ${warning}`);
      for (const sequence of campaign.sequences) {
        if (!sequence.orderVerified) unverifiedSequences.push(`${funnelId}/${sequence.cellId}`);
      }
    } catch (error) {
      // One unparseable campaign must not stop the other 169.
      skipped++;
      allWarnings.push(`${funnelId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (written === 0) {
    fail('no campaigns normalised — a silent empty result is worse than an error');
    return;
  }

  const unknownStyles = new Set(
    allWarnings
      .map((w) => /undocumented node style "([^"]+)"/.exec(w)?.[1])
      .filter((s): s is string => s !== undefined),
  );

  console.log(`\n[${args.app}] normalised ${written} campaigns, skipped ${skipped}`);
  console.log(
    `  undocumented styles encountered: ${unknownStyles.size}` +
      `${unknownStyles.size > 0 ? ` — ${[...unknownStyles].join(', ')}` : ''}`,
  );
  console.log(`  sequences whose order could not be walked: ${unverifiedSequences.length}`);
  if (unverifiedSequences.length > 0) {
    console.log(
      `    ${unverifiedSequences.slice(0, 10).join(', ')}` +
        `${unverifiedSequences.length > 10 ? ` … and ${unverifiedSequences.length - 10} more` : ''}`,
    );
  }
  console.log(`  output: ${outDir}\n`);
}

await main();
