import { describe, expect, it } from 'vitest';
import { SessionExpiredError, isSessionExpired } from '../src/errors.js';
import { assertAuthenticated } from '../src/auth/session.js';

/**
 * The probe itself needs a browser, so what is pinned here is the decision it
 * rests on: that a bounce to the login host is recognised as expiry rather
 * than as some other failure.
 */
const pageAt = (url: string) => ({ url: () => url }) as never;

describe('session expiry detection', () => {
  it('treats the Thryv login host as expiry', () => {
    // The exact URL the 12 October refresh landed on.
    const landed =
      'https://login.labs.thryv.com/u/login/identifier?state=hKFo2SBxaDdIc2p4dVI5ZHhfU3ZM';
    expect(() => assertAuthenticated(pageAt(landed))).toThrow(SessionExpiredError);
  });

  it('leaves an ordinary app page alone', () => {
    expect(() =>
      assertAuthenticated(pageAt('https://se232.infusionsoft.com/app/funnel/funnelEditor?funnelId=1')),
    ).not.toThrow();
  });

  it('classifies the error so a caller can tell expiry from a crash', () => {
    const expired = new SessionExpiredError('Session expired — landed on …');
    expect(isSessionExpired(expired)).toBe(true);
    expect(isSessionExpired(new Error('ECONNREFUSED'))).toBe(false);
  });
});
