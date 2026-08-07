import { XMLParser } from 'fast-xml-parser';
import { cleanName, stripLongSuffix } from '../parse/cells.js';

/**
 * Attributes whose values are entity ids worth following.
 *
 * Taken from a survey of all 170 campaigns: 23 attributes carry Java-Long
 * values. `funnelId` is excluded — it identifies the campaign itself rather
 * than something the campaign points at — as are `decisionId` and `flowId`,
 * which are structural routing within a campaign rather than references out.
 */
export const FK_ATTRIBUTES = [
  'marketingEmailId',
  'webformId',
  'landingPageId',
  'purchaseId',
  'eventId',
  'sourceFunnelId',
  'internalFormId',
  'actionSetId',
  'marketingNoteId',
  'fileBoxId',
  'stageId',
  'marketingFulfillmentId',
  'confirmLinkId',
  'fieldValueFileBoxId',
  'userId',
  'marketingLetterId',
  'voiceBroadcastId',
  'marketingFaxId',
  'createOrderConfigId',
  'roundRobinId',
] as const;

export interface NodeReferences {
  tagIds: string[];
  tagCategoryIds: string[];
  [key: string]: string | string[] | undefined;
}

/**
 * A reference as a list, whichever shape it was stored in.
 *
 * The same foreign key arrives as a scalar attribute in one account and as an
 * `<Array as="…">` in another — 361 purchase goals in se232 carry
 * `<Array as="purchaseId">` and not one carries the scalar. Storing each
 * faithfully keeps the artifact honest; reading through here means no consumer
 * has to know which shape it got, and none can silently skip the array form the
 * way `typeof value === 'string'` checks did.
 */
export function referenceValues(references: NodeReferences, attribute: string): string[] {
  const value = references[attribute];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value;
  return [];
}

export interface NormalizedNode {
  cellId: string;
  style: string;
  metaType: string | null;
  parent: string | null;
  name: string | null;
  ready: boolean | null;
  published: boolean | null;
  config: Record<string, string>;
  lists: Record<string, string[]>;
  objectLists: Record<string, Record<string, string>[]>;
  references: NodeReferences;
}

/**
 * Config keys that are status or metadata rather than type-specific settings.
 *
 * Everything else on a node is what the operator was supposed to fill in.
 */
const STATUS_KEYS = new Set([
  'initialized',
  'ready',
  'published',
  'broken',
  'deepCopy',
  'global',
  'name',
  'flowType',
  'achievementType',
]);

/**
 * True when nobody ever filled this node in.
 *
 * Keap refuses to publish a campaign containing one — observed live on campaign
 * 987, where publication required deleting a `task` step whose every field was
 * empty (`test/fixtures/campaign-987-lifecycle/`). So this is the same
 * incompleteness Keap's own validator rejects, and it is why so many campaigns
 * were never published.
 *
 * Empty and "0" both count as unset: the deleted step carried
 * `taskType="" taskAssignToOwner="0"`, so testing for empty strings alone would
 * have called it configured. Arrays and objectLists are checked too — a
 * decision keeps its branches in `objectLists`, not `config`, and reading
 * config alone would condemn every decision in the account.
 *
 * Validated against two independently established counts: it flags exactly the
 * 11 branchless decisions from section 11, and exactly the 58 tag steps that
 * carry neither `isApply` nor any tag.
 */
export function isUnconfigured(node: NormalizedNode): boolean {
  for (const [key, value] of Object.entries(node.config)) {
    if (STATUS_KEYS.has(key)) continue;
    if (value !== '' && value !== '0') return false;
  }
  if (node.references.tagIds.length > 0) return false;
  for (const [key, value] of Object.entries(node.references)) {
    if (key === 'tagIds' || key === 'tagCategoryIds') continue;
    if (typeof value === 'string') return false;
  }
  if (Object.values(node.lists).some((entries) => entries.length > 0)) return false;
  if (Object.values(node.objectLists).some((entries) => entries.length > 0)) return false;
  return true;
}

export interface RawEdge {
  cellId: string;
  source: string;
  target: string;
  /** The parent cell id: "1" for campaign level, or a flow id for a step edge. */
  scope: string;
}

export interface ParsedGraph {
  nodes: NormalizedNode[];
  edges: RawEdge[];
  styleCounts: Record<string, number>;
  warnings: string[];
}

const ATTR = '@_';

interface XmlNode {
  [key: string]: unknown;
}

