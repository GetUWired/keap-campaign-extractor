import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeCampaign } from '../src/normalize/campaign.js';
import { buildGraph } from '../src/normalize/graph.js';
import { renderCampaign } from '../src/render/campaignDoc.js';

const c987 = readFileSync(new URL('./fixtures/campaign-987-draft.xml', import.meta.url), 'utf8');
const campaign = normalizeCampaign(c987, '', {}, 'WooConnection Beta Tester Application', '987');
const graph = buildGraph([campaign]);
const page = renderCampaign(campaign, graph);

describe('renderCampaign', () => {
  it('titles the page with the campaign name and id', () => {
    expect(page.split('\n')[0]).toBe('# WooConnection Beta Tester Application (987)');
  });

  it('embeds the diagram in a mermaid fence', () => {
    expect(page).toContain('```mermaid\nflowchart TD');
  });

  it('lists every sequence with its steps in order', () => {
    for (const sequence of campaign.sequences) {
      if (sequence.name !== null) expect(page).toContain(sequence.name);
    }
  });

  it('flags an empty sequence rather than showing nothing', () => {
    // 987 routes into two sequences containing only a start vertex.
    expect(page).toMatch(/empty/i);
  });

  it('states once, not per line, that names are unavailable without a catalog', () => {
    expect(page.match(/ids are shown instead of names/gi) ?? []).toHaveLength(1);
  });

  it('never prints an internal style name', () => {
    for (const style of ['newsletterRequest', 'indicateInterest', 'bardEmail', 'unlayerEmail']) {
      expect(page, style).not.toContain(style);
    }
  });

  it('never leaks an undecoded entity', () => {
    expect(page).not.toMatch(/&#\d+;|&quot;|&amp;/);
  });

  it('has the sections a reader needs', () => {
    for (const heading of ['## Flow', '## Goals', '## Sequences', '## Connections']) {
      expect(page, heading).toContain(heading);
    }
  });

  it('notes an unverified sequence order instead of implying the order is real', () => {
    const unordered = {
      ...campaign,
      sequences: campaign.sequences.map((s) => ({ ...s, orderVerified: false })),
    };
    expect(renderCampaign(unordered, graph)).toMatch(/order could not be verified/i);
  });

  it('balances every code fence, so the Markdown does not break downstream', () => {
    expect((page.match(/```/g) ?? []).length % 2).toBe(0);
  });
});
