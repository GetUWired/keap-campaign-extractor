import type { RuleValue } from '../parse/decisionHtml.js';
import type { NormalizedCampaign } from './campaign.js';
import { type NormalizedNode, referenceValues } from './nodes.js';

export type EntityKind =
  | 'campaign'
  | 'tag'
  | 'email'
  | 'webform'
  | 'landingPage'
  | 'product'
  | 'form'
  | 'user';

export type EdgeKind =
  | 'applies'
  | 'removes'
  | 'listens-for'
  | 'tests'
  | 'sends'
  | 'entry-point'
  | 'references-campaign'
  | 'assigned-to'
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

/**
 * Keap's category value for a tag rule.
 *
 * Measured, not guessed: the category values across the corpus are
 * formSubmissionOptions_FieldCategory (204), tags_FieldCategory (110),
 * customFieldGroup1_FieldCategory (39), customFieldGroup7_FieldCategory (11)
 * and contact.contactFields_FieldCategory (4). A parser looking for "Tag"
 * would find nothing and report it as a campaign with no tag decisions.
 */
export const TAG_RULE_CATEGORY = 'tags_FieldCategory';

/**
 * Visits every tag-category rule value on a campaign's decisions.
 *
 * Once per decision, NOT once per branch: normalizeCampaign attaches the same
 * DecisionCriteria object to every branch of a decision, so walking branches
 * multiplies each rule by the branch count.
 */
export function eachDecisionTagValue(
  campaign: NormalizedCampaign,
  visit: (value: RuleValue, decisionCellId: string) => void,
): { decisionsWithoutCriteria: number } {
  let decisionsWithoutCriteria = 0;

  for (const decision of campaign.decisions) {
    const rules = decision.branches.find((branch) => branch.rules !== null)?.rules ?? null;
    if (rules === null) {
      decisionsWithoutCriteria++;
      continue;
    }
    for (const wrapper of rules.wrappers) {
      for (const group of wrapper.any) {
        for (const rule of group.all) {
          if (rule.category !== TAG_RULE_CATEGORY) continue;
          for (const value of rule.values) visit(value, decision.cellId);
        }
      }
    }
  }

  return { decisionsWithoutCriteria };
}

/**
 * Harvests `tests` edges: a campaign tests a tag when a decision branches on it.
 *
 * A decision that routes on a tag is an edge the graph would otherwise miss
 * entirely — 11 tags in the corpus appear nowhere except decision criteria.
 */
export function decisionTagEdges(campaign: NormalizedCampaign, from: string): EdgeHarvest {
  const edges: GraphEdge[] = [];
  const tallies: Record<string, number> = {};

  const { decisionsWithoutCriteria } = eachDecisionTagValue(campaign, (value, decisionCellId) => {
    edges.push({ from, to: entityId('tag', value.id), kind: 'tests', viaCellId: decisionCellId });
  });

  if (decisionsWithoutCriteria > 0) {
    tallies['decisions have no criteria on disk — any tags they route on are invisible'] =
      decisionsWithoutCriteria;
  }

  return { edges, tallies };
}

/**
 * Tag display names, keyed by tag id.
 *
 * Decision criteria are the ONLY place a display name appears anywhere in the
 * extracted data — the `_text` companion input beside a rule value. Everything
 * else is bare ids until stage 3 resolves them through the REST API.
 */
export function tagLabels(campaigns: NormalizedCampaign[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const campaign of campaigns) {
    eachDecisionTagValue(campaign, (value) => {
      if (value.label !== null && !labels.has(value.id)) labels.set(value.id, value.label);
    });
  }
  return labels;
}

/**
 * The lifted foreign keys that have a place in the graph's entity vocabulary.
 *
 * `nodes.ts` lifts 20 foreign-key attributes; these seven are the ones the
 * EntityKind values can express. The other thirteen — marketingNoteId (94 in
 * the corpus), fileBoxId (43), stageId (37), roundRobinId, eventId,
 * marketingFulfillmentId, actionSetId, marketingLetterId, fieldValueFileBoxId,
 * confirmLinkId, voiceBroadcastId, marketingFaxId, createOrderConfigId — are
 * tallied so the warnings say plainly what the graph is not modelling. They
 * remain in the normalised files, so widening this table later costs a re-run
 * and nothing else.
 *
 * roundRobinId is deliberately absent despite being assignment-adjacent: a
 * round-robin is a rule for picking a user, not a user.
 */
export const REFERENCE_EDGES: Record<string, { kind: EntityKind; edge: EdgeKind }> = {
  marketingEmailId: { kind: 'email', edge: 'sends' },
  webformId: { kind: 'webform', edge: 'entry-point' },
  landingPageId: { kind: 'landingPage', edge: 'entry-point' },
  purchaseId: { kind: 'product', edge: 'entry-point' },
  internalFormId: { kind: 'form', edge: 'entry-point' },
  userId: { kind: 'user', edge: 'assigned-to' },
  sourceFunnelId: { kind: 'campaign', edge: 'references-campaign' },
};

/** Harvests edges from the foreign keys `nodes.ts` lifted onto each node. */
export function referenceEdges(campaign: NormalizedCampaign, from: string): EdgeHarvest {
  const edges: GraphEdge[] = [];
  const tallies: Record<string, number> = {};

  for (const node of campaignNodes(campaign)) {
    for (const attribute of Object.keys(node.references)) {
      // tagIds and tagCategoryIds are the two array-valued members of
      // NodeReferences; tags are tagEdges' business, not this function's.
      if (attribute === 'tagIds' || attribute === 'tagCategoryIds') continue;

      // One edge per value: a purchase goal can name several products, and
      // reading only the scalar form once hid 390 of them.
      const values = referenceValues(node.references, attribute);
      if (values.length === 0) continue;

      const mapping = REFERENCE_EDGES[attribute];
      if (mapping === undefined) {
        const reason = `reference attribute "${attribute}" has no entity kind`;
        tallies[reason] = (tallies[reason] ?? 0) + values.length;
        continue;
      }

      for (const value of values) {
        edges.push({
          from,
          to: entityId(mapping.kind, value),
          kind: mapping.edge,
          viaCellId: node.cellId,
        });
      }
    }
  }

  return { edges, tallies };
}
