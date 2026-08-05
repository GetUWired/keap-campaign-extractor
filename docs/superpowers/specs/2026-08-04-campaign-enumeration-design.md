# Campaign Enumeration — Design

Date: 2026-08-04
Status: approved, ready for implementation planning
Builds on: `2026-08-04-multi-app-support-design.md`
Evidence: observed against `jordan.infusionsoft.com`, app build `1.70.0.989251-sysarch-202608031100`

## 1. Context

The extractor can pull any campaign whose `funnelId` is already known. It has no way to discover
which ids exist, so a bulk run is impossible. Every campaign extracted so far came from an id the
original handoff happened to record.

The Automations list is a legacy JSP report:

```
GET /Reports/searchTemplate.jsp?reportClass=SetupFunnel&view=resultsPage
```

**Pagination and page size are POST**, submitted as form data (`perPage`, `currentPage`, `pageSet`,
`action`, `reportClass`, `skin`, `reportStateId`) to `searchTemplate.jsp?view=gridGuts`. The
read-only guard blocks every non-GET request, so driving the report the way the UI does is not
available to us.

**Verified workaround:** `perPage` is also honoured as a GET query parameter.

| Request | Rows returned | `numberOfRecords` | `perPage` echoed |
|---|---|---|---|
| `?reportClass=SetupFunnel&view=resultsPage` | 50 | 170 | 50 |
| `…&perPage=500` | **170** | 170 | 500 |

One read-only request returns the whole list. The server mints a `reportStateId` itself, so none
needs to be supplied.

## 2. Goal

Produce, for a given app, the complete list of campaigns with every field the list page exposes,
using only GET requests.

## 3. Non-goals

- Extracting campaign structure. Enumeration feeds the bulk extractor; it does not invoke it.
- Pagination. A single `perPage` request must cover the account, and a short read is an error rather
  than something to work around (see §7).
- Parsing or normalising dates. See §6.
- The `exportResults.jsp` export endpoint. It is a GET and may return cleaner structured data, but
  the format is unobserved and it is a file download. Not worth a second unknown when the list page
  is already understood.

## 4. Two defects in shipped code, fixed as part of this

### 4.1 The read-only guard does not cover `/Reports/`

`WRITE_URL_PATTERN` applies only under `/app/`, and is matched against the pathname only. Both
choices were deliberate and remain correct in isolation — the `/app/` scope avoids aborting static
assets, and skipping the query string avoids false-positiving on campaign names like "Save for
later". Together they leave this **allowed**:

```
GET /Reports/reportActions.jsp?actionName=Unpublish+and+Delete+Automations&reportClass=SetupFunnel
```

That URL is in the Actions menu of the very page this feature scrapes. We would never construct it,
but a guard exists precisely so that "we would never" is not the control.

**Fix:** apply the denylist to *all* paths, exempting a static-asset prefix allowlist
(`/resources/`, `/css/`, `/js/`, `/images/`, `/slices/`, `/files/`), and add `reportActions` and
`unpublish` to the pattern. Query strings stay out of scope, so the campaign-name false positive
stays fixed.

### 4.2 Not every app is `<name>.infusionsoft.com`

The account menu exposes three distinct URL shapes across linked apps:

- `https://sp218.infusionsoft.com` — subdomain, what `baseUrlFor` assumes
- `https://app.infusionsoft.com?app_id=ro474`
- `https://keap.app?app_id=qw806`

`baseUrlFor` would build an unresolvable URL for the latter two. This is not fixed here — it needs a
real app of each shape to verify against, and `KEAP_BASE_URL` already provides an escape hatch. It
is recorded in the findings so it is not discovered mid-migration on a client account.

## 5. Architecture

### 5.1 `src/parse/campaignList.ts` — pure

