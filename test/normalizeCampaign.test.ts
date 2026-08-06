import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeCampaign, orderSteps } from '../src/normalize/campaign.js';
import type { NormalizedNode, RawEdge } from '../src/normalize/nodes.js';

const c584 = readFileSync(new URL('./fixtures/campaign-584-draft.xml', import.meta.url), 'utf8');
const c987 = readFileSync(new URL('./fixtures/campaign-987-draft.xml', import.meta.url), 'utf8');

function step(cellId: string, style: string): NormalizedNode {
  return {
    cellId,
    style,
    metaType: null,
    parent: '3',
    name: null,
    ready: null,
    published: null,
    config: {},
    lists: {},
    objectLists: {},
    references: { tagIds: [], tagCategoryIds: [] },
  };
}

const edge = (source: string, target: string): RawEdge => ({
  cellId: `e${source}${target}`,
  source,
  target,
  scope: '3',
});

describe('orderSteps', () => {
  it('walks from the start vertex, ignoring document order', () => {
    const steps = [
      step('17', 'email'),
      step('14', 'start'),
      step('25', 'email'),
      step('81', 'timerDelay'),
      step('27', 'timerDelay'),
    ];
    const edges = [edge('25', '27'), edge('27', '17'), edge('14', '81'), edge('81', '25')];
    const result = orderSteps(steps, edges);
    expect(result.ordered.map((s) => s.cellId)).toEqual(['14', '81', '25', '27', '17']);
    expect(result.verified).toBe(true);
    expect(result.warning).toBeNull();
  });

  it('falls back to document order when there is no start vertex', () => {
    const steps = [step('25', 'email'), step('27', 'timerDelay')];
    const result = orderSteps(steps, [edge('25', '27')]);
    expect(result.ordered.map((s) => s.cellId)).toEqual(['25', '27']);
    expect(result.verified).toBe(false);
    expect(result.warning).toMatch(/no start/i);
  });

  it('falls back when the walk does not reach every step', () => {
    const steps = [step('14', 'start'), step('81', 'timerDelay'), step('99', 'email')];
    const result = orderSteps(steps, [edge('14', '81')]);
    expect(result.verified).toBe(false);
    expect(result.warning).toMatch(/reached 2 of 3/i);
    expect(result.ordered).toHaveLength(3);
  });

  it('stops on a cycle rather than looping forever', () => {
    const steps = [step('14', 'start'), step('81', 'timerDelay')];
    const result = orderSteps(steps, [edge('14', '81'), edge('81', '14')]);
    expect(result.ordered).toHaveLength(2);
    expect(result.verified).toBe(true);
  });

  it('reports a branch rather than silently taking one arm', () => {
    const steps = [step('14', 'start'), step('81', 'timerDelay'), step('82', 'email')];
    const result = orderSteps(steps, [edge('14', '81'), edge('14', '82')]);
    expect(result.verified).toBe(false);
    expect(result.warning).toMatch(/branch/i);
  });

  it('handles a single step with no edges', () => {
    const result = orderSteps([step('14', 'start')], []);
    expect(result.ordered.map((s) => s.cellId)).toEqual(['14']);
    expect(result.verified).toBe(true);
  });

  it('treats an empty sequence as trivially ordered, not as a failure', () => {
    // 365 of 767 sequences across the account are empty. Reporting each as an
    // unwalkable order buried the 58 genuine partial walks.
    const result = orderSteps([], []);
    expect(result.ordered).toEqual([]);
    expect(result.verified).toBe(true);
    expect(result.warning).toBeNull();
  });
});

describe('normalizeCampaign against campaign 584', () => {
  const c = normalizeCampaign(c584, '', {}, '[MP-76] Satisfaction Survey');

  it('reads identity and publication state', () => {
    expect(c.funnelId).toBe('584');
    expect(c.appName).toBe('jordan');
    expect(c.name).toBe('[MP-76] Satisfaction Survey');
    expect(c.published).toBe(false);
    expect(c.hasUnpublishedChanges).toBe(false);
  });

  it('reproduces the handoff sequence order exactly', () => {
    const satisfied = c.sequences.find((s) => s.cellId === '3');
    expect(satisfied?.name).toBe('Satisfied');
    expect(satisfied?.orderVerified).toBe(true);
    expect(satisfied?.steps.map((s) => `${s.cellId}:${s.style}`)).toEqual([
      '14:start',
      '81:timerDelay',
      '25:email',
      '27:timerDelay',
      '17:email',
    ]);
  });

  it('numbers step positions from zero', () => {
    const satisfied = c.sequences.find((s) => s.cellId === '3');
    expect(satisfied?.steps.map((s) => s.position)).toEqual([0, 1, 2, 3, 4]);
  });

  it('finds the decision cell and its branches', () => {
    expect(c.decisions.map((d) => d.cellId)).toEqual(['13']);
    expect(c.decisions[0]?.branches.map((b) => `${b.decisionId}->${b.flowId}`)).toEqual([
      '386->3',
      '388->4',
      '390->5',
    ]);
  });

  it('leaves decision rules null when no criteria were supplied', () => {
    expect(c.decisions[0]?.branches[0]?.rules).toBeNull();
  });

  it('separates goals from sequences and notes', () => {
    expect(c.goals.length).toBeGreaterThan(0);
    for (const g of c.goals) expect(['flow', 'edge', 'notes', 'note']).not.toContain(g.style);
    expect(c.notes.length).toBeGreaterThan(0);
  });

  it('records campaign-level edges with their scope', () => {
    expect(c.edges.some((e) => e.scope === '1')).toBe(true);
    expect(c.edges.some((e) => e.scope === '3')).toBe(true);
  });

  it('detects the orphan goal the handoff documents', () => {
    // Handoff section 7, gotcha 6: cell 99, a newsletterRequest named "test",
    // wired to nothing.
    expect(c.orphans).toContain('99');
  });
});

describe('normalizeCampaign against campaign 987', () => {
  it('joins supplied criteria onto the matching decision branch', () => {
    const criteria = {
      '34': {
        decisionIds: ['479', '481'],
        flowIds: ['3', '32'],
        wrappers: [],
        elseOptions: [],
        elseSelected: null,
        warnings: [],
      },
    };
    const c = normalizeCampaign(c987, 'not empty', criteria);
    expect(c.decisions[0]?.branches[0]?.rules).not.toBeNull();
    expect(c.hasUnpublishedChanges).toBe(true);
  });

  it('surfaces tag references on apply-tag steps', () => {
    const c = normalizeCampaign(c987, '', {});
    const tagged = c.sequences.flatMap((s) => s.steps).filter((s) => s.style === 'tag');
    expect(tagged.length).toBeGreaterThan(0);
    expect(tagged.some((s) => s.references.tagIds.includes('1123'))).toBe(true);
  });

  it('warns on an undocumented style rather than throwing', () => {
    const doctored = c987.replace('style="tag"', 'style="somethingKeapAddedLater"');
    const c = normalizeCampaign(doctored, '', {});
    expect(c.warnings.some((w) => /somethingKeapAddedLater/.test(w))).toBe(true);
  });

  it('does not warn about styles already observed across the corpus', () => {
    // The warning must mean "Keap added a node type", not fire 47 times a run.
    const c = normalizeCampaign(c987, '', {});
    expect(c.warnings.filter((w) => /undocumented node style/.test(w))).toEqual([]);
  });
});
