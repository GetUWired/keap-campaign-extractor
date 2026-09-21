import { describe, expect, it } from 'vitest';
import { REDACTED, redactHttp } from '../src/content/redact.js';
import type { HttpContent } from '../src/content/types.js';

const base: HttpContent = {
  kind: 'http',
  name: 'Zapier hook',
  method: 'POST',
  url: 'https://hooks.example.com/catch/1',
  headers: [],
  fields: [],
  body: null,
};

describe('redactHttp', () => {
  it('redacts secret headers by name', () => {
    const { content, redacted } = redactHttp({
      ...base,
      headers: [
        { name: 'Authorization', value: 'Bearer abc' },
        { name: 'X-Api-Key', value: 'k1' },
        { name: 'Content-Type', value: 'application/json' },
      ],
    });
    expect(content.headers).toEqual([
      { name: 'Authorization', value: REDACTED },
      { name: 'X-Api-Key', value: REDACTED },
      { name: 'Content-Type', value: 'application/json' },
    ]);
    expect(redacted).toEqual([
      { location: 'header', name: 'Authorization' },
      { location: 'header', name: 'X-Api-Key' },
    ]);
  });

  it('redacts secret fields but never merge fields', () => {
    const { content, redacted } = redactHttp({
      ...base,
      fields: [
        { name: 'api_token', value: 's3cret' },
        { name: 'contact_token', value: '~Contact.Id~' },
        { name: 'email', value: '~Contact.Email~' },
      ],
    });
    expect(content.fields.map((f) => f.value)).toEqual([REDACTED, '~Contact.Id~', '~Contact.Email~']);
    expect(redacted).toEqual([{ location: 'field', name: 'api_token' }]);
  });

  it('redacts query parameters and userinfo, leaving the rest of the URL as written', () => {
    const { content, redacted } = redactHttp({
      ...base,
      url: 'https://user:pw@hooks.example.com/x?key=abc&id=~Contact.Id~&page=2#frag',
    });
    expect(content.url).toBe(
      `https://${REDACTED}@hooks.example.com/x?key=${REDACTED}&id=~Contact.Id~&page=2#frag`,
    );
    expect(redacted).toEqual([
      { location: 'url', name: 'userinfo' },
      { location: 'query', name: 'key' },
    ]);
  });

  it('redacts secret keys inside a JSON body, at any depth', () => {
    const { content, redacted } = redactHttp({
      ...base,
      body: JSON.stringify({ auth: { password: 'p' }, email: '~Contact.Email~' }),
    });
    expect(JSON.parse(content.body ?? '')).toEqual({
      auth: REDACTED,
      email: '~Contact.Email~',
    });
    expect(redacted).toEqual([{ location: 'body', name: 'auth' }]);
  });

  it('leaves a non-JSON body alone', () => {
    expect(redactHttp({ ...base, body: 'plain text' }).content.body).toBe('plain text');
  });

  it('does not mutate its input', () => {
    const input = { ...base, headers: [{ name: 'Authorization', value: 'x' }] };
    redactHttp(input);
    expect(input.headers[0]?.value).toBe('x');
  });
});
