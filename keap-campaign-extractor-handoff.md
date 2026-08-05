# Keap Campaign Extraction & Understanding — Engineering Handoff

Prepared from a live reverse-engineering session against a Keap Max Classic tenant.
Everything below was observed directly in the running app, not inferred from documentation.

## 0. Goal

Build a tool that extracts the complete structure of every campaign in a Keap account,
normalises it, resolves cross-campaign relationships, and produces a map plus a
human-readable explanation of what each campaign does and how they work together.

Target scale for the first real client: **398 campaigns**.

## 1. Environment observed

| Item | Value |
|---|---|
| Tenant | https://jordan.infusionsoft.com |
| Product | Keap Max Classic (element prop `isMaxClassic: true`, `isMaxApp: false`) |
| App build | `1.70.0.989251-sysarch-202608031100` |
| Campaign editor URL | `/app/funnel/funnelEditor?funnelId=<ID>` |
| Editor stack | Polymer 1.x custom element `<campaign-editor>` wrapping **mxGraph** (globals `mxClient`, `mxConstants`) |
| Account timezone | `America/Phoenix` (from `div#editor[data-newtimezoneid]`, `data-timezonelabel="(GMT -07:00) Phoenix"`) |

Campaigns are called **funnels** internally. Sequences are called **flows**.

## 2. The core discovery: where the structure lives

**The campaign structure is not fetched over the network.** It is inlined in the
page HTML of the campaign editor.

On a full load of the editor, 59 requests fired: 56 static assets (SVG/PNG/fonts under
`/resources/funnel/images/...`), 2 FullStory beacons, and exactly one data call —
`GET /app/timerFunnel/getDateTimeFieldMap?mediaType=json` (a timer field lookup, not campaign data).

Instead, a ~15 KB inline `<script>` assigns properties onto the `<campaign-editor>` element:

| Property | Meaning |
|---|---|
| `draftXml` | **The complete campaign model** as mxGraph XML. Authoritative. |
| `publishXml` | Published version of the same. Empty string = never published. |
| `initialGraphView` | `'default'` |
| `initialFlowId` | Deep-link into a specific sequence |
| `navigateToNode` | Deep-link to a specific node |
| `initialStartDate` / `initialEndDate` | Reporting date range |
| `funnelStats`, `pluginSettings` (57 keys), `validPresets`, `_publishedGraphs` | Reporting / feature flags |

**Canonical retrieval (single line):**

```js
document.querySelector('campaign-editor').draftXml
```

Observed sizes: funnelId 584 → 11,185 chars / 43 `mxCell`; funnelId 987 → 7,252 chars / 32 `mxCell`.

Other requests seen during editor boot (context, not data sources):
`GET /app/session/keepAlive`, `GET /app/funnel/campaignPluginSettings`,
`GET /app/funnel/editor?funnelId=<ID>` (XHR returning the editor shell HTML).


## 3. draftXml schema (mxGraph)

```
mxGraphModel
  └── root
        ├── mxCell id="0"                        (graph root)
        ├── mxCell id="1" parent="0"             (default layer)
        └── mxCell ...                           (every goal, sequence, step and edge)
```

### 3.1 mxCell attributes

| Attribute | Notes |
|---|---|
| `id` | Cell id, unique within the campaign. Integer-as-string. |
| `parent` | `"1"` = campaign top level. A flow cell id = **step inside that sequence**. |
| `style` | The node type. See taxonomy below. |
| `metaType` | Secondary classifier on goals, e.g. `webform`, `purchase`. |
| `vertex` | `"1"` for nodes. |
| `edge` | `"1"` for connectors. |
| `source` / `target` | Cell ids, edges only. |
| `collapsed` | UI state. |

### 3.2 Children of a vertex

Every vertex has, in order:

1. `<Object as="value" ...>` — the **config payload**, all settings as attributes.
2. `<mxGeometry as="geometry" x y width height/>` — canvas position.

### 3.3 Nesting: how sequences contain steps

