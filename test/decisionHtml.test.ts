import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDecisionHtml } from '../src/parse/decisionHtml.js';

const real = readFileSync(new URL('./fixtures/decision-987-34.html', import.meta.url), 'utf8');
const synthetic = readFileSync(
  new URL('./fixtures/synthetic-decision.html', import.meta.url),
  'utf8',
);

describe('parseDecisionHtml against the real campaign 987 decision 34 response', () => {
  it('reads the bracketed decision and flow id lists', () => {
    const result = parseDecisionHtml(real);
    expect(result.decisionIds).toEqual(['479', '481']);
    expect(result.flowIds).toEqual(['3', '32']);
  });

  it('pairs each wrapper with its decision and sequence', () => {
    const [first, second] = parseDecisionHtml(real).wrappers;
    expect(first).toMatchObject({ index: 0, decisionId: '479', flowId: '3' });
    expect(second).toMatchObject({ index: 1, decisionId: '481', flowId: '32' });
  });

  it('captures the goal context needed to rebuild the editor URL', () => {
    expect(parseDecisionHtml(real).wrappers[0]).toMatchObject({
      primaryKey: 'Marketing',
      secondaryKey: 'WebForm',
      secondaryKeyId: '681',
    });
  });

  it('reproduces the handoff worked example: negative branch routes to sequence 3', () => {
    const wrapper = parseDecisionHtml(real).wrappers[0];
    const rule = wrapper?.any[0]?.all[0];
    expect(wrapper?.any).toHaveLength(1);
    expect(rule).toMatchObject({
      ruleId: '561',
      subject: 'contact_Subject',
      subjectLabel: "Contact's",
      category: 'tags_FieldCategory',
      categoryLabel: 'Tags',
      field: 'tags_Field',
      constraint: 'notContains_Constraint',
      constraintLabel: "doesn't contain",
    });
    expect(rule?.values).toEqual([
      { id: '1123', label: 'WooConnection Beta -> WooCommerce Beta Tester - Applied' },
    ]);
  });

  it('reproduces the handoff worked example: positive branch routes to sequence 32', () => {
    const rule = parseDecisionHtml(real).wrappers[1]?.any[0]?.all[0];
    expect(rule?.ruleId).toBe('563');
    expect(rule?.constraint).toBe('contains_Constraint');
    expect(rule?.values[0]?.id).toBe('1123');
  });

  it('never mistakes a rule-menu div for a rule', () => {
    // The flow header carries rule_menu_button_off_1499, rule_menu_popup_1499
    // and rule_import_rules_menu_item_1499. A /^rule_(.+)$/ id match picks all
    // three up; only /^rule_(\d+)$/ rejects them.
    const ruleIds = parseDecisionHtml(real).wrappers.flatMap((w) =>
      w.any.flatMap((g) => g.all.map((r) => r.ruleId)),
    );
    expect(ruleIds).toEqual(['561', '563']);
  });

  it('reads the else branch from the select value attribute, with no selected option', () => {
    const result = parseDecisionHtml(real);
    expect(result.elseSelected?.decisionId).toBe('0');
    expect(result.elseSelected?.flowId).toBeNull();
    expect(result.elseOptions.map((o) => o.decisionId)).toEqual(['0', '481', '479']);
    expect(result.elseOptions.find((o) => o.decisionId === '481')?.flowId).toBe('32');
  });

  it('parses cleanly with no warnings', () => {
    expect(parseDecisionHtml(real).warnings).toEqual([]);
  });
});

describe('parseDecisionHtml edge cases', () => {
  it('captures every value in a multi-select rule', () => {
    const rule = parseDecisionHtml(synthetic).wrappers[0]?.any[0]?.all[0];
    expect(rule?.values).toEqual([
      { id: '9001', label: 'Example Category -> First Tag' },
      { id: '9002', label: 'Example Category -> Second Tag' },
    ]);
  });

  it('groups two rules in the same inner group as one AND group', () => {
    const wrapper = parseDecisionHtml(synthetic).wrappers[1];
    expect(wrapper?.any).toHaveLength(1);
    expect(wrapper?.any[0]?.all.map((r) => r.ruleId)).toEqual(['200', '201']);
  });

  it('reads a rule with a populated field and no values', () => {
    const rule = parseDecisionHtml(synthetic).wrappers[1]?.any[0]?.all[1];
    expect(rule?.field).toBe('Region');
    expect(rule?.categoryLabel).toBe('Info');
    expect(rule?.values).toEqual([]);
  });

  it('treats two inner groups under one outer group as an OR of AND groups', () => {
    const wrapper = parseDecisionHtml(synthetic).wrappers[2];
    expect(wrapper?.any).toHaveLength(2);
    expect(wrapper?.any.map((g) => g.all[0]?.constraint)).toEqual([
      'isEmpty_Constraint',
      'notEmpty_Constraint',
    ]);
  });

  it('resolves the else branch to a real sequence when one is chosen', () => {
    const result = parseDecisionHtml(synthetic);
    expect(result.elseSelected).toMatchObject({ decisionId: '481', flowId: '32' });
  });
});

