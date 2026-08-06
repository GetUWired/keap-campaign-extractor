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

### Authorisation — settled

Handoff §12 says to "check the client's terms of service before running at scale". **Resolved
2026-08-05: not a blocker.** Clients grant this agency access to their accounts so it can work on
their campaigns on their behalf, so operating the app through a delegated login is the normal course
of the engagement rather than something exceptional.

The safeguards stay regardless, because they protect the client's data rather than the agency's
position: GET only, every write path blocked at the driver level, no contact records touched, and a
session a human established by hand.

For reference, one full account costs under 500 meaningful requests over about six minutes —
`funnelEditor` ×160, `keepAlive` ×160, `decisionEditor` ×85, plus ~70 incidental app calls.

### Request volume is dominated by page chrome

Of 31,814 requests to the tenant during the full run, only about 480 were meaningful. **The other
~98.5% were SVGs, fonts, CSS and JavaScript** — the cost of loading the entire campaign-builder UI
160 times in order to read one DOM property off one element.

Broken down: **scripts 67.7%**, CSS 12.1%, images 10.4%, pages 6.0%, Polymer HTML imports 1.5%.
Blocking images, CSS and fonts — the categories that provably cannot affect `draftXml` — would remove
only 22.5%. The bulk is JavaScript, which may be load-bearing.

**Deliberately deferred 2026-08-05.** At 2.18s per campaign a 398-campaign account takes about
sixteen minutes, which is not a constraint worth optimising against yet. Recorded rather than acted
on.

Three tiers exist if it ever becomes worth doing, in increasing order of payoff and risk:

1. Block images, CSS and fonts — no risk, ~155 requests per campaign instead of ~200.
2. Also block external scripts — ~20 requests. `draftXml` is assigned by an *inline* script, which
   still runs when external ones are blocked, so Polymer and mxGraph may be unnecessary given that
   nothing is ever rendered. Unverified.
3. No browser at all: a plain authenticated GET, parsing `draftXml` out of the inline script — **1**
   request. This is the fast path handoff §9 names, along with its warning that the JS string
   escaping is a footgun. Any implementation must extract the value without logging or storing the
   surrounding script text, since session tokens sit beside it (§7 gotcha 4).

Whichever is attempted, it is now cheaply decidable rather than arguable: every campaign on disk
carries a `draftXmlSha256`, so a candidate approach can be verified byte-exact against 170 known-good
extractions.

## 11. Normalisation

Added 2026-08-06. All 170 campaigns are canonical JSON in `artifacts/jordan/normalized/`.

| | |
|---|---|
| Campaigns normalised / skipped | **170 / 0** |
| Sequences | 767 — of which **365 are empty** |
| Steps | 1,824 |
| Goals | 728 |
| Notes | 198 |
| Decisions | 85, of which 74 carry criteria |
| Orphans | 53 |
| Undocumented styles encountered | 0 |

### Step ordering works, and document order would have been wrong

Edges are separate cells carrying `source`/`target`, scoped by `parent`. Walking from the `start`
vertex reproduces campaign 584's documented sequence exactly — `14, 81, 25, 27, 17` — while those
edge cells appear in the XML as 28, 18, 82, 83. **Document order is not step order**, so a normaliser
that trusted file order would have produced confidently wrong sequences for the whole corpus.

**58 of 767 sequences (7.6%)** could not be walked to completion, every one because the walk reached
some but not all steps. Those keep document order and are flagged `orderVerified: false` rather than
being silently reordered.

An earlier run reported 423 failures. **365 of those were sequences with no steps at all** — empty
sequences have no start vertex, so they looked like walk failures. Treating an empty sequence as
trivially ordered brought the real figure out from under the noise. Worth noting on its own account:
**48% of the sequences in this account are empty**, which is a substantial signal for the
live-versus-dead question.

### Cross-validation

The normalised corpus contains **131 distinct tags across 295 references** — matching the raw XML
survey exactly. Two independent code paths, the same answer.

### Gaps this surfaced

- **11 of 85 decisions have no branches at all** — corrected 2026-08-06 while building the graph.
  The earlier reading of "routing but no criteria" was wrong: every decision that has branches also
  has criteria on disk (74 of 74). The 11 are unconfigured diamonds with an empty
  `<Array as="decisions">`, so there is no routing to chase and nothing missing from the extraction.
- **53 orphans** across the account — top-level nodes no edge touches. The handoff calls orphan
  detection free, and this is the first count of it.
- **198 notes.** The handoff calls these the highest-signal text in the corpus, and there is
  substantially more of it than expected.

### What is deliberately not done

