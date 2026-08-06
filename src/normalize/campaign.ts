import { parseIdentity } from '../parse/cells.js';
import type { DecisionCriteria } from '../parse/decisionHtml.js';
import { type NormalizedNode, type ParsedGraph, type RawEdge, parseNodes } from './nodes.js';

/**
 * Every style observed across the 170-campaign corpus.
 *
 * Anything outside this set still normalises — the set exists only to decide
 * what to warn about. Seeded with the handoff's list of 10, a warning would
 * fire 47 times per campaign and mean nothing. Seeded with what has actually
 * been seen, a warning means Keap has added a node type since.
 */
const KNOWN_STYLES = new Set([
  // Documented in keap-campaign-extractor-handoff.md section 3.4
  'newsletterRequest', 'purchaseSuccess', 'decision', 'flow', 'start', 'timerDelay',
  'email', 'bardEmail', 'task', 'notes', 'edge', 'tag', 'tagApplied', '(none)',
  // Observed across the corpus, previously undocumented
  'timerDate', 'indicateInterest', 'http', 'eventRequest', 'note', 'goal', 'requestInfo',
  'makeCall', 'landingPage', 'eventAttend', 'fulfillment', 'api', 'website', 'noteApplied',
  'fileDownload', 'unlayerEmail', 'emailConfirm', 'confirmEmail', 'stageMove', 'existingList',
  'timerContact', 'opportunity', 'actionSet', 'convrrtLandingPage', 'meetingRequest',
  'internalForm', 'letter', 'facebook', 'taskComplete', 'fieldValue', 'blog', 'twitter',
  'linkClick', 'websiteTrigger', 'assignOwner', 'meetingAttend', 'voice', 'fax', 'liveEvent',
  'facebookParticipate', 'radioAd', 'customerHub', 'scoreAchieved', 'failedPurchase',
  'createOrder', 'addToSequence', 'cancelSubscription',
]);

const NOTE_STYLES = new Set(['notes', 'note']);

export interface StepOrder {
  ordered: NormalizedNode[];
  verified: boolean;
  warning: string | null;
}

export interface NormalizedSequence extends NormalizedNode {
  flowType: string | null;
  steps: (NormalizedNode & { position: number })[];
  orderVerified: boolean;
}

export interface NormalizedDecisionBranch {
  decisionId: string;
  flowId: string;
  rules: DecisionCriteria | null;
}

export interface NormalizedDecision extends NormalizedNode {
  branches: NormalizedDecisionBranch[];
}

export interface NormalizedCampaign {
  funnelId: string | null;
  appName: string | null;
  name: string | null;
  published: boolean;
  hasUnpublishedChanges: boolean;
  goals: NormalizedNode[];
  sequences: NormalizedSequence[];
  decisions: NormalizedDecision[];
  notes: NormalizedNode[];
  edges: RawEdge[];
  orphans: string[];
  styleCounts: Record<string, number>;
  warnings: string[];
}

/**
 * Orders a sequence's steps by walking source→target from its start vertex.
 *
 * Document order is NOT step order. Verified on campaign 584, whose edge cells
 * appear in the XML as 28, 18, 82, 83 while the steps run 14, 81, 25, 27, 17 —
 * exactly the order the handoff documents in section 8.
 *
 * Where the walk cannot complete — no start vertex, a branch, or steps it never
 * reaches — document order is kept and the reason reported. Order is never
 * guessed silently, because a plausible-but-wrong sequence is worse than an
 * admittedly unordered one.
 */