```ts
export interface CampaignSummary {
  funnelId: string;
  name: string;
  categories: string[];
  activeContacts: number | null;
  publishedDate: string | null;
  publishedBy: string | null;
  published: boolean;
}

export interface CampaignList {
  total: number | null;
  perPage: number | null;
  reportStateId: string | null;
  campaigns: CampaignSummary[];
  warnings: string[];
}

export function parseCampaignList(html: string): CampaignList;
```

**Rows are anchored on the editor link**, `a[href*="funnelEditor?funnelId="]` — it yields both id and
name, and it is the same URL the extractor already uses, so a row without one is not extractable
anyway.

**Cells are read by column name, not position.** The header row exposes `Id`, `Name`, `Categories`,
`Active Contacts`, `Published Date`, `Published By` inside `span.header-sort-name`. The parser builds
a name→index map and reads through it. Reading by fixed position would silently shift every field if
Keap adds or reorders a column — the same class of failure that made the decision parser return
confident, empty results.

A missing expected column is a warning naming the column, not a crash.

### 5.2 `src/extract/campaigns.ts`

```ts
export function campaignListUrl(baseUrl: string, perPage?: number): string;
export function fetchCampaignList(
  context: BrowserContext,
  baseUrl: string,
  perPage?: number,
): Promise<CampaignList>;
```

`perPage` defaults to 500. GET only, through `safeGet`.

### 5.3 `src/cli/enumerate.ts`

```bash
npm run enumerate -- --app jordan
```

Writes `artifacts/<app>/campaigns.json` and prints a summary: total, published vs never-published
counts, and category tallies.

## 6. Dates stay raw

`publishedDate` is stored exactly as rendered — `11/10/2020 8:31 AM`. The page itself tooltips
"The timezone used is: (GMT -07:00) Phoenix", and the handoff already caught Keap serving
timezone-shifted values once (§4.2, a consistent +3h discrepancy on timer fields, still unresolved).

`published` is derived from *presence* of a date, which needs no parsing and is the signal that
actually matters: it separates live campaigns from drafts. Campaign 999 "Untitled automation" has no
date; campaign 987 has one.

## 7. Error handling

| Condition | Behaviour |
|---|---|
| `--app` missing or invalid | Same validation as the extractor: usage or `Invalid app name`, no browser launched. |
| No session for the app | `Run: npm run login -- --app <app>` |
| Session expired | Detected by login-URL match, as today. |
| `rows < total` | **Fail.** A truncated list silently produces an incomplete bulk run. The error names both numbers and suggests a higher `perPage` — the page's own tooltip references a 1000-per-page mode. |
| `total` absent from the page | Warn and proceed with whatever parsed. Missing evidence is weaker than contradictory evidence. |
| Zero rows parsed | Fail, naming the response size, since a valid account with campaigns should never return none. |
| An expected column is absent | Warn naming the column; that field is null for every row. |

## 8. Testing

Offline, against a committed fixture of the real list page:

- 170 campaigns parsed, `total` 170.
- Campaign 987 has name "WooConnection Beta Tester Application", category "WooConnection",
  `publishedDate` "11/10/2020 8:31 AM", `publishedBy` "Amy Anton", `published` true.
- Campaign 999 "Untitled automation" has no category, no date, `published` false.
- Column reordering: with `Name` and `Categories` swapped in the header and cells, fields still land
  correctly — proving name-based lookup rather than positional.
- A removed column produces a warning naming it rather than an exception.
- Guard: `/Reports/reportActions.jsp?actionName=Unpublish+and+Delete+Automations` is denied;
  `/resources/funnel/images/template-icon.svg` is still allowed; a decision-editor URL whose
  `title` contains "save" is still allowed.

Then one live run against `jordan`, expecting 170.

## 9. Success criteria

1. `npm run enumerate -- --app jordan` writes `artifacts/jordan/campaigns.json` with 170 campaigns.
2. The reported total matches the page's `numberOfRecords`.
3. Published and never-published campaigns are distinguished.
4. `/Reports/reportActions.jsp?...Delete...` is denied by the guard, with a test.
5. Zero non-GET requests reach the network.
6. The full suite passes offline.
