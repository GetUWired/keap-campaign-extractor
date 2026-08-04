import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDecisionHtml } from '../src/parse/decisionHtml.js';

const html = readFileSync(new URL('./fixtures/synthetic-decision.html', import.meta.url), 'utf8');

describe('parseDecisionHtml', () => {
  it('reads the decision and flow id lists', () => {
    const result = parseDecisionHtml(html);
    expect(result.decisionIds).toEqual(['479', '481']);
    expect(result.flowIds).toEqual(['3', '32']);
  });

  it('aligns wrappers ordinally with the id lists', () => {
    const [first, second] = parseDecisionHtml(html).wrappers;
    expect(first).toMatchObject({ index: 0, decisionId: '479', flowId: '3' });
    expect(second).toMatchObject({ index: 1, decisionId: '481', flowId: '32' });
  });

  it('extracts a rule with both raw enum values and display labels', () => {
    const rule = parseDecisionHtml(html).wrappers[0]?.any[0]?.all[0];
    expect(rule).toMatchObject({
      ruleId: '100',
      subject: 'contact_Subject',
      subjectLabel: "Contact's",
      category: 'tags_FieldCategory',
      categoryLabel: 'Tags',
      constraint: 'notContains_Constraint',
      constraintLabel: "doesn't contain",
    });
  });

  it('captures every value with its _text label and the L stripped', () => {
    const rule = parseDecisionHtml(html).wrappers[0]?.any[0]?.all[0];
    expect(rule?.values).toEqual([
      { id: '1123', label: 'WooConnection Beta -> WooCommerce Beta Tester - Applied' },
      { id: '1145', label: 'Beta -> Second Tag' },
    ]);
  });

  it('groups two rules in the same inner group as a single AND group', () => {
    const wrapper = parseDecisionHtml(html).wrappers[1];
    expect(wrapper?.any).toHaveLength(1);
    expect(wrapper?.any[0]?.all.map((r) => r.ruleId)).toEqual(['200', '201']);
  });

  it('reads a rule with a populated field and no values', () => {
    const rule = parseDecisionHtml(html).wrappers[1]?.any[0]?.all[1];
    expect(rule?.field).toBe('Region');
    expect(rule?.categoryLabel).toBe('Info');
    expect(rule?.values).toEqual([]);
  });

  it('reads the else branch options and which is selected', () => {
    const result = parseDecisionHtml(html);
    expect(result.elseOptions).toEqual([
      { decisionId: '0', flowId: null, label: "Don't put them in a sequence", selected: true },
      { decisionId: '481', flowId: '32', label: '32', selected: false },
      { decisionId: '479', flowId: '3', label: '3', selected: false },
    ]);
    expect(result.elseSelected?.decisionId).toBe('0');
  });

  it('warns instead of throwing when id lists and wrappers disagree', () => {
    const broken = html.replace('value="479,481"', 'value="479"');
    const result = parseDecisionHtml(broken);
    expect(result.warnings.some((w) => /align|mismatch/i.test(w))).toBe(true);
    expect(result.wrappers).toHaveLength(2);
    expect(result.wrappers[1]?.decisionId).toBeNull();
  });

  it('returns an empty result with a warning for unrelated HTML', () => {
    const result = parseDecisionHtml('<html><body>Session expired</body></html>');
    expect(result.wrappers).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
