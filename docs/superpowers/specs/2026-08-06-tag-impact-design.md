# Tag Impact Analysis — Design

Date: 2026-08-06
Status: approved, ready for implementation planning
Builds on: `2026-08-06-normaliser-design.md`, `2026-08-06-renderers-design.md`
Evidence: `docs/spike-findings.md` §12–16, and both accounts in `artifacts/`

## 1. Context

The first real use of this data is deciding which tags in a Keap account can be deleted or merged
without breaking the automation. An operator assembles a list of tags, and needs to know which
campaigns reference them and where, before making the change.

The graph already answers this. Deleting `tag:13269` in `se232` — "Funnel -> In Funnel: Nurture
Emails" — would touch **139 of 398 campaigns** — 1 referencing it as a trigger, 138 in decisions, and 138
applying or removing it, mostly the same campaigns doing several at once. What is missing is an interface: a way to pass in a list and get an answer back.

This is a stepping stone. The larger goal is understanding how an account's campaigns relate to each
other; tag impact is the first question worth answering along the way.

## 2. Goal

Given a list of tags to delete or combine, report which campaigns reference each one, and where in
the campaign.

## 3. Non-goals

- **Performing the deletion or merge.** This tool reports; the operator acts. It needs no write
  access to anything, and the read-only guard stays untouched.
- **Deriving consequences of a merge.** Merging tags A and B can wire two previously unrelated
  campaigns together. That is real, and deliberately out of scope: the operator asked for what is
  referenced and where, not for inference about what would result.
- **Recommending which tags to delete.** The list is an input, not an output.
- Cross-account analysis. Every Keap app is a different client; accounts are never compared or
  merged.

## 4. What counts as an affected location

Three types, from the graph's existing tag edges:

| Location | Graph edge | What breaking it means |
|---|---|---|
| **Trigger** | `listens-for` | The campaign loses an entry point — it can no longer start this way |
| **Sequence step** | `applies`, `removes` | A step stops doing what it was configured to do |
| **Decision** | `tests` | Routing changes; contacts take a different branch |

Volumes, so the weight of each is clear:

| | jordan | se232 |
|---|---|---|
| `applies` | 146 | 1,730 |
| `removes` | 99 | 870 |
| `listens-for` | 27 | 1,242 |
| `tests` | 43 | **1,746** |

Decisions are the largest category in a real account. Omitting them would make the analysis
incomplete on the thing it most needs to get right.

Derived `triggers` edges are excluded: they are computed, not observed, and a merge's consequences
are out of scope per §3.

## 5. Input — CSV or JSON, chosen by extension

Both forms carry id **and** name. The id is what the analysis matches on; the name is what makes the
report readable and lets the operator confirm the list is the one they meant.

**CSV**, which is where a list like this is usually assembled:

```csv
id,name,group
13269,Funnel -> In Funnel: Nurture Emails,
14799,Old Newsletter Subscriber,newsletter
14801,Newsletter Signup 2023,newsletter
```

An empty `group` means the tag is being deleted. A shared `group` value means those tags are being
combined into one. Group names are labels only — the tool never needs to know which tag survives,
because every tag in the group is being changed either way.

**JSON**, the same thing stated explicitly:

```json
{
  "delete": [{ "id": "13269", "name": "Funnel -> In Funnel: Nurture Emails" }],
  "combine": [
    { "group": "newsletter", "tags": [{ "id": "14799", "name": "Old Newsletter Subscriber" }] }
  ]
}
```

A row that cannot be parsed is warned about and skipped. A typo in one row must not cost the
operator the other forty.

## 6. Output — JSON first, Markdown generated from it

`artifacts/<app>/tag-impact.json` is the source of truth; `artifacts/<app>/tag-impact.md` is
rendered from it. The same relationship `graph.json` has with the campaign pages.

The result is organised **two ways**, because the operator asks two different questions:

- **by tag** — "what does deleting this one touch?"
- **by campaign** — "what do I actually need to open and fix?"

```ts
export type LocationKind = 'trigger' | 'step' | 'decision';

export interface ImpactLocation {
  campaignId: string;          // "987"
  campaignName: string | null;
  tagId: string;
  tagName: string;             // as supplied in the list
  kind: LocationKind;
  /** 'applies' | 'removes' for a step; 'listens-for'; 'tests'. */
  edgeKind: string;
  cellId: string;
  /** Present for a step: which sequence, and where in it. */
  sequenceName?: string;
  stepPosition?: number;
  /** The node's own name — the operator's words for why it is there. */
  nodeName?: string | null;
}

export interface TagImpact {
  tagId: string;
  tagName: string;
  /** The combine group this tag belongs to, or null when it is being deleted outright. */
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
```

