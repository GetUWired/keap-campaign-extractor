import { describe, expect, it } from 'vitest';
import { parseFetchContentArgs } from '../src/cli/fetchContentArgs.js';

describe('parseFetchContentArgs', () => {
  it('parses every flag', () => {
    expect(
      parseFetchContentArgs([
        '--app', 'SE232', '--kinds', 'email,sms', '--funnel', '987',
        '--force', '--limit', '5', '--delay', '0', '--headed',
      ]),
    ).toEqual({
      app: 'se232',
      kinds: ['email', 'sms'],
      funnelId: '987',
      force: true,
      limit: 5,
      delayMs: 0,
      headed: true,
    });
  });

  it('defaults', () => {
    expect(parseFetchContentArgs(['--app', 'jordan'])).toEqual({
      app: 'jordan',
      kinds: null,
      funnelId: null,
      force: false,
      limit: null,
      delayMs: 250,
      headed: false,
    });
  });

  it('refuses an unknown kind by name', () => {
    expect(() => parseFetchContentArgs(['--app', 'x', '--kinds', 'email,fax'])).toThrow(/fax/);
  });

  it('requires --app', () => {
    expect(() => parseFetchContentArgs([])).toThrow(/Usage/);
  });
});
