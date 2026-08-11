# Renderers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the 170 normalized campaigns into one readable Markdown page each — a Mermaid diagram, the structure in English, and what the campaign connects to — written to `artifacts/<app>/rendered/`.

**Architecture:** Five small pure modules under `src/render/`, each with one job: text hygiene, type labels, per-node prose, the diagram, the page. A sixth assembles the index. Only the CLI touches the filesystem. Nothing touches the network, and every module is testable against the corpus already on disk.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node ≥20, vitest, tsx. No new dependencies.

## Global Constraints

- **No network access.** Inputs are `normalized/*.json`, `graph.json` and optionally `entities.json`.
- **Never print an internal style name** for any style in the label tables. `newsletterRequest` and `indicateInterest` must not appear in output.
- **Never paraphrase intent.** The renderer derives *what* a node does and quotes the operator's own words for *why*. Inferring purpose is the LLM pass and is out of scope.
- **Never guess a type label.** A style in neither table renders as its raw style name so it asks to be added.
- **Timers render verbatim from `name`.** No arithmetic — Keap already wrote the English, and handoff §14 Q2's timezone question is unresolved.
- **The existing 283 tests must pass unchanged.** This work adds modules; it changes no existing behavior.
- Import specifiers carry `.js` even for TypeScript sources (`./text.js`).
- US spelling in identifiers and prose (`catalog`, `normalize`, `labeled`).
- `npm run typecheck` and `npm test` pass at the end of every task.

---

## Context an implementer needs

**Everything here is measured from the corpus, not assumed.**

**1. HTML entities survive into the normalized data — in labels, not just note bodies.** `cleanName`
(`src/parse/cells.ts:38`) strips `~br~` and collapses whitespace, but does nothing about entities. So
these are real strings in `normalized/*.json`:

```
"Wait until 3 days before the contact&#39;s next Birthday and then run at 8:00 AM"
"Request our Email Series \"How to generate leads online\""
"I haven&#39;t heard back?"
```

**76 labels** contain characters hostile to Mermaid or Markdown, and **95 note bodies** contain
entities or inline HTML. The design doc treats decoding as a notes concern; it is a text concern.
Task 1 handles it once, for everything.

**2. One style can mean several things.** `newsletterRequest` (205 nodes) is a web form submission
when it carries `webformId` (106), a landing page when it carries `landingPageId` (20), an internal
form when it carries `internalFormId` (7), and unconfigured when it carries nothing (69). So
`typeLabel` takes a **node**, not a style.

**3. Keap has shipped several builders.** `email`, `bardEmail` and `unlayerEmail` all reference
`marketingEmailId` and are all just "Email". `landingPage` and `convrrtLandingPage` are both landing
pages. The generation is an implementation detail no reader needs.

**4. Names are the primary label, and Keap writes timer descriptions into them.** 83% of goals and
steps carry a `name`, and for timers it is already a full English sentence — `"Wait at least 3 days
and then run on a weekday at 8:00 AM"`. Four cases need a template because `name` is absent or
useless: `tag` (0 of 241 named), `notes`/`note` (body is in `config.notes`), `email` family (98 are
literally "Untitled Email"), and `decision` (routing is not a name).

**5. Campaign sizes.** Median 14 renderable nodes and 4 campaign-level edges; only 14 of 170 exceed
50 nodes. The diagram covers the campaign level only — goals, decisions and sequences — which is what
keeps the largest legible.

**Expected corpus results**, for Task 7 to check against:

| | |
|---|---|
| Pages written | 170 + index |
| Campaigns with a diagram | 170 |
| Notes rendered | 198, of which 95 needed decoding |
| Labels needing escape | 76 |

---

## File Structure

| File | Responsibility |
|---|---|
| `src/render/text.ts` (create) | Decode entities, strip inline tags, escape Mermaid labels, truncate. The only place text hygiene lives. |
| `src/render/labels.ts` (create) | `typeLabel(node)` — style families and reference resolution. The one hardcoded block anyone can correct on sight. |
| `src/render/prose.ts` (create) | `describeNode(node, ctx)` — one node, one English line. |
| `src/render/mermaid.ts` (create) | `renderMermaid(campaign, ctx)` — the campaign-level flowchart. |
| `src/render/campaignDoc.ts` (create) | `renderCampaign(...)` — assembles one page. |
| `src/render/indexDoc.ts` (create) | `renderIndex(...)` — the account listing. |
| `src/cli/render.ts` (create) | Reads artifacts, writes `rendered/`. The only impure file. |
| `package.json` (modify) | Add the `render` script. |

---

### Task 1: Text hygiene

Everything downstream renders text, and every piece of it can contain entities, inline HTML, quotes
and Mermaid metacharacters. Getting this wrong is the `stripLongSuffix` failure mode again: silent
corruption that looks like working output.

**Files:**
- Create: `src/render/text.ts`
- Test: `test/renderText.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `decodeEntities(text: string): string`, `stripTags(text: string): string`, `plainText(text: string): string`, `escapeMermaid(text: string): string`, `truncate(text: string, max: number): string`.

- [ ] **Step 1: Write the failing test**

Create `test/renderText.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  decodeEntities,
  escapeMermaid,
  plainText,
  stripTags,
  truncate,
} from '../src/render/text.js';

describe('decodeEntities', () => {
  it('decodes the entities that actually occur in the corpus', () => {
    // Real strings from normalized/*.json — cleanName strips ~br~ but not these.
    expect(decodeEntities('the contact&#39;s next Birthday')).toBe("the contact's next Birthday");
    expect(decodeEntities('&quot;No Show Sequence&quot;')).toBe('"No Show Sequence"');
    expect(decodeEntities('Tom &amp; Jerry')).toBe('Tom & Jerry');
    expect(decodeEntities('&lt;b&gt;bold&lt;/b&gt;')).toBe('<b>bold</b>');
  });

  it('decodes numeric and hex forms', () => {
    expect(decodeEntities('caf&#233;')).toBe('café');
    expect(decodeEntities('caf&#xe9;')).toBe('café');
  });

  it('leaves a bare ampersand alone', () => {
    expect(decodeEntities('R&D budget')).toBe('R&D budget');
  });

  it('decodes &amp;#39; to an apostrophe, not to &#39;', () => {
    // Double-encoded input must not stop half-way and leave a visible entity.
    expect(decodeEntities('it&amp;#39;s')).toBe("it's");
  });
});

describe('stripTags', () => {
  it('removes inline markup and keeps the words', () => {
    expect(stripTags('set the event date as <b>November 14th, 2012</b>.')).toBe(
      'set the event date as November 14th, 2012.',
    );
  });

  it('turns block breaks into spaces rather than joining words', () => {
    expect(stripTags('line one<br>line two')).toBe('line one line two');
    expect(stripTags('<p>one</p><p>two</p>')).toBe('one two');
  });
});

describe('plainText', () => {
  it('decodes then strips, and collapses the whitespace that leaves', () => {
    expect(plainText('I&#39;ve set it as <b>November</b>.  Everything follows.')).toBe(
      "I've set it as November. Everything follows.",
    );
  });

  it('returns an empty string for nothing', () => {
    expect(plainText('')).toBe('');
    expect(plainText('   ')).toBe('');
  });
});

