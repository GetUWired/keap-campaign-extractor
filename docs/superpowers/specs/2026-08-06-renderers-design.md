# Renderers — Design

Date: 2026-08-06
Status: approved, ready for implementation planning
Builds on: `2026-08-06-normaliser-design.md`, `2026-08-06-enrichment-design.md`
Evidence: `docs/spike-findings.md` §12–14, and the corpus in `artifacts/jordan/`

## 1. Context

170 campaigns are normalized, graphed and partly named. Reading any of them still means opening JSON.

The account-level findings are already sharp — 155 broken references, 10 unreachable campaigns, 720
unconfigured nodes — but they are counts. A picture of campaign 987 showed in one glance that it
routes people into two empty sequences, a fact that had been sitting in the data as two rows of
"365 empty sequences" and that nobody had noticed.

Renderers add no information. They make existing information impossible to miss.

## 2. Goal

One Markdown page per campaign, containing a diagram, its structure in English, and what it connects
to — generated from files already on disk.

## 3. Non-goals

- **The LLM narrative pass.** Handoff stage 4 ends with a model summarizing the normalized JSON.
  That is different work with different failure modes and belongs on its own.
- HTML output. Markdown first; presentation can be layered later.
- Per-sequence diagrams. Steps are linear by construction, so an ordered list beats a flowchart of a
  straight line.
- **Timer arithmetic** — see §6. It turns out not to be needed at all.
- Live/dead classification.

## 4. Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Output | Markdown, one file per campaign | Renders in GitHub, VS Code, Notion, Obsidian; diffable and greppable; mirrors how `normalized/` already works. |
| Diagram scope | Campaign level only — goals, decisions, sequences | Median campaign is 14 nodes and 4 top-level edges. Steps are what make the 14 largest campaigns unreadable, and they belong in lists. |
| Primary label | The node's own `name` | Populated on **83%** of goals and steps, and it is what the operator sees in the builder. |
| Type names in output | Empirical default labels, never internal styles | `newsletterRequest` and `indicateInterest` are legacy identifiers nobody recognizes. |
| Timers | Verbatim from `name` | Keap already writes the English. |
| Prose templates | Only where `name` is absent or useless | Four cases, not twelve. |

## 5. Type labels: never show an internal style

Internal style names are legacy identifiers that do not match anything in the UI. Each style has a
default name Keap writes into the box, recoverable from the corpus by taking the most common `name`
per style:

| Internal style | Renders as | Evidence |
|---|---|---|
| `http` | **Send HTTP Post** | default name on 26 of 60 nodes |
| `newsletterRequest` | **Web form submitted** | 205 nodes; carries `webformId`, `landingPageId`, `internalFormId` |
| `indicateInterest` | **Opportunity stage moved** | 82 nodes; carries `stageId`; names are pipeline stages — "New Lead", "Contacted", "Negotiating", "Closed" |
| `requestInfo` | **Request information** | default name; carries `stageId`, `webformId`, `internalFormId` |
| `purchaseSuccess` | **Purchase made** | default name "Purchase online" on 8 nodes |

The table is **hardcoded, not computed at run time.** Deriving it from whichever corpus is loaded
would make output depend on the account being rendered; a reviewed table is deterministic. Any style
absent from the table renders as its raw style name — visibly odd, which is the point: it asks to be
added rather than passing silently.

**These labels are inferred, and two of them are inferences rather than observations.** `http`,
`requestInfo` and `purchaseSuccess` come straight from Keap's own default names. But "Web form
submitted" and "Opportunity stage moved" are *my* readings of what those goals do, drawn from the
foreign keys they carry and the names operators gave them — Keap's own defaults are the unhelpful
"Sign up for newsletter" and "Indicate interest". The `stageId` reading is corroborated (an
opportunity moving stage in a pipeline) but the phrasing is not verified against the current UI.

Anyone who knows the builder should correct this table on sight. It lives in one place for exactly
that reason, and nothing else in the renderer depends on the wording.

## 6. Timers need no arithmetic

Keap writes the human-readable description into `name`:

```
"Wait at least 3 days and then run on a weekday at 8:00 AM"
"Run on 11-12-2018 at 8:00 AM"
```

So timers render verbatim, and **handoff §14 Q2's unresolved timezone discrepancy does not block
this work**: displaying Keap's own string shows exactly what the UI shows. Computing our own from
the raw hour fields would risk contradicting the builder over an ambiguity nobody has settled.

Q2 stays open for anything that needs to *reason* about timing. Display does not.

## 7. `src/render/prose.ts`

```ts
export interface ProseContext {
  /** entity id → display name, from the catalog. Absent means ids only. */
  names: Map<string, string>;
}

export function describeNode(node: NormalizedNode, context: ProseContext): string;
export function typeLabel(style: string): string;
```

