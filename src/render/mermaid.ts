import type { NormalizedCampaign } from '../normalize/campaign.js';
import type { NormalizedNode } from '../normalize/nodes.js';
import { typeLabel } from './labels.js';
import { escapeMermaid, truncate } from './text.js';

/** Long enough to be meaningful, short enough that boxes stay readable. */
const LABEL_LIMIT = 44;

/**
 * A Mermaid id that cannot collide with syntax.
 *
 * Cell ids are numeric strings, and a bare number is not a valid Mermaid node
 * id, so every one is prefixed.
 */
const nodeId = (cellId: string): string => `n${cellId.replace(/\W/g, '_')}`;

/**
 * True when a sequence does nothing at all.
 *
 * Not simply `steps.length === 0`. A sequence whose only step is the `start`
 * vertex has one step and still does nothing — 28 such sequences exist across
 * the account, including both of campaign 987's terminal branches. Counting
 * only the zero-step case undercounts the account's dead sequences by 28,
 * reporting 365 where 393 do nothing.
 */
export function doesNothing(steps: { style: string }[]): boolean {
  return steps.every((step) => step.style === 'start');
}

/** A node's own name, falling back to what it does when it has none. */
function label(node: NormalizedNode): string {
  const name = node.name ?? '';
  return escapeMermaid(truncate(name.trim() === '' ? typeLabel(node) : name, LABEL_LIMIT));
}

/**
 * The campaign-level flowchart: goals, decisions and sequences.
 *
 * Steps are deliberately absent. The median campaign has 14 renderable nodes
 * and 4 campaign-level edges, but the largest has 112 nodes and 86 steps —
 * drawing those would produce a hairball nobody reads. Steps are linear by
 * construction and belong in an ordered list, which the page provides.
 */
export function renderMermaid(campaign: NormalizedCampaign): string {
  const lines = ['flowchart TD'];
  const rendered = new Set<string>();

  for (const goal of campaign.goals) {
    lines.push(`  ${nodeId(goal.cellId)}(["${label(goal)}"])`);
    rendered.add(goal.cellId);
  }

  for (const decision of campaign.decisions) {
    lines.push(`  ${nodeId(decision.cellId)}{"${label(decision)}"}`);
    rendered.add(decision.cellId);
  }

  for (const sequence of campaign.sequences) {
    // An empty sequence is a dead end a reader must not miss.
    const doing = sequence.steps.filter((s) => s.style !== 'start').length;
    const suffix = doesNothing(sequence.steps)
      ? ' (empty)'
      : ` (${doing} step${doing === 1 ? '' : 's'})`;
    lines.push(`  ${nodeId(sequence.cellId)}["${label(sequence)}${suffix}"]`);
    rendered.add(sequence.cellId);
  }

  for (const edge of campaign.edges) {
    if (edge.scope !== '1') continue;
    if (!rendered.has(edge.source) || !rendered.has(edge.target)) continue;
    lines.push(`  ${nodeId(edge.source)} --> ${nodeId(edge.target)}`);
  }

  return lines.join('\n');
}
