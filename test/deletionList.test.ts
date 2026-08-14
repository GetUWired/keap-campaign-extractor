import { describe, expect, it } from 'vitest';
import { parseDeletionList } from '../src/analyze/deletionList.js';

describe('parseDeletionList — CSV', () => {
  it('reads id and name', () => {
    const csv = 'id,name\n11119,Welcome Home trips\n8647,Travel Guides\n';
    expect(parseDeletionList(csv, 'csv').campaigns).toEqual([
      { campaignId: '11119', name: 'Welcome Home trips' },
      { campaignId: '8647', name: 'Travel Guides' },
    ]);
  });

  it('accepts the column names a Keap export uses', () => {
    // Nobody should have to rename a column to use their own export.
    for (const column of ['campaign_id', 'funnel_id', 'funnelId']) {
      const list = parseDeletionList(`${column},campaign_name\n11119,Welcome\n`, 'csv');
      expect(list.campaigns[0]).toEqual({ campaignId: '11119', name: 'Welcome' });
    }
  });

  it('works with only an id column', () => {
    expect(parseDeletionList('id\n11119\n', 'csv').campaigns).toEqual([
      { campaignId: '11119', name: '' },
    ]);
  });

  it('honours quoting, because campaign names contain commas', () => {
    const csv = 'id,name\n1,"Trip Ends; Adding Tags, Tier Levels"\n';
    expect(parseDeletionList(csv, 'csv').campaigns[0]?.name).toBe('Trip Ends; Adding Tags, Tier Levels');
  });

  it('warns and skips a row with no id', () => {
    const list = parseDeletionList('id,name\n,No Id\n2,Fine\n', 'csv');
    expect(list.campaigns.map((c) => c.campaignId)).toEqual(['2']);
    expect(list.warnings.some((w) => /no campaign id/i.test(w))).toBe(true);
  });

  it('warns and skips a duplicate id', () => {
    const list = parseDeletionList('id,name\n1,First\n1,Again\n', 'csv');
    expect(list.campaigns).toHaveLength(1);
    expect(list.warnings.some((w) => /more than once/i.test(w))).toBe(true);
  });

  it('names the columns it would accept when none is present', () => {
    expect(() => parseDeletionList('name\nA\n', 'csv')).toThrow(/campaign_id/);
  });
});

describe('parseDeletionList — JSON', () => {
  it('reads a delete array of objects', () => {
    const json = JSON.stringify({ delete: [{ id: '11119', name: 'Welcome' }] });
    expect(parseDeletionList(json, 'json').campaigns).toEqual([
      { campaignId: '11119', name: 'Welcome' },
    ]);
  });

  it('accepts a bare array of ids', () => {
    expect(parseDeletionList('["11119", 8647]', 'json').campaigns).toEqual([
      { campaignId: '11119', name: '' },
      { campaignId: '8647', name: '' },
    ]);
  });

  it('throws on malformed JSON rather than returning an empty list', () => {
    expect(() => parseDeletionList('{oops', 'json')).toThrow();
  });
});
