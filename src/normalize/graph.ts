import type { EntityCatalogue } from '../api/catalogue.js';
import type { NormalizedCampaign } from './campaign.js';
import {
  type EdgeKind,
  type EntityKind,
  type GraphEdge,
  REFERENCE_EDGES,
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
  /**
   * Referenced by a step someone marked ready, but absent from the account —
   * genuine breakage worth chasing. Empty without a catalogue.
   */
  entitiesNotFound: string[];
  /**
   * Absent from the account and referenced only by steps nobody marked ready —
   * unfinished drafting rather than breakage. Empty without a catalogue.
   */
  entitiesNeverBuilt: string[];
  /** Catalogue entities nothing references — dead weight not to migrate. Empty without a catalogue. */
  unusedEntities: string[];
}

export interface AccountGraph {
  entities: GraphEntity[];
  edges: GraphEdge[];
  findings: GraphFindings;
  warnings: string[];
}

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

/** Sorts entity ids numerically within their kind, for stable output. */
function sortIds(ids: Iterable<string>): string[] {
  return [...ids].sort((a, b) => {
    const left = Number(a.slice(a.indexOf(':') + 1));
    const right = Number(b.slice(b.indexOf(':') + 1));
    if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/** Groups edges of one kind by target, collecting the campaigns on the other end. */
export function campaignsByTarget(edges: GraphEdge[], kind: EdgeKind): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.kind !== kind) continue;
    const campaigns = out.get(edge.to) ?? new Set<string>();
    campaigns.add(edge.from);
    out.set(edge.to, campaigns);
  }
  return out;
}

/**
 * The one computed edge kind: A triggers B when A applies a tag B listens for.
 *
 * Self-loops are kept. A campaign that applies a tag its own goal listens for
 * re-enters itself, which is real behaviour worth seeing rather than an
 * artefact to filter out — 5 of the corpus's 9 triggers are self-loops.
 */
export function triggerEdges(observed: GraphEdge[]): GraphEdge[] {
  const appliers = campaignsByTarget(observed, 'applies');
  const listeners = campaignsByTarget(observed, 'listens-for');
  const edges: GraphEdge[] = [];

  for (const [tagEntity, listening] of listeners) {
    const applying = appliers.get(tagEntity);
    if (applying === undefined) continue;
    const tagId = tagEntity.slice(tagEntity.indexOf(':') + 1);
    for (const applier of applying) {
      for (const listener of listening) {
        edges.push({
          from: applier,
          to: listener,
          kind: 'triggers',
          viaTagId: tagId,
          derived: true,
        });
      }
    }
  }

  return dedupeEdges(edges);
}

/**
 * The questions the graph exists to answer.
 *
 * `unreachableCampaigns` is the sharpest of them for the live-versus-dead
 * problem: a campaign whose only door is a tag goal, for a tag no OTHER
 * campaign applies, cannot be entered by the automation. A campaign applying a
 * tag it listens for does not save itself — the loop still needs an outside
 * first push — so self-application is excluded deliberately.
 */
