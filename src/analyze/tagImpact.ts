import type { NormalizedCampaign } from '../normalize/campaign.js';
import type { AccountGraph } from '../normalize/graph.js';
import type { CampaignSummary } from '../parse/campaignList.js';
import type { RequestedTag, TagList } from './tagList.js';

export type LocationKind = 'trigger' | 'step' | 'decision';

/**
 * Where a campaign stands, per §14's two signals.
 *
 * `publishXml` answers *has this ever been published*; the campaign list's
 * Published Date answers *is it live now*. On se232 they disagree about 125
 * campaigns, so collapsing them to one boolean would report a third of the
 * account's dead campaigns as running.
 *
 * `unknown` means the campaign list was not supplied — an absent answer, not a
 * fourth state.
 */
export type CampaignStatus = 'live' | 'stopped' | 'never-published' | 'unknown';

export const STATUS_RANK: Record<CampaignStatus, number> = {
  live: 0,
  stopped: 1,
  'never-published': 2,
  unknown: 3,
};

export function campaignStatus(
  campaign: NormalizedCampaign,
  summary: CampaignSummary | undefined,
): CampaignStatus {
  if (summary === undefined) return 'unknown';
  if (summary.published) return 'live';
  return campaign.published ? 'stopped' : 'never-published';
}

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
  /** For an unnamed decision: the name of whatever feeds it on the canvas. */
  after?: string;
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
  status: CampaignStatus;
  /** On the operator's list of campaigns to delete, so its breakage is moot. */
  plannedDeletion: boolean;
  /** From the campaign list: how many contacts are sitting in it right now. */
  activeContacts: number | null;
  /** Verbatim as the list rendered it, e.g. "8/5/2026 11:32 AM". */
  publishedDate: string | null;
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
  noCampaignReferences: { tagId: string; tagName: string; group: string | null }[];
  /** How many affected campaigns are themselves slated for deletion. */
  plannedDeletions: number;
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
  after?: string;
}

/**
 * Names an unnamed decision by whatever feeds it.
 *
 * Operators name goals and sequences but almost never the decision diamonds
 * between them — every one of se232's 179 is nameless — so "cell 1349" is the
 * only thing left to print, and it is not something anyone can find in the
 * builder. The campaign-level edge into it gives "the decision after Any
 * purchase", which is.
 */
function upstreamName(campaign: NormalizedCampaign, cellId: string): string | undefined {
  const named = new Map<string, string | null>();
  for (const node of [...campaign.goals, ...campaign.sequences, ...campaign.decisions]) {
    named.set(node.cellId, node.name);
  }
  for (const edge of campaign.edges) {
    if (edge.target !== cellId || edge.scope !== '1') continue;
    const name = named.get(edge.source);
    if (name !== null && name !== undefined && name !== '') return name;
  }
  return undefined;
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
    if (decision.cellId !== cellId) continue;
    const placement: Placement = { kind: 'decision', nodeName: decision.name };
    if (decision.name === null || decision.name === '') {
      const after = upstreamName(campaign, cellId);
      if (after !== undefined) placement.after = after;
    }
    return placement;
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
  /** The campaign list, for status. Absent means every status reads `unknown`. */
  summaries: CampaignSummary[] = [],
  /** Campaign ids the operator intends to delete. Absent means none are. */
  plannedDeletions: string[] = [],
): TagImpactReport {
  const warnings = [...list.warnings];
  const requested = new Map<string, RequestedTag>(list.tags.map((t) => [t.id, t]));
  const byId = new Map(campaigns.map((c) => [c.funnelId ?? '', c]));
  const summaryById = new Map(summaries.map((s) => [s.funnelId, s]));
  const deleting = new Set(plannedDeletions);

  // A campaign id on the deletion list that does not exist in the account is
  // almost always a typo, and silently matching nothing would read as "that one
  // is fine".
  for (const campaignId of deleting) {
    if (!byId.has(campaignId)) {
      warnings.push(
        `campaign ${campaignId} is on the deletion list but is not in this account's extract`,
      );
    }
  }

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
    if (placement.after !== undefined) location.after = placement.after;

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
      const campaign = byId.get(campaignId);
      const summary = summaryById.get(campaignId);
      return {
        campaignId,
        campaignName: locations[0]?.campaignName ?? null,
        status: campaign === undefined ? 'unknown' : campaignStatus(campaign, summary),
        plannedDeletion: deleting.has(campaignId),
        activeContacts: summary?.activeContacts ?? null,
        publishedDate: summary?.publishedDate ?? null,
        locations,
        duplicatedGroups: [...groups.entries()]
          .filter(([, ids]) => ids.size > 1)
          .map(([group, ids]) => ({ group, tagIds: [...ids].sort() })),
      };
    })
    // Live campaigns first: a running campaign losing a trigger is a different
    // problem from a never-published one, whatever the location count says.
    .sort(
      (a, b) =>
        STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.locations.length - a.locations.length,
    );

  return {
    appName,
    analyzedAt: new Date().toISOString(),
    tags,
    campaigns: campaignImpacts,
    noCampaignReferences: tags
      .filter((t) => t.locations.length === 0)
      .map((t) => ({ tagId: t.tagId, tagName: t.tagName, group: t.group })),
    plannedDeletions: campaignImpacts.filter((c) => c.plannedDeletion).length,
    warnings,
  };
}
