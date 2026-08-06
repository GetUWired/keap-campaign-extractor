import { describe, expect, it } from 'vitest';
import { SessionExpiredError, isSessionExpired } from '../src/errors.js';

describe('SessionExpiredError', () => {
  it('is an Error with the given message', () => {
    const error = new SessionExpiredError('Session expired — landed on /login');
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('Session expired');
    expect(error.name).toBe('SessionExpiredError');
  });
});

describe('isSessionExpired', () => {
  it('recognises the typed error', () => {
    expect(isSessionExpired(new SessionExpiredError('x'))).toBe(true);
  });

  it('rejects a plain Error even when its text looks identical', () => {
    // The whole reason this is typed: message text is not a contract, and a
    // bulk run decides whether to abort based on this answer.
    expect(isSessionExpired(new Error('Session expired — landed on /login'))).toBe(false);
  });

  it('rejects non-errors', () => {
    expect(isSessionExpired(null)).toBe(false);
    expect(isSessionExpired(undefined)).toBe(false);
    expect(isSessionExpired('Session expired')).toBe(false);
    expect(isSessionExpired({ message: 'Session expired' })).toBe(false);
  });

  it('recognises an error carrying the marker without prototype identity', () => {
    // Guards against instanceof failing across module realms.
    const impostor = Object.assign(new Error('x'), { isSessionExpired: true as const });
    expect(isSessionExpired(impostor)).toBe(true);
  });
});
