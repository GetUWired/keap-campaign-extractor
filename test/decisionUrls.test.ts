import { describe, expect, it } from 'vitest';
import { decisionCandidateUrls, isDecisionHtml } from '../src/extract/decision.js';

const cell = { cellId: '34', name: 'Applied Already?', branches: [] };

describe('decisionCandidateUrls', () => {
  it('produces three candidates in the documented order', () => {
    const urls = decisionCandidateUrls(cell, 1_700_000_000_000);
    expect(urls).toHaveLength(3);
    expect(urls[0]).toContain('title=Applied%20Already%3F');
    expect(urls[1]).not.toContain('title=');
    expect(urls[2]).toContain('includePage=true');
  });

  it('always targets configureCell with metaType=decision', () => {
    for (const url of decisionCandidateUrls(cell, 1)) {
      expect(url).toContain('/app/funnel/configureCell?');
      expect(url).toContain('metaType=decision');
      expect(url).toContain('cellId=34');
    }
  });

  it('tolerates a cell with no name', () => {
    const urls = decisionCandidateUrls({ cellId: '7', name: null, branches: [] }, 1);
    expect(urls[0]).toContain('title=');
  });
});

describe('isDecisionHtml', () => {
  it('accepts a body containing the decision container', () => {
    expect(isDecisionHtml('<div id="decisionComponents"></div>')).toBe(true);
  });

  it('accepts a body containing the decision id input', () => {
    expect(isDecisionHtml('<input id="decisionIds" value="1"/>')).toBe(true);
  });

  it('rejects an unrelated page even when it returns 200', () => {
    expect(isDecisionHtml('<html><body>Session expired</body></html>')).toBe(false);
  });
});
