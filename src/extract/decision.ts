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
 * The decision-editor URL shape is INFERRED, not observed. The handoff
 * captured the configureCell pattern for a timerDelay cell only, so these
 * candidates are tried in order and validated by content.
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
