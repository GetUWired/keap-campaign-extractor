import { contentRefsOf } from '../content/collect.js';
import { REDACTED, SECRET_NAME_PATTERN } from '../content/redact.js';
import { type ContentItemKey, type ContentKind, type StepVersion, itemKey } from '../content/types.js';
import type { NormalizedCampaign, NormalizedDecision } from '../normalize/campaign.js';
import { TAG_RULE_CATEGORY } from '../normalize/graphEdges.js';
import type { NormalizedNode } from '../normalize/nodes.js';
import { stripLongSuffix } from '../parse/cells.js';
import type { CampaignSummary } from '../parse/campaignList.js';
import { decodeEntities } from '../render/text.js';
import { htmlToText } from './htmlText.js';
import { findMergeFields } from './mergeFields.js';

/** A tag a step or goal applies, removes, triggers on, or carries without a stated direction. */
export interface TagRef {
  id: string;
  name: string | null;
  action: 'apply' | 'remove' | 'trigger' | 'unspecified';
}

/** A tag name lookup, typically backed by the enrichment catalog. */
export type TagNameLookup = (id: string) => string | null;

/** Where one piece of content is in the export, or why it is not there. */
export type ResolvedContent =
  | { kind: ContentKind; id: string; ref: string }
  | { kind: ContentKind; id: string; status: 'failed' | 'notFound' | 'notFetched' };

/**
 * A step's content, tagged with the version that uses it: `both` when the cell
 * points at it in draft and published alike, `draft` or `published` when the
 * versions disagree — a step being edited can publish one email and draft
 * another, and the migrator needs to see both.
 */
export type ContentPointer = ResolvedContent & { version: StepVersion };

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
  tags: TagRef[];
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
  tags: { id: string; name: string | null }[];
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
  resolve: (key: ContentItemKey) => ResolvedContent;
  /** Names tags by id, typically backed by the enrichment catalog. Absent → every tag name is null. */
  tagName?: TagNameLookup;
}

/**
 * Status and bookkeeping attributes: nothing a migrator rebuilds.
 *
 * This differs from normalize's STATUS_KEYS on purpose. STATUS_KEYS decides
 * whether a node counts as "unconfigured", so it ignores settings such as a
 * goal's achievementType that every node carries by default. Here those stay:
 * achievementType is a real goal setting the migrator has to reproduce.
 */
const HIDDEN_CONFIG = new Set([
  'initialized', 'deepCopy', 'global', 'name', 'ready', 'published', 'broken',
  'appName', 'buildNumber', 'funnelId',
]);

const STRUCTURAL = new Set(['flow', 'edge', 'start', '(none)']);
/**
 * A canvas note — text on the canvas, not a step. The `note` style is the
 * Apply Note step: it carries a marketingNoteId and lives in a sequence, even
 * though normalize also files it under `notes`.
 */
const CANVAS_NOTE = 'notes';

/**
 * Every node of the draft, once each, in document-ish order: goals, sequences
 * and their steps, decisions, notes. (Apply Note steps appear both in their
 * sequence and in `notes`; the sequence copy wins.)
 */
export function draftNodesOf(campaign: NormalizedCampaign): NormalizedNode[] {
  const seen = new Set<string>();
  return [
    ...campaign.goals,
    ...campaign.sequences.flatMap((sequence) => [sequence, ...sequence.steps]),
    ...campaign.decisions,
    ...campaign.notes,
  ].filter((node) => {
    if (seen.has(node.cellId)) return false;
    seen.add(node.cellId);
    return true;
  });
}

function settingsOf(node: NormalizedNode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(node.config)) {
    if (HIDDEN_CONFIG.has(key) || (node.style === 'task' && key.startsWith('task'))) continue;
    out[key] = SECRET_NAME_PATTERN.test(key) && value.trim() !== '' ? REDACTED : value;
  }
  return out;
}

function decodedName(name: string | null): string | null {
  return name === null ? null : decodeEntities(name);
}

/**
 * The tags a node carries, direction rule verbatim from `graphEdges.tagEdges`:
 * a `tag` step's `config.isApply` says apply/remove, a `tagApplied` node
 * always triggers, and tagIds on any other style are unspecified rather than
 * guessed. Deduplicated by id, order kept.
 */
function tagsOf(node: NormalizedNode, tagName?: TagNameLookup): TagRef[] {
  const seen = new Set<string>();
  const out: TagRef[] = [];
  for (const id of node.references.tagIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    let action: TagRef['action'] = 'unspecified';
    if (node.style === 'tag') {
      if (node.config.isApply === 'true') action = 'apply';
      else if (node.config.isApply === 'false') action = 'remove';
    } else if (node.style === 'tagApplied') {
      action = 'trigger';
    }
    out.push({ id, name: tagName?.(id) ?? null, action });
  }
  return out;
}

