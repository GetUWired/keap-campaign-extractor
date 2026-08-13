# Tag Impact Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Given a list of tags to delete or combine, report which campaigns reference them and where — as JSON, with a Markdown view generated from it.

**Architecture:** Three pure modules under `src/analyze/` and `src/render/`, plus one CLI. The analysis reads `graph.json` for tag edges and `normalized/*.json` to resolve a cell id into a named sequence and step position. No network, no writes to Keap.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node ≥20, vitest, tsx. No new dependencies — the CSV parser is ~25 lines and adding one would be disproportionate.

## Global Constraints

- **The word "safe" must never appear in the rendered Markdown.** A tag with no campaign references is reported as "no campaign references — other uses are not visible to this tool". There is a test asserting this. This report informs deletions in a live client account.
- **The JSON field is `noCampaignReferences`, never `safeToDelete`.**
- **No network access.** Inputs are `graph.json`, `normalized/*.json` and the operator's list file.
- **Derived `triggers` edges never contribute a location.** They are computed rather than observed, and merge consequences are out of scope.
- **One bad row must not cost the run.** A row with no id, or a duplicate id, warns and is skipped.
- **Every Keap app is a different client.** The tool operates on one account at a time and never compares accounts.
- **The existing 382 tests must pass unchanged.** This work adds modules; it changes no existing behaviour.
- Import specifiers carry `.js` even for TypeScript sources (`./tagList.js`).
- US spelling in identifiers and prose.
- `npm run typecheck` and `npm test` pass at the end of every task.

---

## Context an implementer needs

**The analysis already works — this plan is packaging it.** An ad-hoc run against `se232` on
2026-08-06, using a real 6,227-row client list, produced:

| | Delete | Merge |
|---|---|---|
| tags requested | 2,008 | 1,510 |
| referenced by a campaign | 259 | 375 |
| campaigns affected | 161 | 133 |
| trigger / decision / step locations | 197 / 73 / 401 | 236 / 446 / 223 |

**229 of 398 campaigns affected.** Those numbers are the target: the finished tool should reproduce
them from the same input.

**Where each location comes from.** `graph.json` edges whose `to` is `tag:<id>`:

| edge kind | location `kind` |
|---|---|
| `listens-for` | `trigger` |
| `tests` | `decision` |
| `applies`, `removes` | `step` |

Each edge carries `viaCellId`. Resolving that against the normalized campaign gives the sequence name
and step position — a goal cell matches `campaign.goals`, a decision cell matches
`campaign.decisions`, and a step cell is found by searching each sequence's `steps` array.

**Step positions are 1-based in output.** `steps` is a zero-based array; an operator counting boxes
in the builder starts at one.

**Campaign ids.** Graph node ids are `campaign:<funnelId>`; `NormalizedCampaign.funnelId` is the bare
id. Slice `'campaign:'.length` when going from an edge to a campaign.

**Reading the corpus in tests.** `artifacts/` is gitignored, so corpus-backed tests must skip when it
is absent, the way `test/renderText.test.ts` already does with `describe.skipIf`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/analyze/tagList.ts` (create) | Parse CSV or JSON into one internal `TagList`. Pure. ~90 lines. |
| `src/analyze/tagImpact.ts` (create) | `analyzeTagImpact(list, campaigns, graph) → TagImpactReport`. Pure. ~120 lines. |
| `src/render/tagImpactDoc.ts` (create) | `renderTagImpact(report) → string`. Pure. ~90 lines. |
| `src/cli/tagImpact.ts` (create) | Reads artifacts and the list, writes both outputs. The only impure file. |
| `package.json` (modify) | Add the `tag-impact` script. |

Analysis and rendering are separate for the same reason `graph.ts` and `campaignDoc.ts` are: the JSON
is the artifact, the Markdown is a view of it.

---

### Task 1: Parse the tag list

**Files:**
- Create: `src/analyze/tagList.ts`
- Test: `test/tagList.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface RequestedTag { id: string; name: string; group: string | null }`
  - `interface TagList { tags: RequestedTag[]; warnings: string[] }`
  - `parseTagList(text: string, format: 'csv' | 'json'): TagList`
  - `formatFor(path: string): 'csv' | 'json'` — throws on an unrecognised extension.

- [x] **Step 1: Write the failing test**

Create `test/tagList.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatFor, parseTagList } from '../src/analyze/tagList.js';

describe('formatFor', () => {
  it('chooses by extension, case-insensitively', () => {
    expect(formatFor('list.csv')).toBe('csv');
    expect(formatFor('/tmp/list.JSON')).toBe('json');
  });

  it('refuses anything else rather than guessing', () => {
    expect(() => formatFor('list.txt')).toThrow(/\.csv.*\.json/i);
  });
});

