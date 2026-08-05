import { XMLParser } from 'fast-xml-parser';

export interface DecisionBranch {
  decisionId: string;
  flowId: string;
}

export interface DecisionCell {
  cellId: string;
  name: string | null;
  branches: DecisionBranch[];
}

export interface CellInventory {
  cellCount: number;
  decisions: DecisionCell[];
  styleCounts: Record<string, number>;
  warnings: string[];
}

const ATTR = '@_';

/**
 * Foreign keys are serialised as Java Longs: "479L" -> "479".
 *
 * Only digits-then-L qualify. A bare /L$/ strip corrupts any ordinary value
 * that happens to end in a capital L — decision rules can match literal
 * strings, so "EMAIL" would silently become "EMAI".
 */
export function stripLongSuffix(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value);
  const match = /^(\d+)L$/.exec(text);
  return match?.[1] ?? text;
}

/** `~br~` is Keap's line-break token inside name attributes. */
export function cleanName(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const cleaned = String(value).replace(/~br~/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length > 0 ? cleaned : null;
}

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

export function parseCells(draftXml: string): CellInventory {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: ATTR,
    parseAttributeValue: false,
    isArray: (name) => ['mxCell', 'Object', 'Array'].includes(name),
  });

  const doc = parser.parse(draftXml) as XmlNode;
  const model = doc.mxGraphModel as XmlNode | undefined;
  const root = model?.root as XmlNode | undefined;
  if (!root) {
    throw new Error('draftXml has no mxGraphModel/root element');
  }

  const cells = asArray(root.mxCell);
  const styleCounts: Record<string, number> = {};
  const decisions: DecisionCell[] = [];
  const warnings: string[] = [];

  for (const cell of cells) {
    const cellId = attr(cell, 'id') ?? '(missing id)';
    const style = attr(cell, 'style') ?? '(none)';
    styleCounts[style] = (styleCounts[style] ?? 0) + 1;

    if (style !== 'decision') continue;

    const value = asArray(cell.Object)[0];
    if (!value) {
      warnings.push(`decision cell ${cellId} has no <Object as="value"> payload`);
      decisions.push({ cellId, name: null, branches: [] });
      continue;
    }

    const decisionsArray = asArray(value.Array).find((a) => attr(a, 'as') === 'decisions');
    const branches: DecisionBranch[] = [];

    for (const entry of asArray(decisionsArray?.Object)) {
      const decisionId = stripLongSuffix(attr(entry, 'decisionId'));
      const flowId = stripLongSuffix(attr(entry, 'flowId'));
      if (decisionId === null || flowId === null) {
        warnings.push(`decision cell ${cellId} has a branch missing decisionId or flowId`);
        continue;
      }
      branches.push({ decisionId, flowId });
    }

    if (branches.length === 0) {
      warnings.push(`decision cell ${cellId} has no routing branches (likely unconfigured)`);
    }

    decisions.push({ cellId, name: cleanName(attr(value, 'name')), branches });
  }

  return { cellCount: cells.length, decisions, styleCounts, warnings };
}

export interface CampaignIdentity {
  appName: string | null;
  funnelId: string | null;
  buildNumber: string | null;
}

/**
 * Reads the self-identifying markers Keap embeds in every campaign.
 *
 * Observed on the <Object as="value"> child of mxCell id="0", the graph root:
 *   <Object initialized="1" funnelId="987L" appName="jordan" buildNumber="..." as="value">
 *
 * Searches every cell for the first Object carrying appName rather than
 * hardcoding cell 0, so the marker moving does not break identification.
 */
export function parseIdentity(draftXml: string): CampaignIdentity {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: ATTR,
    parseAttributeValue: false,
    isArray: (name) => ['mxCell', 'Object', 'Array'].includes(name),
  });

  const doc = parser.parse(draftXml) as XmlNode;
  const model = doc.mxGraphModel as XmlNode | undefined;
  const root = model?.root as XmlNode | undefined;
  const empty: CampaignIdentity = { appName: null, funnelId: null, buildNumber: null };
  if (!root) return empty;

  for (const cell of asArray(root.mxCell)) {
    for (const value of asArray(cell.Object)) {
      const appName = attr(value, 'appName');
      if (appName === undefined) continue;
      return {
        appName,
        funnelId: stripLongSuffix(attr(value, 'funnelId')),
        buildNumber: attr(value, 'buildNumber') ?? null,
      };
    }
  }

  return empty;
}
