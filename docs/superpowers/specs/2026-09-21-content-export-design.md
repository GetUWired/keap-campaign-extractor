# Campaign Content Export — Design

Date: 2026-09-21
Status: approved, ready for implementation planning (phase 0 spike first)
Builds on: `2026-08-06-normaliser-design.md`, `2026-08-06-enrichment-design.md`
Evidence: `docs/spike-findings.md`, handoff §4.4

## 1. Context

The extractor captures campaign **structure** and nothing a contact actually receives. Handoff §4.4:
emails store only `marketingEmailId` — "no subject, no body". The same holds for landing pages,
forms, SMS, Apply Note templates and HTTP steps: the campaign XML carries an id and the content
lives elsewhere in Keap.

Some content is already on disk. Task steps carry their full payload inline (`taskTitle`,
`taskBody`, `taskType`, priority, due, assignment), and canvas notes keep their text in
`config.notes`.

The goal is a migration: the account's campaigns rebuilt on a platform not yet chosen. So the
output must be complete, self-contained, and neutral — not shaped for any one importer.

## 2. Goal

Fetch every piece of content every campaign references, with every asset that content depends on,
and write it as a neutral, per-campaign package that survives the Keap account being closed.

## 3. Scope

| Priority | Content |
|---|---|
| Must have | Emails — from, reply-to, to, cc, bcc, subject, preview text, HTML body, plain-text body, attachments |
| Must have | Landing page HTML |
| Must have | SMS messages |
| In scope | Web forms — fields, hidden fields, thank-you/redirect behaviour, form HTML where available |
| In scope | Apply Note templates |
| In scope | HTTP Post / HTTP Request steps |
| In scope | Tasks and canvas notes (already on disk — no fetch needed) |
| Deferred | Action sets, fax, voice broadcast, letters |

**Every campaign in `campaigns.json`**, including drafts and inactive ones. Content steps from both
the draft and the published version.

## 4. Non-goals

- **Contact data of any kind.** The enrichment spec's rule stands. Sent-email history (`/emails`)
  stays refused; only content templates are read.
- Shaping output for a specific destination platform, or translating merge fields to another
  platform's syntax.
- Rewriting HTML to point at re-hosted assets. The asset map makes that the migration tool's job.
- Writing anything to Keap. Every request is a GET through an existing guard.

## 5. Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Pipeline shape | Two stages: `fetch-content` (network) then `export` (offline) | Matches `extract-all` / `normalize`. The slow step runs once and resumes; the format can change and re-run in seconds; raw responses remain as evidence. |
| Source per content kind | Chosen per kind by the phase 0 spike — REST or editor GET | The standing rule: use the API for what it can answer, scrape only for depth it cannot. Every endpoint here has been settled by running it, never by assuming. |
| Package layout | One folder per campaign holding everything it uses | The user's call. Templates are rarely shared, and a self-contained folder is what gets handed to whoever rebuilds that campaign. |
| Shared content | Fetched once, copied into each campaign that uses it, marked `sharedWith` | Dedupe where it costs requests, duplicate where it costs only disk. `sharedWith` stops the same template being migrated twice unknowingly. |
| Assets | Download everything, including third-party images | A migration must not depend on the source account staying open. |
| Original HTML | Never modified | Neutral output. The asset map lets any tool rewrite URLs to wherever it re-hosts. |
| Merge fields | Kept in Keap syntax; one account-wide inventory | One list for someone to map, rather than a guessed translation. |
| Secrets | Redacted in the export by default; raw store unredacted | `artifacts/` is local and gitignored; the export is built to be handed on. |

## 6. Phase 0 — discovery spike

The design above is fixed; which **source** each kind uses is not. Before implementation, a spike
against one account settles, for each kind:

1. **Emails via REST.** Does `GET /crm/rest/v2/emails/templates/{id}` (already allowlisted) return
   HTML body, plain text, cc/bcc, and attachments? Test a legacy `email` and a `bardEmail` id.
   Handoff notes that some named email steps disagreed with the record at their
   `marketingEmailId` — confirm which id space each builder uses.
2. **Editor endpoints** for whatever REST cannot serve: open each kind in a headed session and
   capture the GET that populates the editor — legacy email, bard email, landing page (legacy and
   `unlayerLandingPageId`), web form / smart form, SMS (`marketingAutomatedSmsId`,
   `automationMessageId`), Apply Note (`marketingNoteId`), HTTP Post / Request
   (`httpRequestConfigId`).
