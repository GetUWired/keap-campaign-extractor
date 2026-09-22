# Keap Campaign Extractor

Reads a Keap account's campaigns and answers questions about them that the Keap UI cannot —
starting with "which campaigns break if we delete these tags?"

**It never writes to Keap.** Every run is read-only, enforced at the browser driver rather than by
convention: 95 write attempts made by Keap's own campaign builder were blocked across two accounts
during ordinary read-only runs. See [The read-only guard](#the-read-only-guard).

---

## Contents

- [Before you start](#before-you-start)
- [The short version](#the-short-version)
- [Step 1 — Log in](#step-1--log-in)
- [Step 2 — List the campaigns](#step-2--list-the-campaigns)
- [Step 3 — Extract them](#step-3--extract-them)
- [Step 4 — Normalize](#step-4--normalize)
- [Step 5 — Resolve names (optional)](#step-5--resolve-names-optional)
- [Step 6 — Readable pages (optional)](#step-6--readable-pages-optional)
- [Step 7 — Tag impact analysis](#step-7--tag-impact-analysis)
- [Broken references](#broken-references)
- [Step 8 — Export campaign content (migration)](#step-8--export-campaign-content-migration)
- [Where everything lands](#where-everything-lands)
- [Handing the report to someone](#handing-the-report-to-someone)
- [Safety](#safety)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

---

## Before you start

- **Node 20 or newer.** Check with `node --version`.
- **A Keap login** for the account you are reading, with campaign-builder access.
- **The app name** — the subdomain. For `https://se232.infusionsoft.com` the app name is `se232`.
  Every command takes it as `--app`.

Install once:

```bash
npm install
```

```bash
npx playwright install chromium
```

The second command fetches the browser the extractor drives. It is a no-op if you already have it.

---

## The short version

For an account you have never touched, run these in order. Steps 1–4 are required; 5 and 6 are
optional; 7 is the thing you probably came for.

```bash
npm run login       -- --app se232
npm run enumerate   -- --app se232
npm run extract-all -- --app se232
npm run normalize   -- --app se232
npm run tag-impact  -- --app se232 --tags ./tags.csv
```

Each step reads what the previous step wrote, so they must run in that order the first time. After
that you can re-run any step on its own. If you skip one, the next tells you which command to run.

Expect **20–40 minutes** for `extract-all` on a 400-campaign account. Everything after it is a pure
function over files on disk and takes seconds.

---

## Step 1 — Log in

```bash
npm run login -- --app se232
```

A real Chrome window opens on the account. **You log in yourself** — type your own password, complete
MFA, land on the dashboard — then press Enter in the terminal. The tool never sees or handles your
credentials.

It saves the session cookies to `.sessions/se232.json` with permissions `600`. That directory is
gitignored and must stay that way: the file is a live login to a client account.

Sessions expire. When a later step fails with an auth error, run this again.

One session per app. Logging into `se232` does not give you `jordan`.

---

## Step 2 — List the campaigns

```bash
npm run enumerate -- --app se232
```

Reads the campaign list page and writes `artifacts/se232/campaigns.json` — every campaign's id, name,
categories, active contact count, published date and publisher.

| Flag | Meaning |
|---|---|
| `--per-page <n>` | Page size, default 500. Raise it if the run reports a truncated list. |
| `--headed` | Show the browser instead of running it hidden. Useful when something looks wrong. |

**This file matters later.** It is the only source for whether a campaign is *live now*, as opposed
to *ever published* — the two disagree about 125 of se232's 398 campaigns. Without it, tag impact
reports every status as `unknown`.

---

## Step 3 — Extract them

```bash
npm run extract-all -- --app se232
```

Walks the list from step 2 and pulls each campaign's structure: `draft.xml`, `publish.xml`, a
`meta.json`, and one file per decision node holding its branching rules.

This is the slow step and the only one that touches the network in bulk. It is resumable — progress
is written to `artifacts/se232/progress.json` after every campaign, so a run interrupted at campaign
300 of 398 picks up at 301.

| Flag | Meaning |
|---|---|
| `--force` | Re-extract campaigns already done, instead of skipping them. |
| `--limit <n>` | Stop after n campaigns. Good for a first look at an unfamiliar account. |
| `--delay <ms>` | Pause between campaigns, default 250. Raise it if Keap starts throttling. |
| `--headed` | Show the browser. |

Try a small slice first on a new account:

```bash
npm run extract-all -- --app se232 --limit 5
```

---

## Step 4 — Normalize

```bash
npm run normalize -- --app se232
```

Turns the raw XML into structured JSON — one file per campaign in `artifacts/se232/normalized/` —
and builds the account relationship graph at `artifacts/se232/graph.json`: which campaigns apply
which tags, which listen for them, which decisions route on them, which emails and forms are shared.

No network. Re-runnable at any time.

It prints a findings summary — unreachable campaigns, tags applied by nobody, tags nobody listens
for, shared emails, broken references. Those are leads, not verdicts.

`--funnel <id>` normalizes a single campaign while you are iterating. The graph is skipped in that
mode, because a one-campaign graph would be misleading.

---

## Step 5 — Resolve names (optional)

```bash
KEAP_API_KEY=… npm run enrich -- --app se232
```

The campaign XML refers to tags, products, forms and users by numeric id. This fetches their names
through Keap's REST API into `artifacts/se232/entities.json`, so reports can say
*"Trip Completed"* instead of *"tag 11454"*.

You need a Keap **Service Account Key** or Personal Access Token, which you create in the Keap admin
UI and pass as an environment variable. It is never written to disk by this tool and never appears in
its error messages.

Skip this and everything still works — tag names come from your own tag list, and 57% of tag steps
already name their tag from the campaign data itself.

The API access is **allowlisted, not denylisted**, because the key is admin-scoped. Only tags,
products, users, forms, webforms, `emails/templates` and `account/profile` are reachable. Anything
else is refused before a request is made. Notably `/emails` — sent-email history, i.e. who received
what — is refused, while `/emails/templates` is permitted.

---

## Step 6 — Readable pages (optional)

```bash
npm run render -- --app se232
```

Writes one Markdown page per campaign to `artifacts/se232/rendered/`, each with a Mermaid diagram of
the campaign and plain-English descriptions of every goal, sequence and decision, plus an
`index.md` listing them all.

Useful for reading a single campaign closely. Not needed for tag impact.

`--funnel <id>` renders one campaign.

---

## Step 7 — Tag impact analysis

**The question this answers:** we intend to delete or merge these tags — which campaigns does that
touch, and where exactly?

### 7a. Write the tag list

CSV (detected by the `.csv` extension):

```csv
id,name,group
13269,Nurture Emails,
14799,Old Newsletter,newsletter
14821,Newsletter 2023,newsletter
```

- **`id`** — required. Rows without one are skipped with a warning.
- **`name`** — optional but worth including; it is what appears in the report.
- **`group`** — **empty means delete outright.** A value means "merge these into one", and every tag
  sharing that value is one merge group. Omit the column entirely for a pure delete list.

Quoting is handled properly, which matters because real tag names contain commas —
`"List: Minus TSP, Essence, 2024 trip purchased"` is one row, not three columns.

JSON works too (`.json` extension):

```json
{
  "delete": [{ "id": "13269", "name": "Nurture Emails" }],
  "combine": [
    { "group": "newsletter", "tags": [
      { "id": "14799", "name": "Old Newsletter" },
      { "id": "14821", "name": "Newsletter 2023" }
    ]}
  ]
}
```

**A tag export works as-is.** If your file lists the whole account with `Delete` and `Merge` boolean
columns — the shape Keap exports — pass it straight in. Only rows flagged `TRUE` in one of them are
requested: `Delete` means delete outright, `Merge` means combine. `tag_id` and `tag_name` are
accepted as the id and name columns.

> The one thing booleans cannot say is *what* each tag merges into. Without a `group` column the
> report can still show every merge location, but it cannot flag a campaign that references two tags
> destined to become one — it says so in a warning. Add a `group` column naming each merge target
> when you want that.

### 7b. Or audit every tag in the account

To ask "where is each of our tags used?" rather than "what does this change break", skip the list
entirely:

```bash
npm run tag-impact -- --app se232 --all-tags
```

This reads the account's own tag inventory from `artifacts/<app>/entities.json`, so it needs
[step 5](#step-5--resolve-names-optional) to have run. No tag carries a planned change, so the report
switches to **audit** wording — *tag usage*, *campaigns using tags* — and the delete/merge badges and
filter disappear rather than implying an intent you do not have.

`--all-tags` and `--tags` are alternatives; passing both is refused.

It also reports how many tags campaigns reference that the account no longer has — deleted tags whose
campaign steps remain. On se232 that is **275**.

### 7c. Run it


```bash
npm run tag-impact -- --app se232 --tags ./tags.csv
```

If you are also deleting campaigns, pass that list too — see
[7c](#7d-campaigns-you-are-also-deleting).

Output:

```
[se232] 3518 tags requested
  referenced by a campaign: 634
  no campaign references:   2884
  campaigns affected:       229 of 398
    by status: 94 live, 99 stopped, 36 never-published
  locations: 1576 — 433 trigger, 519 decision, 624 step
```

It writes three files to `artifacts/se232/`:

| File | For |
|---|---|
| `tag-impact.html` | **The one to share.** Filterable, searchable, self-contained. |
| `tag-impact.md` | Same content as a document — good for pasting into a ticket. |
| `tag-impact.json` | The data, for anything else you want to build. |

### 7d. Campaigns you are also deleting

A campaign that is itself being deleted does not need its broken triggers investigated. Pass the list
and the report separates the two:

```bash
npm run tag-impact -- --app se232 --tags ./tags.csv --deleting ./campaigns-to-delete.csv
```

```csv
id,name
11307,Cruises Abandon Cart
12787,Old Welcome Series
```

`id` is required; `campaign_id`, `campaignId`, `funnel_id` and `funnelId` all work as the column
name, so a Keap export needs no editing. `name` is optional. JSON works too — either
`{"delete": [{"id": "11307"}]}` or a bare `["11307", "12787"]`.

**A working spreadsheet works as-is too.** If the file lists every campaign and flags a subset in a
`Delete` or `Delete?` column, only the flagged rows count:

```csv
Id,Name,Categories,Active Contacts,Delete?,Notes
11307,Cruises Abandon Cart,,0,TRUE,superseded
12929,Pre-Trip Concierge,,174,FALSE,
```

`TRUE`, `yes`, `y`, `x` and `1` all read as flagged; blank and `FALSE` do not. If the column exists
but nothing is flagged, the run says so rather than reporting no planned deletions.

The run then reports both numbers:

```
campaigns affected:       229 of 398
  41 campaigns on the deletion list; 40 of them are affected
  still affected once those are deleted: 189
```

Those campaigns are **marked and filterable, not hidden** — struck through, tagged *campaign being
deleted*, and excluded with one click via the **Campaign plan** filter. Deletion is a plan; until it
happens the report should still agree with the account as it stands.

An id on the list that is not in the account is reported as a warning rather than quietly matching
nothing, because it is nearly always a typo.

### 7e. Read the HTML

Open `artifacts/se232/tag-impact.html` in any browser — double-click it, no server needed.

- **The numbers across the top** lead with how many affected campaigns are **live** and how many
  contacts are inside them. That is the figure to weigh a deletion against — not the campaign count.
The filters are separate labelled groups, and each narrows something different:

- **Campaign status** — live / stopped / never published.
- **Tag used as** — where the tag appears: trigger, decision, or sequence step.
- **Tag change** — whether the tag is being deleted or merged. Only shown when the list has both.
- **Campaign plan** — being deleted / keeping. Only shown when you passed `--deleting`.

**Reset filters** appears once anything is narrowed.
- **Search** matches campaign names, tag names, sequence names and ids. Press `/` to jump to it.
- **`tag:13269`** matches that tag exactly. Plain `13269` also matches tag 17390 and friends, because
  ids substring-match.
- **By tag** ranks tags by how many *live* campaigns they touch, and links through to them.
- **No campaign references** lists every requested tag no campaign uses, with its delete/merge
  marking. It carries its own caveat, because it is the tab most likely to be read as a
  green light: not used by a campaign is not the same as not used.

Each affected campaign expands to show every location, grouped by kind:

> **Trigger** — goal "Mother's Day Cruise 2026" starts this campaign when `22527` … `DELETE`
> **Decision** — the decision after "Any purchase" (cell 1349) routes on `11454` … `MERGE`
> **Sequence** — "Onboarding" step 2 applies `13269` … `DELETE`

The badge on each line says what is happening to that tag — deleted outright, or merged into
another. Where a list has several merge groups, the badge names the target group.

### What it will not tell you

**This analysis sees campaign usage only.** Tags are also used in saved searches, broadcasts, manual
application, internal forms and integrations, none of which is visible to this tool.

So a tag reported as having **no campaign references is not thereby unused** — the report says
exactly that, and the word "safe" appears nowhere in it by design. This tool narrows what you have to
check by hand; it does not replace the checking, and it does not recommend deletions.

It also does not perform deletions or merges. It has no write access to Keap at all.

---

## Broken references

**The question this answers:** what is *already* broken — campaign steps, goals and decisions
pointing at tags, products and forms the account no longer has? Keap deletes the entity and leaves
the reference behind.

```bash
npm run broken-refs -- --app se232
```

Needs [step 5](#step-5--resolve-names-optional) and then [step 4](#step-4--normalize) again, in that
order: the comparison is against the account's entity catalog, and the graph has to be rebuilt with
it present. Without it the report says **nothing could be checked** rather than reporting a clean
account — the two look identical from the outside and only one is good news.

It writes `broken-refs.json`, `.md` and `.html` beside the tag impact reports.

Two distinctions it draws, both load-bearing:

- **Ready vs never built.** A missing entity referenced by a step someone marked *ready* is
  breakage. One referenced only by unready steps is a half-built campaign. On se232 that is 229
  against 86 — collapsing them would turn 86 drafts into 86 emergencies.
- **Campaigns with no working way in.** Where *every* tag goal listens for a tag that no longer
  exists, nothing can enrol through any of them. se232 has **12**, five of them live.

The consequence text is deliberately mechanical — *"this branch tests something that no longer
exists"* — because what Keap does at runtime with a decision on a deleted tag was never observed
here, and a guess would read as fact to whoever acts on it.

---

## Step 8 — Export campaign content (migration)

**What is read today.** Emails (from, to, cc, bcc, subject, HTML and text — through the REST API),
web forms (name, hosted URL, redirect or thank-you setting from the REST API, plus fields and HTML
fetched anonymously from the form's public page where Keap serves one — otherwise the record says
`fieldsAvailable: false` and carries `pageError`), SMS messages, Apply Note templates, and HTTP
Request steps.
Emails and web forms need `KEAP_API_KEY`; the rest use your login session.

**Not read yet**, and listed as NOT FETCHED in every run and as `notFetched` in the export: landing
pages, email attachments, email reply-to and preview text, legacy HTTP Post steps, smart and
internal forms, and SMS steps keyed only by `automationMessageId`.

```bash
npm run fetch-content -- --app se232
```

```bash
npm run export -- --app se232
```

`fetch-content` reads the content every campaign step points at — emails, forms, SMS, note
templates, HTTP steps — and every image, stylesheet and font that content uses. It is resumable
like `extract-all`, fetches shared content once, and needs a login session (plus `KEAP_API_KEY` if
any content kind is read through the REST API — it says which before starting).

`export` needs no network. It writes `export/se232/`, one self-contained folder per campaign:

```
export/se232/
  manifest.json          counts, and any content that could not be fetched
  merge-fields.json      every ~Contact.X~ style merge field, to map onto the new platform
  tags.json              every tag a campaign uses: name, and which campaigns apply, remove, trigger on or test it
  campaigns/<id>-<name>/
    campaign.json        goals, sequences, steps, decisions, tasks and canvas notes
    emails/<id>/         email.json (to, cc, bcc, subject…), body.html, body.txt
    forms/<id>/          form.json (fields, when the form's public page has them) and form.html
    sms/ notes/ http/    one JSON file each
    assets/              every image and file the campaign's content uses, plus assets.json
```

Content used by several campaigns is copied into each and lists the others under `sharedWith`.
HTML is never modified; `assets.json` maps each original URL to its local file.

`form.html` is Keap's live public form — submitting it creates a real contact and can start the
campaign; use it as a reference, do not submit it.

Forms fetched before this version carry no fields or `form.html`; re-fetch them with
`npm run fetch-content -- --app se232 --kinds form --force`, because `fetch-content` otherwise
skips items it already has stored.

Tag names need `artifacts/<app>/entities.json` — run `npm run enrich -- --app se232` first. Without
it, `export` still writes `tags.json` and every step's `tags`, but names fall back to whatever a
decision's criteria happened to label the tag, and `export`'s output says so. A tag in `tags.json`
with `name: null` is not in the account's tag list — most likely deleted.

**HTTP step credentials are redacted** and listed under `redacted` in each file: secret-looking
headers, query parameters, form fields, and keys in JSON or form-encoded bodies. A body that is
neither JSON nor form-encoded is left as written and listed as `(unparsed — review manually)`.
A secret embedded in the URL path itself — a Zapier or Slack webhook URL, say — cannot be detected
and must be reviewed by hand. `--include-secrets` keeps them and marks the manifest; treat such an
export as a secret.

| Flag | Command | Meaning |
|---|---|---|
| `--kinds email,sms` | fetch-content | Fetch only these kinds. |
| `--funnel <id>` | both | One campaign. `export` writes it to `export/<app>/_funnel-<id>/`. |
| `--force`, `--limit`, `--delay`, `--headed` | fetch-content | As for `extract-all`. |
| `--include-secrets` | export | Keep HTTP credentials. |

`export/` is gitignored. It holds client content — do not commit it.

---

## Where everything lands

Everything is under `artifacts/<app>/`, which is **gitignored in full** — it is client data.

```
artifacts/se232/
  campaigns.json        step 2  the campaign list, and the only source of "live now"
  progress.json         step 3  resume state
  requests.log.json     step 3  every request made, and every write blocked
  campaigns/<id>/       step 3  draft.xml, publish.xml, meta.json, decisions/
  normalized/<id>.json  step 4  structured campaigns
  graph.json            step 4  the account relationship graph
  entities.json         step 5  id → name, from the REST API
  rendered/<id>.md      step 6  one readable page per campaign, plus index.md
  tag-impact.html       step 7  the shareable report
  tag-impact.md         step 7  the same thing as a document
  tag-impact.json       step 7  the same thing as data
```

Accounts never mix. Each app is a separate client and nothing in this tool joins data across them.

---

## Handing the report to someone

Send **`tag-impact.html` on its own.** The data is embedded in the file — no JSON alongside it, no
server, no network access. It opens by double-click and works offline.

Two things to say when you send it:

- It is a **snapshot**, stamped with its generation time in the header. Re-run and re-send after the
  tag list or the account changes.
- It contains **client data** — every affected campaign name, tag name and contact count for the
  account. Treat it like the tag list itself.

---

## Safety

### The read-only guard

Every browser run installs a guard that blocks any request looking like a write — anything matching
`save`, `publish`, `delete`, `hotSwap`, `reportActions` or a path ending `/template`, plus all
non-GET methods to the application. Blocked requests are recorded in `requests.log.json`.

This is not theoretical. **Keap's campaign builder tries to write to a campaign you are merely
looking at, on page load.** Across two accounts the guard blocked 95 `PUT /app/funnel/<id>` calls
during ordinary read-only extraction. Without it, this tool would have modified live client
campaigns while doing nothing but reading them.

If you see blocked entries in the log, that is the guard working, not a failure.

### Things this tool will not do

- Write to Keap, in any form.
- Handle your password or MFA — you log in yourself in a real browser.
- Join data across accounts.
- Tell you a tag is safe to delete.

### Files to keep out of git

Already in `.gitignore`, and worth knowing why:

| Path | Why |
|---|---|
| `.sessions/` | Live session cookies for a client account. |
| `artifacts/` | Extracted client campaign data. |
| `tag-list.csv`, `*-tag-list.csv` | Client tag names and contact counts. |
| `tag-impact.*` | The reports, same reason. |

---

## Troubleshooting

**"No campaign list at artifacts/…/campaigns.json"** — run step 2 first. Each step names the command
that produces what it is missing.

**Auth errors, or a run that lands on a login page** — the session expired. Re-run `npm run login`.

**`extract-all` stopped partway** — just run it again; it resumes from `progress.json`. Use `--force`
only if you want to re-pull campaigns it already has.

**The tag impact report says every status is `unknown`** — `campaigns.json` is missing. Re-run step 2.

**"the tag list contains no usable rows"** — no `id` column, or every row is missing an id. The
report deliberately refuses to render as "nothing is affected" when the real problem is an unreadable
list.

**A campaign is missing from the results** — check `requests.log.json` and the normalize findings.
Imported campaigns (published into this account from another Keap app) extract normally, but a
handful of accounts have campaigns the builder itself cannot open.

**Something looks wrong and you want to watch it happen** — add `--headed` to `enumerate`,
`extract-all` or `spike`.

---

## Development

```bash
npm test        # 444 tests
npm run typecheck
```

Tests run offline against fixtures. The ones needing a real extracted account skip themselves when
`artifacts/` is absent, so a fresh clone passes.

`npm run spike -- --app <app> --funnel <id>` extracts a single campaign with verbose output, for
poking at one campaign's structure.

### How it fits together

Only steps 1–3 touch the network. Everything after is a pure function over files on disk, which is
why re-running normalize, render or tag-impact costs seconds and cannot damage anything.

```
login → enumerate → extract-all → normalize → ┬→ enrich  (names)
                                              ├→ render  (pages)
                                              └→ tag-impact (the report)
```

### Where the reasoning is written down

- [`docs/spike-findings.md`](docs/spike-findings.md) — everything learned about how Keap actually
  behaves, in the order it was learned, including the corrections. §14 covers publication semantics,
  §16 the second account, §17 tag impact.
- `docs/superpowers/specs/` — approved designs, one per subsystem.
- `docs/superpowers/plans/` — the implementation plans those designs became.

Read `spike-findings.md` before changing anything. Several obvious-looking assumptions in this domain
are wrong, and that document records which ones and how they were caught.
