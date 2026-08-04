import { describe, expect, it } from 'vitest';
import { classifyRequest } from '../src/guard/readonly.js';

describe('classifyRequest', () => {
  it('allows a GET to the campaign editor', () => {
    expect(
      classifyRequest('GET', 'https://x.infusionsoft.com/app/funnel/funnelEditor?funnelId=584'),
    ).toBeNull();
  });

  it('blocks the observed template-writing PUT', () => {
    expect(classifyRequest('PUT', 'https://x.infusionsoft.com/app/authoring/a/b/template')).toBe(
      'non-get',
    );
  });

  it('blocks every POST regardless of path', () => {
    expect(classifyRequest('POST', 'https://x.infusionsoft.com/anything')).toBe('non-get');
  });

  it('blocks a GET to a write-shaped /app/ path', () => {
    expect(classifyRequest('GET', 'https://x.infusionsoft.com/app/funnel/saveDraft?id=1')).toBe(
      'denylist',
    );
  });

  it('allows static assets whose path contains a denylisted word', () => {
    expect(
      classifyRequest(
        'GET',
        'https://x.infusionsoft.com/resources/funnel/images/template-icon.svg',
      ),
    ).toBeNull();
  });

  it('allows a decision-editor GET whose title parameter contains "save"', () => {
    expect(
      classifyRequest(
        'GET',
        'https://x.infusionsoft.com/app/funnel/configureCell?cellId=34&metaType=decision&title=Save%20for%20later',
      ),
    ).toBeNull();
  });

  it('blocks a malformed URL rather than letting it through', () => {
    expect(classifyRequest('GET', 'not-a-url')).toBe('denylist');
  });
});
