# Tags and Form Fields Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The migration export carries every tag a campaign uses (with name and what it does with it), and every web form's fields and HTML.

**Architecture:** Two independent changes. (1) `src/export/campaignDoc.ts` gains a per-step `tags` list using the same direction rule the relationship graph uses, the export planner writes an account-level `tags.json`, and names come from the enrichment catalog plus decision-criteria labels. (2) The web form source, after finding a form in the REST list, fetches its public hosted page anonymously through the existing SSRF-guarded anonymous fetcher, saves it as `form.html`, and parses its fields.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), cheerio, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-21-content-export-design.md` (§9 export, §7.2 sources). Evidence: `docs/spike-findings.md` §18; the user asked for tags and form fields after reviewing the se232 export.

## Global Constraints

- **Read-only, and the Keap session never reaches the form page.** The public form page is fetched with `anonymousFetcher()` (`src/content/assets/download.ts`) — no cookies, DNS-checked, private addresses refused — and redirects are followed by the source itself, at most 5 hops, re-running `classifyUrl` (`src/content/assets/discover.ts`) on every `Location`.
- **Status is not evidence.** A page with no `<form>` is not a form: the record keeps `fieldsAvailable: false` and no `form.html` is written.
- **No test touches the network.** Fixtures: `test/fixtures/content/webform-page.html` (real FUNNEL form page, scrubbed) and `webform-page-error.html` ("Error 640", no form).
- Tag direction rule, verbatim from `src/normalize/graphEdges.ts` `tagEdges`: style `tag` with `config.isApply === 'true'` → apply; `'false'` → remove; style `tagApplied` → trigger; any other style carrying `tagIds` → `unspecified` (never guess a direction).
- Do not modify `src/normalize/*`. Import specifiers carry `.js`. `npm run typecheck` and `npm test` green at the end of each task (751 tests today). Never stage `.superpowers/` or `export/`.

---

### Task 1: Tags in the export

**Files:**
- Modify: `src/export/campaignDoc.ts`, `src/export/plan.ts`, `src/cli/export.ts`, `README.md` (Step 8 export tree + one line on `npm run enrich` for tag names)
- Test: `test/exportCampaignDoc.test.ts`, `test/exportPlan.test.ts`

**Interfaces:**
- Produces: `TagRef { id: string; name: string | null; action: 'apply' | 'remove' | 'trigger' | 'unspecified' }`; `StepDoc.tags: TagRef[]`; `DecisionDoc.tags: { id: string; name: string | null }[]`; `CampaignDocInput.tagName?: (id: string) => string | null`; `ExportInput.tagNames?: Map<string, string>`; a new `tags.json` at the export root.

- [ ] **Step 1: Failing tests in `test/exportCampaignDoc.test.ts`**
  - A `tag` step with `config.isApply: 'true'` and `references.tagIds: ['4153']` → `tags: [{ id: '4153', name: 'Two Tickets', action: 'apply' }]` when `tagName` returns `'Two Tickets'` for 4153.
  - `isApply: 'false'` → `action: 'remove'`; a `tag` step with no `isApply` → `unspecified`.
  - A `tagApplied` goal with `tagIds: ['1', '2']` → two entries with `action: 'trigger'`.
  - A `purchaseSuccess` goal carrying `tagIds: ['9']` → `action: 'unspecified'`.
  - `tagName` absent → `name: null`.
  - Every other step has `tags: []`.
  - A decision whose `branches[0].rules` contains a rule with `category: 'tags_FieldCategory'` and a value `{ id: '77', label: 'VIP' }` → `DecisionDoc.tags: [{ id: '77', name: 'VIP' }]`; when `tagName('77')` returns `'VIP Customer'`, the catalog name wins. Build the rules object with the `DecisionCriteria` shape from `src/parse/decisionHtml.ts` (`wrappers[].any[].all[]` with `category` and `values`) — read that file for the exact type.
  - Step and goal `name`s are entity-decoded: a goal named `TRIP 1: 2nd traveler&#39;s info` exports as `TRIP 1: 2nd traveler's info` (use `decodeEntities` from `src/render/text.ts`).
  - Existing expectations that `toEqual` whole step objects gain `tags: []`.

- [ ] **Step 2: Implement in `campaignDoc.ts`**
  - `tagsOf(node, tagName)`: map `node.references.tagIds` (deduplicated, order kept) with the direction rule above.
  - `stepDoc` adds `tags` and decodes `name`; `buildCampaignDoc` does the same for goals, steps, published-only steps, and sequence/decision names.
  - Decisions: walk `branches.find(b => b.rules !== null)?.rules` (once per decision — the same criteria object is shared by every branch) for rules with `category === 'tags_FieldCategory'`; name = `tagName(id) ?? value.label ?? null`; dedupe by id.

- [ ] **Step 3: Failing tests in `test/exportPlan.test.ts`**
  - With `tagNames: new Map([['4153', 'Two Tickets']])` and two campaigns — one applying tag 4153, one whose `tagApplied` goal triggers on 4153 — the plan writes `tags.json`:
    ```json
    [{ "id": "4153", "name": "Two Tickets",
       "appliedBy": ["1"], "removedBy": [], "triggers": ["2"], "testedBy": [], "otherUses": [] }]
    ```
    (funnel ids, sorted; `otherUses` collects `unspecified`; decisions go in `testedBy`). Sorted by numeric id.
  - Campaign docs in the plan carry the catalog name on their step tags.
  - `tagNames` absent → names `null`, `tags.json` still written.
  - `manifest.json` gains `tagCount`.

- [ ] **Step 4: Implement in `plan.ts`** — build `tagName` from `input.tagNames`, pass it to `buildCampaignDoc`, aggregate `tags.json` from the docs' step and decision tags, add `tagCount` to the manifest.

- [ ] **Step 5: CLI (`src/cli/export.ts`)** — load `artifacts/<app>/entities.json` if present (type `EntityCatalog` from `src/api/catalog.ts`; entity ids look like `tag:4153`, kind `tag`) into `tagNames`; also seed names from decision criteria with `tagLabels(normalizedCampaigns)` from `src/normalize/graphEdges.ts` for tags the catalog lacks (catalog wins). If the catalog is missing, print `  note: no entities.json — tag names come from decision labels only. Run:  npm run enrich -- --app <app>`. After writing, print `  tags: <n> (<m> named)`.

- [ ] **Step 6: README** — export tree gains `tags.json   every tag a campaign uses: name, and which campaigns apply, remove, trigger on or test it`; one line under Step 8 that tag names need `npm run enrich` first.

- [ ] **Step 7:** `npm run typecheck && npm test`; commit `feat: carry tags — ids, names and direction — into the migration export`.

---

### Task 2: Web form fields and HTML

**Files:**
- Modify: `src/content/sources/webform.ts`, `src/content/types.ts` (`FormField` gains `options?: string[]`)
- Test: `test/sourceWebform.test.ts`

**Interfaces:**
- Produces: `parseWebformPage(html): { fields: FormField[] } | null`; `WebformSourceDeps { fetchPage?: (url: string) => Promise<{ status: number; body: string; finalUrl: string }> }`; `createWebformSource(deps?)`.

- [ ] **Step 1: Failing tests — the parser**, against `test/fixtures/content/webform-page.html`:
  - Returns exactly these fields in page order, each `hidden: false`, `defaultValue: null`:
    | name | label | type | required |
    |---|---|---|---|
    | `inf_custom_2ndTravelersFIRSTNAME` | `2nd Traveler's FIRST NAME` | `text` | true |
    | `inf_custom_2ndTravelersLASTNAME` | `2nd Traveler's LAST NAME` | `text` | true |
    | `inf_custom_2ndTravelersEMAILADDRESS` | `2nd Traveler's EMAIL ADDRESS` | `text` | true |
    | `inf_custom_2ndTravelersBIRTHDATE` | `2nd Traveler's BIRTH DATE` | `text` | true |
    | `inf_custom_2ndTravelersCELLPHONENUMBER` | `2nd Traveler's CELL PHONE NUMBER` | `text` | true |
    | `inf_custom_2ndTravelersSHIPPINGADDRESS` | `2nd Traveler's SHIPPING ADDRESS` | `text` | true |
    | `inf_field_Email` | `Your Email with Example Co®` | `email` | true |
    Labels come from `<label for="<field id>">`, with the trailing `*` removed and entities decoded; `required` is true when the label ends with `*` or the field has a `required` attribute, else false.
  - Keap's plumbing and anti-spam inputs are excluded: `inf_form_xid`, `inf_form_name`, `infusionsoft_version`, `inf-sbt`, and the randomly named honeypot (`inf_qhcSMNC9AnJYJcEz`). Rule: keep only names matching `/^inf_(field|custom|option|other)_/`.
  - Inline HTML cases: a `<select name="inf_field_State">` with options `CA`, `NY` (and a blank "Please select" option) → `type: 'select'`, `options: ['CA', 'NY']`; radio inputs sharing `name="inf_option_Size"` with values `S`, `M` → ONE field, `type: 'radio'`, `options: ['S', 'M']`; a `<input type="hidden" name="inf_field_LeadSource" value="Webinar">` → `hidden: true`, `defaultValue: 'Webinar'`, label null; a `<textarea name="inf_custom_Notes">` → `type: 'textarea'`; a checkbox `inf_option_Consent` → `type: 'checkbox'`.
  - `webform-page-error.html` → `null`.

- [ ] **Step 2: Implement `parseWebformPage`** with cheerio: first `<form>`; collect `input, select, textarea` in document order; group radio/checkbox by name; label lookup by `for` = field id; decode with `decodeEntities`; `type` = tag name for select/textarea, else the `type` attribute (default `text`).

- [ ] **Step 3: Failing tests — the source**, with an injected `fetchPage`:
  - Fetching form `5` from the list fixture calls `fetchPage` with that entry's `webform_url`; the page fixture yields `fieldsAvailable: true`, the seven fields, and `files: [{ name: 'form.html', body: <page> }]`; evidence still includes `webform.json` and now also `page.html` (the raw page).
  - A page with no form → `fieldsAvailable: false`, `fields: []`, no `form.html`, and the record gains `pageError: 'no form on the public page'`.
  - `fetchPage` rejecting → still returns the list metadata with `fieldsAvailable: false` and `pageError: <message>` (a form page failing must not lose the form).
  - `webform_url` null → no fetch, `fieldsAvailable: false`, `pageError: 'no public URL'`.
  - `validate` unchanged in spirit (evidence `webform.json` with an id).

- [ ] **Step 4: Implement** — `createWebformSource(deps = {})`; default `fetchPage` built from `anonymousFetcher()`: loop ≤ 5 hops; on 3xx resolve `location` with `classifyUrl(location, currentUrl)` and throw on a skip reason; on 2xx return the body; otherwise throw `HTTP <status>`. Add `pageError?: string` to `FormContent` in types.ts. Keep `ContentNotFoundError`/not-listed behaviour exactly as today. `SOURCES` in `src/content/sources/index.ts` keeps calling `createWebformSource()` with no arguments.

- [ ] **Step 5: README** — the "What is read today" web form line: fields and HTML from the form's public page where Keap serves one.

- [ ] **Step 6:** `npm run typecheck && npm test`; commit `feat: read web form fields and HTML from the public form page`.

---

### After both tasks (with the user)

`npm run fetch-content -- --app se232 --kinds form --force` (key terminal), then `npm run export -- --app se232`; check campaign 2939's `forms/303/form.json` and `form.html`, and a tag goal's `tags` in its `campaign.json`.
