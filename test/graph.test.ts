import { describe, expect, it } from 'vitest';
import { buildGraph } from '../src/normalize/graph.js';
import { makeCampaign, makeDecision, makeNode, makeSequence } from './fixtures/graphFixtures.js';

const applyStep = (cellId: string, tagIds: string[]) => ({
  ...makeNode({
    cellId,
    style: 'tag',
    config: { isApply: 'true' },
    references: { tagIds, tagCategoryIds: [] },
  }),
  position: 0,
});

const listenGoal = (cellId: string, tagIds: string[]) =>
  makeNode({ cellId, style: 'tagApplied', references: { tagIds, tagCategoryIds: [] } });

describe('buildGraph entities', () => {
  it('makes one entity per campaign, labelled with its name', () => {
    const graph = buildGraph([
      makeCampaign({ funnelId: '584', name: 'Satisfaction Survey' }),
      makeCampaign({ funnelId: '987', name: 'Newsletter' }),
    ]);
    expect(graph.entities.filter((e) => e.kind === 'campaign')).toEqual([
      { id: 'campaign:584', kind: 'campaign', label: 'Satisfaction Survey', campaignCount: 0 },
      { id: 'campaign:987', kind: 'campaign', label: 'Newsletter', campaignCount: 0 },
    ]);
  });

  it('counts how many campaigns touch a shared entity', () => {
    const emailStep = (cellId: string, id: string) => ({
      ...makeNode({
        cellId,
        style: 'email',
        references: { tagIds: [], tagCategoryIds: [], marketingEmailId: id },
      }),
      position: 0,
    });
    const graph = buildGraph([
      makeCampaign({ funnelId: '1', sequences: [makeSequence({ steps: [emailStep('9', '77')] })] }),
      makeCampaign({ funnelId: '2', sequences: [makeSequence({ steps: [emailStep('9', '77')] })] }),
    ]);
    expect(graph.entities.find((e) => e.id === 'email:77')?.campaignCount).toBe(2);
  });

  it('registers a tag known only by an undirected reference', () => {
    // 24 references across the corpus sit on goal styles that state no
    // direction. They earn no edge, but the tag is still in the account.
    const graph = buildGraph([
      makeCampaign({
        funnelId: '1',
        goals: [
          makeNode({
            cellId: '7',
            style: 'eventAttend',
            references: { tagIds: ['900'], tagCategoryIds: [] },
          }),
        ],
      }),
    ]);
    expect(graph.entities.find((e) => e.id === 'tag:900')).toEqual({
      id: 'tag:900',
      kind: 'tag',
      label: null,
      campaignCount: 0,
    });
    expect(graph.edges.filter((e) => e.to === 'tag:900')).toEqual([]);
  });

  it('sorts entities by kind then numerically by id', () => {
    const graph = buildGraph([
      makeCampaign({ funnelId: '100' }),
      makeCampaign({ funnelId: '9' }),
      makeCampaign({ funnelId: '20' }),
    ]);
    expect(graph.entities.map((e) => e.id)).toEqual(['campaign:9', 'campaign:20', 'campaign:100']);
  });

  it('drops a campaign with no funnelId, with a warning, rather than minting campaign:null', () => {
    const graph = buildGraph([makeCampaign({ funnelId: '1' }), makeCampaign({ funnelId: null })]);
    expect(graph.entities.map((e) => e.id)).toEqual(['campaign:1']);
    expect(graph.warnings.some((w) => /no funnelId/.test(w))).toBe(true);
  });

  it('throws when nothing usable was supplied, rather than returning an empty graph', () => {
    expect(() => buildGraph([])).toThrow(/no campaigns/i);
    expect(() => buildGraph([makeCampaign({ funnelId: null })])).toThrow(/no campaigns/i);
  });
});

