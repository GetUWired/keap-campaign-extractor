import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseNodes } from '../src/normalize/nodes.js';

const c584 = readFileSync(new URL('./fixtures/campaign-584-draft.xml', import.meta.url), 'utf8');
const c987 = readFileSync(new URL('./fixtures/campaign-987-draft.xml', import.meta.url), 'utf8');

describe('parseNodes', () => {
  it('separates vertices from edges', () => {
    const g = parseNodes(c584);
    expect(g.nodes.length).toBeGreaterThan(0);
    expect(g.edges.length).toBeGreaterThan(0);
    const nodeIds = new Set(g.nodes.map((n) => n.cellId));
    for (const e of g.edges) expect(nodeIds.has(e.cellId)).toBe(false);
  });

  it('records each edge with its scope', () => {
    // Verified against the raw XML: inside flow 3, 14->81, 81->25, 25->27, 27->17.
    const inFlow3 = parseNodes(c584).edges.filter((e) => e.scope === '3');
    expect(inFlow3.map((e) => `${e.source}->${e.target}`).sort()).toEqual(
      ['14->81', '25->27', '27->17', '81->25'].sort(),
    );
  });

  it('captures every attribute verbatim in config', () => {
    const node = parseNodes(c987).nodes.find((n) => n.cellId === '15');
    expect(node?.style).toBe('tag');
    expect(node?.config.isApply).toBe('true');
    expect(node?.config.ready).toBe('1');
  });

  it('captures scalar arrays into lists, with the L stripped', () => {
    // <Array as="tagIds"><add value="1123L"/></Array>
    const node = parseNodes(c987).nodes.find((n) => n.cellId === '15');
    expect(node?.lists.tagIds).toEqual(['1123']);
  });

  it('captures object arrays into objectLists', () => {
    // <Array as="decisions"><Object decisionId="479L" flowId="3"/>…</Array>
    const node = parseNodes(c987).nodes.find((n) => n.cellId === '34');
    expect(node?.objectLists.decisions).toEqual([
      { decisionId: '479', flowId: '3' },
      { decisionId: '481', flowId: '32' },
    ]);
  });

  it('lifts tagIds into references', () => {
    const node = parseNodes(c987).nodes.find((n) => n.cellId === '15');
    expect(node?.references.tagIds).toEqual(['1123']);
  });

  it('lifts foreign-key attributes into references', () => {
    const withEmail = parseNodes(c584).nodes.find((n) => n.config.marketingEmailId !== undefined);
    expect(withEmail).toBeDefined();
    expect(withEmail?.references.marketingEmailId).toMatch(/^\d+$/);
    expect(withEmail?.references.marketingEmailId).not.toContain('L');
  });

  it('does not lift structural ids that are not entity references', () => {
    // funnelId identifies the campaign itself, not something it points at.
    const root = parseNodes(c987).nodes.find((n) => n.config.appName !== undefined);
    expect(root).toBeDefined();
    expect(root?.references.funnelId).toBeUndefined();
  });

  it('cleans ~br~ out of names', () => {
    const named = parseNodes(c584).nodes.filter((n) => n.name !== null);
    expect(named.length).toBeGreaterThan(0);
    for (const n of named) expect(n.name).not.toContain('~br~');
  });

  it('normalises ready and published to booleans', () => {
    const node = parseNodes(c987).nodes.find((n) => n.cellId === '15');
    expect(node?.ready).toBe(true);
    expect(node?.published).toBe(true);
  });

  it('tallies styles', () => {
    expect(parseNodes(c987).styleCounts.tag).toBe(1);
    expect(parseNodes(c987).styleCounts.decision).toBe(1);
  });

  it('throws a clear error when the document has no root', () => {
    expect(() => parseNodes('<nope/>')).toThrow(/mxGraphModel/);
  });
});
