# Normaliser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn each campaign's raw mxGraph XML into canonical JSON — goals, sequences with steps in execution order, decisions joined to their criteria, edges and orphans.

**Architecture:** Two pure modules with a clear boundary. `nodes.ts` parses XML into generic nodes and edges, capturing every attribute and nested array verbatim and lifting the known foreign keys. `campaign.ts` assembles those into campaign structure, ordering sequence steps by walking edges from the `start` vertex. A CLI runs it over an app's artifacts. No network, no session.

**Tech Stack:** Node 20+, TypeScript (ESM, strict), fast-xml-parser, vitest, tsx.

**Spec:** `docs/superpowers/specs/2026-08-06-normaliser-design.md`

**Out of scope:** the account-level relationship graph. Deferred to its own plan — see spec §7.

## Global Constraints

- **Node 20 or newer.** ESM only. All relative imports carry a `.js` extension.
- **TypeScript `strict: true`** with `noUncheckedIndexedAccess`.
- **Pure functions only.** No network, no session, no Playwright import in either module.
- **Nothing is silently dropped.** Every attribute and every nested array is captured verbatim, because the vocabulary is 61 styles and 104 attributes and was unknown until yesterday.
- **Unknown styles produce a node and a warning**, never an exception.
- **Sequence order is never guessed.** Where the walk cannot complete, document order is kept and a warning names the sequence and the reason.
- **Ids are stripped of the Java-Long `L`; `~br~` becomes a space.** Reuse `stripLongSuffix` and `cleanName` from `src/parse/cells.js`.
- **Timer fields are captured verbatim and not interpreted** — handoff §4.2 records an unresolved timezone discrepancy.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/normalize/nodes.ts` | create | XML → generic nodes + edges. Config, lists, lifted references. |
| `src/normalize/campaign.ts` | create | Nodes + edges → campaign structure. Step ordering. |
| `src/cli/normalize.ts` | create | Run over an app's artifacts, write `normalized/` |
| `package.json` | modify | Add `normalize` |
| `test/normalizeNodes.test.ts` | create | Node parsing against the real corpus |
| `test/normalizeCampaign.test.ts` | create | Structure and step ordering |

The split matters: `nodes.ts` knows nothing about goals or sequences, and `campaign.ts` never touches XML. Step ordering — the only subtle logic here — is isolated in one function with its own tests.

---

### Task 1: Parse cells into generic nodes and edges

**Files:**
- Create: `src/normalize/nodes.ts`
- Test: `test/normalizeNodes.test.ts`

**Interfaces:**
- Consumes: `cleanName`, `stripLongSuffix` from `src/parse/cells.js`
- Produces: `NormalizedNode`, `NodeReferences`, `RawEdge`, `ParsedGraph`, `FK_ATTRIBUTES`, `parseNodes(draftXml: string): ParsedGraph`

**Design note — two kinds of nested array.** The 13 `<Array as="…">` containers hold two different
child shapes. Most hold scalars:

```xml
<Array as="tagIds"><add value="352L"/><add value="338L"/></Array>
```

`decisions` holds objects:

```xml
<Array as="decisions"><Object decisionId="479L" flowId="3"/></Array>
```

Both are captured — scalars into `lists`, objects into `objectLists` — so nothing is lost and
`campaign.ts` can read decision routing without a special case in the parser.

**Design note — edges are cells.** An edge is an `mxCell` with `edge="1"` carrying `source`/`target`.
It is not a property of the vertices. Its `parent` is the scope: `"1"` for campaign level, or a flow
cell id for edges inside a sequence.

- [ ] **Step 1: Write the failing test**

Create `test/normalizeNodes.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseNodes } from '../src/normalize/nodes.js';

const c584 = readFileSync(new URL('./fixtures/campaign-584-draft.xml', import.meta.url), 'utf8');
const c987 = readFileSync(new URL('./fixtures/campaign-987-draft.xml', import.meta.url), 'utf8');

