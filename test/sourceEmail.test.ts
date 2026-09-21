import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ApiError, type ApiClient } from '../src/api/client.js';
import { emailSource } from '../src/content/sources/email.js';
import { ContentNotFoundError, type ContentItemKey, type FetchContext } from '../src/content/types.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(`test/fixtures/content/${name}`, 'utf8'));

function ctxReturning(result: unknown | Error) {
  const paths: string[] = [];
  const api: ApiClient = {
    get: async (path) => {
      paths.push(path);
      if (result instanceof Error) throw result;
      return result;
    },
    getAll: async () => {
      throw new Error('not used');
    },
  };
  const ctx: FetchContext = { app: 'jordan', baseUrl: 'https://jordan.infusionsoft.com', browser: null, api };
  return { ctx, paths };
}

const key = (id: string): ContentItemKey => ({ kind: 'email', attribute: 'marketingEmailId', id });

describe('emailSource', () => {
  it('declares what it needs', () => {
    expect(emailSource).toMatchObject({
      kind: 'email',
      attributes: ['marketingEmailId'],
      needsApiKey: true,
      needsBrowser: false,
    });
  });

  it('maps a legacy template and drops the HTML-only placeholder text part', async () => {
    const { ctx, paths } = ctxReturning(fixture('email-template-legacy.json'));
    const fetched = await emailSource.fetch(key('1261'), ctx);

    expect(paths).toEqual(['/crm/rest/v2/emails/templates/1261']);
    expect(fetched.record).toEqual({
      kind: 'email',
      name: 'Untitled Email',
      from: '"Example Sender" <sender@example.com>',
      replyTo: null,
      to: '~Contact.Email~',
      cc: null,
      bcc: 'records@example.com',
      subject: 'Hi ~Contact.FirstName~',
      previewText: null,
      attachments: [],
    });
    expect(fetched.files.map((f) => f.name)).toEqual(['body.html']);
    expect(fetched.evidence.map((f) => f.name)).toEqual(['response.json']);
    expect(emailSource.validate(fetched)).toBeNull();
  });

  it('cleans ~br~ from the title and handles an HTML-only template', async () => {
    const { ctx } = ctxReturning(fixture('email-template-unlayer.json'));
    const fetched = await emailSource.fetch(key('2415'), ctx);
    expect(fetched.record).toMatchObject({ name: 'EM1 Initial Notification', subject: 'Your payment failed' });
    expect(fetched.files.map((f) => f.name)).toEqual(['body.html']);
  });

  it('keeps a real text part and omits an empty HTML part', async () => {
    const { ctx } = ctxReturning(fixture('email-template-plain.json'));
    const fetched = await emailSource.fetch(key('3001'), ctx);
    expect(fetched.files).toEqual([{ name: 'body.txt', body: 'Hi ~Contact.FirstName~, see you tomorrow.' }]);
  });

  it('reports a deleted template as not found', async () => {
    const { ctx } = ctxReturning(new ApiError(404, '/crm/rest/v2/emails/templates/9', 'GET … failed with 404'));
    await expect(emailSource.fetch(key('9'), ctx)).rejects.toBeInstanceOf(ContentNotFoundError);
  });

  it('refuses a response for a different template', async () => {
    const { ctx } = ctxReturning(fixture('email-template-legacy.json'));
    await expect(emailSource.fetch(key('1262'), ctx)).rejects.toThrow(/asked for template 1262/);
  });

  it('needs the API client', async () => {
    const { ctx } = ctxReturning({});
    await expect(emailSource.fetch(key('1'), { ...ctx, api: null })).rejects.toThrow(/KEAP_API_KEY/);
  });

  it('rejects evidence that is not a template', () => {
    expect(
      emailSource.validate({
        record: { kind: 'email', name: null, from: null, replyTo: null, to: null, cc: null, bcc: null, subject: null, previewText: null, attachments: [] },
        files: [],
        evidence: [{ name: 'response.json', body: '{"message":"oops"}' }],
        assetUrls: [],
      }),
    ).toMatch(/not an email template/);
  });
});
