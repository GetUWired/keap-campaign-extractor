import { describe, expect, it } from 'vitest';
import type {
  CampaignImpact,
  ImpactLocation,
  TagImpactReport,
} from '../src/analyze/tagImpact.js';
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

const campaign = (over: Partial<CampaignImpact> = {}): CampaignImpact => ({
  campaignId: '16',
  campaignName: 'Welcome',
  status: 'live',
  activeContacts: null,
  publishedDate: null,
  locations: [location()],
  duplicatedGroups: [],
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
      report({ campaigns: [campaign()] }),
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
      report({ campaigns: [campaign({ locations: [step] })] }),
    );
    expect(page).toContain('Onboarding');
    expect(page).toContain('step 2');
    expect(page).toMatch(/removes/i);
  });

  it('reports a campaign that references two tags from one group', () => {
    const page = renderTagImpact(
      report({
        campaigns: [campaign({ duplicatedGroups: [{ group: 'newsletter', tagIds: ['646', '647'] }] })],
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

describe('campaign status in the page', () => {
  it('labels a live campaign and says who is in it', () => {
    const page = renderTagImpact(
      report({
        campaigns: [
          campaign({ status: 'live', activeContacts: 88, publishedDate: '8/5/2026 11:32 AM' }),
        ],
      }),
    );
    expect(page).toContain('**Live**');
    expect(page).toContain('88 active contacts');
    expect(page).toContain('8/5/2026 11:32 AM');
  });

  it('distinguishes stopped from never published', () => {
    const page = renderTagImpact(
      report({
        campaigns: [
          campaign({ campaignId: '16', status: 'stopped' }),
          campaign({ campaignId: '17', status: 'never-published' }),
        ],
      }),
    );
    expect(page).toContain('Published, then stopped');
    expect(page).toContain('Never published');
  });

  it('says the status is unknown rather than implying it is fine', () => {
    const page = renderTagImpact(report({ campaigns: [campaign({ status: 'unknown' })] }));
    expect(page).toContain('Status unknown');
  });

  it('breaks the affected campaigns down by status', () => {
    const page = renderTagImpact(
      report({
        campaigns: [
          campaign({ campaignId: '16', status: 'live', activeContacts: 88 }),
          campaign({ campaignId: '17', status: 'never-published' }),
        ],
      }),
    );
    expect(page).toContain('Affected campaigns by status');
    expect(page).toMatch(/\| Live \| 1 \| 1 \| 88 \|/);
  });

  it('omits the breakdown when nothing is affected', () => {
    expect(renderTagImpact(report())).not.toContain('by status');
  });
});

describe('what change each tag is undergoing', () => {
  it('marks a tag with no group as a deletion', () => {
    const page = renderTagImpact(report({ campaigns: [campaign()] }));
    expect(page).toContain('[delete]');
  });

  it('names the merge group when the list has more than one', () => {
    const page = renderTagImpact(
      report({
        campaigns: [
          campaign({ campaignId: '16', locations: [location({ group: 'newsletter' })] }),
          campaign({ campaignId: '17', locations: [location({ group: 'welcome' })] }),
        ],
      }),
    );
    expect(page).toContain('[merge → newsletter]');
    expect(page).toContain('[merge → welcome]');
  });

  it('omits a group name that every merged tag shares, since it says nothing', () => {
    const page = renderTagImpact(
      report({ campaigns: [campaign({ locations: [location({ group: 'merge' })] })] }),
    );
    expect(page).toContain('[merge]');
    expect(page).not.toContain('merge → merge');
  });
});
