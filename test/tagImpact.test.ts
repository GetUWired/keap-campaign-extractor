import { describe, expect, it } from 'vitest';
import { analyzeTagImpact } from '../src/analyze/tagImpact.js';
import type { NormalizedCampaign } from '../src/normalize/campaign.js';
import type { CampaignSummary } from '../src/parse/campaignList.js';
import { buildGraph } from '../src/normalize/graph.js';
import { makeCampaign, makeDecision, makeNode, makeSequence } from './fixtures/graphFixtures.js';

const list = (tags: { id: string; name: string; group?: string | null }[]) => ({
  tags: tags.map((t) => ({ id: t.id, name: t.name, group: t.group ?? null })),
  warnings: [] as string[],
});

const tagStep = (cellId: string, tagIds: string[], isApply: string, name: string | null = null) => ({
  ...makeNode({
    cellId,
    style: 'tag',
    name,
    config: { isApply },
    references: { tagIds, tagCategoryIds: [] },
  }),
  position: 0,
});

const tagGoal = (cellId: string, tagIds: string[], name: string) =>
  makeNode({ cellId, style: 'tagApplied', name, references: { tagIds, tagCategoryIds: [] } });

const tagRules = (tagId: string, label: string) => ({
  decisionIds: ['479'],
  flowIds: ['3'],
  wrappers: [
    {
      index: 0,
      decisionId: '479',
      flowId: '3',
      primaryKey: null,
      secondaryKey: null,
      secondaryKeyId: null,
      any: [
        {
          groupId: '1',
          all: [
            {
              ruleId: '2',
              subject: null,
              subjectLabel: null,
              category: 'tags_FieldCategory',
              categoryLabel: null,
              field: null,
              fieldLabel: null,
              constraint: null,
              constraintLabel: null,
              values: [{ id: tagId, label }],
            },
          ],
        },
      ],
    },
  ],
  elseOptions: [],
  elseSelected: null,
  warnings: [],
});

describe('analyzeTagImpact — location kinds', () => {
  it('reads a tagApplied goal as a trigger', () => {
    const campaign = makeCampaign({
      funnelId: '16',
      name: 'Welcome',
      goals: [tagGoal('4', ['646'], 'Signed up')],
    });
    const report = analyzeTagImpact('x', list([{ id: '646', name: 'Bought' }]), [campaign], buildGraph([campaign]));
    expect(report.tags[0]?.locations).toEqual([
      {
        campaignId: '16',
        campaignName: 'Welcome',
        tagId: '646',
        tagName: 'Bought',
        group: null,
        kind: 'trigger',
        edgeKind: 'listens-for',
        cellId: '4',
        nodeName: 'Signed up',
      },
    ]);
  });

  it('reads an apply-tag step as a step, with its sequence and 1-based position', () => {
    const campaign = makeCampaign({
      funnelId: '16',
      name: 'Welcome',
      sequences: [
        makeSequence({
          cellId: '3',
          name: 'Onboarding',
          steps: [
            { ...makeNode({ cellId: '9', style: 'email' }), position: 0 },
            { ...tagStep('10', ['646'], 'true', 'Mark bought'), position: 1 },
          ],
        }),
      ],
    });
    const report = analyzeTagImpact('x', list([{ id: '646', name: 'Bought' }]), [campaign], buildGraph([campaign]));
    expect(report.tags[0]?.locations[0]).toMatchObject({
      kind: 'step',
      edgeKind: 'applies',
      sequenceName: 'Onboarding',
      stepPosition: 2,
      nodeName: 'Mark bought',
    });
  });

  it('distinguishes a remove-tag step from an apply', () => {
    const campaign = makeCampaign({
      funnelId: '16',
      sequences: [makeSequence({ cellId: '3', steps: [tagStep('10', ['646'], 'false')] })],
    });
    const report = analyzeTagImpact('x', list([{ id: '646', name: 'Bought' }]), [campaign], buildGraph([campaign]));
    expect(report.tags[0]?.locations[0]?.edgeKind).toBe('removes');
  });

  it('reads a decision that routes on the tag as a decision', () => {
    const campaign = makeCampaign({
      funnelId: '16',
      decisions: [
        makeDecision({
          cellId: '34',
          name: 'Has bought?',
          branches: [{ decisionId: '479', flowId: '3', rules: tagRules('646', 'Bought') }],
        }),
      ],
    });
    const report = analyzeTagImpact('x', list([{ id: '646', name: 'Bought' }]), [campaign], buildGraph([campaign]));
    expect(report.tags[0]?.locations[0]).toMatchObject({
      kind: 'decision',
      edgeKind: 'tests',
      cellId: '34',
      nodeName: 'Has bought?',
    });
  });

  it('never counts a derived triggers edge as a location', () => {
    // A triggers edge points campaign -> campaign, and merge consequences are
    // out of scope. It must not appear even though it exists in the graph.
    const applier = makeCampaign({
      funnelId: '1',
      sequences: [makeSequence({ cellId: '3', steps: [tagStep('10', ['646'], 'true')] })],
    });
    const listener = makeCampaign({ funnelId: '2', goals: [tagGoal('4', ['646'], 'Starts')] });
    const graph = buildGraph([applier, listener]);
    expect(graph.edges.some((e) => e.kind === 'triggers')).toBe(true);
    const report = analyzeTagImpact('x', list([{ id: '646', name: 'B' }]), [applier, listener], graph);
    expect(report.tags[0]?.locations.every((l) => l.edgeKind !== 'triggers')).toBe(true);
  });
});

