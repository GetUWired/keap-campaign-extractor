# Keap Campaign Extraction Spike — Findings

Run 2026-08-04 against `jordan.infusionsoft.com`, app build `1.70.0.989251-sysarch-202608031100`.
Campaigns 584 and 987. All values below were observed, not inferred.

## Verdict

The spike succeeded. A strictly read-only Playwright extractor logs in with a human-established
session, exports campaign structure, enumerates decision cells, and fetches and parses their
criteria. Both open questions blocking automation are closed.

| Success criterion | Result |
|---|---|
| Human login produces a reusable session | pass |
| `draft.xml` non-empty and parseable | pass — 584 is 11,185 chars, byte-identical to the handoff baseline |
| `parseCells` finds decision cell 13 in campaign 584 | pass — three branches |
| Campaign 987 decision 34 routes `479→3`, `481→32` | pass |
| Decision criteria resolved | pass — endpoint confirmed, both campaigns parsed |
| Zero non-GET requests reached the network | pass |
| Tests pass offline | pass — 58 tests |

## 1. The decision editor endpoint (closes handoff §14 Q1)

**`configureCell` was the wrong endpoint.** All three guessed candidates returned HTTP 200 with a
75-byte empty modal shell:

```html
<input id="cellId" type="hidden" value="34" /><div class="modal-body">
```

It echoed `cellId` correctly, so the request was well formed — `metaType=decision` simply is not
what populates it. Status code alone would have read as success; only content-based validation
caught it.

The real endpoint, captured by opening a decision diamond in the UI:

```
GET /app/decisionFunnel/decisionEditor
    ?flowIds=3,32&decisionIds=479L,481L&secondaryKey=WebForm&secondaryKeyId=681L
```

Notable properties:

- **Keyed by branch lists, not by cell id.** Both lists come from the decision cell's
  `<Array as="decisions">`.
- **`decisionIds` keeps the Java-Long `L` suffix; `flowIds` does not.**
- **`secondaryKey` / `secondaryKeyId` are optional.** Both campaigns returned complete, parseable
  rules from the bare form. `secondaryKeyId=681L` is the `webformId` of the upstream
  `newsletterRequest` goal (cell 2 in campaign 987) — so supplying it requires tracing the goal
  that feeds the decision.
- **The response echoes those two parameters back rather than deriving them.** Requested bare, they
  return empty. They cannot be recovered from the response.

### Consequence: labels degrade without goal context

Requested bare, Keap cannot resolve display names for **form-scoped** fields and renders the raw
enum plus a marker:

```
<option selected="selected" value="formSubmission_Subject">formSubmission_Subject (invalid)</option>
```

Machine-readable values are unaffected, so routing and logic stay correct — only human-readable
labels are lost. Tag-based decisions (campaign 987) are unaffected, because tags are account-global
rather than form-scoped.

**Open decision for stage 3:** either trace the upstream goal and pass `secondaryKey`/`secondaryKeyId`,
or resolve `formSubmissionOption3780` style ids through the REST API during enrichment. The second is
probably better — it keeps the fragile scraped surface smaller, which is the standing rule.

## 2. Layer-B markup: the handoff's container chain is misleading

Handoff §5.2 documents the chain as `div.ruleGroupOuter_<n>` — dot notation, implying class. The
live markup puts the number on **`id`**, with an unsuffixed class:

```html
<div id="ruleGroupOuter_1499" class="ruleGroupOuter">
```

A class-based parser finds zero rule groups and reports no error. Three further corrections:

| Handoff / assumption | Reality |
|---|---|
| Rules identified by class suffix | `id="rule_561"`, class is bare `rule` |
| `#elseRulesOptions` marks its choice with `selected` | No option is selected; the `<select>` carries `value="0"` |
| Wrapper→sequence pairing is ordinal only | Each wrapper has `<span id="flow_3">` naming its sequence directly. Ordinal alignment held on both campaigns, but the header is authoritative |
| `field_<id>` is a hidden input | Hidden input in 987, `<select>` in 584. Both occur |
| Rule values are entity ids with a `_text` label | True for tags. Form-option rules store a literal `value="true"` in a text input with no `_text` companion |

**Trap:** the flow header contains `rule_menu_button_off_1499`, `rule_menu_popup_1499` and
`rule_import_rules_menu_item_1499`. An id match of `/^rule_(.+)$/` reads all three as rules.
Anchor on `/^rule_(\d+)$/`.