There is **no separate sequence document**. Sequence contents live in the same flat
`<root>` list and are scoped by `parent`:

- `style="flow"` cells are sequence containers.
- Any cell whose `parent` equals a flow cell id is a **step inside that sequence**.
- Edges are also in the flat list, scoped by their own `parent`.
- Step order = walk `source`/`target` from the sequence's `start` cell.

**Drilling into a sequence in the UI issues zero data requests** — it is purely a
client-side mxGraph view change. Verified: only sequence-level SVG icons loaded.

### 3.4 Node type taxonomy (`style`) — 10 observed

| style | metaType | Kind | Notes |
|---|---|---|---|
| `newsletterRequest` | `webform` | Goal | Web form submitted. Carries `webformId`. |
| `purchaseSuccess` | `purchase` | Goal | Product purchased. Carries `purchaseId`. |
| `decision` | — | Router | Decision diamond. See section 5. |
| `flow` | — | Container | A sequence. Carries `flowType`. |
| `start` | — | Step | Sequence entry point. |
| `timerDelay` | — | Step | Wait/scheduling rules. |
| `email` | — | Step | Legacy email. Carries `marketingEmailId`. |
| `bardEmail` | — | Step | Newer ("beta") email builder. Carries `marketingEmailId`. |
| `task` | — | Step | Creates a task. |
| `notes` | — | Annotation | Free text on the canvas. **High-signal documentation — mine it.** |

The on-screen palettes offer roughly **25** goal/step types (Tag applied, Landing Page,
Email Link clicked, Failed Purchase, Quote status, Internal Form submitted, Task completed,
Opportunity Stage moved, Note applied, Lead Score achieved, API, WordPress Opt-In,
Apply/Remove Tags, Apply Note, Create Appointment, Set Field Value, Assign an Owner,
Create Opportunity, Fulfillment List, Create Order, Cancel Subscription, Send HTTP Post,
Send HTTP Request, Add to Sequence, Move Opportunity, Action Set, Letter, Date Timer,
Field Timer, ...). **Build a style registry with a loud fallback for unknown types and log them.**


## 4. `<Object>` config payload reference

Union of all attributes observed across both campaigns:

`buildNumber, funnelId, initialized, appName, as, deepCopy, global, name, published,
ready, broken, webformId, flowType, runOnType, startAmPm, startHour, startMinute,
stopAmPm, stopHour, stopMinute, timeOfDayType, waitDelay, waitDelayType,
marketingEmailId, taskAssignToBackup, taskAssignToOwner, taskBody, taskDaysTillDue,
taskDueAt, taskNotifyOwner, taskPriority, taskReminder, taskTitle, taskType,
decisionId, flowId, notes, eventId, purchaseId`

### 4.1 Common flags (most types)

| Attribute | Meaning |
|---|---|
| `name` | Display label. **Contains `~br~` as a line-break token — replace with a space.** |
| `ready` | `"1"` configured, `"0"` = UI shows "Setup required". |
| `published` | `"1"` live, `"0"` draft-only. |
| `initialized` | Whether the node has ever been configured. |
| `broken` | Node references something missing/invalid. |
| `deepCopy`, `global`, `as` | Internal serialisation flags — ignore. |

### 4.2 Real examples (verbatim)

`timerDelay` cell 81:
```
waitDelay=30  waitDelayType=Minute  runOnType=Weekday  timeOfDayType=Between
startHour=5  startMinute=0  startAmPm=AM   stopHour=2  stopMinute=0  stopAmPm=PM
name="Wait at least 30 minutes and then run on a weekday between 8:00 AM - 5:00 PM"
```

> **WARNING / OPEN QUESTION:** the raw fields say 5:00 AM–2:00 PM but the rendered label
> says 8:00 AM–5:00 PM — a consistent **+3 hour** offset. The stored hours are evidently in
> a different timezone from the display (account tz is America/Phoenix, GMT-7).
> **Do not assume the raw hour fields are display hours.** Verify the offset rule against
> several campaigns and several account timezones before generating prose from them.
> Safest interim approach: use the pre-rendered `name` for display and treat the numeric
> fields as machine values pending confirmation.

