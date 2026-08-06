import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCampaignList } from '../src/parse/campaignList.js';

const html = readFileSync(new URL('./fixtures/campaign-list-jordan.html', import.meta.url), 'utf8');

describe('parseCampaignList', () => {
  it('reads the account-wide total from the page, not from the rows', () => {
    // The fixture holds six sampled rows but reports the real account total.
    expect(parseCampaignList(html).total).toBe(170);
  });

  it('reads the report state id and page size', () => {
    const result = parseCampaignList(html);
    expect(result.reportStateId).toBe('6df5eb9a-3e7f-4bc3-8aa8-1fec92114637');
    expect(result.perPage).toBe(50);
  });

  it('extracts every row anchored on the editor link', () => {
    expect(parseCampaignList(html).campaigns.map((c) => c.funnelId)).toEqual([
      '999',
      '987',
      '953',
      '745',
      '676',
      '592',
    ]);
  });

  it('reads a fully populated row', () => {
    const c = parseCampaignList(html).campaigns.find((x) => x.funnelId === '987');
    expect(c).toMatchObject({
      name: 'WooConnection Beta Tester Application',
      categories: ['WooConnection'],
      activeContacts: 0,
      publishedDate: '11/10/2020 8:31 AM',
      publishedBy: 'Amy Anton',
      published: true,
    });
  });

  it('treats a missing published date as never published', () => {
    const c = parseCampaignList(html).campaigns.find((x) => x.funnelId === '999');
    expect(c).toMatchObject({
      name: 'Untitled automation',
      categories: [],
      publishedDate: null,
      publishedBy: null,
      published: false,
    });
  });

  it('keeps a literal N/A publisher rather than turning it into null', () => {
    const c = parseCampaignList(html).campaigns.find((x) => x.funnelId === '745');
    expect(c?.publishedBy).toBe('N/A');
    expect(c?.published).toBe(true);
  });

  it('decodes HTML entities in campaign names', () => {
    const c = parseCampaignList(html).campaigns.find((x) => x.funnelId === '676');
    expect(c?.name).toBe('Bundle Offer – Convert Leads (Shopify)');
    expect(c?.name).not.toContain('&ndash;');
  });

  it('stores the published date verbatim, with no timezone interpretation', () => {
    const dates = parseCampaignList(html)
      .campaigns.map((c) => c.publishedDate)
      .filter((d): d is string => d !== null);
    expect(dates.length).toBeGreaterThan(0);
    for (const d of dates) expect(d).toMatch(/^\d{1,2}\/\d{1,2}\/\d{4} \d{1,2}:\d{2} [AP]M$/);
  });
});

describe('parseCampaignList resilience', () => {
  it('reads columns by name, so reordering them does not shift fields', () => {
    // Swap the Name and Categories header labels. The campaign name still comes
    // from the editor link, but the Categories lookup now points at the column
    // that holds names — proving lookup is by label, not by fixed position.
    const swapped = html
      .replace('>Name</span>', '>__TMP__</span>')
      .replace('>Categories</span>', '>Name</span>')
      .replace('>__TMP__</span>', '>Categories</span>');
    const c = parseCampaignList(swapped).campaigns.find((x) => x.funnelId === '987');
    expect(c?.name).toBe('WooConnection Beta Tester Application');
    expect(c?.categories).toEqual(['WooConnection Beta Tester Application']);
  });

  it('warns naming a column that has disappeared rather than throwing', () => {
    const gutted = html.replace('>Published Date</span>', '>Something Else</span>');
    const result = parseCampaignList(gutted);
    expect(result.warnings.some((w) => /Published Date/.test(w))).toBe(true);
    expect(result.campaigns.every((c) => c.publishedDate === null)).toBe(true);
    expect(result.campaigns.every((c) => c.published === false)).toBe(true);
  });

  it('does not count the wrapper row that contains the data table', () => {
    // The data table is nested one row deep inside an outer grid-table. A
    // global $('tr') scan matches that wrapper too, and because .find() is
    // recursive it reports every descendant cell and the first data row's
    // link — yielding a phantom campaign with every column shifted by one.
    // Live, this produced 171 campaigns against a page reporting 170.
    const result = parseCampaignList(html);
    const ids = result.campaigns.map((c) => c.funnelId);
    expect(ids).toHaveLength(new Set(ids).size);
    expect(result.campaigns).toHaveLength(6);
  });

  it('never lets a campaign name leak into the categories column', () => {
    // The symptom the shifted phantom row produced: "Untitled automation"
    // appearing in the category tally.
    const names = new Set(parseCampaignList(html).campaigns.map((c) => c.name));
    for (const campaign of parseCampaignList(html).campaigns) {
      for (const category of campaign.categories) {
        expect(names.has(category)).toBe(false);
      }
    }
  });

  it('returns no campaigns and a warning for unrelated HTML', () => {
    const result = parseCampaignList('<html><body>Session expired</body></html>');
    expect(result.campaigns).toEqual([]);
    expect(result.total).toBeNull();
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
