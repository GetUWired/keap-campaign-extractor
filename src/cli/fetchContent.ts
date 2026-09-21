import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createClient } from '../api/client.js';
import { closeSession, openSession } from '../auth/session.js';
import { createAssetLedger, loadAssetIndex, saveAssetIndex } from '../content/assets/assetStore.js';
import { anonymousFetcher, sessionFetcher } from '../content/assets/download.js';
import { type ContentRef, buildQueue, campaignRefs, loadCampaignNodes } from '../content/collect.js';
import {
  type AssetCounts,
  emptyAssetCounts,
  emptyContentProgress,
  loadContentProgress,
  pendingItems,
  reconcileContent,
  recordItem,
  saveContentProgress,
} from '../content/progress.js';
import { type RunDeps, fetchItem } from '../content/run.js';
import { SOURCES } from '../content/sources/index.js';
import { isItemStored, writeStoredItem } from '../content/store.js';
import { type ContentItem, type ContentKind, itemKey } from '../content/types.js';
import { isSessionExpired } from '../errors.js';
import { type FetchContentArgs, parseFetchContentArgs } from './fetchContentArgs.js';

function fail(message: string): void {
  console.error(`\n${message}\n`);
  process.exitCode = 1;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function countBy<T>(items: T[], keyOf: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[keyOf(item)] = (out[keyOf(item)] ?? 0) + 1;
  return out;
}

function served(item: ContentItem): boolean {
  return SOURCES[item.kind]?.attributes.includes(item.attribute) ?? false;
}

async function funnelIdsFor(args: FetchContentArgs): Promise<string[] | null> {
  if (args.funnelId !== null) return [args.funnelId];
  const queuePath = join('artifacts', args.app, 'campaigns.json');
  try {
    const queue = JSON.parse(await readFile(queuePath, 'utf8')) as {
      campaigns?: { funnelId: string }[];
    };
    return (queue.campaigns ?? []).map((c) => c.funnelId);
  } catch {
    fail(`No campaign list at ${queuePath}. Run:  npm run enumerate -- --app ${args.app}`);
    return null;
  }
}

async function main(): Promise<void> {
  let args: FetchContentArgs;
  try {
    args = parseFetchContentArgs(process.argv.slice(2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  const funnelIds = await funnelIdsFor(args);
  if (funnelIds === null) return;

  const refs: ContentRef[] = [];
  const notExtracted: string[] = [];
  for (const funnelId of funnelIds) {
    const nodes = await loadCampaignNodes(args.app, funnelId);
    if (nodes === null) notExtracted.push(funnelId);
    else refs.push(...campaignRefs(funnelId, nodes.draft, nodes.published));
  }
  if (notExtracted.length === funnelIds.length) {
    fail(`No extracted campaigns found. Run:  npm run extract-all -- --app ${args.app}`);
    return;
  }
  if (notExtracted.length > 0) {
    console.log(
      `  warning: ${notExtracted.length} campaign(s) not extracted and skipped — ` +
        `run extract-all first: ${notExtracted.slice(0, 10).join(', ')}` +
        `${notExtracted.length > 10 ? ' …' : ''}`,
    );
  }

  let items = buildQueue(refs);
  if (args.kinds !== null) {
    const wanted = new Set<ContentKind>(args.kinds);
    items = items.filter((item) => wanted.has(item.kind));
  }
  const byKey = new Map(items.map((item) => [itemKey(item), item]));

  const now = () => new Date().toISOString();
  let progress = (await loadContentProgress(args.app)) ?? emptyContentProgress(args.app, now());
  const reconciled = reconcileContent(
    progress,
    (key) => {
      const item = byKey.get(key);
      return item === undefined || isItemStored(args.app, item);
    },
    now(),
  );
  progress = reconciled.progress;
  if (reconciled.demoted.length > 0) {
    console.log(`  warning: ${reconciled.demoted.length} item(s) marked done are missing and will be re-fetched`);
  }

  let pending = pendingItems(progress, items, args.force);
  const unserved = pending.filter((item) => !served(item));
  pending = pending.filter(served);
  if (args.limit !== null) pending = pending.slice(0, args.limit);

  console.log(
    `\n[${args.app}] ${items.length} content items across ${funnelIds.length - notExtracted.length} ` +
      `campaigns — ${pending.length} to fetch${args.force ? ' (forced)' : ''}`,
  );
  console.log(`  by kind: ${JSON.stringify(countBy(items, (i) => i.kind))}`);
  if (unserved.length > 0) {
    // Loud, not silent: these are real content the export will show as notFetched.
    console.log(
      `  NOT FETCHED — no source reads these yet: ` +
        `${JSON.stringify(countBy(unserved, (i) => `${i.kind}/${i.attribute}`))}`,
    );
  }

  const needKey = [...new Set(pending.filter((i) => SOURCES[i.kind]?.needsApiKey).map((i) => i.kind))];
  const apiKey = process.env.KEAP_API_KEY;
  if (needKey.length > 0 && !apiKey) {
    fail(`KEAP_API_KEY is required to fetch: ${needKey.join(', ')}. Nothing was fetched.`);
    return;
  }

  if (pending.length === 0) {
    console.log('  nothing to do\n');
    return;
  }

  // Always opened: Keap-hosted assets are fetched with the session even when
  // every source uses REST.
  let session: Awaited<ReturnType<typeof openSession>>;
  try {
    session = await openSession({ app: args.app, headless: !args.headed });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  const ledger = createAssetLedger(args.app, await loadAssetIndex(args.app));
  const deps: RunDeps = {
    sources: SOURCES,
    ctx: {
      app: args.app,
      baseUrl: session.baseUrl,
      browser: session.context,
      api: apiKey ? createClient(apiKey) : null,
    },
    fetchers: { keap: sessionFetcher(session.context), anonymous: anonymousFetcher() },
    assets: ledger,
    saveItem: async (key, fetched, assetUrls) => {
      await writeStoredItem(args.app, key, fetched, assetUrls, now());
    },
  };

  const tally: Record<string, { done: number; failed: number; notFound: number }> = {};
  const assetTotals: AssetCounts = emptyAssetCounts();
  let aborted = false;
  const started = Date.now();

  try {
    for (const [index, item] of pending.entries()) {
      const label = `[${index + 1}/${pending.length}] ${item.kind} ${item.attribute}=${item.id}`;
      const bucket = (tally[item.kind] ??= { done: 0, failed: 0, notFound: 0 });
      try {
        const outcome = await fetchItem(item, deps);
        bucket[outcome.status]++;
        for (const [status, count] of Object.entries(outcome.assets ?? {})) {
          assetTotals[status as keyof AssetCounts] += count;
        }
        progress = recordItem(
          progress,
          itemKey(item),
          { status: outcome.status, at: now(), error: outcome.error, assets: outcome.assets },
          now(),
        );
        const detail =
          outcome.status === 'done'
            ? `ok — ${outcome.assets?.downloaded ?? 0} asset(s), ${outcome.assets?.failed ?? 0} failed`
            : `${outcome.status.toUpperCase()} — ${outcome.error ?? ''}`;
        console.log(`  ${label} ${detail}`);
      } catch (error) {
        if (isSessionExpired(error)) {
          aborted = true;
          console.error(`  ${label} ABORT — ${error.message}`);
          break;
        }
        throw error;
      }

      await saveContentProgress(args.app, progress);
      await saveAssetIndex(args.app, ledger.index());
      if (args.delayMs > 0) await sleep(args.delayMs);
    }
  } finally {
    await saveContentProgress(args.app, progress);
    await saveAssetIndex(args.app, ledger.index());
    await closeSession(session);
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n  ${elapsed}s elapsed`);
  for (const [kind, counts] of Object.entries(tally)) {
    console.log(`  ${kind}: ${counts.done} fetched, ${counts.failed} failed, ${counts.notFound} not found`);
  }
  console.log(
    `  assets: ${assetTotals.downloaded} downloaded, ${assetTotals.failed} failed, ` +
      `${assetTotals.tooLarge} too large, ${assetTotals.skipped} skipped`,
  );
  const nonGet = session.guard.blocked.filter((b) => b.reason === 'non-get');
  console.log(
    `  browser requests: ${session.guard.allowed.length} allowed, ` +
      `${session.guard.blocked.length} blocked (${nonGet.length} non-GET)`,
  );
  if (aborted) console.log(`  run aborted — re-run:  npm run login -- --app ${args.app}`);
  console.log('');

  const anyFailed = Object.values(tally).some((t) => t.failed > 0);
  if (aborted || anyFailed) process.exitCode = 1;
}

await main();