export function computeFindings(
  usable: { campaign: NormalizedCampaign; from: string }[],
  edges: GraphEdge[],
  tagEntityIds: string[],
  catalogue?: EntityCatalogue,
): GraphFindings {
  const appliers = campaignsByTarget(edges, 'applies');
  const listeners = campaignsByTarget(edges, 'listens-for');
  const senders = campaignsByTarget(edges, 'sends');

  const unreachableCampaigns: { campaignId: string; reason: string }[] = [];
  for (const { campaign, from } of usable) {
    if (campaign.goals.length === 0) {
      unreachableCampaigns.push({
        campaignId: from,
        reason: 'no goals — nothing can enter this campaign',
      });
      continue;
    }
    if (!campaign.goals.every((goal) => goal.style === 'tagApplied')) continue;

    const enteredFromOutside = campaign.goals
      .flatMap((goal) => goal.references.tagIds)
      .some((tagId) => {
        const applying = appliers.get(entityId('tag', tagId));
        return applying !== undefined && [...applying].some((applier) => applier !== from);
      });
    if (!enteredFromOutside) {
      unreachableCampaigns.push({
        campaignId: from,
        reason: 'every goal listens for a tag no other campaign applies',
      });
    }
  }

  const withSeveral = (grouped: Map<string, Set<string>>): [string, string[]][] =>
    sortIds([...grouped.keys()])
      .filter((id) => (grouped.get(id)?.size ?? 0) > 1)
      .map((id) => [id, sortIds(grouped.get(id) ?? [])]);

  // Both are only meaningful against a catalogue: without one, "not found" and
  // "not looked up" are the same observation.
  //
  // That distinction also has to hold PER KIND. A kind the API could not serve
  // (landing pages have no endpoint) or whose ids live in a different space
  // from the ones campaigns reference (the email template library shares no id
  // with any marketingEmailId) yields no matches at all — and reporting its
  // every reference as "broken" would claim 310 campaigns point at deleted
  // records when the truth is that nothing was ever looked up. So a kind counts
  // only once it has proved comparable by matching at least one id.
  const catalogued = new Set((catalogue?.entities ?? []).map((entry) => entry.id));
  const referenced = new Set(edges.filter((edge) => !edge.derived).map((edge) => edge.to));

  const kindOfId = (id: string): string => id.slice(0, id.indexOf(':'));
  const comparable = new Set<string>();
  for (const id of referenced) {
    if (catalogued.has(id)) comparable.add(kindOfId(id));
  }

  const missing =
    catalogue === undefined
      ? []
      : [...referenced].filter(
          (id) => !id.startsWith('campaign:') && comparable.has(kindOfId(id)) && !catalogued.has(id),
        );

  // A missing entity means two different things depending on who pointed at it.
  // Referenced from a step someone marked ready, it is breakage: the operator
  // finished the work and the target has since gone. Referenced only from steps
  // nobody ever marked ready, it was most likely never created — which is also
  // why those campaigns were never published, since Keap's validator rejects
  // unfinished steps. Reporting both as "broken" would inflate the count with
  // abandoned drafting.
  const referencedByReady = new Set<string>();
  for (const { campaign } of usable) {
    for (const node of campaignNodes(campaign)) {
      if (node.ready !== true) continue;
      for (const tagId of node.references.tagIds) referencedByReady.add(entityId('tag', tagId));
      for (const [attribute, value] of Object.entries(node.references)) {
        if (attribute === 'tagIds' || attribute === 'tagCategoryIds') continue;
        if (typeof value !== 'string') continue;
        const mapping = REFERENCE_EDGES[attribute];
        if (mapping !== undefined) referencedByReady.add(entityId(mapping.kind, value));
      }
    }
  }

  const entitiesNotFound = sortIds(missing.filter((id) => referencedByReady.has(id)));
  const entitiesNeverBuilt = sortIds(missing.filter((id) => !referencedByReady.has(id)));

  const unusedEntities =
    catalogue === undefined
      ? []
      : sortIds(
          [...catalogued].filter((id) => comparable.has(kindOfId(id)) && !referenced.has(id)),
        );

  return {
    unreachableCampaigns,
    entitiesNotFound,
    entitiesNeverBuilt,
    unusedEntities,
    tagsAppliedByNobody: sortIds(tagEntityIds.filter((id) => !appliers.has(id))),
    tagsNobodyListensFor: sortIds(
      tagEntityIds.filter((id) => appliers.has(id) && !listeners.has(id)),
    ),
    sharedEmails: withSeveral(senders).map(([emailId, campaigns]) => ({ emailId, campaigns })),
    duplicateTagAppliers: withSeveral(appliers).map(([tagId, campaigns]) => ({ tagId, campaigns })),
  };
}

export function buildGraph(
  campaigns: NormalizedCampaign[],
  catalogue?: EntityCatalogue,
): AccountGraph {
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
  // Entity registration below is driven by `edges` alone: a triggers edge runs
  // campaign-to-campaign, and both endpoints are already registered.
  const derived = triggerEdges(edges);

  const labels = tagLabels(usable.map((entry) => entry.campaign));
  const entities = new Map<string, GraphEntity>();
  const touchedBy = new Map<string, Set<string>>();

  // Catalogue names win over decision-criteria labels: the criteria label is a
  // snapshot taken whenever that decision was last saved, while the catalogue is
  // what the account says today. Disagreement is worth seeing, though — six tags
  // in the corpus carry both, a free cross-check between two independent
  // sources, the same class of check that validated the 131-tag count.
  const catalogued = new Map((catalogue?.entities ?? []).map((entry) => [entry.id, entry]));

  // Decision criteria render a tag as "Category -> Name"; the API returns the
  // bare name. Verified against all six tags that carry both labels: five
  // differ only by that prefix, and treating them as conflicts would bury a
  // real drift under predictable noise.
  const labelsAgree = (criteria: string, api: string): boolean =>
    criteria === api || criteria.endsWith(` -> ${api}`);

  const labelFor = (id: string, fallback: string | null): string | null => {
    const record = catalogued.get(id);
    if (record?.name == null) return fallback;
    if (fallback !== null && !labelsAgree(fallback, record.name)) {
      warnings.push(
        `${id}: decision criteria say "${fallback}" but the catalogue says ` +
          `"${record.name}" — using the catalogue`,
      );
    }
    return record.name;
  };

  const register = (id: string, label: string | null): void => {
    if (!entities.has(id)) entities.set(id, { id, kind: kindOf(id), label, campaignCount: 0 });
  };

  for (const { campaign, from } of usable) register(from, campaign.name);

  for (const edge of edges) {
    const kind = kindOf(edge.to);
    register(
      edge.to,
      labelFor(edge.to, kind === 'tag' ? (labels.get(edge.to.slice(4)) ?? null) : null),
    );
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
        const id = entityId('tag', tagId);
        register(id, labelFor(id, labels.get(tagId) ?? null));
      }
    }
  }

  for (const entity of entities.values()) {
    entity.campaignCount = touchedBy.get(entity.id)?.size ?? 0;
  }

  for (const [reason, count] of Object.entries(tallies)) warnings.push(`${count}× ${reason}`);

  return {
    entities: [...entities.values()].sort(compareEntities),
    edges: [...edges, ...derived].sort(compareEdges),
    findings: computeFindings(
      usable,
      edges,
      [...entities.values()].filter((e) => e.kind === 'tag').map((e) => e.id),
      catalogue,
    ),
    warnings,
  };
}
