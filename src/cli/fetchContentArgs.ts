import { normalizeAppName, normalizeFunnelId } from '../app.js';
import { CONTENT_KINDS, type ContentKind } from '../content/types.js';

export interface FetchContentArgs {
  app: string;
  kinds: ContentKind[] | null;
  funnelId: string | null;
  force: boolean;
  limit: number | null;
  delayMs: number;
  headed: boolean;
}

export const FETCH_CONTENT_USAGE =
  'Usage: npm run fetch-content -- --app <appName> [--kinds email,sms,…] [--funnel <id>] ' +
  '[--force] [--limit <n>] [--delay <ms>] [--headed]';

function valueOf(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function numeric(argv: string[], flag: string): number | null {
  const raw = valueOf(argv, flag);
  if (!argv.includes(flag)) return null;
  const value = Number.parseInt(raw ?? '', 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid ${flag} ${JSON.stringify(raw)}. Expected a non-negative integer.`);
  }
  return value;
}

export function parseFetchContentArgs(argv: string[]): FetchContentArgs {
  const rawApp = valueOf(argv, '--app');
  if (!rawApp) throw new Error(FETCH_CONTENT_USAGE);

  let kinds: ContentKind[] | null = null;
  const rawKinds = valueOf(argv, '--kinds');
  if (rawKinds !== undefined) {
    const requested = rawKinds.split(',').map((k) => k.trim()).filter((k) => k !== '');
    const unknown = requested.filter((k) => !(CONTENT_KINDS as readonly string[]).includes(k));
    if (unknown.length > 0 || requested.length === 0) {
      throw new Error(
        `Unknown --kinds ${JSON.stringify(unknown.join(','))}. Expected: ${CONTENT_KINDS.join(', ')}.`,
      );
    }
    kinds = requested as ContentKind[];
  }

  const limit = numeric(argv, '--limit');
  if (limit === 0) throw new Error('Invalid --limit "0". Expected a positive integer.');
  const rawFunnel = valueOf(argv, '--funnel');

  return {
    app: normalizeAppName(rawApp),
    kinds,
    funnelId: rawFunnel === undefined ? null : normalizeFunnelId(rawFunnel),
    force: argv.includes('--force'),
    limit,
    delayMs: numeric(argv, '--delay') ?? 250,
    headed: argv.includes('--headed'),
  };
}
