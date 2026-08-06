import { describe, expect, it } from 'vitest';
import {
  campaignNodes,
  decisionTagEdges,
  dedupeEdges,
  entityId,
  mergeTallies,
  referenceEdges,
  tagEdges,
  tagLabels,
} from '../src/normalize/graphEdges.js';
import { makeCampaign, makeDecision, makeNode, makeSequence } from './fixtures/graphFixtures.js';

describe('entityId', () => {
  it('namespaces an id by its kind', () => {
    expect(entityId('tag', '646')).toBe('tag:646');
    expect(entityId('campaign', '987')).toBe('campaign:987');
  });
});

describe('campaignNodes', () => {
  it('flattens goals, decisions, notes, sequences and nested steps', () => {
    const campaign = makeCampaign({
      goals: [makeNode({ cellId: 'g1', style: 'tagApplied' })],
      decisions: [makeDecision({ cellId: 'd1' })],
      notes: [makeNode({ cellId: 'n1', style: 'notes' })],
      sequences: [
        makeSequence({
          cellId: 'f1',
          steps: [
            { ...makeNode({ cellId: 's1', style: 'tag' }), position: 0 },
            { ...makeNode({ cellId: 's2', style: 'email' }), position: 1 },
          ],
        }),
      ],
    });
    expect(campaignNodes(campaign).map((n) => n.cellId)).toEqual([
      'g1',
      'd1',
      'n1',
      'f1',
      's1',
      's2',
    ]);
  });

  it('returns an empty list for an empty campaign', () => {
    expect(campaignNodes(makeCampaign())).toEqual([]);
  });
});

describe('mergeTallies', () => {
  it('sums counts per key across campaigns', () => {
    const total: Record<string, number> = { a: 1 };
    mergeTallies(total, { a: 2, b: 5 });
    mergeTallies(total, { b: 1 });
    expect(total).toEqual({ a: 3, b: 6 });
  });
});

describe('dedupeEdges', () => {
  it('drops edges identical in from, to, kind and provenance', () => {
    const edge = { from: 'campaign:1', to: 'tag:5', kind: 'tests' as const, viaCellId: '9' };
    expect(dedupeEdges([edge, { ...edge }, { ...edge, viaCellId: '10' }])).toHaveLength(2);
  });

  it('keeps the same pair when the kind differs', () => {
    const base = { from: 'campaign:1', to: 'tag:5', viaCellId: '9' };
    const deduped = dedupeEdges([
      { ...base, kind: 'applies' as const },
      { ...base, kind: 'removes' as const },
    ]);
    expect(deduped).toHaveLength(2);
  });
});