`task` cell 19:
```
taskTitle=<65 chars>  taskBody=<271 chars>  taskType=Call  taskPriority=2
taskDueAt=17:00  taskDaysTillDue=0  taskAssignToOwner=1  taskAssignToBackup=0L
taskNotifyOwner=0  taskReminder=0  ready=0
```

`email` cell 25 / `bardEmail` cell 93:
```
marketingEmailId=2048L   name="Thank You +~br~Testimonial Request"   ready=1
marketingEmailId=2054L   name="Untitled Email (beta)"
```

`flow` cell 3: `flowType=Stop  name="Satisfied"  ready=1  published=0`

### 4.3 Id format gotcha

Foreign keys are serialised as Java Longs with a trailing `L`: `2048L`, `1123L`, `479L`, `0L`.
**Strip the trailing `L` before joining to API data.**

### 4.4 What is NOT in the XML

Emails store only `marketingEmailId` — no subject, no body. Likewise `webformId`,
`purchaseId`, `eventId`, `decisionId` and tag ids are bare numbers. All human-readable
names for these must be resolved from the Keap REST API (or, for tags/custom fields,
from the decision editor HTML — see 5.3).


## 5. Decision nodes — a TWO-LAYER problem (most important finding)

The decision diamond's **rule logic is not in draftXml**. The XML holds only the routing table.

### 5.1 Layer A — routing (in draftXml)

```xml
<mxCell id="34" style="decision" parent="1" vertex="1">
  <Object initialized="1" ready="1" published="1" as="value">
    <Array as="decisions">
      <Object decisionId="479L" flowId="3"/>
      <Object decisionId="481L" flowId="32"/>
    </Array>
  </Object>
  <mxGeometry as="geometry" x="160" y="80" width="32" height="32"/>
</mxCell>
```

That is the entirety of what the XML knows: which `decisionId` routes to which sequence.

### 5.2 Layer B — criteria (server-rendered HTML, keyed by decisionId)

Opening the Decision Diamond editor swaps legacy form HTML into the funnel editor shell.
Container chain:

```
div#pagecontent
  div#editor[data-funnelname][data-maxcellid][data-newtimezoneid][data-timezonelabel]
    div#hotSwappableEditor_2
      div#wrapper_decisionComponents.whole-page-editor-wrapper
        div#decisionComponents
          section.decisionWrapper            <-- ONE PER TARGET SEQUENCE
            div.ruleGroupOuter_<n>           <-- OR group
              div.ruleGroupInner_<n>         <-- AND group
                table.ruleContainer_<ruleId>
                  div.rule_<ruleId>          <-- one condition
```

Two hidden inputs make the pairing explicit and **ordinally align with the sections**:

```
#decisionIds  ->  [479, 481]
#flowIds      ->  [3, 32]
```

So `section.decisionWrapper[0]` = decision 479 = flow 3, and so on.

### 5.3 Field contract per condition

For each `div.rule_<ruleId>`:

| Field name | Type | Example value | Example label |
|---|---|---|---|
| `subject_<ruleId>` | select | `contact_Subject` | Contact's |
| `category_<ruleId>` | select | `tags_FieldCategory` | Tags |
| `field_<ruleId>` | input/select | (empty for tags) | |
| `constraint_<ruleId>` | select | `notContains_Constraint` | doesn't contain |
| `value_<ruleId>_<valueId>` | hidden | `1123L` | (the entity id) |
| `value_<ruleId>_<valueId>_text` | text | | `WooConnection Beta -> WooCommerce Beta Tester - Applied` |

A rule may have multiple `value_*` pairs (multi-select). The `_text` companion is the
**only place tag / custom-field display names appear** — worth harvesting.

### 5.4 Fallback branch

