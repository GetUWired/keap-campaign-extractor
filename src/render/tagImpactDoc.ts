import type {
  CampaignImpact,
  CampaignStatus,
  ImpactLocation,
  TagImpactReport,
} from '../analyze/tagImpact.js';
import { plainText } from './text.js';

/** The three states of §14, plus the absence of an answer. */
const STATUS_LABEL: Record<CampaignStatus, string> = {
  live: 'Live',
  stopped: 'Published, then stopped',
  'never-published': 'Never published',
  unknown: 'Status unknown',
};

const STATUS_ORDER: CampaignStatus[] = ['live', 'stopped', 'never-published', 'unknown'];

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

/**
 * What is being done to the tag: no group means delete outright, a group means
 * merge into the others sharing it.
 *
 * `showGroup` is false when the whole list uses one group name, which then says
 * only "merging" — printing "merge to merge" on 700 rows is noise.
 */
function describeLocation(location: ImpactLocation, showGroup: boolean): string {
  const change =
    location.change === 'none'
      ? ''
      : location.group === null
        ? ' [delete]'
        : showGroup
          ? ` [merge → ${cell(location.group)}]`
          : ' [merge]';
  const tag = `\`${location.tagId}\` ${cell(location.tagName)}${change}`;
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

/** The status line under a campaign heading: what it is, and who is in it. */
function describeStatus(campaign: CampaignImpact): string {
  const parts = [`**${STATUS_LABEL[campaign.status]}**`];
  if (campaign.plannedDeletion) parts.push('**on the campaign deletion list**');
  if (campaign.status === 'live' && campaign.publishedDate !== null) {
    parts.push(`published ${cell(campaign.publishedDate)}`);
  }
  if (campaign.activeContacts !== null) {
    const contacts = campaign.activeContacts;
    parts.push(`${contacts} active contact${contacts === 1 ? '' : 's'}`);
  }
  parts.push(`${campaign.locations.length} affected location(s)`);
  return parts.join(' · ');
}

export function renderTagImpact(report: TagImpactReport): string {
  const audit = report.mode === 'audit';
  const lines: string[] = [
    `# Tag ${audit ? 'Usage Audit' : 'Impact Analysis'} — ${report.appName}`,
    '',
    `Generated ${report.analyzedAt}`,
    '',
    ...CAVEAT,
    '',
  ];

  const groups = new Set(report.campaigns.flatMap((c) => c.locations.map((l) => l.group)));
  groups.delete(null);
  const showGroup = groups.size > 1;

  const referenced = report.tags.filter((t) => t.locations.length > 0);
  const locations = report.campaigns.reduce((n, c) => n + c.locations.length, 0);

  lines.push('## Summary', '');
  lines.push('| | Count |', '|---|---|');
  lines.push(`| Tags ${audit ? 'in the account' : 'requested'} | ${report.tags.length} |`);
  lines.push(`| Referenced by at least one campaign | ${referenced.length} |`);
  lines.push(`| No campaign references | ${report.noCampaignReferences.length} |`);
  lines.push(`| Campaigns ${audit ? 'using a tag' : 'affected'} | ${report.campaigns.length} |`);
  if (report.plannedDeletions > 0) {
    lines.push(`| …themselves being deleted | ${report.plannedDeletions} |`);
    lines.push(
      `| …still affected afterwards | ${report.campaigns.length - report.plannedDeletions} |`,
    );
  }
  lines.push(`| ${audit ? 'Tag' : 'Affected'} locations | ${locations} |`);
  lines.push('');

  // A live campaign losing an entry point is the finding; a never-published one
  // losing the same entry point is housekeeping. The split says which is which.
  const byStatus = STATUS_ORDER.map((status) => ({
    status,
    campaigns: report.campaigns.filter((c) => c.status === status),
  })).filter((row) => row.campaigns.length > 0);

  if (byStatus.length > 0) {
    lines.push(`### ${audit ? 'Campaigns' : 'Affected campaigns'} by status`, '');
    lines.push('| Status | Campaigns | Locations | Active contacts |', '|---|---|---|---|');
    for (const row of byStatus) {
      const rowLocations = row.campaigns.reduce((n, c) => n + c.locations.length, 0);
      const contacts = row.campaigns.reduce((n, c) => n + (c.activeContacts ?? 0), 0);
      lines.push(
        `| ${STATUS_LABEL[row.status]} | ${row.campaigns.length} | ${rowLocations} | ${contacts} |`,
      );
    }
    lines.push('');
  }

  if (report.campaigns.length > 0) {
    lines.push(
      audit ? '## Campaigns using tags' : '## Affected campaigns',
      '',
      'Live campaigns first, then by number of affected locations.',
      '',
    );
    for (const campaign of report.campaigns) {
      const name =
        campaign.campaignName === null
          ? `Campaign ${campaign.campaignId}`
          : cell(campaign.campaignName);
      lines.push(`### ${name} (${campaign.campaignId})`, '');
      lines.push(describeStatus(campaign), '');
      for (const group of campaign.duplicatedGroups) {
        lines.push(
          `> References ${group.tagIds.length} tags from combine group **${cell(group.group)}** ` +
            `(${group.tagIds.join(', ')}) — after merging, those become duplicate steps.`,
          '',
        );
      }
      const order = { trigger: 0, decision: 1, step: 2 } as const;
      for (const location of [...campaign.locations].sort((a, b) => order[a.kind] - order[b.kind])) {
        lines.push(`- ${describeLocation(location, showGroup)}`);
      }
      lines.push('');
    }
  }

  if (report.noCampaignReferences.length > 0) {
    lines.push('## No campaign references', '');
    lines.push('No campaign uses these tags as a trigger, in a decision, or in a sequence step.');
    lines.push('**Other uses are not visible to this tool** — see the note at the top.', '');
    lines.push('| Tag id | Name | Change |', '|---|---|---|');
    for (const tag of report.noCampaignReferences) {
      const change =
        tag.change === 'none'
          ? '—'
          : tag.group === null
            ? 'delete'
            : showGroup
              ? `merge → ${cell(tag.group)}`
              : 'merge';
      lines.push(`| ${tag.tagId} | ${cell(tag.tagName)} | ${change} |`);
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
