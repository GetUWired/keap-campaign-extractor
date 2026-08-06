import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeAppName, normalizeFunnelId } from '../app.js';
import { closeSession, openSession } from '../auth/session.js';
import { extractOne } from '../extract/campaignRun.js';

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
    const result = await extractOne(session, page, args.app, args.funnelId);

    console.log(`\n[${args.app}] campaign ${args.funnelId} — "${result.funnelName ?? '(no name)'}"`);

    const baseline = BASELINES[args.funnelId];
    const cellCount = result.inventory.cellCount;
    if (baseline) {
      console.log(
        `  draftXml: ${result.draftXmlLength} chars / ${cellCount} mxCell ` +
          `(handoff baseline ${baseline.chars} / ${baseline.cells}; ` +
          `delta ${result.draftXmlLength - baseline.chars} chars, ${cellCount - baseline.cells} cells)`,
      );
    } else {
      console.log(`  draftXml: ${result.draftXmlLength} chars / ${cellCount} mxCell (no baseline)`);
    }

    console.log(
      `  published: ${result.publishXmlLength === 0 ? 'never' : `${result.publishXmlLength} chars`}`,
    );
    console.log(`  styles: ${JSON.stringify(result.inventory.styleCounts)}`);
    for (const warning of result.inventory.warnings) console.log(`  warning: ${warning}`);

    for (const decision of result.decisions) {
      if (decision.hit) {
        console.log(`  decision ${decision.cellId}: HIT — ${decision.branches} branch(es)`);
        for (const warning of decision.warnings) console.log(`    warning: ${warning}`);
      } else {
        failed = true;
        console.log(`  decision ${decision.cellId}: MISS on all ${decision.attempts} candidates`);
      }
    }

    await writeFile(
      join(result.outDir, 'requests.log.json'),
      JSON.stringify(session.guard, null, 2),
      'utf8',
    );

    const nonGet = session.guard.blocked.filter((b) => b.reason === 'non-get');
    console.log(
      `\n  requests: ${session.guard.allowed.length} allowed, ` +
        `${session.guard.blocked.length} blocked (${nonGet.length} non-GET)`,
    );
    console.log(`  artifacts: ${result.outDir}\n`);
  } catch (error) {
    failed = true;
    console.error(`\nspike failed: ${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    await closeSession(session);
  }

  if (failed) process.exitCode = 1;
}

await main();