`select#elseRulesOptions` — "If contacts don't meet any of the rules defined above, where
do you want them to go?" Option values are `decisionId`, option labels are `flowId`:

```
0   -> "Don't put them in a sequence"   (observed selected)
481 -> 32
479 -> 3
```

### 5.5 Enum vocabularies

```
subject:     _blank, contact_Subject
constraint:  _blank, contains_Constraint, notContains_Constraint,
             isEmpty_Constraint, notEmpty_Constraint
category:    _blank, tags_FieldCategory, contact.contactFields_FieldCategory,
             customFieldGroup<N>_FieldCategory   <-- ACCOUNT-SPECIFIC, treat as data
```

Observed `customFieldGroup` labels on this account: 29=Info, 1=Header, 7=Question 3,
31=Custom Fields, 10=Referral Source, 16=Employer.

### 5.6 Worked example (funnelId 987, cell 34)

```
IF contact's tags DOESN'T CONTAIN  tag 1123L ("WooConnection Beta -> WooCommerce Beta Tester - Applied")
   -> sequence 3  "Tag and Send Application Confirmation"
IF contact's tags CONTAINS         tag 1123L
   -> sequence 32 "Already Applied"
ELSE -> do not enrol
```

Client-side script for this editor: `/resources/funnel/decision/decision.js`.


## 6. Endpoints observed

| Method | URL | Purpose | Safe? |
|---|---|---|---|
| GET | `/app/funnel/funnelEditor?funnelId=<ID>` | **Primary source.** Editor page with inline draftXml/publishXml. | read |
| GET | `/app/funnel/editor?funnelId=<ID>` | XHR returning editor shell HTML. | read |
| GET | `/app/funnel/configureCell?cellId=<ID>&metaType=<style>&title=<label>&includePage=...&timestamp=<ms>&_=<ms>` | Server-rendered config form for one cell. Observed for `timerDelay` cell 81. | read |
| GET | `/app/funnel/campaignPluginSettings` | Feature flags. | read |
| GET | `/app/timerFunnel/getDateTimeFieldMap?mediaType=json` | Timer field lookup. | read |
| GET | `/app/session/keepAlive` | Session refresh. | read |
| GET | `/app/funnel/emailMenu`, `/app/funnel/authoringTestMenu` | UI menus. | read |
| POST | `/app/emailFunnel/hotSwapDetails?parentId=<emailId>` | Email editor bootstrap. | avoid |
| POST | `/app/emailFunnel/hotSwapEditor?contentType=email&parentId=<emailId>` | Email editor. | avoid |
| POST | `/app/authoring/hotSwapSideBar`, `/app/contentChecker/showSpamScore` | Email editor internals. | avoid |
| **PUT** | `/app/authoring/<a>/<b>/template` | **WRITES an email template.** | **NEVER** |

**The exact URL that serves the decision editor was not captured** (the network log had
rolled over). It is almost certainly the `configureCell` pattern with
`metaType=decision&cellId=<decisionCellId>`, but **verify this first** — it is the one
unknown blocking full automation of layer B.

## 7. Gotchas discovered the hard way

1. `~br~` in `name` attributes is a line-break token. Strip it.
2. Trailing `L` on all foreign-key ids. Strip before joining.
3. `document.scripts[n]` indexes **all** scripts; an inline-only filtered array has
   different indices. Use `[...document.scripts].filter(s => !s.src)`.
4. Dumping raw inline script text can trip data-protection filters (session tokens are
   embedded nearby). **Parse with DOMParser and emit derived data — never echo raw script text.**
5. `publishXml === ''` means never published. Diffing draft vs publish gives you an
   "unpublished changes" report for free.
6. Orphan detection is free: any vertex with no inbound and no outbound edge.
   Real example — cell 99, a `newsletterRequest` goal named "test", wired to nothing.
7. The mxGraph instance is **not** exposed on any DOM element property. Do not try to reach
   into the live graph object; read `draftXml` instead.
8. Timer hour fields appear timezone-shifted vs the label (see 4.2).
9. Network logs roll over; if you need to observe traffic, clear first, then act.