describe('escapeMermaid', () => {
  it('neutralizes quotes, which would end the label early', () => {
    expect(escapeMermaid('Request our Email Series "How to generate leads online"')).toBe(
      'Request our Email Series #quot;How to generate leads online#quot;',
    );
  });

  it('neutralizes the characters Mermaid reads as syntax', () => {
    expect(escapeMermaid('a->b')).not.toContain('->');
    expect(escapeMermaid('#hash')).not.toMatch(/^#hash/);
    for (const char of ['[', ']', '{', '}', '(', ')', '|']) {
      expect(escapeMermaid(`x${char}y`), char).not.toContain(char);
    }
  });

  it('decodes entities first, so no label shows &#39;', () => {
    expect(escapeMermaid('I haven&#39;t heard back?')).toBe("I haven't heard back?");
  });

  it('flattens newlines, which would break the node definition', () => {
    expect(escapeMermaid('one\ntwo')).toBe('one two');
  });

  it('leaves ordinary text untouched', () => {
    expect(escapeMermaid('Application Received')).toBe('Application Received');
  });
});

describe('truncate', () => {
  it('shortens with an ellipsis and never exceeds the limit', () => {
    const long = 'Wait at least 3 days and then run on a weekday at 8:00 AM';
    expect(truncate(long, 20)).toHaveLength(20);
    expect(truncate(long, 20).endsWith('…')).toBe(true);
  });

  it('leaves short text alone', () => {
    expect(truncate('short', 20)).toBe('short');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/renderText.test.ts
```

Expected: FAIL — `Cannot find module '../src/render/text.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/render/text.ts`:

```ts
/**
 * Named entities that actually occur in this corpus, plus the handful any HTML
 * source produces. Numeric and hex forms are handled separately.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
};

/**
 * Decodes HTML entities.
 *
 * These survive into the normalized data: `cleanName` strips `~br~` and
 * collapses whitespace but does nothing about entities, so 76 labels and 95
 * note bodies still carry them. Emitted raw, a timer reads "the contact&#39;s
 * next Birthday".
 *
 * Runs repeatedly so double-encoded input ("it&amp;#39;s") resolves fully
 * rather than stopping half-way and leaving a visible entity. Capped, because
 * a crafted string could otherwise loop.
 */
export function decodeEntities(text: string): string {
  let current = text;
  for (let pass = 0; pass < 3; pass++) {
    const next = current.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
      const token = body.toLowerCase();
      if (token.startsWith('#x')) {
        const code = Number.parseInt(token.slice(2), 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      if (token.startsWith('#')) {
        const code = Number.parseInt(token.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      return NAMED_ENTITIES[token] ?? match;
    });
    if (next === current) return current;
    current = next;
  }
  return current;
}

/**
 * Removes inline markup, keeping the words.
 *
 * Block-level tags become a space rather than nothing, so "<p>one</p><p>two</p>"
 * does not become "onetwo".
 */
export function stripTags(text: string): string {
  return text
    .replace(/<(br|p|div|li|tr)\b[^>]*>/gi, ' ')
    .replace(/<\/(p|div|li|tr)>/gi, ' ')
    .replace(/<[^>]*>/g, '');
}

/** Decode, strip, collapse. The standard treatment for any text from Keap. */
export function plainText(text: string): string {
  return stripTags(decodeEntities(text)).replace(/\s+/g, ' ').trim();
}

/**
 * Makes a string safe inside a quoted Mermaid label.
 *
 * Mermaid reads `"`, `#`, brackets, braces, parentheses, `|` and `->` as
 * syntax. Unescaped, it renders the wrong diagram or nothing at all — and
 * reports no error, which is why this is tested against the ugliest names
 * actually in the corpus rather than invented ones.
 */
export function escapeMermaid(text: string): string {
  return plainText(text)
    .replace(/#/g, '#35;')
    .replace(/"/g, '#quot;')
    .replace(/->/g, '→')
    .replace(/[[\]{}()|]/g, (char) => `#${char.charCodeAt(0)};`);
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run test/renderText.test.ts && npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Prove it against every label in the real corpus**

```bash
node --input-type=module -e "
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
const {escapeMermaid}=await import('./src/render/text.ts').catch(()=>({}));
" 2>/dev/null || npx tsx -e "
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {escapeMermaid} from './src/render/text.js';
const dir='artifacts/jordan/normalized';
let checked=0, bad=0;
for(const f of readdirSync(dir).filter(x=>x.endsWith('.json'))){
  const c=JSON.parse(readFileSync(join(dir,f),'utf8'));
  for(const n of [...c.goals,...c.decisions,...c.sequences,...c.sequences.flatMap(s=>s.steps)]){
    if(!n.name) continue;
    checked++;
    const out=escapeMermaid(n.name);
    if(/[\"#\[\]{}()|]|->|&#|&[a-z]+;/.test(out)) { bad++; if(bad<4) console.log('LEAK:', JSON.stringify(out)); }
  }
}
console.log('labels checked:', checked, '| still containing a hostile character:', bad);
"
```

Expected: `still containing a hostile character: 0`. Any leak is a bug in `escapeMermaid`, not in the data.

- [ ] **Step 6: Commit**

```bash
git add src/render/text.ts test/renderText.test.ts
git commit -m "feat: text hygiene for rendering — entities, tags, Mermaid escaping"
```

---

### Task 2: Type labels

**Files:**
- Create: `src/render/labels.ts`
- Test: `test/renderLabels.test.ts`

**Interfaces:**
- Consumes: `NormalizedNode` from `src/normalize/nodes.js`.
- Produces: `typeLabel(node: NormalizedNode): string`, `STYLE_LABELS: Record<string, string>`, `SUBMISSION_STYLES: Set<string>`.

- [ ] **Step 1: Write the failing test**

Create `test/renderLabels.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { STYLE_LABELS, typeLabel } from '../src/render/labels.js';
import { makeNode } from './fixtures/graphFixtures.js';

const node = (style: string, references: Record<string, string> = {}) =>
  makeNode({ style, references: { tagIds: [], tagCategoryIds: [], ...references } });

describe('typeLabel', () => {
  it('collapses every email builder generation to one label', () => {
    // Keap has shipped several email builders over the years. The generation
    // is an implementation detail; all three reference marketingEmailId.
    for (const style of ['email', 'bardEmail', 'unlayerEmail']) {
      expect(typeLabel(node(style, { marketingEmailId: '1200' })), style).toBe('Email');
    }
  });

  it('collapses both landing page builders to one label', () => {
    expect(typeLabel(node('landingPage', { landingPageId: '42' }))).toBe('Landing page submitted');
    expect(typeLabel(node('convrrtLandingPage'))).toBe('Landing page submitted');
  });

  it('resolves a submission style by what it actually references', () => {
    // newsletterRequest is a web form 106 times, a landing page 20 times and an
    // internal form 7 times. The style alone cannot say which.
    expect(typeLabel(node('newsletterRequest', { webformId: '681' }))).toBe('Web form submitted');
    expect(typeLabel(node('newsletterRequest', { landingPageId: '42' }))).toBe(
      'Landing page submitted',
    );
    expect(typeLabel(node('newsletterRequest', { internalFormId: '3' }))).toBe(
      'Internal form submitted',
    );
  });

  it('says so when a submission references nothing, rather than guessing', () => {
    // 69 of 205 newsletterRequest nodes carry no reference at all.
    expect(typeLabel(node('newsletterRequest'))).toBe('Form submitted (unconfigured)');
  });

  it('uses Keap own default wording for the plain cases', () => {
    expect(typeLabel(node('http'))).toBe('Send HTTP Post');
    expect(typeLabel(node('task'))).toBe('Create Task');
    expect(typeLabel(node('tag', { }))).toBe('Tag applied');
    expect(typeLabel(node('fulfillment'))).toBe('Fulfillment List');
  });

  it('falls back to the raw style for anything unknown, so it asks to be added', () => {
    expect(typeLabel(node('somethingKeapAddedLater'))).toBe('somethingKeapAddedLater');
  });

  it('never emits a legacy internal style name for a style it knows', () => {
    const forbidden = ['newsletterRequest', 'indicateInterest', 'bardEmail', 'unlayerEmail'];
    for (const style of forbidden) {
      expect(typeLabel(node(style, { webformId: '1' })), style).not.toContain(style);
    }
  });

  it('keeps the four stageId styles distinct until the UI question is settled', () => {
    // Most instances leave stageId unset — 7 of 82 for indicateInterest, 2 of
    // 13 for fileDownload — so calling them all "stage move" would misdescribe
    // the majority.
    const labels = ['stageMove', 'makeCall', 'indicateInterest', 'fileDownload'].map((s) =>
      typeLabel(node(s)),
    );
    expect(new Set(labels).size).toBe(4);
    expect(labels).not.toContain('indicateInterest');
  });
});

describe('STYLE_LABELS', () => {
  it('is a plain table anyone can correct without reading code', () => {
    expect(STYLE_LABELS.http).toBe('Send HTTP Post');
    expect(Object.values(STYLE_LABELS).every((v) => typeof v === 'string')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/renderLabels.test.ts
```

Expected: FAIL — `Cannot find module '../src/render/labels.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/render/labels.ts`:

```ts
import type { NormalizedNode } from '../normalize/nodes.js';

/**
 * Styles whose meaning depends on what they reference, not on the style.
 *
 * `newsletterRequest` is a web form submission 106 times, a landing page 20
 * times and an internal form 7 times across this corpus. The legacy style name
 * describes none of them.
 */
export const SUBMISSION_STYLES = new Set(['newsletterRequest', 'requestInfo']);

/**
 * What each style is called in output.
 *
 * Wording comes from Keap's own default names wherever possible — the most
 * common `name` across nodes of that style. Several styles collapse together
 * because Keap has shipped multiple builders over the years and the generation
 * is an implementation detail no reader needs.
 *
 * CORRECT THIS TABLE ON SIGHT if you know the builder. Nothing else in the
 * renderer depends on the wording, and a style missing here falls through to
 * its raw name rather than being guessed at.
 *
 * Known-unsettled: stageMove, makeCall, indicateInterest and fileDownload all
 * carry an optional stageId that most instances leave unset. They may be one
 * goal type in the current UI or four; until that is answered they stay
 * distinct, because calling them all "stage move" would misdescribe the
 * majority that move no stage.
 */
export const STYLE_LABELS: Record<string, string> = {
  // Email — three builder generations, one meaning
  email: 'Email',
  bardEmail: 'Email',
  unlayerEmail: 'Email',
  emailConfirm: 'Confirmation email',
  confirmEmail: 'Email confirmed',
  // Landing pages — two builder generations
  landingPage: 'Landing page submitted',
  convrrtLandingPage: 'Landing page submitted',
  // Timers
  timerDelay: 'Wait',
  timerDate: 'Wait until date',
  timerContact: 'Wait until contact date',
  // Tags and notes
  tag: 'Tag applied',
  tagApplied: 'Tag applied (goal)',
  notes: 'Note',
  note: 'Apply note',
  noteApplied: 'Note applied',
  // Actions
  http: 'Send HTTP Post',
  task: 'Create Task',
  taskComplete: 'Task completed',
  fulfillment: 'Fulfillment List',
  actionSet: 'Apply Action Set',
  fieldValue: 'Set Field Value',
  assignOwner: 'Assign an Owner',
  opportunity: 'Create Opportunity',
  createOrder: 'Create Order',
  addToSequence: 'Add to Sequence',
  cancelSubscription: 'Cancel subscription',
  customerHub: 'Add to CustomerHub',
  letter: 'Letter',
  voice: 'Voice broadcast',
  fax: 'Fax',
  // Goals
  internalForm: 'Internal form submitted',
  purchaseSuccess: 'Purchase made',
  failedPurchase: 'Purchase failed',
  eventRequest: 'Event registration',
  eventAttend: 'Event attended',
  liveEvent: 'Live event',
  meetingRequest: 'Appointment scheduled',
  meetingAttend: 'Appointment attended',
  linkClick: 'Link clicked',
  fileDownload: 'File downloaded',
  scoreAchieved: 'Lead score reached',
  websiteTrigger: 'Web page automation',
  website: 'Website',
  api: 'API',
  blog: 'Blog',
  facebook: 'Facebook',
  facebookParticipate: 'Facebook promotion',
  twitter: 'Twitter',
  radioAd: 'Radio ad',
  existingList: 'Existing list',
  goal: 'Goal',
  decision: 'Decision',
  // The unsettled stageId group — see the note above
  stageMove: 'Opportunity stage moved',
  makeCall: 'Call made',
  indicateInterest: 'Interest indicated',
};

/** Which entity a submission-style node actually points at. */
function submissionLabel(node: NormalizedNode): string {
  const { references } = node;
  if (typeof references.webformId === 'string') return 'Web form submitted';
  if (typeof references.landingPageId === 'string') return 'Landing page submitted';
  if (typeof references.internalFormId === 'string') return 'Internal form submitted';
  return 'Form submitted (unconfigured)';
}

/**
 * What this node does, in words a Keap operator would recognize.
 *
 * Takes a node rather than a style because one style can mean several things.
 * Never returns an internal style name for a style in the tables; an unknown
 * style returns its raw name so it is visibly odd and asks to be added.
 */
export function typeLabel(node: NormalizedNode): string {
  if (SUBMISSION_STYLES.has(node.style)) return submissionLabel(node);
  return STYLE_LABELS[node.style] ?? node.style;
}
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run test/renderLabels.test.ts && npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/labels.ts test/renderLabels.test.ts
git commit -m "feat: type labels derived from style and references"
```

---

### Task 3: Per-node prose

**Files:**
- Create: `src/render/prose.ts`
- Test: `test/renderProse.test.ts`

**Interfaces:**
- Consumes: `typeLabel` from `./labels.js`, `plainText`/`truncate` from `./text.js`, `NormalizedNode`.
- Produces:
  - `interface ProseContext { names: Map<string, string> }`
  - `nameIndex(catalog?: EntityCatalog): Map<string, string>`
  - `describeNode(node: NormalizedNode, context: ProseContext): string`

- [ ] **Step 1: Write the failing test**

Create `test/renderProse.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { EntityCatalog } from '../src/api/catalog.js';
import { describeNode, nameIndex } from '../src/render/prose.js';
import { makeNode } from './fixtures/graphFixtures.js';

const ctx = (pairs: [string, string][] = []) => ({ names: new Map(pairs) });
const node = (
  style: string,
  overrides: { name?: string | null; config?: Record<string, string>; refs?: Record<string, string | string[]> } = {},
) =>
  makeNode({
    style,
    name: overrides.name ?? null,
    config: overrides.config ?? {},
    references: { tagIds: [], tagCategoryIds: [], ...(overrides.refs ?? {}) },
  });

describe('describeNode', () => {
  it('leads with the operator name, which is the why', () => {
    expect(describeNode(node('email', { name: 'Tip 1', refs: { marketingEmailId: '1200' } }), ctx())).toContain(
      'Tip 1',
    );
  });

  it('states what the node does alongside it', () => {
    expect(describeNode(node('http', { name: 'SMS Reminder' }), ctx())).toBe(
      'Send HTTP Post — "SMS Reminder"',
    );
  });

  it('renders a timer verbatim, doing no arithmetic', () => {
    // Keap already wrote the English. Recomputing it would risk contradicting
    // the builder over the unresolved timezone question in handoff Q2.
    const name = 'Wait at least 3 days and then run on a weekday at 8:00 AM';
    expect(describeNode(node('timerDelay', { name }), ctx())).toContain(name);
  });

  it('decodes entities in a name', () => {
    const out = describeNode(
      node('timerContact', { name: 'Wait until 3 days before the contact&#39;s next Birthday' }),
      ctx(),
    );
    expect(out).toContain("contact's next Birthday");
    expect(out).not.toContain('&#39;');
  });

  it('names the tag on an apply-tag step, which has no name of its own', () => {
    // 0 of 241 tag steps carry a name. Without the reference there is nothing.
    const step = node('tag', { config: { isApply: 'true' }, refs: { tagIds: ['646'] } });
    expect(describeNode(step, ctx([['tag:646', 'Bought']]))).toBe('Applies tag "Bought"');
  });

  it('distinguishes removing a tag from applying one', () => {
    const step = node('tag', { config: { isApply: 'false' }, refs: { tagIds: ['646'] } });
    expect(describeNode(step, ctx([['tag:646', 'Bought']]))).toBe('Removes tag "Bought"');
  });

  it('falls back to the tag id when no catalog name is known', () => {
    const step = node('tag', { config: { isApply: 'true' }, refs: { tagIds: ['646'] } });
    expect(describeNode(step, ctx())).toBe('Applies tag 646');
  });

  it('says a tag step is unconfigured when it references nothing', () => {
    expect(describeNode(node('tag', { config: { isApply: 'true' } }), ctx())).toBe(
      'Tag applied — not configured',
    );
  });

  it('renders a note body from config, decoded and stripped', () => {
    const body = 'I&#39;ve set the event date as <b>November 14th, 2012</b>.';
    expect(describeNode(node('notes', { config: { notes: body } }), ctx())).toBe(
      'Note: I\'ve set the event date as November 14th, 2012.',
    );
  });

  it('prefers the catalog email name over "Untitled Email"', () => {
    // 98 email steps are literally named "Untitled Email".
    const step = node('email', { name: 'Untitled Email', refs: { marketingEmailId: '1200' } });
    expect(describeNode(step, ctx([['email:1200', 'Welcome 1']]))).toBe('Email — "Welcome 1"');
  });

  it('keeps a real email name when the operator set one', () => {
    const step = node('email', { name: 'Tip 1', refs: { marketingEmailId: '1200' } });
    expect(describeNode(step, ctx([['email:1200', 'Welcome 1']]))).toBe('Email — "Tip 1"');
  });

  it('describes a node with no name by its type alone', () => {
    expect(describeNode(node('fulfillment'), ctx())).toBe('Fulfillment List');
  });

  it('never emits a legacy style name', () => {
    const goal = node('newsletterRequest', { name: 'Request E-Book', refs: { webformId: '681' } });
    const out = describeNode(goal, ctx([['webform:681', 'E-Book form']]));
    expect(out).not.toContain('newsletterRequest');
    expect(out).toBe('Web form submitted — "Request E-Book" (E-Book form)');
  });
});

describe('nameIndex', () => {
  it('maps entity ids to names from the catalog', () => {
    const catalog = {
      appName: 'jordan',
      fetchedAt: '2026-08-06T00:00:00.000Z',
      sources: {},
      warnings: [],
      entities: [{ id: 'tag:646', kind: 'tag' as const, name: 'Bought', extra: {} }],
    } satisfies EntityCatalog;
    expect(nameIndex(catalog).get('tag:646')).toBe('Bought');
  });

  it('is empty when there is no catalog', () => {
    expect(nameIndex(undefined).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/renderProse.test.ts
```

Expected: FAIL — `Cannot find module '../src/render/prose.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/render/prose.ts`:

```ts
import type { EntityCatalog } from '../api/catalog.js';
import { entityId } from '../normalize/graphEdges.js';
import type { NormalizedNode } from '../normalize/nodes.js';
import { typeLabel } from './labels.js';
import { plainText, truncate } from './text.js';

const NOTE_STYLES = new Set(['notes', 'note']);
const EMAIL_STYLES = new Set(['email', 'bardEmail', 'unlayerEmail']);

/** Longest note body rendered inline before it is cut. */
const NOTE_LIMIT = 300;

export interface ProseContext {
  /** entity id → display name. Empty means ids only. */
  names: Map<string, string>;
}

export function nameIndex(catalog?: EntityCatalog): Map<string, string> {
  const index = new Map<string, string>();
  for (const entity of catalog?.entities ?? []) {
    if (entity.name !== null) index.set(entity.id, entity.name);
  }
  return index;
}

/** The catalog name for a reference, falling back to the bare id. */
function referenceLabel(
  context: ProseContext,
  kind: Parameters<typeof entityId>[0],
  id: string,
): string {
  return context.names.get(entityId(kind, id)) ?? id;
}

/**
 * One node, one line of English.
 *
 * Leads with what the node DOES, derived from style and references, then
 * quotes the operator's own name — which is the only record of WHY. The name
 * is never paraphrased; inferring intent is the LLM pass, not this.
 */
export function describeNode(node: NormalizedNode, context: ProseContext): string {
  const label = typeLabel(node);
  const name = node.name === null ? null : plainText(node.name);

  // A tag step carries no name at all — 0 of 241 in the corpus — so the tag it
  // points at is the entire content of the line.
  if (node.style === 'tag') {
    const [tagId] = node.references.tagIds;
    if (tagId === undefined) return `${label} — not configured`;
    const verb = node.config.isApply === 'false' ? 'Removes' : 'Applies';
    const tag = referenceLabel(context, 'tag', tagId);
    return `${verb} tag ${tag === tagId ? tagId : `"${tag}"`}`;
  }

  // A note keeps its body in config.notes rather than name, and that body is
  // HTML — the handoff calls these the highest-signal text in the corpus.
  if (NOTE_STYLES.has(node.style)) {
    const body = plainText(node.config.notes ?? '');
    if (body === '') return name === null ? label : `${label} — "${name}"`;
    return `Note: ${truncate(body, NOTE_LIMIT)}`;
  }

  // 98 email steps are literally called "Untitled Email", so the catalog name
  // is better whenever the operator did not choose one.
  if (EMAIL_STYLES.has(node.style)) {
    const emailId = node.references.marketingEmailId;
    const catalogName =
      typeof emailId === 'string' ? context.names.get(entityId('email', emailId)) : undefined;
    const chosen = name === null || /^untitled/i.test(name) ? (catalogName ?? name) : name;
    return chosen === null || chosen === undefined ? label : `${label} — "${chosen}"`;
  }

  // Everything else: the type, the operator's words, and the entity it points
  // at when we can name it.
  const parts: string[] = [label];
  if (name !== null) parts.push(`— "${name}"`);

  for (const [attribute, kind] of [
    ['webformId', 'webform'],
    ['landingPageId', 'landingPage'],
    ['internalFormId', 'form'],
    ['purchaseId', 'product'],
    ['userId', 'user'],
  ] as const) {
    const value = node.references[attribute];
    if (typeof value !== 'string') continue;
    const resolved = context.names.get(entityId(kind, value));
    if (resolved !== undefined) parts.push(`(${resolved})`);
    break;
  }

  return parts.join(' ');
}
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run test/renderProse.test.ts && npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/prose.ts test/renderProse.test.ts
git commit -m "feat: per-node prose leading with what, quoting the operator's why"
```

---

### Task 4: The Mermaid diagram

**Files:**
- Create: `src/render/mermaid.ts`
- Test: `test/renderMermaid.test.ts`

**Interfaces:**
- Consumes: `escapeMermaid`/`truncate` from `./text.js`, `typeLabel` from `./labels.js`, `NormalizedCampaign`, `ProseContext`.
- Produces: `renderMermaid(campaign: NormalizedCampaign, context: ProseContext): string`.

- [ ] **Step 1: Write the failing test**

Create `test/renderMermaid.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeCampaign } from '../src/normalize/campaign.js';
import { renderMermaid } from '../src/render/mermaid.js';
import { makeCampaign, makeDecision, makeNode, makeSequence } from './fixtures/graphFixtures.js';

const c987 = readFileSync(new URL('./fixtures/campaign-987-draft.xml', import.meta.url), 'utf8');
const ctx = { names: new Map<string, string>() };

describe('renderMermaid', () => {
  it('opens a top-down flowchart', () => {
    expect(renderMermaid(makeCampaign({ funnelId: '1' }), ctx).split('\n')[0]).toBe('flowchart TD');
  });

  it('renders goals, decisions and sequences with distinct shapes', () => {
    const campaign = makeCampaign({
      funnelId: '987',
      goals: [makeNode({ cellId: '2', style: 'tagApplied', name: 'Approved' })],
      decisions: [makeDecision({ cellId: '34', name: null })],
      sequences: [makeSequence({ cellId: '3', name: 'Confirmation' })],
      edges: [
        { cellId: 'e1', source: '2', target: '34', scope: '1' },
        { cellId: 'e2', source: '34', target: '3', scope: '1' },
      ],
    });
    const out = renderMermaid(campaign, ctx);
    expect(out).toContain('n2(["');   // goal — stadium
    expect(out).toContain('n34{"');   // decision — rhombus
    expect(out).toContain('n3["');    // sequence — rectangle
    expect(out).toContain('n2 --> n34');
    expect(out).toContain('n34 --> n3');
  });

  it('never emits step-level edges, only campaign scope', () => {
    const campaign = makeCampaign({
      funnelId: '1',
      sequences: [makeSequence({ cellId: '3' })],
      edges: [{ cellId: 'e9', source: '14', target: '81', scope: '3' }],
    });
    expect(renderMermaid(campaign, ctx)).not.toContain('n14');
  });

  it('escapes a label that would otherwise break the diagram', () => {
    const campaign = makeCampaign({
      funnelId: '1',
      goals: [
        makeNode({ cellId: '2', style: 'goal', name: 'Request our Email Series "How to sell"' }),
      ],
    });
    const out = renderMermaid(campaign, ctx);
    expect(out).toContain('#quot;');
    expect(out.split('\n').filter((l) => l.includes('n2(')).join()).not.toMatch(/"[^"]*"[^"]*"/);
  });

  it('decodes entities so no diagram shows &#39;', () => {
    const campaign = makeCampaign({
      funnelId: '1',
      goals: [makeNode({ cellId: '2', style: 'goal', name: 'I haven&#39;t heard back?' })],
    });
    expect(renderMermaid(campaign, ctx)).not.toContain('&#39;');
  });

  it('marks an empty sequence as empty', () => {
    // Campaign 987 routes into two sequences that contain nothing. As a table
    // row nobody notices; in a diagram it should be unmissable.
    const campaign = makeCampaign({
      funnelId: '1',
      sequences: [makeSequence({ cellId: '38', name: 'Approved for Beta', steps: [] })],
    });
    expect(renderMermaid(campaign, ctx)).toMatch(/n38\["[^"]*empty/i);
  });

  it('renders campaign 987 with its real goals, decision and sequences', () => {
    const campaign = normalizeCampaign(c987, '', {}, null, '987');
    const out = renderMermaid(campaign, ctx);
    expect(out).toContain('flowchart TD');
    for (const sequence of campaign.sequences) expect(out).toContain(`n${sequence.cellId}`);
    for (const decision of campaign.decisions) expect(out).toContain(`n${decision.cellId}{`);
    expect(out.split('\n').filter((l) => l.includes('-->')).length).toBeGreaterThan(0);
  });

  it('produces a diagram with no nodes for an empty campaign, not a crash', () => {
    expect(renderMermaid(makeCampaign({ funnelId: '1' }), ctx)).toBe('flowchart TD');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/renderMermaid.test.ts
```

Expected: FAIL — `Cannot find module '../src/render/mermaid.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/render/mermaid.ts`:

```ts
import type { NormalizedCampaign } from '../normalize/campaign.js';
import type { NormalizedNode } from '../normalize/nodes.js';
import { typeLabel } from './labels.js';
import type { ProseContext } from './prose.js';
import { escapeMermaid, truncate } from './text.js';

/** Long enough to be meaningful, short enough that boxes stay readable. */
const LABEL_LIMIT = 44;

/**
 * A Mermaid id that cannot collide with syntax.
 *
 * Cell ids are numeric strings, and a bare number is not a valid Mermaid node
 * id, so every one is prefixed.
 */
const nodeId = (cellId: string): string => `n${cellId.replace(/[^\w]/g, '_')}`;

function label(node: NormalizedNode, context: ProseContext): string {
  const name = node.name ?? '';
  const text = name.trim() === '' ? typeLabel(node) : name;
  void context;
  return escapeMermaid(truncate(escapeMermaid(text).length > LABEL_LIMIT ? text : text, LABEL_LIMIT));
}

/**
 * The campaign-level flowchart: goals, decisions and sequences.
 *
 * Steps are deliberately absent. The median campaign has 14 renderable nodes
 * and 4 campaign-level edges, but the largest has 112 nodes and 86 steps —
 * drawing those would produce a hairball nobody reads. Steps are linear by
 * construction and belong in an ordered list, which the page provides.
 */
export function renderMermaid(campaign: NormalizedCampaign, context: ProseContext): string {
  const lines = ['flowchart TD'];
  const rendered = new Set<string>();

  for (const goal of campaign.goals) {
    lines.push(`  ${nodeId(goal.cellId)}(["${label(goal, context)}"])`);
    rendered.add(goal.cellId);
  }

  for (const decision of campaign.decisions) {
    const text = decision.name === null ? 'Decision' : decision.name;
    lines.push(`  ${nodeId(decision.cellId)}{"${escapeMermaid(truncate(text, LABEL_LIMIT))}"}`);
    rendered.add(decision.cellId);
  }

  for (const sequence of campaign.sequences) {
    // An empty sequence is a dead end a reader must not miss.
    const suffix = sequence.steps.length === 0 ? ' (empty)' : ` (${sequence.steps.length} steps)`;
    const text = sequence.name === null ? 'Sequence' : sequence.name;
    lines.push(
      `  ${nodeId(sequence.cellId)}["${escapeMermaid(truncate(text, LABEL_LIMIT))}${suffix}"]`,
    );
    rendered.add(sequence.cellId);
  }

  for (const edge of campaign.edges) {
    if (edge.scope !== '1') continue;
    if (!rendered.has(edge.source) || !rendered.has(edge.target)) continue;
    lines.push(`  ${nodeId(edge.source)} --> ${nodeId(edge.target)}`);
  }

  return lines.join('\n');
}
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run test/renderMermaid.test.ts && npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Simplify the label helper**

The `label` function above contains a redundant conditional left from drafting. Replace it with:

```ts
function label(node: NormalizedNode, context: ProseContext): string {
  void context;
  const name = node.name ?? '';
  const text = name.trim() === '' ? typeLabel(node) : name;
  return escapeMermaid(truncate(text, LABEL_LIMIT));
}
```

Re-run `npx vitest run test/renderMermaid.test.ts` — still PASS.

- [ ] **Step 6: Commit**

```bash
git add src/render/mermaid.ts test/renderMermaid.test.ts
git commit -m "feat: campaign-level Mermaid diagrams with escaped labels"
```

---

### Task 5: The campaign page

**Files:**
- Create: `src/render/campaignDoc.ts`
- Test: `test/renderCampaignDoc.test.ts`

**Interfaces:**
- Consumes: `renderMermaid`, `describeNode`, `nameIndex`, `ProseContext`; `AccountGraph` from `src/normalize/graph.js`; `EntityCatalog`.
- Produces: `renderCampaign(campaign: NormalizedCampaign, graph: AccountGraph, catalog?: EntityCatalog): string`.

- [ ] **Step 1: Write the failing test**

Create `test/renderCampaignDoc.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeCampaign } from '../src/normalize/campaign.js';
import { buildGraph } from '../src/normalize/graph.js';
import { renderCampaign } from '../src/render/campaignDoc.js';

const c987 = readFileSync(new URL('./fixtures/campaign-987-draft.xml', import.meta.url), 'utf8');
const campaign = normalizeCampaign(c987, '', {}, 'WooConnection Beta Tester Application', '987');
const graph = buildGraph([campaign]);
const page = renderCampaign(campaign, graph);

describe('renderCampaign', () => {
  it('titles the page with the campaign name and id', () => {
    expect(page.split('\n')[0]).toBe('# WooConnection Beta Tester Application (987)');
  });

  it('embeds the diagram in a mermaid fence', () => {
    expect(page).toContain('```mermaid\nflowchart TD');
    expect(page).toContain('```');
  });

  it('lists every sequence with its steps in order', () => {
    for (const sequence of campaign.sequences) {
      if (sequence.name !== null) expect(page).toContain(sequence.name);
    }
  });

  it('flags an empty sequence rather than showing nothing', () => {
    // 987 routes into two sequences containing only a start vertex.
    expect(page).toMatch(/empty/i);
  });

  it('states once, not per line, that names are unavailable without a catalog', () => {
    expect(page.match(/ids are shown instead of names/gi) ?? []).toHaveLength(1);
  });

  it('never prints an internal style name', () => {
    for (const style of ['newsletterRequest', 'indicateInterest', 'bardEmail', 'unlayerEmail']) {
      expect(page, style).not.toContain(style);
    }
  });

  it('never leaks an undecoded entity', () => {
    expect(page).not.toMatch(/&#\d+;|&quot;|&amp;/);
  });

  it('has the sections a reader needs', () => {
    for (const heading of ['## Flow', '## Goals', '## Sequences', '## Connections']) {
      expect(page, heading).toContain(heading);
    }
  });

  it('notes an unverified sequence order instead of implying the order is real', () => {
    const unordered = {
      ...campaign,
      sequences: campaign.sequences.map((s) => ({ ...s, orderVerified: false })),
    };
    expect(renderCampaign(unordered, graph)).toMatch(/order could not be verified/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/renderCampaignDoc.test.ts
```

Expected: FAIL — `Cannot find module '../src/render/campaignDoc.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/render/campaignDoc.ts`:

```ts
import type { EntityCatalog } from '../api/catalog.js';
import type { NormalizedCampaign } from '../normalize/campaign.js';
import type { AccountGraph } from '../normalize/graph.js';
import { entityId } from '../normalize/graphEdges.js';
import { renderMermaid } from './mermaid.js';
import { type ProseContext, describeNode, nameIndex } from './prose.js';
import { plainText } from './text.js';

const EDGE_PHRASING: Record<string, string> = {
  applies: 'Applies tag',
  removes: 'Removes tag',
  'listens-for': 'Starts when tag applied',
  tests: 'Branches on tag',
  sends: 'Sends email',
  'entry-point': 'Entry point',
  'references-campaign': 'References campaign',
  'assigned-to': 'Assigned to',
  triggers: 'Triggers campaign',
};

function statusLine(campaign: NormalizedCampaign): string {
  const parts = [
    campaign.published ? 'Published' : 'Never published',
    campaign.hasUnpublishedChanges ? 'has unpublished changes' : 'no unpublished changes',
    `${campaign.sequences.length} sequences`,
    `${campaign.sequences.reduce((n, s) => n + s.steps.length, 0)} steps`,
  ];
  return parts.join(' · ');
}

function findingsLine(campaign: NormalizedCampaign): string | null {
  const empty = campaign.sequences.filter((s) => s.steps.length === 0).length;
  const parts: string[] = [];
  if (empty > 0) parts.push(`${empty} empty sequence${empty === 1 ? '' : 's'}`);
  if (campaign.unconfigured.length > 0) {
    parts.push(`${campaign.unconfigured.length} unconfigured node(s)`);
  }
  if (campaign.orphans.length > 0) parts.push(`${campaign.orphans.length} orphan(s)`);
  return parts.length === 0 ? null : `> ⚠ ${parts.join(' · ')}`;
}

function connections(campaign: NormalizedCampaign, graph: AccountGraph): string[] {
  const self = entityId('campaign', campaign.funnelId ?? '');
  const label = (id: string): string =>
    graph.entities.find((e) => e.id === id)?.label ?? id;

  const out: string[] = [];
  for (const edge of graph.edges) {
    if (edge.from === self) out.push(`- ${EDGE_PHRASING[edge.kind] ?? edge.kind} → ${label(edge.to)}`);
    else if (edge.to === self && edge.kind === 'triggers') {
      out.push(`- Triggered by ← ${label(edge.from)}`);
    }
  }
  return out;
}

/**
 * One campaign as a Markdown page.
 *
 * Presents both components of every element: what it does, derived from style
 * and references, and the operator's own words for why. Intent is never
 * paraphrased — that inference is the LLM pass, and keeping it out is what
 * makes this testable.
 */
export function renderCampaign(
  campaign: NormalizedCampaign,
  graph: AccountGraph,
  catalog?: EntityCatalog,
): string {
  const context: ProseContext = { names: nameIndex(catalog) };
  const title = campaign.name === null ? `Campaign ${campaign.funnelId}` : plainText(campaign.name);
  const lines: string[] = [`# ${title} (${campaign.funnelId})`, '', statusLine(campaign), ''];

  const findings = findingsLine(campaign);
  if (findings !== null) lines.push(findings, '');

  if (context.names.size === 0) {
    lines.push('_No entity catalog was available, so ids are shown instead of names._', '');
  }

  lines.push('## Flow', '', '```mermaid', renderMermaid(campaign, context), '```', '');

  lines.push('## Goals', '');
  if (campaign.goals.length === 0) lines.push('_None — nothing can enter this campaign._', '');
  else {
    for (const goal of campaign.goals) lines.push(`- ${describeNode(goal, context)}`);
    lines.push('');
  }

  lines.push('## Sequences', '');
  for (const sequence of campaign.sequences) {
    const name = sequence.name === null ? `Sequence ${sequence.cellId}` : plainText(sequence.name);
    const state = [
      sequence.ready === true ? 'ready' : 'not marked ready',
      sequence.published === true ? 'published' : 'not published',
    ].join(' · ');
    lines.push(`### ${name}`, '', `_${state}_`, '');

    if (sequence.steps.length === 0) {
      lines.push('_Empty — this sequence does nothing._', '');
      continue;
    }
    if (!sequence.orderVerified) {
      lines.push('_Step order could not be verified; shown in document order._', '');
    }
    for (const [index, step] of sequence.steps.entries()) {
      lines.push(`${index + 1}. ${describeNode(step, context)}`);
    }
    lines.push('');
  }

  lines.push('## Connections', '');
  const links = connections(campaign, graph);
  lines.push(...(links.length === 0 ? ['_None._'] : links), '');

  if (campaign.warnings.length > 0) {
    lines.push('## Warnings', '');
    for (const warning of campaign.warnings) lines.push(`- ${warning}`);
    lines.push('');
  }

  return lines.join('\n');
}
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run test/renderCampaignDoc.test.ts && npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/campaignDoc.ts test/renderCampaignDoc.test.ts
git commit -m "feat: render one campaign as a Markdown page"
```

---

### Task 6: The index and the CLI

**Files:**
- Create: `src/render/indexDoc.ts`, `src/cli/render.ts`
- Modify: `package.json`
- Test: `test/renderIndexDoc.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: `renderIndex(campaigns: NormalizedCampaign[], graph: AccountGraph): string`; `npm run render -- --app <app> [--funnel <id>]`.

- [ ] **Step 1: Write the failing test**

Create `test/renderIndexDoc.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildGraph } from '../src/normalize/graph.js';
import { renderIndex } from '../src/render/indexDoc.js';
import { makeCampaign, makeSequence } from './fixtures/graphFixtures.js';

const campaigns = [
  makeCampaign({
    funnelId: '16',
    name: 'Live One',
    published: true,
    sequences: [makeSequence({ cellId: '3', name: 'Seq', ready: true })],
  }),
  makeCampaign({ funnelId: '987', name: 'Dead One', published: false, unconfigured: ['43'] }),
];
const index = renderIndex(campaigns, buildGraph(campaigns));

describe('renderIndex', () => {
  it('links to every campaign page', () => {
    expect(index).toContain('[Live One](16.md)');
    expect(index).toContain('[Dead One](987.md)');
  });

  it('shows publication state', () => {
    expect(index).toMatch(/Live One.*published/i);
    expect(index).toMatch(/Dead One.*never published/i);
  });

  it('surfaces the incompleteness counts that decide migration effort', () => {
    expect(index).toMatch(/Dead One.*\|\s*1\s*\|/);
  });

  it('states the account totals', () => {
    expect(index).toContain('2 campaigns');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/renderIndexDoc.test.ts
```

Expected: FAIL — `Cannot find module '../src/render/indexDoc.js'`.

- [ ] **Step 3: Write the index**

Create `src/render/indexDoc.ts`:

```ts
import type { NormalizedCampaign } from '../normalize/campaign.js';
import type { AccountGraph } from '../normalize/graph.js';
import { plainText } from './text.js';

/**
 * The account listing.
 *
 * Columns are chosen to answer one question — how much work is this campaign —
 * so unconfigured nodes and empty sequences sit beside publication state
 * rather than being buried in the page.
 */
export function renderIndex(campaigns: NormalizedCampaign[], graph: AccountGraph): string {
  const rows = [...campaigns].sort((a, b) =>
    Number(a.funnelId ?? 0) - Number(b.funnelId ?? 0),
  );

  const lines: string[] = [
    '# Campaigns',
    '',
    `${rows.length} campaigns · ${graph.entities.length} entities · ${graph.edges.length} edges`,
    '',
    '| Campaign | Status | Sequences | Steps | Unconfigured | Empty seq |',
    '|---|---|---|---|---|---|',
  ];

  for (const campaign of rows) {
    const name = campaign.name === null ? `Campaign ${campaign.funnelId}` : plainText(campaign.name);
    const steps = campaign.sequences.reduce((n, s) => n + s.steps.length, 0);
    const empty = campaign.sequences.filter((s) => s.steps.length === 0).length;
    const status = campaign.published
      ? campaign.hasUnpublishedChanges
        ? 'published, changes pending'
        : 'published'
      : 'never published';
    lines.push(
      `| [${name}](${campaign.funnelId}.md) | ${status} | ${campaign.sequences.length} | ${steps} | ${campaign.unconfigured.length} | ${empty} |`,
    );
  }

  lines.push('');
  return lines.join('\n');
}
```

- [ ] **Step 4: Write the CLI**

Create `src/cli/render.ts`:

```ts
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EntityCatalog } from '../api/catalog.js';
import { normalizeAppName, normalizeFunnelId } from '../app.js';
import type { NormalizedCampaign } from '../normalize/campaign.js';
import type { AccountGraph } from '../normalize/graph.js';
import { renderCampaign } from '../render/campaignDoc.js';
import { renderIndex } from '../render/indexDoc.js';

function fail(message: string): void {
  console.error(`\n${message}\n`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const appIndex = argv.indexOf('--app');
  const rawApp = appIndex >= 0 ? argv[appIndex + 1] : undefined;
  if (!rawApp) {
    fail('Usage: npm run render -- --app <appName> [--funnel <funnelId>]');
    return;
  }

  let app: string;
  let only: string | null = null;
  try {
    app = normalizeAppName(rawApp);
    const funnelIndex = argv.indexOf('--funnel');
    const rawFunnel = funnelIndex >= 0 ? argv[funnelIndex + 1] : undefined;
    if (rawFunnel !== undefined) only = normalizeFunnelId(rawFunnel);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  const normalizedDir = join('artifacts', app, 'normalized');
  const graphPath = join('artifacts', app, 'graph.json');
  if (!existsSync(normalizedDir) || !existsSync(graphPath)) {
    fail(`No normalized data at ${normalizedDir}. Run:  npm run normalize -- --app ${app}`);
    return;
  }

  const graph = JSON.parse(await readFile(graphPath, 'utf8')) as AccountGraph;

  // Names are optional; without them pages show ids and say so once.
  let catalog: EntityCatalog | undefined;
  const catalogPath = join('artifacts', app, 'entities.json');
  if (existsSync(catalogPath)) {
    try {
      catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as EntityCatalog;
    } catch {
      console.log(`  warning: ${catalogPath} is unreadable — rendering with ids`);
    }
  }

  const outDir = join('artifacts', app, 'rendered');
  await mkdir(outDir, { recursive: true });

  const campaigns: NormalizedCampaign[] = [];
  let written = 0;
  let skipped = 0;

  for (const file of (await readdir(normalizedDir)).sort()) {
    const match = /^(\d+)\.json$/.exec(file);
    if (!match?.[1]) continue;
    if (only !== null && match[1] !== only) continue;

    try {
      const campaign = JSON.parse(
        await readFile(join(normalizedDir, file), 'utf8'),
      ) as NormalizedCampaign;
      await writeFile(
        join(outDir, `${match[1]}.md`),
        renderCampaign(campaign, graph, catalog),
        'utf8',
      );
      campaigns.push(campaign);
      written++;
    } catch (error) {
      // One bad campaign must not cost the other 169.
      skipped++;
      console.log(`  warning: ${file} — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (written === 0) {
    fail('no campaigns rendered — a silent empty result is worse than an error');
    return;
  }

  if (only === null) {
    await writeFile(join(outDir, 'index.md'), renderIndex(campaigns, graph), 'utf8');
  }

  console.log(`\n[${app}] rendered ${written} campaigns, skipped ${skipped}`);
  console.log(`  names: ${catalog === undefined ? 'ids only (no catalog)' : 'from catalog'}`);
  console.log(`  output: ${outDir}\n`);
}

await main();
```

- [ ] **Step 5: Add the npm script**

In `package.json`, beside `"enrich"`:

```json
    "render": "tsx src/cli/render.ts",
```

- [ ] **Step 6: Run the tests**

```bash
npm test && npm run typecheck
```

Expected: PASS, including all 283 pre-existing tests unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/render/indexDoc.ts src/cli/render.ts test/renderIndexDoc.test.ts package.json
git commit -m "feat: render CLI writing per-campaign pages and an account index"
```

---

### Task 7: Run it against the corpus

**Files:** none — this task produces verification.

- [ ] **Step 1: Render the account**

```bash
npm run render -- --app jordan
```

Expected: `rendered 170 campaigns, skipped 0`, and `names: from catalog`.

- [ ] **Step 2: Check the invariants that matter**

```bash
node --input-type=module -e "
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
const dir='artifacts/jordan/rendered';
const files=readdirSync(dir).filter(f=>f.endsWith('.md')&&f!=='index.md');
let entities=0, styles=0, diagrams=0, fences=0;
const forbidden=['newsletterRequest','indicateInterest','bardEmail','unlayerEmail','convrrtLandingPage'];
for(const f of files){
  const t=readFileSync(join(dir,f),'utf8');
  if(/&#\d+;|&quot;|&amp;|&lt;/.test(t)) entities++;
  if(forbidden.some(s=>t.includes(s))) styles++;
  if(t.includes('\`\`\`mermaid')) diagrams++;
  if((t.match(/\`\`\`/g)??[]).length % 2 !== 0) fences++;
}
console.log('pages:', files.length);
console.log('pages leaking an HTML entity:      ', entities, '(want 0)');
console.log('pages printing an internal style:  ', styles, '(want 0)');
console.log('pages with a diagram:              ', diagrams, '(want', files.length+')');
console.log('pages with unbalanced code fences: ', fences, '(want 0)');
"
```

Expected: 170 pages, 0 entity leaks, 0 internal styles, 170 diagrams, 0 unbalanced fences.

- [ ] **Step 3: Read campaign 987's page end to end**

```bash
cat artifacts/jordan/rendered/987.md
```

Check by eye: the title reads as a campaign name, the diagram matches its four sequences and one decision, **both empty sequences are visibly marked empty**, tags in Connections carry names rather than ids, and nothing reads like machine output.

- [ ] **Step 4: Check the largest campaign is still legible**

```bash
head -40 artifacts/jordan/rendered/751.md
```

Campaign 751 has 112 nodes and 86 steps. Its diagram should contain only goals, decisions and its 14 sequences — no step nodes. If the diagram is a hairball, the campaign-level-only decision was not honored.

- [ ] **Step 5: Verify rendering without a catalog still works**

```bash
mv artifacts/jordan/entities.json /tmp/entities.json
npm run render -- --app jordan --funnel 987 && grep -c "ids are shown instead of names" artifacts/jordan/rendered/987.md
mv /tmp/entities.json artifacts/jordan/entities.json
npm run render -- --app jordan
```

Expected: the run succeeds, the caveat appears exactly once, and the final re-render restores names.

- [ ] **Step 6: Commit nothing**

`artifacts/` is gitignored. This task's output is the verification above, which feeds Task 8.

---

### Task 8: Record what rendering surfaced

**Files:**
- Modify: `docs/spike-findings.md`

- [ ] **Step 1: Append the section**

Append a `## 15. Rendering` section covering, with the real numbers from Task 7:

- Pages written, and that the whole account renders offline in seconds.
- **Entities in labels, not just notes** — `cleanName` never decoded them, so 76 labels and 95 note bodies carried `&#39;` into the normalized data. Rendering is what made a long-standing data defect visible.
- **Timers needed no arithmetic** — Keap writes the English into `name`, so handoff §14 Q2's timezone question does not block display. Q2 stays open for anything that reasons about timing.
- **One style, several meanings** — `newsletterRequest` is a web form 106 times, a landing page 20, an internal form 7, and unconfigured 69. Note that the flat style→label table originally specced could not have expressed this.
- The unsettled `stageId` group, and what would settle it.
- Anything the diagrams made obvious that the counts had not — campaign 987's two empty sequences is the known example; look for others while reading Task 7 step 3.

Follow the existing sections' voice: what was observed, what it cost, what it means.

- [ ] **Step 2: Commit**

```bash
git add docs/spike-findings.md
git commit -m "docs: record what rendering surfaced"
```

---

## Self-review against the spec

| Spec requirement | Where |
|---|---|
| §4 Markdown, one file per campaign | Tasks 5, 6 |
| §4 Diagram is campaign level only | Task 4, verified Task 7 step 4 |
| §4 `name` is the primary label | Task 3 |
| §5 `typeLabel(node)`, not `typeLabel(style)` | Task 2 |
| §5 Email and landing-page builder families collapse | Task 2 |
| §5 Submission styles resolve by reference | Task 2 |
| §5 Unknown style falls through to raw name | Task 2 |
| §5 stageId group left distinct and documented | Task 2 |
| §5a What derived, why quoted, intent never paraphrased | Task 3, Task 5 |
| §6 Timers verbatim, no arithmetic | Task 3 |
| §7 Four templates: tag, notes, email family, decision | Task 3 |
| §7 Note bodies decoded and stripped | Tasks 1, 3 |
| §8 Mermaid escaping against real corpus names | Task 1 step 5, Task 4 |
| §9 Page sections and `Connections` from the graph | Task 5 |
| §10 CLI, `rendered/`, index | Task 6 |
| §11 Every error-handling row | Tasks 5, 6 |
| §12 All 170 render without throwing | Task 7 |
| §13 All six success criteria | Tasks 7, 8 |

**Two deviations from the spec, both stated where they happen:**

1. **Entity decoding is not notes-only.** The spec scopes it to note bodies; the corpus shows 76
   *labels* carrying entities too, including timer descriptions. Task 1 handles all text uniformly,
   which is simpler than two paths and fixes a defect the spec did not know about.
2. **`decision` has no separate prose template.** The spec lists four template cases; a decision's
   routing is already visible in the diagram and in `Connections`, so a fifth code path to restate it
   as prose would duplicate rather than inform. Decisions render via the generic path with their
   `Decision` label.
