import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeTagImpact } from '../src/analyze/tagImpact.js';
import { parseTagList } from '../src/analyze/tagList.js';
import type { NormalizedCampaign } from '../src/normalize/campaign.js';
import type { AccountGraph } from '../src/normalize/graph.js';
import type { CampaignSummary } from '../src/parse/campaignList.js';
import { renderTagImpact } from '../src/render/tagImpactDoc.js';

// artifacts/ is gitignored, so this runs only where the corpus exists.
const DIR = new URL('../artifacts/se232/normalized/', import.meta.url);
const GRAPH = new URL('../artifacts/se232/graph.json', import.meta.url);
const LIST = new URL('../artifacts/se232/campaigns.json', import.meta.url);
const present = existsSync(DIR) && existsSync(GRAPH) && existsSync(LIST);

const graph = present
  ? (JSON.parse(readFileSync(GRAPH, 'utf8')) as AccountGraph)
  : ({ entities: [], edges: [], findings: {} } as unknown as AccountGraph);

const campaigns = present
  ? readdirSync(DIR)
      .filter((f) => /^\d+\.json$/.test(f))
      .map((f) => JSON.parse(readFileSync(new URL(f, DIR), 'utf8')) as NormalizedCampaign)
  : [];

const summaries: CampaignSummary[] = present
  ? (JSON.parse(readFileSync(LIST, 'utf8')) as { campaigns: CampaignSummary[] }).campaigns
  : [];

describe.skipIf(!present)('tag impact against the real se232 corpus', () => {
  it('counts the campaigns referencing tag 13269 consistently', () => {
    // This asserted 139 — the figure measured by hand in August. The corpus is
    // now re-extracted weekly, so the account moves under it: 17 campaigns were
    // added by October and the honest answer became 144. A number that changes
    // whenever the client edits a campaign tests the client, not the code, so
    // what is pinned here is the internal agreement between the two counts.
    const list = parseTagList('id,name\n13269,Funnel -> In Funnel: Nurture Emails\n', 'csv');
    const report = analyzeTagImpact('se232', list, campaigns, graph);
    const distinct = new Set(
      report.campaigns.flatMap((c) => c.locations).map((l) => l.campaignId),
    ).size;

    expect(report.tags[0]?.campaignCount).toBe(distinct);
    expect(report.campaigns).toHaveLength(distinct);
    // A floor, so "returns nothing" still fails loudly.
    expect(distinct).toBeGreaterThan(100);
  });

  it('resolves every step location to a sequence and position', () => {
    const list = parseTagList('id,name\n13269,Nurture\n', 'csv');
    const report = analyzeTagImpact('se232', list, campaigns, graph);
    const steps = report.campaigns.flatMap((c) => c.locations).filter((l) => l.kind === 'step');
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((s) => typeof s.stepPosition === 'number')).toBe(true);
  });

  it('gives every nameless decision something an operator can find it by', () => {
    // All 179 of se232's decisions are unnamed; a bare cell id is not findable.
    const list = parseTagList('id,name\n13269,Nurture\n', 'csv');
    const report = analyzeTagImpact('se232', list, campaigns, graph);
    const decisions = report.campaigns
      .flatMap((c) => c.locations)
      .filter((l) => l.kind === 'decision');
    expect(decisions.every((d) => d.nodeName || d.after)).toBe(true);
  });

  it('gives every affected campaign a status the campaign list can support', () => {
    const list = parseTagList('id,name\n13269,Nurture\n', 'csv');
    const report = analyzeTagImpact('se232', list, campaigns, graph, summaries);
    expect(report.campaigns.every((c) => c.status !== 'unknown')).toBe(true);
    expect(report.campaigns.filter((c) => c.status === 'live').length).toBeGreaterThan(0);
  });

  it('renders the whole thing without the word "safe"', () => {
    const list = parseTagList('id,name\n13269,Nurture\n999999,Not Used\n', 'csv');
    const page = renderTagImpact(analyzeTagImpact('se232', list, campaigns, graph));
    expect(page.toLowerCase()).not.toContain('safe');
    expect(page).toMatch(/no campaign references/i);
  });
});