## 8. Reference data: funnelId 584 ("[MP-76] Satisfaction Survey")

Top level (`parent="1"`): `2 newsletterRequest` (Satisfaction Survey),
`3/4/5/87 flow`, `13 decision`, `78 notes`, `86 purchaseSuccess` (Made A Purchase),
`99 newsletterRequest` ("test", orphan).

Sequences and their steps:

| Flow | Name | Steps (in order) |
|---|---|---|
| 3 | Satisfied | 14 start, 81 timerDelay, 25 email, 27 timerDelay, 17 email |
| 4 | Neutral | 15 start, 35 timerDelay, 7 email |
| 5 | Not Satisfied | 16 start, 19 task |
| 87 | Untitled Sequence | 90 start, 91 timerDelay, 93 bardEmail, 95 timerDelay, 97 bardEmail |

Edges: `86>87, 87>2, 2>13, 13>3, 13>4, 13>5, 14>81, 81>25, 25>27, 27>17,
15>35, 35>7, 16>19, 90>91, 91>93, 93>95, 95>97`

Artifacts already exported from the session (useful as parser fixtures):
`keap-campaign-584-draft.xml`, `keap-campaign-584-structure.json`,
`keap-campaign-584-sequences.json`, `keap-campaign-987-decision-34.json`.


## 9. Recommended architecture

**Not an agent walking the UI.** The data is fully structured and the traversal rules are
unambiguous, so extraction and traversal must be deterministic code. An agent doing this
398 times would be slow, expensive, non-reproducible, and risks clicking Save or Publish
in a live marketing system. Reserve the LLM for the narrative layer.

Four stages, each independently testable:

### Stage 1 — Extractor (thin and dumb)

- Playwright (or similar) with a persisted, human-established login session.
  **Do not automate credential entry; have a human log in and reuse storage state.**
- Per campaign: load `funnelEditor?funnelId=<ID>`, read `draftXml` and `publishXml`
  off the `campaign-editor` element. Reading the DOM property gives you the string already
  unescaped — much safer than regexing the inline script.
- Per `style="decision"` cell: one extra request for the decision editor, scrape layer B.
- Write raw artifacts to disk (XML + decision HTML/JSON). Do nothing else.
- A plain authenticated GET + HTML parse is a valid fast path once the parser is proven,
  but the JS string escaping is a footgun.

### Stage 2 — Normaliser (pure function, zero network)

mxGraph XML in, canonical JSON out. All logic lives here. Test offline against a fixture
library of saved XML. Style registry with graceful fallback for unknown types.

Suggested canonical shape:

```json
{
  "funnelId": "584",
  "title": "[MP-76] Satisfaction Survey",
  "published": false,
  "hasUnpublishedChanges": true,
  "goals":     [{ "cellId": "86", "style": "purchaseSuccess", "metaType": "purchase",
                  "name": "Made A Purchase", "ready": true, "refs": { "purchaseId": "..." } }],
  "sequences": [{ "cellId": "3", "name": "Satisfied", "flowType": "Stop", "ready": true,
                  "steps": [{ "position": 0, "cellId": "14", "style": "start", "config": {} }] }],
  "decisions": [{ "cellId": "13",
                  "branches": [{ "decisionId": "479", "flowId": "3",
                                 "rules": { "any": [ { "all": [ { "subject": "contact",
                                   "category": "tags", "field": null,
                                   "constraint": "notContains",
                                   "values": [{ "id": "1123", "label": "..." }] } ] } ] },
                                 "fallback": null }] }],
  "edges":     [{ "source": "86", "target": "87", "scope": "1" }],
  "orphans":   ["99"],
  "warnings":  ["unknown style 'xyz' on cell 44"],
  "provenance":{ "extractedAt": "...", "appBuild": "1.70.0...", "rawXmlSha256": "..." }
}
```

### Stage 3 — Enrichment via the official REST API