function asArray(value: unknown): XmlNode[] {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]) as XmlNode[];
}

function attr(node: XmlNode, name: string): string | undefined {
  const raw = node[`${ATTR}${name}`];
  return raw === undefined || raw === null ? undefined : String(raw);
}

/** Keap writes "1"/"0"; anything else is left unknown rather than coerced. */
function boolOrNull(raw: string | undefined): boolean | null {
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return null;
}

function attributesOf(node: XmlNode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!key.startsWith(ATTR)) continue;
    const name = key.slice(ATTR.length);
    if (name === 'as') continue; // serialisation marker, not data
    out[name] = String(value);
  }
  return out;
}

/**
 * Parses every mxCell into a generic node or an edge.
 *
 * Nothing is interpreted per style: the vocabulary is 61 styles and 104
 * attributes, and was unknown until the whole corpus was surveyed. Every
 * attribute lands in `config` and every nested array in `lists` or
 * `objectLists`, so a node type nobody has seen yet still round-trips.
 */
export function parseNodes(draftXml: string): ParsedGraph {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: ATTR,
    parseAttributeValue: false,
    isArray: (name) => ['mxCell', 'Object', 'Array', 'add'].includes(name),
  });

  const doc = parser.parse(draftXml) as XmlNode;
  const root = (doc.mxGraphModel as XmlNode | undefined)?.root as XmlNode | undefined;
  if (!root) throw new Error('draftXml has no mxGraphModel/root element');

  const nodes: NormalizedNode[] = [];
  const edges: RawEdge[] = [];
  const styleCounts: Record<string, number> = {};
  const warnings: string[] = [];

  for (const cell of asArray(root.mxCell)) {
    const cellId = attr(cell, 'id');
    if (cellId === undefined) {
      warnings.push('an mxCell has no id and was skipped');
      continue;
    }

    const style = attr(cell, 'style') ?? '(none)';
    styleCounts[style] = (styleCounts[style] ?? 0) + 1;

    // An edge is a cell in its own right, not a property of the vertices.
    const source = attr(cell, 'source');
    const target = attr(cell, 'target');
    if (source !== undefined && target !== undefined) {
      edges.push({ cellId, source, target, scope: attr(cell, 'parent') ?? '1' });
      continue;
    }

    const value = asArray(cell.Object)[0];
    const config = value ? attributesOf(value) : {};

    const lists: Record<string, string[]> = {};
    const objectLists: Record<string, Record<string, string>[]> = {};
    for (const array of asArray(value?.Array)) {
      const name = attr(array, 'as');
      if (name === undefined) continue;

      const scalars = asArray(array.add)
        .map((entry) => stripLongSuffix(attr(entry, 'value')))
        .filter((v): v is string => v !== null);
      if (scalars.length > 0) lists[name] = scalars;

      const objects = asArray(array.Object).map((entry) => {
        const bag = attributesOf(entry);
        for (const [key, raw] of Object.entries(bag)) bag[key] = stripLongSuffix(raw) ?? raw;
        return bag;
      });
      if (objects.length > 0) objectLists[name] = objects;

      // An empty array is real data — an unconfigured goal, for instance.
      if (scalars.length === 0 && objects.length === 0) lists[name] = [];
    }

    const references: NodeReferences = {
      tagIds: lists.tagIds ?? [],
      tagCategoryIds: lists.tagCategoryIds ?? [],
    };
    for (const key of FK_ATTRIBUTES) {
      // A foreign key can arrive either as an attribute or as an <Array as="…">.
      // Both forms occur for the same key across accounts, so both are lifted;
      // referenceValues() lets consumers read them uniformly.
      const list = lists[key];
      if (list !== undefined && list.length > 0) {
        const values = list.map((v) => stripLongSuffix(v)).filter((v): v is string => v !== null);
        if (values.length > 0) references[key] = values;
        continue;
      }

      const raw = config[key];
      if (raw === undefined) continue;
      const stripped = stripLongSuffix(raw);
      if (stripped !== null) references[key] = stripped;
    }

    nodes.push({
      cellId,
      style,
      metaType: attr(cell, 'metaType') ?? null,
      parent: attr(cell, 'parent') ?? null,
      name: cleanName(config.name),
      ready: boolOrNull(config.ready),
      published: boolOrNull(config.published),
      config,
      lists,
      objectLists,
      references,
    });
  }

  return { nodes, edges, styleCounts, warnings };
}
