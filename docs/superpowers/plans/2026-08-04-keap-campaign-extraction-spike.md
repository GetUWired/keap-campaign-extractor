# Keap Campaign Extraction Spike — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove a strictly read-only Playwright extractor can log into Keap Max Classic, export a campaign's `draftXml`/`publishXml`, enumerate its decision cells, and fetch + parse the server-rendered decision criteria — producing raw artifacts and the fixture set the project has been missing.

**Architecture:** Two pure parser modules (`parse/cells.ts`, `parse/decisionHtml.ts`) hold all the logic and are TDD'd offline against synthetic fixtures built from documented examples in `keap-campaign-extractor-handoff.md`. Thin Playwright I/O layers (`auth/`, `extract/`) wrap them. A route-level guard plus a GET-only `safeGet` wrapper make writes structurally impossible. A single CLI orchestrates one campaign end to end.

**Tech Stack:** Node 20+, TypeScript (ESM, strict), Playwright, fast-xml-parser, cheerio, vitest, tsx.

**Spec:** `docs/superpowers/specs/2026-08-04-keap-campaign-extraction-spike-design.md`

## Global Constraints

Every task's requirements implicitly include these.

- **Node 20 or newer.** ESM only (`"type": "module"`). All relative imports carry a `.js` extension.
- **TypeScript `strict: true`.** No `any` except where reading untyped DOM properties inside `page.evaluate`, and there it must be locally cast, never widened into an exported type.
- **Strictly read-only against Keap.** The only exception is `src/auth/login.ts`, where a human submits the login form. Extraction code never issues a non-GET request.
- **No credentials in code or environment.** Session comes only from `storageState.json`, produced by a human login.
- **`storageState.json` and `artifacts/` are gitignored from the first commit.** They hold live session cookies and client data respectively.
- **Base URL is configurable**, defaulting to `https://jordan.infusionsoft.com`, read from `KEAP_BASE_URL`.
- **All timestamps are ISO 8601 UTC** (`new Date().toISOString()`).
- **Strip the trailing Java-Long `L`** from every foreign-key id before emitting it (`479L` → `479`).
- **Replace `~br~` with a single space** in every `name` attribute, then collapse whitespace and trim.
- **Never read or emit raw inline `<script>` text.** Session tokens sit adjacent to campaign data in those scripts. Read DOM properties only.
- **Unknown node types are data, not errors.** Record them in `warnings`/`styleCounts` and continue.

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `.gitignore` | Scaffold, scripts, ignore rules |
| `src/config.ts` | Base URL, state path, login-detection pattern |
| `src/guard/readonly.ts` | Request classification, route interception, `safeGet` |
| `src/parse/cells.ts` | `draftXml` → decision cell inventory. Pure. |
| `src/parse/decisionHtml.ts` | Layer-B HTML → structured rules. Pure. |
| `src/auth/login.ts` | One-time human login → `storageState.json` |
| `src/auth/session.ts` | Load state, build guarded context, detect expiry |
| `src/extract/campaign.ts` | Editor page → `CampaignRaw` |
| `src/extract/decision.ts` | Candidate URL construction + fetch + parse |
| `src/cli/spike.ts` | Orchestrator, artifact writing, summary |
| `test/*.test.ts` | Offline tests for the guard, both parsers, and URL construction |

Tasks 2–4 are pure and fully TDD'd before any browser code exists. Tasks 5–8 are I/O and are verified by the real run in Task 9.

---

### Task 1: Project scaffold

**Files:**
- Create: `.gitignore`
- Create: `package.json`
- Create: `tsconfig.json`

**Interfaces:**
- Consumes: nothing
- Produces: npm scripts `login`, `spike`, `test`, `typecheck`. All later tasks assume ESM with `.js` import extensions.

- [ ] **Step 1: Initialise the git repository with ignore rules in place first**

The ignore file must exist before anything else, so a session cookie file can never enter history.

Create `.gitignore`:

```
node_modules/
storageState.json
artifacts/
*.log
.DS_Store
```

Then:

```bash
git init && git add .gitignore && git commit -m "chore: initialise repo with ignore rules for session state and artifacts"
```

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "keap-campaign-extractor",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "login": "tsx src/auth/login.ts",
    "spike": "tsx src/cli/spike.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "cheerio": "^1.0.0",
    "fast-xml-parser": "^4.5.0",
    "playwright": "^1.48.0"
  },
  "devDependencies": {
    "@types/node": "^22.7.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["node"],
    "noEmit": true
  },
  "include": ["src", "test"]
}
```

`"lib"` includes `DOM` because `page.evaluate` callbacks reference `document`.

- [ ] **Step 4: Install dependencies and the browser**

```bash
npm install && npx playwright install chromium
```

Expected: no peer-dependency errors; Chromium downloads.

- [ ] **Step 5: Verify the toolchain runs**

Run: `npm run typecheck`
Expected: PASS with no output. (`include` points at `src` and `test`, which do not exist yet — `tsc` succeeds on an empty program.)

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json && git commit -m "chore: scaffold TypeScript ESM project with Playwright and vitest"
```

---

### Task 2: Read-only guard

**Files:**
- Create: `src/guard/readonly.ts`
- Test: `test/readonly.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `classifyRequest(method: string, url: string): BlockReason | null`
  - `installReadOnlyGuard(context: BrowserContext): Guard`
  - `safeGet(context: BrowserContext, url: string): Promise<APIResponse>`
  - types `BlockReason`, `BlockedRequest`, `AllowedRequest`, `Guard`
  - constants `WRITE_URL_PATTERN`, `GUARDED_PATH_PREFIX`

The whole policy is isolated in `classifyRequest`, a pure function, so it is testable without a browser.

**Design note — why the pattern matches the pathname only:** matching the query string would break real extractions. Decision-editor URLs carry `&title=<cell name>`, and a campaign author is free to name a decision node "Save for later". Matching the query would abort that legitimate GET. Writes are already blocked unconditionally by method, so the path pattern is defence in depth, not the primary control.

- [ ] **Step 1: Write the failing test**

Create `test/readonly.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { classifyRequest } from '../src/guard/readonly.js';

