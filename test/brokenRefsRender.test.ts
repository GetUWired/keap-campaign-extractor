import { describe, expect, it } from 'vitest';
import type { BrokenLocation, BrokenRefsReport } from '../src/analyze/brokenRefs.js';
import { renderBrokenRefs } from '../src/render/brokenRefsDoc.js';
import { renderBrokenRefsHtml } from '../src/render/brokenRefsHtml.js';

const location = (over: Partial<BrokenLocation> = {}): BrokenLocation => ({
  entityId: 'tag:646',
  campaignId: '16',
  campaignName: 'Welcome',
  status: 'live',
  activeContacts: 12,
  kind: 'trigger',
  edgeKind: 'listens-for',
  cellId: '4',
  nodeName: 'Signed up',
  ...over,
});

const report = (over: Partial<BrokenRefsReport> = {}): BrokenRefsReport => ({
  appName: 'se232',
  analyzedAt: '2026-09-22T00:00:00.000Z',
  catalogPresent: true,
  references: [
    {
      entityId: 'tag:646',
      kind: 'tag',
      entityRef: '646',
      name: 'Bought',
      severity: 'ready',
      locations: [location()],
    },
  ],
  campaigns: [
    {
      campaignId: '16',
      campaignName: 'Welcome',
      status: 'live',
      activeContacts: 12,
      locations: [location()],
      allEntryPointsBroken: true,
      goalsKilled: 1,
      goalsWorking: 0,
    },
  ],
  counts: {
    references: 1,
    readyReferences: 1,
    neverBuiltReferences: 0,
    locations: 1,
    campaigns: 1,
    liveCampaigns: 1,
    byKind: { tag: 1 },
    byLocationKind: { trigger: 1 },
  },
  warnings: [],
  ...over,
});

describe('renderBrokenRefs (Markdown)', () => {
  it('names the missing entity on every line', () => {
    // Without it the line says "something that no longer exists" and nothing else.
    expect(renderBrokenRefs(report())).toContain('`tag:646` Bought');
  });

  it('leads with the campaigns that have no way in', () => {
    const page = renderBrokenRefs(report());
    expect(page).toContain('Campaigns with no working way in');
    expect(page.indexOf('no working way in')).toBeLessThan(page.indexOf('## By campaign'));
  });

  it('separates ready steps from ones nobody finished', () => {
    const page = renderBrokenRefs(report());
    expect(page).toMatch(/by a step marked ready \| 1/);
    expect(page).toMatch(/only by steps nobody finished \| 0/);
  });

  it('refuses to report a clean account when there was no catalog', () => {
    const page = renderBrokenRefs(report({ catalogPresent: false }));
    expect(page).toMatch(/not.*the same as finding nothing broken/i);
    expect(page).toContain('npm run enrich');
    expect(page).not.toContain('## By campaign');
  });

  it('states the consequence without inventing runtime behaviour', () => {
    const page = renderBrokenRefs(report());
    expect(page).toContain('nothing can enrol through this goal');
    expect(page.toLowerCase()).not.toContain('always false');
  });
});

describe('renderBrokenRefsHtml', () => {
  it('embeds the entity on each location rather than reverse-mapping it', () => {
    // 246 of se232's locations reference more than one missing entity.
    const page = renderBrokenRefsHtml(report());
    expect(page).toContain('"entityId":"tag:646"');
    expect(page).not.toContain('ENTITY_OF');
  });

  it('is self-contained', () => {
    const page = renderBrokenRefsHtml(report());
    expect(page).not.toMatch(/<script[^>]+\bsrc=/);
    expect(page).not.toMatch(/https?:\/\/(?!www\.w3)/);
  });

  it('cannot be escaped by a campaign name containing markup', () => {
    const hostile = '</script><img src=x onerror=alert(1)>';
    const page = renderBrokenRefsHtml(
      report({
        campaigns: [
          {
            campaignId: '16',
            campaignName: hostile,
            status: 'live',
            activeContacts: null,
            locations: [location()],
            allEntryPointsBroken: false,
            goalsKilled: 0,
            goalsWorking: 1,
          },
        ],
      }),
    );
    const embedded = page.slice(page.indexOf('id="report-data"'));
    const payload = embedded.slice(embedded.indexOf('>') + 1, embedded.indexOf('</script>'));
    expect(payload).not.toContain('<');
  });

  it('says nothing could be checked when there was no catalog', () => {
    const page = renderBrokenRefsHtml(report({ catalogPresent: false }));
    expect(page).toMatch(/Nothing could be checked/i);
    expect(page).not.toContain('report-data');
  });
});
