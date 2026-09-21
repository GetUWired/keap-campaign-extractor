import { join } from 'node:path';
import type { AssetRecord, AssetStatus } from '../content/assets/download.js';
import { campaignRefs } from '../content/collect.js';
import type { ItemStatus } from '../content/progress.js';
import { redactHttp } from '../content/redact.js';
import type { StoredItem } from '../content/store.js';
import { CONTENT_KINDS, type ContentItemKey, type ContentKind, itemKey } from '../content/types.js';
import type { NormalizedCampaign } from '../normalize/campaign.js';
import type { NormalizedNode } from '../normalize/nodes.js';
import type { CampaignSummary } from '../parse/campaignList.js';
import { type ResolvedContent, buildCampaignDoc, draftNodesOf } from './campaignDoc.js';
import { htmlToText } from './htmlText.js';
import { findMergeFields } from './mergeFields.js';
import {
  RECORD_FILE,
  SINGLE_FILE_KINDS,
  attachmentFileName,
  campaignFolderName,
  contentRef,
} from './paths.js';

export type PlannedFile = { path: string; data: string | Buffer } | { path: string; copyFrom: string };

export interface ExportCampaignInput {
  funnelId: string;
  summary: CampaignSummary | null;
  normalized: NormalizedCampaign;
  publishNodes: NormalizedNode[];
}

export interface ExportInput {
  app: string;
  exportedAt: string;
  includeSecrets: boolean;
  campaigns: ExportCampaignInput[];
  /** Stored items, keyed by itemKey. */
  items: Map<string, StoredItem>;
  /** Progress statuses, keyed by itemKey — tells failed from notFound from never tried. */
  statuses: Map<string, ItemStatus>;
  assets: Record<string, AssetRecord>;
  /** Path on disk of a stored asset file. */
  assetSource: (file: string) => string;
  readText: (path: string) => string;
}

type KindCounts = { exported: number; failed: number; notFound: number; notFetched: number };

export interface Manifest {
  formatVersion: 1;
  app: string;
  exportedAt: string;
  secretsIncluded: boolean;
  campaignCount: number;
  content: Record<ContentKind, KindCounts>;
  assets: Record<AssetStatus, number>;
  campaigns: { funnelId: string; name: string | null; folder: string; missingContent: number }[];
}

