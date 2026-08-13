import type { ImpactLocation, TagImpactReport } from '../analyze/tagImpact.js';
import { plainText } from './text.js';

/**
 * The caveat that must travel with every one of these numbers.
 *
 * This report sits beside someone deleting tags in a live client account, and
 * it sees campaign usage only. The word "safe" appears nowhere in this file by
 * design, and a test asserts it.
 */
const CAVEAT = [
  '> **This analysis sees campaign usage only.** Tags are also used in saved searches,',
  '> broadcasts, manual application, internal forms and integrations, none of which is',
  '> visible to this tool. A tag with no campaign references may still be in use elsewhere.',
];

/** A pipe inside a name would split a Markdown table cell. */
const cell = (text: string): string => plainText(text).replace(/\|/g, '\\|');

function describeLocation(location: ImpactLocation): string {
  const tag = `\`${location.tagId}\` ${cell(location.tagName)}`;
  if (location.kind === 'trigger') {
    const goal =
      location.nodeName === null || location.nodeName === undefined
        ? `cell ${location.cellId}`
        : `"${cell(location.nodeName)}"`;
    return `**Trigger** — goal ${goal} starts this campaign when ${tag} is applied`;
  }
  if (location.kind === 'decision') {
    // Decisions are nearly always nameless, so say what feeds it instead.
    const name =
      location.nodeName !== null && location.nodeName !== undefined
        ? `"${cell(location.nodeName)}"`
        : location.after !== undefined
          ? `the decision after "${cell(location.after)}" (cell ${location.cellId})`
          : `cell ${location.cellId}`;
    return `**Decision** — ${name} routes on ${tag}`;
  }
  const sequence =
    location.sequenceName === undefined ? 'an unnamed sequence' : `"${cell(location.sequenceName)}"`;
  const position = location.stepPosition === undefined ? '' : ` step ${location.stepPosition}`;
  const verb = location.edgeKind === 'removes' ? 'removes' : 'applies';
  return `**Sequence** — ${sequence}${position} ${verb} ${tag}`;
}

export function renderTagImpact(report: TagImpactReport): string {
  const lines: string[] = [
    `# Tag Impact Analysis — ${report.appName}`,
    '',
    `Generated ${report.analyzedAt}`,
    '',
    ...CAVEAT,
    '',
  ];

  const referenced = report.tags.filter((t) => t.locations.length > 0);
  const locations = report.campaigns.reduce((n, c) => n + c.locations.length, 0);

  lines.push('## Summary', '');
  lines.push('| | Count |', '|---|---|');
  lines.push(`| Tags requested | ${report.tags.length} |`);
  lines.push(`| Referenced by at least one campaign | ${referenced.length} |`);
  lines.push(`| No campaign references | ${report.noCampaignReferences.length} |`);
  lines.push(`| Campaigns affected | ${report.campaigns.length} |`);
  lines.push(`| Affected locations | ${locations} |`);
  lines.push('');

  if (report.campaigns.length > 0) {
    lines.push('## Affected campaigns', '', 'Ordered by number of affected locations.', '');
    for (const campaign of report.campaigns) {
      const name =
        campaign.campaignName === null
          ? `Campaign ${campaign.campaignId}`
          : cell(campaign.campaignName);
      lines.push(`### ${name} (${campaign.campaignId})`, '');
      lines.push(`_${campaign.locations.length} affected location(s)_`, '');
      for (const group of campaign.duplicatedGroups) {
        lines.push(
          `> References ${group.tagIds.length} tags from combine group **${cell(group.group)}** ` +
            `(${group.tagIds.join(', ')}) — after merging, those become duplicate steps.`,
          '',
        );
      }
      const order = { trigger: 0, decision: 1, step: 2 } as const;
      for (const location of [...campaign.locations].sort((a, b) => order[a.kind] - order[b.kind])) {
        lines.push(`- ${describeLocation(location)}`);
      }
      lines.push('');
    }
  }

  if (report.noCampaignReferences.length > 0) {
    lines.push('## No campaign references', '');
    lines.push('No campaign uses these tags as a trigger, in a decision, or in a sequence step.');
    lines.push('**Other uses are not visible to this tool** — see the note at the top.', '');
    lines.push('| Tag id | Name |', '|---|---|');
    for (const tag of report.noCampaignReferences) {
      lines.push(`| ${tag.tagId} | ${cell(tag.tagName)} |`);
    }
    lines.push('');
  }

  if (report.warnings.length > 0) {
    lines.push('## Warnings', '');
    for (const warning of report.warnings) lines.push(`- ${cell(warning)}`);
    lines.push('');
  }

  return lines.join('\n');
}
