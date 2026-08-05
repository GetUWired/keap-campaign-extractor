# Keap Campaign Extraction Spike — Design

Date: 2026-08-04
Status: approved, ready for implementation planning
Source of prior findings: `keap-campaign-extractor-handoff.md`

## 1. Context

The long-term goal is a system that extracts every campaign ("funnel") in a Keap Max
Classic account, normalises the structure, resolves cross-campaign relationships through
shared entities, and gives an AI agent precise tools over the result. Target scale for the
first real client is 398 campaigns.

The handoff document records a live reverse-engineering session that established the
mechanics: campaign structure lives in a `draftXml` property on a `<campaign-editor>`
Polymer element inlined in the editor page, sequences are scoped by `parent` within the
same flat XML, and decision-diamond routing is in the XML while decision *criteria* are
only in server-rendered HTML fetched separately.

Two things make a spike the right next step rather than starting at the normaliser:

1. **The fixture artifacts the handoff recommends building against do not exist.** Section 8
   references `keap-campaign-584-draft.xml`, `keap-campaign-584-structure.json`,
   `keap-campaign-584-sequences.json`, and `keap-campaign-987-decision-34.json`. The
   project directory contains only the handoff itself. Extraction is the only way to get
   real data to build the normaliser against.
2. **The decision-editor URL is unconfirmed** (handoff §14 Q1) and it is the one unknown
   blocking full automation of decision criteria.

This spike produces raw artifacts for one campaign and resolves the decision-editor URL.

## 2. Goal

Prove end to end that a Playwright-driven, strictly read-only extractor can:

- authenticate to Keap using a human-established session,
- load the Campaign Builder for a given `funnelId`,
- export `draftXml` and `publishXml` plus editor metadata,
- enumerate every decision cell from the XML,
- fetch and parse the layer-B criteria HTML for each decision cell,
- write raw and structured artifacts to disk,

while making writes structurally impossible.

## 3. Non-goals

Explicitly out of scope for this spike:

- Bulk extraction of all campaigns.
- The stage-2 normaliser (mxGraph XML → canonical campaign JSON).
- Keap REST API enrichment (tag names, email subjects, form names, products).
- Resolving the timer timezone discrepancy (handoff §4.2 / §14 Q2). Raw timer fields and
  the account timezone label are captured so it can be answered later without re-extracting.
- Mermaid/Graphviz rendering, LLM summarisation, the canonical store, the tool surface.
- Probing Keap's campaign sharing/import as an alternative ingestion path (handoff §14 Q3).
  Decision taken: commit to the `draftXml` scrape, which is already proven.

## 4. Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Authentication | Persisted session via `storageState.json` | Human logs in once by hand, handling MFA/SSO/captcha. No credentials in the codebase. Matches handoff §12: "Do not automate credential entry." |
| Spike scope | One campaign, fully walked | Proves both open unknowns and rebuilds the missing fixture set in a single pass. |
| Stack | Node + TypeScript | Playwright's native language; `page.evaluate` returns the `draftXml` string already unescaped. |
| Target tenant | `jordan.infusionsoft.com` | Own tenant, already characterised, known-good funnelIds 584 and 987. Zero risk to a client's live marketing system. |
| Read-only enforcement | Hard block at route level | Handoff §12 observed `PUT /app/authoring/<a>/<b>/template` writing an email template. Structural prevention, not care. |
| Decision-editor access | Direct URL guessing (`configureCell`) | Chosen over driving the UI. Stateless and never touches the canvas. Risk accepted: the URL shape is unconfirmed. |

### 4.1 Accepted risk on the decision-editor URL

Approach A (guess the URL) was chosen over driving the UI with a network recorder. The
handoff observed the `configureCell` pattern for a `timerDelay` cell but never captured the
decision variant, so the parameter shape is inferred.

Mitigation: the extractor tries an ordered list of candidate URLs, validates each response
by content rather than status code, and on total failure writes every response body to disk
alongside a report of what each candidate returned. Iterating on the guess is then
evidence-driven. If all candidates fail, the documented fallback is a one-off manual run
with Playwright's request log capturing a real decision-editor open — but that is a
follow-up task, not part of this spike.

