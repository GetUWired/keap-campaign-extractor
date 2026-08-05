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
 * The goal a decision hangs off. Observed as secondaryKey=WebForm,
 * secondaryKeyId=681L, where 681 is the webformId of the upstream
 * newsletterRequest goal.
 */
export interface GoalContext {
  secondaryKey: string;
  secondaryKeyId: string;
}

/**
 * Builds candidate URLs for the decision editor.
 *
 * The endpoint is /app/decisionFunnel/decisionEditor — confirmed by observing a
 * real decision-diamond click, not inferred. It is keyed by the branch lists
 * rather than by cell id, and decisionIds keep their Java-Long `L` suffix.
 *
 * Whether secondaryKey/secondaryKeyId are required is still unconfirmed: they
 * plausibly only select the field vocabulary offered in the editor, since the
 * saved rules are keyed server-side by decisionId. The bare form is therefore
 * tried first, and the response itself carries the goal context back (see
 * DecisionWrapper), so a hit on the bare form means we never have to trace the
 * upstream goal at all.
 */
export function decisionCandidateUrls(cell: DecisionCell, context?: GoalContext): string[] {
  const base = `${BASE_URL}/app/decisionFunnel/decisionEditor`;
  const flowIds = cell.branches.map((b) => b.flowId).join(',');
  // parseCells strips the L suffix; the live URL carries it, so restore it.
  const decisionIds = cell.branches.map((b) => `${b.decisionId}L`).join(',');
  const core = `flowIds=${encodeURIComponent(flowIds)}&decisionIds=${encodeURIComponent(decisionIds)}`;

  const urls = [`${base}?${core}`];

  if (context) {
    const secondaryKeyId = context.secondaryKeyId.endsWith('L')
      ? context.secondaryKeyId
      : `${context.secondaryKeyId}L`;
    urls.push(
      `${base}?${core}&secondaryKey=${encodeURIComponent(context.secondaryKey)}` +
        `&secondaryKeyId=${encodeURIComponent(secondaryKeyId)}`,
    );
  }

  return urls;
}

/** Status alone is not trusted: the app can return 200 with an empty modal shell. */
export function isDecisionHtml(body: string): boolean {
  return /decisionComponents|decisionIds/.test(body);
}

export async function fetchDecision(
  context: BrowserContext,
  cell: DecisionCell,
  goal?: GoalContext,
): Promise<DecisionFetchResult> {
  const attempts: DecisionFetchAttempt[] = [];
  const missBodies: string[] = [];

  if (cell.branches.length === 0) {
    return {
      cellId: cell.cellId,
      attempts,
      html: null,
      criteria: null,
      missBodies: [],
    };
  }

  for (const url of decisionCandidateUrls(cell, goal)) {
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
