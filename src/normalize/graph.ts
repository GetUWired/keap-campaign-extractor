import type { NormalizedCampaign } from './campaign.js';
import {
  type EntityKind,
  type GraphEdge,
  campaignNodes,
  decisionTagEdges,
  dedupeEdges,
  entityId,
  mergeTallies,
  referenceEdges,
  tagEdges,
  tagLabels,
} from './graphEdges.js';

export interface GraphEntity {
  id: string;
  kind: EntityKind;
  label: string | null;
  /** Distinct campaigns with an observed edge to this entity, excluding itself. */
  campaignCount: number;
}

export interface GraphFindings {
  unreachableCampaigns: { campaignId: string; reason: string }[];
  tagsAppliedByNobody: string[];
  tagsNobodyListensFor: string[];
  sharedEmails: { emailId: string; campaigns: string[] }[];
  duplicateTagAppliers: { tagId: string; campaigns: string[] }[];
}

export interface AccountGraph {
  entities: GraphEntity[];
  edges: GraphEdge[];
  findings: GraphFindings;
  warnings: string[];
}

const EMPTY_FINDINGS: GraphFindings = {
  unreachableCampaigns: [],
  tagsAppliedByNobody: [],
  tagsNobodyListensFor: [],
  sharedEmails: [],
  duplicateTagAppliers: [],
};

/** "tag:646" → "tag". Entity ids are minted by entityId and always have one colon. */
function kindOf(id: string): EntityKind {
  return id.slice(0, id.indexOf(':')) as EntityKind;
}

/**
 * Sorts numerically within a kind so campaign:9 precedes campaign:100.
 *
 * Output ordering is not cosmetic: graph.json is regenerated on every run, so
 * an unstable order turns a no-op re-run into a large diff.
 */
function compareEntities(a: GraphEntity, b: GraphEntity): number {
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  const left = Number(a.id.slice(a.id.indexOf(':') + 1));
  const right = Number(b.id.slice(b.id.indexOf(':') + 1));
  if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function compareEdges(a: GraphEdge, b: GraphEdge): number {
  const key = (e: GraphEdge) =>
    `${e.from}|${e.kind}|${e.to}|${e.viaCellId ?? ''}|${e.viaTagId ?? ''}`;
  const left = key(a);
  const right = key(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function buildGraph(campaigns: NormalizedCampaign[]): AccountGraph {
  const warnings: string[] = [];

  const usable: { campaign: NormalizedCampaign; from: string }[] = [];
  for (const campaign of campaigns) {
    if (campaign.funnelId === null) {
      warnings.push(
        `a campaign has no funnelId and was left out of the graph ` +
          `(name: ${campaign.name ?? 'unknown'})`,
      );
      continue;
    }
    usable.push({ campaign, from: entityId('campaign', campaign.funnelId) });
  }

  if (usable.length === 0) {
    throw new Error('no campaigns with a funnelId — nothing to build a graph from');
  }

  const tallies: Record<string, number> = {};
  const harvested: GraphEdge[] = [];
  for (const { campaign, from } of usable) {
    for (const harvest of [
      tagEdges(campaign, from),
      decisionTagEdges(campaign, from),
      referenceEdges(campaign, from),
    ]) {
      harvested.push(...harvest.edges);
      mergeTallies(tallies, harvest.tallies);
    }
  }
  const edges = dedupeEdges(harvested);

  const labels = tagLabels(usable.map((entry) => entry.campaign));
  const entities = new Map<string, GraphEntity>();
  const touchedBy = new Map<string, Set<string>>();

  const register = (id: string, label: string | null): void => {
    if (!entities.has(id)) entities.set(id, { id, kind: kindOf(id), label, campaignCount: 0 });
  };

  for (const { campaign, from } of usable) register(from, campaign.name);

  for (const edge of edges) {
    const kind = kindOf(edge.to);
    register(edge.to, kind === 'tag' ? (labels.get(edge.to.slice(4)) ?? null) : null);
    if (edge.from === edge.to) continue;
    const touching = touchedBy.get(edge.to) ?? new Set<string>();
    touching.add(edge.from);
    touchedBy.set(edge.to, touching);
  }

  // A tag referenced without a stated direction earns no edge, but it exists.
  // Registering it here is what takes the account from 130 tags to the 142
  // actually present, and keeps tag entities a superset of tag edge targets.
  for (const { campaign } of usable) {
    for (const node of campaignNodes(campaign)) {
      for (const tagId of node.references.tagIds) {
        register(entityId('tag', tagId), labels.get(tagId) ?? null);
      }
    }
  }

  for (const entity of entities.values()) {
    entity.campaignCount = touchedBy.get(entity.id)?.size ?? 0;
  }

  for (const [reason, count] of Object.entries(tallies)) warnings.push(`${count}× ${reason}`);

  return {
    entities: [...entities.values()].sort(compareEntities),
    edges: [...edges].sort(compareEdges),
    findings: { ...EMPTY_FINDINGS },
    warnings,
  };
}
