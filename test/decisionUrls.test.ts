import { describe, expect, it } from 'vitest';
import { decisionCandidateUrls, isDecisionHtml } from '../src/extract/decision.js';

const BASE = 'https://jordan.infusionsoft.com';

const cell = {
  cellId: '34',
  name: null,
  branches: [
    { decisionId: '479', flowId: '3' },
    { decisionId: '481', flowId: '32' },
  ],
};

describe('decisionCandidateUrls', () => {
  it('targets the confirmed decisionEditor endpoint', () => {
    for (const url of decisionCandidateUrls(BASE, cell)) {
      expect(url).toContain('/app/decisionFunnel/decisionEditor?');
    }
  });

  it('reproduces the observed URL when given the goal context', () => {
    const urls = decisionCandidateUrls(BASE, cell, { secondaryKey: 'WebForm', secondaryKeyId: '681L' });
    expect(urls[1]).toBe(
      'https://jordan.infusionsoft.com/app/decisionFunnel/decisionEditor' +
        '?flowIds=3%2C32&decisionIds=479L%2C481L&secondaryKey=WebForm&secondaryKeyId=681L',
    );
  });

  it('restores the Java Long suffix on decisionIds but not flowIds', () => {
    const url = decisionCandidateUrls(BASE, cell)[0] ?? '';
    expect(decodeURIComponent(url)).toContain('decisionIds=479L,481L');
    expect(decodeURIComponent(url)).toContain('flowIds=3,32');
  });

  it('tries the bare form first, so a hit avoids tracing the upstream goal', () => {
    const urls = decisionCandidateUrls(BASE, cell, { secondaryKey: 'WebForm', secondaryKeyId: '681L' });
    expect(urls).toHaveLength(2);
    expect(urls[0]).not.toContain('secondaryKey');
  });

  it('produces only the bare form when no goal context is known', () => {
    expect(decisionCandidateUrls(BASE, cell)).toHaveLength(1);
  });

  it('adds the L suffix to a secondaryKeyId supplied without one', () => {
    const urls = decisionCandidateUrls(BASE, cell, { secondaryKey: 'WebForm', secondaryKeyId: '681' });
    expect(urls[1]).toContain('secondaryKeyId=681L');
  });
});

describe('isDecisionHtml', () => {
  it('accepts a body containing the decision container', () => {
    expect(isDecisionHtml('<div id="decisionComponents"></div>')).toBe(true);
  });

  it('accepts a body containing the decision id input', () => {
    expect(isDecisionHtml('<input id="decisionIds" value="1"/>')).toBe(true);
  });

  it('rejects the empty modal shell configureCell returns for a decision cell', () => {
    // The exact 75-byte body observed from the wrong endpoint, HTTP 200.
    expect(
      isDecisionHtml('<input id="cellId" type="hidden" value="34" /><div class="modal-body">'),
    ).toBe(false);
  });

  it('rejects an unrelated page even when it returns 200', () => {
    expect(isDecisionHtml('<html><body>Session expired</body></html>')).toBe(false);
  });
});
