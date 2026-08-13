import type { NormalizedCampaign } from '../normalize/campaign.js';
import type { AccountGraph } from '../normalize/graph.js';
import type { RequestedTag, TagList } from './tagList.js';

export type LocationKind = 'trigger' | 'step' | 'decision';

export interface ImpactLocation {
  campaignId: string;
  campaignName: string | null;
  tagId: string;
  tagName: string;
  group: string | null;
  kind: LocationKind;
  /** The graph edge that produced this: listens-for, tests, applies or removes. */
  edgeKind: string;
  cellId: string;
  /** Present for a step: which sequence, and where in it (1-based). */
  sequenceName?: string;
  stepPosition?: number;
  /** The node's own name — the operator's words for why it is there. */
  nodeName?: string | null;
}

export interface TagImpact {
  tagId: string;
  tagName: string;
  group: string | null;
  locations: ImpactLocation[];
  campaignCount: number;
}

export interface CampaignImpact {
  campaignId: string;
  campaignName: string | null;
  locations: ImpactLocation[];
  /** Tags from one combine group that this campaign references more than one of. */
  duplicatedGroups: { group: string; tagIds: string[] }[];
}

export interface TagImpactReport {
  appName: string;
  analyzedAt: string;
  tags: TagImpact[];
  campaigns: CampaignImpact[];
  /** Requested tags no campaign references. NOT the same as "safe to delete". */
  noCampaignReferences: { tagId: string; tagName: string }[];
  warnings: string[];
}

/** Which of the three location kinds an edge represents. */
const LOCATION_KIND: Record<string, LocationKind> = {
  'listens-for': 'trigger',
  tests: 'decision',
  applies: 'step',
  removes: 'step',
};

interface Placement {
  kind: LocationKind;
  sequenceName?: string;
  stepPosition?: number;
  nodeName: string | null;
}

/**
 * Finds where a cell sits inside its campaign.
 *
 * The edge says which tag and which campaign; only the normalized campaign can
 * say that cell 10 is step 2 of "Onboarding", which is what an operator needs
 * to find it in the builder.
 */
function placeCell(campaign: NormalizedCampaign, cellId: string, fallback: LocationKind): Placement {
  for (const goal of campaign.goals) {
    if (goal.cellId === cellId) return { kind: 'trigger', nodeName: goal.name };
  }
  for (const decision of campaign.decisions) {
    if (decision.cellId === cellId) return { kind: 'decision', nodeName: decision.name };
  }
  for (const sequence of campaign.sequences) {
    const index = sequence.steps.findIndex((step) => step.cellId === cellId);
    if (index < 0) continue;
    return {
      kind: 'step',
      sequenceName: sequence.name ?? undefined,
      // 1-based: an operator counting boxes in the builder starts at one.
      stepPosition: index + 1,
      nodeName: sequence.steps[index]?.name ?? null,
    };
  }
  return { kind: fallback, nodeName: null };
}

export function analyzeTagImpact(
  appName: string,
  list: TagList,
  campaigns: NormalizedCampaign[],
  graph: AccountGraph,
): TagImpactReport {
  const warnings = [...list.warnings];
  const requested = new Map<string, RequestedTag>(list.tags.map((t) => [t.id, t]));
  const byId = new Map(campaigns.map((c) => [c.funnelId ?? '', c]));

  const byTag = new Map<string, ImpactLocation[]>();
  const byCampaign = new Map<string, ImpactLocation[]>();

  for (const edge of graph.edges) {
    // Derived edges are computed, not observed, and merge consequences are out
    // of scope — a triggers edge is never a location.
    if (edge.derived === true) continue;
    if (!edge.to.startsWith('tag:')) continue;
    const kind = LOCATION_KIND[edge.kind];
    if (kind === undefined) continue;

    const tagId = edge.to.slice('tag:'.length);
    const tag = requested.get(tagId);
    if (tag === undefined) continue;

    const campaignId = edge.from.slice('campaign:'.length);
    const campaign = byId.get(campaignId);
    if (campaign === undefined) continue;

    const placement = placeCell(campaign, edge.viaCellId ?? '', kind);
    const location: ImpactLocation = {
      campaignId,
      campaignName: campaign.name,
      tagId,
      tagName: tag.name,
      group: tag.group,
      kind: placement.kind,
      edgeKind: edge.kind,
      cellId: edge.viaCellId ?? '',
      nodeName: placement.nodeName,
    };
    if (placement.sequenceName !== undefined) location.sequenceName = placement.sequenceName;
    if (placement.stepPosition !== undefined) location.stepPosition = placement.stepPosition;

    byTag.set(tagId, [...(byTag.get(tagId) ?? []), location]);
    byCampaign.set(campaignId, [...(byCampaign.get(campaignId) ?? []), location]);
  }

  // A decision with no criteria on disk hides whatever tags it routes on, so a
  // report that cannot see everything says so rather than reading as complete.
  for (const campaign of campaigns) {
    const blind = campaign.decisions.filter((d) => d.branches.every((b) => b.rules === null));
    if (blind.length > 0) {
      warnings.push(
        `campaign ${campaign.funnelId} has ${blind.length} decision(s) with no criteria on disk — ` +
          `any tag they route on is invisible to this analysis`,
      );
    }
  }

  const tags: TagImpact[] = list.tags.map((tag) => {
    const locations = byTag.get(tag.id) ?? [];
    return {
      tagId: tag.id,
      tagName: tag.name,
      group: tag.group,
      locations,
      campaignCount: new Set(locations.map((l) => l.campaignId)).size,
    };
  });

  const campaignImpacts: CampaignImpact[] = [...byCampaign.entries()]
    .map(([campaignId, locations]) => {
      const groups = new Map<string, Set<string>>();
      for (const location of locations) {
        if (location.group === null) continue;
        groups.set(location.group, (groups.get(location.group) ?? new Set()).add(location.tagId));
      }
      return {
        campaignId,
        campaignName: locations[0]?.campaignName ?? null,
        locations,
        duplicatedGroups: [...groups.entries()]
          .filter(([, ids]) => ids.size > 1)
          .map(([group, ids]) => ({ group, tagIds: [...ids].sort() })),
      };
    })
    .sort((a, b) => b.locations.length - a.locations.length);

  return {
    appName,
    analyzedAt: new Date().toISOString(),
    tags,
    campaigns: campaignImpacts,
    noCampaignReferences: tags
      .filter((t) => t.locations.length === 0)
      .map((t) => ({ tagId: t.tagId, tagName: t.tagName })),
    warnings,
  };
}