The account-level relationship graph — campaigns and shared entities as nodes, `applies` /
`listens-for` / `triggers` as edges — is designed in
`docs/superpowers/specs/2026-08-06-normaliser-design.md` §7 but not built. It is the piece that turns
131 tags and 295 references into "what fires when tag 646 is applied" and "which campaigns are
unreachable". Split into its own plan deliberately.

### Incidental

The app build changed mid-session, from `1.70.0.989251-sysarch-202608031100` to
`1.70.0.990820-hf-202608041714` — Keap shipped a hotfix while this work was in progress. Nothing
broke, but it is a reminder that every endpoint here is undocumented and can move without notice.
`meta.json` records `appBuild` per campaign, so a future format change is at least attributable.

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

The 142 tags are the 131 counted from `<Array as="tagIds">` plus **11 that appear only in decision
criteria** — the excess over the floor is fully attributable, as the design predicted.

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
campaign 16  → 467            via tag 346
campaign 672 → 670, 674, 676  via tag 646
```

The tag counts say the same thing from the other side: **92 of the 142 tags are applied by a campaign
nothing listens for**, and 44 are applied by nobody at all. Tags here are overwhelmingly
record-keeping rather than wiring between campaigns.

**Emails are never shared.** 250 distinct `marketingEmailId` values across 250 references — every
email belongs to exactly one campaign. Only 13 tags are applied by more than one campaign.

The practical consequence for a migration is good news: campaigns are mostly independent units, so
they can be moved one at a time rather than in coupled clusters.

### 10 campaigns cannot be entered

Four have no goals at all — 199, 331, 411, 656. Six have goals, but every one is a `tagApplied` goal
listening for a tag no *other* campaign applies: 557, 588, 672, 745, 809, 949. A campaign applying a
tag it listens for does not rescue itself; the loop still needs an outside first push.

Campaign 672 is the interesting one: it is unreachable, and it is also the account's largest trigger
source, feeding 670, 674 and 676. A dead campaign holding three live ones open.

Combined with the 91 never-published campaigns and 365 empty sequences already on record, this is
the third independent signal pointing at the same conclusion about how much of this account is inert.

### What the graph deliberately does not model

- **14 of the 20 lifted foreign keys have no entity kind** — led by `marketingNoteId` (94
  references), `fileBoxId` (43) and `stageId` (37). They stay in the normalised files, so widening
  the entity vocabulary later costs a re-run and nothing else.
- **24 `tagIds` references state no direction.** They sit on goal styles — `eventAttend` (6), `goal`
  (6), `newsletterRequest` (4), `purchaseSuccess` (3), `indicateInterest` (2), `requestInfo` (2),
  `eventRequest` (1) — that carry a tag without saying whether they apply it, require it, or
  something else. The tags are registered as entities; no edge is invented. Settling this needs a
  look at the live UI for one of each style.
- **Only 6 of 142 tags have a display name.** Decision criteria are the sole source of names in the
  extracted data, so everything else is a bare id until stage 3 resolves them through the REST API.
  A graph of numbered tags is analysable but not yet readable.

### Verification

Every figure above was predicted from the corpus before the code was written, and the implementation
reproduced all of them exactly — entity counts, edge counts per kind, and all five findings. Two
independent derivations agreeing. The run is also byte-deterministic: a second `npm run normalize`
produces an identical `graph.json`.

## 13. REST API enrichment

Added 2026-08-06. `artifacts/jordan/entities.json` — 528 entities in 9.7s, joined onto the graph at
normalise time. Auth is a Service Account Key in `X-Keap-API-Key`; the key is never written to disk,
logged, or included in an error message.

| Kind | Endpoint | Fetched | Referenced | Labelled |
|---|---|---|---|---|
| tag | `/crm/rest/v2/tags` | 131 | 142 | **40** |
| webform | `/crm/rest/v2/webforms` | 202 | 113 | **63** |
| email | `/crm/rest/v2/emails/templates` | 136 | 250 | **0** |
| form | `/crm/rest/v1/forms` | 7 | 16 | **0** |
| product | `/crm/rest/v2/products` | 36 | 11 | **7** |
| user | `/crm/rest/v2/users` | 16 | 4 | **3** |
| landingPage | none exists | — | 60 | **0** |

**113 of 596 non-campaign entities now carry a name**, against the 586 this stage set out to fix.
That is a modest result, and the reasons are worth more than the number.

### The first run pulled 14,914 sent emails

`/crm/rest/v2/emails` is **sent-email history** — the record of what went to which contact — not the
campaign email templates that `marketingEmailId` points at. Probed blind, it answered, and the
catalogue filled with 14,914 records against 250 referenced.

It looked like it worked. 104 of the 250 referenced ids existed in that set, so 40% of campaign email
steps would have been labelled — every one of them wrong. The tell was that the API returned the
**same** name for every distinct id sampled, and all 72 email steps carrying a real name disagreed
with the record sitting at their id. The "matches" were coincidental collisions in a range spanning
1–30740.

**Campaign email content lives one level down, at `/crm/rest/v2/emails/templates`.** The parent is
now permanently off the allowlist, anchored so that permitting the child cannot reopen it. The
catalogue that run produced was deleted.

Two lessons, both already written into the code rather than only here. An endpoint answering `200`
with plausible data is not evidence it holds what you asked for. And the check that caught it —
comparing against names the extractor already had — cost nothing and was the only thing standing
between this and a confidently mislabelled corpus.

### Campaign emails are still unresolved

The templates endpoint is the right resource and returns real, named emails. But **it shares no id
with any `marketingEmailId`**: template ids run 150–2058 and are mostly odd, campaign email ids run
1146–2442 and are uniformly even. Zero of 250 match.

So `/emails/templates` is the account's reusable template library, and a campaign email is a
different record. Nothing is mislabelled — zero overlap means zero false names — but **handoff §14 Q9
remains open**: the API supplies email templates, and campaign email content is still unresolved.

### `/forms` and `/webforms` are different resources

`/crm/rest/v1/forms` matched 6 of 16 `internalFormId` references and **0 of 113** `webformId`. It
serves internal forms. An earlier candidate ordering let `webform` claim it first, which would have
named 113 webforms from 7 unrelated records — the same failure as the email endpoint, caught by the
same kind of check before it shipped.

Public webforms have their own resource, `/crm/rest/v2/webforms`, which matched 63 of 113.

The 6 internal forms that do match carry **no name field at all**, so they resolve to an entity and
label nothing. Matched is not the same as named.

### "Not found" and "not looked up" are different claims

The first enriched run reported **465 broken references**. 310 of those were emails and landing
pages — kinds with no comparable source at all. Reported that way it reads as "310 campaigns point
at deleted records", which is false; nothing was ever looked up.

A kind now qualifies for broken-reference reporting only once it has proved comparable by matching
at least one id. The honest figures:

| Finding | Total | By kind |
|---|---|---|
| Broken references | **155** | tag 90, webform 50, form 10, product 4, user 1 |
| Unused account entities | **273** | webform 139, tag 91, product 29, user 13, form 1 |

**90 tags and 50 webforms referenced by campaigns no longer exist in the account.** Against 141
campaigns filed under "Old Campaigns", that is consistent rather than surprising — and it is the
fourth independent signal, after 91 never-published campaigns, 365 empty sequences and 10
unreachable campaigns, all pointing the same way.

The other direction is just as useful for a migration: **273 account entities nothing references**,
including 139 webforms and 91 tags that exist but are wired to nothing.

### The cross-check paid for itself twice

Six tags carry a label from decision criteria — an entirely independent source, extracted months of
code earlier. All six agree with the API. Five differ only in that criteria render a tag as
`Category -> Name` where the API returns the bare name, so the comparison treats that prefix as
agreement; otherwise five predictable conflicts would have buried any real drift.

That check is what proved the tag join sound, and therefore that 40-of-142 is genuine deletion rather
than a broken key. It is also what condemned the email join.

### Rate limits — a lower bound, not an answer

Handoff §14 Q10 asked about API rate limits. **Not reached.** The 528-entity run made roughly 13
requests at the extractor's 250ms throttle with no 429; the earlier 15,103-entity run made about 21,
including 15 pages of 1,000 records, also with no 429.

That is a lower bound of "at least 4 requests/second sustained, at least 15,000 records", not a
measured ceiling. State it as such: nothing here establishes where the limit is.

### What remains unnamed

- **250 campaign emails** — the template library does not key by `marketingEmailId`.
- **60 landing pages** — no endpoint exists on either API version.
- **16 internal forms** — 6 resolve but carry no name.
- **102 tags and 50 webforms** — deleted from the account; correctly unnamed.

## 14. Publication semantics, established by experiment

Added 2026-08-06. Everything before this was inferred from static snapshots. Here a human made two
deliberate changes in the campaign builder between extractions of campaign 987, which turns several
guesses into observations. All three states are preserved in
`test/fixtures/campaign-987-lifecycle/`.

### `ready` is user-controlled, and independent of publication

Ticking "ready" on two sequences changed exactly this, and nothing else:

```diff
- <Object name="Approved for Beta" flowType="Stop" published="0" initialized="1" as="value"/>
+ <Object name="Approved for Beta" flowType="Stop" published="0" initialized="1" ready="1" broken="0" as="value"/>
```

`published="0"` is unchanged and `publish.xml` is byte-identical across the transition. Readiness and
publication are separate axes.

**Before the change the attribute was absent entirely, not `ready="0"`.** So `ready: null` means
"never marked" and is a distinct state from an explicit false. `boolOrNull` preserves all three,
which is the only reason this was visible; a parser coercing absent to false would have erased it.

The three states behave differently, and absent is the worst:

| `ready` | share of references that resolve to a real account entity |
|---|---|
| `true` | 45% |
| `false` (explicit) | 16% |
| `null` (absent) | **7%** |

### `published` at node level means "in the published snapshot"

Not "finished". This is why it predicts nothing about whether a referenced entity exists — 36% of
references resolve under `published=true` against 39% under false, which is noise.

`ready` is the field carrying builder intent, and it is the one with signal.

### `broken` is transient

It appears when readiness is evaluated and is **removed entirely on publication** — zero occurrences
remain in the published state. It is a pre-publish validation artifact, not durable state.

That reframes the corpus survey: 910 nodes carry `broken`, and all of them are therefore unpublished.
Any analysis treating it as a lasting property would have been reading unpublished-ness under
another name. Caught before anything was built on it.

### Keap refuses to publish a campaign containing an unconfigured step

Publishing required deleting cell 43 — a `task` step with every field empty:

```
taskType="" taskTitle="" taskBody="" taskAssignToOwner="0" taskDaysTillDue="0"
```

The operator deleted it and its inbound edge rather than configure it, taking the campaign from 11
steps to 10 and removing `task` from the style histogram. Publication also flipped `published` to
`1` throughout and made `draft.xml` and `publish.xml` byte-identical, so `hasUnpublishedChanges`
went `true` → `false` — **the only live validation that logic has had.**

### This inverts the missing-entity story

Entities referenced only by never-published campaigns exist in the account 31% of the time, against
49% for those touched by at least one published campaign. The intuitive reading is that entities are
missing *because* the campaign is unpublished.

The mechanism is the other way round. Every published campaign has passed a validator that rejects
unconfigured steps, so unconfigured steps survive mainly in campaigns that were never published — and
those steps' references were never real entities to begin with. **A campaign is not missing entities
because it is unpublished; it is unpublished because it still contains steps nobody finished.**

Consequence for the graph, now acted on: the 155 "broken references" were two different things, and
splitting them by whether a *ready* step is what points at the missing entity gives

| | |
|---|---|
| **87** referenced by a step someone marked ready | genuine breakage, worth chasing |
| **68** referenced only by steps nobody marked ready | abandoned drafting, not breakage |

Nearly half the apparent breakage was never breakage.

### Unconfigured steps, detected structurally

`isUnconfigured` in `nodes.ts` flags a node with no type-specific setting, no reference, and no
non-empty array — the same incompleteness Keap's validator rejects. Empty and `"0"` both count as
unset, because the deleted step carried `taskType=""` *and* `taskAssignToOwner="0"`; testing for
empty strings alone would have called it configured. Arrays and `objectLists` are checked too, since
a decision keeps its branches there rather than in `config`.

The rule was validated against three independent facts rather than by inspection:

- it flags cell 43, the step Keap refused to publish, in the preserved fixture;
- it flags **exactly the 11 branchless decisions** from section 11;
- it flags **exactly the 58 tag steps** carrying neither `isApply` nor any tag.

Across the account: **720 unconfigured nodes in 116 of 170 campaigns.** None of those campaigns can
be published as they stand.

### Readiness is the sharpest live-versus-dead signal yet

| Sequences | |
|---|---|
| Marked ready | 158 of 767 |
| Explicitly not ready | 135 |
| Never marked | 474 |

**102 of 170 campaigns have no ready sequence at all** — more than the 91 never published, and a
better-grounded measure, because it records whether a human considered the work finished rather than
whether it reached production.

The 135 explicit `ready="0"` sequences are worth a second look: since absence is the untouched state,
an explicit false plausibly means marked-then-unmarked. That mechanism is unconfirmed.

### Two operational notes

**Re-extraction destroys history.** `npm run spike` overwrites
`artifacts/<app>/campaigns/<id>/` in place. Cell 43 now exists nowhere in Keap and nowhere in the
artifacts — it survives only because it was copied into `test/fixtures/` by hand. `meta.json` stores
`draftXmlSha256`, so a re-extraction can tell you something changed and never what. Three
experiments produced three irreversible states today and only the last is in `artifacts/`.

**The session expired a second time**, mid-experiment, consistent with the ~30-minute window in §8.
It failed cleanly with nothing written and nothing clobbered. Irrelevant to a bulk run at 6.5 minutes
per account; awkward for interactive work like this.

## 15. Rendering

Added 2026-08-06. `artifacts/jordan/rendered/` — 170 Markdown pages plus an index, generated offline
in seconds from `normalized/`, `graph.json` and `entities.json`.

Each page carries a Mermaid diagram of the campaign level, every goal and step in English, and what
the campaign connects to in both directions. Rendering adds no information. Its entire value is
making existing information impossible to miss — and on the first real run it did that four times.

### Entities were never decoded anywhere

`cleanName` strips `~br~` and collapses whitespace, but nothing in the pipeline ever decoded HTML
entities. **76 labels and 95 note bodies carried `&#39;` and `&quot;` straight through extraction,
normalisation and the graph** — including timer descriptions reading "the contact&#39;s next
Birthday".