`sequenceName` and `stepPosition` come from resolving `viaCellId` against the normalized campaign, so
the operator can find the step in the builder without hunting. That means the analysis reads both
`graph.json` and `normalized/*.json`.

## 7. Two guardrails built in, not bolted on

**Never say "safe to delete."** This tool informs a destructive action, and it sees campaign usage
only. Tags are also used in saved searches, broadcasts, manual application, internal forms,
integrations and other automation — none of it in our data. A requested tag with no campaign
references is reported as:

> **no campaign references** — other uses are not visible to this tool

in both the JSON field name (`noCampaignReferences`, not `safeToDelete`) and the Markdown wording.
Getting this wrong once could cost a client something real.

**Flag decisions whose criteria are missing.** 11 of 85 decisions in `jordan` and 2 of 464 in
`se232` have no criteria on disk, so any tag they route on is invisible. Those campaigns are named
in `warnings`, so a report that cannot see everything says so rather than reading as complete.

## 8. One factual extra for combine groups

When a single campaign references **two or more tags from the same combine group**, it is flagged in
`duplicatedGroups`. After the merge that campaign will have two steps doing the identical thing.

This is a local fact about one campaign, not inference about what the merge wires together — the
distinction §3 draws. It is called out here because it is an addition to what was asked for.

## 9. Shape

| File | Responsibility |
|---|---|
| `src/analyze/tagList.ts` (create) | Parse CSV or JSON into one internal shape. Pure. |
| `src/analyze/tagImpact.ts` (create) | `analyzeTagImpact(list, campaigns, graph) → TagImpactReport`. Pure. |
| `src/render/tagImpactDoc.ts` (create) | `renderTagImpact(report) → string`. Pure. |
| `src/cli/tagImpact.ts` (create) | Reads artifacts, writes both outputs. The only impure file. |
| `package.json` (modify) | Add the `tag-impact` script. |

```bash
npm run tag-impact -- --app se232 --tags ./tags-to-delete.csv
```

No network. Everything it needs is already on disk.

## 10. Error handling

| Condition | Behaviour |
|---|---|
| No `graph.json` or `normalized/` | Fail, naming `npm run normalize -- --app <app>`. |
| `--tags` file missing | Fail, naming the path. |
| Unrecognised extension | Fail, saying `.csv` and `.json` are supported. |
| CSV missing an `id` column | Fail — every row would be unusable, so this is a bad file, not a bad row. |
| A row with no id, or a duplicate id | Warn and skip that row; carry on. |
| A tag id no campaign references | Not an error. Reported in `noCampaignReferences`. |
| A decision with no criteria on disk | Warn, naming the campaign. |
| An empty list after parsing | Fail. An empty report would read as "nothing is affected". |
| The same tag id in both a delete and a combine group | Warn and treat it as a combine member. Deleting a tag that is also being merged is contradictory, and the operator should see that rather than have one silently win. |
| CSV with no `group` column at all | Every row is a deletion. A list of tags to delete is the common case and should not require an empty column. |

## 11. Testing

Pure and offline throughout:

- CSV and JSON parse to the same internal shape for equivalent input.
- A blank `group` is a delete; a shared `group` is a combine group.
- A malformed row warns and is skipped without failing the run.
- A trigger, a sequence step and a decision each produce the right `kind` from the right edge.
- A step location carries its sequence name and position, resolved from `viaCellId`.
- A campaign referencing two tags in one group is flagged in `duplicatedGroups`.
- A tag no campaign references lands in `noCampaignReferences` — and the word "safe" appears
  nowhere in the rendered Markdown.
- Derived `triggers` edges never contribute a location.
- **Against the real `se232` graph:** `tag:13269` yields 139 affected campaigns, matching the figure
  measured before this tool existed.

## 12. Success criteria

1. `npm run tag-impact -- --app se232 --tags <file>` writes both artifacts.
2. `tag:13269` reports **139 distinct campaigns**. The per-kind campaign counts overlap and do not
   partition that total: 1 references it as a trigger, 138 in decisions, 138 apply it, 138 remove
   it — mostly the same campaigns doing several of those at once.
3. Every step location names its sequence and position.
4. The Markdown never contains the word "safe"; unreferenced tags read as "no campaign references".
5. Campaigns with unanalysable decisions are named in `warnings`.
6. The full suite passes offline, including the 382 existing tests unchanged.
