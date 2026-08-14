import { describe, expect, it } from 'vitest';
import type { CampaignImpact, ImpactLocation, TagImpactReport } from '../src/analyze/tagImpact.js';
import { renderTagImpactHtml } from '../src/render/tagImpactHtml.js';

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
  plannedDeletion: false,
  activeContacts: 88,
  publishedDate: '8/5/2026 11:32 AM',
  locations: [location()],
  duplicatedGroups: [],
  ...over,
});

const report = (over: Partial<TagImpactReport> = {}): TagImpactReport => ({
  appName: 'se232',
  analyzedAt: '2026-08-06T00:00:00.000Z',
  tags: [{ tagId: '646', tagName: 'Bought', group: null, locations: [location()], campaignCount: 1 }],
  campaigns: [campaign()],
  noCampaignReferences: [],
  plannedDeletions: 0,
  warnings: [],
  ...over,
});

/** The embedded payload, as the page's own script would parse it. */
function payloadOf(page: string): { campaigns: CampaignImpact[] } {
  const match = page.match(
    /<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/,
  );
  if (match?.[1] === undefined) throw new Error('no embedded payload');
  return JSON.parse(match[1].replace(/\\u003c/g, '<').replace(/\\u003e/g, '>'));
}

describe('renderTagImpactHtml', () => {
  it('never uses the word "safe"', () => {
    // Same refusal as the Markdown view: this drives deletions in a live account.
    expect(renderTagImpactHtml(report()).toLowerCase()).not.toContain('safe');
  });

  it('puts the caveat on the page, not in a footnote', () => {
    expect(renderTagImpactHtml(report())).toMatch(/campaign usage only/i);
  });

  it('is self-contained — no external requests', () => {
    const page = renderTagImpactHtml(report());
    expect(page).not.toMatch(/<script[^>]+\bsrc=/);
    expect(page).not.toMatch(/<link[^>]+stylesheet/);
    expect(page).not.toMatch(/https?:\/\//);
  });

  it('cannot be escaped by a campaign name containing markup', () => {
    // Campaign and tag names are client-authored text. The name survives intact
    // as data; what must not survive is any character that can start markup.
    const hostile = '</script><img src=x onerror=alert(1)>';
    const page = renderTagImpactHtml(
      report({ campaigns: [campaign({ campaignName: hostile, locations: [location({ tagName: hostile })] })] }),
    );
    const embedded = page.slice(page.indexOf('id="report-data"'));
    const payloadText = embedded.slice(embedded.indexOf('>') + 1, embedded.indexOf('</script>'));
    expect(payloadText).not.toContain('<');
    expect(payloadText).not.toContain('>');
    expect(payloadOf(page).campaigns[0]?.campaignName).toBe(hostile);
  });

  it('escapes an app name containing markup in the static shell', () => {
    const page = renderTagImpactHtml(report({ appName: '<img src=x onerror=alert(1)>' }));
    expect(page).not.toContain('<img src=x');
    expect(page).toContain('&lt;img src=x');
  });

  it('carries the campaign data the page navigates', () => {
    const page = renderTagImpactHtml(report());
    const parsed = payloadOf(page);
    expect(parsed.campaigns).toHaveLength(1);
    expect(parsed.campaigns[0]?.status).toBe('live');
    expect(parsed.campaigns[0]?.locations[0]?.tagName).toBe('Bought');
  });

  it('leaves out the tags array, which repeats every location already embedded', () => {
    const page = renderTagImpactHtml(report());
    expect(Object.keys(payloadOf(page))).not.toContain('tags');
  });

  it('offers an exact tag query, because ids substring-match each other', () => {
    // Searching "739" also matches tag 17390; the tag table's link must not
    // land on 12 campaigns for a tag the table said was in 9.
    const page = renderTagImpactHtml(report());
    expect(page).toContain("startsWith('tag:')");
    expect(page).toContain("'tag:' + row.tagId");
  });

  it('keeps status and location-kind filters in separate labelled groups', () => {
    // Read as one row of seven chips, nobody could tell the two sets apart.
    const page = renderTagImpactHtml(report());
    const groups = [...page.matchAll(/<div class="group"[\s\S]*?<\/div>\s*<\/div>/g)].map((m) => m[0]);
    expect(groups).toHaveLength(2);


    const statusGroup = groups.find((g) => g.includes('data-status')) ?? '';
    const kindGroup = groups.find((g) => g.includes('data-kind')) ?? '';
    expect(statusGroup).toContain('Campaign status');
    expect(statusGroup).not.toContain('data-kind');
    expect(kindGroup).toContain('Tag used as');
    expect(kindGroup).not.toContain('data-status');
  });

  it('offers a delete/merge filter when the list holds both', () => {
    const both = report({
      campaigns: [
        campaign({ campaignId: '16', locations: [location({ group: null })] }),
        campaign({ campaignId: '17', locations: [location({ group: 'newsletter' })] }),
      ],
    });
    const page = renderTagImpactHtml(both);
    expect(page).toContain('Tag change');
    expect(page).toContain('data-change="delete"');
    expect(page).toContain('data-change="merge"');
    const groups = [...page.matchAll(/<div class="group"[\s\S]*?<\/div>\s*<\/div>/g)];
    expect(groups).toHaveLength(3);
  });

  it('omits that filter when every tag is the same kind of change', () => {
    // One option filters nothing.
    const page = renderTagImpactHtml(report({ campaigns: [campaign()] }));
    expect(page).not.toContain('data-change=');
  });

  it('offers a campaign-plan filter once a deletion list is in play', () => {
    const page = renderTagImpactHtml(
      report({
        campaigns: [campaign({ plannedDeletion: true }), campaign({ campaignId: '17' })],
        plannedDeletions: 1,
      }),
    );
    expect(page).toContain('Campaign plan');
    expect(page).toContain('data-plan="deleting"');
    expect(page).toContain('once deletions are done');
  });

  it('omits that filter when no campaign is being deleted', () => {
    const page = renderTagImpactHtml(report());
    expect(page).not.toContain('data-plan=');
    expect(page).not.toContain('once deletions are done');
  });

  it('gives the unreferenced tags their own tab, with the count in the label', () => {
    const page = renderTagImpactHtml(
      report({
        noCampaignReferences: [
          { tagId: '999', tagName: 'Unused', group: null },
          { tagId: '998', tagName: 'Also unused', group: 'newsletter' },
        ],
      }),
    );
    expect(page).toContain('data-view="unreferenced"');
    expect(page).toContain('No campaign references (2)');
  });

  it('embeds those tags with the change each one is undergoing', () => {
    const page = renderTagImpactHtml(
      report({ noCampaignReferences: [{ tagId: '999', tagName: 'Unused', group: 'newsletter' }] }),
    );
    const payload = payloadOf(page) as unknown as {
      noCampaignReferences: { tagId: string; group: string | null }[];
    };
    expect(payload.noCampaignReferences).toEqual([
      { tagId: '999', tagName: 'Unused', group: 'newsletter' },
    ]);
  });

  it('puts the caveat beside that list, not only in the header', () => {
    // This is the tab someone reads as "these are fine to delete".
    const page = renderTagImpactHtml(
      report({ noCampaignReferences: [{ tagId: '999', tagName: 'Unused', group: null }] }),
    );
    expect(page).toMatch(/not used by any campaign — that is all this says/i);
    expect(page).toMatch(/before removing it/i);
    expect(page.toLowerCase()).not.toContain('safe');
  });

  it('offers a way back out of a filtered state', () => {
    expect(renderTagImpactHtml(report())).toContain('id="reset"');
  });

  it('leads with how many affected campaigns are live', () => {
    const page = renderTagImpactHtml(
      report({
        campaigns: [
          campaign({ campaignId: '16', status: 'live', activeContacts: 88 }),
          campaign({ campaignId: '17', status: 'never-published', activeContacts: null }),
        ],
      }),
    );
    expect(page).toContain('of them live');
    expect(page).toContain('contacts in live campaigns');
  });
});
