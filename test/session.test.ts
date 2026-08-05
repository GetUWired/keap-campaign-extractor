import { describe, expect, it } from 'vitest';
import { assertResponseAuthenticated } from '../src/auth/session.js';

/** Minimal stand-in for the shape assertResponseAuthenticated needs. */
const response = (url: string) => ({ url: () => url });

describe('assertResponseAuthenticated', () => {
  it('accepts the automations report', () => {
    expect(() =>
      assertResponseAuthenticated(
        response('https://jordan.infusionsoft.com/Reports/searchTemplate.jsp?reportClass=SetupFunnel'),
      ),
    ).not.toThrow();
  });

  it('accepts the campaign editor', () => {
    expect(() =>
      assertResponseAuthenticated(
        response('https://jordan.infusionsoft.com/app/funnel/funnelEditor?funnelId=584'),
      ),
    ).not.toThrow();
  });

  it('rejects the Thryv sign-in redirect observed on an expired session', () => {
    // Real final URL from a lapsed session: HTTP 200, 55KB of login markup.
    expect(() =>
      assertResponseAuthenticated(response('https://login.labs.thryv.com/u/login/identifier?state=abc')),
    ).toThrow(/Session expired/);
  });

  it('names the command that fixes it', () => {
    expect(() =>
      assertResponseAuthenticated(response('https://login.labs.thryv.com/u/login/identifier')),
    ).toThrow(/npm run login/);
  });

  it('rejects the legacy accounts sign-in host', () => {
    expect(() =>
      assertResponseAuthenticated(response('https://accounts.infusionsoft.com/app/central/home')),
    ).toThrow(/Session expired/);
  });
});