## 5. Architecture

```
keap-campaign-extractor/
  package.json
  tsconfig.json
  .gitignore
  keap-campaign-extractor-handoff.md
  docs/superpowers/specs/
  src/
    auth/
      login.ts            CLI: headed browser, human login, writes storageState.json
      session.ts          loads storageState, builds a guarded BrowserContext
    guard/
      readonly.ts         route interception + safeGet wrapper + blocked-request log
    extract/
      campaign.ts         funnelEditor page -> CampaignRaw
      decision.ts         decision cell -> candidate URLs -> DecisionFetchResult
    parse/
      cells.ts            draftXml -> CellInventory            (pure, no Playwright)
      decisionHtml.ts     layer-B HTML -> DecisionCriteria     (pure, no Playwright)
    cli/
      spike.ts            orchestrator
  test/
    fixtures/             copied from artifacts/, committed
    cells.test.ts
    decisionHtml.test.ts
  artifacts/              gitignored, runtime output
  storageState.json       gitignored, chmod 600
```

The two `parse/` modules import nothing from Playwright. They are pure
`string -> object` functions and hold all the logic worth testing. Everything in
`extract/` and `auth/` is thin I/O.

## 6. Module contracts

### 6.1 `guard/readonly.ts`

```ts
// Applied to the URL path only, and only to /app/ paths. Static assets under
// /resources/ are exempt: the editor loads paths containing "template" as SVG
// and PNG assets, and aborting those would break rendering without preventing
// any write. Non-GET methods are blocked unconditionally regardless of path.
export const WRITE_URL_PATTERN = /(save|publish|delete|template|hotSwap)/i;
export const GUARDED_PATH_PREFIX = '/app/';

export type BlockReason = 'non-get' | 'denylist';

export interface BlockedRequest {
  method: string;
  url: string;
  reason: BlockReason;
  at: string;              // ISO timestamp
}

export interface Guard {
  blocked: BlockedRequest[];
  allowed: { method: string; url: string; at: string }[];
}

export function installReadOnlyGuard(context: BrowserContext): Guard;
export function safeGet(context: BrowserContext, url: string): Promise<APIResponse>;
```

Two halves because they cover different traffic:

- `installReadOnlyGuard` registers `context.route('**/*', ...)`. A request is aborted if its
  method is not GET (unconditional), or if it is a GET whose path starts with
  `GUARDED_PATH_PREFIX` and matches `WRITE_URL_PATTERN`. Everything else is recorded and
  continued. Both outcomes are logged.
- `safeGet` exists because Playwright's `APIRequestContext` does **not** participate in
  route handling, so direct HTTP calls would otherwise bypass the interception entirely.
  It asserts the URL against `WRITE_URL_PATTERN` before issuing the call and exposes no
  verb other than GET.

Expected side effect: FullStory beacons (POST) will be aborted. Editor boot was observed to
be GET-only, so this should not break page load. If it does, the blocked-request log
identifies the exact call.

### 6.2 `parse/cells.ts`

```ts
export interface DecisionBranch { decisionId: string; flowId: string }

export interface DecisionCell {
  cellId: string;
  name: string | null;       // ~br~ tokens replaced with a space
  branches: DecisionBranch[];
}

export interface CellInventory {
  cellCount: number;
  decisions: DecisionCell[];
  styleCounts: Record<string, number>;
  warnings: string[];
}

export function parseCells(draftXml: string): CellInventory;
```

Parses with `fast-xml-parser` (attributes preserved), never regex. Collects
`style="decision"` cells with their `<Array as="decisions">` routing pairs, and tallies
every `style` seen so unknown node types surface as data rather than crashes. Foreign-key
ids have their trailing Java-Long `L` stripped (handoff §4.3).

### 6.3 `parse/decisionHtml.ts`

