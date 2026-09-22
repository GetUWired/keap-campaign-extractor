import type { BrokenLocation, BrokenRefsReport } from '../analyze/brokenRefs.js';
import type { CampaignStatus } from '../analyze/tagImpact.js';
import { plainText } from './text.js';

const STATUS_LABEL: Record<CampaignStatus, string> = {
  live: 'Live',
  stopped: 'Published, then stopped',
  'never-published': 'Never published',
  unknown: 'Status unknown',
};

/** A pipe inside a name would split a Markdown table cell. */
const cell = (text: string): string => plainText(text).replace(/\|/g, '\\|');

/**
 * What a reference to a missing entity does at that location.
 *
 * Stated mechanically. What Keap does at runtime when a decision tests a tag
 * that no longer exists was not observed, and guessing it here would put an
 * invented behaviour in front of someone about to act on it.
 */
const CONSEQUENCE: Record<string, string> = {
  trigger: 'nothing can enrol through this goal',
  decision: 'this branch tests something that no longer exists',
  step: 'this step acts on something that no longer exists',
  other: 'this node points at something that no longer exists',
};

export function describeBrokenLocation(location: BrokenLocation, name: string | null): string {
  const missing = name === null ? `\`${location.entityId}\`` : `\`${location.entityId}\` ${cell(name)}`;
  const what = `${CONSEQUENCE[location.kind] ?? CONSEQUENCE.other} (${missing})`;
  if (location.kind === 'trigger') {
    const goal =
      location.nodeName === null || location.nodeName === undefined
        ? `cell ${location.cellId}`
        : `"${cell(location.nodeName)}"`;
    return `**Trigger** — goal ${goal}: ${what}`;
  }
  if (location.kind === 'decision') {
    const name =
      location.nodeName !== null && location.nodeName !== undefined && location.nodeName !== ''
        ? `"${cell(location.nodeName)}"`
        : location.after !== undefined
          ? `the decision after "${cell(location.after)}" (cell ${location.cellId})`
          : `cell ${location.cellId}`;
    return `**Decision** — ${name}: ${what}`;
  }
  if (location.kind === 'step') {
    const sequence =
      location.sequenceName === undefined
        ? 'an unnamed sequence'
        : `"${cell(location.sequenceName)}"`;
    const position = location.stepPosition === undefined ? '' : ` step ${location.stepPosition}`;
    return `**Sequence** — ${sequence}${position} (${location.edgeKind}): ${what}`;
  }
  return `**${cell(location.edgeKind)}** — cell ${location.cellId}: ${what}`;
}

export function renderBrokenRefs(report: BrokenRefsReport): string {
  const { counts } = report;
  const names = new Map(report.references.map((r) => [r.entityId, r.name]));
  const lines: string[] = [
    `# Broken References — ${report.appName}`,
    '',
    `Generated ${report.analyzedAt}`,
    '',
    '> **These are references campaigns still hold to entities the account no longer has.**',
    "> Nothing here is a planned change — it is what is already in place. Comparison is against",
    "> the account's entity catalog at the time it was fetched, so a tag created since will look",
    '> missing until enrich runs again.',
    '',
  ];

  if (!report.catalogPresent) {
    lines.push(
      '## No catalog',
      '',
      'The graph holds no comparison against the account, so nothing can be reported as missing.',
      'This is **not** the same as finding nothing broken. Run:',
      '',
      '```bash',
      `KEAP_API_KEY=… npm run enrich -- --app ${report.appName}`,
      `npm run normalize -- --app ${report.appName}`,
      '```',
      '',
    );
    return lines.join('\n');
  }

  lines.push('## Summary', '');
  lines.push('| | Count |', '|---|---|');
  lines.push(`| Missing entities referenced | ${counts.references} |`);
  lines.push(`| …by a step marked ready | ${counts.readyReferences} |`);
  lines.push(`| …only by steps nobody finished | ${counts.neverBuiltReferences} |`);
  lines.push(`| Locations holding a broken reference | ${counts.locations} |`);
  lines.push(`| Campaigns affected | ${counts.campaigns} |`);
  lines.push(`| …live right now | ${counts.liveCampaigns} |`);
  lines.push('');

  const kinds = Object.entries(counts.byKind).sort((a, b) => b[1] - a[1]);
  if (kinds.length > 0) {
    lines.push('| Entity kind | Missing |', '|---|---|');
    for (const [kind, n] of kinds) lines.push(`| ${kind} | ${n} |`);
    lines.push('');
  }

  const dead = report.campaigns.filter((c) => c.allTriggersBroken);
  if (dead.length > 0) {
    lines.push(
      '## Campaigns with no working way in',
      '',
      'Every tag goal in these campaigns listens for a tag the account no longer has, so nothing',
      'can enrol through them. Live ones are the ones to look at first.',
      '',
      '| Campaign | Id | Status | Active contacts |',
      '|---|---|---|---|',
    );
    for (const campaign of dead) {
      const name =
        campaign.campaignName === null
          ? `Campaign ${campaign.campaignId}`
          : cell(campaign.campaignName);
      lines.push(
        `| ${name} | ${campaign.campaignId} | ${STATUS_LABEL[campaign.status]} | ${campaign.activeContacts ?? '—'} |`,
      );
    }
    lines.push('');
  }

  lines.push('## By campaign', '', 'Campaigns with no way in first, then live ones.', '');
  for (const campaign of report.campaigns) {
    const name =
      campaign.campaignName === null
        ? `Campaign ${campaign.campaignId}`
        : cell(campaign.campaignName);
    lines.push(`### ${name} (${campaign.campaignId})`, '');
    const bits = [`**${STATUS_LABEL[campaign.status]}**`];
    if (campaign.allTriggersBroken) bits.push('**no working way in**');
    if (campaign.activeContacts !== null) bits.push(`${campaign.activeContacts} active contacts`);
    bits.push(`${campaign.locations.length} broken reference(s)`);
    lines.push(bits.join(' · '), '');
    const order = { trigger: 0, decision: 1, step: 2, other: 3 } as const;
    for (const location of [...campaign.locations].sort(
      (a, b) => order[a.kind] - order[b.kind],
    )) {
      lines.push(`- ${describeBrokenLocation(location, names.get(location.entityId) ?? null)}`);
    }
    lines.push('');
  }

  lines.push('## Missing entities', '', '| Entity | Name | Referenced by | Severity |', '|---|---|---|---|');
  for (const reference of report.references) {
    const name = reference.name === null ? '_(name not recorded)_' : cell(reference.name);
    const severity = reference.severity === 'ready' ? 'ready step' : 'never built';
    lines.push(
      `| \`${reference.entityId}\` | ${name} | ${reference.locations.length} location(s) | ${severity} |`,
    );
  }
  lines.push('');

  if (report.warnings.length > 0) {
    lines.push('## Warnings', '');
    for (const warning of report.warnings) lines.push(`- ${cell(warning)}`);
    lines.push('');
  }

  return lines.join('\n');
}