describe('parseNodes', () => {
  it('separates vertices from edges', () => {
    const g = parseNodes(c584);
    expect(g.nodes.length).toBeGreaterThan(0);
    expect(g.edges.length).toBeGreaterThan(0);
    // No cell appears as both.
    const nodeIds = new Set(g.nodes.map((n) => n.cellId));
    for (const e of g.edges) expect(nodeIds.has(e.cellId)).toBe(false);
  });

  it('records each edge with its scope', () => {
    // Verified from the raw XML: inside flow 3, 14->81, 81->25, 25->27, 27->17.
    const inFlow3 = parseNodes(c584).edges.filter((e) => e.scope === '3');
    expect(inFlow3.map((e) => `${e.source}->${e.target}`).sort()).toEqual(
      ['14->81', '25->27', '27->17', '81->25'].sort(),
    );
  });

  it('captures every attribute verbatim in config', () => {
    const node = parseNodes(c987).nodes.find((n) => n.cellId === '15');
    expect(node?.style).toBe('tag');
    expect(node?.config.isApply).toBe('true');
    expect(node?.config.ready).toBe('1');
  });

  it('captures scalar arrays into lists, with the L stripped', () => {
    // <Array as="tagIds"><add value="1123L"/></Array>
    const node = parseNodes(c987).nodes.find((n) => n.cellId === '15');
    expect(node?.lists.tagIds).toEqual(['1123']);
  });

  it('captures object arrays into objectLists', () => {
    // <Array as="decisions"><Object decisionId="479L" flowId="3"/>…</Array>
    const node = parseNodes(c987).nodes.find((n) => n.cellId === '34');
    expect(node?.objectLists.decisions).toEqual([
      { decisionId: '479', flowId: '3' },
      { decisionId: '481', flowId: '32' },
    ]);
  });

  it('lifts tagIds into references', () => {
    const node = parseNodes(c987).nodes.find((n) => n.cellId === '15');
    expect(node?.references.tagIds).toEqual(['1123']);
  });

  it('lifts foreign-key attributes into references', () => {
    const withEmail = parseNodes(c584).nodes.find((n) => n.config.marketingEmailId !== undefined);
    expect(withEmail).toBeDefined();
    expect(withEmail?.references.marketingEmailId).toMatch(/^\d+$/);
    expect(withEmail?.references.marketingEmailId).not.toContain('L');
  });

  it('does not lift structural ids that are not entity references', () => {
    // funnelId identifies the campaign itself, not something it points at.
    const root = parseNodes(c987).nodes.find((n) => n.config.appName !== undefined);
    expect(root?.references.funnelId).toBeUndefined();
  });

  it('cleans ~br~ out of names', () => {
    const named = parseNodes(c584).nodes.filter((n) => n.name !== null);
    for (const n of named) expect(n.name).not.toContain('~br~');
  });

  it('normalises ready and published to booleans', () => {
    const node = parseNodes(c987).nodes.find((n) => n.cellId === '15');
    expect(node?.ready).toBe(true);
    expect(node?.published).toBe(true);
  });

  it('tallies styles', () => {
    expect(parseNodes(c987).styleCounts.tag).toBe(1);
    expect(parseNodes(c987).styleCounts.decision).toBe(1);
  });

  it('throws a clear error when the document has no root', () => {
    expect(() => parseNodes('<nope/>')).toThrow(/mxGraphModel/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/normalizeNodes.test.ts`
Expected: FAIL — cannot resolve `../src/normalize/nodes.js`.

- [ ] **Step 3: Write the implementation**

Create `src/normalize/nodes.ts`:

```ts
import { XMLParser } from 'fast-xml-parser';
import { cleanName, stripLongSuffix } from '../parse/cells.js';

/**
 * Attributes whose values are entity ids worth following.
 *
 * Taken from a survey of all 170 campaigns: 23 attributes carry Java-Long
 * values. `funnelId` is excluded — it identifies the campaign itself rather
 * than something the campaign points at — as are `decisionId` and `flowId`,
 * which are structural routing within a campaign.
 */
export const FK_ATTRIBUTES = [
  'marketingEmailId',
  'webformId',
  'landingPageId',
  'purchaseId',
  'eventId',
  'sourceFunnelId',
  'internalFormId',
  'actionSetId',
  'marketingNoteId',
  'fileBoxId',
  'stageId',
  'marketingFulfillmentId',
  'confirmLinkId',
  'fieldValueFileBoxId',
  'userId',
  'marketingLetterId',
  'voiceBroadcastId',
  'marketingFaxId',
  'createOrderConfigId',
  'roundRobinId',
] as const;

export interface NodeReferences {
  tagIds: string[];
  tagCategoryIds: string[];
  [key: string]: string | string[] | undefined;
}

export interface NormalizedNode {
  cellId: string;
  style: string;
  metaType: string | null;
  parent: string | null;
  name: string | null;
  ready: boolean | null;
  published: boolean | null;
  config: Record<string, string>;
  lists: Record<string, string[]>;
  objectLists: Record<string, Record<string, string>[]>;
  references: NodeReferences;
}

export interface RawEdge {
  cellId: string;
  source: string;
  target: string;
  /** The parent cell id: "1" for campaign level, or a flow id for a step edge. */
  scope: string;
}

export interface ParsedGraph {
  nodes: NormalizedNode[];
  edges: RawEdge[];
  styleCounts: Record<string, number>;
  warnings: string[];
}

const ATTR = '@_';

interface XmlNode {
  [key: string]: unknown;
}

function asArray(value: unknown): XmlNode[] {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]) as XmlNode[];
}

function attr(node: XmlNode, name: string): string | undefined {
  const raw = node[`${ATTR}${name}`];
  return raw === undefined || raw === null ? undefined : String(raw);
}

/** Keap writes "1"/"0" for these; anything else is left unknown rather than coerced. */
function boolOrNull(raw: string | undefined): boolean | null {
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return null;
}

function attributesOf(node: XmlNode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!key.startsWith(ATTR)) continue;
    const name = key.slice(ATTR.length);
    if (name === 'as') continue; // serialisation marker, not data
    out[name] = String(value);
  }
  return out;
}

export function parseNodes(draftXml: string): ParsedGraph {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: ATTR,
    parseAttributeValue: false,
    isArray: (name) => ['mxCell', 'Object', 'Array', 'add'].includes(name),
  });

  const doc = parser.parse(draftXml) as XmlNode;
  const root = (doc.mxGraphModel as XmlNode | undefined)?.root as XmlNode | undefined;
  if (!root) throw new Error('draftXml has no mxGraphModel/root element');

  const nodes: NormalizedNode[] = [];
  const edges: RawEdge[] = [];
  const styleCounts: Record<string, number> = {};
  const warnings: string[] = [];

  for (const cell of asArray(root.mxCell)) {
    const cellId = attr(cell, 'id');
    if (cellId === undefined) {
      warnings.push('an mxCell has no id and was skipped');
      continue;
    }

    const style = attr(cell, 'style') ?? '(none)';
    styleCounts[style] = (styleCounts[style] ?? 0) + 1;

    const source = attr(cell, 'source');
    const target = attr(cell, 'target');
    if (source !== undefined && target !== undefined) {
      edges.push({ cellId, source, target, scope: attr(cell, 'parent') ?? '1' });
      continue;
    }

    const value = asArray(cell.Object)[0];
    const config = value ? attributesOf(value) : {};

    const lists: Record<string, string[]> = {};
    const objectLists: Record<string, Record<string, string>[]> = {};
    for (const array of asArray(value?.Array)) {
      const name = attr(array, 'as');
      if (name === undefined) continue;

      const scalars = asArray(array.add)
        .map((entry) => stripLongSuffix(attr(entry, 'value')))
        .filter((v): v is string => v !== null);
      if (scalars.length > 0) lists[name] = scalars;

      const objects = asArray(array.Object).map((entry) => {
        const bag = attributesOf(entry);
        for (const [k, v] of Object.entries(bag)) bag[k] = stripLongSuffix(v) ?? v;
        return bag;
      });
      if (objects.length > 0) objectLists[name] = objects;

      // An empty array is real data — an unconfigured goal, for instance.
      if (scalars.length === 0 && objects.length === 0) lists[name] = [];
    }

    const references: NodeReferences = {
      tagIds: lists.tagIds ?? [],
      tagCategoryIds: lists.tagCategoryIds ?? [],
    };
    for (const key of FK_ATTRIBUTES) {
      const raw = config[key];
      if (raw !== undefined) {
        const stripped = stripLongSuffix(raw);
        if (stripped !== null) references[key] = stripped;
      }
    }

    nodes.push({
      cellId,
      style,
      metaType: attr(cell, 'metaType') ?? null,
      parent: attr(cell, 'parent') ?? null,
      name: cleanName(config.name),
      ready: boolOrNull(config.ready),
      published: boolOrNull(config.published),
      config,
      lists,
      objectLists,
      references,
    });
  }

  return { nodes, edges, styleCounts, warnings };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/normalizeNodes.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/normalize/nodes.ts test/normalizeNodes.test.ts && git commit -m "feat: parse campaign cells into generic nodes with lifted references"