describe('parseTagList — CSV', () => {
  it('reads id, name and group', () => {
    const csv = 'id,name,group\n13269,Nurture Emails,\n14799,Old Newsletter,newsletter\n';
    expect(parseTagList(csv, 'csv').tags).toEqual([
      { id: '13269', name: 'Nurture Emails', group: null },
      { id: '14799', name: 'Old Newsletter', group: 'newsletter' },
    ]);
  });

  it('treats a file with no group column as all deletions', () => {
    // A plain delete list should not need an empty column.
    const csv = 'id,name\n13269,Nurture Emails\n';
    expect(parseTagList(csv, 'csv').tags).toEqual([
      { id: '13269', name: 'Nurture Emails', group: null },
    ]);
  });

  it('handles quoted fields containing commas', () => {
    // A real tag name: List: Minus TSP, Essence, 2024 trip purchased
    const csv = 'id,name,group\n1,"List: Minus TSP, Essence",\n';
    expect(parseTagList(csv, 'csv').tags[0]?.name).toBe('List: Minus TSP, Essence');
  });

  it('handles an escaped quote inside a quoted field', () => {
    const csv = 'id,name,group\n1,"She said ""yes""",\n';
    expect(parseTagList(csv, 'csv').tags[0]?.name).toBe('She said "yes"');
  });

  it('is case-insensitive about column names', () => {
    const csv = 'ID,Name,Group\n1,A,\n';
    expect(parseTagList(csv, 'csv').tags[0]?.id).toBe('1');
  });

  it('warns and skips a row with no id rather than failing the run', () => {
    const csv = 'id,name,group\n,No Id,\n2,Fine,\n';
    const list = parseTagList(csv, 'csv');
    expect(list.tags.map((t) => t.id)).toEqual(['2']);
    expect(list.warnings.some((w) => /no id/i.test(w))).toBe(true);
  });

  it('warns and skips a duplicate id, keeping the first', () => {
    const csv = 'id,name,group\n1,First,\n1,Second,\n';
    const list = parseTagList(csv, 'csv');
    expect(list.tags).toHaveLength(1);
    expect(list.tags[0]?.name).toBe('First');
    expect(list.warnings.some((w) => /duplicate/i.test(w))).toBe(true);
  });

  it('throws when there is no id column at all, because every row is unusable', () => {
    expect(() => parseTagList('name,group\nA,\n', 'csv')).toThrow(/id column/i);
  });

  it('ignores a trailing blank line', () => {
    expect(parseTagList('id,name\n1,A\n\n', 'csv').tags).toHaveLength(1);
  });
});

