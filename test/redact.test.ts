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

  it('redacts a form-encoded body pair by pair', () => {
    const { content, redacted } = redactHttp({ ...base, body: 'api_key=abc&email=~Contact.Email~' });
    expect(content.body).toBe(`api_key=${REDACTED}&email=~Contact.Email~`);
    expect(redacted).toEqual([{ location: 'body', name: 'api_key' }]);
  });

  it('accepts empty values and a trailing & in a form body', () => {
    const { content, redacted } = redactHttp({ ...base, body: 'token=t1&note=&' });
    expect(content.body).toBe(`token=${REDACTED}&note=&`);
    expect(redacted).toEqual([{ location: 'body', name: 'token' }]);
  });

  it('leaves any other body unchanged but flags it for manual review', () => {
    const { content, redacted } = redactHttp({ ...base, body: 'plain text' });
    expect(content.body).toBe('plain text');
    expect(redacted).toEqual([{ location: 'body', name: '(unparsed — review manually)' }]);
  });

  it('does not flag an empty body', () => {
    expect(redactHttp({ ...base, body: '' }).redacted).toEqual([]);
  });

  it('redacts every copy of a repeated query key', () => {
    const { content, redacted } = redactHttp({ ...base, url: 'https://h.example.com/x?key=a&id=1&key=b' });
    expect(content.url).toBe(`https://h.example.com/x?key=${REDACTED}&id=1&key=${REDACTED}`);
    expect(redacted).toEqual([
      { location: 'query', name: 'key' },
      { location: 'query', name: 'key' },
    ]);
  });

  it('redacts a numeric secret in a JSON body', () => {
    const { content, redacted } = redactHttp({ ...base, body: JSON.stringify({ apiKey: 12345, n: 1 }) });
    expect(JSON.parse(content.body ?? '')).toEqual({ apiKey: REDACTED, n: 1 });
    expect(redacted).toEqual([{ location: 'body', name: 'apiKey' }]);
  });

  it('redacts a secret inside an array of objects', () => {
    const { content } = redactHttp({
      ...base,
      body: JSON.stringify({ items: [{ token: 't', id: 1 }, { id: 2 }] }),
    });
    expect(JSON.parse(content.body ?? '')).toEqual({ items: [{ token: REDACTED, id: 1 }, { id: 2 }] });
  });

  it('does not throw on malformed percent-encoding', () => {
    const url = 'https://h.example.com/x?key=%E0%A4%A&x=%';
    const { content } = redactHttp({ ...base, url, body: 'secret=%zz&y=%' });
    expect(content.url).toBe(`https://h.example.com/x?key=${REDACTED}&x=%`);
    expect(content.body).toBe(`secret=${REDACTED}&y=%`);
  });

  it('does not mutate its input', () => {
    const input = { ...base, headers: [{ name: 'Authorization', value: 'x' }] };
    redactHttp(input);
    expect(input.headers[0]?.value).toBe('x');
  });
});
