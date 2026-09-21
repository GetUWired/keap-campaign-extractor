import { contentRefsOf } from '../content/collect.js';
import type { ContentItemKey, ContentKind, StepVersion } from '../content/types.js';
import type { NormalizedCampaign } from '../normalize/campaign.js';
import type { NormalizedNode } from '../normalize/nodes.js';
import { stripLongSuffix } from '../parse/cells.js';
import type { CampaignSummary } from '../parse/campaignList.js';
import { htmlToText } from './htmlText.js';
import { findMergeFields } from './mergeFields.js';

export type ContentPointer =
  | { kind: ContentKind; id: string; ref: string }
  | { kind: ContentKind; id: string; status: 'failed' | 'notFound' | 'notFetched' };

export interface TaskDoc {
  title: string | null;
  body: string | null;
  type: string | null;
  priority: string | null;
  daysTillDue: string | null;
  dueAt: string | null;
  assignToOwner: boolean | null;
  assignToUserId: string | null;
  assignToBackup: string | null;
  notifyOwner: boolean | null;
  reminder: string | null;
}

export interface StepDoc {
  cellId: string;
  type: string;
  name: string | null;
  version: StepVersion;
  settings: Record<string, string>;
  content: ContentPointer[];
  task?: TaskDoc;
}

export interface SequenceDoc {
  cellId: string;
  name: string | null;
  version: StepVersion;
  orderVerified: boolean;
  steps: (StepDoc & { position: number })[];
}

export interface DecisionDoc {
  cellId: string;
  name: string | null;
  version: StepVersion;
  branches: { flowId: string; rules: unknown }[];
}

export interface CampaignDoc {
  formatVersion: 1;
  funnelId: string;
  name: string | null;
  categories: string[];
  status: { liveNow: boolean | null; everPublished: boolean; hasUnpublishedChanges: boolean };
  goals: StepDoc[];
  sequences: SequenceDoc[];
  decisions: DecisionDoc[];
  /** Steps present only in the published version — rare, and easy to miss. */
  publishedOnly: StepDoc[];
  canvasNotes: { cellId: string; text: string }[];
  mergeFields: string[];
}

export interface CampaignDocInput {
  funnelId: string;
  normalized: NormalizedCampaign;
  summary: CampaignSummary | null;
  publishNodes: NormalizedNode[];
  resolve: (key: ContentItemKey) => ContentPointer;
}

/** Status and bookkeeping attributes: nothing a migrator rebuilds. */
const HIDDEN_CONFIG = new Set([
  'initialized', 'deepCopy', 'global', 'name', 'ready', 'published', 'broken',
  'appName', 'buildNumber', 'funnelId',
]);

const STRUCTURAL = new Set(['flow', 'edge', 'start', '(none)']);
const NOTE_STYLES = new Set(['notes', 'note']);

/** Every node of the draft, in document-ish order: goals, sequences and their steps, decisions, notes. */
export function draftNodesOf(campaign: NormalizedCampaign): NormalizedNode[] {
  return [
    ...campaign.goals,
    ...campaign.sequences.flatMap((sequence) => [sequence, ...sequence.steps]),
    ...campaign.decisions,
    ...campaign.notes,
  ];
}

function settingsOf(node: NormalizedNode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(node.config)) {
    if (HIDDEN_CONFIG.has(key) || (node.style === 'task' && key.startsWith('task'))) continue;
    out[key] = value;
  }
  return out;
}

function taskOf(node: NormalizedNode): TaskDoc | undefined {
  if (node.style !== 'task') return undefined;
  const text = (key: string): string | null => {
    const value = node.config[key];
    return value === undefined || value === '' ? null : value;
  };
  const flag = (key: string): boolean | null =>
    node.config[key] === '1' ? true : node.config[key] === '0' ? false : null;
  const user = (value: string | null | undefined): string | null => {
    const id = value ? stripLongSuffix(value) : null;
    return id === null || id === '0' ? null : id;
  };
  const userIds = node.references.userId;
  return {
    title: text('taskTitle'),
    body: text('taskBody'),
    type: text('taskType'),
    priority: text('taskPriority'),
    daysTillDue: text('taskDaysTillDue'),
    dueAt: text('taskDueAt'),
    assignToOwner: flag('taskAssignToOwner'),
    assignToUserId: user(typeof userIds === 'string' ? userIds : userIds?.[0]),
    assignToBackup: user(text('taskAssignToBackup')),
    notifyOwner: flag('taskNotifyOwner'),
    reminder: text('taskReminder') === '0' ? null : text('taskReminder'),
  };
}

function stepDoc(
  node: NormalizedNode,
  version: StepVersion,
  resolve: CampaignDocInput['resolve'],
): StepDoc {
  const doc: StepDoc = {
    cellId: node.cellId,
    type: node.style,
    name: node.name,
    version,
    settings: settingsOf(node),
    content: contentRefsOf([node]).map(({ key }) => resolve(key)),
  };
  const task = taskOf(node);
  if (task) doc.task = task;
  return doc;
}

export function buildCampaignDoc(input: CampaignDocInput): CampaignDoc {
  const { normalized, publishNodes, resolve } = input;
  const publishedIds = new Set(publishNodes.map((n) => n.cellId));
  const versionOf = (cellId: string): StepVersion => (publishedIds.has(cellId) ? 'both' : 'draft');
  const draftIds = new Set(draftNodesOf(normalized).map((n) => n.cellId));

  const sequences: SequenceDoc[] = normalized.sequences.map((sequence) => ({
    cellId: sequence.cellId,
    name: sequence.name,
    version: versionOf(sequence.cellId),
    orderVerified: sequence.orderVerified,
    steps: sequence.steps
      .filter((step) => step.style !== 'start')
      .map((step) => ({ ...stepDoc(step, versionOf(step.cellId), resolve), position: step.position })),
  }));

  const decisions: DecisionDoc[] = normalized.decisions.map((decision) => ({
    cellId: decision.cellId,
    name: decision.name,
    version: versionOf(decision.cellId),
    branches: decision.branches.map((branch) => ({ flowId: branch.flowId, rules: branch.rules })),
  }));

  const publishedOnly = publishNodes
    .filter((n) => !draftIds.has(n.cellId) && !STRUCTURAL.has(n.style) && !NOTE_STYLES.has(n.style))
    .map((n) => stepDoc(n, 'published', resolve));

  const canvasNotes = normalized.notes.map((note) => ({
    cellId: note.cellId,
    text: htmlToText(note.config.notes ?? note.name ?? ''),
  }));

  const tasks = sequences.flatMap((s) => s.steps).flatMap((s) => (s.task ? [s.task] : []));
  const mergeFields = findMergeFields(
    ...tasks.flatMap((t) => [t.title, t.body]),
    ...canvasNotes.map((n) => n.text),
  );

  return {
    formatVersion: 1,
    funnelId: input.funnelId,
    name: normalized.name ?? input.summary?.name ?? null,
    categories: input.summary?.categories ?? [],
    status: {
      liveNow: input.summary?.published ?? null,
      everPublished: normalized.published,
      hasUnpublishedChanges: normalized.hasUnpublishedChanges,
    },
    goals: normalized.goals.map((goal) => stepDoc(goal, versionOf(goal.cellId), resolve)),
    sequences,
    decisions,
    publishedOnly,
    canvasNotes,
    mergeFields,
  };
}
