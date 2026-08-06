import type {
  NormalizedCampaign,
  NormalizedDecision,
  NormalizedSequence,
} from '../../src/normalize/campaign.js';
import type { NormalizedNode } from '../../src/normalize/nodes.js';

/** A node with everything blank, so a test states only what it is about. */
export function makeNode(overrides: Partial<NormalizedNode> = {}): NormalizedNode {
  return {
    cellId: '1',
    style: 'email',
    metaType: null,
    parent: '1',
    name: null,
    ready: null,
    published: null,
    config: {},
    lists: {},
    objectLists: {},
    references: { tagIds: [], tagCategoryIds: [] },
    ...overrides,
  };
}

export function makeSequence(overrides: Partial<NormalizedSequence> = {}): NormalizedSequence {
  return {
    ...makeNode({ style: 'flow' }),
    flowType: null,
    steps: [],
    orderVerified: true,
    ...overrides,
  };
}

export function makeDecision(overrides: Partial<NormalizedDecision> = {}): NormalizedDecision {
  return { ...makeNode({ style: 'decision' }), branches: [], ...overrides };
}

export function makeCampaign(overrides: Partial<NormalizedCampaign> = {}): NormalizedCampaign {
  return {
    funnelId: '1',
    appName: 'jordan',
    name: null,
    published: false,
    hasUnpublishedChanges: false,
    goals: [],
    sequences: [],
    decisions: [],
    notes: [],
    edges: [],
    orphans: [],
    unconfigured: [],
    styleCounts: {},
    warnings: [],
    ...overrides,
  };
}
