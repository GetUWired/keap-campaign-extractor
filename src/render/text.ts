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

/**
 * Decode, strip, collapse. The standard treatment for any text from Keap.
 *
 * `~br~` is Keap's own line-break token. `cleanName` removes it from names
 * parsed out of the XML, but catalog names come from the REST API and never
 * pass through it, so it has to be handled here too.
 */
export function plainText(text: string): string {
  return stripTags(decodeEntities(text.replace(/~br~/g, ' ')))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Makes a string safe inside a quoted Mermaid label.
 *
 * Mermaid reads `"`, `#`, brackets, braces, parentheses, `|` and `->` as
 * syntax. Unescaped, it renders the wrong diagram or nothing at all — and
 * reports no error, which is why this is tested against the ugliest names
 * actually in the corpus rather than invented ones.
 *
 * `#` is replaced first: every other replacement introduces `#`, so doing it
 * later would mangle the escapes this function just wrote.
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
