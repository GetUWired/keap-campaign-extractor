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
- **Rate limits** on both the app and the API (handoff §14 Q10).

## 8. Multi-app support

Added 2026-08-04. Each Keap account is an **app**, identified by its subdomain. Sessions live at
`.sessions/<app>.json` and artifacts at `artifacts/<app>/campaigns/<funnelId>/`.

### Session lifetime — partial answer to handoff §14 Q8

A session created at 17:33 was still working at 22:05 for campaign 987, then failed on the very next
command for campaign 584:

```
Session expired — landed on https://login.labs.thryv.com/u/login/identifier?state=...
```

Inspecting the saved cookies afterwards: of 12 cookies, 10 carry an explicit expiry and **2 had
already passed it, the earliest at 18:03** — roughly 30 minutes after login. The session survived
several hours of disuse but lapsed between two back-to-back runs.

**This is the single biggest operational risk to a 398-campaign run.** At this cadence a bulk
extraction cannot complete on one login. Before the bulk run, the extractor needs either a
`/app/session/keepAlive` ping on a timer, or expiry detection with resumable progress so a lapse
costs one campaign rather than the whole run. Note that the editor already issues `keepAlive` itself
on every page load, which was evidently not sufficient.

The failure was clean: a readable message, no stack trace, and **nothing written** — the
verification-before-write ordering held.

### Cross-app access — still unanswered, but largely defused

The plan intended to answer whether the `.infusionsoft.com` wildcard cookie grants one app's session
access to another app's subdomain. It could not be answered, because per-app session files make the
attempt impossible:

```
$ npm run spike -- --app abc12345 --funnel 987
No session for "abc12345" at .sessions/abc12345.json. Run:  npm run login -- --app abc12345
```

The run stops before any network request. This is a stronger property than the design aimed for —
the wildcard cookie never gets an opportunity — but it means **the underlying question remains open**
and would need a second real app to settle.

The residual risk is an operator holding sessions for two apps who targets the wrong host. That path
was tested directly, by copying the `jordan` session to `.sessions/abc12345.json` and pointing it at
`jordan`'s real host:

```
KEAP_BASE_URL is set — using https://jordan.infusionsoft.com instead of the URL derived
from app "abc12345". Artifacts are still filed under "abc12345".
  app mismatch: asked for "abc12345" but draftXml says "jordan"
identity check failed — nothing was written
```

No directory was created. The guard works end to end, and the `KEAP_BASE_URL` override announces
itself so a stale environment variable cannot silently redirect a run.

### Input validation

App names and funnel ids are interpolated into both URLs and filesystem paths, so both are validated
before use. `--app ../../../etc`, `--app evil.com/x`, `--funnel ../etc` and `--funnel abc` are all
rejected without launching a browser or creating a directory.

### Verified layout (multi-app)

Both campaigns re-extracted under the new structure. Campaign 584 came back at **11,185 chars / 43
cells — a delta of 0 against the handoff baseline**. `meta.json` now leads with `appName`, so an
artifact identifies its own origin even if moved. Both runs allowed 0 non-GET requests.

## 9. Campaign enumeration

Added 2026-08-04. The extractor could previously only fetch campaigns whose ids were already known;
every one extracted came from an id the handoff happened to record.

### The endpoint, and why page size is a GET

The Automations list is a legacy JSP report:

```
GET /Reports/searchTemplate.jsp?reportClass=SetupFunnel&view=resultsPage&perPage=500
```

**The UI paginates by POST** — form data (`perPage`, `currentPage`, `pageSet`, `action`,
`reportClass`, `skin`, `reportStateId`) to `searchTemplate.jsp?view=gridGuts`. The read-only guard
blocks every non-GET, so the UI's own mechanism is unavailable.

`perPage` is also honoured as a **GET query parameter**, which the default page load does not reveal:

| Request | Rows | `numberOfRecords` |
|---|---|---|
| default | 50 | 170 |
| `&perPage=500` | **170** | 170 |

One read-only request covers the account, so no guard exception was needed. The server mints its own
`reportStateId`; none has to be supplied. The page's own selector tops out at 500, but a tooltip
references a 1000-per-page mode if an account ever needs it.

### Results for `jordan`

**170 campaigns. 79 published, 91 never published** — 54% of the account has never been published.

Categories: Old Campaigns 141, ListCleaner.io Campaigns 4, Demo Campaigns 3, WooConnection 1,
Mesa High 20 Year Reunion 1, ezSMS 1, LinkTracking.com 1. A single catch-all category holds 83% of
the account, which says more about how the taxonomy is used than about the campaigns.

Cross-validated against the two campaigns extracted directly: 584 reports `published: false` and its
`publish.xml` is 0 bytes; 987 reports `published: true` and its `publish.xml` is 4,899 chars. Two
independent sources agreeing.

**Caveat on the live-versus-dead question.** "Never published" is a strong signal, but "published
years ago and now inert" is the larger category in most accounts and this data cannot see it.
Separating those needs the reporting activity the handoff describes in §11, which nothing here has
touched. Treat 91 as a floor on the dead count, not an estimate of it.

### Three defects found, all by running it rather than reading it

1. **The guard did not cover `/Reports/`.** `WRITE_URL_PATTERN` applied only under `/app/`, leaving
   `GET /Reports/reportActions.jsp?actionName=Unpublish+and+Delete+Automations` — a URL in the
   Actions menu of the very page enumeration reads — allowed. The denylist now applies to all paths
   with a static-asset prefix exemption. `/template` is anchored to the end of the path, because an
   unanchored match blocks `/Reports/searchTemplate.jsp`, the enumeration endpoint itself.