```

---

### Task 2: Assemble campaign structure and order sequence steps

**Files:**
- Create: `src/normalize/campaign.ts`
- Test: `test/normalizeCampaign.test.ts`

**Interfaces:**
- Consumes: `parseNodes`, `NormalizedNode`, `RawEdge` from `src/normalize/nodes.js`; `parseIdentity` from `src/parse/cells.js`; `DecisionCriteria` from `src/parse/decisionHtml.js`
- Produces: `NormalizedSequence`, `NormalizedDecision`, `NormalizedCampaign`, `orderSteps`, `normalizeCampaign(draftXml, publishXml, criteriaByCellId): NormalizedCampaign`

**Design note — step ordering, verified.** Steps are vertices whose `parent` is the flow's cell id.
Edges inside that flow have the same `parent`. Walking `source`→`target` from the `start` vertex
reproduces campaign 584's documented order exactly:

```
edges 14→81, 81→25, 25→27, 27→17   walk: 14 → 81 → 25 → 27 → 17
handoff §8: 14 start, 81 timerDelay, 25 email, 27 timerDelay, 17 email
```

Those edge cells appear in the XML as 28, 18, 82, 83 — **document order is not step order**.

`orderSteps` is exported separately so the walk can be tested on synthetic branches and cycles
without constructing a whole campaign.

- [ ] **Step 1: Write the failing test**

Create `test/normalizeCampaign.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { NormalizedNode, RawEdge } from '../src/normalize/nodes.js';
import { normalizeCampaign, orderSteps } from '../src/normalize/campaign.js';

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
    const steps = [step('17', 'email'), step('14', 'start'), step('25', 'email'), step('81', 'timerDelay'), step('27', 'timerDelay')];
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
});

