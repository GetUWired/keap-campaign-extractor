import type { EntityCatalog } from '../api/catalog.js';
import type { NormalizedCampaign } from '../normalize/campaign.js';
import type { AccountGraph } from '../normalize/graph.js';
import { entityId } from '../normalize/graphEdges.js';
import { doesNothing, renderMermaid } from './mermaid.js';
import { type ProseContext, describeNode, nameIndex } from './prose.js';
import { plainText } from './text.js';

/** How each edge kind reads in a sentence, from this campaign's point of view. */
const EDGE_PHRASING: Record<string, string> = {
  applies: 'Applies tag',
  removes: 'Removes tag',
  'listens-for': 'Starts when tag applied',
  tests: 'Branches on tag',
  sends: 'Sends email',
  'entry-point': 'Entry point',
  'references-campaign': 'References campaign',
  'assigned-to': 'Assigned to',
  triggers: 'Triggers campaign',
};

function statusLine(campaign: NormalizedCampaign): string {
  const steps = campaign.sequences.reduce(
    (total, s) => total + s.steps.filter((step) => step.style !== 'start').length,
    0,
  );
  return [
    campaign.published ? 'Published' : 'Never published',
    campaign.hasUnpublishedChanges ? 'has unpublished changes' : 'no unpublished changes',
    `${campaign.sequences.length} sequences`,
    `${steps} steps`,
  ].join(' · ');
}

/** The one-line warning banner, or null when there is nothing to warn about. */
function findingsLine(campaign: NormalizedCampaign): string | null {
  const empty = campaign.sequences.filter((s) => doesNothing(s.steps)).length;
  const parts: string[] = [];
  if (empty > 0) parts.push(`${empty} empty sequence${empty === 1 ? '' : 's'}`);
  if (campaign.unconfigured.length > 0) {
    parts.push(`${campaign.unconfigured.length} unconfigured node(s)`);
  }
  if (campaign.orphans.length > 0) parts.push(`${campaign.orphans.length} orphan(s)`);
  return parts.length === 0 ? null : `> ⚠ ${parts.join(' · ')}`;
}

/**
 * What this campaign connects to, in both directions.
 *
 * Outbound edges say what it does to the account; inbound `triggers` edges say
 * what starts it. The second direction exists nowhere else per campaign — it is
 * only visible at account level in graph.json.
 */
function connections(campaign: NormalizedCampaign, graph: AccountGraph): string[] {
  const self = entityId('campaign', campaign.funnelId ?? '');
  // Graph labels come from the catalog too, so they need the same hygiene as
  // node names — an API name carrying newlines put four broken lines into a page.
  const labelOf = (id: string): string => {
    const label = graph.entities.find((e) => e.id === id)?.label;
    // An unresolved id reads better as "email 2399" than "email:2399".
    return label === undefined || label === null ? id.replace(':', ' ') : plainText(label);
  };

  // Deduplicated: two cells pointing at the same tag are one connection. The
  // per-cell detail lives in Goals and Sequences, where it belongs.
  const out = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.from === self) {
      out.add(`- ${EDGE_PHRASING[edge.kind] ?? edge.kind} → ${labelOf(edge.to)}`);
    } else if (edge.to === self && edge.kind === 'triggers') {
      out.add(`- Triggered by ← ${labelOf(edge.from)}`);
    }
  }
  return [...out].sort();
}

/**
 * One campaign as a Markdown page.
 *
 * Presents both components of every element: what it does, derived from style
 * and references, and the operator's own words for why. Intent is never
 * paraphrased — that inference is the LLM pass, and keeping it out is what
 * makes this testable.
 */
export function renderCampaign(
  campaign: NormalizedCampaign,
  graph: AccountGraph,
  catalog?: EntityCatalog,
): string {
  const context: ProseContext = { names: nameIndex(catalog) };
  const title = campaign.name === null ? `Campaign ${campaign.funnelId}` : plainText(campaign.name);
  const lines: string[] = [`# ${title} (${campaign.funnelId})`, '', statusLine(campaign), ''];

  const findings = findingsLine(campaign);
  if (findings !== null) lines.push(findings, '');

  // Said once at the top rather than on every line that lacks a name.
  if (context.names.size === 0) {
    lines.push('_No entity catalog was available, so ids are shown instead of names._', '');
  }

  lines.push('## Flow', '', '```mermaid', renderMermaid(campaign), '```', '');

  lines.push('## Goals', '');
  if (campaign.goals.length === 0) {
    lines.push('_None — nothing can enter this campaign._', '');
  } else {
    for (const goal of campaign.goals) lines.push(`- ${describeNode(goal, context)}`);
    lines.push('');
  }

  lines.push('## Sequences', '');
  if (campaign.sequences.length === 0) lines.push('_None._', '');
  for (const sequence of campaign.sequences) {
    const name = sequence.name === null ? `Sequence ${sequence.cellId}` : plainText(sequence.name);
    const state = [
      sequence.ready === true ? 'ready' : 'not marked ready',
      sequence.published === true ? 'published' : 'not published',
    ].join(' · ');
    lines.push(`### ${name}`, '', `_${state}_`, '');

    // A sequence whose only step is the start vertex does nothing, and saying
    // "1 step" would imply otherwise.
    if (doesNothing(sequence.steps)) {
      lines.push('_Empty — this sequence does nothing._', '');
      continue;
    }
    if (!sequence.orderVerified) {
      lines.push('_Step order could not be verified; shown in document order._', '');
    }
    const doing = sequence.steps.filter((step) => step.style !== 'start');
    for (const [index, step] of doing.entries()) {
      lines.push(`${index + 1}. ${describeNode(step, context)}`);
    }
    lines.push('');
  }

  lines.push('## Connections', '');
  const links = connections(campaign, graph);
  lines.push(...(links.length === 0 ? ['_None._'] : links), '');

  if (campaign.warnings.length > 0) {
    lines.push('## Warnings', '');
    for (const warning of campaign.warnings) lines.push(`- ${warning}`);
    lines.push('');
  }

  return lines.join('\n');
}