describe('buildGraph edges', () => {
  it('collects every harvester into one edge list', () => {
    const graph = buildGraph([
      makeCampaign({
        funnelId: '16',
        goals: [listenGoal('4', ['346'])],
        sequences: [makeSequence({ steps: [applyStep('10', ['646'])] })],
      }),
    ]);
    expect(graph.edges).toContainEqual({
      from: 'campaign:16',
      to: 'tag:346',
      kind: 'listens-for',
      viaCellId: '4',
    });
    expect(graph.edges).toContainEqual({
      from: 'campaign:16',
      to: 'tag:646',
      kind: 'applies',
      viaCellId: '10',
    });
  });

  it('renders one warning per distinct reason, carrying the account-wide count', () => {
    const noteGoal = (cellId: string) =>
      makeNode({
        cellId,
        style: 'note',
        references: { tagIds: [], tagCategoryIds: [], marketingNoteId: '55' },
      });
    const graph = buildGraph([
      makeCampaign({ funnelId: '1', goals: [noteGoal('9')] }),
      makeCampaign({ funnelId: '2', goals: [noteGoal('9')] }),
    ]);
    const matched = graph.warnings.filter((w) => /marketingNoteId/.test(w));
    expect(matched).toHaveLength(1);
    expect(matched[0]).toMatch(/^2×/);
  });

  it('labels a tag from decision criteria wherever that tag appears', () => {
    const rules = {
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
                  values: [{ id: '346', label: 'Mastermind Registered' }],
                },
              ],
            },
          ],
        },
      ],
      elseOptions: [],
      elseSelected: null,
      warnings: [],
    };
    const graph = buildGraph([
      makeCampaign({
        funnelId: '1',
        decisions: [
          makeDecision({ cellId: '34', branches: [{ decisionId: '479', flowId: '3', rules }] }),
        ],
      }),
      makeCampaign({ funnelId: '2', goals: [listenGoal('4', ['346'])] }),
    ]);
    expect(graph.entities.find((e) => e.id === 'tag:346')?.label).toBe('Mastermind Registered');
  });
});

describe('derived triggers edges', () => {
  it('links an applier to a listener through the shared tag', () => {
    // The design's synthetic two-campaign case: A applies T, B listens for T.
    const graph = buildGraph([
      makeCampaign({
        funnelId: '16',
        sequences: [makeSequence({ steps: [applyStep('10', ['346'])] })],
      }),
      makeCampaign({ funnelId: '467', goals: [listenGoal('4', ['346'])] }),
    ]);
    const triggers = graph.edges.filter((e) => e.kind === 'triggers');
    expect(triggers).toEqual([
      {
        from: 'campaign:16',
        to: 'campaign:467',
        kind: 'triggers',
        viaTagId: '346',
        derived: true,
      },
    ]);
  });

  it('marks derived edges and leaves observed edges unmarked', () => {
    const graph = buildGraph([
      makeCampaign({
        funnelId: '16',
        sequences: [makeSequence({ steps: [applyStep('10', ['346'])] })],
      }),
      makeCampaign({ funnelId: '467', goals: [listenGoal('4', ['346'])] }),
    ]);
    expect(graph.edges.filter((e) => e.derived === true)).toHaveLength(1);
    expect(
      graph.edges.filter((e) => e.kind !== 'triggers').every((e) => e.derived === undefined),
    ).toBe(true);
  });

  it('keeps a self-trigger, because a campaign applying a tag it listens for is a real loop', () => {
    // 5 of the corpus's 9 triggers are self-loops.
    const graph = buildGraph([
      makeCampaign({
        funnelId: '594',
        goals: [listenGoal('4', ['610'])],
        sequences: [makeSequence({ steps: [applyStep('10', ['610'])] })],
      }),
    ]);
    expect(graph.edges.filter((e) => e.kind === 'triggers')).toEqual([
      {
        from: 'campaign:594',
        to: 'campaign:594',
        kind: 'triggers',
        viaTagId: '610',
        derived: true,
      },
    ]);
  });

  it('emits one triggers edge per applier-listener-tag triple', () => {
    const graph = buildGraph([
      makeCampaign({
        funnelId: '672',
        sequences: [makeSequence({ steps: [applyStep('10', ['646'])] })],
      }),
      makeCampaign({ funnelId: '670', goals: [listenGoal('4', ['646'])] }),
      makeCampaign({ funnelId: '674', goals: [listenGoal('4', ['646'])] }),
    ]);
    expect(
      graph.edges
        .filter((e) => e.kind === 'triggers')
        .map((e) => `${e.from}->${e.to}`)
        .sort(),
    ).toEqual(['campaign:672->campaign:670', 'campaign:672->campaign:674']);
  });

  it('derives nothing from a tag that is tested but never applied', () => {
    const graph = buildGraph([makeCampaign({ funnelId: '1', goals: [listenGoal('4', ['999'])] })]);
    expect(graph.edges.filter((e) => e.kind === 'triggers')).toEqual([]);
  });
});