3. **Attachments.** Where they are listed, and the GET that downloads one.
4. **Content validation.** For each endpoint, what a genuine response contains versus an empty
   shell. The decision editor returned HTTP 200 with a 75-byte shell; status alone is not evidence.
5. **Read-only guard.** Every captured request is a GET, and none trips `guard/readonly.ts`.

Output: a findings section in `docs/spike-findings.md` and scrubbed fixtures per kind in
`test/fixtures/content/`. Any kind with no viable read-only source is recorded as such and dropped
from phase 1, not worked around.

The user runs `npm run login` for the spike account; the tool never handles credentials.

## 7. Stage 1 — `fetch-content`

```bash
npm run fetch-content -- --app se232
```

### 7.1 Input

The normalised campaigns — `normalize` must have run, and the command says so if it has not. From
every node in both draft and published trees it lifts content ids:

| Kind | Attributes |
|---|---|
| email | `marketingEmailId` on `email` and `bardEmail` nodes |
| landingPage | `landingPageId`, `unlayerLandingPageId` |
| form | `webformId`, `smartFormInstanceId`, `internalFormId` |
| sms | `marketingAutomatedSmsId`, `automationMessageId` |
| note | `marketingNoteId` |
| http | `httpRequestConfigId` |

These are already in `FK_ATTRIBUTES`, read through `referenceValues` so scalar and array forms are
both seen. The result is one queue of `(kind, id)` with duplicates removed.

### 7.2 Sources

One module per kind in `src/content/sources/`, each with the same contract:

```ts
interface ContentSource {
  kind: ContentKind;
  fetch(id: string, ctx: FetchContext): Promise<RawContent>;
  validate(raw: RawContent): ValidationResult;   // content-based, not status-based
}

interface RawContent {
  files: { name: string; body: string | Buffer; contentType: string }[];
  assetUrls: string[];
  attachments: AttachmentRef[];
}
```

REST sources go through `src/api/guard.ts`; editor sources through the browser read-only guard.
Each new path is added to its guard deliberately, one at a time, with a comment saying what it
serves — the allowlist's friction is the feature.

### 7.3 Validation and failure

A response that fails its source's `validate` is retried once, then recorded `failed` with the
reason. It is never written as a success. A 404 is `notFound` — a step pointing at a deleted
template is a finding, not an error.

### 7.4 Progress and resume

`artifacts/<app>/content-progress.json`, written after every item: `done`, `failed` or `notFound`,
with reason. A re-run skips `done` items. Session expiry stops the run cleanly with the
`npm run login` message; nothing partial is written for the item in flight.

Raw output: `artifacts/<app>/content/raw/<kind>/<id>/`.

### 7.5 Credential check

If any selected kind uses a REST source and `KEAP_API_KEY` is unset, the run stops before its first
request and names the kinds that need it. It does not silently skip them.

### 7.6 Flags

| Flag | Meaning |
|---|---|
| `--kinds email,sms` | Fetch only these kinds. |
| `--funnel <id>` | Fetch content for one campaign. |
| `--force` | Re-fetch items already `done`. |
| `--limit <n>` | Stop after n items. |
| `--delay <ms>` | Pause between items, default 250. |
| `--headed` | Show the browser. |

### 7.7 Summary

At the end, per kind: fetched, failed, not found; and assets downloaded, failed, skipped.

## 8. Assets

### 8.1 Discovery

Scanned from each fetched item:

- `<img src>` and `srcset`
- `url(...)` in inline `style` attributes and `<style>` blocks
- `<link rel="stylesheet">`, and `url(...)` inside those stylesheets — followed one level, for fonts
  and background images
- `<a href>` **only** when it points at Keap file hosting (file box downloads). Other links are
  recorded as links, never followed.
- Attachments from the item's own metadata

Recorded but not downloaded, with a reason: URLs containing a merge field (`~Contact.Id~`), and
tracking pixels.

### 8.2 Download

During `fetch-content`, immediately after the owning item, so resume covers assets too. Stored once
by content hash at `artifacts/<app>/content/assets/<sha256>.<ext>`, with an index from original URL
to hash.

- **Keap-hosted URLs** are fetched with the session — file box downloads may require it.
- **Everything else** is an anonymous GET with no cookies and no API key. The Keap login never
  reaches a third-party host.
- Limits: 25 MB per file, 30 s timeout. Content type as served.

### 8.3 Failure

