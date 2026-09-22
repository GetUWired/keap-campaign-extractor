import type { NormalizedCampaign } from '../normalize/campaign.js';
import type { AccountGraph } from '../normalize/graph.js';
import type { CampaignSummary } from '../parse/campaignList.js';
import { type LocationKind, placeCell } from './locate.js';
import { type CampaignStatus, STATUS_RANK, campaignStatus } from './tagImpact.js';

/**
 * References to things the account no longer has.
 *
 * Every other report in this project answers "what would a planned change
 * break". This one answers "what is already broken" — campaign steps, goals and
 * decisions pointing at tags, products and forms that have since been deleted.
 * Keap removes the entity and leaves the reference behind.
 */

/**
 * Whether the reference is breakage or unfinished drafting.
 *
 * `ready` means a step someone marked ready points at a missing entity — the
 * operator considered that step finished. `never-built` means only unready
 * steps reference it, which is a half-built campaign rather than a fault.
 * Collapsing the two would turn 86 drafts into 86 emergencies.
 */
export type RefSeverity = 'ready' | 'never-built';

export interface BrokenLocation {
  /**
   * Which missing entity this location points at.
   *
   * Carried rather than looked up: 246 of se232's locations reference more than
   * one missing entity — a single step applying two deleted tags — so a map
   * keyed by campaign, cell and edge silently keeps only the last.
   */
  entityId: string;
  campaignId: string;
  campaignName: string | null;
  status: CampaignStatus;
  activeContacts: number | null;
  /** trigger, decision or step — or `other` for a reference that is none of those. */
  kind: LocationKind | 'other';
  /** The graph edge: listens-for, tests, applies, removes, entry-point, sends… */
  edgeKind: string;
  cellId: string;
  sequenceName?: string;
  stepPosition?: number;
  nodeName?: string | null;
  after?: string;
}

export interface BrokenReference {
  /** The graph id, e.g. "tag:417". */
  entityId: string;
  kind: string;
  entityRef: string;
  /** Known only when a campaign recorded it — a deleted entity has no other name. */
  name: string | null;
  severity: RefSeverity;
  locations: BrokenLocation[];
}

export interface BrokenCampaign {
  campaignId: string;
  campaignName: string | null;
  status: CampaignStatus;
  activeContacts: number | null;
  locations: BrokenLocation[];
  /**
   * Every one of this campaign's tag triggers points at a missing tag, so
   * nothing can enrol through them.
   */
  allTriggersBroken: boolean;
}

export interface BrokenRefsReport {
  appName: string;
  analyzedAt: string;
  /** False when the account's entity catalog was missing, which makes every count meaningless. */
  catalogPresent: boolean;
  references: BrokenReference[];
  campaigns: BrokenCampaign[];
  counts: {
    references: number;
    readyReferences: number;
    neverBuiltReferences: number;
    locations: number;
    campaigns: number;
    liveCampaigns: number;
    byKind: Record<string, number>;
    byLocationKind: Record<string, number>;
  };
  warnings: string[];
}

/** Which of the three location kinds an edge represents, if any. */
const LOCATION_KIND: Record<string, LocationKind> = {
  'listens-for': 'trigger',
  tests: 'decision',
  applies: 'step',
  removes: 'step',
};

