import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  decodeEntities,
  escapeMermaid,
  plainText,
  stripTags,
  truncate,
} from '../src/render/text.js';

interface RawNode {
  name?: string | null;
  config?: Record<string, string>;
}

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
    expect(stripTags('<p>one</p><p>two</p>').trim()).toBe('one  two');
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
    expect(truncate(long, 20).length).toBeLessThanOrEqual(20);
    expect(truncate(long, 20).endsWith('…')).toBe(true);
  });

  it('leaves short text alone', () => {
    expect(truncate('short', 20)).toBe('short');
  });
});

/**
 * The corpus is gitignored, so this guard runs only where it exists. It is the
 * assertion that matters most: escaping that passes hand-written cases but
 * leaks on real data is exactly the failure this whole module exists to stop.
 */
const CORPUS = new URL('../artifacts/jordan/normalized/', import.meta.url);
const corpusFiles = existsSync(CORPUS) ? readdirSync(CORPUS).filter((f) => f.endsWith('.json')) : [];

describe.skipIf(corpusFiles.length === 0)('against every label in the real corpus', () => {
  const nodes = corpusFiles.flatMap((file) => {
    const c = JSON.parse(readFileSync(new URL(file, CORPUS), 'utf8')) as {
      goals: RawNode[];
      decisions: RawNode[];
      notes: RawNode[];
      sequences: (RawNode & { steps: RawNode[] })[];
    };
    return [...c.goals, ...c.decisions, ...c.notes, ...c.sequences, ...c.sequences.flatMap((s) => s.steps)];
  });

  it('leaves no Mermaid metacharacter in any label', () => {
    const leaks = nodes
      .filter((n) => n.name)
      .map((n) => escapeMermaid(n.name as string))
      .filter((out) => /["#[\]{}()|]|->|&#|&[a-z]+;/.test(out.replace(/#\d+;|#quot;/g, '')));
    expect(leaks).toEqual([]);
  });

  it('leaves no entity or tag in any note body', () => {
    const leaks = nodes
      .map((n) => n.config?.notes)
      .filter((body): body is string => typeof body === 'string')
      .map((body) => plainText(body))
      .filter((out) => /&#\d+;|&[a-z]+;|<[a-z]/i.test(out));
    expect(leaks).toEqual([]);
  });
});

describe('plainText and the ~br~ token', () => {
  it('strips Keap line-break tokens, which arrive from the API too', () => {
    // cleanName handles ~br~ for names parsed from XML, but catalog names come
    // from the REST API and never pass through it — one real webform is named
    // "WooConnection Beta~br~Tester Application".
    expect(plainText('WooConnection Beta~br~Tester Application')).toBe(
      'WooConnection Beta Tester Application',
    );
  });
});
