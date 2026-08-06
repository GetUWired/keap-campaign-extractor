import { describe, expect, it } from 'vitest';
import {
  campaignNodes,
  dedupeEdges,
  entityId,
  mergeTallies,
  tagEdges,
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
