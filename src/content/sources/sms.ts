import { SessionExpiredError } from '../../errors.js';
import type { ContentSource, FetchedContent, SmsContent } from '../types.js';
import { appGet, looksLikeSignInPage } from './appGet.js';

interface SmsResponse {
  id?: unknown;
  message?: unknown;
  phoneTypes?: unknown;
}

export function smsPath(id: string): string {
  return `/app/automatedSmsFunnel/${encodeURIComponent(id)}`;
}

/**
 * An automated SMS step, from the JSON the SMS builder itself loads
 * (spike-findings §18). An unconfigured step answers `message: null` — genuine,
 * and exported as an empty message rather than a failure.
 */
export function mapSms(raw: unknown, body: string): FetchedContent {
  const r = (raw ?? {}) as SmsResponse;
  const record: SmsContent = {
    kind: 'sms',
    name: null,
    text: typeof r.message === 'string' ? r.message : '',
    sender: null,
    phoneTypes: Array.isArray(r.phoneTypes)
      ? r.phoneTypes.filter((t): t is string => typeof t === 'string')
      : [],
  };
  return { record, files: [], evidence: [{ name: 'response.json', body }], assetUrls: [] };
}

// The response's `id` is the automationMessageId, not the requested
// marketingAutomatedSmsId, so it cannot be checked against the request to tell a
// response for the wrong step apart from a genuine one. Trust rests on the URL.
export const smsSource: ContentSource = {
  kind: 'sms',
  attributes: ['marketingAutomatedSmsId'],
  needsApiKey: false,
  needsBrowser: true,

  async fetch(key, ctx) {
    const response = await appGet(ctx, smsPath(key.id));
    if (!response.contentType.toLowerCase().includes('json')) {
      if (looksLikeSignInPage(response.body)) {
        throw new SessionExpiredError(
          `Session expired — ${smsPath(key.id)} returned a sign-in page. Re-run:  npm run login -- --app ${ctx.app}`,
        );
      }
      throw new Error(`expected JSON from ${smsPath(key.id)}, got ${response.contentType || 'no content type'}`);
    }
    return mapSms(JSON.parse(response.body) as unknown, response.body);
  },

  validate(content) {
    const evidence = content.evidence.find((file) => file.name === 'response.json');
    try {
      const parsed = JSON.parse(String(evidence?.body ?? '')) as SmsResponse & Record<string, unknown>;
      if (parsed.id !== undefined && 'message' in parsed) return null;
    } catch {
      // fall through
    }
    return 'response is not an automated SMS message';
  },
};