2. **Session expiry was invisible to API requests.** `safeGet` has no `Page`, so
   `assertAuthenticated` never ran. An expired session returns **HTTP 200 with 55 KB of login
   markup**, which the parser reported as "the response did not look like the automations list" —
   sending the reader after a parser bug when the fix was to log in again. `fetchCampaignList` now
   checks the response's final URL.

3. **A phantom campaign with every column shifted by one.** The data table is nested one row deep
   inside an outer `grid-table`. A global `$('tr')` scan matched that wrapper row too, and because
   cheerio's `find()` is recursive it reported every descendant cell — 1191 of them — plus the first
   data row's link. The first live run returned **171 campaigns against a page reporting 170**, with
   the campaign name "Untitled automation" appearing in the *category* tally.

   Two things let it through. The fixture had been trimmed of the wrapper, so no test could see it.
   And the count check was one-sided — it failed on a short read but not an over-count. Both are
   fixed: the fixture reproduces the nesting exactly, row and cell selection is scoped to the
   header's own table using direct children, and any disagreement with the page's total now fails,
   naming which direction it went.

### App URL shapes (open, still)

The account menu exposes three distinct shapes across linked apps: `sp218.infusionsoft.com`,
`app.infusionsoft.com?app_id=ro474`, and `keap.app?app_id=qw806`. `baseUrlFor` assumes the first
only, and would build an unresolvable URL for the other two. Not fixed — it needs a real app of each
shape to verify against, and `KEAP_BASE_URL` is an escape hatch meanwhile. Worth settling before a
client migration rather than during one.

## 10. Bulk extraction

Added 2026-08-05. The whole `jordan` account is extracted.

### Timing — the session problem is smaller than it looked

**160 campaigns in 389.5 seconds, zero failures**, on one session that survived the entire run.

| Measure | Value |
|---|---|
| Per campaign, including a 250ms throttle | 2.43s |
| Per campaign, net of the throttle | 2.18s |
| Projected for a 398-campaign account | ~16 minutes |

That is comfortably inside the observed ~30-minute session window, which reframes the expiry
problem: a full account does **not** need keepAlive. Resumability is insurance against a mid-run
death, and the measured cost of resuming is one campaign — about two seconds.

The earlier three-campaign sample predicted 1.75s; the real figure across 170 is 2.18s. The
difference is campaign size: the sample happened to be small ones. The largest here was 148 cells
against the sample's 43.

### Scale of the corpus

170 campaigns, **6,521 cells**, **85 decision diamonds**, 80 with a published version.

### The style vocabulary is far larger than documented

**61 distinct node styles. 47 were never documented** — the handoff listed 10, and the first two
campaigns added 4 more.

The most common undocumented ones, by cell count: `timerDate` 113, `indicateInterest` 82, `http` 60,
`eventRequest` 36, `note` 35, `goal` 33, `requestInfo` 30, `makeCall` 23, `landingPage` 22,
`eventAttend` 21, `fulfillment` 18, `api` 17, `website` 16, `noteApplied` 16. The tail runs down to
single occurrences: `radioAd`, `customerHub`, `scoreAchieved`, `failedPurchase`, `createOrder`,
`addToSequence`, `cancelSubscription`.

**This is the strongest argument yet for not having built the normaliser earlier.** Its step
taxonomy is its entire job, and designing one against the 14 styles known from two campaigns would
have covered 23% of the vocabulary actually present. Note also that `http` (60) and `api` (17)
represent outbound integrations — the "external coupling" relationship the handoff describes in §10,
and far more common here than expected.

### Two published signals disagree

Enumeration reports 79 published; `publishXml` reports 80. They disagree about exactly one campaign:

```
899 "Testing Wooconnection" — list Published Date: none, publishXmlLength: 1863
```

The list's Published Date column is metadata; a non-empty `publishXml` is the artifact itself.
**Treat `publishXml` as authoritative.** The consequence for the live-versus-dead classification is
that the cheap signal available at enumeration time is slightly wrong, and the reliable one only
exists after extraction.

### A guard false positive, found by volume

The full run blocked 3 requests on the denylist rather than the method rule:

```
GET /app/funnel/_publish.svg?b=…
```

An icon, blocked because its filename contains "publish". It sits under `/app/`, so the
`/resources/` prefix exemption missed it. Harmless — `draftXml` is read from the DOM, not from
rendered icons — but it demonstrates the denylist blocking a legitimate read, and the next such
asset might matter. Fixed by exempting static file *extensions* wherever they are served from, not
just static directories.

Two runs of two and three campaigns never surfaced it. It took 170.

### Resume verified, not assumed

`progress.json` claimed campaign 999 was complete. Its directory was deleted, and the next run
reported:

```
warning: 1 campaign(s) marked done have no artifacts on disk and will be re-extracted: 999
```

It re-extracted that campaign and only that campaign. This is the mitigation for keeping the
progress record separate from the artifacts it describes, and it works.

After the full run, `progress.json` lists 170 done and there are 170 campaign directories, with no
entry on either side lacking a counterpart.

### Incidental

The app build changed mid-session, from `1.70.0.989251-sysarch-202608031100` to
`1.70.0.990820-hf-202608041714` — Keap shipped a hotfix while this work was in progress. Nothing
broke, but it is a reminder that every endpoint here is undocumented and can move without notice.
`meta.json` records `appBuild` per campaign, so a future format change is at least attributable.