describe('tagEdges', () => {
  const tagStep = (cellId: string, isApply: string | undefined, tagIds: string[]) =>
    makeNode({
      cellId,
      style: 'tag',
      config: isApply === undefined ? {} : { isApply },
      references: { tagIds, tagCategoryIds: [] },
    });

  it('reads direction from isApply', () => {
    const campaign = makeCampaign({
      sequences: [
        makeSequence({
          steps: [
            { ...tagStep('10', 'true', ['646']), position: 0 },
            { ...tagStep('11', 'false', ['647']), position: 1 },
          ],
        }),
      ],
    });
    expect(tagEdges(campaign, 'campaign:987').edges).toEqual([
      { from: 'campaign:987', to: 'tag:646', kind: 'applies', viaCellId: '10' },
      { from: 'campaign:987', to: 'tag:647', kind: 'removes', viaCellId: '11' },
    ]);
  });

  it('emits one edge per tag on a step carrying several', () => {
    const campaign = makeCampaign({
      sequences: [makeSequence({ steps: [{ ...tagStep('10', 'true', ['1', '2']), position: 0 }] })],
    });
    expect(tagEdges(campaign, 'campaign:1').edges.map((e) => e.to)).toEqual(['tag:1', 'tag:2']);
  });

  it('reads a tagApplied goal as listens-for', () => {
    const campaign = makeCampaign({
      goals: [
        makeNode({
          cellId: '4',
          style: 'tagApplied',
          references: { tagIds: ['346'], tagCategoryIds: [] },
        }),
      ],
    });
    expect(tagEdges(campaign, 'campaign:16').edges).toEqual([
      { from: 'campaign:16', to: 'tag:346', kind: 'listens-for', viaCellId: '4' },
    ]);
  });

  it('emits no edge for a tag step with no isApply, and tallies it', () => {
    const campaign = makeCampaign({
      sequences: [makeSequence({ steps: [{ ...tagStep('10', undefined, ['646']), position: 0 }] })],
    });
    const harvest = tagEdges(campaign, 'campaign:1');
    expect(harvest.edges).toEqual([]);
    expect(Object.values(harvest.tallies)).toEqual([1]);
    expect(Object.keys(harvest.tallies)[0]).toMatch(/direction/i);
  });

  it('emits no edge for tagIds on a goal style that does not state a direction', () => {
    // Measured: 24 such references across the corpus, on eventAttend, goal,
    // newsletterRequest, purchaseSuccess, indicateInterest, requestInfo and
    // eventRequest. The tag is real; what the campaign does with it is not stated.
    const campaign = makeCampaign({
      goals: [
        makeNode({
          cellId: '7',
          style: 'eventAttend',
          references: { tagIds: ['900', '901'], tagCategoryIds: [] },
        }),
      ],
    });
    const harvest = tagEdges(campaign, 'campaign:1');
    expect(harvest.edges).toEqual([]);
    expect(harvest.tallies['tagIds on "eventAttend" nodes state no apply/remove direction']).toBe(2);
  });

  it('ignores nodes with no tags at all', () => {
    const campaign = makeCampaign({
      goals: [makeNode({ cellId: '1', style: 'newsletterRequest' })],
    });
    expect(tagEdges(campaign, 'campaign:1')).toEqual({ edges: [], tallies: {} });
  });
});

