/**
 * Keap merge fields: `~Contact.FirstName~`, `~Owner.Email~`, `~Date.Today~`.
 * The dot is required, which is what keeps `~br~` — Keap's line-break token —
 * and prose tildes out.
 */
export const MERGE_FIELD_PATTERN = /~[A-Za-z][A-Za-z0-9_]*\.[A-Za-z0-9_.]+~/g;

export function findMergeFields(...texts: (string | null | undefined)[]): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(MERGE_FIELD_PATTERN)) found.add(match[0]);
  }
  return [...found].sort();
}