Use the **documented Keap REST API with OAuth** for everything it can answer. Account-level
entities (tags, custom fields, users, products, email metadata, forms) are **not** per-campaign:
fetch once, cache globally, join by id across all 398 campaigns.

Use `/campaigns` to **enumerate** funnel ids and cross-check names. Rule of thumb:
API for anything it can answer, scrape only for the step-level depth it cannot.
This keeps the fragile surface as small as possible.

### Stage 4 — Renderers

- Mermaid / Graphviz straight from the edge list (near-mechanical).
- Templated English per step type. Do not pay a model to do arithmetic on `waitDelay`.
- **Then** an LLM pass over the normalised JSON for narrative synthesis and audit findings.
  Never feed it raw HTML.


## 10. Cross-campaign relationships (the highest-value output)

Keap campaigns rarely reference each other directly — they couple through **shared entities**,
and **tags are the nervous system**. These edges are all deterministically computable:

| Relationship | How to detect |
|---|---|
| A triggers B | A has an Apply Tag step with tag T; B has a "Tag applied" goal for tag T |
| A enrols into B | "Add to Sequence" step referencing another sequence |
| Shared entry point | Two campaigns with goals on the same `webformId` / landing page |
| Shared content | Same `marketingEmailId` used in multiple campaigns |
| Shared commerce trigger | Same `purchaseId` / `eventId` |
| External coupling | Send HTTP Post / HTTP Request steps to the same host |
| Gate | Decision rule testing a tag that another campaign applies |

Build an **account-level graph whose nodes are campaigns AND shared entities** (tags, forms,
emails, products) with edges like applies / listens-for / sends / adds-to. That unlocks the
questions that actually matter: what fires when tag 1123 is applied; the full journey from a
given form submission; which campaigns are unreachable because nothing applies their trigger
tag; where two campaigns apply the same tag and create a loop.

**Compute the graph first, generate prose from the graph** — never the reverse. Relationship
claims must come from the computed graph, never from model inference.

## 11. Making Claude understand 398 campaigns

**A classic RAG over prose chunks is the wrong primary mechanism.** RAG is for unstructured
text and fuzzy recall; you will have 398 rigorously structured graphs with clean numeric join
keys. Embedding them into chunks destroys the precision.

Scale check: ~15 KB normalised JSON per campaign → ~6 MB total (too big for context), but a
one-paragraph summary per campaign is ~100 tokens → **the entire catalogue is ~40k tokens and
fits in context.** So: keep the catalogue resident, keep full detail in a store one tool call away.

Three layers:

1. **Canonical store** — SQLite/Postgres: campaigns, sequences, steps, edges, decisions,
   decision_rules, plus an account-wide `entities` table (tags, emails, forms, products,
   custom fields) and a `relationships` table. Every row keeps its source ids (funnelId,
   cellId, decisionId) so any statement is traceable. Keep versioned raw XML alongside.
2. **Derived semantic layer** — per-campaign generated summary, a taxonomy label
   (lead capture / nurture / onboarding / purchase follow-up / re-engagement / internal ops /
   event / sales handoff), computed metrics, and clusters. Layer in reporting activity so you
   can separate **live** campaigns from **archaeology** — with 398 campaigns, expect a large
   fraction to be abandoned experiments and duplicates. That live-vs-dead split is probably
   the single most useful thing the finished system can tell the client.
3. **Interaction layer — tools, not a vector index.** Suggested surface:
   `search_campaigns`, `get_campaign`, `trace_tag`, `trace_form`, `find_paths_between`,
   `what_touches_entity`, `list_orphans`, `diff_draft_vs_published`, `list_unreachable`.
   Add embeddings only as **one fuzzy entry point** for "which campaign handles the beta
   tester application", then hand off to the precise tools.

### Domain knowledge: handbook, not RAG