describe('decisionTagEdges', () => {
  const criteria = (category: string, values: { id: string; label: string | null }[]) => ({
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
            groupId: '1499',
            all: [
              {
                ruleId: '561',
                subject: null,
                subjectLabel: null,
                category,
                categoryLabel: null,
                field: null,
                fieldLabel: null,
                constraint: null,
                constraintLabel: null,
                values,
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

  it('emits a tests edge per tag value', () => {
    const rules = criteria('tags_FieldCategory', [{ id: '1123', label: 'Bought' }]);
    const campaign = makeCampaign({
      decisions: [
        makeDecision({ cellId: '34', branches: [{ decisionId: '479', flowId: '3', rules }] }),
      ],
    });
    expect(decisionTagEdges(campaign, 'campaign:987').edges).toEqual([
      { from: 'campaign:987', to: 'tag:1123', kind: 'tests', viaCellId: '34' },
    ]);
  });

  it('reads a decision once even though every branch carries the same rules object', () => {
    // normalizeCampaign attaches criteriaByCellId[cellId] to EVERY branch, so
    // iterating branches would count each rule once per branch.
    const rules = criteria('tags_FieldCategory', [{ id: '1123', label: null }]);
    const campaign = makeCampaign({
      decisions: [
        makeDecision({
          cellId: '34',
          branches: [
            { decisionId: '479', flowId: '3', rules },
            { decisionId: '481', flowId: '32', rules },
          ],
        }),
      ],
    });
    expect(decisionTagEdges(campaign, 'campaign:987').edges).toHaveLength(1);
  });

  it('ignores rules in a non-tag category', () => {
    const rules = criteria('formSubmissionOptions_FieldCategory', [{ id: '3780', label: null }]);
    const campaign = makeCampaign({
      decisions: [
        makeDecision({ cellId: '13', branches: [{ decisionId: '1', flowId: '2', rules }] }),
      ],
    });
    expect(decisionTagEdges(campaign, 'campaign:584').edges).toEqual([]);
  });

  it('tallies a decision with no branches rather than throwing', () => {
    // 11 of 85 decisions in the corpus are unconfigured diamonds with no branches.
    const campaign = makeCampaign({ decisions: [makeDecision({ cellId: '141', branches: [] })] });
    const harvest = decisionTagEdges(campaign, 'campaign:211');
    expect(harvest.edges).toEqual([]);
    expect(Object.values(harvest.tallies)).toEqual([1]);
  });

  it('tallies a decision whose criteria file was never fetched', () => {
    const campaign = makeCampaign({
      decisions: [
        makeDecision({ cellId: '34', branches: [{ decisionId: '479', flowId: '3', rules: null }] }),
      ],
    });
    expect(Object.values(decisionTagEdges(campaign, 'campaign:1').tallies)).toEqual([1]);
  });

  describe('tagLabels', () => {
    it('collects display names from tag rule values', () => {
      const rules = criteria('tags_FieldCategory', [
        { id: '346', label: 'JordanHatch.com -> Mastermind Panels Registered' },
        { id: '999', label: null },
      ]);
      const campaign = makeCampaign({
        decisions: [
          makeDecision({ cellId: '34', branches: [{ decisionId: '1', flowId: '2', rules }] }),
        ],
      });
      const labels = tagLabels([campaign]);
      expect(labels.get('346')).toBe('JordanHatch.com -> Mastermind Panels Registered');
      expect(labels.has('999')).toBe(false);
    });
  });
});

describe('referenceEdges', () => {
  it('maps each lifted foreign key to its entity kind and edge kind', () => {
    const campaign = makeCampaign({
      goals: [
        makeNode({
          cellId: '2',
          style: 'newsletterRequest',
          references: { tagIds: [], tagCategoryIds: [], webformId: '681' },
        }),
        makeNode({
          cellId: '5',
          style: 'landingPage',
          references: { tagIds: [], tagCategoryIds: [], landingPageId: '42' },
        }),
        makeNode({
          cellId: '6',
          style: 'purchaseSuccess',
          references: { tagIds: [], tagCategoryIds: [], purchaseId: '7' },
        }),
        makeNode({
          cellId: '8',
          style: 'internalForm',
          references: { tagIds: [], tagCategoryIds: [], internalFormId: '3' },
        }),
      ],
      sequences: [
        makeSequence({
          steps: [
            {
              ...makeNode({
                cellId: '25',
                style: 'email',
                references: { tagIds: [], tagCategoryIds: [], marketingEmailId: '1200' },
              }),
              position: 0,
            },
          ],
        }),
      ],
    });
    expect(referenceEdges(campaign, 'campaign:987').edges).toEqual([
      { from: 'campaign:987', to: 'webform:681', kind: 'entry-point', viaCellId: '2' },
      { from: 'campaign:987', to: 'landingPage:42', kind: 'entry-point', viaCellId: '5' },
      { from: 'campaign:987', to: 'product:7', kind: 'entry-point', viaCellId: '6' },
      { from: 'campaign:987', to: 'form:3', kind: 'entry-point', viaCellId: '8' },
      { from: 'campaign:987', to: 'email:1200', kind: 'sends', viaCellId: '25' },
    ]);
  });

  it('points a sourceFunnelId at another campaign', () => {
    const campaign = makeCampaign({
      goals: [
        makeNode({
          cellId: '3',
          style: 'existingList',
          references: { tagIds: [], tagCategoryIds: [], sourceFunnelId: '584' },
        }),
      ],
    });
    expect(referenceEdges(campaign, 'campaign:987').edges).toEqual([
      { from: 'campaign:987', to: 'campaign:584', kind: 'references-campaign', viaCellId: '3' },
    ]);
  });

  it('tallies a foreign key with no entity kind instead of inventing one', () => {
    const campaign = makeCampaign({
      goals: [
        makeNode({
          cellId: '9',
          style: 'note',
          references: { tagIds: [], tagCategoryIds: [], marketingNoteId: '55' },
        }),
      ],
    });
    const harvest = referenceEdges(campaign, 'campaign:1');
    expect(harvest.edges).toEqual([]);
    expect(harvest.tallies['reference attribute "marketingNoteId" has no entity kind']).toBe(1);
  });

  it('never treats tagIds or tagCategoryIds as a foreign key', () => {
    const campaign = makeCampaign({
      goals: [
        makeNode({
          cellId: '4',
          style: 'tagApplied',
          references: { tagIds: ['346'], tagCategoryIds: ['9'] },
        }),
      ],
    });
    expect(referenceEdges(campaign, 'campaign:1')).toEqual({ edges: [], tallies: {} });
  });
});