describe('analyzeTagImpact — grouping and totals', () => {
  it('reports the same locations by tag and by campaign', () => {
    const campaign = makeCampaign({
      funnelId: '16',
      goals: [tagGoal('4', ['646'], 'A')],
      sequences: [makeSequence({ cellId: '3', steps: [tagStep('10', ['646'], 'true')] })],
    });
    const report = analyzeTagImpact('x', list([{ id: '646', name: 'B' }]), [campaign], buildGraph([campaign]));
    expect(report.tags[0]?.locations).toHaveLength(2);
    expect(report.campaigns[0]?.locations).toHaveLength(2);
    expect(report.tags[0]?.campaignCount).toBe(1);
  });

  it('lists a requested tag no campaign references, without calling it safe', () => {
    const campaign = makeCampaign({ funnelId: '16' });
    const report = analyzeTagImpact('x', list([{ id: '999', name: 'Unused' }]), [campaign], buildGraph([campaign]));
    expect(report.noCampaignReferences).toEqual([{ tagId: '999', tagName: 'Unused', group: null }]);
    expect(report.tags.find((t) => t.tagId === '999')?.locations).toEqual([]);
  });

  it('flags a campaign referencing two tags from one combine group', () => {
    const campaign = makeCampaign({
      funnelId: '16',
      sequences: [
        makeSequence({
          cellId: '3',
          steps: [tagStep('10', ['646'], 'true'), { ...tagStep('11', ['647'], 'true'), position: 1 }],
        }),
      ],
    });
    const report = analyzeTagImpact(
      'x',
      list([
        { id: '646', name: 'A', group: 'newsletter' },
        { id: '647', name: 'B', group: 'newsletter' },
      ]),
      [campaign],
      buildGraph([campaign]),
    );
    expect(report.campaigns[0]?.duplicatedGroups).toEqual([
      { group: 'newsletter', tagIds: ['646', '647'] },
    ]);
  });

  it('does not flag a campaign referencing one tag from a group', () => {
    const campaign = makeCampaign({
      funnelId: '16',
      sequences: [makeSequence({ cellId: '3', steps: [tagStep('10', ['646'], 'true')] })],
    });
    const report = analyzeTagImpact(
      'x',
      list([{ id: '646', name: 'A', group: 'newsletter' }]),
      [campaign],
      buildGraph([campaign]),
    );
    expect(report.campaigns[0]?.duplicatedGroups).toEqual([]);
  });

  it('warns about a campaign whose decision criteria are missing', () => {
    // 2 of 464 decisions in se232 have no criteria on disk. Any tag they route
    // on is invisible, so the report must say it cannot see everything.
    const campaign = makeCampaign({
      funnelId: '16',
      name: 'Has a blind decision',
      decisions: [makeDecision({ cellId: '34', branches: [{ decisionId: '1', flowId: '2', rules: null }] })],
    });
    const report = analyzeTagImpact('x', list([{ id: '646', name: 'B' }]), [campaign], buildGraph([campaign]));
    expect(report.warnings.some((w) => /16.*criteria/i.test(w))).toBe(true);
  });

  it("carries the list's own warnings through", () => {
    const campaign = makeCampaign({ funnelId: '16' });
    const report = analyzeTagImpact(
      'x',
      { tags: [], warnings: ['a row has no id and was skipped'] },
      [campaign],
      buildGraph([campaign]),
    );
    expect(report.warnings).toContain('a row has no id and was skipped');
  });
});

