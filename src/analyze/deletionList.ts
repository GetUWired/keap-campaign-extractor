import { parseCsvRows } from './tagList.js';

export interface PlannedDeletion {
  campaignId: string;
  name: string;
}

export interface DeletionList {
  campaigns: PlannedDeletion[];
  warnings: string[];
}

/**
 * Column aliases for the campaign id.
 *
 * A list typed by hand says `id`; one exported from Keap says `campaign_id` or
 * `funnel_id`. All three mean the same number, and refusing the last two would
 * make the operator rename a column for no reason.
 */
const ID_COLUMNS = ['id', 'campaign_id', 'campaignid', 'funnel_id', 'funnelid'];
const NAME_COLUMNS = ['name', 'campaign_name', 'campaignname'];

interface JsonDeletionList {
  delete?: ({ id?: string; campaignId?: string; name?: string } | string | number)[];
}

/**
 * Reads the list of campaigns an operator intends to delete.
 *
 * This does not delete anything and never could — it exists so the impact
 * report can separate "this campaign breaks" from "this campaign is going away
 * anyway", which is most of the noise in a large run.
 */
export function parseDeletionList(text: string, format: 'csv' | 'json'): DeletionList {
  const warnings: string[] = [];
  const seen = new Map<string, PlannedDeletion>();

  const add = (rawId: string, rawName: string): void => {
    const campaignId = rawId.trim();
    if (campaignId === '') {
      warnings.push(`a row has no campaign id and was skipped (name: ${rawName.trim() || 'blank'})`);
      return;
    }
    if (seen.has(campaignId)) {
      warnings.push(`campaign ${campaignId} is listed more than once; the first entry was kept`);
      return;
    }
    seen.set(campaignId, { campaignId, name: rawName.trim() });
  };

  if (format === 'json') {
    const parsed = JSON.parse(text) as JsonDeletionList | (string | number)[];
    const entries = Array.isArray(parsed) ? parsed : (parsed.delete ?? []);
    for (const entry of entries) {
      if (typeof entry === 'string' || typeof entry === 'number') add(String(entry), '');
      else add(String(entry.id ?? entry.campaignId ?? ''), entry.name ?? '');
    }
    return { campaigns: [...seen.values()], warnings };
  }

  const rows = parseCsvRows(text).filter((row) => row.some((field) => field.trim() !== ''));
  const header = rows[0];
  if (header === undefined) throw new Error('the campaign list is empty');

  const columnFor = (names: string[]): number =>
    header.findIndex((h) => names.includes(h.trim().toLowerCase()));
  const idAt = columnFor(ID_COLUMNS);
  if (idAt < 0) {
    throw new Error(
      `the campaign list has no id column, so no row can be used. Expected one of: ${ID_COLUMNS.join(', ')}`,
    );
  }
  const nameAt = columnFor(NAME_COLUMNS);

  for (const row of rows.slice(1)) add(row[idAt] ?? '', nameAt >= 0 ? (row[nameAt] ?? '') : '');
  return { campaigns: [...seen.values()], warnings };
}