describe('classifyRequest', () => {
  it('allows a GET to the campaign editor', () => {
    expect(
      classifyRequest('GET', 'https://x.infusionsoft.com/app/funnel/funnelEditor?funnelId=584'),
    ).toBeNull();
  });

  it('blocks the observed template-writing PUT', () => {
    expect(
      classifyRequest('PUT', 'https://x.infusionsoft.com/app/authoring/a/b/template'),
    ).toBe('non-get');
  });

  it('blocks every POST regardless of path', () => {
    expect(classifyRequest('POST', 'https://x.infusionsoft.com/anything')).toBe('non-get');
  });

  it('blocks a GET to a write-shaped /app/ path', () => {
    expect(
      classifyRequest('GET', 'https://x.infusionsoft.com/app/funnel/saveDraft?id=1'),
    ).toBe('denylist');
  });

  it('allows static assets whose path contains a denylisted word', () => {
    expect(
      classifyRequest('GET', 'https://x.infusionsoft.com/resources/funnel/images/template-icon.svg'),
    ).toBeNull();
  });

  it('allows a decision-editor GET whose title parameter contains "save"', () => {
    expect(
      classifyRequest(
        'GET',
        'https://x.infusionsoft.com/app/funnel/configureCell?cellId=34&metaType=decision&title=Save%20for%20later',
      ),
    ).toBeNull();
  });

  it('blocks a malformed URL rather than letting it through', () => {
    expect(classifyRequest('GET', 'not-a-url')).toBe('denylist');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/readonly.test.ts`
Expected: FAIL — cannot resolve `../src/guard/readonly.js`.

- [ ] **Step 3: Write the implementation**

Create `src/guard/readonly.ts`:

```ts
import type { APIResponse, BrowserContext } from 'playwright';

/** Matched against the URL pathname only. See the design note in the plan. */
export const WRITE_URL_PATTERN = /(save|publish|delete|template|hotSwap)/i;

/** Only paths under this prefix are subject to WRITE_URL_PATTERN. */
export const GUARDED_PATH_PREFIX = '/app/';

export type BlockReason = 'non-get' | 'denylist';

export interface BlockedRequest {
  method: string;
  url: string;
  reason: BlockReason;
  at: string;
}

export interface AllowedRequest {
  method: string;
  url: string;
  at: string;
}

export interface Guard {
  blocked: BlockedRequest[];
  allowed: AllowedRequest[];
}

/**
 * Returns the reason a request must be blocked, or null if it is allowed.
 * Pure — this is the entire read-only policy.
 */
export function classifyRequest(method: string, url: string): BlockReason | null {
  if (method.toUpperCase() !== 'GET') return 'non-get';

  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // A URL we cannot parse is a URL we cannot vet.
    return 'denylist';
  }

  if (pathname.startsWith(GUARDED_PATH_PREFIX) && WRITE_URL_PATTERN.test(pathname)) {
    return 'denylist';
  }

  return null;
}

export function installReadOnlyGuard(context: BrowserContext): Guard {
  const guard: Guard = { blocked: [], allowed: [] };

  void context.route('**/*', async (route) => {
    const request = route.request();
    const method = request.method();
    const url = request.url();
    const at = new Date().toISOString();

    const reason = classifyRequest(method, url);
    if (reason) {
      guard.blocked.push({ method, url, reason, at });
      await route.abort();
      return;
    }

    guard.allowed.push({ method, url, at });
    await route.continue();
  });

  return guard;
}

/**
 * GET-only HTTP helper.
 *
 * Playwright's APIRequestContext does not participate in route handling, so
 * requests made through it bypass installReadOnlyGuard entirely. This wrapper
 * re-applies the same policy and exposes no verb other than GET.
 */
export async function safeGet(context: BrowserContext, url: string): Promise<APIResponse> {
  const reason = classifyRequest('GET', url);
  if (reason) {
    throw new Error(`safeGet refused ${url} (${reason})`);
  }
  return context.request.get(url);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/readonly.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/guard/readonly.ts test/readonly.test.ts && git commit -m "feat: add read-only request guard with pure classification policy"
```

---

### Task 3: Parse decision cells from draftXml

**Files:**
- Create: `test/fixtures/synthetic-campaign.xml`
- Create: `src/parse/cells.ts`
- Test: `test/cells.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `parseCells(draftXml: string): CellInventory`
  - `stripLongSuffix(value: string | undefined | null): string | null`
  - `cleanName(value: string | undefined | null): string | null`
  - types `DecisionBranch`, `DecisionCell`, `CellInventory`

`DecisionCell` is consumed by Task 7 (`fetchDecision`) and Task 8. `stripLongSuffix` is reused by Task 4.

- [ ] **Step 1: Create the synthetic fixture**

Built from the verbatim `decision` cell in handoff §5.1 and the campaign-584 reference data in §8. Real artifacts join it in Task 9; it exists so the parser can be TDD'd with no network.

Create `test/fixtures/synthetic-campaign.xml`:

```xml
<mxGraphModel dx="1000" dy="600" grid="1">
  <root>
    <mxCell id="0"/>
    <mxCell id="1" parent="0"/>
    <mxCell id="2" style="newsletterRequest" metaType="webform" parent="1" vertex="1">
      <Object name="Satisfaction~br~Survey" webformId="812L" ready="1" as="value"/>
      <mxGeometry as="geometry" x="40" y="40" width="60" height="60"/>
    </mxCell>
    <mxCell id="3" style="flow" parent="1" vertex="1">
      <Object name="Satisfied" flowType="Stop" ready="1" published="0" as="value"/>
      <mxGeometry as="geometry" x="240" y="40" width="80" height="60"/>
    </mxCell>
    <mxCell id="34" style="decision" parent="1" vertex="1">
      <Object initialized="1" ready="1" published="1" name="Applied~br~Already?" as="value">
        <Array as="decisions">
          <Object decisionId="479L" flowId="3"/>
          <Object decisionId="481L" flowId="32"/>
        </Array>
      </Object>
      <mxGeometry as="geometry" x="160" y="80" width="32" height="32"/>
    </mxCell>
    <mxCell id="44" style="someFutureNodeType" parent="1" vertex="1">
      <Object name="Unknown Thing" as="value"/>
      <mxGeometry as="geometry" x="400" y="80" width="32" height="32"/>
    </mxCell>
    <mxCell id="55" style="decision" parent="1" vertex="1">
      <Object initialized="0" ready="0" name="Unconfigured" as="value"/>
      <mxGeometry as="geometry" x="500" y="80" width="32" height="32"/>
    </mxCell>
    <mxCell id="70" style="timerDelay" parent="3" vertex="1">
      <Object name="Wait 30 minutes" waitDelay="30" waitDelayType="Minute" as="value"/>
      <mxGeometry as="geometry" x="10" y="10" width="40" height="40"/>
    </mxCell>
    <mxCell id="e1" edge="1" parent="1" source="2" target="34"/>
  </root>
</mxGraphModel>
```

- [ ] **Step 2: Write the failing test**

Create `test/cells.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanName, parseCells, stripLongSuffix } from '../src/parse/cells.js';

const xml = readFileSync(new URL('./fixtures/synthetic-campaign.xml', import.meta.url), 'utf8');

describe('stripLongSuffix', () => {
  it('removes a trailing Java Long marker', () => {
    expect(stripLongSuffix('479L')).toBe('479');
  });

  it('leaves a plain number alone', () => {
    expect(stripLongSuffix('3')).toBe('3');
  });

  it('returns null for missing input', () => {
    expect(stripLongSuffix(undefined)).toBeNull();
  });
});

describe('cleanName', () => {
  it('replaces the ~br~ line-break token with a space', () => {
    expect(cleanName('Thank You +~br~Testimonial Request')).toBe('Thank You + Testimonial Request');
  });

  it('collapses the whitespace it introduces', () => {
    expect(cleanName('A ~br~ B')).toBe('A B');
  });
});

describe('parseCells', () => {
  it('counts every mxCell including the two graph roots and the edge', () => {
    // ids 0, 1, 2, 3, 34, 44, 55, 70, e1
    expect(parseCells(xml).cellCount).toBe(9);
  });

  it('tallies styles, bucketing style-less cells under (none)', () => {
    const { styleCounts } = parseCells(xml);
    expect(styleCounts.decision).toBe(2);
    expect(styleCounts.flow).toBe(1);
    expect(styleCounts['(none)']).toBe(3); // ids 0, 1 and the edge e1
  });

  it('records an unknown style as data rather than throwing', () => {
    expect(parseCells(xml).styleCounts.someFutureNodeType).toBe(1);
  });

  it('extracts decision routing with the L suffix stripped', () => {
    const cell = parseCells(xml).decisions.find((d) => d.cellId === '34');
    expect(cell?.branches).toEqual([
      { decisionId: '479', flowId: '3' },
      { decisionId: '481', flowId: '32' },
    ]);
  });

  it('cleans ~br~ out of the decision name', () => {
    const cell = parseCells(xml).decisions.find((d) => d.cellId === '34');
    expect(cell?.name).toBe('Applied Already?');
  });

  it('warns about a decision cell with no routing rather than dropping it', () => {
    const inventory = parseCells(xml);
    const cell = inventory.decisions.find((d) => d.cellId === '55');
    expect(cell?.branches).toEqual([]);
    expect(inventory.warnings.some((w) => w.includes('55'))).toBe(true);
  });

  it('throws a clear error when the document has no root', () => {
    expect(() => parseCells('<nope/>')).toThrow(/mxGraphModel/);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/cells.test.ts`
Expected: FAIL — cannot resolve `../src/parse/cells.js`.

- [ ] **Step 4: Write the implementation**

Create `src/parse/cells.ts`:

```ts
import { XMLParser } from 'fast-xml-parser';

export interface DecisionBranch {
  decisionId: string;
  flowId: string;
}

export interface DecisionCell {
  cellId: string;
  name: string | null;
  branches: DecisionBranch[];
}

export interface CellInventory {
  cellCount: number;
  decisions: DecisionCell[];
  styleCounts: Record<string, number>;
  warnings: string[];
}

const ATTR = '@_';

/** Foreign keys are serialised as Java Longs: "479L" -> "479". */
export function stripLongSuffix(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  return String(value).replace(/L$/, '');
}

/** `~br~` is Keap's line-break token inside name attributes. */
export function cleanName(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const cleaned = String(value).replace(/~br~/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length > 0 ? cleaned : null;
}

interface XmlNode {
  [key: string]: unknown;
}

function asArray(value: unknown): XmlNode[] {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]) as XmlNode[];
}

function attr(node: XmlNode, name: string): string | undefined {
  const raw = node[`${ATTR}${name}`];
  return raw === undefined || raw === null ? undefined : String(raw);
}

export function parseCells(draftXml: string): CellInventory {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: ATTR,
    parseAttributeValue: false,
    isArray: (name) => ['mxCell', 'Object', 'Array'].includes(name),
  });

  const doc = parser.parse(draftXml) as XmlNode;
  const model = doc.mxGraphModel as XmlNode | undefined;
  const root = model?.root as XmlNode | undefined;
  if (!root) {
    throw new Error('draftXml has no mxGraphModel/root element');
  }

  const cells = asArray(root.mxCell);
  const styleCounts: Record<string, number> = {};
  const decisions: DecisionCell[] = [];
  const warnings: string[] = [];

  for (const cell of cells) {
    const cellId = attr(cell, 'id') ?? '(missing id)';
    const style = attr(cell, 'style') ?? '(none)';
    styleCounts[style] = (styleCounts[style] ?? 0) + 1;

    if (style !== 'decision') continue;

    const value = asArray(cell.Object)[0];
    if (!value) {
      warnings.push(`decision cell ${cellId} has no <Object as="value"> payload`);
      decisions.push({ cellId, name: null, branches: [] });
      continue;
    }

    const decisionsArray = asArray(value.Array).find((a) => attr(a, 'as') === 'decisions');
    const branches: DecisionBranch[] = [];

    for (const entry of asArray(decisionsArray?.Object)) {
      const decisionId = stripLongSuffix(attr(entry, 'decisionId'));
      const flowId = stripLongSuffix(attr(entry, 'flowId'));
      if (decisionId === null || flowId === null) {
        warnings.push(`decision cell ${cellId} has a branch missing decisionId or flowId`);
        continue;
      }
      branches.push({ decisionId, flowId });
    }

    if (branches.length === 0) {
      warnings.push(`decision cell ${cellId} has no routing branches (likely unconfigured)`);
    }

    decisions.push({ cellId, name: cleanName(attr(value, 'name')), branches });
  }

  return { cellCount: cells.length, decisions, styleCounts, warnings };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/cells.test.ts`
Expected: PASS, 12 tests (3 `stripLongSuffix`, 2 `cleanName`, 7 `parseCells`).

- [ ] **Step 6: Commit**

```bash
git add src/parse/cells.ts test/cells.test.ts test/fixtures/synthetic-campaign.xml && git commit -m "feat: parse decision cell inventory from campaign draftXml"
```

---

### Task 4: Parse decision criteria HTML

**Files:**
- Create: `test/fixtures/synthetic-decision.html`
- Create: `src/parse/decisionHtml.ts`
- Test: `test/decisionHtml.test.ts`

**Interfaces:**
- Consumes: `stripLongSuffix` from `src/parse/cells.js`
- Produces:
  - `parseDecisionHtml(html: string): DecisionCriteria`
  - types `RuleValue`, `Rule`, `RuleGroup`, `DecisionWrapper`, `ElseOption`, `DecisionCriteria`

`DecisionCriteria` is consumed by Task 7 and written to disk by Task 8.

**Design note — id extraction:** the handoff records `#decisionIds -> [479, 481]` without specifying whether the raw attribute is `479,481` or `[479, 481]`. The parser extracts every integer run with `/\d+/g`, which handles both and is insensitive to bracket or whitespace style.

**Design note — class matching:** `ruleGroupOuter_1` would match a naive `[class*="rule"]` selector. Class tokens are matched with anchored regexes (`/^rule_(.+)$/`) so an outer group is never mistaken for a rule.

- [ ] **Step 1: Create the synthetic fixture**

Built from the container chain in handoff §5.2, the field contract in §5.3, the fallback select in §5.4, and the worked example in §5.6. The first wrapper carries one rule with two values to exercise multi-select; the second carries two rules in one AND group to exercise grouping.

Create `test/fixtures/synthetic-decision.html`:

```html
<div id="pagecontent">
  <div id="editor" data-funnelname="Beta Application" data-maxcellid="99"
       data-newtimezoneid="America/Phoenix" data-timezonelabel="(GMT -07:00) Phoenix">
    <div id="hotSwappableEditor_2">
      <div id="wrapper_decisionComponents" class="whole-page-editor-wrapper">
        <div id="decisionComponents">
          <input type="hidden" id="decisionIds" name="decisionIds" value="479,481"/>
          <input type="hidden" id="flowIds" name="flowIds" value="3,32"/>

          <section class="decisionWrapper">
            <div class="ruleGroupOuter_1">
              <div class="ruleGroupInner_1">
                <table class="ruleContainer_100">
                  <tr><td>
                    <div class="rule_100">
                      <select name="subject_100">
                        <option value="_blank">Choose</option>
                        <option value="contact_Subject" selected="selected">Contact's</option>
                      </select>
                      <select name="category_100">
                        <option value="_blank">Choose</option>
                        <option value="tags_FieldCategory" selected="selected">Tags</option>
                      </select>
                      <input type="text" name="field_100" value=""/>
                      <select name="constraint_100">
                        <option value="contains_Constraint">contains</option>
                        <option value="notContains_Constraint" selected="selected">doesn't contain</option>
                      </select>
                      <input type="hidden" name="value_100_1" value="1123L"/>
                      <input type="text" name="value_100_1_text"
                             value="WooConnection Beta -&gt; WooCommerce Beta Tester - Applied"/>
                      <input type="hidden" name="value_100_2" value="1145L"/>
                      <input type="text" name="value_100_2_text" value="Beta -&gt; Second Tag"/>
                    </div>
                  </td></tr>
                </table>
              </div>
            </div>
          </section>

          <section class="decisionWrapper">
            <div class="ruleGroupOuter_2">
              <div class="ruleGroupInner_2">
                <table class="ruleContainer_200">
                  <tr><td>
                    <div class="rule_200">
                      <select name="subject_200">
                        <option value="contact_Subject" selected="selected">Contact's</option>
                      </select>
                      <select name="category_200">
                        <option value="tags_FieldCategory" selected="selected">Tags</option>
                      </select>
                      <input type="text" name="field_200" value=""/>
                      <select name="constraint_200">
                        <option value="contains_Constraint" selected="selected">contains</option>
                      </select>
                      <input type="hidden" name="value_200_1" value="1123L"/>
                      <input type="text" name="value_200_1_text"
                             value="WooConnection Beta -&gt; WooCommerce Beta Tester - Applied"/>
                    </div>
                  </td></tr>
                </table>
                <table class="ruleContainer_201">
                  <tr><td>
                    <div class="rule_201">
                      <select name="subject_201">
                        <option value="contact_Subject" selected="selected">Contact's</option>
                      </select>
                      <select name="category_201">
                        <option value="customFieldGroup29_FieldCategory" selected="selected">Info</option>
                      </select>
                      <input type="text" name="field_201" value="Region"/>
                      <select name="constraint_201">
                        <option value="notEmpty_Constraint" selected="selected">is not empty</option>
                      </select>
                    </div>
                  </td></tr>
                </table>
              </div>
            </div>
          </section>

          <select id="elseRulesOptions" name="elseRulesOptions">
            <option value="0" selected="selected">Don't put them in a sequence</option>
            <option value="481">32</option>
            <option value="479">3</option>
          </select>
        </div>
      </div>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Write the failing test**

Create `test/decisionHtml.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDecisionHtml } from '../src/parse/decisionHtml.js';

const html = readFileSync(new URL('./fixtures/synthetic-decision.html', import.meta.url), 'utf8');

describe('parseDecisionHtml', () => {
  it('reads the decision and flow id lists', () => {
    const result = parseDecisionHtml(html);
    expect(result.decisionIds).toEqual(['479', '481']);
    expect(result.flowIds).toEqual(['3', '32']);
  });

  it('aligns wrappers ordinally with the id lists', () => {
    const [first, second] = parseDecisionHtml(html).wrappers;
    expect(first).toMatchObject({ index: 0, decisionId: '479', flowId: '3' });
    expect(second).toMatchObject({ index: 1, decisionId: '481', flowId: '32' });
  });

  it('extracts a rule with both raw enum values and display labels', () => {
    const rule = parseDecisionHtml(html).wrappers[0]?.any[0]?.all[0];
    expect(rule).toMatchObject({
      ruleId: '100',
      subject: 'contact_Subject',
      subjectLabel: "Contact's",
      category: 'tags_FieldCategory',
      categoryLabel: 'Tags',
      constraint: 'notContains_Constraint',
      constraintLabel: "doesn't contain",
    });
  });

  it('captures every value with its _text label and the L stripped', () => {
    const rule = parseDecisionHtml(html).wrappers[0]?.any[0]?.all[0];
    expect(rule?.values).toEqual([
      { id: '1123', label: 'WooConnection Beta -> WooCommerce Beta Tester - Applied' },
      { id: '1145', label: 'Beta -> Second Tag' },
    ]);
  });

  it('groups two rules in the same inner group as a single AND group', () => {
    const wrapper = parseDecisionHtml(html).wrappers[1];
    expect(wrapper?.any).toHaveLength(1);
    expect(wrapper?.any[0]?.all.map((r) => r.ruleId)).toEqual(['200', '201']);
  });

  it('reads a rule with a populated field and no values', () => {
    const rule = parseDecisionHtml(html).wrappers[1]?.any[0]?.all[1];
    expect(rule?.field).toBe('Region');
    expect(rule?.categoryLabel).toBe('Info');
    expect(rule?.values).toEqual([]);
  });

  it('reads the else branch options and which is selected', () => {
    const result = parseDecisionHtml(html);
    expect(result.elseOptions).toEqual([
      { decisionId: '0', flowId: null, label: "Don't put them in a sequence", selected: true },
      { decisionId: '481', flowId: '32', label: '32', selected: false },
      { decisionId: '479', flowId: '3', label: '3', selected: false },
    ]);
    expect(result.elseSelected?.decisionId).toBe('0');
  });

  it('warns instead of throwing when id lists and wrappers disagree', () => {
    const broken = html.replace('value="479,481"', 'value="479"');
    const result = parseDecisionHtml(broken);
    expect(result.warnings.some((w) => /align|mismatch/i.test(w))).toBe(true);
    expect(result.wrappers).toHaveLength(2);
    expect(result.wrappers[1]?.decisionId).toBeNull();
  });

  it('returns an empty result with a warning for unrelated HTML', () => {
    const result = parseDecisionHtml('<html><body>Session expired</body></html>');
    expect(result.wrappers).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/decisionHtml.test.ts`
Expected: FAIL — cannot resolve `../src/parse/decisionHtml.js`.

- [ ] **Step 4: Write the implementation**

Create `src/parse/decisionHtml.ts`:

```ts
import { type AnyNode, type Cheerio, load } from 'cheerio';
import { stripLongSuffix } from './cells.js';

export interface RuleValue {
  id: string;
  label: string | null;
}

export interface Rule {
  ruleId: string;
  subject: string | null;
  subjectLabel: string | null;
  category: string | null;
  categoryLabel: string | null;
  field: string | null;
  fieldLabel: string | null;
  constraint: string | null;
  constraintLabel: string | null;
  values: RuleValue[];
}

/** One AND group: every rule inside must hold. */
export interface RuleGroup {
  groupId: string;
  all: Rule[];
}

/** One target sequence. `any` is an OR over AND groups. */
export interface DecisionWrapper {
  index: number;
  decisionId: string | null;
  flowId: string | null;
  any: RuleGroup[];
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

type Q = ReturnType<typeof load>;

/** Tolerates "479,481", "[479, 481]" and whitespace-separated forms alike. */
function extractIds(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.match(/\d+/g) ?? [];
}

/** Returns the capture from the first class token matching `re`, else null. */
function classCapture($el: Cheerio<AnyNode>, re: RegExp): string | null {
  const classes = ($el.attr('class') ?? '').split(/\s+/).filter(Boolean);
  for (const token of classes) {
    const match = re.exec(token);
    if (match?.[1]) return match[1];
  }
  return null;
}

/** Finds a control by `name`, falling back to `id`. */
function control(scope: Cheerio<AnyNode>, name: string): Cheerio<AnyNode> {
  const byName = scope.find(`[name="${name}"]`).first();
  if (byName.length > 0) return byName;
  return scope.find(`#${name}`).first();
}

function readControl(
  scope: Cheerio<AnyNode>,
  name: string,
): { value: string | null; label: string | null } {
  const el = control(scope, name);
  if (el.length === 0) return { value: null, label: null };

  if (el.is('select')) {
    const selected = el.find('option[selected]').first();
    const option = selected.length > 0 ? selected : el.find('option').first();
    if (option.length === 0) return { value: null, label: null };
    return {
      value: option.attr('value') ?? null,
      label: option.text().trim() || null,
    };
  }

  const value = el.attr('value') ?? null;
  return { value: value === '' ? null : value, label: null };
}

function parseRule($: Q, ruleEl: Cheerio<AnyNode>, ruleId: string): Rule {
  const subject = readControl(ruleEl, `subject_${ruleId}`);
  const category = readControl(ruleEl, `category_${ruleId}`);
  const field = readControl(ruleEl, `field_${ruleId}`);
  const constraint = readControl(ruleEl, `constraint_${ruleId}`);

  const values: RuleValue[] = [];
  ruleEl.find(`[name^="value_${ruleId}_"]`).each((_, node) => {
    const el = $(node);
    const name = el.attr('name');
    if (!name || name.endsWith('_text')) return;
    const id = stripLongSuffix(el.attr('value'));
    if (id === null) return;
    const label = ruleEl.find(`[name="${name}_text"]`).first().attr('value') ?? null;
    values.push({ id, label: label === '' ? null : label });
  });

  return {
    ruleId,
    subject: subject.value,
    subjectLabel: subject.label,
    category: category.value,
    categoryLabel: category.label,
    field: field.value,
    fieldLabel: field.label,
    constraint: constraint.value,
    constraintLabel: constraint.label,
    values,
  };
}

export function parseDecisionHtml(html: string): DecisionCriteria {
  const $ = load(html);
  const warnings: string[] = [];

  const decisionIds = extractIds($('#decisionIds').attr('value'));
  const flowIds = extractIds($('#flowIds').attr('value'));

  const wrappers: DecisionWrapper[] = [];

  $('section.decisionWrapper').each((index, sectionNode) => {
    const section = $(sectionNode);
    const groups: RuleGroup[] = [];

    section.find('div').each((_, outerNode) => {
      const outer = $(outerNode);
      if (classCapture(outer, /^ruleGroupOuter_(.+)$/) === null) return;

      outer.find('div').each((__, innerNode) => {
        const inner = $(innerNode);
        const groupId = classCapture(inner, /^ruleGroupInner_(.+)$/);
        if (groupId === null) return;

        const all: Rule[] = [];
        inner.find('div').each((___, ruleNode) => {
          const ruleEl = $(ruleNode);
          const ruleId = classCapture(ruleEl, /^rule_(.+)$/);
          if (ruleId === null) return;
          all.push(parseRule($, ruleEl, ruleId));
        });

        groups.push({ groupId, all });
      });
    });

    wrappers.push({
      index,
      decisionId: decisionIds[index] ?? null,
      flowId: flowIds[index] ?? null,
      any: groups,
    });
  });

  if (wrappers.length === 0) {
    warnings.push('no section.decisionWrapper elements found — this may not be decision editor HTML');
  }
  if (decisionIds.length !== wrappers.length || flowIds.length !== wrappers.length) {
    warnings.push(
      `id lists do not align with wrappers: ${decisionIds.length} decisionIds, ` +
        `${flowIds.length} flowIds, ${wrappers.length} wrappers — mismatch, ordinal pairing unreliable`,
    );
  }

  const elseOptions: ElseOption[] = [];
  $('#elseRulesOptions option').each((_, node) => {
    const option = $(node);
    const decisionId = option.attr('value');
    if (decisionId === undefined) return;
    const label = option.text().trim();
    elseOptions.push({
      decisionId,
      flowId: /^\d+$/.test(label) ? label : null,
      label,
      selected: option.attr('selected') !== undefined,
    });
  });

  return {
    decisionIds,
    flowIds,
    wrappers,
    elseOptions,
    elseSelected: elseOptions.find((o) => o.selected) ?? null,
    warnings,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/decisionHtml.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Run the whole suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS, 28 tests total (7 guard + 12 cells + 9 decisionHtml), no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/parse/decisionHtml.ts test/decisionHtml.test.ts test/fixtures/synthetic-decision.html && git commit -m "feat: parse decision criteria from server-rendered layer-B HTML"
```

---

### Task 5: Session handling and human login

**Files:**
- Create: `src/config.ts`
- Create: `src/auth/login.ts`
- Create: `src/auth/session.ts`

**Interfaces:**
- Consumes: `installReadOnlyGuard` from `src/guard/readonly.js`
- Produces:
  - `BASE_URL: string`, `STATE_PATH: string`, `LOGIN_URL_PATTERN: RegExp` from `src/config.js`
  - `openSession(options?: { headless?: boolean }): Promise<Session>`
  - `closeSession(session: Session): Promise<void>`
  - `assertAuthenticated(page: Page): void`
  - type `Session { browser: Browser; context: BrowserContext; guard: Guard }`

**Design note — login is deliberately unguarded.** `login.ts` never installs the read-only guard, because the human must POST the sign-in form. It is the one place in the codebase that touches a non-GET request, and it does so under direct human control. Every other entry point goes through `openSession`, which always installs the guard.

- [ ] **Step 1: Create the shared config**

Create `src/config.ts`:

```ts
export const BASE_URL = (process.env.KEAP_BASE_URL ?? 'https://jordan.infusionsoft.com').replace(
  /\/+$/,
  '',
);

export const STATE_PATH = process.env.KEAP_STATE_PATH ?? 'storageState.json';

/** URL fragments that indicate we have been bounced to a sign-in screen. */
export const LOGIN_URL_PATTERN = /(\/login|\/signin|signin\.|accounts\.infusionsoft\.com)/i;
```

- [ ] **Step 2: Write the login CLI**

Create `src/auth/login.ts`:

```ts
import { chmod } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { chromium } from 'playwright';
import { BASE_URL, STATE_PATH } from '../config.js';

/**
 * One-time interactive login.
 *
 * No read-only guard is installed here: submitting the sign-in form requires a
 * POST, and a human is driving. Every non-interactive entry point uses
 * openSession(), which always installs the guard.
 */
async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(BASE_URL);

  console.log(`\nA browser window is open at ${BASE_URL}.`);
  console.log('Log in to Keap there, wait until you can see the dashboard, then return here.');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('Press Enter once you are logged in... ');
  rl.close();

  await context.storageState({ path: STATE_PATH });
  await chmod(STATE_PATH, 0o600);
  await browser.close();

  console.log(`\nSaved session to ${STATE_PATH} (mode 600).`);
  console.log('This file contains live session cookies. It is gitignored — keep it that way.');
}

await main();
```

- [ ] **Step 3: Write the session helper**

Create `src/auth/session.ts`:

```ts
import { existsSync } from 'node:fs';
import { type Browser, type BrowserContext, type Page, chromium } from 'playwright';
import { LOGIN_URL_PATTERN, STATE_PATH } from '../config.js';
import { type Guard, installReadOnlyGuard } from '../guard/readonly.js';

export interface Session {
  browser: Browser;
  context: BrowserContext;
  guard: Guard;
}

export async function openSession(options?: { headless?: boolean }): Promise<Session> {
  if (!existsSync(STATE_PATH)) {
    throw new Error(`No session file at ${STATE_PATH}. Run:  npm run login`);
  }

  const browser = await chromium.launch({ headless: options?.headless ?? true });
  const context = await browser.newContext({ storageState: STATE_PATH });
  const guard = installReadOnlyGuard(context);

  return { browser, context, guard };
}

export async function closeSession(session: Session): Promise<void> {
  await session.context.close();
  await session.browser.close();
}

/** Throws if the page has been bounced to a sign-in screen. */
export function assertAuthenticated(page: Page): void {
  const url = page.url();
  if (LOGIN_URL_PATTERN.test(url)) {
    throw new Error(`Session expired — landed on ${url}. Run:  npm run login`);
  }
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS, no errors.

- [ ] **Step 5: Run the login flow end to end**

Run: `npm run login`

Expected: a Chromium window opens at the Keap tenant. Log in by hand. After pressing Enter, `storageState.json` exists.

Then verify it is protected and ignored:

```bash
ls -l storageState.json && git check-ignore -v storageState.json
```

Expected: mode `-rw-------`, and `git check-ignore` prints the matching `.gitignore` line. If it prints nothing, **stop** — the ignore rule is not working and the file must not be committed.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/auth/login.ts src/auth/session.ts && git commit -m "feat: add human login flow and guarded session loader"
```

---

### Task 6: Extract campaign XML from the editor page

**Files:**
- Create: `src/extract/campaign.ts`

**Interfaces:**
- Consumes: `assertAuthenticated` from `src/auth/session.js`, `BASE_URL` from `src/config.js`
- Produces: `extractCampaign(page: Page, funnelId: string): Promise<CampaignRaw>`, type `CampaignRaw`

`CampaignRaw` is consumed by Task 8.

**Design note — `appBuild` is best-effort.** The handoff records the build string (`1.70.0.989251-sysarch-202608031100`) but not where it is read from. This extracts it from any script `src` containing `sysarch`, returning `null` when absent. A null build number is provenance we lack, not a failure.

- [ ] **Step 1: Write the implementation**

Create `src/extract/campaign.ts`:

```ts
import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import { assertAuthenticated } from '../auth/session.js';
import { BASE_URL } from '../config.js';

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

const EDITOR_TIMEOUT_MS = 30_000;

export async function extractCampaign(page: Page, funnelId: string): Promise<CampaignRaw> {
  const url = `${BASE_URL}/app/funnel/funnelEditor?funnelId=${encodeURIComponent(funnelId)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  assertAuthenticated(page);

  try {
    await page.waitForFunction(
      () => {
        const el = document.querySelector('campaign-editor') as { draftXml?: unknown } | null;
        return typeof el?.draftXml === 'string' && el.draftXml.length > 0;
      },
      undefined,
      { timeout: EDITOR_TIMEOUT_MS },
    );
  } catch {
    const title = await page.title();
    throw new Error(
      `campaign-editor never produced draftXml for funnelId=${funnelId} ` +
        `after ${EDITOR_TIMEOUT_MS}ms. Final URL: ${page.url()} — page title: "${title}"`,
    );
  }

  // Reads DOM properties only. Inline script text is never touched: session
  // tokens are embedded near the campaign data in those scripts.
  const raw = await page.evaluate(() => {
    const editorEl = document.querySelector('campaign-editor') as {
      draftXml?: unknown;
      publishXml?: unknown;
    } | null;
    const shell = document.querySelector('#editor') as HTMLElement | null;

    const buildScript = [...document.scripts]
      .map((s) => s.src)
      .find((src) => src.includes('sysarch'));
    const buildMatch = buildScript ? /(\d+\.\d+\.\d+\.\d+-sysarch-\d+)/.exec(buildScript) : null;

    return {
      draftXml: typeof editorEl?.draftXml === 'string' ? editorEl.draftXml : '',
      publishXml: typeof editorEl?.publishXml === 'string' ? editorEl.publishXml : '',
      funnelName: shell?.dataset.funnelname ?? null,
      maxCellId: shell?.dataset.maxcellid ?? null,
      timezoneId: shell?.dataset.newtimezoneid ?? null,
      timezoneLabel: shell?.dataset.timezonelabel ?? null,
      appBuild: buildMatch?.[1] ?? null,
    };
  });

  if (raw.draftXml.length === 0) {
    throw new Error(`draftXml was empty for funnelId=${funnelId}`);
  }

  return {
    funnelId,
    ...raw,
    extractedAt: new Date().toISOString(),
    draftXmlSha256: createHash('sha256').update(raw.draftXml, 'utf8').digest('hex'),
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/extract/campaign.ts && git commit -m "feat: extract draftXml and editor metadata from the campaign editor page"
```

---

### Task 7: Fetch and parse decision criteria

**Files:**
- Create: `src/extract/decision.ts`
- Test: `test/decisionUrls.test.ts`

**Interfaces:**
- Consumes: `safeGet` from `src/guard/readonly.js`, `DecisionCell` from `src/parse/cells.js`, `parseDecisionHtml` + `DecisionCriteria` from `src/parse/decisionHtml.js`, `BASE_URL` from `src/config.js`
- Produces:
  - `decisionCandidateUrls(cell: DecisionCell, nowMs: number): string[]`
  - `isDecisionHtml(body: string): boolean`
  - `fetchDecision(context: BrowserContext, cell: DecisionCell, nowMs?: number): Promise<DecisionFetchResult>`
  - types `DecisionFetchAttempt`, `DecisionFetchResult`

The two pure helpers are unit tested; `fetchDecision` is verified by the real run in Task 9.

**Design note — content-based hit detection.** The app may return HTTP 200 with an error or session shell, so status code alone is not trusted. A response counts as a hit only if its body contains `decisionComponents` or `decisionIds`.

- [ ] **Step 1: Write the failing test**

Create `test/decisionUrls.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { decisionCandidateUrls, isDecisionHtml } from '../src/extract/decision.js';

const cell = { cellId: '34', name: 'Applied Already?', branches: [] };

describe('decisionCandidateUrls', () => {
  it('produces three candidates in the documented order', () => {
    const urls = decisionCandidateUrls(cell, 1_700_000_000_000);
    expect(urls).toHaveLength(3);
    expect(urls[0]).toContain('title=Applied%20Already%3F');
    expect(urls[1]).not.toContain('title=');
    expect(urls[2]).toContain('includePage=true');
  });

  it('always targets configureCell with metaType=decision', () => {
    for (const url of decisionCandidateUrls(cell, 1)) {
      expect(url).toContain('/app/funnel/configureCell?');
      expect(url).toContain('metaType=decision');
      expect(url).toContain('cellId=34');
    }
  });

  it('tolerates a cell with no name', () => {
    const urls = decisionCandidateUrls({ cellId: '7', name: null, branches: [] }, 1);
    expect(urls[0]).toContain('title=');
  });
});

describe('isDecisionHtml', () => {
  it('accepts a body containing the decision container', () => {
    expect(isDecisionHtml('<div id="decisionComponents"></div>')).toBe(true);
  });

  it('accepts a body containing the decision id input', () => {
    expect(isDecisionHtml('<input id="decisionIds" value="1"/>')).toBe(true);
  });

  it('rejects an unrelated page even when it returns 200', () => {
    expect(isDecisionHtml('<html><body>Session expired</body></html>')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/decisionUrls.test.ts`
Expected: FAIL — cannot resolve `../src/extract/decision.js`.

- [ ] **Step 3: Write the implementation**

Create `src/extract/decision.ts`:

```ts
import type { BrowserContext } from 'playwright';
import { BASE_URL } from '../config.js';
import { safeGet } from '../guard/readonly.js';
import type { DecisionCell } from '../parse/cells.js';
import { type DecisionCriteria, parseDecisionHtml } from '../parse/decisionHtml.js';

export interface DecisionFetchAttempt {
  url: string;
  status: number;
  bytes: number;
  hit: boolean;
}

export interface DecisionFetchResult {
  cellId: string;
  attempts: DecisionFetchAttempt[];
  /** Non-null only on a hit. */
  html: string | null;
  criteria: DecisionCriteria | null;
  /** Populated on a total miss so the caller can write them for inspection. */
  missBodies: string[];
}

/**
 * The decision-editor URL shape is INFERRED, not observed. The handoff captured
 * the configureCell pattern for a timerDelay cell only. These candidates are
 * tried in order and validated by content.
 */
export function decisionCandidateUrls(cell: DecisionCell, nowMs: number): string[] {
  const base = `${BASE_URL}/app/funnel/configureCell`;
  const stamp = String(nowMs);
  const common = `cellId=${encodeURIComponent(cell.cellId)}&metaType=decision`;
  const title = encodeURIComponent(cell.name ?? '');

  return [
    `${base}?${common}&title=${title}&timestamp=${stamp}&_=${stamp}`,
    `${base}?${common}&timestamp=${stamp}&_=${stamp}`,
    `${base}?${common}&includePage=true&timestamp=${stamp}&_=${stamp}`,
  ];
}

/** Status alone is not trusted: the app can return 200 with an error shell. */
export function isDecisionHtml(body: string): boolean {
  return /decisionComponents|decisionIds/.test(body);
}

export async function fetchDecision(
  context: BrowserContext,
  cell: DecisionCell,
  nowMs: number = Date.now(),
): Promise<DecisionFetchResult> {
  const attempts: DecisionFetchAttempt[] = [];
  const missBodies: string[] = [];

  for (const url of decisionCandidateUrls(cell, nowMs)) {
    const response = await safeGet(context, url);
    const body = await response.text();
    const hit = isDecisionHtml(body);

    attempts.push({ url, status: response.status(), bytes: body.length, hit });

    if (hit) {
      return {
        cellId: cell.cellId,
        attempts,
        html: body,
        criteria: parseDecisionHtml(body),
        missBodies: [],
      };
    }

    missBodies.push(body);
  }

  return { cellId: cell.cellId, attempts, html: null, criteria: null, missBodies };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/decisionUrls.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/extract/decision.ts test/decisionUrls.test.ts && git commit -m "feat: fetch decision criteria HTML via candidate configureCell URLs"
```

---

### Task 8: Spike orchestrator CLI

**Files:**
- Create: `src/cli/spike.ts`

**Interfaces:**
- Consumes: `openSession`/`closeSession` from `src/auth/session.js`, `extractCampaign` from `src/extract/campaign.js`, `fetchDecision` from `src/extract/decision.js`, `parseCells` from `src/parse/cells.js`
- Produces: the `npm run spike -- --funnel <id>` entry point and the `artifacts/<funnelId>/` layout

**Baseline reporting:** campaign 584 was recorded in the handoff at 11,185 chars / 43 `mxCell`, campaign 987 at 7,252 / 32. The CLI prints observed values next to the baseline as an informational delta. A divergence is *not* a failure — campaigns change between sessions — but it must be visible rather than silently accepted.

- [ ] **Step 1: Write the implementation**

Create `src/cli/spike.ts`:

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { closeSession, openSession } from '../auth/session.js';
import { extractCampaign } from '../extract/campaign.js';
import { type DecisionFetchResult, fetchDecision } from '../extract/decision.js';
import { parseCells } from '../parse/cells.js';

/** Recorded in keap-campaign-extractor-handoff.md §2 and §8. Informational only. */
const BASELINES: Record<string, { chars: number; cells: number }> = {
  '584': { chars: 11_185, cells: 43 },
  '987': { chars: 7_252, cells: 32 },
};

interface Args {
  funnelId: string;
  headed: boolean;
}

function parseArgs(argv: string[]): Args {
  const funnelIndex = argv.indexOf('--funnel');
  const funnelId = funnelIndex >= 0 ? argv[funnelIndex + 1] : undefined;
  if (!funnelId) {
    throw new Error('Usage: npm run spike -- --funnel <funnelId> [--headed]');
  }
  return { funnelId, headed: argv.includes('--headed') };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const outDir = join('artifacts', args.funnelId);
  const decisionsDir = join(outDir, 'decisions');
  await mkdir(decisionsDir, { recursive: true });

  const session = await openSession({ headless: !args.headed });
  let failed = false;

  try {
    const page = await session.context.newPage();
    const campaign = await extractCampaign(page, args.funnelId);
    const inventory = parseCells(campaign.draftXml);

    await writeFile(join(outDir, 'draft.xml'), campaign.draftXml, 'utf8');
    await writeFile(join(outDir, 'publish.xml'), campaign.publishXml, 'utf8');

    const { draftXml, publishXml, ...meta } = campaign;
    await writeFile(
      join(outDir, 'meta.json'),
      JSON.stringify(
        {
          ...meta,
          publishXmlLength: publishXml.length,
          neverPublished: publishXml.length === 0,
          inventory,
        },
        null,
        2,
      ),
      'utf8',
    );

    console.log(`\ncampaign ${args.funnelId} — "${campaign.funnelName ?? '(no name)'}"`);
    const baseline = BASELINES[args.funnelId];
    const cellCount = inventory.cellCount;
    if (baseline) {
      console.log(
        `  draftXml: ${draftXml.length} chars / ${cellCount} mxCell ` +
          `(handoff baseline ${baseline.chars} / ${baseline.cells}; ` +
          `delta ${draftXml.length - baseline.chars} chars, ${cellCount - baseline.cells} cells)`,
      );
    } else {
      console.log(`  draftXml: ${draftXml.length} chars / ${cellCount} mxCell (no baseline)`);
    }
    console.log(`  published: ${publishXml.length === 0 ? 'never' : `${publishXml.length} chars`}`);
    console.log(`  styles: ${JSON.stringify(inventory.styleCounts)}`);
    for (const warning of inventory.warnings) console.log(`  warning: ${warning}`);

    const results: DecisionFetchResult[] = [];
    for (const cell of inventory.decisions) {
      const result = await fetchDecision(session.context, cell);
      results.push(result);

      if (result.html && result.criteria) {
        await writeFile(join(decisionsDir, `${cell.cellId}.html`), result.html, 'utf8');
        await writeFile(
          join(decisionsDir, `${cell.cellId}.json`),
          JSON.stringify(result.criteria, null, 2),
          'utf8',
        );
        const hitIndex = result.attempts.findIndex((a) => a.hit);
        console.log(
          `  decision ${cell.cellId}: HIT on candidate ${hitIndex + 1} — ` +
            `${result.criteria.wrappers.length} branch(es)`,
        );
        console.log(`    url: ${result.attempts[hitIndex]?.url ?? '(unknown)'}`);
        for (const warning of result.criteria.warnings) console.log(`    warning: ${warning}`);
      } else {
        failed = true;
        console.log(`  decision ${cell.cellId}: MISS on all ${result.attempts.length} candidates`);
        for (const [i, attempt] of result.attempts.entries()) {
          console.log(`    [${i + 1}] ${attempt.status} ${attempt.bytes}B ${attempt.url}`);
          await writeFile(
            join(decisionsDir, `${cell.cellId}.attempt-${i + 1}.html`),
            result.missBodies[i] ?? '',
            'utf8',
          );
        }
      }
    }

    await writeFile(
      join(outDir, 'requests.log.json'),
      JSON.stringify(session.guard, null, 2),
      'utf8',
    );

    const nonGet = session.guard.blocked.filter((b) => b.reason === 'non-get');
    console.log(
      `\n  requests: ${session.guard.allowed.length} allowed, ` +
        `${session.guard.blocked.length} blocked (${nonGet.length} non-GET)`,
    );
    console.log(`  artifacts: ${outDir}\n`);
  } catch (error) {
    failed = true;
    console.error(`\nspike failed: ${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    await closeSession(session);
  }

  process.exitCode = failed ? 1 : 0;
}

await main();
```

- [ ] **Step 2: Typecheck and run the full suite**

Run: `npm run typecheck && npm test`
Expected: PASS, no type errors, 34 tests (7 guard + 12 cells + 9 decisionHtml + 6 decisionUrls).

- [ ] **Step 3: Verify the CLI rejects bad input without launching a browser**

Run: `npm run spike`
Expected: exits with the usage message `Usage: npm run spike -- --funnel <funnelId> [--headed]`. No Chromium window opens.

- [ ] **Step 4: Commit**

```bash
git add src/cli/spike.ts && git commit -m "feat: add spike orchestrator writing raw artifacts and a request log"
```

---

### Task 9: Real extraction run and fixture promotion

**Files:**
- Create: `test/fixtures/campaign-584-draft.xml` (copied from a real run)
- Create: `test/fixtures/campaign-987-draft.xml` (copied from a real run)
- Create: `test/fixtures/decision-987-34.html` (copied from a real run, on a decision hit)
- Modify: `test/cells.test.ts` (append real-fixture assertions)
- Modify: `test/decisionHtml.test.ts` (append real-fixture assertions, on a hit)
- Create: `docs/spike-findings.md`

**Interfaces:**
- Consumes: everything built in Tasks 1–8
- Produces: the fixture set for the stage-2 normaliser, and a findings document recording whether the decision-editor URL guess held.

This task requires a valid `storageState.json` from Task 5. If the session has expired, re-run `npm run login` first.

- [ ] **Step 1: Extract campaign 584**

Run: `npm run spike -- --funnel 584`

Expected: `artifacts/584/draft.xml` written; the summary prints the char/cell delta against the 11,185 / 43 baseline; `styles` includes `decision`.

**If the run fails**, do not proceed. Read the error — it names the failing stage (session expiry, editor timeout, or empty `draftXml`) and includes the final URL and page title.

- [ ] **Step 2: Extract campaign 987**

Run: `npm run spike -- --funnel 987`

Expected: `artifacts/987/draft.xml` written, and decision cell `34` reported with branches `479 -> 3` and `481 -> 32`.

- [ ] **Step 3: Verify the read-only guard held**

```bash
node --input-type=module -e "import{readFileSync}from'node:fs';const j=JSON.parse(readFileSync('artifacts/987/requests.log.json','utf8'));const bad=j.allowed.filter(r=>r.method!=='GET');console.log('non-GET allowed:',bad.length);console.log(JSON.stringify(bad,null,2));"
```

Expected: `non-GET allowed: 0`. Anything else means the guard has a hole — **stop and fix it before continuing**.

- [ ] **Step 4: Record the decision-URL outcome**

Read the `decision 34:` line from the Step 2 output.

**On HIT:** note which candidate index won and its exact URL. Compare `artifacts/987/decisions/34.json` against the handoff §5.6 worked example — it should show tag `1123` with `notContains` routing to flow `3`, `contains` routing to flow `32`, and an else branch of "Don't put them in a sequence".

**On MISS:** inspect the three saved bodies:

```bash
head -c 400 artifacts/987/decisions/34.attempt-1.html; echo; head -c 400 artifacts/987/decisions/34.attempt-2.html; echo; head -c 400 artifacts/987/decisions/34.attempt-3.html
```

A miss is an acceptable spike outcome. It converts an unknown into a bounded next step — the documented fallback is a one-off run that opens the decision editor through the UI with Playwright's request log recording the real URL. Record that as the follow-up; do not attempt it in this task.

- [ ] **Step 5: Promote artifacts to committed fixtures**

```bash
cp artifacts/584/draft.xml test/fixtures/campaign-584-draft.xml && cp artifacts/987/draft.xml test/fixtures/campaign-987-draft.xml
```

On a decision HIT, also:

```bash
cp artifacts/987/decisions/34.html test/fixtures/decision-987-34.html
```

Keep the synthetic fixtures. They cover edge cases (unknown styles, unconfigured decisions, multi-value rules) that the real campaigns may not exercise.

- [ ] **Step 6: Add real-fixture regression tests**

Append to `test/cells.test.ts`:

```ts
describe('parseCells against real campaign 987', () => {
  const realXml = readFileSync(
    new URL('./fixtures/campaign-987-draft.xml', import.meta.url),
    'utf8',
  );

  it('finds decision cell 34 with the documented routing', () => {
    const cell = parseCells(realXml).decisions.find((d) => d.cellId === '34');
    expect(cell?.branches).toEqual([
      { decisionId: '479', flowId: '3' },
      { decisionId: '481', flowId: '32' },
    ]);
  });

  it('parses without producing an unknown-style crash', () => {
    const inventory = parseCells(realXml);
    expect(inventory.cellCount).toBeGreaterThan(0);
    expect(Object.keys(inventory.styleCounts).length).toBeGreaterThan(1);
  });
});
```

On a decision HIT, also append to `test/decisionHtml.test.ts`:

```ts
describe('parseDecisionHtml against real decision 987/34', () => {
  const realHtml = readFileSync(
    new URL('./fixtures/decision-987-34.html', import.meta.url),
    'utf8',
  );

  it('reproduces the handoff worked example', () => {
    const result = parseDecisionHtml(realHtml);
    expect(result.wrappers).toHaveLength(2);
    expect(result.wrappers[0]?.flowId).toBe('3');
    expect(result.wrappers[1]?.flowId).toBe('32');
    const firstRule = result.wrappers[0]?.any[0]?.all[0];
    expect(firstRule?.constraint).toBe('notContains_Constraint');
    expect(firstRule?.values[0]?.id).toBe('1123');
  });
});
```

- [ ] **Step 7: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS, all tests including the new real-fixture ones.

- [ ] **Step 8: Write the findings document**

Create `docs/spike-findings.md` recording, with actual observed values:

- The decision-editor URL outcome — the winning candidate and its exact URL, or all three failing responses with status and byte count. This closes or re-scopes handoff §14 Q1.
- Observed `styleCounts` across both campaigns, and any style not in the handoff's list of 10. This starts answering handoff §14 Q4.
- Whether `publishXml` was empty for both campaigns (handoff §14 Q5).
- The blocked-request tally, confirming zero non-GET requests reached the network.
- Any `warnings` emitted by either parser.
- The char/cell deltas against the handoff baselines.

- [ ] **Step 9: Commit**

```bash
git add test/fixtures/ test/cells.test.ts test/decisionHtml.test.ts docs/spike-findings.md && git commit -m "test: add real campaign fixtures and record spike findings"
```

Note the `git add` deliberately names paths. Never use `git add -A` in this repo — `artifacts/` and `storageState.json` are gitignored, but explicit paths remove any chance of a rule regression exposing session cookies.

---

## Definition of Done

The spike is complete when every box above is checked and:

1. `npm run login` produces a reusable `storageState.json` (Task 5, Step 5).
2. `npm run spike -- --funnel 584` writes a non-empty, parseable `draft.xml` (Task 9, Step 1).
3. `parseCells` finds decision cell 13 in campaign 584 — verify in `artifacts/584/meta.json`.
4. Campaign 987 yields decision cell 34 with branches `479 -> 3`, `481 -> 32` (Task 9, Step 6).
5. The decision-editor URL question is answered either way, with evidence, in `docs/spike-findings.md`.
6. `requests.log.json` shows zero non-GET requests allowed (Task 9, Step 3).
7. `npm test` passes offline.

Criterion 5 is the one that can legitimately land as a documented failure rather than a success. That is a valid outcome — the point is to replace a guess with evidence.