describe('naming an unnamed decision', () => {
  // Operators name goals and sequences but almost never the diamonds between
  // them, so "cell 1349" would be the only handle an operator got otherwise.
  const withEdges = (edges: { cellId: string; source: string; target: string; scope: string }[]) =>
    makeCampaign({
      funnelId: '11119',
      name: 'Trips',
      goals: [tagGoal('14', ['700'], 'Any purchase')],
      decisions: [
        makeDecision({
          cellId: '1349',
          name: null,
          branches: [{ decisionId: '479', flowId: '3', rules: tagRules('646', 'Bought') }],
        }),
      ],
      edges,
    });

  const decisionIn = (campaign: ReturnType<typeof withEdges>) =>
    analyzeTagImpact(
      'x',
      list([{ id: '646', name: 'Bought' }]),
      [campaign],
      buildGraph([campaign]),
    ).campaigns[0]?.locations.find((l) => l.kind === 'decision');

  it('locates it by whatever feeds it on the canvas', () => {
    const campaign = withEdges([{ cellId: '1350', source: '14', target: '1349', scope: '1' }]);
    expect(decisionIn(campaign)?.after).toBe('Any purchase');
  });

  it('leaves it unset when nothing named feeds the decision', () => {
    expect(decisionIn(withEdges([]))?.after).toBeUndefined();
  });
});

describe('campaign status', () => {
  // §14: publishXml answers "ever published", the campaign list answers "live
  // now". They disagree about 125 of se232's campaigns.
  const summary = (over: Partial<CampaignSummary> = {}): CampaignSummary => ({
    funnelId: '16',
    name: 'Welcome',
    categories: [],
    activeContacts: null,
    publishedDate: null,
    publishedBy: null,
    published: false,
    ...over,
  });

  const affected = (campaign: NormalizedCampaign, summaries: CampaignSummary[]) =>
    analyzeTagImpact(
      'x',
      list([{ id: '646', name: 'Bought' }]),
      [campaign],
      buildGraph([campaign]),
      summaries,
    ).campaigns[0];

  const campaign = (published: boolean) =>
    makeCampaign({ funnelId: '16', published, goals: [tagGoal('4', ['646'], 'Signed up')] });

  it('is live when the campaign list carries a published date', () => {
    const one = affected(campaign(true), [
      summary({ published: true, publishedDate: '8/5/2026 11:32 AM', activeContacts: 88 }),
    ]);
    expect(one?.status).toBe('live');
    expect(one?.activeContacts).toBe(88);
    expect(one?.publishedDate).toBe('8/5/2026 11:32 AM');
  });

  it('is stopped when it was published but the list shows no date', () => {
    expect(affected(campaign(true), [summary()])?.status).toBe('stopped');
  });

  it('is never-published when neither signal is present', () => {
    expect(affected(campaign(false), [summary()])?.status).toBe('never-published');
  });

  it('is unknown when no campaign list was supplied', () => {
    // An absent answer, not a reassuring one.
    expect(affected(campaign(true), [])?.status).toBe('unknown');
  });

  it('puts live campaigns first, ahead of bigger never-published ones', () => {
    const live = makeCampaign({
      funnelId: '16',
      published: true,
      goals: [tagGoal('4', ['646'], 'Signed up')],
    });
    const dead = makeCampaign({
      funnelId: '17',
      published: false,
      goals: [tagGoal('4', ['646'], 'A'), tagGoal('5', ['646'], 'B')],
    });
    const report = analyzeTagImpact(
      'x',
      list([{ id: '646', name: 'Bought' }]),
      [live, dead],
      buildGraph([live, dead]),
      [summary({ funnelId: '16', published: true }), summary({ funnelId: '17' })],
    );
    expect(report.campaigns.map((c) => c.campaignId)).toEqual(['16', '17']);
    expect(report.campaigns[1]?.locations.length).toBeGreaterThan(
      report.campaigns[0]?.locations.length ?? 0,
    );
  });
});

describe('campaigns the operator plans to delete', () => {
  const campaignWith = (funnelId: string) =>
    makeCampaign({ funnelId, published: true, goals: [tagGoal('4', ['646'], 'Signed up')] });

  const run = (deleting: string[]) => {
    const a = campaignWith('16');
    const b = campaignWith('17');
    return analyzeTagImpact(
      'x',
      list([{ id: '646', name: 'Bought' }]),
      [a, b],
      buildGraph([a, b]),
      [],
      deleting,
    );
  };

  it('marks an affected campaign that is itself being deleted', () => {
    const report = run(['16']);
    const marked = report.campaigns.filter((c) => c.plannedDeletion).map((c) => c.campaignId);
    expect(marked).toEqual(['16']);
    expect(report.plannedDeletions).toBe(1);
  });

  it('marks nothing when no list is supplied', () => {
    const report = run([]);
    expect(report.campaigns.every((c) => !c.plannedDeletion)).toBe(true);
    expect(report.plannedDeletions).toBe(0);
  });

  it('still reports the campaign, because deletion is a plan and not a fact', () => {
    // Hiding it would make the report disagree with the account as it stands.
    expect(run(['16']).campaigns.map((c) => c.campaignId).sort()).toEqual(['16', '17']);
  });

  it('warns about an id that is not in the account, which is usually a typo', () => {
    const report = run(['99999']);
    expect(report.warnings.some((w) => /99999.*not in this account/i.test(w))).toBe(true);
    expect(report.plannedDeletions).toBe(0);
  });
});