```ts
export interface RuleValue { id: string; label: string | null }

export interface Rule {
  ruleId: string;
  subject: string | null;         // raw enum, e.g. "contact_Subject"
  subjectLabel: string | null;    // display text, e.g. "Contact's"
  category: string | null;
  categoryLabel: string | null;
  field: string | null;
  fieldLabel: string | null;
  constraint: string | null;
  constraintLabel: string | null;
  values: RuleValue[];
}

export interface RuleGroup { groupId: string; all: Rule[] }   // AND group

export interface DecisionWrapper {
  index: number;
  decisionId: string | null;
  flowId: string | null;
  any: RuleGroup[];                                            // OR of AND-groups
}

export interface ElseOption {
  decisionId: string;
  flowId: string | null;
  label: string;
  selected: boolean;
}

export interface DecisionCriteria {
  decisionIds: string[];
  flowIds: string[];
  wrappers: DecisionWrapper[];
  elseOptions: ElseOption[];
  elseSelected: ElseOption | null;
  warnings: string[];
}

export function parseDecisionHtml(html: string): DecisionCriteria;
```

Parses with `cheerio`. Reads `#decisionIds` and `#flowIds`, then aligns them ordinally with
`section.decisionWrapper` elements as established in handoff §5.2. Within each wrapper:
`div.ruleGroupOuter_<n>` is an OR group, `div.ruleGroupInner_<n>` an AND group,
`table.ruleContainer_<ruleId>` wraps `div.rule_<ruleId>`. Per rule it reads
`subject_<id>`, `category_<id>`, `field_<id>`, `constraint_<id>`, and every
`value_<id>_<valueId>` hidden input paired with its `_text` companion — the only place tag
and custom-field display names appear. Finally `select#elseRulesOptions` yields the fallback
branch, where option values are `decisionId` and option labels are `flowId`.

Any ordinal misalignment between `#decisionIds`/`#flowIds` and the wrapper count is recorded
in `warnings` rather than throwing, since the alignment rule was observed on a single sample.

### 6.4 `extract/campaign.ts`

```ts
export interface CampaignRaw {
  funnelId: string;
  draftXml: string;
  publishXml: string;
  funnelName: string | null;
  maxCellId: string | null;
  timezoneId: string | null;
  timezoneLabel: string | null;
  appBuild: string | null;
  extractedAt: string;
  draftXmlSha256: string;
}

export function extractCampaign(page: Page, funnelId: string): Promise<CampaignRaw>;
```

Navigates to `/app/funnel/funnelEditor?funnelId=<id>`, waits for
`document.querySelector('campaign-editor')?.draftXml` to be non-empty, then reads the
properties plus the `#editor` data attributes (`data-funnelname`, `data-maxcellid`,
`data-newtimezoneid`, `data-timezonelabel`).

Reads DOM properties only, never inline script text. This sidesteps both the JS
string-escaping footgun and handoff §7 gotcha 4 — session tokens sit near the campaign data
in those scripts and must never be echoed.

### 6.5 `extract/decision.ts`

```ts
export interface DecisionFetchAttempt {
  url: string;
  status: number;
  bytes: number;
  hit: boolean;
  bodyPath: string | null;   // set when saved for inspection
}

export interface DecisionFetchResult {
  cellId: string;
  attempts: DecisionFetchAttempt[];
  html: string | null;
  criteria: DecisionCriteria | null;
}

export function fetchDecision(
  context: BrowserContext,
  funnelId: string,
  cell: DecisionCell,
): Promise<DecisionFetchResult>;
```

Candidate URLs, tried in order against `/app/funnel/configureCell`:

1. `?cellId=<id>&metaType=decision&title=<name>&timestamp=<ms>&_=<ms>`
2. `?cellId=<id>&metaType=decision&timestamp=<ms>&_=<ms>`
3. `?cellId=<id>&metaType=decision&includePage=true&timestamp=<ms>&_=<ms>`

A response is a hit only if the body contains `decisionComponents` or `decisionIds`. Status
code alone is not trusted, since the app may return 200 with an error shell. First hit wins.
If every candidate misses, all three bodies are written to
`artifacts/<funnelId>/decisions/<cellId>.attempt-<n>.html` and the result carries
`html: null` so the orchestrator can report precisely what came back.

### 6.6 `cli/spike.ts`

Orchestrates: load session → install guard → extract campaign → parse cells → fetch and
parse each decision → write artifacts → print a summary. Exit code 1 if the campaign
extraction fails or if any decision cell produced no hit.

