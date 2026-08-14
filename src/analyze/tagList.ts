export interface RequestedTag {
  id: string;
  name: string;
  /** The combine group this tag belongs to, or null when it is being deleted outright. */
  group: string | null;
}

export interface TagList {
  tags: RequestedTag[];
  warnings: string[];
}

/**
 * Chooses the parser by file extension.
 *
 * Refuses anything else rather than sniffing the content: a file with the wrong
 * extension is more likely a mistake than an intention, and guessing wrong on a
 * list that drives deletions is not worth the convenience.
 */
export function formatFor(path: string): 'csv' | 'json' {
  const lower = path.toLowerCase();
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.json')) return 'json';
  throw new Error(`Unrecognized list format: ${path}. Supported extensions are .csv and .json.`);
}

/**
 * A minimal RFC 4180 reader.
 *
 * Written rather than added as a dependency: real tag names contain commas and
 * quotes — "List: Minus TSP, Essence, 2024 trip purchased" is one — so quoting
 * has to be honored, but that is twenty lines, not a package.
 */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') field += char;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Collects tags, rejecting rows with no id and keeping the first of any duplicate. */
function collect(
  entries: { id: string; name: string; group: string | null }[],
  warnings: string[],
): RequestedTag[] {
  const seen = new Map<string, RequestedTag>();
  for (const entry of entries) {
    const id = entry.id.trim();
    if (id === '') {
      warnings.push(`a row has no id and was skipped (name: ${entry.name || 'blank'})`);
      continue;
    }
    const existing = seen.get(id);
    if (existing !== undefined) {
      // Both a delete and a combine for one tag is contradictory. Combining
      // wins, because a tag being merged is not simply being removed, and the
      // operator is told rather than left to wonder which took effect.
      if (existing.group === null && entry.group !== null) {
        existing.group = entry.group;
        warnings.push(`tag ${id} appears as both a deletion and a combine — treated as combine`);
      } else {
        warnings.push(`duplicate id ${id} was skipped; the first entry was kept`);
      }
      continue;
    }
    seen.set(id, { id, name: entry.name.trim(), group: entry.group });
  }
  return [...seen.values()];
}

interface JsonList {
  delete?: { id?: string; name?: string }[];
  combine?: { group?: string; tags?: { id?: string; name?: string }[] }[];
}

export function parseTagList(text: string, format: 'csv' | 'json'): TagList {
  const warnings: string[] = [];

  if (format === 'json') {
    const parsed = JSON.parse(text) as JsonList;
    const entries = [
      ...(parsed.delete ?? []).map((t) => ({ id: t.id ?? '', name: t.name ?? '', group: null })),
      ...(parsed.combine ?? []).flatMap((g) =>
        (g.tags ?? []).map((t) => ({ id: t.id ?? '', name: t.name ?? '', group: g.group ?? '' })),
      ),
    ];
    return { tags: collect(entries, warnings), warnings };
  }

  const rows = parseCsvRows(text).filter((r) => r.some((cell) => cell.trim() !== ''));
  const header = rows[0];
  if (header === undefined) throw new Error('the list is empty');

  const column = (name: string): number => header.findIndex((h) => h.trim().toLowerCase() === name);
  const idAt = column('id');
  if (idAt < 0) throw new Error('the CSV has no id column, so no row can be used');
  const nameAt = column('name');
  // A plain delete list should not have to carry an empty group column.
  const groupAt = column('group');

  const entries = rows.slice(1).map((row) => ({
    id: row[idAt] ?? '',
    name: nameAt >= 0 ? (row[nameAt] ?? '') : '',
    group:
      groupAt >= 0 && (row[groupAt] ?? '').trim() !== '' ? (row[groupAt] as string).trim() : null,
  }));

  return { tags: collect(entries, warnings), warnings };
}