export function orderSteps(steps: NormalizedNode[], edges: RawEdge[]): StepOrder {
  const fallback = (warning: string): StepOrder => ({ ordered: steps, verified: false, warning });

  // An empty sequence is trivially ordered. Reporting it as unwalkable was
  // wrong and drowned the real signal: 365 of 423 apparent failures across the
  // account were empty sequences, against 58 genuine partial walks.
  if (steps.length === 0) return { ordered: [], verified: true, warning: null };

  const start = steps.find((s) => s.style === 'start');
  if (!start) return fallback('no start vertex; keeping document order');

  const outbound = new Map<string, string[]>();
  for (const e of edges) {
    outbound.set(e.source, [...(outbound.get(e.source) ?? []), e.target]);
  }

  const byId = new Map(steps.map((s) => [s.cellId, s]));
  const ordered: NormalizedNode[] = [];
  const seen = new Set<string>();
  let current: string | undefined = start.cellId;

  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const node = byId.get(current);
    if (node) ordered.push(node);

    // Annotated explicitly: `current` is assigned from `next[0]` while `next`
    // derives from `current`, which TypeScript cannot infer through.
    const next: string[] = outbound.get(current) ?? [];
    if (next.length > 1) return fallback(`branch at cell ${current}; keeping document order`);
    current = next[0];
  }

  if (ordered.length !== steps.length) {
    return fallback(
      `walk reached ${ordered.length} of ${steps.length} steps; keeping document order`,
    );
  }

  return { ordered, verified: true, warning: null };
}

/**
 * `funnelName` is passed in rather than parsed: the campaign's display name is
 * not in draftXml at all. It comes from the #editor data attribute, which the
 * extractor already stored in meta.json.
 */
export function normalizeCampaign(
  draftXml: string,
  publishXml: string,
  criteriaByCellId: Record<string, DecisionCriteria>,
  funnelName: string | null = null,
): NormalizedCampaign {
  const graph: ParsedGraph = parseNodes(draftXml);
  const identity = parseIdentity(draftXml);
  const warnings = [...graph.warnings];

  for (const style of Object.keys(graph.styleCounts)) {
    if (!KNOWN_STYLES.has(style)) {
      warnings.push(`undocumented node style "${style}" — captured generically`);
    }
  }

  const flows = graph.nodes.filter((n) => n.style === 'flow');
  const flowIds = new Set(flows.map((f) => f.cellId));

  const sequences: NormalizedSequence[] = flows.map((flow) => {
    const steps = graph.nodes.filter((n) => n.parent === flow.cellId);
    const scoped = graph.edges.filter((e) => e.scope === flow.cellId);
    const { ordered, verified, warning } = orderSteps(steps, scoped);
    if (warning) warnings.push(`sequence ${flow.cellId} ("${flow.name ?? 'unnamed'}"): ${warning}`);
    return {
      ...flow,
      flowType: flow.config.flowType ?? null,
      steps: ordered.map((s, position) => ({ ...s, position })),
      orderVerified: verified,
    };
  });

  const decisions: NormalizedDecision[] = graph.nodes
    .filter((n) => n.style === 'decision')
    .map((node) => ({
      ...node,
      branches: (node.objectLists.decisions ?? []).map((branch) => ({
        decisionId: branch.decisionId ?? '',
        flowId: branch.flowId ?? '',
        rules: criteriaByCellId[node.cellId] ?? null,
      })),
    }));

  const notes = graph.nodes.filter((n) => NOTE_STYLES.has(n.style));

  const goals = graph.nodes.filter(
    (n) =>
      n.parent === '1' &&
      n.style !== 'flow' &&
      n.style !== 'decision' &&
      n.style !== 'edge' &&
      !NOTE_STYLES.has(n.style),
  );

  // An orphan is a top-level vertex no edge touches — the handoff calls this
  // detection free, and it is: cell 99 in campaign 584 is a goal wired to
  // nothing at all.
  const touched = new Set<string>();
  for (const e of graph.edges) {
    touched.add(e.source);
    touched.add(e.target);
  }
  const orphans = graph.nodes
    .filter((n) => n.parent === '1' && !flowIds.has(n.cellId) && !touched.has(n.cellId))
    .filter((n) => n.style !== '(none)' && !NOTE_STYLES.has(n.style))
    .map((n) => n.cellId);

  return {
    funnelId: identity.funnelId,
    appName: identity.appName,
    name: funnelName,
    published: publishXml.length > 0,
    hasUnpublishedChanges: publishXml.length > 0 && publishXml !== draftXml,
    goals,
    sequences,
    decisions,
    notes,
    edges: graph.edges,
    orphans,
    styleCounts: graph.styleCounts,
    warnings,
  };
}
