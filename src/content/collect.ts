import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { campaignDirFor } from '../app.js';
import { type NormalizedNode, parseNodes, referenceValues } from '../normalize/nodes.js';
import { stripLongSuffix } from '../parse/cells.js';
import {
  CONTENT_ID_PATTERN,
  CONTENT_KINDS,
  type ContentItem,
  type ContentItemKey,
  type ContentUse,
  KIND_ATTRIBUTES,
  itemKey,
} from './types.js';

export interface ContentRef {
  key: ContentItemKey;
  use: ContentUse;
}

/** Every content reference the nodes make, one per (node, attribute, id). */
export function contentRefsOf(
  nodes: NormalizedNode[],
): { key: ContentItemKey; node: NormalizedNode }[] {
  const out: { key: ContentItemKey; node: NormalizedNode }[] = [];
  for (const node of nodes) {
    for (const kind of CONTENT_KINDS) {
      for (const attribute of KIND_ATTRIBUTES[kind]) {
        // Most content ids are lifted into node.references. Some — like
        // convrrtLandingPageId — are not FK_ATTRIBUTES, so they stay in
        // node.config; fall back there when the reference didn't carry one.
        let ids = referenceValues(node.references, attribute);
        if (ids.length === 0) {
          const configId = stripLongSuffix(node.config[attribute]);
          if (configId) ids = [configId];
        }
        for (const id of ids) {
          if (CONTENT_ID_PATTERN.test(id)) {
            // Skip ids that consist only of zeros: Keap uses 0 / 0L for "nothing selected"
            // and treats them as unconfigured, not as a reference to content id 0.
            if (!/^0+$/.test(id)) {
              out.push({ key: { kind, attribute, id }, node });
            }
          }
        }
      }
    }
  }
  return out;
}

/**
 * A campaign's content references across its draft and published versions.
 *
 * A step is `both` when the same cell points at the same content in each,
 * `draft` or `published` when only one version has it.
 */
export function campaignRefs(
  funnelId: string,
  draftNodes: NormalizedNode[],
  publishNodes: NormalizedNode[],
): ContentRef[] {
  const draft = contentRefsOf(draftNodes);
  const published = contentRefsOf(publishNodes);
  const refId = (r: { key: ContentItemKey; node: NormalizedNode }) =>
    `${r.node.cellId}|${itemKey(r.key)}`;
  const publishedIds = new Set(published.map(refId));
  const draftIds = new Set(draft.map(refId));

  const use = (node: NormalizedNode, version: ContentUse['version']): ContentUse => ({
    funnelId,
    cellId: node.cellId,
    style: node.style,
    name: node.name,
    version,
  });

  const refs: ContentRef[] = draft.map((r) => ({
    key: r.key,
    use: use(r.node, publishedIds.has(refId(r)) ? 'both' : 'draft'),
  }));
  for (const r of published) {
    if (!draftIds.has(refId(r))) refs.push({ key: r.key, use: use(r.node, 'published') });
  }
  return refs;
}

const KIND_ORDER = new Map(CONTENT_KINDS.map((kind, index) => [kind, index]));

/** One item per (kind, attribute, id), carrying every step that uses it. */
export function buildQueue(refs: ContentRef[]): ContentItem[] {
  const byKey = new Map<string, ContentItem>();
  for (const { key, use } of refs) {
    const k = itemKey(key);
    const existing = byKey.get(k);
    if (existing) existing.usedBy.push(use);
    else byKey.set(k, { ...key, usedBy: [use] });
  }
  return [...byKey.values()].sort(
    (a, b) =>
      (KIND_ORDER.get(a.kind) ?? 0) - (KIND_ORDER.get(b.kind) ?? 0) ||
      a.attribute.localeCompare(b.attribute) ||
      Number(a.id) - Number(b.id) ||
      a.id.localeCompare(b.id),
  );
}

export interface CampaignNodes {
  funnelId: string;
  draft: NormalizedNode[];
  published: NormalizedNode[];
}

/**
 * Parses both XML files of an extracted campaign.
 *
 * The normalised campaign is built from the draft alone, so a step that exists
 * only in the published version would be invisible from there.
 */
export async function loadCampaignNodes(
  app: string,
  funnelId: string,
): Promise<CampaignNodes | null> {
  const dir = campaignDirFor(app, funnelId);
  const draftPath = join(dir, 'draft.xml');
  if (!existsSync(draftPath)) return null;

  const draft = parseNodes(await readFile(draftPath, 'utf8')).nodes;
  const publishPath = join(dir, 'publish.xml');
  const publishXml = existsSync(publishPath) ? await readFile(publishPath, 'utf8') : '';
  const published = publishXml.trim() === '' ? [] : parseNodes(publishXml).nodes;
  return { funnelId, draft, published };
}
