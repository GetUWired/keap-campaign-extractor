import { describe, expect, it } from 'vitest';
import type { ImpactLocation, TagImpactReport } from '../src/analyze/tagImpact.js';
import { renderTagImpact } from '../src/render/tagImpactDoc.js';

const location = (over: Partial<ImpactLocation> = {}): ImpactLocation => ({
  campaignId: '16',
  campaignName: 'Welcome',
  tagId: '646',
  tagName: 'Bought',
  group: null,
  kind: 'trigger',
  edgeKind: 'listens-for',
  cellId: '4',
  nodeName: 'Signed up',
  ...over,
});

const report = (over: Partial<TagImpactReport> = {}): TagImpactReport => ({
  appName: 'se232',
  analyzedAt: '2026-08-06T00:00:00.000Z',
  tags: [],
  campaigns: [],
  noCampaignReferences: [],
  warnings: [],
  ...over,
});

describe('renderTagImpact', () => {
  it('never uses the word "safe"', () => {
    // This report sits beside someone deleting tags in a live client account.
    const page = renderTagImpact(
      report({ noCampaignReferences: [{ tagId: '999', tagName: 'Unused' }] }),
    );
    expect(page.toLowerCase()).not.toContain('safe');
  });

  it('says what "no campaign references" does and does not mean', () => {
    const page = renderTagImpact(
      report({ noCampaignReferences: [{ tagId: '999', tagName: 'Unused' }] }),
    );
    expect(page).toMatch(/no campaign references/i);
    expect(page).toMatch(/not visible to this tool/i);
  });

  it('carries the caveat even when nothing is unreferenced', () => {
    expect(renderTagImpact(report())).toMatch(/campaign usage only/i);
  });

  it('describes a trigger location by its goal', () => {
    const page = renderTagImpact(
      report({ campaigns: [{ campaignId: '16', campaignName: 'Welcome', locations: [location()], duplicatedGroups: [] }] }),
    );
    expect(page).toMatch(/Trigger/);
    expect(page).toContain('Signed up');
  });

  it('describes a step by its sequence and position', () => {
    const step = location({
      kind: 'step',
      edgeKind: 'removes',
      sequenceName: 'Onboarding',
      stepPosition: 2,
      nodeName: null,
    });
    const page = renderTagImpact(
      report({ campaigns: [{ campaignId: '16', campaignName: 'Welcome', locations: [step], duplicatedGroups: [] }] }),
    );
    expect(page).toContain('Onboarding');
    expect(page).toContain('step 2');
    expect(page).toMatch(/removes/i);
  });

  it('reports a campaign that references two tags from one group', () => {
    const page = renderTagImpact(
      report({
        campaigns: [
          {
            campaignId: '16',
            campaignName: 'Welcome',
            locations: [location()],
            duplicatedGroups: [{ group: 'newsletter', tagIds: ['646', '647'] }],
          },
        ],
      }),
    );
    expect(page).toContain('newsletter');
  });

  it('lists warnings so a partial view is visible', () => {
    const page = renderTagImpact(report({ warnings: ['campaign 16 has 2 decision(s) with no criteria'] }));
    expect(page).toContain('no criteria');
  });

  it('escapes a pipe in a name so the Markdown table survives', () => {
    const page = renderTagImpact(
      report({ noCampaignReferences: [{ tagId: '1', tagName: 'A | B' }] }),
    );
    const row = page.split('\n').find((l) => l.startsWith('| 1 |')) ?? '';
    expect(row).toContain('A \\| B');
  });
});
