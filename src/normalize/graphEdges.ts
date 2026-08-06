import type { NormalizedCampaign } from './campaign.js';
import type { NormalizedNode } from './nodes.js';

export type EntityKind =
  | 'campaign'
  | 'tag'
  | 'email'
  | 'webform'
  | 'landingPage'
  | 'product'
  | 'form';

export type EdgeKind =
  | 'applies'
  | 'removes'
  | 'listens-for'
  | 'tests'
  | 'sends'
  | 'entry-point'
  | 'references-campaign'
  | 'triggers';

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** The cell that produced an observed edge. */
  viaCellId?: string;
  /** The tag linking applier to listener, on a derived `triggers` edge. */
  viaTagId?: string;
  /** Present and true only on computed edges, never on observed ones. */
  derived?: boolean;
}

/**
 * What one harvester found in one campaign.
 *
 * `tallies` are counts keyed by a self-describing reason. They are merged
 * account-wide before being rendered, because a per-campaign warning about an
 * unmodelled attribute would fire 170 times and mean nothing; one line saying
 * "94× ..." is the actual signal.
 */
export interface EdgeHarvest {
  edges: GraphEdge[];
  tallies: Record<string, number>;
}

export function entityId(kind: EntityKind, id: string): string {
  return `${kind}:${id}`;
}

/** Every vertex in a campaign, including the steps nested inside sequences. */
export function campaignNodes(campaign: NormalizedCampaign): NormalizedNode[] {
  return [
    ...campaign.goals,
    ...campaign.decisions,
    ...campaign.notes,
    ...campaign.sequences,
    ...campaign.sequences.flatMap((sequence) => sequence.steps),
  ];
}

export function mergeTallies(into: Record<string, number>, from: Record<string, number>): void {
  for (const [reason, count] of Object.entries(from)) {
    into[reason] = (into[reason] ?? 0) + count;
  }
}

/**
 * Removes edges identical in endpoints, kind and provenance.
 *
 * A decision that tests the same tag in two rules yields the same edge twice;
 * that is one fact, not two. Provenance is part of the key, so the same tag
 * tested by two different decisions stays two edges.
 */
export function dedupeEdges(edges: GraphEdge[]): GraphEdge[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = `${edge.from}|${edge.to}|${edge.kind}|${edge.viaCellId ?? ''}|${edge.viaTagId ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Harvests tag relationships from one campaign.
 *
 * Direction comes from `config.isApply`, the string "true" or "false" — the
 * only thing distinguishing an apply-tag step from a remove-tag step, since
 * both carry style="tag". Across the corpus 138 apply, 45 remove, and 58 have
 * no isApply at all (and, as it happens, no tagIds either).
 *
 * Tags on any other style are counted and dropped. Seven goal styles carry
 * tagIds without saying what they do with them; guessing a direction there
 * would invent 24 relationships that may not exist. The tags themselves are
 * still registered as entities by the caller — the tag exists, the edge does not.
 */
export function tagEdges(campaign: NormalizedCampaign, from: string): EdgeHarvest {
  const edges: GraphEdge[] = [];
  const tallies: Record<string, number> = {};

  for (const node of campaignNodes(campaign)) {
    const { tagIds } = node.references;
    if (tagIds.length === 0) continue;

    let kind: EdgeKind | null = null;
    if (node.style === 'tag') {
      if (node.config.isApply === 'true') kind = 'applies';
      else if (node.config.isApply === 'false') kind = 'removes';
    } else if (node.style === 'tagApplied') {
      kind = 'listens-for';
    }

    if (kind === null) {
      const reason = `tagIds on "${node.style}" nodes state no apply/remove direction`;
      tallies[reason] = (tallies[reason] ?? 0) + tagIds.length;
      continue;
    }

    for (const tagId of tagIds) {
      edges.push({ from, to: entityId('tag', tagId), kind, viaCellId: node.cellId });
    }
  }

  return { edges, tallies };
}
