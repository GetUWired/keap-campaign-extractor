import { describe, expect, it } from 'vitest';
import { analyzeBrokenReferences } from '../src/analyze/brokenRefs.js';
import type { AccountGraph } from '../src/normalize/graph.js';
import { buildGraph } from '../src/normalize/graph.js';
import type { CampaignSummary } from '../src/parse/campaignList.js';
import { makeCampaign, makeNode } from './fixtures/graphFixtures.js';

const tagGoal = (cellId: string, tagIds: string[], name: string) =>
  makeNode({ cellId, style: 'tagApplied', name, references: { tagIds, tagCategoryIds: [] } });

const summary = (over: Partial<CampaignSummary> = {}): CampaignSummary => ({
  funnelId: '16',
  name: 'Welcome',
  categories: [],
  activeContacts: null,
  publishedDate: null,
  publishedBy: null,
  published: false,
  ...over,
});

/** A graph whose findings name the entities the account no longer has. */
const withFindings = (
  graph: AccountGraph,
  notFound: string[],
  neverBuilt: string[] = [],
): AccountGraph => ({
  ...graph,
  findings: { ...graph.findings, entitiesNotFound: notFound, entitiesNeverBuilt: neverBuilt },
});

describe('analyzeBrokenReferences', () => {
  const campaign = makeCampaign({
    funnelId: '16',
    name: 'Welcome',
    published: true,
    goals: [tagGoal('4', ['646'], 'Signed up')],
  });

  it('locates a reference to an entity the account no longer has', () => {
    const graph = withFindings(buildGraph([campaign]), ['tag:646']);
    const report = analyzeBrokenReferences('x', [campaign], graph, [
      summary({ published: true, activeContacts: 12 }),
    ]);

    expect(report.counts.references).toBe(1);
    expect(report.references[0]?.entityId).toBe('tag:646');
    expect(report.references[0]?.locations[0]).toMatchObject({
      campaignId: '16',
      kind: 'trigger',
      nodeName: 'Signed up',
      status: 'live',
      activeContacts: 12,
    });
  });

  it('ignores references to entities that still exist', () => {
    const report = analyzeBrokenReferences('x', [campaign], withFindings(buildGraph([campaign]), []));
    expect(report.counts.references).toBe(0);
    expect(report.campaigns).toEqual([]);
  });

  it('separates a ready step from one nobody finished', () => {
    // 86 half-built drafts are not 86 emergencies.
    const graph = withFindings(buildGraph([campaign]), [], ['tag:646']);
    const report = analyzeBrokenReferences('x', [campaign], graph);
    expect(report.references[0]?.severity).toBe('never-built');
    expect(report.counts.readyReferences).toBe(0);
    expect(report.counts.neverBuiltReferences).toBe(1);
  });

  it('flags a campaign whose every trigger points at something missing', () => {
    const graph = withFindings(buildGraph([campaign]), ['tag:646']);
    const report = analyzeBrokenReferences('x', [campaign], graph);
    expect(report.campaigns[0]?.allEntryPointsBroken).toBe(true);
  });

  it('does not call a campaign dead when a non-tag goal still works', () => {
    // Counting only tag goals called campaigns dead that a purchase or
    // link-click goal could still let people into.
    const mixed = makeCampaign({
      funnelId: '18',
      goals: [
        tagGoal('4', ['646'], 'Gone'),
        makeNode({ cellId: '5', style: 'purchaseSuccess', name: 'Any purchase' }),
      ],
    });
    const graph = withFindings(buildGraph([mixed]), ['tag:646']);
    const report = analyzeBrokenReferences('x', [mixed], graph);
    expect(report.campaigns[0]?.allEntryPointsBroken).toBe(false);
    expect(report.campaigns[0]?.goalsWorking).toBe(1);
  });

  it('ignores a goal nobody configured, either way', () => {
    // An unfinished template is not a campaign a deletion killed.
    const half = makeCampaign({
      funnelId: '19',
      goals: [
        tagGoal('4', ['646'], 'Gone'),
        makeNode({ cellId: '5', style: 'purchaseSuccess', name: null }),
      ],
      unconfigured: ['5'],
    });
    const graph = withFindings(buildGraph([half]), ['tag:646']);
    const report = analyzeBrokenReferences('x', [half], graph);
    expect(report.campaigns[0]?.allEntryPointsBroken).toBe(true);
    expect(report.campaigns[0]?.goalsWorking).toBe(0);
  });

  it('does not flag a campaign that still has one working way in', () => {
    const two = makeCampaign({
      funnelId: '17',
      name: 'Two ways in',
      goals: [tagGoal('4', ['646'], 'Gone'), tagGoal('5', ['999'], 'Still here')],
    });
    const graph = withFindings(buildGraph([two]), ['tag:646']);
    const report = analyzeBrokenReferences('x', [two], graph);
    expect(report.campaigns[0]?.allEntryPointsBroken).toBe(false);
  });

  it('puts campaigns that cannot start first, then live ones', () => {
    const dead = makeCampaign({ funnelId: '16', published: true, goals: [tagGoal('4', ['646'], 'A')] });
    const alive = makeCampaign({
      funnelId: '17',
      published: true,
      goals: [tagGoal('4', ['646'], 'B'), tagGoal('5', ['999'], 'C')],
    });
    const graph = withFindings(buildGraph([dead, alive]), ['tag:646']);
    const report = analyzeBrokenReferences('x', [dead, alive], graph, [
      summary({ funnelId: '16', published: true }),
      summary({ funnelId: '17', published: true }),
    ]);
    expect(report.campaigns.map((c) => c.campaignId)).toEqual(['16', '17']);
  });

  it('says when there is no catalog, rather than reporting a clean account', () => {
    // Both findings are empty without one, which reads identically to "nothing broken".
    const report = analyzeBrokenReferences('x', [campaign], buildGraph([campaign]));
    expect(report.catalogPresent).toBe(false);
    expect(report.warnings.some((w) => /no catalog comparison/i.test(w))).toBe(true);
  });

  it('counts references by entity kind', () => {
    const graph = withFindings(buildGraph([campaign]), ['tag:646']);
    expect(analyzeBrokenReferences('x', [campaign], graph).counts.byKind).toEqual({ tag: 1 });
  });
});