describe('parseDecisionHtml failure reporting', () => {
  it('warns instead of throwing when id lists and wrappers disagree', () => {
    const broken = real.replace('value="[479, 481]"', 'value="[479]"');
    const result = parseDecisionHtml(broken);
    expect(result.warnings.some((w) => /align|mismatch/i.test(w))).toBe(true);
    expect(result.wrappers).toHaveLength(2);
    expect(result.wrappers[1]?.decisionId).toBeNull();
  });

  it('warns when a wrapper yields no rule groups rather than reporting silent success', () => {
    const gutted = real.replace(/ruleGroupOuter_\d+/g, 'somethingElse_1');
    const result = parseDecisionHtml(gutted);
    expect(result.wrappers.every((w) => w.any.length === 0)).toBe(true);
    expect(result.warnings.filter((w) => /no rule groups/i.test(w))).toHaveLength(2);
  });

  it('returns an empty result with a warning for unrelated HTML', () => {
    const result = parseDecisionHtml('<html><body>Session expired</body></html>');
    expect(result.wrappers).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('prefers the flow header over ordinal position and warns on disagreement', () => {
    const swapped = real.replace('value="[3, 32]"', 'value="[99, 32]"');
    const result = parseDecisionHtml(swapped);
    expect(result.wrappers[0]?.flowId).toBe('3');
    expect(result.warnings.some((w) => /flow header says 3/.test(w))).toBe(true);
  });
});

describe('parseDecisionHtml against the real campaign 584 decision 13 response', () => {
  const formDecision = readFileSync(
    new URL('./fixtures/decision-584-13.html', import.meta.url),
    'utf8',
  );

  it('handles a three-branch decision', () => {
    const result = parseDecisionHtml(formDecision);
    expect(result.decisionIds).toEqual(['386', '388', '390']);
    expect(result.wrappers.map((w) => w.flowId)).toEqual(['3', '4', '5']);
    expect(result.warnings).toEqual([]);
  });

  it('keeps raw enum values intact even when the server cannot resolve labels', () => {
    // Requested without secondaryKey/secondaryKeyId, Keap cannot resolve
    // display names for form-scoped fields and renders "<enum> (invalid)".
    // The machine-readable values are unaffected, so routing stays correct.
    const rule = parseDecisionHtml(formDecision).wrappers[0]?.any[0]?.all[0];
    expect(rule?.subject).toBe('formSubmission_Subject');
    expect(rule?.category).toBe('formSubmissionOptions_FieldCategory');
    expect(rule?.constraint).toBe('selected_Constraint');
    expect(rule?.field).toBe('formSubmissionOption3780_Field');
  });

  it('reports the degraded label rather than hiding it', () => {
    const rule = parseDecisionHtml(formDecision).wrappers[0]?.any[0]?.all[0];
    expect(rule?.subjectLabel).toContain('(invalid)');
  });

  it('reads field from a select here, though 987 serves it as a hidden input', () => {
    const byWrapper = parseDecisionHtml(formDecision).wrappers.map(
      (w) => w.any[0]?.all[0]?.field,
    );
    expect(byWrapper).toEqual([
      'formSubmissionOption3780_Field',
      'formSubmissionOption3782_Field',
      'formSubmissionOption3784_Field',
    ]);
  });

  it('captures a literal boolean rule value that has no _text companion', () => {
    // Form-option rules store `true` in a text input, not an entity id in a
    // hidden input paired with a label.
    const rule = parseDecisionHtml(formDecision).wrappers[0]?.any[0]?.all[0];
    expect(rule?.values).toEqual([{ id: 'true', label: null }]);
  });

  it('leaves goal context null when the editor was requested without it', () => {
    expect(parseDecisionHtml(formDecision).wrappers[0]).toMatchObject({
      primaryKey: 'Marketing',
      secondaryKey: null,
      secondaryKeyId: null,
    });
  });
});
