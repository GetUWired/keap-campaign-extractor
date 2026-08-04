import { type CheerioAPI, load } from 'cheerio';
import { stripLongSuffix } from './cells.js';

/**
 * The querying function returned by load().
 *
 * Node types (AnyNode, Element) live in `domhandler`, which cheerio depends on
 * but does not re-export. Deriving the selection type from CheerioAPI itself
 * keeps us off a transitive dependency we do not declare.
 */
type Q = CheerioAPI;
type Selection = ReturnType<Q>;

export interface RuleValue {
  id: string;
  label: string | null;
}

export interface Rule {
  ruleId: string;
  subject: string | null;
  subjectLabel: string | null;
  category: string | null;
  categoryLabel: string | null;
  field: string | null;
  fieldLabel: string | null;
  constraint: string | null;
  constraintLabel: string | null;
  values: RuleValue[];
}

/** One AND group: every rule inside must hold. */
export interface RuleGroup {
  groupId: string;
  all: Rule[];
}

/** One target sequence. `any` is an OR over AND groups. */
export interface DecisionWrapper {
  index: number;
  decisionId: string | null;
  flowId: string | null;
  any: RuleGroup[];
}

export interface ElseOption {
  decisionId: string;
  flowId: string | null;
  label: string;
  selected: boolean;
}

export interface DecisionCriteria {
  decisionIds: string[];
  flowIds: string[];
  wrappers: DecisionWrapper[];
  elseOptions: ElseOption[];
  elseSelected: ElseOption | null;
  warnings: string[];
}

/**
 * Tolerates "479,481", "[479, 481]" and whitespace-separated forms alike.
 * The handoff recorded the rendered representation, not the raw attribute, so
 * the exact delimiter is unconfirmed.
 */
function extractIds(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.match(/\d+/g) ?? [];
}

/**
 * Returns the capture from the first class token matching `re`, else null.
 *
 * Anchored matching matters: a naive [class*="rule"] selector would treat
 * `ruleGroupOuter_1` as a rule.
 */
function classCapture($el: Selection, re: RegExp): string | null {
  const classes = ($el.attr('class') ?? '').split(/\s+/).filter(Boolean);
  for (const token of classes) {
    const match = re.exec(token);
    if (match?.[1]) return match[1];
  }
  return null;
}

/** Finds a control by `name`, falling back to `id`. */
function control(scope: Selection, name: string): Selection {
  const byName = scope.find(`[name="${name}"]`).first();
  if (byName.length > 0) return byName;
  return scope.find(`#${name}`).first();
}

function readControl(
  scope: Selection,
  name: string,
): { value: string | null; label: string | null } {
  const el = control(scope, name);
  if (el.length === 0) return { value: null, label: null };

  if (el.is('select')) {
    const selected = el.find('option[selected]').first();
    const option = selected.length > 0 ? selected : el.find('option').first();
    if (option.length === 0) return { value: null, label: null };
    return {
      value: option.attr('value') ?? null,
      label: option.text().trim() || null,
    };
  }

  const value = el.attr('value') ?? null;
  return { value: value === '' ? null : value, label: null };
}

function parseRule($: Q, ruleEl: Selection, ruleId: string): Rule {
  const subject = readControl(ruleEl, `subject_${ruleId}`);
  const category = readControl(ruleEl, `category_${ruleId}`);
  const field = readControl(ruleEl, `field_${ruleId}`);
  const constraint = readControl(ruleEl, `constraint_${ruleId}`);

  const values: RuleValue[] = [];
  ruleEl.find(`[name^="value_${ruleId}_"]`).each((_, node) => {
    const el = $(node);
    const name = el.attr('name');
    if (!name || name.endsWith('_text')) return;
    const id = stripLongSuffix(el.attr('value'));
    if (id === null) return;
    // The _text companion is the only place tag and custom-field display
    // names appear anywhere in the extraction surface.
    const label = ruleEl.find(`[name="${name}_text"]`).first().attr('value') ?? null;
    values.push({ id, label: label === '' ? null : label });
  });

  return {
    ruleId,
    subject: subject.value,
    subjectLabel: subject.label,
    category: category.value,
    categoryLabel: category.label,
    field: field.value,
    fieldLabel: field.label,
    constraint: constraint.value,
    constraintLabel: constraint.label,
    values,
  };
}

export function parseDecisionHtml(html: string): DecisionCriteria {
  const $ = load(html);
  const warnings: string[] = [];

  const decisionIds = extractIds($('#decisionIds').attr('value'));
  const flowIds = extractIds($('#flowIds').attr('value'));

  const wrappers: DecisionWrapper[] = [];

  $('section.decisionWrapper').each((index, sectionNode) => {
    const section = $(sectionNode);
    const groups: RuleGroup[] = [];

    section.find('div').each((_, outerNode) => {
      const outer = $(outerNode);
      if (classCapture(outer, /^ruleGroupOuter_(.+)$/) === null) return;

      outer.find('div').each((__, innerNode) => {
        const inner = $(innerNode);
        const groupId = classCapture(inner, /^ruleGroupInner_(.+)$/);
        if (groupId === null) return;

        const all: Rule[] = [];
        inner.find('div').each((___, ruleNode) => {
          const ruleEl = $(ruleNode);
          const ruleId = classCapture(ruleEl, /^rule_(.+)$/);
          if (ruleId === null) return;
          all.push(parseRule($, ruleEl, ruleId));
        });

        groups.push({ groupId, all });
      });
    });

    // Ordinal alignment: section[i] pairs with decisionIds[i] / flowIds[i].
    wrappers.push({
      index,
      decisionId: decisionIds[index] ?? null,
      flowId: flowIds[index] ?? null,
      any: groups,
    });
  });

  if (wrappers.length === 0) {
    warnings.push(
      'no section.decisionWrapper elements found — this may not be decision editor HTML',
    );
  }
  if (decisionIds.length !== wrappers.length || flowIds.length !== wrappers.length) {
    warnings.push(
      `id lists do not align with wrappers: ${decisionIds.length} decisionIds, ` +
        `${flowIds.length} flowIds, ${wrappers.length} wrappers — mismatch, ordinal pairing unreliable`,
    );
  }

  const elseOptions: ElseOption[] = [];
  $('#elseRulesOptions option').each((_, node) => {
    const option = $(node);
    const decisionId = option.attr('value');
    if (decisionId === undefined) return;
    // Option values are decisionIds; option labels are flowIds.
    const label = option.text().trim();
    elseOptions.push({
      decisionId,
      flowId: /^\d+$/.test(label) ? label : null,
      label,
      selected: option.attr('selected') !== undefined,
    });
  });

  return {
    decisionIds,
    flowIds,
    wrappers,
    elseOptions,
    elseSelected: elseOptions.find((o) => o.selected) ?? null,
    warnings,
  };
}
