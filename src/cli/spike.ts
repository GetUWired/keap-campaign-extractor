import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { campaignDirFor, normalizeAppName, normalizeFunnelId, verifyIdentity } from '../app.js';
import { closeSession, openSession } from '../auth/session.js';
import { extractCampaign } from '../extract/campaign.js';
import { fetchDecision } from '../extract/decision.js';
import { parseCells, parseIdentity } from '../parse/cells.js';

/** Recorded in keap-campaign-extractor-handoff.md sections 2 and 8. Informational only. */
const BASELINES: Record<string, { chars: number; cells: number }> = {
  '584': { chars: 11_185, cells: 43 },
  '987': { chars: 7_252, cells: 32 },
};

interface Args {
  app: string;
  funnelId: string;
  headed: boolean;
}

function parseArgs(argv: string[]): Args {
  const usage = 'Usage: npm run spike -- --app <appName> --funnel <funnelId> [--headed]';
  const appIndex = argv.indexOf('--app');
  const funnelIndex = argv.indexOf('--funnel');
  const rawApp = appIndex >= 0 ? argv[appIndex + 1] : undefined;
  const rawFunnel = funnelIndex >= 0 ? argv[funnelIndex + 1] : undefined;
  if (!rawApp || !rawFunnel) throw new Error(usage);

  return {
    app: normalizeAppName(rawApp),
    funnelId: normalizeFunnelId(rawFunnel),
    headed: argv.includes('--headed'),
  };
}

/** Prints `message` without a stack trace and marks the run as failed. */
function fail(message: string): void {
  console.error(`\n${message}\n`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  // Bad arguments and a missing session are ordinary, user-fixable conditions.
  // They are handled before the extraction try block so they surface as
  // messages rather than stack traces.
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  let session: Awaited<ReturnType<typeof openSession>>;
  try {
    session = await openSession({ app: args.app, headless: !args.headed });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  if (process.env.KEAP_BASE_URL) {
    console.log(
      `\nKEAP_BASE_URL is set — using ${session.baseUrl} instead of the URL derived ` +
        `from app "${args.app}". Artifacts are still filed under "${args.app}".`,
    );
  }

  let failed = false;

  try {
    const page = await session.context.newPage();
    const campaign = await extractCampaign(page, session.baseUrl, args.funnelId);

    // Verify BEFORE creating any directory. A refused run must leave nothing
    // behind — an empty client folder is exactly the confusion this prevents.
    const identity = parseIdentity(campaign.draftXml);
    const check = verifyIdentity({ app: args.app, funnelId: args.funnelId }, identity);
    for (const warning of check.warnings) console.log(`  warning: ${warning}`);
    if (!check.ok) {
      for (const error of check.errors) console.error(`  ${error}`);
      fail('identity check failed — nothing was written');
      return;
    }

    const inventory = parseCells(campaign.draftXml);
    const outDir = campaignDirFor(args.app, args.funnelId);
    const decisionsDir = join(outDir, 'decisions');
    // Clear prior decision output first. A stale .attempt-N.html from a failed
    // run sitting beside a successful .html reads as though both happened.
    await rm(decisionsDir, { recursive: true, force: true });
    await mkdir(decisionsDir, { recursive: true });

    await writeFile(join(outDir, 'draft.xml'), campaign.draftXml, 'utf8');
    await writeFile(join(outDir, 'publish.xml'), campaign.publishXml, 'utf8');

    const { draftXml, publishXml, ...meta } = campaign;
    await writeFile(
      join(outDir, 'meta.json'),
      JSON.stringify(
        {
          appName: identity.appName ?? args.app,
          ...meta,
          publishXmlLength: publishXml.length,
          neverPublished: publishXml.length === 0,
          inventory,
        },
        null,
        2,
      ),
      'utf8',
    );

    console.log(
      `\n[${args.app}] campaign ${args.funnelId} — "${campaign.funnelName ?? '(no name)'}"`,
    );

    const baseline = BASELINES[args.funnelId];
    const cellCount = inventory.cellCount;
    if (baseline) {
      console.log(
        `  draftXml: ${draftXml.length} chars / ${cellCount} mxCell ` +
          `(handoff baseline ${baseline.chars} / ${baseline.cells}; ` +
          `delta ${draftXml.length - baseline.chars} chars, ${cellCount - baseline.cells} cells)`,
      );
    } else {
      console.log(`  draftXml: ${draftXml.length} chars / ${cellCount} mxCell (no baseline)`);
    }

    console.log(`  published: ${publishXml.length === 0 ? 'never' : `${publishXml.length} chars`}`);
    console.log(`  styles: ${JSON.stringify(inventory.styleCounts)}`);
    for (const warning of inventory.warnings) console.log(`  warning: ${warning}`);

    for (const cell of inventory.decisions) {
      const result = await fetchDecision(session.context, session.baseUrl, cell);

      if (result.html && result.criteria) {
        await writeFile(join(decisionsDir, `${cell.cellId}.html`), result.html, 'utf8');
        await writeFile(
          join(decisionsDir, `${cell.cellId}.json`),
          JSON.stringify(result.criteria, null, 2),
          'utf8',
        );
        const hitIndex = result.attempts.findIndex((a) => a.hit);
        console.log(
          `  decision ${cell.cellId}: HIT on candidate ${hitIndex + 1} — ` +
            `${result.criteria.wrappers.length} branch(es)`,
        );
        for (const warning of result.criteria.warnings) console.log(`    warning: ${warning}`);
      } else {
        failed = true;
        console.log(`  decision ${cell.cellId}: MISS on all ${result.attempts.length} candidates`);
        for (const [i, attempt] of result.attempts.entries()) {
          console.log(`    [${i + 1}] ${attempt.status} ${attempt.bytes}B ${attempt.url}`);
          await writeFile(
            join(decisionsDir, `${cell.cellId}.attempt-${i + 1}.html`),
            result.missBodies[i] ?? '',
            'utf8',
          );
        }
      }
    }

    await writeFile(
      join(outDir, 'requests.log.json'),
      JSON.stringify(session.guard, null, 2),
      'utf8',
    );

    const nonGet = session.guard.blocked.filter((b) => b.reason === 'non-get');
    console.log(
      `\n  requests: ${session.guard.allowed.length} allowed, ` +
        `${session.guard.blocked.length} blocked (${nonGet.length} non-GET)`,
    );
    console.log(`  artifacts: ${outDir}\n`);
  } catch (error) {
    failed = true;
    console.error(`\nspike failed: ${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    await closeSession(session);
  }

  if (failed) process.exitCode = 1;
}

await main();