General marketing-automation reasoning is already in the model. What it cannot know is
**this client's conventions**. Mine those from the corpus: the tag naming already reveals a
taxonomy (`WooConnection Beta -> WooCommerce Beta Tester - Applied` is clearly
category-then-state), plus prefix conventions, internal-ops vs customer-facing sequences, and
which tags are gates versus records. Write it up as a derived artifact, have someone who knows
the account review it, and treat it as authoritative. A few-thousand-token curated handbook
beats a vector store over Keap's help docs.

### Summary generation

One LLM call per campaign, grounded strictly in that campaign's normalised JSON with ids
resolved to names. Two quality multipliers: **mine the `notes` nodes** (cell 78 in campaign 584
contained a human-written campaign overview — the highest-signal text in the corpus), and
**include email subject lines but not bodies** (subjects carry intent, bodies add noise).

### Human validation loop (do not skip)

Take the top ~30–40 campaigns by activity, have the client confirm or correct each generated
summary, and store corrections as authoritative overrides that beat generated text. This is the
highest-leverage step for trust, and it surfaces systematic template misreadings while they are
cheap to fix.

### Evaluation

Fixed set of ~50 questions with known answers, so you can measure whether changes help.


## 12. Safety and operational rules

- **Strictly read-only.** Enforce it at the driver level: allow GET only, and refuse to
  navigate to or submit anything matching save / publish / delete / template.
  A `PUT /app/authoring/.../template` was observed in this app — writes are one click away.
- Never touch the Actions, Publish, Save or rule controls.
- Throttle and cache. 398 campaigns is small; there is no reason to hammer the app.
- These `/app/` endpoints are **not a documented interface.** Check the client's terms of
  service before running at scale, and prefer the official API wherever it suffices.
- Snapshot raw XML for every extraction and hash it, so a format change means reprocessing
  history rather than losing it. Alert on unknown styles or unexpected attributes.
- Do not automate credential entry. Human logs in; reuse the session.
- **No PII required.** Campaign structure contains zero contact data — keep it that way
  deliberately. Do not pull contact records.
- Keep all client data inside the client's own tenancy/storage.

## 13. Suggested build order

1. **Normaliser first.** Build it against the four artifacts already exported, with
   golden-file tests and a Mermaid renderer. No auth, no bulk extraction. You already have
   enough real data to build and validate ~90% of the system.
2. Verify the **decision editor URL** (section 6) — the one real unknown.
3. Resolve the **timer timezone offset** question (section 4.2).
4. Extractor + session handling; pull all 398 into raw snapshots.
5. Load into the canonical store; build the entity cross-reference.
6. **Compute the relationship graph and look at what it reveals before generating any prose.**
   The surprises live there, and it tells you which campaigns deserve careful description and
   which are dead and need one line.
7. API enrichment pass (tags, emails, forms, products, users).
8. Summary generation + taxonomy + live/dead classification.
9. Tool surface + resident catalogue.
10. Human validation loop on the top campaigns; evaluation set.

## 14. Open questions to resolve early

1. Exact URL/params for the **decision editor** HTML (likely
   `configureCell?cellId=<id>&metaType=decision` — unconfirmed).
2. **Timer hour timezone semantics** (+3h discrepancy observed).
3. Does Keap's **campaign sharing / import** feature produce a serialised campaign package?
   If so that is a vendor-supported ingestion path and would be far more stable than reading
   `draftXml`. **Check this before committing to the scrape.**
4. Full `style` vocabulary — enumerate by sampling many campaigns and logging unknowns.
5. `publishXml` structure on a **published** campaign (both samples were unpublished drafts;
   `publishXml` was empty and `_publishedGraphs` was `[]`).
6. Whether `configureCell` exposes anything the XML does not for other step types.
7. How multi-value decision rules and multiple OR groups serialise once more than one exists
   (both observed rules were single-condition).
8. Session lifetime / `keepAlive` cadence needed for a long extraction run.
9. Whether the REST API can supply email subject lines (avoids scraping the email editor).
10. Rate limits on both the app and the API.

---

*Compiled from a live read-only investigation. No campaign was modified; Save and Publish were
never touched.*
