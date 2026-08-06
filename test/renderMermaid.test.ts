import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeCampaign } from '../src/normalize/campaign.js';
import { renderMermaid } from '../src/render/mermaid.js';
import { makeCampaign, makeDecision, makeNode, makeSequence } from './fixtures/graphFixtures.js';

const c987 = readFileSync(new URL('./fixtures/campaign-987-draft.xml', import.meta.url), 'utf8');

describe('renderMermaid', () => {
  it('opens a top-down flowchart', () => {
    expect(renderMermaid(makeCampaign({ funnelId: '1' })).split('\n')[0]).toBe('flowchart TD');
  });

  it('renders goals, decisions and sequences with distinct shapes', () => {
    const campaign = makeCampaign({
      funnelId: '987',
      goals: [makeNode({ cellId: '2', style: 'tagApplied', name: 'Approved' })],
      decisions: [makeDecision({ cellId: '34', name: null })],
      sequences: [makeSequence({ cellId: '3', name: 'Confirmation' })],
      edges: [
        { cellId: 'e1', source: '2', target: '34', scope: '1' },
        { cellId: 'e2', source: '34', target: '3', scope: '1' },
      ],
    });
    const out = renderMermaid(campaign);
    expect(out).toContain('n2(["'); // goal — stadium
    expect(out).toContain('n34{"'); // decision — rhombus
    expect(out).toContain('n3["'); // sequence — rectangle
    expect(out).toContain('n2 --> n34');
    expect(out).toContain('n34 --> n3');
  });

  it('never emits step-level edges, only campaign scope', () => {
    const campaign = makeCampaign({
      funnelId: '1',
      sequences: [makeSequence({ cellId: '3' })],
      edges: [{ cellId: 'e9', source: '14', target: '81', scope: '3' }],
    });
    expect(renderMermaid(campaign)).not.toContain('n14');
  });

  it('escapes a label that would otherwise break the diagram', () => {
    const campaign = makeCampaign({
      funnelId: '1',
      goals: [
        makeNode({ cellId: '2', style: 'goal', name: 'Request our Email Series "How to sell"' }),
      ],
    });
    const out = renderMermaid(campaign);
    expect(out).toContain('#quot;');
    const nodeLine = out.split('\n').find((l) => l.includes('n2(')) ?? '';
    expect((nodeLine.match(/"/g) ?? []).length).toBe(2);
  });

  it('decodes entities so no diagram shows &#39;', () => {
    const campaign = makeCampaign({
      funnelId: '1',
      goals: [makeNode({ cellId: '2', style: 'goal', name: 'I haven&#39;t heard back?' })],
    });
    expect(renderMermaid(campaign)).not.toContain('&#39;');
  });

  it('marks an empty sequence as empty', () => {
    // Campaign 987 routes into two sequences that contain nothing. As a table
    // row nobody notices; in a diagram it should be unmissable.
    const campaign = makeCampaign({
      funnelId: '1',
      sequences: [makeSequence({ cellId: '38', name: 'Approved for Beta', steps: [] })],
    });
    expect(renderMermaid(campaign)).toMatch(/n38\["[^"]*empty/i);
  });

  it('renders campaign 987 with its real goals, decision and sequences', () => {
    const campaign = normalizeCampaign(c987, '', {}, null, '987');
    const out = renderMermaid(campaign);
    expect(out).toContain('flowchart TD');
    for (const sequence of campaign.sequences) expect(out).toContain(`n${sequence.cellId}`);
    for (const decision of campaign.decisions) expect(out).toContain(`n${decision.cellId}{`);
    expect(out.split('\n').filter((l) => l.includes('-->')).length).toBeGreaterThan(0);
  });

  it('produces a diagram with no nodes for an empty campaign, not a crash', () => {
    expect(renderMermaid(makeCampaign({ funnelId: '1' }))).toBe('flowchart TD');
  });
});
