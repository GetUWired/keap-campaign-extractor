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

/**
 * A column marking which rows are actually being deleted.
 *
 * A working spreadsheet lists the whole account and flags a subset — the real
 * one has 190 rows and 107 flags. Without this the other 83 would be reported
 * as planned deletions, which is the opposite of what the operator meant.
 */
const FLAG_COLUMNS = ['delete', 'delete?', 'remove', 'remove?', 'to delete', 'to_delete'];

/** Spreadsheet truth: TRUE from a formula, or a hand-typed yes/x/1. */
const TRUTHY = new Set(['true', 'yes', 'y', 'x', '1']);

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

  const flagAt = columnFor(FLAG_COLUMNS);
  const body = rows.slice(1);

  for (const row of body) {
    // With no flag column every row is a deletion — a list of just the ones to
    // delete. With one, only the flagged rows are.
    if (flagAt >= 0 && !TRUTHY.has((row[flagAt] ?? '').trim().toLowerCase())) continue;
    add(row[idAt] ?? '', nameAt >= 0 ? (row[nameAt] ?? '') : '');
  }

  if (flagAt >= 0 && seen.size === 0 && body.length > 0) {
    warnings.push(
      `the campaign list has a "${header[flagAt]?.trim()}" column but no row is marked — ` +
        `nothing is treated as a planned deletion`,
    );
  }

  return { campaigns: [...seen.values()], warnings };
}
