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

/**
 * The goal context a decision hangs off. Carried as attributes on the rule
 * group and rule divs, and needed to rebuild the decisionEditor URL:
 * secondaryKey/secondaryKeyId become query parameters.
 */
export interface RuleContext {
  primaryKey: string | null;
  secondaryKey: string | null;
  secondaryKeyId: string | null;
}

/** One target sequence. `any` is an OR over AND groups. */
export interface DecisionWrapper extends RuleContext {
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

/** The real response serves "[3, 32]"; tolerate "3,32" and whitespace forms too. */
function extractIds(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.match(/\d+/g) ?? [];
}

/**
 * Returns the capture from the element's id attribute, else null.
 *
 * The structural markers live on `id`, not `class`: the real markup is
 * <div id="ruleGroupOuter_1499" class="ruleGroupOuter">. The class carries no
 * suffix, so matching class tokens finds nothing at all.
 *
 * Callers must anchor on \d+ rather than .+ — the flow header contains
 * rule_menu_button_off_1499, rule_menu_popup_1499 and
 * rule_import_rules_menu_item_1499, every one of which a /^rule_(.+)$/ match
 * would happily mistake for a rule.
 */
function idCapture($el: Selection, re: RegExp): string | null {
  const id = $el.attr('id');
  if (!id) return null;
  const match = re.exec(id);
  return match?.[1] ?? null;
}

function blankToNull(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  return value.trim() === '' ? null : value;
}

/**
 * The response echoes back whatever secondaryKey/secondaryKeyId the request
 * supplied — it does not derive them. Requested bare, they come back empty, so
 * blanks are normalised to null rather than stored as "".
 */
function readContext($el: Selection): RuleContext {
  return {
    primaryKey: blankToNull($el.attr('primarykey')),
    secondaryKey: blankToNull($el.attr('secondarykey')),
    secondaryKeyId: blankToNull(stripLongSuffix($el.attr('secondarykeyid'))),
  };
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
  ruleEl.find(`[name^="value_${ruleId}_"], [id^="value_${ruleId}_"]`).each((_, node) => {
    const el = $(node);
    const key = el.attr('name') ?? el.attr('id');
    if (!key || !/^value_\d+_\d+$/.test(key)) return;
    const id = stripLongSuffix(el.attr('value'));
    if (id === null) return;
    if (values.some((v) => v.id === id)) return;
    // The _text companion is the only place tag and custom-field display
    // names appear anywhere in the extraction surface.
    const labelEl = control(ruleEl, `${key}_text`);
    const label = labelEl.attr('value') ?? null;
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
    let context: RuleContext = { primaryKey: null, secondaryKey: null, secondaryKeyId: null };

    section.find('div').each((_, outerNode) => {
      const outer = $(outerNode);
      if (idCapture(outer, /^ruleGroupOuter_(\d+)$/) === null) return;
      context = readContext(outer);

      outer.find('div').each((__, innerNode) => {
        const inner = $(innerNode);
        const groupId = idCapture(inner, /^ruleGroupInner_(\d+)$/);
        if (groupId === null) return;

        const all: Rule[] = [];
        inner.find('div').each((___, ruleNode) => {
          const ruleEl = $(ruleNode);
          const ruleId = idCapture(ruleEl, /^rule_(\d+)$/);
          if (ruleId === null) return;
          all.push(parseRule($, ruleEl, ruleId));
        });

        groups.push({ groupId, all });
      });
    });

    // The flow header names its sequence directly (<span id="flow_3">), which
    // beats ordinal alignment. Ordinal is the fallback.
    const flowSpanId = section.find('span[id^="flow_"]').first().attr('id');
    const flowFromHeader = flowSpanId ? flowSpanId.slice('flow_'.length) : null;
    const flowFromOrdinal = flowIds[index] ?? null;

    if (flowFromHeader && flowFromOrdinal && flowFromHeader !== flowFromOrdinal) {
      warnings.push(
        `wrapper ${index}: flow header says ${flowFromHeader} but ordinal position says ` +
          `${flowFromOrdinal} — using the header`,
      );
    }

    if (groups.length === 0) {
      warnings.push(
        `wrapper ${index} contains no rule groups — either the sequence has no entry ` +
          `criteria, or the markup shape has changed`,
      );
    }

    wrappers.push({
      index,
      decisionId: decisionIds[index] ?? null,
      flowId: flowFromHeader ?? flowFromOrdinal,
      any: groups,
      ...context,
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

  const elseSelect = $('#elseRulesOptions');
  const elseOptions: ElseOption[] = [];

  // The live markup marks the choice with a `value` attribute on the <select>
  // itself and no `selected` option, so both signals have to be read.
  const selectValue = elseSelect.attr('value') ?? null;

  elseSelect.find('option').each((_, node) => {
    const option = $(node);
    const decisionId = option.attr('value');
    if (decisionId === undefined) return;
    // Option values are decisionIds; option labels are flowIds.
    const label = option.text().trim();
    elseOptions.push({
      decisionId,
      flowId: /^\d+$/.test(label) ? label : null,
      label,
      selected: option.attr('selected') !== undefined || decisionId === selectValue,
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
