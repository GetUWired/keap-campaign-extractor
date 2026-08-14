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