## 7. Artifact layout

```
artifacts/<funnelId>/
  draft.xml
  publish.xml                  empty file when never published
  meta.json                    CampaignRaw minus the two XML strings, plus cell inventory
  decisions/<cellId>.html      raw layer-B HTML, on hit
  decisions/<cellId>.json      parsed DecisionCriteria, on hit
  decisions/<cellId>.attempt-<n>.html   on total miss
  requests.log.json            full allowed/blocked request log for the run
```

Everything under `artifacts/` is gitignored. Once the spike succeeds, the 584 and 987
outputs are copied into `test/fixtures/` and committed as golden files — restoring the
fixture set the handoff assumed existed.

## 8. Error handling

| Condition | Behaviour |
|---|---|
| `storageState.json` missing | Exit with instruction to run `npm run login`. |
| Session expired | Detected by landing on a login URL. Exit telling the user to re-run login. Never write empty artifacts. |
| `campaign-editor` never gets `draftXml` | Timeout after 30s, log final URL and page title. |
| `publishXml === ''` | Normal — means never published. Written as an empty file, recorded in `meta.json`. |
| Unknown `mxCell` style | Counted in `styleCounts`, appended to `warnings`. Never throws. The handoff expects ~25 types against 10 observed, so unknowns are the normal case. |
| All decision URL candidates miss | Bodies saved, per-candidate report printed, non-zero exit. |
| Ordinal misalignment in decision HTML | Recorded in `warnings`, partial result still returned. |

## 9. Testing

`parse/cells.ts` and `parse/decisionHtml.ts` are pure functions and get golden-file tests
under `test/`, run with `vitest`, entirely offline and with no Playwright import. The
fixtures are the artifacts this spike produces.

The Playwright layers are not unit tested. Their correctness is demonstrated by the spike
run itself and guarded by the assertions in §11.

This ordering is deliberate: the spike exists partly to manufacture the test fixtures, so
the tests are written immediately after the first successful run, not before it.

## 10. Security and safety

- `storageState.json` holds live session cookies and is functionally a credential.
  Gitignored, `chmod 600`, never logged, never copied into `artifacts/`.
- No credentials in code or environment.
- Route-level guard plus `safeGet` make non-GET traffic structurally impossible.
- Raw inline script text is never read or emitted.
- No contact data is touched. Campaign structure contains zero PII and this must stay
  deliberate — the extractor has no reason to request contact records.
- These `/app/` endpoints are not a documented interface. Before pointing this at a client
  tenant, check that client's terms of service, and prefer the official REST API for
  anything it can answer.

## 11. Success criteria

The spike is done when all of these hold:

1. `npm run login` produces a `storageState.json` that a subsequent run reuses without
   re-prompting.
2. `npm run spike -- --funnel 584` writes a non-empty `artifacts/584/draft.xml` that parses
   as valid `mxGraphModel` XML. The run reports its character count and `mxCell` count
   alongside the handoff's recorded baseline (11,185 chars / 43 cells) as an informational
   delta. A divergence is **not** a failure — campaigns change between sessions — but it must
   be printed rather than silently accepted. The run fails only if `draftXml` is absent,
   empty, or unparseable.
3. `parseCells` finds decision cell `13` in campaign 584.
4. `npm run spike -- --funnel 987` yields decision cell `34` with branches
   `479 -> 3` and `481 -> 32`.
5. For campaign 987 cell 34, either a candidate URL returns parseable decision HTML whose
   rules match the handoff §5.6 worked example, or the failure report lists all three
   candidate responses with status and body size.
6. `requests.log.json` shows zero non-GET requests reaching the network.
7. `vitest` passes offline against the committed fixtures.

Criterion 5 is the one that can legitimately fail, since the URL shape is a guess. A clean
failure with three documented responses is an acceptable spike outcome — it converts the
unknown into a bounded, evidence-backed next step.

## 12. What this spike feeds

On success: the fixture set for the stage-2 normaliser, a confirmed decision-editor URL, and
a proven read-only session harness that the bulk 398-campaign run can reuse unchanged.
