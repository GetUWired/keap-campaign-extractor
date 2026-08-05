import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanName, parseCells, stripLongSuffix } from '../src/parse/cells.js';

const xml = readFileSync(new URL('./fixtures/synthetic-campaign.xml', import.meta.url), 'utf8');

describe('stripLongSuffix', () => {
  it('removes a trailing Java Long marker', () => {
    expect(stripLongSuffix('479L')).toBe('479');
  });

  it('leaves a plain number alone', () => {
    expect(stripLongSuffix('3')).toBe('3');
  });

  it('returns null for missing input', () => {
    expect(stripLongSuffix(undefined)).toBeNull();
  });

  it('leaves ordinary values that merely end in L intact', () => {
    // Decision rules can match literal strings. A bare /L$/ strip turns
    // "EMAIL" into "EMAI" — silent corruption of real rule values.
    expect(stripLongSuffix('EMAIL')).toBe('EMAIL');
    expect(stripLongSuffix('ALL')).toBe('ALL');
    expect(stripLongSuffix('MODEL')).toBe('MODEL');
    expect(stripLongSuffix('true')).toBe('true');
  });
});

describe('cleanName', () => {
  it('replaces the ~br~ line-break token with a space', () => {
    expect(cleanName('Thank You +~br~Testimonial Request')).toBe('Thank You + Testimonial Request');
  });

  it('collapses the whitespace it introduces', () => {
    expect(cleanName('A ~br~ B')).toBe('A B');
  });
});

describe('parseCells', () => {
  it('counts every mxCell including the two graph roots and the edge', () => {
    // ids 0, 1, 2, 3, 34, 44, 55, 70, e1
    expect(parseCells(xml).cellCount).toBe(9);
  });

  it('tallies styles, bucketing style-less cells under (none)', () => {
    const { styleCounts } = parseCells(xml);
    expect(styleCounts.decision).toBe(2);
    expect(styleCounts.flow).toBe(1);
    expect(styleCounts['(none)']).toBe(3); // ids 0, 1 and the edge e1
  });

  it('records an unknown style as data rather than throwing', () => {
    expect(parseCells(xml).styleCounts.someFutureNodeType).toBe(1);
  });

  it('extracts decision routing with the L suffix stripped', () => {
    const cell = parseCells(xml).decisions.find((d) => d.cellId === '34');
    expect(cell?.branches).toEqual([
      { decisionId: '479', flowId: '3' },
      { decisionId: '481', flowId: '32' },
    ]);
  });

  it('cleans ~br~ out of the decision name', () => {
    const cell = parseCells(xml).decisions.find((d) => d.cellId === '34');
    expect(cell?.name).toBe('Applied Already?');
  });

  it('warns about a decision cell with no routing rather than dropping it', () => {
    const inventory = parseCells(xml);
    const cell = inventory.decisions.find((d) => d.cellId === '55');
    expect(cell?.branches).toEqual([]);
    expect(inventory.warnings.some((w) => w.includes('55'))).toBe(true);
  });

  it('throws a clear error when the document has no root', () => {
    expect(() => parseCells('<nope/>')).toThrow(/mxGraphModel/);
  });
});

describe('parseCells against real captured campaigns', () => {
  const c584 = readFileSync(
    new URL('./fixtures/campaign-584-draft.xml', import.meta.url),
    'utf8',
  );
  const c987 = readFileSync(
    new URL('./fixtures/campaign-987-draft.xml', import.meta.url),
    'utf8',
  );

  it('matches the handoff cell count for campaign 584 exactly', () => {
    expect(c584.length).toBe(11_185);
    expect(parseCells(c584).cellCount).toBe(43);
  });

  it('finds decision cell 13 in campaign 584 with all three branches', () => {
    const cell = parseCells(c584).decisions.find((d) => d.cellId === '13');
    expect(cell?.branches).toEqual([
      { decisionId: '386', flowId: '3' },
      { decisionId: '388', flowId: '4' },
      { decisionId: '390', flowId: '5' },
    ]);
  });

  it('finds decision cell 34 in campaign 987 with the documented routing', () => {
    const cell = parseCells(c987).decisions.find((d) => d.cellId === '34');
    expect(cell?.branches).toEqual([
      { decisionId: '479', flowId: '3' },
      { decisionId: '481', flowId: '32' },
    ]);
  });

  it('surfaces node styles the handoff never documented', () => {
    // The handoff listed 10 styles. These four turned up in the first two real
    // campaigns; tag and tagApplied are the primitives the cross-campaign
    // relationship graph is built from.
    const styles = {
      ...parseCells(c584).styleCounts,
      ...parseCells(c987).styleCounts,
    };
    for (const style of ['edge', 'tag', 'tagApplied']) {
      expect(styles).toHaveProperty(style);
    }
  });

  it('parses both campaigns without warnings', () => {
    expect(parseCells(c584).warnings).toEqual([]);
    expect(parseCells(c987).warnings).toEqual([]);
  });
});
