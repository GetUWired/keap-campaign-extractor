import type { NormalizedCampaign } from '../normalize/campaign.js';

export type LocationKind = 'trigger' | 'step' | 'decision';

export interface Placement {
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
export function placeCell(campaign: NormalizedCampaign, cellId: string, fallback: LocationKind): Placement {
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

