# Multi-App Support — Design

Date: 2026-08-04
Status: approved, ready for implementation planning
Builds on: `docs/superpowers/specs/2026-08-04-keap-campaign-extraction-spike-design.md`
Evidence: `docs/spike-findings.md`

## 1. Context

A Keap account is called an **app**, identified by its subdomain: `jordan`, `ab123`, `abc12345`.
The extractor currently hardcodes a single tenant through `BASE_URL` and writes every campaign to a
flat `artifacts/<funnelId>/`. Running it against a second account would overwrite the first
account's artifacts with no indication anything had happened.

Two facts from the completed spike shape this design:

1. **Every `draftXml` carries `appName` on its root `<Object>`**, beside `funnelId` and
   `buildNumber`. Observed as `appName="jordan"` in campaigns 584 and 987. Extractions are
   therefore self-identifying.
2. **The saved session carries a `.infusionsoft.com` wildcard cookie.** It is sent to *any*
   subdomain, so pointing one app's session at another app's URL does not reliably bounce to a login
   page the way a domain-scoped cookie would.

Together these mean mislabeling is a live failure mode with a free, authoritative check available.
Filing one client's campaigns under another client is the specific outcome this design prevents.

## 2. Goal

Extract campaigns from any number of Keap apps, keeping sessions and artifacts separated by app,
and make it impossible to write one app's data into another's directory.

## 3. Non-goals

- Extracting from several apps concurrently. One app per command invocation.
- A registry or config file of known apps. The `--app` argument is the only input.
- Migrating or reconciling artifacts between apps.
- Anything in stage 2 (normaliser) or stage 3 (REST enrichment). The layout leaves room for
  account-level entity data; this change does not fetch any.

## 4. Decisions

| Decision | Choice | Rationale |
|---|---|---|
| App input | `--app <name>` flag, base URL derived | One source of truth. The URL and the artifact path are computed from the same value, so they cannot disagree. |
| Mismatch behaviour | Refuse, write nothing | Wrong-app data never reaches disk, so a later bulk run cannot quietly poison a client's folder. |
| Artifact layout | `artifacts/<app>/campaigns/<funnelId>/` | Leaves room beside `campaigns/` for the account-level entity caches stage 3 needs, avoiding a later restructure. |
| Session storage | `.sessions/<app>.json` | One gitignored directory; makes authenticated apps visible at a glance and keeps the repo root clean. |
| `KEAP_BASE_URL` | Retained as a full override | Escape hatch for non-standard hosts. When set it wins over the derived URL, and that is stated in the run output so a stale value cannot silently redirect a run. |

## 5. Architecture

### 5.1 `src/app.ts` — app identity

```ts
export function normalizeAppName(raw: string): string;
export function baseUrlFor(app: string): string;
export function sessionPathFor(app: string): string;
export function campaignDirFor(app: string, funnelId: string): string;
```

Pure, no I/O, no Playwright. Every path and URL in the system derives from these four functions.

**`normalizeAppName` is a security boundary, not a convenience.** The app name becomes both a URL
subdomain and a filesystem path segment:

- `--app ../../../etc` is path traversal.
- `--app evil.com/x` redirects the extractor at a host the operator did not intend.

It lowercases, then enforces DNS label rules — `/^[a-z0-9][a-z0-9-]{0,62}$/` — and throws on
anything else. Lowercasing also prevents `--app Jordan` and `--app jordan` becoming two directories
holding half the data each.

### 5.2 `parseIdentity` in `src/parse/cells.ts`

```ts
export interface CampaignIdentity {
  appName: string | null;
  funnelId: string | null;
  buildNumber: string | null;
}

export function parseIdentity(draftXml: string): CampaignIdentity;
```

Pure string-in, object-out, tested offline against the committed fixtures. Lives beside `parseCells`
because it reads the same document; kept separate because callers need it before deciding whether to
write anything at all.

### 5.3 Verification ordering

The current orchestrator creates the output directory before extracting. That ordering has to
invert, or a refused run still leaves an empty client directory behind:

```
open session
  → extract campaign
  → parseIdentity
  → verify appName and funnelId
  → [only now] mkdir and write
```

