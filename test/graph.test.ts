import { describe, expect, it } from 'vitest';
import type { EntityCatalogue } from '../src/api/catalogue.js';
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

const catalogue = (entities: EntityCatalogue['entities']): EntityCatalogue => ({
  appName: 'jordan',
  fetchedAt: '2026-08-06T00:00:00.000Z',
  sources: {},
  entities,
  warnings: [],
});

const taggedDecision = (tagId: string, label: string | null) => ({
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

const emailStep = (cellId: string, id: string) => ({
  ...makeNode({
    cellId,
    style: 'email',
    references: { tagIds: [], tagCategoryIds: [], marketingEmailId: id },
  }),
  position: 0,
});

describe('buildGraph with a catalogue', () => {
  it('labels entities from the catalogue', () => {
    const graph = buildGraph(
      [
        makeCampaign({
          funnelId: '16',
          sequences: [makeSequence({ steps: [applyStep('10', ['646']), emailStep('25', '1200')] })],
        }),
      ],
      catalogue([
        { id: 'tag:646', kind: 'tag', name: 'Bought', extra: {} },
        { id: 'email:1200', kind: 'email', name: 'Welcome 1', extra: { subject: 'Hello' } },
      ]),
    );
    expect(graph.entities.find((e) => e.id === 'tag:646')?.label).toBe('Bought');
    expect(graph.entities.find((e) => e.id === 'email:1200')?.label).toBe('Welcome 1');
  });

  it('prefers the catalogue name over a decision-criteria label, and warns on disagreement', () => {
    const graph = buildGraph(
      [
        makeCampaign({
          funnelId: '1',
          decisions: [
            makeDecision({
              cellId: '34',
              branches: [{ decisionId: '479', flowId: '3', rules: taggedDecision('346', 'Stale Name') }],
            }),
          ],
        }),
      ],
      catalogue([{ id: 'tag:346', kind: 'tag', name: 'Current Name', extra: {} }]),
    );
    expect(graph.entities.find((e) => e.id === 'tag:346')?.label).toBe('Current Name');
    expect(graph.warnings.some((w) => /tag:346.*Stale Name.*Current Name/.test(w))).toBe(true);
  });

  it('keeps the decision-criteria label for a tag the catalogue does not have', () => {
    const graph = buildGraph(
      [
        makeCampaign({
          funnelId: '1',
          decisions: [
            makeDecision({
              cellId: '34',
              branches: [{ decisionId: '479', flowId: '3', rules: taggedDecision('346', 'Only Name') }],
            }),
          ],
        }),
      ],
      catalogue([]),
    );
    expect(graph.entities.find((e) => e.id === 'tag:346')?.label).toBe('Only Name');
    expect(graph.warnings.filter((w) => /tag:346/.test(w))).toEqual([]);
  });

  it('never overwrites a campaign label with a catalogue entry', () => {
    // campaign.name comes from meta.json and is authoritative.
    const graph = buildGraph(
      [makeCampaign({ funnelId: '16', name: 'Real Campaign Name' })],
      catalogue([{ id: 'campaign:16', kind: 'campaign', name: 'API Name', extra: {} }]),
    );
    expect(graph.entities.find((e) => e.id === 'campaign:16')?.label).toBe('Real Campaign Name');
  });
});

describe('catalogue findings', () => {
  it('reports a referenced entity the catalogue does not contain', () => {
    // A campaign pointing at a deleted email is a broken campaign — but only
    // once the kind has proved comparable by matching at least one id.
    const graph = buildGraph(
      [
        makeCampaign({
          funnelId: '16',
          sequences: [makeSequence({ steps: [emailStep('25', '1200'), emailStep('26', '1300')] })],
        }),
      ],
      catalogue([
        { id: 'email:1300', kind: 'email', name: 'Still here', extra: {} },
        { id: 'email:9999', kind: 'email', name: 'Something else', extra: {} },
      ]),
    );
    expect(graph.findings.entitiesNotFound).toEqual(['email:1200']);
  });

  it('reports a catalogue entity nothing references', () => {
    const graph = buildGraph(
      [
        makeCampaign({
          funnelId: '16',
          sequences: [makeSequence({ steps: [applyStep('10', ['346'])] })],
        }),
      ],
      catalogue([
        { id: 'tag:346', kind: 'tag', name: 'In use', extra: {} },
        { id: 'tag:500', kind: 'tag', name: 'Unused', extra: {} },
      ]),
    );
    expect(graph.findings.unusedEntities).toEqual(['tag:500']);
  });

  it('leaves both empty when no catalogue was supplied', () => {
    // "not found" and "not looked up" are different claims.
    const graph = buildGraph([
      makeCampaign({
        funnelId: '16',
        sequences: [makeSequence({ steps: [emailStep('25', '1200')] })],
      }),
    ]);
    expect(graph.findings.entitiesNotFound).toEqual([]);
    expect(graph.findings.unusedEntities).toEqual([]);
  });

  it('never reports a campaign as not found', () => {
    // Campaigns come from the artifact directory, not the catalogue.
    const graph = buildGraph([makeCampaign({ funnelId: '16' })], catalogue([]));
    expect(graph.findings.entitiesNotFound).toEqual([]);
  });
});

describe('findings only claim what was actually looked up', () => {
  const webformGoal = (cellId: string, id: string) =>
    makeNode({
      cellId,
      style: 'newsletterRequest',
      references: { tagIds: [], tagCategoryIds: [], webformId: id },
    });

  it('never calls a reference broken for a kind the catalogue could not compare', () => {
    // Landing pages have no endpoint and the email template library shares no
    // id with any marketingEmailId. Reporting those as "broken" would claim the
    // campaigns point at deleted records, when nothing was ever looked up.
    const graph = buildGraph(
      [
        makeCampaign({
          funnelId: '16',
          goals: [webformGoal('2', '681')],
          sequences: [makeSequence({ steps: [emailStep('25', '1200')] })],
        }),
      ],
      // The catalogue covers webforms and matches one; it says nothing about
      // any email that this campaign references.
      catalogue([
        { id: 'webform:681', kind: 'webform', name: 'Signup', extra: {} },
        { id: 'email:150', kind: 'email', name: 'A template', extra: {} },
      ]),
    );
    expect(graph.findings.entitiesNotFound).toEqual([]);
    expect(graph.findings.unusedEntities).toEqual([]);
  });

  it('still reports a genuinely deleted entity for a kind that did compare', () => {
    const graph = buildGraph(
      [
        makeCampaign({
          funnelId: '16',
          goals: [webformGoal('2', '681'), webformGoal('3', '999')],
        }),
      ],
      catalogue([
        { id: 'webform:681', kind: 'webform', name: 'Signup', extra: {} },
        { id: 'webform:777', kind: 'webform', name: 'Never used', extra: {} },
      ]),
    );
    expect(graph.findings.entitiesNotFound).toEqual(['webform:999']);
    expect(graph.findings.unusedEntities).toEqual(['webform:777']);
  });
});