Never fatal to the owning item. Each asset carries a status: `downloaded`, `failed` (with HTTP
status), `tooLarge`, or `skipped` (with reason).

## 9. Stage 2 — `export`

```bash
npm run export -- --app se232
```

No network. Reads the normalised campaigns, the raw content store, and `campaigns.json`.

### 9.1 Layout

```
export/<app>/
  manifest.json                 account, exported-at, format version, counts, campaign list,
                                secretsIncluded
  merge-fields.json             every merge field across the account, with counts and usage
  campaigns/<funnelId>-<slug>/
    campaign.json               the campaign as a neutral flow
    emails/<id>/
      email.json                from, replyTo, to, cc, bcc, subject, previewText, attachments,
                                assets, mergeFields, usedBy, sharedWith
      body.html                 original HTML, unmodified
      body.txt                  Keap's plain text if it has one, otherwise derived from the HTML
      attachments/<file>
    landing-pages/<id>/         page.json, page.html
    forms/<id>/                 form.json, form.html (where available)
    sms/<id>.json               text, sender, mergeFields, usedBy, sharedWith
    notes/<id>.json             type, subject, body, usedBy, sharedWith
    http/<id>.json              url, method, headers, fields, redacted
    assets/
      <sha256>.<ext>
      assets.json               original URL → local file, content type, size, status, usedBy
```

`<slug>` is the campaign name lowercased, non-alphanumerics collapsed to `-`, truncated to 60
characters. The funnel id prefix keeps it unique.

### 9.2 `campaign.json`

A neutral view of the flow, derived from the normalised campaign:

- name, id, status (live now / ever published, from `campaigns.json`), categories
- goals, with their trigger and any content reference
- sequences, each with steps in order — timers, emails, tag changes, tasks, SMS, notes, HTTP
- decisions, with their rules and branch targets
- tasks and canvas notes **inline in full**, since they belong to this campaign alone
- content steps point at local folders: `{ "type": "email", "ref": "emails/2048" }`
- each step marked `draft`, `published` or `both`
- `mergeFields`: the merge fields this campaign's content uses

### 9.3 Shared content

Copied into every campaign that references it. `sharedWith` lists the other campaigns by id and
name. Assets are copied per campaign likewise.

### 9.4 Missing content

A step whose content is `failed` or `notFound` still appears in `campaign.json`, with
`"content": { "status": "notFound" }` in place of a `ref`. The manifest counts them. A migrator
must see the gap, not a silently shorter campaign.

## 10. Secrets

- The raw store is unredacted. `artifacts/` is gitignored and local.
- The export redacts, in `http/<id>.json`, to `"«redacted»"`:
  - `Authorization`, `Cookie`, `X-Api-Key`-style headers
  - any header, query parameter or form field whose name matches
    `/key|token|secret|password|passwd|auth|signature|sig$/i`
  - userinfo in the URL (`user:pass@`)
- Merge fields are never redacted.
- Each file lists what was removed as `redacted: [{ location, name }]`, so the credential can be
  re-entered on the new platform.
- `--include-secrets` keeps the values, prints a warning, and sets `secretsIncluded: true` in the
  manifest.
- `export/` is added to `.gitignore` — it holds client content.

## 11. Testing

Offline vitest against real, scrubbed fixtures from phase 0.

| Area | Covers |
|---|---|
| Source parsers and validators | One per kind, including a rejected empty-shell response |
| Id collection | Scalar and array forms; draft-only and published-only steps; dedupe |
| Asset discovery | `srcset`, CSS `url()`, stylesheet one level deep, merge-field URLs, file box versus ordinary links |
| Asset download | Cookies sent to Keap hosts only; size limit; failure statuses |
| Redaction | Headers, params, fields, URL userinfo; merge fields untouched; `redacted` list |
| Resume | Interrupted queue resumes; `failed` and `notFound` recorded |
| Export | A small fixture account → full folder structure, including a template shared by two campaigns with `sharedWith` set on both, and a `notFound` step |

Network code stays thin and is exercised through a fake fetcher. Final check: a live
`--limit 5` run against a real account, spot-checked by hand before the work is called done.

## 12. Open until phase 0

- Which kinds REST can serve, and which need the editor.
- Whether `bardEmail` content is reachable read-only at all.
- Whether form HTML is obtainable, or only field definitions.
- Where attachments are listed, and their download URL.
- Throughput: the request count for a full account, and whether `--delay` needs a higher default.
