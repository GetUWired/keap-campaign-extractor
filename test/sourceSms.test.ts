import { readFileSync } from 'node:fs';
import type { BrowserContext } from 'playwright';
import { describe, expect, it } from 'vitest';
import { smsSource } from '../src/content/sources/sms.js';
import type { ContentItemKey, FetchContext } from '../src/content/types.js';

const fixture = (name: string) => readFileSync(`test/fixtures/content/${name}`, 'utf8');

function ctxServing(body: string, contentType = 'application/json;charset=UTF-8') {
  const urls: string[] = [];
  const browser = {
    request: {
      get: async (url: string) => {
        urls.push(url);
        return {
          status: () => 200,
          headers: () => ({ 'content-type': contentType }),
          text: async () => body,
          url: () => url,
        };
      },
    },
  } as unknown as BrowserContext;
  const ctx: FetchContext = { app: 'se232', baseUrl: 'https://se232.infusionsoft.com', browser, api: null };
  return { ctx, urls };
}

const key = (id: string): ContentItemKey => ({ kind: 'sms', attribute: 'marketingAutomatedSmsId', id });

describe('smsSource', () => {
  it('declares what it needs', () => {
    expect(smsSource).toMatchObject({
      kind: 'sms',
      attributes: ['marketingAutomatedSmsId'],
      needsApiKey: false,
      needsBrowser: true,
    });
  });

  it('maps a configured message', async () => {
    const { ctx, urls } = ctxServing(fixture('sms-configured.json'));
    const fetched = await smsSource.fetch(key('50970'), ctx);
    expect(urls).toEqual(['https://se232.infusionsoft.com/app/automatedSmsFunnel/50970']);
    expect(fetched.record).toEqual({
      kind: 'sms',
      name: null,
      text: 'Hi ~Contact.FirstName~, your trip departs tomorrow. Reply STOP to opt out.',
      sender: null,
      phoneTypes: ['Mobile'],
    });
    expect(fetched.files).toEqual([]);
    expect(fetched.evidence.map((f) => f.name)).toEqual(['response.json']);
    expect(smsSource.validate(fetched)).toBeNull();
  });

  it('keeps an unconfigured step as an empty message', async () => {
    const { ctx } = ctxServing(fixture('sms-unconfigured.json'));
    const fetched = await smsSource.fetch(key('45179'), ctx);
    expect(fetched.record).toMatchObject({ text: '', phoneTypes: ['Mobile', 'Work', 'Home', 'Other'] });
    expect(smsSource.validate(fetched)).toBeNull();
  });

  it('refuses an HTML page served in place of the message', async () => {
    const { ctx } = ctxServing('<html><body>Sign in</body></html>', 'text/html');
    await expect(smsSource.fetch(key('1'), ctx)).rejects.toThrow(/expected JSON/);
  });

  it('rejects JSON that is not an SMS message', () => {
    expect(
      smsSource.validate({
        record: { kind: 'sms', name: null, text: '', sender: null },
        files: [],
        evidence: [{ name: 'response.json', body: '{"error":"nope"}' }],
        assetUrls: [],
      }),
    ).toMatch(/not an automated SMS/);
  });
});
