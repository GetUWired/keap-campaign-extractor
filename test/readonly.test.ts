import type { BrowserContext } from 'playwright';
import { describe, expect, it } from 'vitest';
import { classifyRequest } from '../src/guard/readonly.js';

const B = 'https://x.infusionsoft.com';

describe('classifyRequest — allowed reads', () => {
  it('allows the campaign editor', () => {
    expect(classifyRequest('GET', `${B}/app/funnel/funnelEditor?funnelId=584`)).toBeNull();
  });

  it('allows the decision editor', () => {
    expect(classifyRequest('GET', `${B}/app/decisionFunnel/decisionEditor?flowIds=3,32`)).toBeNull();
  });

  it('allows the automations report, whose path contains "Template"', () => {
    expect(
      classifyRequest('GET', `${B}/Reports/searchTemplate.jsp?reportClass=SetupFunnel&perPage=500`),
    ).toBeNull();
  });

  it('allows session keepAlive', () => {
    expect(classifyRequest('GET', `${B}/app/session/keepAlive`)).toBeNull();
  });

  it('allows static assets whose filename contains a denylisted word', () => {
    expect(classifyRequest('GET', `${B}/resources/funnel/images/template-icon.svg`)).toBeNull();
  });

  it('allows a decision-editor GET whose title parameter contains "save"', () => {
    expect(classifyRequest('GET', `${B}/app/funnel/configureCell?title=Save%20for%20later`)).toBeNull();
  });

  it('allows a static asset under /app/ whose filename contains a denylisted word', () => {
    // Observed live: the campaign editor loads /app/funnel/_publish.svg, an
    // icon. It sits under /app/ so the /resources/ prefix exemption misses it,
    // and "publish" in the filename got it blocked. A static file extension
    // cannot change state whatever directory it is served from.
    expect(
      classifyRequest('GET', `${B}/app/funnel/_publish.svg?b=1.70.0.990820-hf-202608041714`),
    ).toBeNull();
    expect(classifyRequest('GET', `${B}/app/funnel/save-icon.png`)).toBeNull();
    expect(classifyRequest('GET', `${B}/app/x/delete.css`)).toBeNull();
  });
});

describe('classifyRequest — blocked writes', () => {
  it('blocks every non-GET regardless of path', () => {
    expect(classifyRequest('POST', `${B}/anything`)).toBe('non-get');
    expect(classifyRequest('PUT', `${B}/app/authoring/a/b/template`)).toBe('non-get');
    expect(classifyRequest('DELETE', `${B}/app/funnel/x`)).toBe('non-get');
  });

  it('blocks the destructive report action found in the Automations Actions menu', () => {
    expect(
      classifyRequest(
        'GET',
        `${B}/Reports/reportActions.jsp?actionName=Unpublish+and+Delete+Automations`,
      ),
    ).toBe('denylist');
  });

  it('blocks write-shaped paths outside /app/, which the old rule ignored', () => {
    expect(classifyRequest('GET', `${B}/Reports/deleteReport.jsp`)).toBe('denylist');
    expect(classifyRequest('GET', `${B}/Admin/saveSettings.jsp`)).toBe('denylist');
  });

  it('blocks write-shaped paths under /app/', () => {
    expect(classifyRequest('GET', `${B}/app/funnel/saveDraft?id=1`)).toBe('denylist');
    expect(classifyRequest('GET', `${B}/app/funnel/publishFunnel?id=1`)).toBe('denylist');
    expect(classifyRequest('GET', `${B}/app/funnel/deleteFunnel?id=1`)).toBe('denylist');
  });

  it('blocks a path ending in /template but not one merely containing it', () => {
    expect(classifyRequest('GET', `${B}/app/authoring/a/b/template`)).toBe('denylist');
    expect(classifyRequest('GET', `${B}/Reports/searchTemplate.jsp`)).toBeNull();
  });

  it('blocks a malformed URL rather than letting it through', () => {
    expect(classifyRequest('GET', 'not-a-url')).toBe('denylist');
  });
});

describe('safeGet timeout forwarding', () => {
  it('forwards timeout to context.request.get', async () => {
    const { safeGet } = await import('../src/guard/readonly.js');
    let capturedOptions: { timeout?: number; maxRedirects?: number } | undefined;
    const fakeBrowserContext = {
      request: {
        get: async (_url: string, options?: { timeout?: number; maxRedirects?: number }) => {
          capturedOptions = options;
          return { status: () => 200, headers: () => ({}), body: async () => Buffer.alloc(0) };
        },
      },
    } as unknown as BrowserContext;
    await safeGet(fakeBrowserContext, 'https://se232.infusionsoft.com/a.png', { timeout: 30000 });
    expect(capturedOptions).toEqual({ timeout: 30000 });
  });

  it('forwards both timeout and maxRedirects to context.request.get', async () => {
    const { safeGet } = await import('../src/guard/readonly.js');
    let capturedOptions: { timeout?: number; maxRedirects?: number } | undefined;
    const fakeBrowserContext = {
      request: {
        get: async (_url: string, options?: { timeout?: number; maxRedirects?: number }) => {
          capturedOptions = options;
          return { status: () => 200, headers: () => ({}), body: async () => Buffer.alloc(0) };
        },
      },
    } as unknown as BrowserContext;
    await safeGet(fakeBrowserContext, 'https://se232.infusionsoft.com/a.png', {
      timeout: 30000,
      maxRedirects: 0,
    });
    expect(capturedOptions).toEqual({ timeout: 30000, maxRedirects: 0 });
  });

  it('refuses blocked URLs without calling context.request.get', async () => {
    const { safeGet } = await import('../src/guard/readonly.js');
    let getWasCalled = false;
    const fakeBrowserContext = {
      request: {
        get: async () => {
          getWasCalled = true;
          throw new Error('should not be called');
        },
      },
    } as unknown as BrowserContext;
    await expect(safeGet(fakeBrowserContext, 'https://x.infusionsoft.com/app/funnel/saveDraft')).rejects.toThrow();
    expect(getWasCalled).toBe(false);
  });
});