export function analyzeBrokenReferences(
  appName: string,
  campaigns: NormalizedCampaign[],
  graph: AccountGraph,
  summaries: CampaignSummary[] = [],
): BrokenRefsReport {
  const warnings: string[] = [];
  const notFound = new Set(graph.findings.entitiesNotFound);
  const neverBuilt = new Set(graph.findings.entitiesNeverBuilt);
  const missing = new Set([...notFound, ...neverBuilt]);

  // Both findings are empty without a catalog to compare against, which reads
  // identically to a clean account. Say which one it is.
  const catalogPresent = missing.size > 0 || graph.findings.unusedEntities.length > 0;
  if (!catalogPresent) {
    warnings.push(
      'the graph holds no catalog comparison, so nothing can be reported as missing — ' +
        'run enrich, then normalize again',
    );
  }

  const byId = new Map(campaigns.map((c) => [c.funnelId ?? '', c]));
  const summaryById = new Map(summaries.map((s) => [s.funnelId, s]));
  const labels = new Map(graph.entities.map((e) => [e.id, e.label ?? null]));

  const statusOf = (campaign: NormalizedCampaign | undefined, campaignId: string) =>
    campaign === undefined ? 'unknown' : campaignStatus(campaign, summaryById.get(campaignId));

  const byEntity = new Map<string, BrokenLocation[]>();
  const byCampaign = new Map<string, BrokenLocation[]>();
  // Every tag trigger per campaign, so a campaign with no way in can be named.
  const triggers = new Map<string, { cellId: string; entityId: string }[]>();

  for (const edge of graph.edges) {
    if (edge.derived === true) continue;
    if (!edge.from.startsWith('campaign:')) continue;
    const campaignId = edge.from.slice('campaign:'.length);

    if (edge.kind === 'listens-for') {
      const seen = triggers.get(campaignId) ?? [];
      seen.push({ cellId: edge.viaCellId ?? '', entityId: edge.to });
      triggers.set(campaignId, seen);
    }

    if (!missing.has(edge.to)) continue;
    const campaign = byId.get(campaignId);
    if (campaign === undefined) continue;

    const fallback = LOCATION_KIND[edge.kind];
    const placement = placeCell(campaign, edge.viaCellId ?? '', fallback ?? 'step');
    const summary = summaryById.get(campaignId);
    const location: BrokenLocation = {
      entityId: edge.to,
      campaignId,
      campaignName: campaign.name,
      status: statusOf(campaign, campaignId),
      activeContacts: summary?.activeContacts ?? null,
      // An edge that is not one of the three is still a reference — a goal
      // pointing at a deleted web form, say — and saying `other` is honest
      // where forcing it into "step" would not be.
      kind: fallback === undefined && placement.kind === 'step' ? 'other' : placement.kind,
      edgeKind: edge.kind,
      cellId: edge.viaCellId ?? '',
      nodeName: placement.nodeName,
    };
    if (placement.sequenceName !== undefined) location.sequenceName = placement.sequenceName;
    if (placement.stepPosition !== undefined) location.stepPosition = placement.stepPosition;
    if (placement.after !== undefined) location.after = placement.after;

    byEntity.set(edge.to, [...(byEntity.get(edge.to) ?? []), location]);
    byCampaign.set(campaignId, [...(byCampaign.get(campaignId) ?? []), location]);
  }

  const references: BrokenReference[] = [...byEntity.entries()]
    .map(([entityId, locations]) => ({
      entityId,
      kind: entityId.slice(0, entityId.indexOf(':')),
      entityRef: entityId.slice(entityId.indexOf(':') + 1),
      name: labels.get(entityId) ?? null,
      severity: (notFound.has(entityId) ? 'ready' : 'never-built') as RefSeverity,
      locations,
    }))
    .sort((a, b) => b.locations.length - a.locations.length);

  const campaignRows: BrokenCampaign[] = [...byCampaign.entries()]
    .map(([campaignId, locations]) => {
      const campaign = byId.get(campaignId);
      const summary = summaryById.get(campaignId);
      const listensFor = triggers.get(campaignId) ?? [];
      return {
        campaignId,
        campaignName: campaign?.name ?? null,
        status: statusOf(campaign, campaignId),
        activeContacts: summary?.activeContacts ?? null,
        locations,
        allTriggersBroken:
          listensFor.length > 0 && listensFor.every((t) => missing.has(t.entityId)),
      };
    })
    .sort(
      (a, b) =>
        Number(b.allTriggersBroken) - Number(a.allTriggersBroken) ||
        STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
        b.locations.length - a.locations.length,
    );

  const byKind: Record<string, number> = {};
  for (const reference of references) byKind[reference.kind] = (byKind[reference.kind] ?? 0) + 1;
  const byLocationKind: Record<string, number> = {};
  for (const row of campaignRows) {
    for (const location of row.locations) {
      byLocationKind[location.kind] = (byLocationKind[location.kind] ?? 0) + 1;
    }
  }

  return {
    appName,
    analyzedAt: new Date().toISOString(),
    catalogPresent,
    references,
    campaigns: campaignRows,
    counts: {
      references: references.length,
      readyReferences: references.filter((r) => r.severity === 'ready').length,
      neverBuiltReferences: references.filter((r) => r.severity === 'never-built').length,
      locations: campaignRows.reduce((n, c) => n + c.locations.length, 0),
      campaigns: campaignRows.length,
      liveCampaigns: campaignRows.filter((c) => c.status === 'live').length,
      byKind,
      byLocationKind,
    },
    warnings,
  };
}
