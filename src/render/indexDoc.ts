import type { NormalizedCampaign } from '../normalize/campaign.js';
import type { AccountGraph } from '../normalize/graph.js';
import { doesNothing } from './mermaid.js';
import { plainText } from './text.js';

/**
 * The account listing.
 *
 * Columns answer one question — how much work is this campaign — so
 * incompleteness sits beside publication state rather than being buried in the
 * page. A reader scanning this should be able to pick the campaigns that need
 * real attention without opening any of them.
 */
export function renderIndex(campaigns: NormalizedCampaign[], graph: AccountGraph): string {
  const rows = [...campaigns].sort((a, b) => Number(a.funnelId ?? 0) - Number(b.funnelId ?? 0));

  const lines: string[] = [
    '# Campaigns',
    '',
    `${rows.length} campaigns · ${graph.entities.length} entities · ${graph.edges.length} edges`,
    '',
    '| Campaign | Status | Sequences | Steps | Unconfigured | Empty seq |',
    '|---|---|---|---|---|---|',
  ];

  for (const campaign of rows) {
    const name = campaign.name === null ? `Campaign ${campaign.funnelId}` : plainText(campaign.name);
    const steps = campaign.sequences.reduce(
      (total, s) => total + s.steps.filter((step) => step.style !== 'start').length,
      0,
    );
    const empty = campaign.sequences.filter((s) => doesNothing(s.steps)).length;
    const status = campaign.published
      ? campaign.hasUnpublishedChanges
        ? 'published, changes pending'
        : 'published'
      : 'never published';
    lines.push(
      `| [${name}](${campaign.funnelId}.md) | ${status} | ${campaign.sequences.length} | ` +
        `${steps} | ${campaign.unconfigured.length} | ${empty} |`,
    );
  }

  lines.push('');
  return lines.join('\n');
}
