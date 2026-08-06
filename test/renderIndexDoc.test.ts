import { describe, expect, it } from 'vitest';
import { buildGraph } from '../src/normalize/graph.js';
import { renderIndex } from '../src/render/indexDoc.js';
import { makeCampaign, makeSequence } from './fixtures/graphFixtures.js';

const campaigns = [
  makeCampaign({
    funnelId: '16',
    name: 'Live One',
    published: true,
    sequences: [makeSequence({ cellId: '3', name: 'Seq', ready: true })],
  }),
  makeCampaign({ funnelId: '987', name: 'Dead One', published: false, unconfigured: ['43'] }),
];
const index = renderIndex(campaigns, buildGraph(campaigns));

describe('renderIndex', () => {
  it('links to every campaign page', () => {
    expect(index).toContain('[Live One](16.md)');
    expect(index).toContain('[Dead One](987.md)');
  });

  it('shows publication state', () => {
    expect(index).toMatch(/Live One.*\bpublished\b/);
    expect(index).toMatch(/Dead One.*never published/);
  });

  it('surfaces the incompleteness counts that decide migration effort', () => {
    const row = index.split('\n').find((l) => l.includes('Dead One')) ?? '';
    expect(row).toMatch(/\|\s*1\s*\|/);
  });

  it('states the account totals', () => {
    expect(index).toContain('2 campaigns');
  });

  it('sorts numerically, so campaign 16 precedes campaign 987', () => {
    expect(index.indexOf('Live One')).toBeLessThan(index.indexOf('Dead One'));
  });
});