/**
 * The tags a decision's rules test, from the criteria shared by every branch
 * (`branches.find(b => b.rules !== null)` — walking every branch would count
 * each rule once per branch instead of once per decision). The catalog name
 * wins when both it and the parsed `_text` label are available.
 */
function decisionTagsOf(
  decision: NormalizedDecision,
  tagName?: TagNameLookup,
): { id: string; name: string | null }[] {
  const rules = decision.branches.find((branch) => branch.rules !== null)?.rules ?? null;
  if (rules === null) return [];

  const names = new Map<string, string | null>();
  for (const wrapper of rules.wrappers) {
    for (const group of wrapper.any) {
      for (const rule of group.all) {
        if (rule.category !== TAG_RULE_CATEGORY) continue;
        for (const value of rule.values) {
          if (names.has(value.id)) continue;
          names.set(value.id, tagName?.(value.id) ?? value.label ?? null);
        }
      }
    }
  }
  return [...names].map(([id, name]) => ({ id, name }));
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

/**
 * The union of what a cell points at in each version: draft order first, then
 * whatever only the published version points at.
 */
function contentOf(
  draft: NormalizedNode | null,
  published: NormalizedNode | null,
  resolve: CampaignDocInput['resolve'],
): ContentPointer[] {
  const keysOf = (node: NormalizedNode | null): ContentItemKey[] =>
    node === null ? [] : contentRefsOf([node]).map(({ key }) => key);
  const draftKeys = keysOf(draft);
  const publishedKeys = keysOf(published);
  const inDraft = new Set(draftKeys.map(itemKey));
  const inPublished = new Set(publishedKeys.map(itemKey));
  return [
    ...draftKeys.map((key): ContentPointer => ({
      ...resolve(key),
      version: inPublished.has(itemKey(key)) ? 'both' : 'draft',
    })),
    ...publishedKeys
      .filter((key) => !inDraft.has(itemKey(key)))
      .map((key): ContentPointer => ({ ...resolve(key), version: 'published' })),
  ];
}

function stepDoc(
  node: NormalizedNode,
  version: StepVersion,
  content: ContentPointer[],
  tagName?: TagNameLookup,
): StepDoc {
  const doc: StepDoc = {
    cellId: node.cellId,
    type: node.style,
    name: decodedName(node.name),
    version,
    settings: settingsOf(node),
    content,
    tags: tagsOf(node, tagName),
  };
  const task = taskOf(node);
  if (task) doc.task = task;
  return doc;
}

export function buildCampaignDoc(input: CampaignDocInput): CampaignDoc {
  const { normalized, publishNodes, resolve, tagName } = input;
  const publishedById = new Map(publishNodes.map((n) => [n.cellId, n]));
  const versionOf = (cellId: string): StepVersion => (publishedById.has(cellId) ? 'both' : 'draft');
  const draftIds = new Set(draftNodesOf(normalized).map((n) => n.cellId));
  const draftStep = (node: NormalizedNode): StepDoc =>
    stepDoc(
      node,
      versionOf(node.cellId),
      contentOf(node, publishedById.get(node.cellId) ?? null, resolve),
      tagName,
    );

  const sequences: SequenceDoc[] = normalized.sequences.map((sequence) => ({
    cellId: sequence.cellId,
    name: decodedName(sequence.name),
    version: versionOf(sequence.cellId),
    orderVerified: sequence.orderVerified,
    steps: sequence.steps
      .filter((step) => step.style !== 'start')
      .map((step) => ({ ...draftStep(step), position: step.position })),
  }));

  const decisions: DecisionDoc[] = normalized.decisions.map((decision) => ({
    cellId: decision.cellId,
    name: decodedName(decision.name),
    version: versionOf(decision.cellId),
    branches: decision.branches.map((branch) => ({ flowId: branch.flowId, rules: branch.rules })),
    tags: decisionTagsOf(decision, tagName),
  }));

  const publishedOnly = publishNodes
    .filter((n) => !draftIds.has(n.cellId) && !STRUCTURAL.has(n.style) && n.style !== CANVAS_NOTE)
    .map((n) => stepDoc(n, 'published', contentOf(null, n, resolve), tagName));

  const canvasNotes = normalized.notes.filter((n) => n.style === CANVAS_NOTE).map((note) => ({
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
    goals: normalized.goals.map(draftStep),
    sequences,
    decisions,
    publishedOnly,
    canvasNotes,
    mergeFields,
  };
}
