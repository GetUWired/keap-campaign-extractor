import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeAppName } from '../app.js';
import { closeSession, openSession } from '../auth/session.js';
import { isSessionExpired } from '../errors.js';
import { extractOne, isCampaignComplete } from '../extract/campaignRun.js';
import {
  emptyProgress,
  loadProgress,
  pendingFunnelIds,
  recordOutcome,
  reconcile,
  saveProgress,
} from '../progress.js';

interface Args {
  app: string;
  force: boolean;
  limit: number | null;
  delayMs: number;
  headed: boolean;
}

const USAGE =
  'Usage: npm run extract-all -- --app <appName> [--force] [--limit <n>] [--delay <ms>] [--headed]';

function numericFlag(argv: string[], flag: string, fallback: number | null): number | null {
  const index = argv.indexOf(flag);
  if (index < 0) return fallback;
  const raw = argv[index + 1];
  const value = Number.parseInt(raw ?? '', 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid ${flag} ${JSON.stringify(raw)}. Expected a non-negative integer.`);
  }
  return value;
}

function parseArgs(argv: string[]): Args {
  const appIndex = argv.indexOf('--app');
  const rawApp = appIndex >= 0 ? argv[appIndex + 1] : undefined;
  if (!rawApp) throw new Error(USAGE);

  const limit = numericFlag(argv, '--limit', null);
  if (limit !== null && limit < 1) {
    throw new Error('Invalid --limit "0". Expected a positive integer.');
  }

  return {
    app: normalizeAppName(rawApp),
    force: argv.includes('--force'),
    limit,
    delayMs: numericFlag(argv, '--delay', 250) ?? 250,
    headed: argv.includes('--headed'),
  };
}

function fail(message: string): void {
  console.error(`\n${message}\n`);
  process.exitCode = 1;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface CampaignQueueFile {
  enumeratedAt?: string;
  campaigns?: { funnelId: string; name: string }[];
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  const queuePath = join('artifacts', args.app, 'campaigns.json');
  let queue: CampaignQueueFile;
  try {
    queue = JSON.parse(await readFile(queuePath, 'utf8')) as CampaignQueueFile;
  } catch {
    fail(`No campaign list at ${queuePath}. Run:  npm run enumerate -- --app ${args.app}`);
    return;
  }

  const allCampaigns = queue.campaigns ?? [];
  const names = new Map(allCampaigns.map((c) => [c.funnelId, c.name]));
  const allIds = allCampaigns.map((c) => c.funnelId);
  if (allIds.length === 0) {
    fail(`${queuePath} lists no campaigns. Re-run:  npm run enumerate -- --app ${args.app}`);
    return;
  }

  const now = () => new Date().toISOString();
  let progress =
    (await loadProgress(args.app)) ??
    emptyProgress(args.app, allIds.length, queue.enumeratedAt ?? null, now());

  // Disk gets the final say over the progress file — see src/progress.ts.
  const reconciled = reconcile(progress, (id) => isCampaignComplete(args.app, id), now());
  progress = reconciled.progress;
  if (reconciled.demoted.length > 0) {
    console.log(
      `  warning: ${reconciled.demoted.length} campaign(s) marked done have no artifacts on disk ` +
        `and will be re-extracted: ${reconciled.demoted.join(', ')}`,
    );
  }

  if (
    progress.enumeratedAt !== null &&
    queue.enumeratedAt !== undefined &&
    progress.enumeratedAt !== queue.enumeratedAt
  ) {
    console.log(
      '  warning: the campaign list was re-enumerated since this progress record started ' +
        `(${progress.enumeratedAt} vs ${queue.enumeratedAt}). Resuming against the newer list.`,
    );
  }

  let pending = pendingFunnelIds(progress, allIds, args.force);
  if (args.limit !== null) pending = pending.slice(0, args.limit);

  console.log(
    `\n[${args.app}] ${allIds.length} campaigns total, ${pending.length} to extract` +
      `${args.force ? ' (forced)' : ''}${args.limit !== null ? ` (limited to ${args.limit})` : ''}`,
  );

  if (pending.length === 0) {
    console.log('  nothing to do\n');
    return;
  }

  let session: Awaited<ReturnType<typeof openSession>>;
  try {
    session = await openSession({ app: args.app, headless: !args.headed });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  const started = Date.now();
  let completed = 0;
  let failedCount = 0;
  let aborted = false;

  try {
    const page = await session.context.newPage();

    for (const [index, funnelId] of pending.entries()) {
      const label = `[${index + 1}/${pending.length}] ${funnelId}`;
      try {
        const result = await extractOne(session, page, args.app, funnelId);
        const misses = result.decisions.filter((d) => !d.hit).length;
        progress = recordOutcome(
          progress,
          funnelId,
          {
            status: 'done',
            at: now(),
            cells: result.inventory.cellCount,
            decisions: result.decisions.length,
          },
          now(),
        );
        completed++;
        console.log(
          `  ${label} ok — ${result.inventory.cellCount} cells, ` +
            `${result.decisions.length} decision(s)${misses > 0 ? `, ${misses} MISS` : ''}` +
            ` — ${names.get(funnelId) ?? ''}`,
        );
      } catch (error) {
        // The session dying is not this campaign's fault. Leave it pending so a
        // resume retries it, and stop — everything after would fail identically.
        if (isSessionExpired(error)) {
          aborted = true;
          console.error(`  ${label} ABORT — ${error.message}`);
          break;
        }
        failedCount++;
        const message = error instanceof Error ? error.message : String(error);
        progress = recordOutcome(
          progress,
          funnelId,
          { status: 'failed', at: now(), error: message },
          now(),
        );
        console.error(`  ${label} FAILED — ${message}`);
      }

      await saveProgress(args.app, progress);
      if (args.delayMs > 0) await sleep(args.delayMs);
    }

    await writeFile(
      join('artifacts', args.app, 'requests.log.json'),
      JSON.stringify(session.guard, null, 2),
      'utf8',
    );
  } finally {
    await saveProgress(args.app, progress);
    await closeSession(session);
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const done = Object.values(progress.entries).filter((e) => e.status === 'done').length;
  const nonGet = session.guard.blocked.filter((b) => b.reason === 'non-get');

  console.log(`\n  extracted ${completed}, failed ${failedCount}, ${elapsed}s elapsed`);
  console.log(`  ${done}/${allIds.length} campaigns complete overall`);
  console.log(
    `  requests: ${session.guard.allowed.length} allowed, ${session.guard.blocked.length} blocked ` +
      `(${nonGet.length} non-GET)`,
  );
  if (aborted) {
    console.log(`  run aborted — re-run:  npm run login -- --app ${args.app}`);
  }
  console.log('');

  if (aborted || failedCount > 0) process.exitCode = 1;
}

await main();