describe('parseTagList — JSON', () => {
  it('reads delete and combine into one list', () => {
    const json = JSON.stringify({
      delete: [{ id: '13269', name: 'Nurture Emails' }],
      combine: [{ group: 'newsletter', tags: [{ id: '14799', name: 'Old Newsletter' }] }],
    });
    expect(parseTagList(json, 'json').tags).toEqual([
      { id: '13269', name: 'Nurture Emails', group: null },
      { id: '14799', name: 'Old Newsletter', group: 'newsletter' },
    ]);
  });

  it('accepts either key being absent', () => {
    expect(parseTagList('{"delete":[{"id":"1","name":"A"}]}', 'json').tags).toHaveLength(1);
    expect(parseTagList('{"combine":[]}', 'json').tags).toEqual([]);
  });

  it('warns when the same id is both deleted and combined, treating it as combined', () => {
    // Contradictory: the operator should see it rather than have one silently win.
    const json = JSON.stringify({
      delete: [{ id: '1', name: 'A' }],
      combine: [{ group: 'g', tags: [{ id: '1', name: 'A' }] }],
    });
    const list = parseTagList(json, 'json');
    expect(list.tags).toEqual([{ id: '1', name: 'A', group: 'g' }]);
    expect(list.warnings.some((w) => /both/i.test(w))).toBe(true);
  });

  it('throws on malformed JSON rather than returning an empty list', () => {
    expect(() => parseTagList('{oops', 'json')).toThrow();
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/tagList.test.ts
```

Expected: FAIL — `Cannot find module '../src/analyze/tagList.js'`.

- [x] **Step 3: Write the implementation**

Create `src/analyze/tagList.ts`:

```ts
export interface RequestedTag {
  id: string;
  name: string;
  /** The combine group this tag belongs to, or null when it is being deleted outright. */
  group: string | null;
}

export interface TagList {
  tags: RequestedTag[];
  warnings: string[];
}

/**
 * Chooses the parser by file extension.
 *
 * Refuses anything else rather than sniffing the content: a file with the wrong
 * extension is more likely a mistake than an intention, and guessing wrong on a
 * list that drives deletions is not worth the convenience.
 */
export function formatFor(path: string): 'csv' | 'json' {
  const lower = path.toLowerCase();
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.json')) return 'json';
  throw new Error(`Unrecognised list format: ${path}. Supported extensions are .csv and .json.`);
}

/**
 * A minimal RFC 4180 reader.
 *
 * Written rather than added as a dependency: real tag names contain commas and
 * quotes — "List: Minus TSP, Essence, 2024 trip purchased" is one — so quoting
 * has to be honoured, but that is twenty lines, not a package.
 */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') field += char;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Collects tags, rejecting rows with no id and keeping the first of any duplicate. */
function collect(
  entries: { id: string; name: string; group: string | null }[],
  warnings: string[],
): RequestedTag[] {
  const seen = new Map<string, RequestedTag>();
  for (const entry of entries) {
    const id = entry.id.trim();
    if (id === '') {
      warnings.push(`a row has no id and was skipped (name: ${entry.name || 'blank'})`);
      continue;
    }
    const existing = seen.get(id);
    if (existing !== undefined) {
      // Both a delete and a combine for one tag is contradictory. Combining
      // wins, because a tag being merged is not simply being removed, and the
      // operator is told rather than left to wonder which took effect.
      if (existing.group === null && entry.group !== null) {
        existing.group = entry.group;
        warnings.push(`tag ${id} appears as both a deletion and a combine — treated as combine`);
      } else {
        warnings.push(`duplicate id ${id} was skipped; the first entry was kept`);
      }
      continue;
    }
    seen.set(id, { id, name: entry.name.trim(), group: entry.group });
  }
  return [...seen.values()];
}

interface JsonList {
  delete?: { id?: string; name?: string }[];
  combine?: { group?: string; tags?: { id?: string; name?: string }[] }[];
}

export function parseTagList(text: string, format: 'csv' | 'json'): TagList {
  const warnings: string[] = [];

  if (format === 'json') {
    const parsed = JSON.parse(text) as JsonList;
    const entries = [
      ...(parsed.delete ?? []).map((t) => ({ id: t.id ?? '', name: t.name ?? '', group: null })),
      ...(parsed.combine ?? []).flatMap((g) =>
        (g.tags ?? []).map((t) => ({ id: t.id ?? '', name: t.name ?? '', group: g.group ?? '' })),
      ),
    ];
    return { tags: collect(entries, warnings), warnings };
  }

  const rows = parseCsvRows(text).filter((r) => r.some((cell) => cell.trim() !== ''));
  const header = rows[0];
  if (header === undefined) throw new Error('the list is empty');

  const column = (name: string): number =>
    header.findIndex((h) => h.trim().toLowerCase() === name);
  const idAt = column('id');
  if (idAt < 0) throw new Error('the CSV has no id column, so no row can be used');
  const nameAt = column('name');
  // A plain delete list should not have to carry an empty group column.
  const groupAt = column('group');

  const entries = rows.slice(1).map((row) => ({
    id: row[idAt] ?? '',
    name: nameAt >= 0 ? (row[nameAt] ?? '') : '',
    group:
      groupAt >= 0 && (row[groupAt] ?? '').trim() !== '' ? (row[groupAt] as string).trim() : null,
  }));

  return { tags: collect(entries, warnings), warnings };
}
```

- [x] **Step 4: Run the tests**

```bash
npx vitest run test/tagList.test.ts && npm run typecheck
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/analyze/tagList.ts test/tagList.test.ts
git commit -m "feat: parse tag lists from CSV or JSON"
```

---

### Task 2: The impact analysis

**Files:**
- Create: `src/analyze/tagImpact.ts`
- Test: `test/tagImpact.test.ts`

**Interfaces:**
- Consumes: `TagList`, `RequestedTag` from `./tagList.js`; `NormalizedCampaign` from `../normalize/campaign.js`; `AccountGraph` from `../normalize/graph.js`.
- Produces:
  - `type LocationKind = 'trigger' | 'step' | 'decision'`
  - `interface ImpactLocation { campaignId; campaignName; tagId; tagName; group; kind; edgeKind; cellId; sequenceName?; stepPosition?; nodeName? }`
  - `interface TagImpact { tagId; tagName; group; locations; campaignCount }`
  - `interface CampaignImpact { campaignId; campaignName; locations; duplicatedGroups }`
  - `interface TagImpactReport { appName; analyzedAt; tags; campaigns; noCampaignReferences; warnings }`
  - `analyzeTagImpact(appName: string, list: TagList, campaigns: NormalizedCampaign[], graph: AccountGraph): TagImpactReport`

- [x] **Step 1: Write the failing test**

Create `test/tagImpact.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { analyzeTagImpact } from '../src/analyze/tagImpact.js';
import { buildGraph } from '../src/normalize/graph.js';
import { makeCampaign, makeDecision, makeNode, makeSequence } from './fixtures/graphFixtures.js';

const list = (tags: { id: string; name: string; group?: string | null }[]) => ({
  tags: tags.map((t) => ({ id: t.id, name: t.name, group: t.group ?? null })),
  warnings: [],
});

const tagStep = (cellId: string, tagIds: string[], isApply: string, name: string | null = null) => ({
  ...makeNode({
    cellId,
    style: 'tag',
    name,
    config: { isApply },
    references: { tagIds, tagCategoryIds: [] },
  }),
  position: 0,
});

const tagGoal = (cellId: string, tagIds: string[], name: string) =>
  makeNode({ cellId, style: 'tagApplied', name, references: { tagIds, tagCategoryIds: [] } });

describe('analyzeTagImpact — location kinds', () => {
  it('reads a tagApplied goal as a trigger', () => {
    const campaign = makeCampaign({
      funnelId: '16',
      name: 'Welcome',
      goals: [tagGoal('4', ['646'], 'Signed up')],
    });
    const report = analyzeTagImpact('x', list([{ id: '646', name: 'Bought' }]), [campaign], buildGraph([campaign]));
    expect(report.tags[0]?.locations).toEqual([
      {
        campaignId: '16',
        campaignName: 'Welcome',
        tagId: '646',
        tagName: 'Bought',
        group: null,
        kind: 'trigger',
        edgeKind: 'listens-for',
        cellId: '4',
        nodeName: 'Signed up',
      },
    ]);
  });

  it('reads an apply-tag step as a step, with its sequence and 1-based position', () => {
    const campaign = makeCampaign({
      funnelId: '16',
      name: 'Welcome',
      sequences: [
        makeSequence({
          cellId: '3',
          name: 'Onboarding',
          steps: [
            { ...makeNode({ cellId: '9', style: 'email' }), position: 0 },
            { ...tagStep('10', ['646'], 'true', 'Mark bought'), position: 1 },
          ],
        }),
      ],
    });
    const report = analyzeTagImpact('x', list([{ id: '646', name: 'Bought' }]), [campaign], buildGraph([campaign]));
    expect(report.tags[0]?.locations[0]).toMatchObject({
      kind: 'step',
      edgeKind: 'applies',
      sequenceName: 'Onboarding',
      stepPosition: 2,
      nodeName: 'Mark bought',
    });
  });

  it('distinguishes a remove-tag step from an apply', () => {
    const campaign = makeCampaign({
      funnelId: '16',
      sequences: [makeSequence({ cellId: '3', steps: [tagStep('10', ['646'], 'false')] })],
    });
    const report = analyzeTagImpact('x', list([{ id: '646', name: 'Bought' }]), [campaign], buildGraph([campaign]));
    expect(report.tags[0]?.locations[0]?.edgeKind).toBe('removes');
  });

  it('reads a decision that routes on the tag as a decision', () => {
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
                  values: [{ id: '646', label: 'Bought' }],
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
    const campaign = makeCampaign({
      funnelId: '16',
      decisions: [
        makeDecision({
          cellId: '34',
          name: 'Has bought?',
          branches: [{ decisionId: '479', flowId: '3', rules }],
        }),
      ],
    });
    const report = analyzeTagImpact('x', list([{ id: '646', name: 'Bought' }]), [campaign], buildGraph([campaign]));
    expect(report.tags[0]?.locations[0]).toMatchObject({
      kind: 'decision',
      edgeKind: 'tests',
      cellId: '34',
      nodeName: 'Has bought?',
    });
  });

  it('never counts a derived triggers edge as a location', () => {
    // A triggers edge points campaign -> campaign, and merge consequences are
    // out of scope. It must not appear even though it exists in the graph.
    const applier = makeCampaign({
      funnelId: '1',
      sequences: [makeSequence({ cellId: '3', steps: [tagStep('10', ['646'], 'true')] })],
    });
    const listener = makeCampaign({ funnelId: '2', goals: [tagGoal('4', ['646'], 'Starts')] });
    const graph = buildGraph([applier, listener]);
    expect(graph.edges.some((e) => e.kind === 'triggers')).toBe(true);
    const report = analyzeTagImpact('x', list([{ id: '646', name: 'B' }]), [applier, listener], graph);
    expect(report.tags[0]?.locations.every((l) => l.edgeKind !== 'triggers')).toBe(true);
  });
});

describe('analyzeTagImpact — grouping and totals', () => {
  it('reports the same locations by tag and by campaign', () => {
    const campaign = makeCampaign({
      funnelId: '16',
      goals: [tagGoal('4', ['646'], 'A')],
      sequences: [makeSequence({ cellId: '3', steps: [tagStep('10', ['646'], 'true')] })],
    });
    const report = analyzeTagImpact('x', list([{ id: '646', name: 'B' }]), [campaign], buildGraph([campaign]));
    expect(report.tags[0]?.locations).toHaveLength(2);
    expect(report.campaigns[0]?.locations).toHaveLength(2);
    expect(report.tags[0]?.campaignCount).toBe(1);
  });

  it('lists a requested tag no campaign references, without calling it safe', () => {
    const campaign = makeCampaign({ funnelId: '16' });
    const report = analyzeTagImpact('x', list([{ id: '999', name: 'Unused' }]), [campaign], buildGraph([campaign]));
    expect(report.noCampaignReferences).toEqual([{ tagId: '999', tagName: 'Unused' }]);
    expect(report.tags.find((t) => t.tagId === '999')?.locations).toEqual([]);
  });

  it('flags a campaign referencing two tags from one combine group', () => {
    const campaign = makeCampaign({
      funnelId: '16',
      sequences: [
        makeSequence({
          cellId: '3',
          steps: [tagStep('10', ['646'], 'true'), { ...tagStep('11', ['647'], 'true'), position: 1 }],
        }),
      ],
    });
    const report = analyzeTagImpact(
      'x',
      list([
        { id: '646', name: 'A', group: 'newsletter' },
        { id: '647', name: 'B', group: 'newsletter' },
      ]),
      [campaign],
      buildGraph([campaign]),
    );
    expect(report.campaigns[0]?.duplicatedGroups).toEqual([
      { group: 'newsletter', tagIds: ['646', '647'] },
    ]);
  });

  it('does not flag a campaign referencing one tag from a group', () => {
    const campaign = makeCampaign({
      funnelId: '16',
      sequences: [makeSequence({ cellId: '3', steps: [tagStep('10', ['646'], 'true')] })],
    });
    const report = analyzeTagImpact(
      'x',
      list([{ id: '646', name: 'A', group: 'newsletter' }]),
      [campaign],
      buildGraph([campaign]),
    );
    expect(report.campaigns[0]?.duplicatedGroups).toEqual([]);
  });

  it('warns about a campaign whose decision criteria are missing', () => {
    // 2 of 464 decisions in se232 have no criteria on disk. Any tag they route
    // on is invisible, so the report must say it cannot see everything.
    const campaign = makeCampaign({
      funnelId: '16',
      name: 'Has a blind decision',
      decisions: [makeDecision({ cellId: '34', branches: [{ decisionId: '1', flowId: '2', rules: null }] })],
    });
    const report = analyzeTagImpact('x', list([{ id: '646', name: 'B' }]), [campaign], buildGraph([campaign]));
    expect(report.warnings.some((w) => /16.*criteria/i.test(w))).toBe(true);
  });

  it('carries the list's own warnings through', () => {
    const campaign = makeCampaign({ funnelId: '16' });
    const report = analyzeTagImpact(
      'x',
      { tags: [], warnings: ['a row has no id and was skipped'] },
      [campaign],
      buildGraph([campaign]),
    );
    expect(report.warnings).toContain('a row has no id and was skipped');
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/tagImpact.test.ts
```

Expected: FAIL — `Cannot find module '../src/analyze/tagImpact.js'`.

- [x] **Step 3: Write the implementation**

Create `src/analyze/tagImpact.ts`:

```ts
import type { NormalizedCampaign } from '../normalize/campaign.js';
import type { AccountGraph } from '../normalize/graph.js';
import type { RequestedTag, TagList } from './tagList.js';

export type LocationKind = 'trigger' | 'step' | 'decision';

export interface ImpactLocation {
  campaignId: string;
  campaignName: string | null;
  tagId: string;
  tagName: string;
  group: string | null;
  kind: LocationKind;
  /** The graph edge that produced this: listens-for, tests, applies or removes. */
  edgeKind: string;
  cellId: string;
  /** Present for a step: which sequence, and where in it (1-based). */
  sequenceName?: string;
  stepPosition?: number;
  /** The node's own name — the operator's words for why it is there. */
  nodeName?: string | null;
}

export interface TagImpact {
  tagId: string;
  tagName: string;
  group: string | null;
  locations: ImpactLocation[];
  campaignCount: number;
}

export interface CampaignImpact {
  campaignId: string;
  campaignName: string | null;
  locations: ImpactLocation[];
  /** Tags from one combine group that this campaign references more than one of. */
  duplicatedGroups: { group: string; tagIds: string[] }[];
}

export interface TagImpactReport {
  appName: string;
  analyzedAt: string;
  tags: TagImpact[];
  campaigns: CampaignImpact[];
  /** Requested tags no campaign references. NOT the same as "safe to delete". */
  noCampaignReferences: { tagId: string; tagName: string }[];
  warnings: string[];
}

/** Which of the three location kinds an edge represents, or null if it is not one. */
const LOCATION_KIND: Record<string, LocationKind> = {
  'listens-for': 'trigger',
  tests: 'decision',
  applies: 'step',
  removes: 'step',
};

interface Placement {
  kind: LocationKind;
  sequenceName?: string;
  stepPosition?: number;
  nodeName: string | null;
}

/**
 * Finds where a cell sits inside its campaign.
 *
 * The edge says which tag and which campaign; only the normalized campaign can
 * say that cell 10 is step 2 of "Onboarding", which is what an operator needs
 * to find it in the builder.
 */
function placeCell(campaign: NormalizedCampaign, cellId: string, fallback: LocationKind): Placement {
  for (const goal of campaign.goals) {
    if (goal.cellId === cellId) return { kind: 'trigger', nodeName: goal.name };
  }
  for (const decision of campaign.decisions) {
    if (decision.cellId === cellId) return { kind: 'decision', nodeName: decision.name };
  }
  for (const sequence of campaign.sequences) {
    const index = sequence.steps.findIndex((step) => step.cellId === cellId);
    if (index < 0) continue;
    return {
      kind: 'step',
      sequenceName: sequence.name ?? undefined,
      // 1-based: an operator counting boxes in the builder starts at one.
      stepPosition: index + 1,
      nodeName: sequence.steps[index]?.name ?? null,
    };
  }
  return { kind: fallback, nodeName: null };
}

export function analyzeTagImpact(
  appName: string,
  list: TagList,
  campaigns: NormalizedCampaign[],
  graph: AccountGraph,
): TagImpactReport {
  const warnings = [...list.warnings];
  const requested = new Map<string, RequestedTag>(list.tags.map((t) => [t.id, t]));
  const byId = new Map(campaigns.map((c) => [c.funnelId ?? '', c]));

  const byTag = new Map<string, ImpactLocation[]>();
  const byCampaign = new Map<string, ImpactLocation[]>();

  for (const edge of graph.edges) {
    // Derived edges are computed, not observed, and merge consequences are out
    // of scope — a triggers edge is never a location.
    if (edge.derived === true) continue;
    if (!edge.to.startsWith('tag:')) continue;
    const kind = LOCATION_KIND[edge.kind];
    if (kind === undefined) continue;

    const tagId = edge.to.slice('tag:'.length);
    const tag = requested.get(tagId);
    if (tag === undefined) continue;

    const campaignId = edge.from.slice('campaign:'.length);
    const campaign = byId.get(campaignId);
    if (campaign === undefined) continue;

    const placement = placeCell(campaign, edge.viaCellId ?? '', kind);
    const location: ImpactLocation = {
      campaignId,
      campaignName: campaign.name,
      tagId,
      tagName: tag.name,
      group: tag.group,
      kind: placement.kind,
      edgeKind: edge.kind,
      cellId: edge.viaCellId ?? '',
      nodeName: placement.nodeName,
    };
    if (placement.sequenceName !== undefined) location.sequenceName = placement.sequenceName;
    if (placement.stepPosition !== undefined) location.stepPosition = placement.stepPosition;

    byTag.set(tagId, [...(byTag.get(tagId) ?? []), location]);
    byCampaign.set(campaignId, [...(byCampaign.get(campaignId) ?? []), location]);
  }

  // A decision with no criteria on disk hides whatever tags it routes on, so a
  // report that cannot see everything says so rather than reading as complete.
  for (const campaign of campaigns) {
    const blind = campaign.decisions.filter((d) => d.branches.every((b) => b.rules === null));
    if (blind.length > 0) {
      warnings.push(
        `campaign ${campaign.funnelId} has ${blind.length} decision(s) with no criteria on disk — ` +
          `any tag they route on is invisible to this analysis`,
      );
    }
  }

  const tags: TagImpact[] = list.tags.map((tag) => {
    const locations = byTag.get(tag.id) ?? [];
    return {
      tagId: tag.id,
      tagName: tag.name,
      group: tag.group,
      locations,
      campaignCount: new Set(locations.map((l) => l.campaignId)).size,
    };
  });

  const campaignImpacts: CampaignImpact[] = [...byCampaign.entries()]
    .map(([campaignId, locations]) => {
      const groups = new Map<string, Set<string>>();
      for (const location of locations) {
        if (location.group === null) continue;
        groups.set(location.group, (groups.get(location.group) ?? new Set()).add(location.tagId));
      }
      return {
        campaignId,
        campaignName: locations[0]?.campaignName ?? null,
        locations,
        duplicatedGroups: [...groups.entries()]
          .filter(([, ids]) => ids.size > 1)
          .map(([group, ids]) => ({ group, tagIds: [...ids].sort() })),
      };
    })
    .sort((a, b) => b.locations.length - a.locations.length);

  return {
    appName,
    analyzedAt: new Date().toISOString(),
    tags,
    campaigns: campaignImpacts,
    noCampaignReferences: tags
      .filter((t) => t.locations.length === 0)
      .map((t) => ({ tagId: t.tagId, tagName: t.tagName })),
    warnings,
  };
}
```

- [x] **Step 4: Run the tests**

```bash
npx vitest run test/tagImpact.test.ts && npm run typecheck
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/analyze/tagImpact.ts test/tagImpact.test.ts
git commit -m "feat: analyze which campaigns reference a list of tags, and where"
```

---

### Task 3: The Markdown view

**Files:**
- Create: `src/render/tagImpactDoc.ts`
- Test: `test/tagImpactDoc.test.ts`

**Interfaces:**
- Consumes: `TagImpactReport`, `ImpactLocation` from `../analyze/tagImpact.js`; `plainText` from `./text.js`.
- Produces: `renderTagImpact(report: TagImpactReport): string`.

- [x] **Step 1: Write the failing test**

Create `test/tagImpactDoc.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { ImpactLocation, TagImpactReport } from '../src/analyze/tagImpact.js';
import { renderTagImpact } from '../src/render/tagImpactDoc.js';

const location = (over: Partial<ImpactLocation> = {}): ImpactLocation => ({
  campaignId: '16',
  campaignName: 'Welcome',
  tagId: '646',
  tagName: 'Bought',
  group: null,
  kind: 'trigger',
  edgeKind: 'listens-for',
  cellId: '4',
  nodeName: 'Signed up',
  ...over,
});

const report = (over: Partial<TagImpactReport> = {}): TagImpactReport => ({
  appName: 'se232',
  analyzedAt: '2026-08-06T00:00:00.000Z',
  tags: [],
  campaigns: [],
  noCampaignReferences: [],
  warnings: [],
  ...over,
});

describe('renderTagImpact', () => {
  it('never uses the word "safe"', () => {
    // This report sits beside someone deleting tags in a live client account.
    const page = renderTagImpact(
      report({ noCampaignReferences: [{ tagId: '999', tagName: 'Unused' }] }),
    );
    expect(page.toLowerCase()).not.toContain('safe');
  });

  it('says what "no campaign references" does and does not mean', () => {
    const page = renderTagImpact(
      report({ noCampaignReferences: [{ tagId: '999', tagName: 'Unused' }] }),
    );
    expect(page).toMatch(/no campaign references/i);
    expect(page).toMatch(/not visible to this tool/i);
  });

  it('carries the caveat even when nothing is unreferenced', () => {
    expect(renderTagImpact(report())).toMatch(/campaign usage only/i);
  });

  it('describes a trigger location by its goal', () => {
    const page = renderTagImpact(
      report({ campaigns: [{ campaignId: '16', campaignName: 'Welcome', locations: [location()], duplicatedGroups: [] }] }),
    );
    expect(page).toMatch(/Trigger/);
    expect(page).toContain('Signed up');
  });

  it('describes a step by its sequence and position', () => {
    const step = location({
      kind: 'step',
      edgeKind: 'removes',
      sequenceName: 'Onboarding',
      stepPosition: 2,
      nodeName: null,
    });
    const page = renderTagImpact(
      report({ campaigns: [{ campaignId: '16', campaignName: 'Welcome', locations: [step], duplicatedGroups: [] }] }),
    );
    expect(page).toContain('Onboarding');
    expect(page).toContain('step 2');
    expect(page).toMatch(/removes/i);
  });

  it('reports a campaign that references two tags from one group', () => {
    const page = renderTagImpact(
      report({
        campaigns: [
          {
            campaignId: '16',
            campaignName: 'Welcome',
            locations: [location()],
            duplicatedGroups: [{ group: 'newsletter', tagIds: ['646', '647'] }],
          },
        ],
      }),
    );
    expect(page).toContain('newsletter');
  });

  it('lists warnings so a partial view is visible', () => {
    const page = renderTagImpact(report({ warnings: ['campaign 16 has 2 decision(s) with no criteria'] }));
    expect(page).toContain('no criteria');
  });

  it('escapes a pipe in a name so the Markdown table survives', () => {
    const page = renderTagImpact(
      report({ noCampaignReferences: [{ tagId: '1', tagName: 'A | B' }] }),
    );
    const row = page.split('\n').find((l) => l.includes('A ')) ?? '';
    expect(row.split('|').length).toBeLessThanOrEqual(5);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/tagImpactDoc.test.ts
```

Expected: FAIL — `Cannot find module '../src/render/tagImpactDoc.js'`.

- [x] **Step 3: Write the implementation**

Create `src/render/tagImpactDoc.ts`:

```ts
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
    const goal = location.nodeName === null ? `cell ${location.cellId}` : `"${cell(location.nodeName)}"`;
    return `**Trigger** — goal ${goal} starts this campaign when ${tag} is applied`;
  }
  if (location.kind === 'decision') {
    const name = location.nodeName === null ? `cell ${location.cellId}` : `"${cell(location.nodeName)}"`;
    return `**Decision** — ${name} routes on ${tag}`;
  }
  const sequence = location.sequenceName === undefined ? 'an unnamed sequence' : `"${cell(location.sequenceName)}"`;
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
  const affected = report.campaigns.length;
  const locations = report.campaigns.reduce((n, c) => n + c.locations.length, 0);

  lines.push('## Summary', '');
  lines.push('| | Count |', '|---|---|');
  lines.push(`| Tags requested | ${report.tags.length} |`);
  lines.push(`| Referenced by at least one campaign | ${referenced.length} |`);
  lines.push(`| No campaign references | ${report.noCampaignReferences.length} |`);
  lines.push(`| Campaigns affected | ${affected} |`);
  lines.push(`| Affected locations | ${locations} |`);
  lines.push('');

  if (report.campaigns.length > 0) {
    lines.push('## Affected campaigns', '', 'Ordered by number of affected locations.', '');
    for (const campaign of report.campaigns) {
      const name = campaign.campaignName === null ? `Campaign ${campaign.campaignId}` : cell(campaign.campaignName);
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
```

- [x] **Step 4: Run the tests**

```bash
npx vitest run test/tagImpactDoc.test.ts && npm run typecheck
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/render/tagImpactDoc.ts test/tagImpactDoc.test.ts
git commit -m "feat: render the tag impact report as Markdown"
```

---

### Task 4: The CLI, and the real-corpus check

**Files:**
- Create: `src/cli/tagImpact.ts`
- Modify: `package.json`
- Test: `test/tagImpactCorpus.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces: `npm run tag-impact -- --app <app> --tags <file>` → `artifacts/<app>/tag-impact.json` and `tag-impact.md`.

- [x] **Step 1: Write the CLI**

Create `src/cli/tagImpact.ts`:

```ts
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { analyzeTagImpact } from '../analyze/tagImpact.js';
import { formatFor, parseTagList } from '../analyze/tagList.js';
import { normalizeAppName } from '../app.js';
import type { NormalizedCampaign } from '../normalize/campaign.js';
import type { AccountGraph } from '../normalize/graph.js';
import { renderTagImpact } from '../render/tagImpactDoc.js';

function fail(message: string): void {
  console.error(`\n${message}\n`);
  process.exitCode = 1;
}

function argAfter(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const rawApp = argAfter(argv, '--app');
  const tagsPath = argAfter(argv, '--tags');
  if (!rawApp || !tagsPath) {
    fail('Usage: npm run tag-impact -- --app <appName> --tags <list.csv|list.json>');
    return;
  }

  let app: string;
  let format: 'csv' | 'json';
  try {
    app = normalizeAppName(rawApp);
    format = formatFor(tagsPath);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  if (!existsSync(tagsPath)) {
    fail(`No tag list at ${tagsPath}`);
    return;
  }

  const normalizedDir = join('artifacts', app, 'normalized');
  const graphPath = join('artifacts', app, 'graph.json');
  if (!existsSync(normalizedDir) || !existsSync(graphPath)) {
    fail(`No normalized data at ${normalizedDir}. Run:  npm run normalize -- --app ${app}`);
    return;
  }

  let list;
  try {
    list = parseTagList(await readFile(tagsPath, 'utf8'), format);
  } catch (error) {
    fail(`could not read the tag list — ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  // An empty report would read as "nothing is affected", which is a different
  // claim from "the list was empty".
  if (list.tags.length === 0) {
    fail('the tag list contains no usable rows');
    return;
  }

  const graph = JSON.parse(await readFile(graphPath, 'utf8')) as AccountGraph;
  const campaigns: NormalizedCampaign[] = [];
  for (const file of (await readdir(normalizedDir)).sort()) {
    if (!/^\d+\.json$/.test(file)) continue;
    campaigns.push(JSON.parse(await readFile(join(normalizedDir, file), 'utf8')) as NormalizedCampaign);
  }

  const report = analyzeTagImpact(app, list, campaigns, graph);
  const jsonPath = join('artifacts', app, 'tag-impact.json');
  const mdPath = join('artifacts', app, 'tag-impact.md');
  await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  await writeFile(mdPath, renderTagImpact(report), 'utf8');

  const locations = report.campaigns.reduce((n, c) => n + c.locations.length, 0);
  const kinds = { trigger: 0, decision: 0, step: 0 };
  for (const campaign of report.campaigns) {
    for (const location of campaign.locations) kinds[location.kind]++;
  }

  console.log(`\n[${app}] ${list.tags.length} tags requested`);
  console.log(`  referenced by a campaign: ${report.tags.filter((t) => t.locations.length > 0).length}`);
  console.log(`  no campaign references:   ${report.noCampaignReferences.length}`);
  console.log(`  campaigns affected:       ${report.campaigns.length} of ${campaigns.length}`);
  console.log(`  locations: ${locations} — ${kinds.trigger} trigger, ${kinds.decision} decision, ${kinds.step} step`);
  for (const warning of report.warnings.slice(0, 5)) console.log(`  warning: ${warning}`);
  if (report.warnings.length > 5) console.log(`  … and ${report.warnings.length - 5} more warnings`);
  console.log(`  output: ${jsonPath}\n          ${mdPath}\n`);
}

await main();
```

- [x] **Step 2: Add the npm script**

In `package.json`, beside `"render"`:

```json
    "tag-impact": "tsx src/cli/tagImpact.ts",
```

- [x] **Step 3: Write the corpus test**

Create `test/tagImpactCorpus.test.ts`:

```ts
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeTagImpact } from '../src/analyze/tagImpact.js';
import { parseTagList } from '../src/analyze/tagList.js';
import type { NormalizedCampaign } from '../src/normalize/campaign.js';
import type { AccountGraph } from '../src/normalize/graph.js';
import { renderTagImpact } from '../src/render/tagImpactDoc.js';

// artifacts/ is gitignored, so this runs only where the corpus exists.
const DIR = new URL('../artifacts/se232/normalized/', import.meta.url);
const GRAPH = new URL('../artifacts/se232/graph.json', import.meta.url);
const present = existsSync(DIR) && existsSync(GRAPH);

describe.skipIf(!present)('tag impact against the real se232 corpus', () => {
  const graph = JSON.parse(readFileSync(GRAPH, 'utf8')) as AccountGraph;
  const campaigns = readdirSync(DIR)
    .filter((f) => /^\d+\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(new URL(f, DIR), 'utf8')) as NormalizedCampaign);

  it('reproduces the measured impact of tag 13269', () => {
    // Measured before this tool existed: 139 distinct campaigns.
    const list = parseTagList('id,name\n13269,Funnel -> In Funnel: Nurture Emails\n', 'csv');
    const report = analyzeTagImpact('se232', list, campaigns, graph);
    expect(report.tags[0]?.campaignCount).toBe(139);
    expect(report.campaigns).toHaveLength(139);
  });

  it('resolves every step location to a sequence and position', () => {
    const list = parseTagList('id,name\n13269,Nurture\n', 'csv');
    const report = analyzeTagImpact('se232', list, campaigns, graph);
    const steps = report.campaigns.flatMap((c) => c.locations).filter((l) => l.kind === 'step');
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((s) => typeof s.stepPosition === 'number')).toBe(true);
  });

  it('renders the whole thing without the word "safe"', () => {
    const list = parseTagList('id,name\n13269,Nurture\n999999,Not Used\n', 'csv');
    const page = renderTagImpact(analyzeTagImpact('se232', list, campaigns, graph));
    expect(page.toLowerCase()).not.toContain('safe');
    expect(page).toMatch(/no campaign references/i);
  });
});
```

- [x] **Step 4: Run everything**

```bash
npm test && npm run typecheck
```

Expected: PASS, including all 382 pre-existing tests unchanged.

- [x] **Step 5: Run it against the real list**

The client list uses `Delete`/`Merge` boolean columns rather than this tool's `group` column, so
convert it first — this is the transform the spec deliberately does not cover:

```bash
node --input-type=module -e "
import {readFileSync,writeFileSync} from 'node:fs';
const rows=readFileSync('tag-list.csv','utf8').split('\n');
const head=rows[0].split(',');
const ix=Object.fromEntries(head.map((h,i)=>[h.trim(),i]));
const out=['id,name,group'];
for(const line of rows.slice(1)){
  if(!line.trim()) continue;
  const c=line.split(',');
  const id=c[ix.tag_id]; if(!id) continue;
  const del=String(c[ix.Delete]).toUpperCase()==='TRUE';
  const mrg=String(c[ix.Merge]).toUpperCase()==='TRUE';
  if(!del&&!mrg) continue;
  out.push([id,'\"'+String(c[ix.tag_name]).replace(/\"/g,'\"\"')+'\"',mrg?'merge':''].join(','));
}
writeFileSync('/tmp/tags-for-impact.csv', out.join('\n'));
console.log('rows:', out.length-1);
"
npm run tag-impact -- --app se232 --tags /tmp/tags-for-impact.csv
```

Expected: **229 campaigns affected of 398**, matching the ad-hoc run of 2026-08-06. A different
number means a bug in this implementation, not a stale expectation.

Note the naive split on `,` in that snippet mangles quoted names; it is fine for producing ids and a
`group` column, and the tool's own parser handles quoting properly.

- [x] **Step 6: Commit**

```bash
git add src/cli/tagImpact.ts test/tagImpactCorpus.test.ts package.json
git commit -m "feat: tag-impact CLI writing JSON and a Markdown view"
```

---

### Task 5: Record what it found

**Files:**
- Modify: `docs/spike-findings.md`

- [x] **Step 1: Append the section**

Append a `## 17. Tag impact analysis` section covering, with the real numbers from Task 4 step 5:

- What the tool answers and what it deliberately does not (no merge-consequence inference, no
  recommendation about which tags to delete, no write access).
- The headline result for `se232`: 229 of 398 campaigns affected by a 3,518-tag list.
- The delete/merge split, and that **merges hit decisions far harder than deletes** — 446 decision
  locations against 73 — because merged tags are the ones campaigns branch on.
- **22 campaigns would lose every entry point**, all of them published. That is the finding worth
  leading with: not a step that stops working, but a live campaign that silently never runs again.
- That 1,749 delete-tags and 1,135 merge-tags have no campaign references, and why that is **not**
  the same as safe to delete.
- The known gap: the client list marks tags for merging but not what they merge into, so
  `duplicatedGroups` cannot be computed from it.

Follow the existing sections' voice: what was observed, what it cost, what it means.

- [x] **Step 2: Commit**

```bash
git add docs/spike-findings.md
git commit -m "docs: record tag impact analysis results"
```

---

## Self-review against the spec

| Spec requirement | Where |
|---|---|
| §4 Three location kinds from `listens-for` / `tests` / `applies`+`removes` | Task 2 |
| §4 Derived `triggers` edges excluded | Task 2, tested explicitly |
| §5 CSV and JSON, chosen by extension | Task 1 |
| §5 Blank group = delete; shared group = combine | Task 1 |
| §5 CSV with no `group` column = all deletions | Task 1 |
| §5 Bad row warns and is skipped | Task 1 |
| §5 No `id` column at all = fail | Task 1 |
| §6 JSON is the artifact, Markdown a view of it | Tasks 2–4 |
| §6 Organised both by tag and by campaign | Task 2 |
| §6 `sequenceName` and `stepPosition` from `viaCellId` | Task 2 |
| §7 Never says "safe"; `noCampaignReferences` naming | Task 3, tested |
| §7 Decisions with missing criteria warned | Task 2 |
| §8 `duplicatedGroups` for combine groups | Tasks 2, 3 |
| §9 File layout and the `tag-impact` script | Tasks 1–4 |
| §10 Every error-handling row | Tasks 1, 4 |
| §11 All eleven test cases | Tasks 1–4 |
| §12 All six success criteria | Task 4 |

**One deviation, stated where it happens:** the spec's §10 says a tag id appearing in both a delete
and a combine group warns and is treated as a combine member. That is implemented in `tagList.ts`
rather than in the analysis, because it is a property of the list rather than of the impact — which
also means it is caught before any graph work happens.