describe('findings', () => {
  it('reports a campaign with no goals as unreachable', () => {
    const graph = buildGraph([makeCampaign({ funnelId: '1' })]);
    expect(graph.findings.unreachableCampaigns).toEqual([
      { campaignId: 'campaign:1', reason: 'no goals — nothing can enter this campaign' },
    ]);
  });

  it('reports a campaign whose only goals listen for tags nobody else applies', () => {
    const graph = buildGraph([
      makeCampaign({ funnelId: '557', goals: [listenGoal('4', ['624'])] }),
      makeCampaign({
        funnelId: '2',
        goals: [makeNode({ cellId: '9', style: 'newsletterRequest' })],
      }),
    ]);
    expect(graph.findings.unreachableCampaigns).toEqual([
      {
        campaignId: 'campaign:557',
        reason: 'every goal listens for a tag no other campaign applies',
      },
    ]);
  });

  it('does not call a campaign unreachable when another campaign applies its tag', () => {
    const graph = buildGraph([
      makeCampaign({ funnelId: '467', goals: [listenGoal('4', ['346'])] }),
      makeCampaign({
        funnelId: '16',
        sequences: [makeSequence({ steps: [applyStep('10', ['346'])] })],
      }),
    ]);
    expect(graph.findings.unreachableCampaigns.map((u) => u.campaignId)).toEqual(['campaign:16']);
  });

  it('does not let a campaign applying its own tag count as reachable', () => {
    const graph = buildGraph([
      makeCampaign({
        funnelId: '594',
        goals: [listenGoal('4', ['610'])],
        sequences: [makeSequence({ steps: [applyStep('10', ['610'])] })],
      }),
    ]);
    expect(graph.findings.unreachableCampaigns.map((u) => u.campaignId)).toEqual(['campaign:594']);
  });

  it('ignores a campaign with a non-tag goal', () => {
    const graph = buildGraph([
      makeCampaign({
        funnelId: '1',
        goals: [makeNode({ cellId: '2', style: 'newsletterRequest' }), listenGoal('4', ['999'])],
      }),
    ]);
    expect(graph.findings.unreachableCampaigns).toEqual([]);
  });

  it('separates tags nobody applies from tags nobody listens for', () => {
    const graph = buildGraph([
      makeCampaign({
        funnelId: '1',
        sequences: [makeSequence({ steps: [applyStep('10', ['500'])] })],
      }),
      makeCampaign({ funnelId: '2', goals: [listenGoal('4', ['600'])] }),
    ]);
    expect(graph.findings.tagsAppliedByNobody).toEqual(['tag:600']);
    expect(graph.findings.tagsNobodyListensFor).toEqual(['tag:500']);
  });

  it('reports an email used by more than one campaign', () => {
    const emailStep = (id: string) => ({
      ...makeNode({
        cellId: '9',
        style: 'email',
        references: { tagIds: [], tagCategoryIds: [], marketingEmailId: id },
      }),
      position: 0,
    });
    const graph = buildGraph([
      makeCampaign({ funnelId: '1', sequences: [makeSequence({ steps: [emailStep('77')] })] }),
      makeCampaign({ funnelId: '2', sequences: [makeSequence({ steps: [emailStep('77')] })] }),
      makeCampaign({ funnelId: '3', sequences: [makeSequence({ steps: [emailStep('88')] })] }),
    ]);
    expect(graph.findings.sharedEmails).toEqual([
      { emailId: 'email:77', campaigns: ['campaign:1', 'campaign:2'] },
    ]);
  });

  it('reports a tag applied by more than one campaign', () => {
    const graph = buildGraph([
      makeCampaign({
        funnelId: '137',
        sequences: [makeSequence({ steps: [applyStep('10', ['419'])] })],
      }),
      makeCampaign({
        funnelId: '321',
        sequences: [makeSequence({ steps: [applyStep('10', ['419'])] })],
      }),
      makeCampaign({
        funnelId: '999',
        sequences: [makeSequence({ steps: [applyStep('10', ['420'])] })],
      }),
    ]);
    expect(graph.findings.duplicateTagAppliers).toEqual([
      { tagId: 'tag:419', campaigns: ['campaign:137', 'campaign:321'] },
    ]);
  });
});