Nothing had ever displayed that text, so nothing had noticed. Rendering is what made a long-standing
data defect visible, and it is fixed at the render layer rather than in `cleanName`, so the
normalised artifacts stay byte-identical to what was extracted.

**Catalog names needed it too, and that was the sharper miss.** Names from the REST API never pass
through `cleanName` at all, so one webform arrived as
`"Request our\nEmail Series\n&quot;How to generate\nleads online&quot;"` and put four broken lines
into a page. The fix cleans every name at the point it enters the renderer.

### Timers needed no arithmetic after all

Keap writes the human-readable description into `name`:

```
"Wait at least 3 days and then run on a weekday at 8:00 AM"
```

So timers render verbatim and **handoff §14 Q2's timezone discrepancy does not block display** —
showing Keap's own string shows exactly what the builder shows. Q2 stays open for anything that needs
to *reason* about timing. This removed the fiddliest part of the planned work entirely.

### One style, several meanings

`newsletterRequest` is a web form submission 106 times, a landing page 20 times, an internal form 7
times, and unconfigured 69 times. The flat style→label table originally specced could not have
expressed that; labels are derived from style **and** references instead.

Keap has also shipped several builders over the years — `email`, `bardEmail` and `unlayerEmail` are
one thing to a reader, as are `landingPage` and `convrrtLandingPage`. Internal style names never
appear in output.

