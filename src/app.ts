import { join } from 'node:path';

/**
 * DNS label rules. App names become both a URL subdomain and a filesystem path
 * segment, so this is a security boundary rather than input tidying:
 * "../../../etc" is path traversal, and "evil.com/x" would point the extractor
 * at a host the operator never named.
 */
const APP_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Keap funnel ids are integers. Same traversal risk through the same mechanism. */
const FUNNEL_ID_PATTERN = /^\d+$/;

export interface IdentityCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export function normalizeAppName(raw: string): string {
  const app = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!APP_NAME_PATTERN.test(app)) {
    throw new Error(
      `Invalid app name ${JSON.stringify(raw)}. Expected a Keap subdomain: lowercase ` +
        `letters, digits and hyphens, starting with a letter or digit, at most 63 characters.`,
    );
  }
  return app;
}

export function normalizeFunnelId(raw: string): string {
  const id = String(raw ?? '').trim();
  if (!FUNNEL_ID_PATTERN.test(id)) {
    throw new Error(`Invalid funnel id ${JSON.stringify(raw)}. Expected digits only.`);
  }
  return id;
}

/**
 * KEAP_BASE_URL overrides the derived host, but the app name is still validated
 * and still governs where artifacts are filed. The override changes where we
 * look, never what we are willing to file it as.
 */
export function baseUrlFor(app: string): string {
  const validated = normalizeAppName(app);
  const override = process.env.KEAP_BASE_URL;
  if (override) return override.replace(/\/+$/, '');
  return `https://${validated}.infusionsoft.com`;
}

export function sessionPathFor(app: string): string {
  return join('.sessions', `${normalizeAppName(app)}.json`);
}

export function campaignDirFor(app: string, funnelId: string): string {
  return join('artifacts', normalizeAppName(app), 'campaigns', normalizeFunnelId(funnelId));
}

/**
 * Compares what we asked for against what the extracted document says it is.
 *
 * A marker that is present and different is a contradiction and aborts the run.
 * A marker that is absent is merely weaker evidence: both were present on every
 * campaign observed, but a schema change that drops one must not halt
 * extraction across an entire account.
 */
export function verifyIdentity(
  expected: { app: string; funnelId: string },
  actual: { appName: string | null; funnelId: string | null },
): IdentityCheck {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (actual.appName === null) {
    warnings.push('draftXml carries no appName marker — cannot confirm which app this came from');
  } else if (actual.appName.toLowerCase() !== expected.app.toLowerCase()) {
    errors.push(`app mismatch: asked for "${expected.app}" but draftXml says "${actual.appName}"`);
  }

  if (actual.funnelId === null) {
    warnings.push('draftXml carries no funnelId marker');
  } else if (actual.funnelId !== expected.funnelId) {
    errors.push(
      `funnel mismatch: asked for "${expected.funnelId}" but draftXml says "${actual.funnelId}"`,
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}