export interface ExportPlan {
  files: PlannedFile[];
  manifest: Manifest;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function uniqueKeys(keys: ContentItemKey[]): ContentItemKey[] {
  const seen = new Map<string, ContentItemKey>();
  for (const key of keys) if (!seen.has(itemKey(key))) seen.set(itemKey(key), key);
  return [...seen.values()];
}

/**
 * Everything the export will write, computed without touching the disk except
 * through `readText`. The writer only executes this list.
 */
export function planExport(input: ExportInput): ExportPlan {
  const files: PlannedFile[] = [];
  const content = Object.fromEntries(
    CONTENT_KINDS.map((kind) => [kind, { exported: 0, failed: 0, notFound: 0, notFetched: 0 }]),
  ) as Record<ContentKind, KindCounts>;
  const accountAssets = new Map<string, AssetStatus>();
  const mergeIndex = new Map<string, Set<string>>();
  const manifestCampaigns: Manifest['campaigns'] = [];

  const perCampaign = input.campaigns.map((campaign) => ({
    campaign,
    name: campaign.normalized.name ?? campaign.summary?.name ?? null,
    refs: campaignRefs(campaign.funnelId, draftNodesOf(campaign.normalized), campaign.publishNodes),
  }));

  // Account-wide usage, for sharedWith.
  const usage = new Map<string, Map<string, string | null>>();
  for (const { campaign, name, refs } of perCampaign) {
    for (const { key } of refs) {
      const users = usage.get(itemKey(key)) ?? new Map<string, string | null>();
      users.set(campaign.funnelId, name);
      usage.set(itemKey(key), users);
    }
  }

  for (const { campaign, name, refs } of perCampaign) {
    const folder = `campaigns/${campaignFolderName(campaign.funnelId, name)}`;

    const resolve = (key: ContentItemKey): ResolvedContent => {
      const k = itemKey(key);
      if (input.items.has(k)) return { kind: key.kind, id: key.id, ref: contentRef(key) };
      const status = input.statuses.get(k);
      return {
        kind: key.kind,
        id: key.id,
        status: status === 'failed' || status === 'notFound' ? status : 'notFetched',
      };
    };

    const doc = buildCampaignDoc({
      funnelId: campaign.funnelId,
      normalized: campaign.normalized,
      summary: campaign.summary,
      publishNodes: campaign.publishNodes,
      resolve,
    });

    const campaignMerge = new Set(doc.mergeFields);
    const campaignAssets = new Map<string, Set<string>>();
    let missingContent = 0;

    for (const key of uniqueKeys(refs.map((r) => r.key))) {
      const k = itemKey(key);
      const stored = input.items.get(k);
      if (!stored) {
        const pointer = resolve(key);
        if ('status' in pointer) content[key.kind][pointer.status]++;
        missingContent++;
        continue;
      }
      content[key.kind].exported++;

      const ref = contentRef(key);
      const itemPath = `${folder}/${ref}`;
      const filePath = (name: string) => join(stored.dir, 'files', name);
      const texts = stored.files
        .filter((name) => /\.(html|txt)$/.test(name))
        .map((name) => input.readText(filePath(name)));
      const mergeFields = findMergeFields(JSON.stringify(stored.record), ...texts);
      for (const field of mergeFields) campaignMerge.add(field);

      for (const url of stored.assetUrls) {
        const users = campaignAssets.get(url) ?? new Set<string>();
        users.add(ref);
        campaignAssets.set(url, users);
      }

      const sharedWith = [...(usage.get(k) ?? new Map<string, string | null>())]
        .filter(([funnelId]) => funnelId !== campaign.funnelId)
        .map(([funnelId, otherName]) => ({ funnelId, name: otherName }));

      let record: object = stored.record;
      let secrets: object = {};
      if (stored.record.kind === 'http') {
        if (input.includeSecrets) {
          secrets = { secretsIncluded: true };
        } else {
          const redaction = redactHttp(stored.record);
          record = redaction.content;
          secrets = { redacted: redaction.redacted };
        }
      }

      const assetList = stored.assetUrls.map((url) => {
        const asset = input.assets[url];
        return {
          url,
          status: asset?.status ?? 'failed',
          file: asset?.status === 'downloaded' && asset.file ? `assets/${asset.file}` : null,
        };
      });

      const derivedText =
        stored.record.kind === 'email' &&
        stored.files.includes('body.html') &&
        !stored.files.includes('body.txt');

      // Stored, but the latest fetch of it did not finish: what is exported is
      // an older copy, and the reader should know.
      const fetchStatus = input.statuses.get(k);
      const staleness = fetchStatus === 'done' ? {} : { stale: true, fetchStatus: fetchStatus ?? 'unknown' };

      const body = {
        id: key.id,
        idAttribute: key.attribute,
        ...record,
        ...(derivedText ? { textDerivedFromHtml: true } : {}),
        ...staleness,
        ...secrets,
        mergeFields,
        usedBy: refs.filter((r) => itemKey(r.key) === k).map((r) => r.use),
        sharedWith,
        assets: assetList,
      };

      if (SINGLE_FILE_KINDS.has(key.kind)) {
        files.push({ path: itemPath, data: json(body) });
        continue;
      }

      files.push({ path: `${itemPath}/${RECORD_FILE[key.kind]}`, data: json(body) });
      for (const name of stored.files) {
        files.push({ path: `${itemPath}/${name}`, copyFrom: filePath(name) });
      }
      if (derivedText) {
        files.push({
          path: `${itemPath}/body.txt`,
          data: htmlToText(input.readText(filePath('body.html'))),
        });
      }
      if (stored.record.kind === 'email') {
        const used = new Set<string>();
        for (const attachment of stored.record.attachments) {
          const asset = input.assets[attachment.url];
          if (asset?.status !== 'downloaded' || !asset.file) continue;
          files.push({
            path: `${itemPath}/attachments/${attachmentFileName(attachment.name, used)}`,
            copyFrom: input.assetSource(asset.file),
          });
        }
      }
    }

    const assetEntries = [...campaignAssets].map(([url, users]) => {
      const asset: AssetRecord = input.assets[url] ?? {
        url,
        status: 'failed',
        reason: 'not in the asset index',
      };
      accountAssets.set(url, asset.status);
      const downloaded = asset.status === 'downloaded' && asset.file !== undefined;
      if (downloaded && asset.file) {
        files.push({ path: `${folder}/assets/${asset.file}`, copyFrom: input.assetSource(asset.file) });
      }
      return {
        ...asset,
        file: downloaded ? `assets/${asset.file}` : null,
        usedBy: [...users].sort(),
      };
    });
    files.push({ path: `${folder}/assets/assets.json`, data: json(assetEntries) });

    doc.mergeFields = [...campaignMerge].sort();
    for (const field of doc.mergeFields) {
      const users = mergeIndex.get(field) ?? new Set<string>();
      users.add(campaign.funnelId);
      mergeIndex.set(field, users);
    }
    files.push({ path: `${folder}/campaign.json`, data: json(doc) });
    manifestCampaigns.push({ funnelId: campaign.funnelId, name, folder, missingContent });
  }

  const assetCounts: Record<AssetStatus, number> = { downloaded: 0, failed: 0, tooLarge: 0, skipped: 0 };
  for (const status of accountAssets.values()) assetCounts[status]++;

  const manifest: Manifest = {
    formatVersion: 1,
    app: input.app,
    exportedAt: input.exportedAt,
    secretsIncluded: input.includeSecrets,
    campaignCount: input.campaigns.length,
    content,
    assets: assetCounts,
    campaigns: manifestCampaigns,
  };
  files.push({ path: 'manifest.json', data: json(manifest) });
  files.push({
    path: 'merge-fields.json',
    data: json(
      [...mergeIndex]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([field, users]) => ({ field, campaignCount: users.size, campaigns: [...users].sort() })),
    ),
  });

  return { files, manifest };
}
