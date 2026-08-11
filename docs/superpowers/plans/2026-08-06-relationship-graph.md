# Account Relationship Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the 170 normalised campaigns in `artifacts/jordan/normalized/` into one account-level graph — campaigns and shared entities as nodes, `applies` / `listens-for` / `tests` / `triggers` as edges — written to `artifacts/<app>/graph.json`.

**Architecture:** Two new pure modules under `src/normalize/`. `graphEdges.ts` harvests observed edges out of one campaign at a time and knows nothing about the account; `graph.ts` aggregates the harvests into an entity table, derives `triggers` edges, and computes findings. Neither reads a file or touches the network. `src/cli/normalize.ts` gains a second phase that calls `buildGraph` over everything it just normalised.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node ≥20, vitest, tsx. No new dependencies.

## Global Constraints

- **No network access.** Both modules are pure functions over data already in memory. No `fetch`, no Playwright, no `safeGet`.
- **No REST enrichment.** Ids stay ids. The only place a display name exists is the `_text` companion in decision criteria; everything else keeps `label: null`.
- **Deterministic output.** `graph.json` is regenerated on every run and must be byte-identical for identical input. Sort entities and edges before writing; never rely on `Map`/`Set` insertion order in output.
- **Warnings are bounded and aggregated.** A per-campaign warning repeated 170 times is noise. Harvesters return tallies keyed by a reason string; `buildGraph` merges them account-wide and renders one warning per distinct reason.
- **Never guess a relationship.** Where direction or identity is unknown, emit no edge, tally the reason, and let the warning say how much was dropped. A plausible-but-wrong edge is worse than a missing one — the same rule that governs step ordering.
- **Import specifiers carry `.js`** even for TypeScript sources (`./graphEdges.js`), matching every existing module.
- `npm run typecheck` and `npm test` must pass at the end of every task.

---

## Context an implementer needs

Read these before starting. They are the facts this plan was measured against, not background reading.

**The corpus is already on disk.** `artifacts/jordan/normalized/*.json` holds 170 files, one per campaign, each a `NormalizedCampaign` (defined in `src/normalize/campaign.ts:52`). Nothing in this plan re-extracts or re-parses XML.

**Five facts measured from that corpus, which the code depends on:**

1. **`funnelId` is `null` in 50 of the 170 files.** `parseIdentity` (`src/parse/cells.ts:130`) reads `funnelId` off the first `<Object>` carrying an `appName` attribute, and 50 campaigns have no such cell. Where it *is* present it equals the directory name in all 120 cases. The directory name is authoritative — extraction fetched by that id and filed the artifact under it. Task 1 fixes this; without it, 29% of the account becomes `campaign:null`.

2. **A tag step's direction lives in `config.isApply`, as the string `"true"` or `"false"`.** Across the corpus: 138 tag steps apply, 45 remove, and 58 carry no `isApply` at all. The 58 also carry no `tagIds`, so they cost nothing.

3. **Every branch of a decision carries the *same* `rules` object.** `normalizeCampaign` attaches `criteriaByCellId[node.cellId]` to each branch (`src/normalize/campaign.ts:166`). Iterating branches counts every rule once per branch — 66 tag-rule values become 132. Read the criteria **once per decision**.

4. **The decision-rule category for tags is `tags_FieldCategory`, not `Tag`.** Measured category values across the corpus: `formSubmissionOptions_FieldCategory` 204, `tags_FieldCategory` 110, `customFieldGroup1_FieldCategory` 39, `customFieldGroup7_FieldCategory` 11, `contact.contactFields_FieldCategory` 4.

5. **24 `tagIds` references sit on goal styles that do not say what they do with the tag** — `eventAttend` 6, `goal` 6, `newsletterRequest` 4, `purchaseSuccess` 3, `indicateInterest` 2, `requestInfo` 2, `eventRequest` 1. They get no edge, but they *do* get a tag entity, because the tag demonstrably exists in the account.

**Expected results, measured by simulating the algorithm over the corpus.** Task 9 checks the run against these. A mismatch is a bug in the implementation, not a stale number.

| Entities: 762 | | Observed edges: 771 | | Findings | |
|---|---|---|---|---|---|
| campaign | 170 | `sends` | 250 | unreachable campaigns | 10 |
| tag | 142 | `entry-point` | 207 | tags applied by nobody | 44 |
| email | 250 | `applies` | 146 | tags nobody listens for | 92 |
| webform | 113 | `removes` | 99 | shared emails | 0 |
| landingPage | 60 | `tests` | 43 | duplicate tag appliers | 13 |
| form | 16 | `listens-for` | 26 | | |
| product | 11 | `references-campaign` | 0 | derived `triggers` | 9 |

Two of those deserve a note up front, because they look like failures and are not:

- **`references-campaign` is 0.** No node in the account carries `sourceFunnelId`. The edge kind is still implemented — a client account that links campaigns will produce them — but this account has none.
- **`sharedEmails` is 0.** There are 250 distinct `marketingEmailId` values across 250 references: every email belongs to exactly one campaign. Emails are not shared in this account.

**The 142 tag figure is the design's success criterion 4 met exactly**: 131 tags from `<Array as="tagIds">` plus 11 that appear *only* in decision criteria. The excess over the 131 floor is fully attributable, as §11 predicted.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/normalize/graphEdges.ts` (create) | Edge and entity types; entity id formatting; flattening a campaign to its nodes; the three observed-edge harvesters. Knows one campaign at a time. ~190 lines. |
| `src/normalize/graph.ts` (create) | Entity table, derived `triggers` edges, findings, `buildGraph`. Knows the account, never sees XML. ~180 lines. |
| `src/normalize/campaign.ts` (modify) | Accept an authoritative `funnelId` from the caller, as it already does for `funnelName`. |
| `src/cli/normalize.ts` (modify) | Pass the directory name as `funnelId`; collect normalised campaigns; build and write `graph.json`; print the summary. |
| `test/fixtures/graphFixtures.ts` (create) | `makeCampaign` / `makeNode` builders, shared by both graph test files. |
| `test/graphEdges.test.ts` (create) | Harvester tests. |
| `test/graph.test.ts` (create) | Entity table, triggers, findings, `buildGraph`. |
| `test/normalizeCampaign.test.ts` (modify) | The `funnelId` override and mismatch warning. |
| `docs/spike-findings.md` (modify) | Section 12 recording what the graph found. |

The split is by knowledge boundary, not by layer: `graphEdges.ts` is per-campaign, `graph.ts` is per-account. That is the same separation the design insists on between `campaign.ts` and `graph.ts`, one level down.

---

### Task 1: Key campaigns by directory name

50 of 170 normalised files carry `funnelId: null`, so the graph would mint `campaign:null` for 29% of the account and collapse them into one node. The directory name is the authoritative id; `normalizeCampaign` should take it the same way it already takes `funnelName`.