## 3. `publishXml` on a published campaign (closes handoff §14 Q5)

Both handoff samples were unpublished drafts with empty `publishXml`. Campaign 987 is published:

| Campaign | draft | publish | Interpretation |
|---|---|---|---|
| 584 | 11,185 chars / 43 cells | 0 chars | never published |
| 987 | 7,917 chars / 33 cells | 4,899 chars / 21 cells | published, with unpublished changes |

Cells `19-22` and `38-45` exist in 987's draft but not its published version; nothing exists only in
the published version. The draft-vs-published diff works as the handoff predicted, and cost nothing.

## 4. Style vocabulary (progresses handoff §14 Q4)

The handoff documented 10 styles. Four more appeared in the first two campaigns:

| Style | Where | Why it matters |
|---|---|---|
| `edge` | both | Edges carry `style="edge"`, not only the `edge="1"` attribute |
| `tag` | 987 | Apply-tag step |
| `tagApplied` | 987 | Tag-applied goal |
| `notes` | 584 | Confirmed present — handoff calls these the highest-signal text in the corpus |

`tag` and `tagApplied` are the two primitives the cross-campaign relationship graph is built from,
and they turned up immediately. Expect more; the style registry must keep failing soft.

Full counts — 584: `newsletterRequest` 2, `flow` 4, `start` 4, `edge` 17, `timerDelay` 5, `email` 3,
`task` 1, `decision` 1, `notes` 1, `purchaseSuccess` 1, `bardEmail` 2. 987: `newsletterRequest` 1,
`flow` 4, `start` 6, `bardEmail` 2, `edge` 12, `tag` 1, `timerDelay` 1, `tagApplied` 2, `decision` 1,
`task` 1.

## 5. Read-only guard held

| Campaign | Allowed | Non-GET allowed | Blocked |
|---|---|---|---|
| 584 | 272 | **0** | 8 |
| 987 | 207 | **0** | 3 |

Every blocked request was a third-party analytics beacon — Amplitude, FullStory, Pendo. No
legitimate application request was blocked, so restricting the write-pattern denylist to `/app/`
paths avoided false positives on static assets.

The editor issued only **two** `/app/` GETs (`funnelEditor`, `session/keepAlive`), confirming the
handoff's central claim: a whole campaign structure costs one request. Decision criteria add one
GET per decision cell.

Note that `safeGet` uses Playwright's `APIRequestContext`, which does not participate in route
handling, so decision fetches do not appear in `requests.log.json`. The policy is re-applied in
code; the log covers browser traffic only.

## 6. Bugs found and fixed

1. **Layer-B parser matched classes instead of ids** — returned zero rules with an empty `warnings`
   array. A confident, empty, wrong answer. The synthetic fixture encoded the same misreading, so
   nine tests passed against a fiction. Fixed, and the parser now warns when a wrapper yields no
   rule groups.
2. **`stripLongSuffix` corrupted ordinary values.** A bare `/L$/` strip turned `EMAIL` into `EMAI`
   and `ALL` into `AL`. Decision rules can match literal strings, so this was live data corruption
   waiting to happen. Narrowed to `/^(\d+)L$/`.
3. **A missing session file produced a stack trace** rather than the documented "run `npm run login`"
   message — `openSession` sat outside the error-handling block.
4. **Stale decision artifacts survived a re-run**, leaving `.attempt-N.html` files from a failed run
   beside a successful `.html`. The output directory is now cleared first.
5. **Dependency vulnerabilities** in the versions the plan pinned — one critical, one high. Neither
   was exploitable in our usage. Cleared by bumping `fast-xml-parser` to 5 and `vitest` to 3.

## 7. Still open

- **Timer hour timezone semantics** (handoff §14 Q2). Untouched. The raw fields and the account
  timezone label are captured in `meta.json`, so it is answerable offline without re-extracting.
- **Whether to pass goal context** for form-scoped decisions, versus resolving those ids through the
  REST API during enrichment — see §1.
- **Full style vocabulary.** Four new types from two campaigns says the tail is long. Log unknowns
  across the full corpus before designing the normaliser's step taxonomy.
- **`RuleValue.id` is a misnomer** for form-option rules, where the value is a literal boolean rather
  than an entity reference. Harmless as raw capture; the normaliser should model the two cases apart.
- **Session lifetime** over a long run (handoff §14 Q8). Two campaigns prove nothing about 398.
- **Rate limits** on both the app and the API (handoff §14 Q10).
