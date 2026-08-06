# Normaliser and Relationship Graph — Design

Date: 2026-08-06
Status: approved, ready for implementation planning
Builds on: `2026-08-05-bulk-extraction-design.md`
Evidence: `docs/spike-findings.md`, and the 170-campaign corpus in `artifacts/jordan/`

## 1. Context

The whole `jordan` account is on disk: 170 campaigns, 6,521 cells, 85 decision diamonds. What has
been captured is **raw data plus a thin index**. `meta.json` carries a cell count, a style histogram,
warnings, and a list of decision cells — because `parseCells` was built to answer exactly one
question: which decision cells exist, so their criteria could be fetched.

For campaign 16 that means 18 sequences, 69 edges, 63 nested steps and 6 email references sit in the
XML, unread. Nothing currently answers what sequences a campaign has, what runs in what order, which
email a step sends, or what connects to what.

Four facts from surveying the corpus shape this design:

- **61 distinct node styles**, 47 undocumented against a handoff listing 10.
- **104 distinct `<Object>` attributes**, 23 of them Java-Long foreign keys.
- **13 `<Array as="…">` containers.** Tags live here, not in attributes — `<Array as="tagIds">` with
  `<add value="352L"/>` children. A normaliser reading only attributes would miss every tag in the
  account.
- **131 distinct tags, 295 references.** The raw material for the relationship graph is already
  extracted.

## 2. Goal

Turn each campaign's raw artifacts into canonical JSON, and turn the set of them into an account-level
graph whose nodes are campaigns and shared entities.

## 3. Non-goals

- Any network access. Both stages are pure functions over files already on disk.
- REST API enrichment. Ids stay ids; resolving them to names is stage 3.
- LLM summaries, Mermaid rendering, the canonical store, the tool surface.
- Interpreting timer hour fields. The handoff records an unresolved timezone discrepancy (§4.2);
  timer config is captured verbatim and left uninterpreted.

## 4. Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Config capture | Generic, plus lifted references | 61 styles and 104 attributes make per-style modelling enormous and brittle, and the vocabulary was unknown until yesterday. Everything is captured verbatim; the 23 foreign keys and `tagIds` are additionally lifted into a normalised block for the graph. |
| Output location | A separate `normalized/` tree | Raw artifacts stay immutable, and the graph stage can load 170 files without walking per-campaign directories. |
| Scope | Normaliser **and** graph | Chosen deliberately: one command produces both. |
| Coupling | Two independent pure modules | The concern with building both together is coupling a per-campaign transform to an account-wide aggregation. Kept apart in code: `campaign.ts` never sees the account, `graph.ts` never sees XML. One CLI runs both. |
| Unknown styles | Warn, still emit the node | The documented list was 10 against 61 real. Failing closed would have discarded most of the corpus. |

## 5. Step ordering — verified, not assumed

Within a sequence, steps are vertices whose `parent` is the flow's cell id. Edges are **separate
cells** with `style="edge"`, `edge="1"`, the same `parent`, and `source`/`target` attributes.

Verified against campaign 584's "Satisfied" sequence, whose order the handoff documents in §8:

```
edges: 14→81, 81→25, 25→27, 27→17
walk from the start vertex: 14 → 81 → 25 → 27 → 17
handoff:                    14 start, 81 timerDelay, 25 email, 27 timerDelay, 17 email
```

Those edge cells appear in the XML in the order 28, 18, 82, 83. **Document order is not step order**,
so walking is required rather than an optimisation.

The walk starts at the vertex with `style="start"`, follows `source`→`target`, and stops on a repeat
visit. Where it cannot complete — no start vertex, a branch with two outbound edges, an unreachable
vertex — the sequence keeps document order and records a warning naming the sequence and the reason.
Order is never guessed silently.

## 6. `src/normalize/campaign.ts`

```ts
export interface NormalizedNode {
  cellId: string;
  style: string;
  metaType: string | null;
  name: string | null;
  ready: boolean | null;
  published: boolean | null;
  config: Record<string, string>;      // every attribute, verbatim
  lists: Record<string, string[]>;     // every <Array as="…">, verbatim
  references: NodeReferences;          // lifted foreign keys and tagIds
}

export interface NodeReferences {
  tagIds: string[];
  tagCategoryIds: string[];
  marketingEmailId?: string;
  webformId?: string;
  landingPageId?: string;
  purchaseId?: string;
  eventId?: string;
  sourceFunnelId?: string;
  internalFormId?: string;
  actionSetId?: string;
  [other: string]: string | string[] | undefined;
}

export interface NormalizedSequence extends NormalizedNode {
  flowType: string | null;
  steps: (NormalizedNode & { position: number })[];
  orderVerified: boolean;
}

export interface NormalizedDecision extends NormalizedNode {
  branches: { decisionId: string; flowId: string; rules: DecisionCriteria | null }[];
  elseFlowId: string | null;
}

export interface NormalizedCampaign {
  funnelId: string;
  appName: string | null;
  name: string | null;
  published: boolean;
  hasUnpublishedChanges: boolean;
  goals: NormalizedNode[];
  sequences: NormalizedSequence[];
  decisions: NormalizedDecision[];
  notes: NormalizedNode[];
  edges: { source: string; target: string; scope: string }[];
  orphans: string[];
  styleCounts: Record<string, number>;
  warnings: string[];
}

export function normalizeCampaign(
  draftXml: string,
  publishXml: string,
  criteriaByCellId: Record<string, DecisionCriteria>,
): NormalizedCampaign;
```