describe('normalizeCampaign against campaign 584', () => {
  const c = normalizeCampaign(c584, '', {});

  it('reads identity and publication state', () => {
    expect(c.funnelId).toBe('584');
    expect(c.appName).toBe('jordan');
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

  it('never throws on an unknown style', () => {
    const doctored = c987.replace('style="tag"', 'style="somethingKeapAddedLater"');
    const c = normalizeCampaign(doctored, '', {});
    expect(c.warnings.some((w) => /somethingKeapAddedLater/.test(w))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/normalizeCampaign.test.ts`
Expected: FAIL — cannot resolve `../src/normalize/campaign.js`.

- [ ] **Step 3: Write the implementation**

Create `src/normalize/campaign.ts`:

```ts
import { parseIdentity } from '../parse/cells.js';
import type { DecisionCriteria } from '../parse/decisionHtml.js';
import { type NormalizedNode, type ParsedGraph, type RawEdge, parseNodes } from './nodes.js';

/**
 * Every style observed across the 170-campaign corpus.
 *
 * Anything outside this set still normalises — the set exists only to decide
 * what to warn about. Seeding it with the handoff's list of 10 would fire a
 * warning 47 times per campaign and mean nothing; seeded with what we have
 * actually seen, a warning means Keap has added a node type since.
 */
const KNOWN_STYLES = new Set([
  // Documented in handoff section 3.4
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
 * Document order is NOT step order — verified on campaign 584, whose edge cells
 * appear as 28, 18, 82, 83 while the steps run 14, 81, 25, 27, 17.
 *
 * Where the walk cannot complete — no start vertex, a branch, or steps it never
 * reaches — document order is kept and the reason is reported. Order is never
 * guessed silently.
 */
export function orderSteps(steps: NormalizedNode[], edges: RawEdge[]): StepOrder {
  const fallback = (warning: string): StepOrder => ({ ordered: steps, verified: false, warning });

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

    const next = outbound.get(current) ?? [];
    if (next.length > 1) {
      return fallback(`branch at cell ${current}; keeping document order`);
    }
    current = next[0];
  }

  if (ordered.length !== steps.length) {
    return fallback(`walk reached ${ordered.length} of ${steps.length} steps; keeping document order`);
  }

  return { ordered, verified: true, warning: null };
}

/**
 * `funnelName` is passed in rather than parsed: the campaign's display name is
 * not in draftXml at all. It comes from the #editor data attribute, which the
 * extractor already stored in meta.json. Without it every campaign normalises
 * with a null name.
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
      branches: (node.objectLists.decisions ?? []).map((b) => ({
        decisionId: b.decisionId ?? '',
        flowId: b.flowId ?? '',
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/normalizeCampaign.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Run the whole suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS, 158 tests — 130 existing plus 12 from Task 1 and 16 from Task 2.

- [ ] **Step 6: Commit**

```bash
git add src/normalize/campaign.ts test/normalizeCampaign.test.ts && git commit -m "feat: assemble campaign structure with verified sequence step ordering"
```

---

### Task 3: CLI, full-corpus run and findings

**Files:**
- Create: `src/cli/normalize.ts`
- Modify: `package.json`
- Modify: `docs/spike-findings.md`

**Interfaces:**
- Consumes: `normalizeAppName`, `normalizeFunnelId` from `src/app.js`; `normalizeCampaign` from `src/normalize/campaign.js`; `DecisionCriteria` from `src/parse/decisionHtml.js`
- Produces: `npm run normalize -- --app <app> [--funnel <id>]`, writing `artifacts/<app>/normalized/<funnelId>.json`

- [ ] **Step 1: Create `src/cli/normalize.ts`**

```ts
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeAppName, normalizeFunnelId } from '../app.js';
import { normalizeCampaign } from '../normalize/campaign.js';
import type { DecisionCriteria } from '../parse/decisionHtml.js';

interface Args {
  app: string;
  funnelId: string | null;
}

function parseArgs(argv: string[]): Args {
  const usage = 'Usage: npm run normalize -- --app <appName> [--funnel <funnelId>]';
  const appIndex = argv.indexOf('--app');
  const rawApp = appIndex >= 0 ? argv[appIndex + 1] : undefined;
  if (!rawApp) throw new Error(usage);

  const funnelIndex = argv.indexOf('--funnel');
  const rawFunnel = funnelIndex >= 0 ? argv[funnelIndex + 1] : undefined;

  return {
    app: normalizeAppName(rawApp),
    funnelId: rawFunnel === undefined ? null : normalizeFunnelId(rawFunnel),
  };
}

function fail(message: string): void {
  console.error(`\n${message}\n`);
  process.exitCode = 1;
}

/** Loads every decisions/<cellId>.json for one campaign, keyed by cell id. */
async function loadCriteria(dir: string): Promise<Record<string, DecisionCriteria>> {
  const decisionsDir = join(dir, 'decisions');
  if (!existsSync(decisionsDir)) return {};
  const out: Record<string, DecisionCriteria> = {};
  for (const file of await readdir(decisionsDir)) {
    const match = /^(\d+)\.json$/.exec(file);
    if (!match?.[1]) continue;
    try {
      out[match[1]] = JSON.parse(await readFile(join(decisionsDir, file), 'utf8')) as DecisionCriteria;
    } catch {
      // A malformed criteria file leaves that branch's rules null rather than
      // failing the campaign; the routing is still known from the XML.
    }
  }
  return out;
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  const campaignsDir = join('artifacts', args.app, 'campaigns');
  if (!existsSync(campaignsDir)) {
    fail(`No campaigns at ${campaignsDir}. Run:  npm run extract-all -- --app ${args.app}`);
    return;
  }

  const outDir = join('artifacts', args.app, 'normalized');
  await mkdir(outDir, { recursive: true });

  const ids = args.funnelId !== null ? [args.funnelId] : (await readdir(campaignsDir)).sort();
  let written = 0;
  let skipped = 0;
  const allWarnings: string[] = [];
  const unverifiedSequences: string[] = [];

  for (const funnelId of ids) {
    const dir = join(campaignsDir, funnelId);
    const draftPath = join(dir, 'draft.xml');
    if (!existsSync(draftPath)) {
      skipped++;
      allWarnings.push(`${funnelId}: no draft.xml`);
      continue;
    }

    try {
      const draftXml = await readFile(draftPath, 'utf8');
      const publishPath = join(dir, 'publish.xml');
      const publishXml = existsSync(publishPath) ? await readFile(publishPath, 'utf8') : '';

      // The display name is not in draftXml — it comes from the #editor data
      // attribute, which the extractor stored in meta.json.
      let funnelName: string | null = null;
      const metaPath = join(dir, 'meta.json');
      if (existsSync(metaPath)) {
        try {
          const meta = JSON.parse(await readFile(metaPath, 'utf8')) as { funnelName?: string | null };
          funnelName = meta.funnelName ?? null;
        } catch {
          allWarnings.push(`${funnelId}: meta.json unreadable; name left null`);
        }
      }

      const campaign = normalizeCampaign(draftXml, publishXml, await loadCriteria(dir), funnelName);

      await writeFile(join(outDir, `${funnelId}.json`), JSON.stringify(campaign, null, 2), 'utf8');
      written++;
      for (const w of campaign.warnings) allWarnings.push(`${funnelId}: ${w}`);
      for (const s of campaign.sequences) {
        if (!s.orderVerified) unverifiedSequences.push(`${funnelId}/${s.cellId}`);
      }
    } catch (error) {
      // One unparseable campaign must not stop the other 169.
      skipped++;
      allWarnings.push(`${funnelId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (written === 0) {
    fail('no campaigns normalised — a silent empty result is worse than an error');
    return;
  }

  const unknownStyles = new Set(
    allWarnings
      .map((w) => /undocumented node style "([^"]+)"/.exec(w)?.[1])
      .filter((s): s is string => s !== undefined),
  );

  console.log(`\n[${args.app}] normalised ${written} campaigns, skipped ${skipped}`);
  console.log(`  undocumented styles encountered: ${unknownStyles.size}`);
  console.log(`  sequences whose order could not be walked: ${unverifiedSequences.length}`);
  if (unverifiedSequences.length > 0) {
    console.log(`    ${unverifiedSequences.slice(0, 10).join(', ')}${unverifiedSequences.length > 10 ? ' …' : ''}`);
  }
  console.log(`  output: ${outDir}\n`);
}

await main();
```

- [ ] **Step 2: Add the npm script**

In `package.json`, add after `"extract-all"`:

```json
    "normalize": "tsx src/cli/normalize.ts",
```

- [ ] **Step 3: Typecheck and run the suite**

Run: `npm run typecheck && npm test`
Expected: PASS, 158 tests.

- [ ] **Step 4: Verify argument handling**

```bash
npx tsx src/cli/normalize.ts
npx tsx src/cli/normalize.ts --app "../../../etc"
npx tsx src/cli/normalize.ts --app nosuchapp
```

Expected, in order: the usage line; `Invalid app name "../../../etc"`; and
`No campaigns at artifacts/nosuchapp/campaigns. Run: npm run extract-all -- --app nosuchapp`.

- [ ] **Step 5: Normalise a single campaign and check it by eye**

```bash
npx tsx src/cli/normalize.ts --app jordan --funnel 584
node --input-type=module -e "import{readFileSync}from'node:fs';const c=JSON.parse(readFileSync('artifacts/jordan/normalized/584.json','utf8'));const s=c.sequences.find(x=>x.cellId==='3');console.log('sequence',s.cellId,s.name,'verified',s.orderVerified);console.log('steps:',s.steps.map(t=>t.position+':'+t.cellId+':'+t.style).join(' -> '));console.log('goals',c.goals.length,'decisions',c.decisions.length,'notes',c.notes.length,'orphans',c.orphans);"
```

Expected: `0:14:start -> 1:81:timerDelay -> 2:25:email -> 3:27:timerDelay -> 4:17:email`, matching
handoff §8. Orphans should include cell 99, the `newsletterRequest` goal named "test" that the
handoff records as wired to nothing.

- [ ] **Step 6: Normalise the whole account**

```bash
npm run normalize -- --app jordan
```

Expected: 170 normalised, 0 skipped. Record the undocumented-style count and how many sequences
could not be order-walked — both are findings, not failures.

- [ ] **Step 7: Survey the result**

```bash
node --input-type=module -e "import{readFileSync,readdirSync}from'node:fs';const d='artifacts/jordan/normalized';let seq=0,steps=0,unver=0,orph=0,goals=0,notes=0,dec=0,withRules=0;for(const f of readdirSync(d)){const c=JSON.parse(readFileSync(d+'/'+f,'utf8'));seq+=c.sequences.length;steps+=c.sequences.reduce((n,s)=>n+s.steps.length,0);unver+=c.sequences.filter(s=>!s.orderVerified).length;orph+=c.orphans.length;goals+=c.goals.length;notes+=c.notes.length;dec+=c.decisions.length;withRules+=c.decisions.filter(x=>x.branches.some(b=>b.rules)).length;}console.log({files:readdirSync(d).length,sequences:seq,steps,unverifiedOrder:unver,orphans:orph,goals,notes,decisions:dec,decisionsWithRules:withRules});"
```

The ratio of `unverifiedOrder` to `sequences` is the number that matters: it says how often the walk
fails on real data, and therefore how much trust the ordering carries.

- [ ] **Step 8: Record the findings**

Append a `Normalisation` section to `docs/spike-findings.md` covering: campaigns normalised and
skipped; total sequences, steps, goals, notes and orphans; how many sequences could not be
order-walked and why; how many decisions have criteria attached versus routing only; and the count of
undocumented styles encountered.

Call out the orphan count specifically — the handoff describes orphan detection as free, and this is
the first measurement of how many campaigns contain dead nodes.

- [ ] **Step 9: Commit**

```bash
git add src/cli/normalize.ts package.json docs/spike-findings.md && git commit -m "feat: normalise campaigns to canonical JSON, and record the results"
```

---

## Definition of Done

1. `npm run normalize -- --app jordan` normalises all 170 campaigns with none skipped.
2. Campaign 584's "Satisfied" sequence yields `14, 81, 25, 27, 17` with `orderVerified: true`,
   matching handoff §8.
3. Campaign 584's orphans include cell 99.
4. Campaign 987's apply-tag step carries `references.tagIds` containing `1123`.
5. Every undocumented style produces a warning; none produces an exception.
6. Sequences whose order cannot be walked are counted and reported, not silently reordered.
7. The full suite passes offline — 158 tests.