**Still unsettled:** `stageMove`, `makeCall`, `indicateInterest` and `fileDownload` all carry an
optional `stageId` that most instances leave unset — 7 of 82 for `indicateInterest`, 2 of 13 for
`fileDownload`. They may be one goal type in the current UI or four. They keep distinct labels until
someone who knows the builder says otherwise; calling them all "stage move" would misdescribe the
majority that move no stage.

### 28 sequences do nothing but were not counted as empty

A sequence whose only step is the `start` vertex has one step and does nothing. Section 11 counted
only `steps.length === 0`, so the account's dead-sequence figure was **365 when the true number is
393**.

Both of campaign 987's terminal branches are like this — and they are the two sequences a human
marked ready and published on the same afternoon.

### What the diagrams surfaced that the counts had not

**Campaign 987 routes contacts into two dead ends.** "Approved for Beta" and "Declined for Beta"
contain nothing. As two rows inside a count of 365 nobody noticed; as two boxes labelled `(empty)` it
is the first thing you see.

**Worse, its two goals are the same trigger.** "Approved" and "Declined" both wait on tag 1019,
`0 - 50 New Contacts` — a tag with nothing to do with beta approval. Approving and declining an
applicant do the same thing. That was in the normalised data all along; it became visible only when
the page named the tag each goal waits for rather than just the goal.

Neither is a rendering defect. Both are defects in a live campaign, found by looking at it.

### Pre-existing mojibake, deliberately not repaired

Five names in campaign 672 contain a stray `U+00C2` — the signature of a UTF-8 non-breaking space
decoded as Latin-1. It arrives that way from Keap.

Left alone on purpose. A mojibake-repair heuristic guesses at encoding damage, and `U+00C2` is a
legitimate character in other contexts; the risk of corrupting good text outweighs five cosmetic
occurrences. This is the `stripLongSuffix` lesson: a narrow correct fix beats a broad clever one.

### Legibility at the top end

The median campaign has 14 renderable nodes; the largest has 112 and 86 steps. Diagrams cover the
campaign level only — goals, decisions and sequences — so campaign 751 renders as 10 goals, 2
decisions and 14 sequence boxes rather than a hairball. Steps are linear by construction and read
better as an ordered list, which the page provides.
