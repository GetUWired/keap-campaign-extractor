import { describe, expect, it } from 'vitest';
import { campaignNodes, dedupeEdges, entityId, mergeTallies } from '../src/normalize/graphEdges.js';
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
