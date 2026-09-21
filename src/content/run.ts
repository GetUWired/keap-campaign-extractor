import { isSessionExpired } from '../errors.js';
import type { AssetLedger } from './assets/assetStore.js';
import {
  type SkippedUrl,
  classifyUrl,
  discoverCssUrls,
  discoverHtmlAssets,
} from './assets/discover.js';
import { type AssetFetchers, type AssetRecord, downloadAsset } from './assets/download.js';
import { type AssetCounts, type ItemStatus, emptyAssetCounts } from './progress.js';
import {
  type ContentItemKey,
  type ContentKind,
  ContentNotFoundError,
  type ContentSource,
  type FetchContext,
  type FetchedContent,
} from './types.js';

export class ContentInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentInvalidError';
  }
}

export interface ItemOutcome {
  status: ItemStatus;
  error?: string;
  assets?: AssetCounts;
}

export interface RunDeps {
  sources: Partial<Record<ContentKind, ContentSource>>;
  ctx: FetchContext;
  fetchers: AssetFetchers;
  assets: AssetLedger;
  saveItem(key: ContentItemKey, fetched: FetchedContent, assetUrls: string[]): Promise<void>;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Two attempts. A response that fails validation is not stored — the decision
 * editor returned HTTP 200 with an empty shell, so status proves nothing.
 */
export async function fetchValidated(
  source: ContentSource,
  key: ContentItemKey,
  ctx: FetchContext,
): Promise<FetchedContent> {
  let reason = 'no attempt made';
  for (let attempt = 0; attempt < 2; attempt++) {
    let fetched: FetchedContent;
    try {
      fetched = await source.fetch(key, ctx);
    } catch (error) {
      if (isSessionExpired(error) || error instanceof ContentNotFoundError) throw error;
      reason = messageOf(error);
      continue;
    }
    const invalid =
      fetched.record.kind !== key.kind
        ? `source returned a ${fetched.record.kind} record for a ${key.kind}`
        : source.validate(fetched);
    if (invalid === null) return fetched;
    reason = invalid;
  }
  throw new ContentInvalidError(reason);
}

/** Every asset an item uses: HTML scanning, the source's extras, and attachments. */
export function itemAssetUrls(fetched: FetchedContent): { download: string[]; skipped: SkippedUrl[] } {
  const download = new Set<string>();
  const skipped: SkippedUrl[] = [];

  for (const file of fetched.files) {
    if (!file.name.endsWith('.html')) continue;
    const found = discoverHtmlAssets(file.body.toString(), null);
    for (const url of found.download) download.add(url);
    skipped.push(...found.skipped);
  }

  const attachments = fetched.record.kind === 'email' ? fetched.record.attachments.map((a) => a.url) : [];
  for (const raw of [...fetched.assetUrls, ...attachments]) {
    const result = classifyUrl(raw, null);
    if ('reason' in result) skipped.push(result);
    else download.add(result.url);
  }
  return { download: [...download], skipped };
}

const isCss = (record: AssetRecord): boolean =>
  (record.contentType ?? '').toLowerCase().includes('text/css') || (record.file ?? '').endsWith('.css');

/**
 * Downloads what the ledger does not already hold. Stylesheets are followed
 * one level, for the fonts and images they pull in; a stylesheet's own imports
 * are not followed further.
 */
export async function collectAssets(
  fetched: FetchedContent,
  deps: RunDeps,
): Promise<{ urls: string[]; counts: AssetCounts }> {
  const { download, skipped } = itemAssetUrls(fetched);
  const counts = emptyAssetCounts();
  const urls: string[] = [];

  const recordSkips = async (list: SkippedUrl[]): Promise<void> => {
    for (const skip of list) {
      if (deps.assets.get(skip.url) === undefined) {
        await deps.assets.put({ url: skip.url, status: 'skipped', reason: skip.reason }, null);
      }
      urls.push(skip.url);
      counts.skipped++;
    }
  };
  await recordSkips(skipped);

  const queue = download.map((url) => ({ url, depth: 0 }));
  const seen = new Set<string>();
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (seen.has(next.url)) continue;
    seen.add(next.url);
    urls.push(next.url);

    let record = deps.assets.get(next.url);
    let bytes: Buffer | null = null;
    if (record === undefined || record.status === 'failed') {
      const result = await downloadAsset(next.url, deps.fetchers);
      record = result.record;
      bytes = result.bytes;
      await deps.assets.put(record, bytes);
    }
    counts[record.status]++;

    if (next.depth === 0 && record.status === 'downloaded' && isCss(record)) {
      const css = (bytes ?? (await deps.assets.read(record)))?.toString('utf8') ?? '';
      const nested = discoverCssUrls(css, next.url);
      for (const url of nested.download) queue.push({ url, depth: 1 });
      await recordSkips(nested.skipped);
    }
  }
  return { urls, counts };
}

export async function fetchItem(key: ContentItemKey, deps: RunDeps): Promise<ItemOutcome> {
  const source = deps.sources[key.kind];
  if (!source || !source.attributes.includes(key.attribute)) {
    return { status: 'failed', error: `no source reads ${key.kind} ${key.attribute} yet` };
  }

  let fetched: FetchedContent;
  try {
    fetched = await fetchValidated(source, key, deps.ctx);
  } catch (error) {
    if (isSessionExpired(error)) throw error;
    if (error instanceof ContentNotFoundError) return { status: 'notFound', error: error.message };
    return { status: 'failed', error: messageOf(error) };
  }

  const { urls, counts } = await collectAssets(fetched, deps);
  await deps.saveItem(key, fetched, urls);
  return { status: 'done', assets: counts };
}
