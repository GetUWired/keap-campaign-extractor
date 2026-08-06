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