Prose leads with the node's `name`. Templates exist only for the cases where that fails:

| Case | Why | Renders as |
|---|---|---|
| `tag` | **0 of 241 carry a name** | `Applies tag "Bought"` / `Removes tag "Bought"` |
| `notes`, `note` | body lives in `config.notes`, not `name` | the decoded note body — see below |
| `email`, `bardEmail` | 98 are literally "Untitled Email" | catalog email name, falling back to the node name |
| `decision` | routing is not a name | `Routes to "Approved" or "Declined"` |

**Notes need decoding, not just copying.** 163 of 198 carry `config.notes`, and the bodies contain
HTML entities and inline tags:

```
"For the purposes of this sequence, I&#39;ve set the event date as <b>November 14th, 2012</b>."
```

Emitted raw into Markdown that renders as literal `&#39;`. Entities are decoded (`&#39;`, `&quot;`,
`&amp;`, `&lt;`, `&gt;`, numeric forms) and inline tags stripped, leaving plain text. The handoff
calls notes the highest-signal text in the corpus, so a visible mangling here would undercut the
whole output.

**`email` and `bardEmail` share one template.** They are the same thing to a reader.

Everything else renders as `<name> — <type label>`, with any resolved reference appended. That is
faithful and needs no per-style work.

## 8. `src/render/mermaid.ts`

```ts
export function renderMermaid(campaign: NormalizedCampaign, context: ProseContext): string;
export function escapeLabel(text: string): string;
```

Goals as stadiums, decisions as rhombuses, sequences as rectangles; edges from `scope === '1'`.
Decision branches carry their target sequence's name.

**Escaping is the real risk here, and it is the same class of bug as `stripLongSuffix`.** Corpus
names contain `->`, quotes, `#`, brackets and parentheses — `ListCleaner.io Tags -> Good Contact
Info` is a real tag name. Unescaped, Mermaid renders the wrong diagram or nothing at all, with no
error. Every label is quoted and escaped, and the tests use the nastiest names actually present in
the corpus rather than invented ones.

## 9. `src/render/campaignDoc.ts`

```ts
export function renderCampaign(
  campaign: NormalizedCampaign,
  graph: AccountGraph,
  catalog?: EntityCatalog,
): string;
```

```
# WooConnection Beta Tester Application  (987)
Published · no unpublished changes · 4 sequences · 10 steps

> ⚠ 2 empty sequences · 1 unconfigured node

## Flow           ← the Mermaid block
## Goals          ← one line each
## Sequences      ← per sequence: ready/published, then ordered steps
## Connections    ← tags applied/removed/listened-for, emails sent, campaigns triggered
## Warnings       ← unverified order, broken references, unconfigured nodes
```

`Connections` reads `graph.json`, so each page shows what the campaign triggers **and what triggers
it** — the cross-campaign view that currently exists only at account level.

## 10. `src/cli/render.ts`

```bash
npm run render -- --app jordan [--funnel <id>]
```

Writes `artifacts/<app>/rendered/<funnelId>.md` and `rendered/index.md`, a table of every campaign
with status, size, findings counts and a link. No network. Re-runs in seconds.

## 11. Error handling

| Condition | Behaviour |
|---|---|
| No `normalized/` | Fail, naming `npm run normalize -- --app <app>`. |
| No `graph.json` | Fail — `Connections` is half the value. |
| No `entities.json` | Render with ids instead of names, stated **once** at the top of each page, never per line. |
| Sequence order unverified | Rendered in document order with an explicit note. Never silently. |
| Empty sequence | Rendered and labelled empty. It is a finding, not an omission. |
| Style absent from the label table | Raw style name, no warning — 41 styles legitimately hit this. |
| One campaign fails to render | Warn and skip; the other 169 still render. |
| Zero campaigns rendered | Fail. |

## 12. Testing

- **Escaping**, against the ugliest real names in the corpus: `->`, quotes, `#`, brackets.
- Campaign 987 renders 3 goals, 4 sequences and a decision with two branches.
- Campaign 584's "Satisfied" sequence appears in the handoff's documented order — `14, 81, 25, 27, 17`.
- An empty sequence is labelled as empty.
- A tag step with no name renders `Applies tag "…"` from its reference.
- `email` and `bardEmail` produce identical phrasing.
- No output anywhere contains the strings `newsletterRequest` or `indicateInterest`.
- A campaign with an unverified sequence order carries the note.
- **All 170 render without throwing.**

## 13. Success criteria

1. `npm run render -- --app jordan` writes 170 pages and an index.
2. Campaign 987's page shows both empty sequences as empty.
3. No page contains an internal style name for any style in the label table.
4. Every Mermaid block parses — verified by escaping tests over real corpus names.
5. Rendering without `entities.json` produces pages with ids and one stated caveat per page.
6. The full suite passes offline, including the 283 existing tests unchanged.