**Files:**
- Modify: `src/normalize/campaign.ts:127-133` (signature), `:194-208` (return)
- Modify: `src/cli/normalize.ts:107`
- Test: `test/normalizeCampaign.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `normalizeCampaign(draftXml: string, publishXml: string, criteriaByCellId: Record<string, DecisionCriteria>, funnelName?: string | null, funnelId?: string | null): NormalizedCampaign`. Every later task assumes `NormalizedCampaign.funnelId` is non-null for corpus data.

- [ ] **Step 1: Write the failing tests**

Append to `test/normalizeCampaign.test.ts`, inside a new `describe` block at the end of the file:

```ts
describe('normalizeCampaign funnelId', () => {
  it('prefers the caller-supplied funnelId over the parsed one', () => {
    const c = normalizeCampaign(c584, '', {}, null, '584');
    expect(c.funnelId).toBe('584');
    expect(c.warnings.filter((w) => /funnelId/.test(w))).toEqual([]);
  });

  it('supplies a funnelId for a draft that carries none', () => {
    // 50 of 170 campaigns have no cell carrying appName, so parseIdentity
    // returns null and the campaign would otherwise become "campaign:null".
    const anonymous = c584.replace(/appName="[^"]*"/g, '');
    expect(normalizeCampaign(anonymous, '', {}).funnelId).toBeNull();
    expect(normalizeCampaign(anonymous, '', {}, null, '584').funnelId).toBe('584');
  });

  it('warns when the directory disagrees with the draft', () => {
    const c = normalizeCampaign(c584, '', {}, null, '999');
    expect(c.funnelId).toBe('999');
    expect(c.warnings.some((w) => /funnelId mismatch.*999.*584/.test(w))).toBe(true);
  });

  it('falls back to the parsed funnelId when the caller supplies none', () => {
    expect(normalizeCampaign(c584, '', {}).funnelId).toBe('584');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run test/normalizeCampaign.test.ts -t "funnelId"
```

Expected: FAIL — `normalizeCampaign` takes four parameters, so the fifth argument is a type error and `c.funnelId` is `null` where `'584'` is expected.

- [ ] **Step 3: Add the parameter**

In `src/normalize/campaign.ts`, replace the signature and its doc comment (currently lines 122-132):

```ts
/**
 * `funnelName` and `funnelId` are passed in rather than parsed.
 *
 * The display name is not in draftXml at all — it comes from the #editor data
 * attribute, which the extractor stored in meta.json. `funnelId` is in the XML
 * but only on a cell that also carries `appName`, and 50 of the 170 campaigns
 * in the corpus have no such cell. The directory an artifact was filed under is
 * authoritative: extraction fetched by that id, and in all 120 cases where the
 * XML does carry one, the two agree.
 */
export function normalizeCampaign(
  draftXml: string,
  publishXml: string,
  criteriaByCellId: Record<string, DecisionCriteria>,
  funnelName: string | null = null,
  funnelId: string | null = null,
): NormalizedCampaign {
```

Then, immediately after `const warnings = [...graph.warnings];` (line 135), insert:

```ts
  if (funnelId !== null && identity.funnelId !== null && funnelId !== identity.funnelId) {
    warnings.push(
      `funnelId mismatch: caller says ${funnelId}, draftXml says ${identity.funnelId} — ` +
        `using ${funnelId}`,
    );
  }
```

Finally change the returned `funnelId` (line 195) from `funnelId: identity.funnelId,` to:

```ts
    funnelId: funnelId ?? identity.funnelId,
```

- [ ] **Step 4: Pass the directory name from the CLI**

In `src/cli/normalize.ts`, replace line 107:

```ts
      const campaign = normalizeCampaign(
        draftXml,
        publishXml,
        await loadCriteria(dir),
        funnelName,
        funnelId,
      );
```

`funnelId` is already in scope — it is the loop variable over directory names at line 78.

- [ ] **Step 5: Run the tests and the typechecker**

```bash
npm test && npm run typecheck
```

Expected: PASS, all files.

- [ ] **Step 6: Re-normalise the corpus and confirm no nulls remain**

```bash
npm run normalize -- --app jordan
```

Then:

```bash
node -e "const{readdirSync,readFileSync}=require('fs');const d='artifacts/jordan/normalized';const n=readdirSync(d).filter(f=>f.endsWith('.json'));const bad=n.filter(f=>!JSON.parse(readFileSync(d+'/'+f,'utf8')).funnelId);console.log('files:',n.length,'null funnelId:',bad.length)"
```

Expected: `files: 170 null funnelId: 0`.

- [ ] **Step 7: Commit**

```bash
git add src/normalize/campaign.ts src/cli/normalize.ts test/normalizeCampaign.test.ts artifacts/jordan/normalized
git commit -m "fix: key normalised campaigns by their artifact directory id"
```

---

### Task 2: Graph primitives — entity ids and node flattening

**Files:**
- Create: `src/normalize/graphEdges.ts`
- Create: `test/fixtures/graphFixtures.ts`
- Test: `test/graphEdges.test.ts`

**Interfaces:**
- Consumes: `NormalizedCampaign` from `src/normalize/campaign.js`, `NormalizedNode` from `src/normalize/nodes.js`.
- Produces:
  - `type EntityKind = 'campaign' | 'tag' | 'email' | 'webform' | 'landingPage' | 'product' | 'form'`
  - `type EdgeKind = 'applies' | 'removes' | 'listens-for' | 'tests' | 'sends' | 'entry-point' | 'references-campaign' | 'triggers'`
  - `interface GraphEdge { from: string; to: string; kind: EdgeKind; viaCellId?: string; viaTagId?: string; derived?: boolean }`
  - `interface EdgeHarvest { edges: GraphEdge[]; tallies: Record<string, number> }`
  - `entityId(kind: EntityKind, id: string): string`
  - `campaignNodes(campaign: NormalizedCampaign): NormalizedNode[]`
  - `mergeTallies(into: Record<string, number>, from: Record<string, number>): void`
  - `dedupeEdges(edges: GraphEdge[]): GraphEdge[]`
  - Test builders `makeNode(overrides)` and `makeCampaign(overrides)` from `test/fixtures/graphFixtures.js`.

- [ ] **Step 1: Write the fixture builders**

Create `test/fixtures/graphFixtures.ts`:

```ts
import type { NormalizedCampaign, NormalizedDecision, NormalizedSequence } from '../../src/normalize/campaign.js';
import type { NormalizedNode } from '../../src/normalize/nodes.js';

/** A node with everything blank, so a test states only what it is about. */
export function makeNode(overrides: Partial<NormalizedNode> = {}): NormalizedNode {
  return {
    cellId: '1',
    style: 'email',
    metaType: null,
    parent: '1',
    name: null,
    ready: null,
    published: null,
    config: {},
    lists: {},
    objectLists: {},
    references: { tagIds: [], tagCategoryIds: [] },
    ...overrides,
  };
}

export function makeSequence(overrides: Partial<NormalizedSequence> = {}): NormalizedSequence {
  return {
    ...makeNode({ style: 'flow' }),
    flowType: null,
    steps: [],
    orderVerified: true,
    ...overrides,
  };
}

export function makeDecision(overrides: Partial<NormalizedDecision> = {}): NormalizedDecision {
  return { ...makeNode({ style: 'decision' }), branches: [], ...overrides };
}

export function makeCampaign(overrides: Partial<NormalizedCampaign> = {}): NormalizedCampaign {
  return {
    funnelId: '1',
    appName: 'jordan',
    name: null,
    published: false,
    hasUnpublishedChanges: false,
    goals: [],
    sequences: [],
    decisions: [],
    notes: [],
    edges: [],
    orphans: [],
    styleCounts: {},
    warnings: [],
    ...overrides,
  };
}
```

- [ ] **Step 2: Write the failing test**

Create `test/graphEdges.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  campaignNodes,
  dedupeEdges,
  entityId,
  mergeTallies,
} from '../src/normalize/graphEdges.js';
import { makeCampaign, makeDecision, makeNode, makeSequence } from './fixtures/graphFixtures.js';

describe('entityId', () => {
  it('namespaces an id by its kind', () => {
    expect(entityId('tag', '646')).toBe('tag:646');
    expect(entityId('campaign', '987')).toBe('campaign:987');
  });
});

describe('campaignNodes', () => {
  it('flattens goals, decisions, notes, sequences and nested steps', () => {
    const campaign = makeCampaign({
      goals: [makeNode({ cellId: 'g1', style: 'tagApplied' })],
      decisions: [makeDecision({ cellId: 'd1' })],
      notes: [makeNode({ cellId: 'n1', style: 'notes' })],
      sequences: [
        makeSequence({
          cellId: 'f1',
          steps: [
            { ...makeNode({ cellId: 's1', style: 'tag' }), position: 0 },
            { ...makeNode({ cellId: 's2', style: 'email' }), position: 1 },
          ],
        }),
      ],
    });
    expect(campaignNodes(campaign).map((n) => n.cellId)).toEqual([
      'g1', 'd1', 'n1', 'f1', 's1', 's2',
    ]);
  });

  it('returns an empty list for an empty campaign', () => {
    expect(campaignNodes(makeCampaign())).toEqual([]);
  });
});

describe('mergeTallies', () => {
  it('sums counts per key across campaigns', () => {
    const total: Record<string, number> = { a: 1 };
    mergeTallies(total, { a: 2, b: 5 });
    mergeTallies(total, { b: 1 });
    expect(total).toEqual({ a: 3, b: 6 });
  });
});

describe('dedupeEdges', () => {
  it('drops edges identical in from, to, kind and provenance', () => {
    const edge = { from: 'campaign:1', to: 'tag:5', kind: 'tests' as const, viaCellId: '9' };
    expect(dedupeEdges([edge, { ...edge }, { ...edge, viaCellId: '10' }])).toHaveLength(2);
  });

  it('keeps the same pair when the kind differs', () => {
    const base = { from: 'campaign:1', to: 'tag:5', viaCellId: '9' };
    const deduped = dedupeEdges([
      { ...base, kind: 'applies' as const },
      { ...base, kind: 'removes' as const },
    ]);
    expect(deduped).toHaveLength(2);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npx vitest run test/graphEdges.test.ts
```

Expected: FAIL — `Cannot find module '../src/normalize/graphEdges.js'`.

- [ ] **Step 4: Write the implementation**

Create `src/normalize/graphEdges.ts`:

```ts
import type { NormalizedCampaign } from './campaign.js';
import type { NormalizedNode } from './nodes.js';

export type EntityKind =
  | 'campaign'
  | 'tag'
  | 'email'
  | 'webform'
  | 'landingPage'
  | 'product'
  | 'form';

export type EdgeKind =
  | 'applies'
  | 'removes'
  | 'listens-for'
  | 'tests'
  | 'sends'
  | 'entry-point'
  | 'references-campaign'
  | 'triggers';

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** The cell that produced an observed edge. */
  viaCellId?: string;
  /** The tag linking applier to listener, on a derived `triggers` edge. */
  viaTagId?: string;
  /** Present and true only on computed edges, never on observed ones. */
  derived?: boolean;
}

/**
 * What one harvester found in one campaign.
 *
 * `tallies` are counts keyed by a self-describing reason. They are merged
 * account-wide before being rendered, because a per-campaign warning about
 * an unmodelled attribute would fire 170 times and mean nothing; one line
 * saying "94× ..." is the actual signal.
 */
export interface EdgeHarvest {
  edges: GraphEdge[];
  tallies: Record<string, number>;
}

export function entityId(kind: EntityKind, id: string): string {
  return `${kind}:${id}`;
}

/** Every vertex in a campaign, including the steps nested inside sequences. */
export function campaignNodes(campaign: NormalizedCampaign): NormalizedNode[] {
  return [
    ...campaign.goals,
    ...campaign.decisions,
    ...campaign.notes,
    ...campaign.sequences,
    ...campaign.sequences.flatMap((sequence) => sequence.steps),
  ];
}

export function mergeTallies(into: Record<string, number>, from: Record<string, number>): void {
  for (const [reason, count] of Object.entries(from)) {
    into[reason] = (into[reason] ?? 0) + count;
  }
}

/**
 * Removes edges identical in endpoints, kind and provenance.
 *
 * A decision that tests the same tag in two rules yields the same edge twice;
 * that is one fact, not two. Provenance is part of the key, so the same tag
 * tested by two different decisions stays two edges.
 */
export function dedupeEdges(edges: GraphEdge[]): GraphEdge[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = `${edge.from}|${edge.to}|${edge.kind}|${edge.viaCellId ?? ''}|${edge.viaTagId ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
```

- [ ] **Step 5: Run the tests**

```bash
npx vitest run test/graphEdges.test.ts && npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/normalize/graphEdges.ts test/graphEdges.test.ts test/fixtures/graphFixtures.ts
git commit -m "feat: graph edge primitives and campaign node flattening"
```

---

### Task 3: Tag edges — `applies`, `removes`, `listens-for`

**Files:**
- Modify: `src/normalize/graphEdges.ts`
- Test: `test/graphEdges.test.ts`

**Interfaces:**
- Consumes: `entityId`, `campaignNodes`, `EdgeHarvest`, `GraphEdge`, `EdgeKind` from Task 2.
- Produces: `tagEdges(campaign: NormalizedCampaign, from: string): EdgeHarvest`.

- [ ] **Step 1: Write the failing test**

Append to `test/graphEdges.test.ts`. Add `tagEdges` to the import list from `../src/normalize/graphEdges.js`.

```ts
describe('tagEdges', () => {
  const tagStep = (cellId: string, isApply: string | undefined, tagIds: string[]) =>
    makeNode({
      cellId,
      style: 'tag',
      config: isApply === undefined ? {} : { isApply },
      references: { tagIds, tagCategoryIds: [] },
    });

  it('reads direction from isApply', () => {
    const campaign = makeCampaign({
      sequences: [
        makeSequence({
          steps: [
            { ...tagStep('10', 'true', ['646']), position: 0 },
            { ...tagStep('11', 'false', ['647']), position: 1 },
          ],
        }),
      ],
    });
    expect(tagEdges(campaign, 'campaign:987').edges).toEqual([
      { from: 'campaign:987', to: 'tag:646', kind: 'applies', viaCellId: '10' },
      { from: 'campaign:987', to: 'tag:647', kind: 'removes', viaCellId: '11' },
    ]);
  });

  it('emits one edge per tag on a step carrying several', () => {
    const campaign = makeCampaign({
      sequences: [makeSequence({ steps: [{ ...tagStep('10', 'true', ['1', '2']), position: 0 }] })],
    });
    expect(tagEdges(campaign, 'campaign:1').edges.map((e) => e.to)).toEqual(['tag:1', 'tag:2']);
  });

  it('reads a tagApplied goal as listens-for', () => {
    const campaign = makeCampaign({
      goals: [
        makeNode({
          cellId: '4',
          style: 'tagApplied',
          references: { tagIds: ['346'], tagCategoryIds: [] },
        }),
      ],
    });
    expect(tagEdges(campaign, 'campaign:16').edges).toEqual([
      { from: 'campaign:16', to: 'tag:346', kind: 'listens-for', viaCellId: '4' },
    ]);
  });

  it('emits no edge for a tag step with no isApply, and tallies it', () => {
    const campaign = makeCampaign({
      sequences: [makeSequence({ steps: [{ ...tagStep('10', undefined, ['646']), position: 0 }] })],
    });
    const harvest = tagEdges(campaign, 'campaign:1');
    expect(harvest.edges).toEqual([]);
    expect(Object.values(harvest.tallies)).toEqual([1]);
    expect(Object.keys(harvest.tallies)[0]).toMatch(/direction/i);
  });

  it('emits no edge for tagIds on a goal style that does not state a direction', () => {
    // Measured: 24 such references across the corpus, on eventAttend, goal,
    // newsletterRequest, purchaseSuccess, indicateInterest, requestInfo and
    // eventRequest. The tag is real; what the campaign does with it is not stated.
    const campaign = makeCampaign({
      goals: [
        makeNode({
          cellId: '7',
          style: 'eventAttend',
          references: { tagIds: ['900', '901'], tagCategoryIds: [] },
        }),
      ],
    });
    const harvest = tagEdges(campaign, 'campaign:1');
    expect(harvest.edges).toEqual([]);
    expect(harvest.tallies['tagIds on "eventAttend" nodes state no apply/remove direction']).toBe(2);
  });

  it('ignores nodes with no tags at all', () => {
    const campaign = makeCampaign({ goals: [makeNode({ cellId: '1', style: 'newsletterRequest' })] });
    expect(tagEdges(campaign, 'campaign:1')).toEqual({ edges: [], tallies: {} });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/graphEdges.test.ts -t "tagEdges"
```

Expected: FAIL — `tagEdges is not exported`.

- [ ] **Step 3: Write the implementation**

Append to `src/normalize/graphEdges.ts`:

```ts
/**
 * Harvests tag relationships from one campaign.
 *
 * Direction comes from `config.isApply`, the string "true" or "false" — the
 * only thing distinguishing an apply-tag step from a remove-tag step, since
 * both carry style="tag". Across the corpus 138 apply, 45 remove, and 58 have
 * no isApply at all (and, as it happens, no tagIds either).
 *
 * Tags on any other style are counted and dropped. Seven goal styles carry
 * tagIds without saying what they do with them; guessing a direction there
 * would invent 24 relationships that may not exist. The tags themselves are
 * still registered as entities by the caller — the tag exists, the edge does not.
 */
export function tagEdges(campaign: NormalizedCampaign, from: string): EdgeHarvest {
  const edges: GraphEdge[] = [];
  const tallies: Record<string, number> = {};

  for (const node of campaignNodes(campaign)) {
    const { tagIds } = node.references;
    if (tagIds.length === 0) continue;

    let kind: EdgeKind | null = null;
    if (node.style === 'tag') {
      if (node.config.isApply === 'true') kind = 'applies';
      else if (node.config.isApply === 'false') kind = 'removes';
    } else if (node.style === 'tagApplied') {
      kind = 'listens-for';
    }

    if (kind === null) {
      const reason = `tagIds on "${node.style}" nodes state no apply/remove direction`;
      tallies[reason] = (tallies[reason] ?? 0) + tagIds.length;
      continue;
    }

    for (const tagId of tagIds) {
      edges.push({ from, to: entityId('tag', tagId), kind, viaCellId: node.cellId });
    }
  }

  return { edges, tallies };
}
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run test/graphEdges.test.ts && npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/normalize/graphEdges.ts test/graphEdges.test.ts
git commit -m "feat: harvest applies, removes and listens-for tag edges"
```

---

### Task 4: Decision `tests` edges

**Files:**
- Modify: `src/normalize/graphEdges.ts`
- Test: `test/graphEdges.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2-3, plus `RuleValue` from `src/parse/decisionHtml.js`.
- Produces:
  - `const TAG_RULE_CATEGORY = 'tags_FieldCategory'`
  - `eachDecisionTagValue(campaign: NormalizedCampaign, visit: (value: RuleValue, decisionCellId: string) => void): { decisionsWithoutCriteria: number }`
  - `decisionTagEdges(campaign: NormalizedCampaign, from: string): EdgeHarvest`
  - `tagLabels(campaigns: NormalizedCampaign[]): Map<string, string>`

- [ ] **Step 1: Write the failing test**

Append to `test/graphEdges.test.ts`. Add `decisionTagEdges` and `tagLabels` to the import list.

```ts
describe('decisionTagEdges', () => {
  const criteria = (category: string, values: { id: string; label: string | null }[]) => ({
    decisionIds: ['479'],
    flowIds: ['3'],
    wrappers: [
      {
        index: 0,
        decisionId: '479',
        flowId: '3',
        primaryKey: null,
        secondaryKey: null,
        secondaryKeyId: null,
        any: [
          {
            groupId: '1499',
            all: [
              {
                ruleId: '561',
                subject: null,
                subjectLabel: null,
                category,
                categoryLabel: null,
                field: null,
                fieldLabel: null,
                constraint: null,
                constraintLabel: null,
                values,
              },
            ],
          },
        ],
      },
    ],
    elseOptions: [],
    elseSelected: null,
    warnings: [],
  });

  it('emits a tests edge per tag value', () => {
    const rules = criteria('tags_FieldCategory', [{ id: '1123', label: 'Bought' }]);
    const campaign = makeCampaign({
      decisions: [
        makeDecision({
          cellId: '34',
          branches: [{ decisionId: '479', flowId: '3', rules }],
        }),
      ],
    });
    expect(decisionTagEdges(campaign, 'campaign:987').edges).toEqual([
      { from: 'campaign:987', to: 'tag:1123', kind: 'tests', viaCellId: '34' },
    ]);
  });

  it('reads a decision once even though every branch carries the same rules object', () => {
    // normalizeCampaign attaches criteriaByCellId[cellId] to EVERY branch, so
    // iterating branches would count each rule once per branch.
    const rules = criteria('tags_FieldCategory', [{ id: '1123', label: null }]);
    const campaign = makeCampaign({
      decisions: [
        makeDecision({
          cellId: '34',
          branches: [
            { decisionId: '479', flowId: '3', rules },
            { decisionId: '481', flowId: '32', rules },
          ],
        }),
      ],
    });
    expect(decisionTagEdges(campaign, 'campaign:987').edges).toHaveLength(1);
  });

  it('ignores rules in a non-tag category', () => {
    const rules = criteria('formSubmissionOptions_FieldCategory', [{ id: '3780', label: null }]);
    const campaign = makeCampaign({
      decisions: [makeDecision({ cellId: '13', branches: [{ decisionId: '1', flowId: '2', rules }] })],
    });
    expect(decisionTagEdges(campaign, 'campaign:584').edges).toEqual([]);
  });

  it('tallies a decision with no branches rather than throwing', () => {
    // 11 of 85 decisions in the corpus are unconfigured diamonds with no branches.
    const campaign = makeCampaign({ decisions: [makeDecision({ cellId: '141', branches: [] })] });
    const harvest = decisionTagEdges(campaign, 'campaign:211');
    expect(harvest.edges).toEqual([]);
    expect(Object.values(harvest.tallies)).toEqual([1]);
  });

  it('tallies a decision whose criteria file was never fetched', () => {
    const campaign = makeCampaign({
      decisions: [
        makeDecision({ cellId: '34', branches: [{ decisionId: '479', flowId: '3', rules: null }] }),
      ],
    });
    expect(Object.values(decisionTagEdges(campaign, 'campaign:1').tallies)).toEqual([1]);
  });

  describe('tagLabels', () => {
    it('collects display names from tag rule values', () => {
      const rules = criteria('tags_FieldCategory', [
        { id: '346', label: 'JordanHatch.com -> Mastermind Panels Registered' },
        { id: '999', label: null },
      ]);
      const campaign = makeCampaign({
        decisions: [makeDecision({ cellId: '34', branches: [{ decisionId: '1', flowId: '2', rules }] })],
      });
      const labels = tagLabels([campaign]);
      expect(labels.get('346')).toBe('JordanHatch.com -> Mastermind Panels Registered');
      expect(labels.has('999')).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/graphEdges.test.ts -t "decisionTagEdges"
```

Expected: FAIL — `decisionTagEdges is not exported`.

- [ ] **Step 3: Write the implementation**

Add the import at the top of `src/normalize/graphEdges.ts`, beside the existing type imports:

```ts
import type { RuleValue } from '../parse/decisionHtml.js';
```

Then append:

```ts
/**
 * Keap's category value for a tag rule.
 *
 * Measured, not guessed: the category values across the corpus are
 * formSubmissionOptions_FieldCategory (204), tags_FieldCategory (110),
 * customFieldGroup1_FieldCategory (39), customFieldGroup7_FieldCategory (11)
 * and contact.contactFields_FieldCategory (4). A parser looking for "Tag"
 * would find nothing and report it as a campaign with no tag decisions.
 */
export const TAG_RULE_CATEGORY = 'tags_FieldCategory';

/**
 * Visits every tag-category rule value on a campaign's decisions.
 *
 * Once per decision, NOT once per branch: normalizeCampaign attaches the same
 * DecisionCriteria object to every branch of a decision, so walking branches
 * multiplies each rule by the branch count.
 */
export function eachDecisionTagValue(
  campaign: NormalizedCampaign,
  visit: (value: RuleValue, decisionCellId: string) => void,
): { decisionsWithoutCriteria: number } {
  let decisionsWithoutCriteria = 0;

  for (const decision of campaign.decisions) {
    const rules = decision.branches.find((branch) => branch.rules !== null)?.rules ?? null;
    if (rules === null) {
      decisionsWithoutCriteria++;
      continue;
    }
    for (const wrapper of rules.wrappers) {
      for (const group of wrapper.any) {
        for (const rule of group.all) {
          if (rule.category !== TAG_RULE_CATEGORY) continue;
          for (const value of rule.values) visit(value, decision.cellId);
        }
      }
    }
  }

  return { decisionsWithoutCriteria };
}

/**
 * Harvests `tests` edges: a campaign tests a tag when a decision branches on it.
 *
 * A decision that routes on a tag is an edge the graph would otherwise miss
 * entirely — 11 tags in the corpus appear nowhere except decision criteria.
 */
export function decisionTagEdges(campaign: NormalizedCampaign, from: string): EdgeHarvest {
  const edges: GraphEdge[] = [];
  const tallies: Record<string, number> = {};

  const { decisionsWithoutCriteria } = eachDecisionTagValue(campaign, (value, decisionCellId) => {
    edges.push({ from, to: entityId('tag', value.id), kind: 'tests', viaCellId: decisionCellId });
  });

  if (decisionsWithoutCriteria > 0) {
    tallies['decisions have no criteria on disk — any tags they route on are invisible'] =
      decisionsWithoutCriteria;
  }

  return { edges, tallies };
}

/**
 * Tag display names, keyed by tag id.
 *
 * Decision criteria are the ONLY place a display name appears anywhere in the
 * extracted data — the `_text` companion input beside a rule value. Everything
 * else is bare ids until stage 3 resolves them through the REST API.
 */
export function tagLabels(campaigns: NormalizedCampaign[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const campaign of campaigns) {
    eachDecisionTagValue(campaign, (value) => {
      if (value.label !== null && !labels.has(value.id)) labels.set(value.id, value.label);
    });
  }
  return labels;
}
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run test/graphEdges.test.ts && npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/normalize/graphEdges.ts test/graphEdges.test.ts
git commit -m "feat: harvest tests edges and tag labels from decision criteria"
```

---

### Task 5: Reference edges — `sends`, `entry-point`, `references-campaign`

**Files:**
- Modify: `src/normalize/graphEdges.ts`
- Test: `test/graphEdges.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2-4.
- Produces:
  - `const REFERENCE_EDGES: Record<string, { kind: EntityKind; edge: EdgeKind }>`
  - `referenceEdges(campaign: NormalizedCampaign, from: string): EdgeHarvest`

- [ ] **Step 1: Write the failing test**

Append to `test/graphEdges.test.ts`. Add `referenceEdges` to the import list.

```ts
describe('referenceEdges', () => {
  it('maps each lifted foreign key to its entity kind and edge kind', () => {
    const campaign = makeCampaign({
      goals: [
        makeNode({
          cellId: '2',
          style: 'newsletterRequest',
          references: { tagIds: [], tagCategoryIds: [], webformId: '681' },
        }),
        makeNode({
          cellId: '5',
          style: 'landingPage',
          references: { tagIds: [], tagCategoryIds: [], landingPageId: '42' },
        }),
        makeNode({
          cellId: '6',
          style: 'purchaseSuccess',
          references: { tagIds: [], tagCategoryIds: [], purchaseId: '7' },
        }),
        makeNode({
          cellId: '8',
          style: 'internalForm',
          references: { tagIds: [], tagCategoryIds: [], internalFormId: '3' },
        }),
      ],
      sequences: [
        makeSequence({
          steps: [
            {
              ...makeNode({
                cellId: '25',
                style: 'email',
                references: { tagIds: [], tagCategoryIds: [], marketingEmailId: '1200' },
              }),
              position: 0,
            },
          ],
        }),
      ],
    });
    expect(referenceEdges(campaign, 'campaign:987').edges).toEqual([
      { from: 'campaign:987', to: 'webform:681', kind: 'entry-point', viaCellId: '2' },
      { from: 'campaign:987', to: 'landingPage:42', kind: 'entry-point', viaCellId: '5' },
      { from: 'campaign:987', to: 'product:7', kind: 'entry-point', viaCellId: '6' },
      { from: 'campaign:987', to: 'form:3', kind: 'entry-point', viaCellId: '8' },
      { from: 'campaign:987', to: 'email:1200', kind: 'sends', viaCellId: '25' },
    ]);
  });

  it('points a sourceFunnelId at another campaign', () => {
    const campaign = makeCampaign({
      goals: [
        makeNode({
          cellId: '3',
          style: 'existingList',
          references: { tagIds: [], tagCategoryIds: [], sourceFunnelId: '584' },
        }),
      ],
    });
    expect(referenceEdges(campaign, 'campaign:987').edges).toEqual([
      { from: 'campaign:987', to: 'campaign:584', kind: 'references-campaign', viaCellId: '3' },
    ]);
  });

  it('tallies a foreign key with no entity kind instead of inventing one', () => {
    const campaign = makeCampaign({
      goals: [
        makeNode({
          cellId: '9',
          style: 'note',
          references: { tagIds: [], tagCategoryIds: [], marketingNoteId: '55' },
        }),
      ],
    });
    const harvest = referenceEdges(campaign, 'campaign:1');
    expect(harvest.edges).toEqual([]);
    expect(harvest.tallies['reference attribute "marketingNoteId" has no entity kind']).toBe(1);
  });

  it('never treats tagIds or tagCategoryIds as a foreign key', () => {
    const campaign = makeCampaign({
      goals: [
        makeNode({
          cellId: '4',
          style: 'tagApplied',
          references: { tagIds: ['346'], tagCategoryIds: ['9'] },
        }),
      ],
    });
    expect(referenceEdges(campaign, 'campaign:1')).toEqual({ edges: [], tallies: {} });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/graphEdges.test.ts -t "referenceEdges"
```

Expected: FAIL — `referenceEdges is not exported`.

- [ ] **Step 3: Write the implementation**

Append to `src/normalize/graphEdges.ts`:

```ts
/**
 * The lifted foreign keys that have a place in the graph's entity vocabulary.
 *
 * `nodes.ts` lifts 20 foreign-key attributes; these six are the ones the seven
 * EntityKind values can express. The other fourteen — marketingNoteId (94 in
 * the corpus), fileBoxId (43), stageId (37), userId, roundRobinId, eventId,
 * marketingFulfillmentId, actionSetId, marketingLetterId, fieldValueFileBoxId,
 * confirmLinkId, voiceBroadcastId, marketingFaxId, createOrderConfigId — are
 * tallied so the warnings say plainly what the graph is not modelling. They
 * remain in the normalised files, so widening this table later costs a re-run
 * and nothing else.
 */
export const REFERENCE_EDGES: Record<string, { kind: EntityKind; edge: EdgeKind }> = {
  marketingEmailId: { kind: 'email', edge: 'sends' },
  webformId: { kind: 'webform', edge: 'entry-point' },
  landingPageId: { kind: 'landingPage', edge: 'entry-point' },
  purchaseId: { kind: 'product', edge: 'entry-point' },
  internalFormId: { kind: 'form', edge: 'entry-point' },
  sourceFunnelId: { kind: 'campaign', edge: 'references-campaign' },
};

/** Harvests edges from the foreign keys `nodes.ts` lifted onto each node. */
export function referenceEdges(campaign: NormalizedCampaign, from: string): EdgeHarvest {
  const edges: GraphEdge[] = [];
  const tallies: Record<string, number> = {};

  for (const node of campaignNodes(campaign)) {
    for (const [attribute, value] of Object.entries(node.references)) {
      // tagIds and tagCategoryIds are the two array-valued members of
      // NodeReferences; tags are tagEdges' business, not this function's.
      if (attribute === 'tagIds' || attribute === 'tagCategoryIds') continue;
      if (typeof value !== 'string') continue;

      const mapping = REFERENCE_EDGES[attribute];
      if (mapping === undefined) {
        const reason = `reference attribute "${attribute}" has no entity kind`;
        tallies[reason] = (tallies[reason] ?? 0) + 1;
        continue;
      }

      edges.push({
        from,
        to: entityId(mapping.kind, value),
        kind: mapping.edge,
        viaCellId: node.cellId,
      });
    }
  }

  return { edges, tallies };
}
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run test/graphEdges.test.ts && npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/normalize/graphEdges.ts test/graphEdges.test.ts
git commit -m "feat: harvest sends, entry-point and references-campaign edges"
```

---

### Task 6: `buildGraph` — entities and observed edges

**Files:**
- Create: `src/normalize/graph.ts`
- Test: `test/graph.test.ts`

**Interfaces:**
- Consumes: `tagEdges`, `decisionTagEdges`, `referenceEdges`, `tagLabels`, `campaignNodes`, `entityId`, `dedupeEdges`, `mergeTallies`, and the `EntityKind` / `EdgeKind` / `GraphEdge` types from `./graphEdges.js`.
- Produces:
  - `interface GraphEntity { id: string; kind: EntityKind; label: string | null; campaignCount: number }`
  - `interface AccountGraph { entities: GraphEntity[]; edges: GraphEdge[]; findings: GraphFindings; warnings: string[] }` — `findings` is stubbed empty in this task and filled in Task 8.
  - `buildGraph(campaigns: NormalizedCampaign[]): AccountGraph`

- [ ] **Step 1: Write the failing test**

Create `test/graph.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildGraph } from '../src/normalize/graph.js';
import { makeCampaign, makeDecision, makeNode, makeSequence } from './fixtures/graphFixtures.js';

const applyStep = (cellId: string, tagIds: string[]) => ({
  ...makeNode({
    cellId,
    style: 'tag',
    config: { isApply: 'true' },
    references: { tagIds, tagCategoryIds: [] },
  }),
  position: 0,
});

const listenGoal = (cellId: string, tagIds: string[]) =>
  makeNode({ cellId, style: 'tagApplied', references: { tagIds, tagCategoryIds: [] } });

describe('buildGraph entities', () => {
  it('makes one entity per campaign, labelled with its name', () => {
    const graph = buildGraph([
      makeCampaign({ funnelId: '584', name: 'Satisfaction Survey' }),
      makeCampaign({ funnelId: '987', name: 'Newsletter' }),
    ]);
    expect(graph.entities.filter((e) => e.kind === 'campaign')).toEqual([
      { id: 'campaign:584', kind: 'campaign', label: 'Satisfaction Survey', campaignCount: 0 },
      { id: 'campaign:987', kind: 'campaign', label: 'Newsletter', campaignCount: 0 },
    ]);
  });

  it('counts how many campaigns touch a shared entity', () => {
    const emailStep = (cellId: string, id: string) => ({
      ...makeNode({
        cellId,
        style: 'email',
        references: { tagIds: [], tagCategoryIds: [], marketingEmailId: id },
      }),
      position: 0,
    });
    const graph = buildGraph([
      makeCampaign({ funnelId: '1', sequences: [makeSequence({ steps: [emailStep('9', '77')] })] }),
      makeCampaign({ funnelId: '2', sequences: [makeSequence({ steps: [emailStep('9', '77')] })] }),
    ]);
    expect(graph.entities.find((e) => e.id === 'email:77')?.campaignCount).toBe(2);
  });

  it('registers a tag known only by an undirected reference', () => {
    // 24 references across the corpus sit on goal styles that state no
    // direction. They earn no edge, but the tag is still in the account.
    const graph = buildGraph([
      makeCampaign({
        funnelId: '1',
        goals: [
          makeNode({
            cellId: '7',
            style: 'eventAttend',
            references: { tagIds: ['900'], tagCategoryIds: [] },
          }),
        ],
      }),
    ]);
    expect(graph.entities.find((e) => e.id === 'tag:900')).toEqual({
      id: 'tag:900',
      kind: 'tag',
      label: null,
      campaignCount: 0,
    });
    expect(graph.edges.filter((e) => e.to === 'tag:900')).toEqual([]);
  });

  it('sorts entities by kind then numerically by id', () => {
    const graph = buildGraph([
      makeCampaign({ funnelId: '100' }),
      makeCampaign({ funnelId: '9' }),
      makeCampaign({ funnelId: '20' }),
    ]);
    expect(graph.entities.map((e) => e.id)).toEqual(['campaign:9', 'campaign:20', 'campaign:100']);
  });

  it('drops a campaign with no funnelId, with a warning, rather than minting campaign:null', () => {
    const graph = buildGraph([makeCampaign({ funnelId: '1' }), makeCampaign({ funnelId: null })]);
    expect(graph.entities.map((e) => e.id)).toEqual(['campaign:1']);
    expect(graph.warnings.some((w) => /no funnelId/.test(w))).toBe(true);
  });

  it('throws when nothing usable was supplied, rather than returning an empty graph', () => {
    expect(() => buildGraph([])).toThrow(/no campaigns/i);
    expect(() => buildGraph([makeCampaign({ funnelId: null })])).toThrow(/no campaigns/i);
  });
});

describe('buildGraph edges', () => {
  it('collects every harvester into one edge list', () => {
    const graph = buildGraph([
      makeCampaign({
        funnelId: '16',
        goals: [listenGoal('4', ['346'])],
        sequences: [makeSequence({ steps: [applyStep('10', ['646'])] })],
      }),
    ]);
    expect(graph.edges).toContainEqual({
      from: 'campaign:16',
      to: 'tag:346',
      kind: 'listens-for',
      viaCellId: '4',
    });
    expect(graph.edges).toContainEqual({
      from: 'campaign:16',
      to: 'tag:646',
      kind: 'applies',
      viaCellId: '10',
    });
  });

  it('renders one warning per distinct reason, carrying the account-wide count', () => {
    const noteGoal = (cellId: string) =>
      makeNode({
        cellId,
        style: 'note',
        references: { tagIds: [], tagCategoryIds: [], marketingNoteId: '55' },
      });
    const graph = buildGraph([
      makeCampaign({ funnelId: '1', goals: [noteGoal('9')] }),
      makeCampaign({ funnelId: '2', goals: [noteGoal('9')] }),
    ]);
    const matched = graph.warnings.filter((w) => /marketingNoteId/.test(w));
    expect(matched).toHaveLength(1);
    expect(matched[0]).toMatch(/^2×/);
  });

  it('labels a tag from decision criteria wherever that tag appears', () => {
    const rules = {
      decisionIds: ['479'],
      flowIds: ['3'],
      wrappers: [
        {
          index: 0,
          decisionId: '479',
          flowId: '3',
          primaryKey: null,
          secondaryKey: null,
          secondaryKeyId: null,
          any: [
            {
              groupId: '1',
              all: [
                {
                  ruleId: '2',
                  subject: null,
                  subjectLabel: null,
                  category: 'tags_FieldCategory',
                  categoryLabel: null,
                  field: null,
                  fieldLabel: null,
                  constraint: null,
                  constraintLabel: null,
                  values: [{ id: '346', label: 'Mastermind Registered' }],
                },
              ],
            },
          ],
        },
      ],
      elseOptions: [],
      elseSelected: null,
      warnings: [],
    };
    const graph = buildGraph([
      makeCampaign({
        funnelId: '1',
        decisions: [
          makeDecision({ cellId: '34', branches: [{ decisionId: '479', flowId: '3', rules }] }),
        ],
      }),
      makeCampaign({ funnelId: '2', goals: [listenGoal('4', ['346'])] }),
    ]);
    expect(graph.entities.find((e) => e.id === 'tag:346')?.label).toBe('Mastermind Registered');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/graph.test.ts
```

Expected: FAIL — `Cannot find module '../src/normalize/graph.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/normalize/graph.ts`:

```ts
import type { NormalizedCampaign } from './campaign.js';
import {
  type EntityKind,
  type GraphEdge,
  campaignNodes,
  decisionTagEdges,
  dedupeEdges,
  entityId,
  mergeTallies,
  referenceEdges,
  tagEdges,
  tagLabels,
} from './graphEdges.js';

export interface GraphEntity {
  id: string;
  kind: EntityKind;
  label: string | null;
  /** Distinct campaigns with an observed edge to this entity, excluding itself. */
  campaignCount: number;
}

export interface GraphFindings {
  unreachableCampaigns: { campaignId: string; reason: string }[];
  tagsAppliedByNobody: string[];
  tagsNobodyListensFor: string[];
  sharedEmails: { emailId: string; campaigns: string[] }[];
  duplicateTagAppliers: { tagId: string; campaigns: string[] }[];
}

export interface AccountGraph {
  entities: GraphEntity[];
  edges: GraphEdge[];
  findings: GraphFindings;
  warnings: string[];
}

const EMPTY_FINDINGS: GraphFindings = {
  unreachableCampaigns: [],
  tagsAppliedByNobody: [],
  tagsNobodyListensFor: [],
  sharedEmails: [],
  duplicateTagAppliers: [],
};

/** "tag:646" → "tag". Entity ids are minted by entityId and always have one colon. */
function kindOf(id: string): EntityKind {
  return id.slice(0, id.indexOf(':')) as EntityKind;
}

/**
 * Sorts numerically within a kind so campaign:9 precedes campaign:100.
 *
 * Output ordering is not cosmetic: graph.json is regenerated on every run and
 * committed, so an unstable order turns a no-op re-run into a large diff.
 */
function compareEntities(a: GraphEntity, b: GraphEntity): number {
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  const left = Number(a.id.slice(a.id.indexOf(':') + 1));
  const right = Number(b.id.slice(b.id.indexOf(':') + 1));
  if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function compareEdges(a: GraphEdge, b: GraphEdge): number {
  const key = (e: GraphEdge) => `${e.from}|${e.kind}|${e.to}|${e.viaCellId ?? ''}|${e.viaTagId ?? ''}`;
  const left = key(a);
  const right = key(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function buildGraph(campaigns: NormalizedCampaign[]): AccountGraph {
  const warnings: string[] = [];

  const usable: { campaign: NormalizedCampaign; from: string }[] = [];
  for (const campaign of campaigns) {
    if (campaign.funnelId === null) {
      warnings.push(
        `a campaign has no funnelId and was left out of the graph (name: ${campaign.name ?? 'unknown'})`,
      );
      continue;
    }
    usable.push({ campaign, from: entityId('campaign', campaign.funnelId) });
  }

  if (usable.length === 0) {
    throw new Error('no campaigns with a funnelId — nothing to build a graph from');
  }

  const tallies: Record<string, number> = {};
  const harvested: GraphEdge[] = [];
  for (const { campaign, from } of usable) {
    for (const harvest of [
      tagEdges(campaign, from),
      decisionTagEdges(campaign, from),
      referenceEdges(campaign, from),
    ]) {
      harvested.push(...harvest.edges);
      mergeTallies(tallies, harvest.tallies);
    }
  }
  const edges = dedupeEdges(harvested);

  const labels = tagLabels(usable.map((entry) => entry.campaign));
  const entities = new Map<string, GraphEntity>();
  const touchedBy = new Map<string, Set<string>>();

  const register = (id: string, label: string | null): void => {
    if (!entities.has(id)) entities.set(id, { id, kind: kindOf(id), label, campaignCount: 0 });
  };

  for (const { campaign, from } of usable) register(from, campaign.name);

  for (const edge of edges) {
    const kind = kindOf(edge.to);
    register(edge.to, kind === 'tag' ? (labels.get(edge.to.slice(4)) ?? null) : null);
    if (edge.from === edge.to) continue;
    const touching = touchedBy.get(edge.to) ?? new Set<string>();
    touching.add(edge.from);
    touchedBy.set(edge.to, touching);
  }

  // A tag referenced without a stated direction earns no edge, but it exists.
  // Registering it here is what takes the account from 130 tags to the 142
  // actually present, and keeps tag entities a superset of tag edges.
  for (const { campaign } of usable) {
    for (const node of campaignNodes(campaign)) {
      for (const tagId of node.references.tagIds) {
        register(entityId('tag', tagId), labels.get(tagId) ?? null);
      }
    }
  }

  for (const entity of entities.values()) {
    entity.campaignCount = touchedBy.get(entity.id)?.size ?? 0;
  }

  for (const [reason, count] of Object.entries(tallies)) warnings.push(`${count}× ${reason}`);

  return {
    entities: [...entities.values()].sort(compareEntities),
    edges: [...edges].sort(compareEdges),
    findings: { ...EMPTY_FINDINGS },
    warnings,
  };
}
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run test/graph.test.ts && npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/normalize/graph.ts test/graph.test.ts
git commit -m "feat: assemble the account entity table and observed edges"
```

---

### Task 7: Derived `triggers` edges

Campaign A triggers campaign B when A applies tag T and B listens for T. This is the edge the whole graph exists to produce, and the only computed one — it carries `derived: true` so a reader can always tell it from an observed fact.

**Files:**
- Modify: `src/normalize/graph.ts`
- Test: `test/graph.test.ts`

**Interfaces:**
- Consumes: `GraphEdge`, `EdgeKind`, `dedupeEdges` from `./graphEdges.js`; `buildGraph` from Task 6.
- Produces: `campaignsByTarget(edges: GraphEdge[], kind: EdgeKind): Map<string, Set<string>>` and `triggerEdges(observed: GraphEdge[]): GraphEdge[]`, both exported from `graph.ts`.

- [ ] **Step 1: Write the failing test**

Append to `test/graph.test.ts`:

```ts
describe('derived triggers edges', () => {
  it('links an applier to a listener through the shared tag', () => {
    // The design's synthetic two-campaign case: A applies T, B listens for T.
    const graph = buildGraph([
      makeCampaign({ funnelId: '16', sequences: [makeSequence({ steps: [applyStep('10', ['346'])] })] }),
      makeCampaign({ funnelId: '467', goals: [listenGoal('4', ['346'])] }),
    ]);
    const triggers = graph.edges.filter((e) => e.kind === 'triggers');
    expect(triggers).toEqual([
      {
        from: 'campaign:16',
        to: 'campaign:467',
        kind: 'triggers',
        viaTagId: '346',
        derived: true,
      },
    ]);
  });

  it('marks derived edges and leaves observed edges unmarked', () => {
    const graph = buildGraph([
      makeCampaign({ funnelId: '16', sequences: [makeSequence({ steps: [applyStep('10', ['346'])] })] }),
      makeCampaign({ funnelId: '467', goals: [listenGoal('4', ['346'])] }),
    ]);
    expect(graph.edges.filter((e) => e.derived === true)).toHaveLength(1);
    expect(graph.edges.filter((e) => e.kind !== 'triggers').every((e) => e.derived === undefined))
      .toBe(true);
  });

  it('keeps a self-trigger, because a campaign applying a tag it listens for is a real loop', () => {
    // 5 of the corpus's 9 triggers are self-loops.
    const graph = buildGraph([
      makeCampaign({
        funnelId: '594',
        goals: [listenGoal('4', ['610'])],
        sequences: [makeSequence({ steps: [applyStep('10', ['610'])] })],
      }),
    ]);
    expect(graph.edges.filter((e) => e.kind === 'triggers')).toEqual([
      {
        from: 'campaign:594',
        to: 'campaign:594',
        kind: 'triggers',
        viaTagId: '610',
        derived: true,
      },
    ]);
  });

  it('emits one triggers edge per applier-listener-tag triple', () => {
    const graph = buildGraph([
      makeCampaign({ funnelId: '672', sequences: [makeSequence({ steps: [applyStep('10', ['646'])] })] }),
      makeCampaign({ funnelId: '670', goals: [listenGoal('4', ['646'])] }),
      makeCampaign({ funnelId: '674', goals: [listenGoal('4', ['646'])] }),
    ]);
    expect(
      graph.edges.filter((e) => e.kind === 'triggers').map((e) => `${e.from}->${e.to}`).sort(),
    ).toEqual(['campaign:672->campaign:670', 'campaign:672->campaign:674']);
  });

  it('derives nothing from a tag that is tested but never applied', () => {
    const graph = buildGraph([
      makeCampaign({ funnelId: '1', goals: [listenGoal('4', ['999'])] }),
    ]);
    expect(graph.edges.filter((e) => e.kind === 'triggers')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/graph.test.ts -t "triggers"
```

Expected: FAIL — no edge has `kind: 'triggers'`.

- [ ] **Step 3: Write the implementation**

In `src/normalize/graph.ts`, add `type EdgeKind` to the import list from `./graphEdges.js`, then insert these two functions above `buildGraph`:

```ts
/** Groups edges of one kind by target, collecting the campaigns on the other end. */
export function campaignsByTarget(edges: GraphEdge[], kind: EdgeKind): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.kind !== kind) continue;
    const campaigns = out.get(edge.to) ?? new Set<string>();
    campaigns.add(edge.from);
    out.set(edge.to, campaigns);
  }
  return out;
}

/**
 * The one computed edge kind: A triggers B when A applies a tag B listens for.
 *
 * Self-loops are kept. A campaign that applies a tag its own goal listens for
 * re-enters itself, which is real behaviour worth seeing rather than an
 * artefact to filter out — 5 of the corpus's 9 triggers are self-loops.
 */
export function triggerEdges(observed: GraphEdge[]): GraphEdge[] {
  const appliers = campaignsByTarget(observed, 'applies');
  const listeners = campaignsByTarget(observed, 'listens-for');
  const edges: GraphEdge[] = [];

  for (const [tagEntity, listening] of listeners) {
    const applying = appliers.get(tagEntity);
    if (applying === undefined) continue;
    const tagId = tagEntity.slice(tagEntity.indexOf(':') + 1);
    for (const applier of applying) {
      for (const listener of listening) {
        edges.push({
          from: applier,
          to: listener,
          kind: 'triggers',
          viaTagId: tagId,
          derived: true,
        });
      }
    }
  }

  return dedupeEdges(edges);
}
```

Then in `buildGraph`, replace the `edges` sorting in the return value. Change:

```ts
  const edges = dedupeEdges(harvested);
```

to:

```ts
  const edges = dedupeEdges(harvested);
  const derived = triggerEdges(edges);
```

and change the returned `edges` line from `entities: [...entities.values()].sort(compareEntities),` / `edges: [...edges].sort(compareEdges),` so the edges line reads:

```ts
    edges: [...edges, ...derived].sort(compareEdges),
```

Entity registration must stay driven by `edges` alone, not `derived` — a `triggers` edge points campaign-to-campaign, and both endpoints are already registered.

- [ ] **Step 4: Run the tests**

```bash
npx vitest run test/graph.test.ts && npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/normalize/graph.ts test/graph.test.ts
git commit -m "feat: derive campaign-triggers-campaign edges through shared tags"
```

---

### Task 8: Findings

**Files:**
- Modify: `src/normalize/graph.ts`
- Test: `test/graph.test.ts`

**Interfaces:**
- Consumes: `campaignsByTarget` from Task 7, `GraphFindings` from Task 6.
- Produces: `computeFindings(usable: { campaign: NormalizedCampaign; from: string }[], edges: GraphEdge[], tagEntityIds: string[]): GraphFindings`, exported from `graph.ts`. `buildGraph` returns its result in place of `EMPTY_FINDINGS`, and `EMPTY_FINDINGS` is deleted.

- [ ] **Step 1: Write the failing test**

Append to `test/graph.test.ts`:

```ts
describe('findings', () => {
  it('reports a campaign with no goals as unreachable', () => {
    const graph = buildGraph([makeCampaign({ funnelId: '1' })]);
    expect(graph.findings.unreachableCampaigns).toEqual([
      { campaignId: 'campaign:1', reason: 'no goals — nothing can enter this campaign' },
    ]);
  });

  it('reports a campaign whose only goals listen for tags nobody else applies', () => {
    const graph = buildGraph([
      makeCampaign({ funnelId: '557', goals: [listenGoal('4', ['624'])] }),
      makeCampaign({ funnelId: '2', goals: [makeNode({ cellId: '9', style: 'newsletterRequest' })] }),
    ]);
    expect(graph.findings.unreachableCampaigns).toEqual([
      {
        campaignId: 'campaign:557',
        reason: 'every goal listens for a tag no other campaign applies',
      },
    ]);
  });

  it('does not call a campaign unreachable when another campaign applies its tag', () => {
    const graph = buildGraph([
      makeCampaign({ funnelId: '467', goals: [listenGoal('4', ['346'])] }),
      makeCampaign({ funnelId: '16', sequences: [makeSequence({ steps: [applyStep('10', ['346'])] })] }),
    ]);
    expect(graph.findings.unreachableCampaigns.map((u) => u.campaignId)).toEqual(['campaign:16']);
  });

  it('does not let a campaign applying its own tag count as reachable', () => {
    const graph = buildGraph([
      makeCampaign({
        funnelId: '594',
        goals: [listenGoal('4', ['610'])],
        sequences: [makeSequence({ steps: [applyStep('10', ['610'])] })],
      }),
    ]);
    expect(graph.findings.unreachableCampaigns.map((u) => u.campaignId)).toEqual(['campaign:594']);
  });

  it('ignores a campaign with a non-tag goal', () => {
    const graph = buildGraph([
      makeCampaign({
        funnelId: '1',
        goals: [makeNode({ cellId: '2', style: 'newsletterRequest' }), listenGoal('4', ['999'])],
      }),
    ]);
    expect(graph.findings.unreachableCampaigns).toEqual([]);
  });

  it('separates tags nobody applies from tags nobody listens for', () => {
    const graph = buildGraph([
      makeCampaign({ funnelId: '1', sequences: [makeSequence({ steps: [applyStep('10', ['500'])] })] }),
      makeCampaign({ funnelId: '2', goals: [listenGoal('4', ['600'])] }),
    ]);
    expect(graph.findings.tagsAppliedByNobody).toEqual(['tag:600']);
    expect(graph.findings.tagsNobodyListensFor).toEqual(['tag:500']);
  });

  it('reports an email used by more than one campaign', () => {
    const emailStep = (id: string) => ({
      ...makeNode({
        cellId: '9',
        style: 'email',
        references: { tagIds: [], tagCategoryIds: [], marketingEmailId: id },
      }),
      position: 0,
    });
    const graph = buildGraph([
      makeCampaign({ funnelId: '1', sequences: [makeSequence({ steps: [emailStep('77')] })] }),
      makeCampaign({ funnelId: '2', sequences: [makeSequence({ steps: [emailStep('77')] })] }),
      makeCampaign({ funnelId: '3', sequences: [makeSequence({ steps: [emailStep('88')] })] }),
    ]);
    expect(graph.findings.sharedEmails).toEqual([
      { emailId: 'email:77', campaigns: ['campaign:1', 'campaign:2'] },
    ]);
  });

  it('reports a tag applied by more than one campaign', () => {
    const graph = buildGraph([
      makeCampaign({ funnelId: '137', sequences: [makeSequence({ steps: [applyStep('10', ['419'])] })] }),
      makeCampaign({ funnelId: '321', sequences: [makeSequence({ steps: [applyStep('10', ['419'])] })] }),
      makeCampaign({ funnelId: '999', sequences: [makeSequence({ steps: [applyStep('10', ['420'])] })] }),
    ]);
    expect(graph.findings.duplicateTagAppliers).toEqual([
      { tagId: 'tag:419', campaigns: ['campaign:137', 'campaign:321'] },
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/graph.test.ts -t "findings"
```

Expected: FAIL — every findings array is empty.

- [ ] **Step 3: Write the implementation**

In `src/normalize/graph.ts`, delete the `EMPTY_FINDINGS` constant and add this function above `buildGraph`:

```ts
/** Sorts entity ids numerically within their kind, for stable output. */
function sortIds(ids: Iterable<string>): string[] {
  return [...ids].sort((a, b) => {
    const left = Number(a.slice(a.indexOf(':') + 1));
    const right = Number(b.slice(b.indexOf(':') + 1));
    if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * The questions the graph exists to answer.
 *
 * `unreachableCampaigns` is the sharpest of them for the live-versus-dead
 * problem: a campaign whose only door is a tag goal, for a tag no OTHER
 * campaign applies, cannot be entered by the automation. A campaign applying
 * a tag it listens for does not save itself — the loop still needs an outside
 * first push — so self-application is excluded deliberately.
 */
export function computeFindings(
  usable: { campaign: NormalizedCampaign; from: string }[],
  edges: GraphEdge[],
  tagEntityIds: string[],
): GraphFindings {
  const appliers = campaignsByTarget(edges, 'applies');
  const listeners = campaignsByTarget(edges, 'listens-for');
  const senders = campaignsByTarget(edges, 'sends');

  const unreachableCampaigns: { campaignId: string; reason: string }[] = [];
  for (const { campaign, from } of usable) {
    if (campaign.goals.length === 0) {
      unreachableCampaigns.push({
        campaignId: from,
        reason: 'no goals — nothing can enter this campaign',
      });
      continue;
    }
    if (!campaign.goals.every((goal) => goal.style === 'tagApplied')) continue;

    const enteredFromOutside = campaign.goals
      .flatMap((goal) => goal.references.tagIds)
      .some((tagId) => {
        const applying = appliers.get(entityId('tag', tagId));
        return applying !== undefined && [...applying].some((applier) => applier !== from);
      });
    if (!enteredFromOutside) {
      unreachableCampaigns.push({
        campaignId: from,
        reason: 'every goal listens for a tag no other campaign applies',
      });
    }
  }

  const withSeveral = (grouped: Map<string, Set<string>>): [string, string[]][] =>
    sortIds([...grouped.keys()])
      .filter((id) => (grouped.get(id)?.size ?? 0) > 1)
      .map((id) => [id, sortIds(grouped.get(id) ?? [])]);

  return {
    unreachableCampaigns,
    tagsAppliedByNobody: sortIds(tagEntityIds.filter((id) => !appliers.has(id))),
    tagsNobodyListensFor: sortIds(tagEntityIds.filter((id) => appliers.has(id) && !listeners.has(id))),
    sharedEmails: withSeveral(senders).map(([emailId, campaigns]) => ({ emailId, campaigns })),
    duplicateTagAppliers: withSeveral(appliers).map(([tagId, campaigns]) => ({ tagId, campaigns })),
  };
}
```

Then in `buildGraph`, replace `findings: { ...EMPTY_FINDINGS },` in the return value with:

```ts
    findings: computeFindings(
      usable,
      edges,
      [...entities.values()].filter((e) => e.kind === 'tag').map((e) => e.id),
    ),
```

- [ ] **Step 4: Run the tests**

```bash
npm test && npm run typecheck
```

Expected: PASS, all files.

- [ ] **Step 5: Commit**

```bash
git add src/normalize/graph.ts test/graph.test.ts
git commit -m "feat: compute unreachable campaigns, orphaned tags and shared entities"
```

---

### Task 9: CLI wiring and the corpus run

**Files:**
- Modify: `src/cli/normalize.ts`

**Interfaces:**
- Consumes: `buildGraph` and `AccountGraph` from `../normalize/graph.js`.
- Produces: `artifacts/<app>/graph.json`. No new exports.

- [ ] **Step 1: Wire the graph into the CLI**

In `src/cli/normalize.ts`, add to the imports:

```ts
import { buildGraph } from '../normalize/graph.js';
import type { NormalizedCampaign } from '../normalize/campaign.js';
```

Beside `const allWarnings: string[] = [];` (line 74), add:

```ts
  const normalized: NormalizedCampaign[] = [];
```

Inside the loop, immediately after `written++;` (line 109), add:

```ts
      normalized.push(campaign);
```

Then, after the existing `console.log(\`  output: ${outDir}\n\`);` at the end of `main`, append:

```ts
  // --funnel normalises one campaign for iteration; a one-campaign graph would
  // overwrite the account's graph.json with a near-empty one.
  if (args.funnelId !== null) {
    console.log('  (graph skipped — --funnel normalises a single campaign)\n');
    return;
  }

  const graph = buildGraph(normalized);
  const graphPath = join('artifacts', args.app, 'graph.json');
  await writeFile(graphPath, JSON.stringify(graph, null, 2), 'utf8');

  const count = <T extends string>(values: T[]): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const value of values) out[value] = (out[value] ?? 0) + 1;
    return out;
  };

  console.log(`[${args.app}] graph: ${graph.entities.length} entities, ${graph.edges.length} edges`);
  console.log(`  entities: ${JSON.stringify(count(graph.entities.map((e) => e.kind)))}`);
  console.log(`  edges:    ${JSON.stringify(count(graph.edges.map((e) => e.kind)))}`);
  console.log(`  unreachable campaigns:  ${graph.findings.unreachableCampaigns.length}`);
  console.log(`  tags applied by nobody: ${graph.findings.tagsAppliedByNobody.length}`);
  console.log(`  tags nobody listens for: ${graph.findings.tagsNobodyListensFor.length}`);
  console.log(`  shared emails:          ${graph.findings.sharedEmails.length}`);
  console.log(`  duplicate tag appliers: ${graph.findings.duplicateTagAppliers.length}`);
  for (const warning of graph.warnings) console.log(`  warning: ${warning}`);
  console.log(`  output: ${graphPath}\n`);
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck && npm test
```

Expected: PASS.

- [ ] **Step 3: Run it against the corpus**

```bash
npm run normalize -- --app jordan
```

Expected output, matching the measured figures in the context section exactly:

```
[jordan] graph: 762 entities, 780 edges
  entities: {"campaign":170,"email":250,"form":16,"landingPage":60,"product":11,"tag":142,"webform":113}
  edges:    {"applies":146,"entry-point":207,"listens-for":26,"removes":99,"sends":250,"tests":43,"triggers":9}
  unreachable campaigns:  10
  tags applied by nobody: 44
  tags nobody listens for: 92
  shared emails:          0
  duplicate tag appliers: 13
```

Key ordering inside the two JSON objects may differ; the numbers may not. **Any disagreement is a bug in the implementation, not a stale expectation** — the figures came from simulating this exact algorithm over this exact corpus. Investigate before proceeding.

Warnings should include one line per unmapped reference attribute (14 of them, led by `94× reference attribute "marketingNoteId" has no entity kind`), one per undirected tag style (7 of them, 24 references in total), and `11× decisions have no criteria on disk — any tags they route on are invisible`.

- [ ] **Step 4: Verify the design's success criteria**

```bash
node -e "const g=require('./artifacts/jordan/graph.json');const tags=g.entities.filter(e=>e.kind==='tag');const refs=g.edges.filter(e=>e.to.startsWith('tag:')&&!e.derived);console.log('tag entities:',tags.length,'(floor 131)');console.log('tag edges:',refs.length,'(floor 295)');console.log('triggers:',g.edges.filter(e=>e.kind==='triggers').length);console.log('labelled tags:',tags.filter(t=>t.label).length)"
```

Expected: `tag entities: 142 (floor 131)`, `tag edges: 314 (floor 295)`, `triggers: 9`, `labelled tags: 6`.

The 314 is 146 `applies` + 99 `removes` + 26 `listens-for` + 43 `tests`. Both floors from design §11 criterion 4 are cleared, and the excess over 131 tags is exactly the 11 that appear only in decision criteria.

- [ ] **Step 5: Verify the run is deterministic**

```bash
cp artifacts/jordan/graph.json /tmp/graph-first.json && npm run normalize -- --app jordan >/dev/null && diff /tmp/graph-first.json artifacts/jordan/graph.json && echo "identical"
```

Expected: `identical`.

- [ ] **Step 6: Verify `--funnel` does not clobber the graph**

```bash
npm run normalize -- --app jordan --funnel 584 && diff /tmp/graph-first.json artifacts/jordan/graph.json && echo "graph untouched"
```

Expected: the run prints `(graph skipped — --funnel normalises a single campaign)` and `graph untouched`.

- [ ] **Step 7: Commit**

```bash
git add src/cli/normalize.ts artifacts/jordan/graph.json
git commit -m "feat: build and write the account relationship graph"
```

---

### Task 10: Record what the graph found

The spike-findings document is the project's record of what running the code revealed. Two of its existing claims need correcting from what Tasks 1 and 4 measured.

**Files:**
- Modify: `docs/spike-findings.md`

- [ ] **Step 1: Correct the decision-criteria claim in §11**

In `docs/spike-findings.md`, under "Gaps this surfaced", replace the first bullet:

```markdown
- **11 of 85 decisions have routing but no criteria.** Their `decisions/<cellId>.json` is absent, so
  branches carry `rules: null`. Worth chasing before the relationship graph, since a decision that
  tests a tag is an edge the graph would otherwise miss.
```

with:

```markdown
- **11 of 85 decisions have no branches at all** — corrected 2026-08-06 while building the graph.
  The earlier reading of "routing but no criteria" was wrong: every decision that has branches also
  has criteria on disk (74 of 74). The 11 are unconfigured diamonds with an empty
  `<Array as="decisions">`, so there is no routing to chase and nothing missing from the extraction.
```

- [ ] **Step 2: Append the new section**

Append to `docs/spike-findings.md`:

```markdown
## 12. The account relationship graph

Added 2026-08-06. `artifacts/jordan/graph.json` — 762 entities, 780 edges, built offline from the
normalised corpus in seconds.

| Entities | | Edges | |
|---|---|---|---|
| campaign | 170 | `sends` | 250 |
| tag | 142 | `entry-point` | 207 |
| email | 250 | `applies` | 146 |
| webform | 113 | `removes` | 99 |
| landingPage | 60 | `tests` | 43 |
| form | 16 | `listens-for` | 26 |
| product | 11 | `triggers` (derived) | 9 |
| | | `references-campaign` | 0 |

### 50 campaigns had no id of their own

`parseIdentity` reads `funnelId` off the first cell carrying an `appName` attribute, and **50 of the
170 campaigns have no such cell** — so 29% of the normalised corpus carried `funnelId: null`. The
graph would have collapsed all fifty into a single `campaign:null` node and produced a confidently
wrong picture of the account.

The artifact's own directory name is authoritative: extraction fetched by that id and filed the
result under it. Where the XML does carry one, the two agree in all 120 cases. `normalizeCampaign`
now takes it from the caller, exactly as it already did for the display name, and warns on
disagreement.

**This was invisible until something tried to use the id as a key.** Nothing in the normaliser's own
output looked wrong.

### The account is far more loosely coupled than expected

**Only 9 `triggers` edges across 170 campaigns, and 5 of those are self-loops.** Four cross-campaign
handoffs exist in the entire account:

```
campaign 16  → 467  via tag 346
campaign 672 → 670, 674, 676  via tag 646
```

The tag counts say the same thing from the other side: **92 of the 142 tags are applied by a campaign
that nothing listens for**, and 44 are applied by nobody at all. Tags are overwhelmingly used as
record-keeping rather than as wiring between campaigns.

**Emails are never shared.** 250 distinct `marketingEmailId` values across 250 references — every
email belongs to exactly one campaign. Only 13 tags are applied by more than one campaign.

The practical consequence for a migration is good news: campaigns are mostly independent units, so
they can be moved one at a time rather than in coupled clusters.

### 10 campaigns cannot be entered

Four have no goals at all. Six have goals, but every one of them is a `tagApplied` goal listening
for a tag no *other* campaign applies — 557, 588, 672, 745, 809, 949. A campaign applying a tag it
listens for does not rescue itself; the loop still needs an outside first push.

Campaign 672 is the interesting one: it is unreachable, and it is also the account's largest
trigger source, feeding 670, 674 and 676. A dead campaign holding three live ones open.

Combined with the 91 never-published campaigns and 365 empty sequences already on record, this is
the third independent signal pointing at the same conclusion about how much of this account is inert.

### What the graph deliberately does not model

- **14 of the 20 lifted foreign keys have no entity kind** — led by `marketingNoteId` (94
  references), `fileBoxId` (43) and `stageId` (37). They stay in the normalised files, so widening
  the entity vocabulary later costs a re-run and nothing else.
- **24 `tagIds` references state no direction.** They sit on goal styles — `eventAttend`, `goal`,
  `newsletterRequest`, `purchaseSuccess`, `indicateInterest`, `requestInfo`, `eventRequest` — that
  carry a tag without saying whether they apply it, require it, or something else. The tags are
  registered as entities; no edge is invented. Settling this needs a look at the live UI for one of
  each style.
- **Only 6 of 142 tags have a display name.** Decision criteria are the sole source of names in the
  extracted data, so everything else is a bare id until stage 3 resolves them through the REST API.
  A graph of numbered tags is analysable but not yet readable.
```

- [ ] **Step 3: Commit**

```bash
git add docs/spike-findings.md
git commit -m "docs: record relationship graph results and correct the decision-criteria count"
```

---

## Self-review against the design

| Design §7 requirement | Where |
|---|---|
| `EntityKind` / `EdgeKind` / `GraphEdge` / `AccountGraph` | Tasks 2, 6 |
| `buildGraph(campaigns): AccountGraph` | Task 6 |
| `applies`/`removes` from `tag` steps via `isApply` | Task 3 |
| `listens-for` from `tagApplied` goals | Task 3 |
| `tests` from tag-category decision criteria | Task 4 |
| `sends`/`entry-point`/`references-campaign` from lifted foreign keys | Task 5 |
| Derived `triggers`, marked `derived: true` | Task 7 |
| All five findings | Task 8 |
| Tag labels from decision criteria; unknown tags keep `label: null` | Tasks 4, 6 |
| CLI writes `artifacts/<app>/graph.json`; `--funnel` skips the graph | Task 9 |
| §9: zero campaigns → fail rather than emit a silent empty graph | Task 6 |
| §10: synthetic two-campaign `triggers` fixture | Task 7 |
| §11 criterion 4: ≥131 tags, ≥295 tag references, excess attributable | Task 9 step 4 |
| §11 criterion 5: at least one `triggers` edge, or the absence explained | Task 9 step 3 (9 found) |
| §11 criterion 7: full suite passes offline | Every task |

**Three deliberate deviations from the design, each recorded where it happens:**

1. `unreachableCampaigns` is `{ campaignId, reason }[]` rather than `string[]`. Two distinct
   conditions produce it — no goals at all, and tag-only entry nobody feeds — and a bare id cannot
   say which.
2. `GraphEdge` gains `viaTagId`. `viaCellId` cannot carry a derived edge's provenance, because the
   linking tag is not a cell in either campaign.
3. Tag entities are registered from all `tagIds` references, not only from edge endpoints. Without
   this the account reports 130 tags instead of the 142 it has, failing design criterion 4 over the
   24 undirected references.