Verification compares case-insensitively. `funnelId` is checked alongside `appName` because it
catches the same class of error from the other direction and costs nothing.

The rule distinguishes contradiction from absence:

- **A value that is present and different** aborts the run. Both the expected and the actual value
  are named, and no file or directory is created.
- **A value that is absent** (`null`) warns and proceeds. Both markers were present on every
  campaign observed, but a missing marker is weaker evidence than a contradictory one, and a schema
  change that drops it must not halt extraction across an entire account.

A related case is worth stating: if `KEAP_BASE_URL` is set to a host belonging to a *different* app,
the extraction succeeds but `appName` will contradict `--app`, and the run aborts. That is the
intended outcome — the override changes where we look, never what we are willing to file it as.

### 5.4 Threading the base URL

`src/config.ts` currently exports a module-level `BASE_URL` that `extract/campaign.ts` and
`extract/decision.ts` import directly. With a per-run app that constant no longer makes sense, so
both take the base URL as a parameter instead. `config.ts` keeps `LOGIN_URL_PATTERN` and the
`KEAP_BASE_URL` override lookup.

## 6. Layout

```
.sessions/<app>.json                                   gitignored, chmod 600
artifacts/<app>/campaigns/<funnelId>/draft.xml
                                    /publish.xml
                                    /meta.json
                                    /decisions/<cellId>.html
                                    /decisions/<cellId>.json
                                    /requests.log.json
artifacts/<app>/                                       entities/ lands here in stage 3
```

`meta.json` gains an `appName` field, so an artifact identifies its own origin even if moved.

## 7. Commands

```bash
npm run login -- --app abc12345
npm run spike -- --app abc12345 --funnel 584
```

`--app` is required by both. Errors interpolate the actual app name rather than a placeholder:
a missing session reports `Run: npm run login -- --app abc12345`.

## 8. Migration

- `storageState.json` moves to `.sessions/jordan.json`. It is a valid `jordan` session; moving it
  avoids a needless re-login.
- `artifacts/584` and `artifacts/987` are deleted. Both are gitignored and regenerable, and leaving
  them beside `artifacts/jordan/campaigns/584` invites confusion about which is current.
- `.gitignore` gains `.sessions/`.
- Committed fixtures are untouched. They are raw captures and carry no layout assumptions.

## 9. Error handling

| Condition | Behaviour |
|---|---|
| `--app` missing | Usage message, exit 1, no browser launched. |
| App name fails validation | Names the offending value and the accepted pattern. Exit 1. |
| `.sessions/<app>.json` missing | `Run: npm run login -- --app <app>`. Exit 1. |
| Session expired | Detected by login-URL match, as today. Exit 1. |
| `appName` mismatch | Abort before any write, naming expected and actual. Exit 1. |
| `funnelId` mismatch | Same. |
| `appName` absent from `draftXml` | Warn and proceed. It was present on both observed campaigns, but a missing marker is weaker evidence than a contradictory one and must not block extraction. |
| `KEAP_BASE_URL` set | Print the override and the app it supersedes, so a stale value is visible. |

## 10. Testing

Offline, no browser:

- `normalizeAppName` rejects `../../../etc`, `evil.com/x`, empty string, a 64-character name, and a
  leading hyphen; accepts `jordan`, `ab123`, `abc12345`; lowercases `Jordan`.
- `baseUrlFor`, `sessionPathFor`, `campaignDirFor` produce the documented strings.
- `parseIdentity` returns `appName: "jordan"` for both committed campaign fixtures, and nulls for a
  document lacking the marker.
- Verification rejects a fixture whose `appName` has been doctored to another value, and accepts one
  differing only in case.

Then one real run per campaign against `jordan`, confirming the new paths and a clean session.

## 11. Success criteria

1. `npm run login -- --app jordan` writes `.sessions/jordan.json` at mode 600.
2. `npm run spike -- --app jordan --funnel 987` writes
   `artifacts/jordan/campaigns/987/draft.xml` and reports `appName jordan`.
3. Running with a deliberately wrong `--app` aborts before any directory is created.
4. An invalid app name is rejected without launching a browser.
5. `git check-ignore` confirms `.sessions/` is ignored.
6. The full suite passes offline.
