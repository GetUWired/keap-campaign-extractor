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
| Type names in output | Derived from style AND references, never internal styles | One style can mean three things: `newsletterRequest` is a web form, landing page or internal form depending on what it carries. |
| Timers | Verbatim from `name` | Keap already writes the English. |
| Prose templates | Only where `name` is absent or useless | Four cases, not twelve. |

## 5. Type labels: what a node does, from style *and* references

Internal style names are legacy identifiers that do not match anything in the UI, and — crucially —
**one style can mean several different things.** `newsletterRequest` is the clearest case:

| `newsletterRequest` carries | count | actually is |
|---|---|---|
| `webformId` | 106 | a web form submission |
| `landingPageId` | 20 | a landing page submission |
| `internalFormId` | 7 | an internal form submission |
| nothing | 69 | unconfigured |

A flat style→label table cannot express that. So the label is a function of the **node**, not the
style:

```ts
export function typeLabel(node: NormalizedNode): string;
```

**Styles collapse into families first.** Keap has shipped several builders over the years and the
generation is an implementation detail no reader needs:

| Family | Styles | Label |
|---|---|---|
| Email | `email`, `bardEmail`, `unlayerEmail` | Email |
| Landing page | `landingPage`, `convrrtLandingPage` | Landing page submitted |
| Submission | `newsletterRequest`, `requestInfo` | resolved by reference — see above |

Verified: all three email styles reference `marketingEmailId` and nothing else; both landing-page
styles are landing pages.

Where a style resolves by reference and carries none, the label says so — "Form submitted
(unconfigured)" — rather than picking a default it cannot justify.

The family and label tables are **hardcoded, not computed at run time.** Deriving them from whichever
corpus is loaded would make output depend on the account being rendered. Any style in neither table
renders as its raw style name — visibly odd, which is the point: it asks to be added rather than
passing silently.

### One label set is unresolved, and deliberately left alone

`stageMove`, `makeCall`, `indicateInterest` and `fileDownload` all carry an optional `stageId`, but
most instances leave it unset — 7 of 82 for `indicateInterest`, 2 of 13 for `fileDownload`. They may
all be one goal type in the current UI, or four distinct ones that can each move a pipeline stage.

Until that is settled they keep separate labels drawn from Keap's own defaults. Calling all of them
"stage move" would misdescribe the majority that move no stage. This is one line per style in one
table, so correcting it later is trivial — and nothing else in the renderer depends on the wording.

## 5a. What a node does versus why it does it

Every campaign element has two components, and conflating them is how renderers become vague:

- **What** it does — form submitted, email sent, tag applied. Fully mechanical: style plus
  references, as above. Deterministic and testable.
- **Why** it does it — the operator's intent, which lives in the node's own name ("Request our Email
  Series") and takes further meaning from the campaign's name around it.

This renderer presents both **faithfully and verbatim**: the mechanism it derives, the operator's own
words it quotes. It never paraphrases intent.

*Inferring* why — reading a step name in the context of its campaign and synthesizing what the
automation is for — is the LLM narrative pass at the end of handoff stage 4, and is out of scope
(§3). The value of keeping that boundary sharp is that everything here stays testable, and the LLM
pass gets clean structured input rather than prose that already guessed.

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
export function typeLabel(node: NormalizedNode): string;
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