Ids are stripped of the Java-Long `L` and `~br~` is replaced in names, reusing `stripLongSuffix` and
`cleanName`. Goals are top-level vertices (`parent="1"`) that are not flows, edges or notes. Orphans
are vertices with no inbound and no outbound edge.

`hasUnpublishedChanges` is `publishXml` non-empty and differing from `draftXml`. Note the finding
that `publishXml` is a **more reliable** published signal than the list page's date column: one
campaign has a 1,863-char `publishXml` and no date.

## 7. `src/normalize/graph.ts`

```ts
export type EntityKind = 'campaign' | 'tag' | 'email' | 'webform' | 'landingPage' | 'product' | 'form';
export type EdgeKind =
  | 'applies' | 'removes' | 'listens-for' | 'tests'
  | 'sends' | 'entry-point' | 'references-campaign' | 'triggers';

export interface GraphEdge {
  from: string;              // "campaign:987"
  to: string;                // "tag:1123"
  kind: EdgeKind;
  viaCellId?: string;
  derived?: boolean;
}

export interface AccountGraph {
  entities: { id: string; kind: EntityKind; label: string | null; campaignCount: number }[];
  edges: GraphEdge[];
  findings: {
    unreachableCampaigns: string[];
    tagsAppliedByNobody: string[];
    tagsNobodyListensFor: string[];
    sharedEmails: { emailId: string; campaigns: string[] }[];
    duplicateTagAppliers: { tagId: string; campaigns: string[] }[];
  };
  warnings: string[];
}

export function buildGraph(campaigns: NormalizedCampaign[]): AccountGraph;
```

Observed edges come straight from the normalised nodes: `applies`/`removes` from `tag` steps with
`isApply` giving the direction, `listens-for` from `tagApplied` goals, `tests` from decision criteria
whose category is tags, and `sends`/`entry-point`/`references-campaign` from the lifted foreign keys.

One edge is **derived**: campaign A `triggers` campaign B when A applies tag T and B listens for T.
It carries `derived: true` so a reader can always tell computed edges from observed ones. Every
finding in the block above falls out of the same structure — `unreachableCampaigns` are those whose
only entry is a `tagApplied` goal for a tag nothing applies.

Tag labels come from decision criteria, which are the only place display names appear in the
extracted data. Tags known only by id keep `label: null` until stage 3 resolves them.

## 8. `src/cli/normalize.ts`

```bash
npm run normalize -- --app jordan [--funnel <id>]
```

Reads `artifacts/<app>/campaigns/*/`, writes `artifacts/<app>/normalized/<funnelId>.json` and
`artifacts/<app>/graph.json`. `--funnel` normalises one campaign and skips the graph, for iterating.

No session, no network. Re-runs in seconds.

## 9. Error handling

| Condition | Behaviour |
|---|---|
| No `artifacts/<app>/campaigns/` | Fail, naming `npm run extract-all -- --app <app>`. |
| A campaign's `draft.xml` is missing or unparseable | Record a warning, skip that campaign, continue. One bad artifact must not stop 169 others. |
| A decision cell has no criteria file | Emit the branch with `rules: null` and warn. Routing is still known from the XML. |
| Unknown style | Node emitted with generic config; style named in warnings. |
| Sequence order cannot be walked | Document order, `orderVerified: false`, warning naming the sequence and reason. |
| An edge references a missing cell | Kept in `edges` and named in warnings — it is real data about a broken campaign. |
| Zero campaigns normalised | Fail. A silent empty graph is worse than an error. |

## 10. Testing

Both modules are pure and test offline against the real corpus:

- Campaign 584's "Satisfied" sequence yields steps in exactly the handoff's documented order, with
  `orderVerified: true`.
- Campaign 584's edge list matches handoff §8 exactly.
- Campaign 987's decision 34 has two branches carrying the criteria already on disk.
- Campaign 16 yields 18 sequences and 69 edges.
- An unknown style produces a node plus a warning, never an exception.
- A sequence with no `start` falls back to document order and warns.
- **All 170 campaigns normalise without throwing** — the strongest available assertion.
- The graph finds **at least** 131 distinct tags and 295 references. Those figures were counted from
  `<Array as="tagIds">` alone, so a tag referenced only by a decision rule legitimately pushes the
  total higher. The assertion is a floor; a shortfall is a bug, an excess is expected and should be
  attributable to decision criteria.
- A synthetic two-campaign fixture where A applies tag T and B listens for T produces exactly one
  `triggers` edge, marked `derived`.

## 11. Success criteria

1. `npm run normalize -- --app jordan` writes 170 normalised files and one `graph.json`.
2. Campaign 584's sequence order matches the handoff exactly.
3. Every campaign normalises; the count of files equals the count of campaign directories.
4. The graph contains at least 131 tag entities and 295 tag references, with any excess attributable
   to tags appearing only in decision criteria.
5. At least one `triggers` edge is found, or its absence is explained in the findings.
6. Warnings name every unknown style and every unverified sequence order.
7. The full suite passes offline.
