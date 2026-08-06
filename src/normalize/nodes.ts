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
